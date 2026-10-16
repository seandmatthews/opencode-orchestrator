import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBriefs, parseReview } from './parse.js'
import type { Attempt, CandidateReport, FailureRecord, Gate, GateResult, PlannerReport, ReviewReport, RunReport, WorkerAdapter, WorkspaceLease, WorkspaceProvider } from './types.js'

export interface SkeletonOptions {
  runId: string
  repo: string
  /** All candidates are pinned to this ref (a SHA, so it cannot move mid-run). */
  baseSha: string
  goal: string
  /** Worker-tier model ID given to every candidate. */
  model: string
  /** Planner-tier model ID, or null to skip planning (candidates get the raw goal). */
  plannerModel: string | null
  /** Reviewer-tier model ID for advisory post-gate review, or null to skip. */
  reviewerModel: string | null
  candidateIds: string[]
  concurrency: number
  timeoutMs: number
  /**
   * Maximum number of attempts per candidate (T-007; CLI default 1 = a
   * single attempt, the pre-retry behavior). Only mechanical failures are
   * retried — an attempt that throws or whose worker fails (non-zero exit /
   * timeout). Verdicts are never re-rolled: a worker that succeeded but
   * produced a zero-byte diff or failed gates is eliminated on the ladder
   * exactly as before (decisions.md: machine gates decide survival).
   */
  maxAttempts: number
  gates: Gate[]
  worker: WorkerAdapter
  workspaces: WorkspaceProvider
  artifactsDir: string
  /** Dispose workspaces after evidence capture instead of leaving them for inspection. */
  cleanWorkspaces: boolean
}

export function builderPrompt(goal: string, workspacePath: string): string {
  return [
    'You are implementing a small, well-specified change in the git repository located at:',
    `  ${workspacePath}`,
    'Read, write, and run commands only inside that directory.',
    '',
    `GOAL: ${goal}`,
    '',
    'Rules:',
    '- Make the minimal change that satisfies the goal.',
    '- Do not create git commits, branches, stashes, or worktrees.',
    '- Do not modify files unrelated to the goal.',
    '- When finished, reply with a one-paragraph summary of what you changed.',
  ].join('\n')
}

export async function runSkeleton(opts: SkeletonOptions): Promise<RunReport> {
  const startedAt = new Date().toISOString()
  mkdirSync(join(opts.artifactsDir, 'wt'), { recursive: true })

  // Planning tier: one smart-model job turns the goal into N distinct briefs.
  // Failure here degrades gracefully — candidates fall back to the raw goal.
  let briefs: string[] = opts.candidateIds.map(() => opts.goal)
  let planner: PlannerReport | undefined
  if (opts.plannerModel) {
    planner = await runPlannerPhase(opts)
    if (planner.ok) briefs = planner.briefs
    console.log(`planner: ${planner.ok ? `${briefs.length} briefs` : 'no valid output, using raw goal'} in ${(planner.durationMs / 1000).toFixed(0)}s (${planner.attempts} attempt${planner.attempts > 1 ? 's' : ''})`)
    console.log('')
  }

  // Lease every candidate's FIRST attempt up front so all workers start from
  // the same base. Retry attempts (T-007) lease their own fresh worktree
  // lazily inside the candidate's lane, at the same baseSha.
  const leases = new Map<string, WorkspaceLease>()
  for (const id of opts.candidateIds) {
    leases.set(id, opts.workspaces.lease(`wt/${id}`, opts.baseSha))
  }

  let next = 0
  const reports: CandidateReport[] = new Array(opts.candidateIds.length)
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= opts.candidateIds.length) return
      const id = opts.candidateIds[i]!
      reports[i] = await runCandidate(id, leases.get(id)!, briefs[i]!, opts)
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, lane))

  const report: RunReport = {
    runId: opts.runId,
    repo: opts.repo,
    baseSha: opts.baseSha,
    goal: opts.goal,
    model: opts.model,
    planner,
    startedAt,
    finishedAt: new Date().toISOString(),
    candidates: reports,
  }
  writeFileSync(join(opts.artifactsDir, 'report.json'), JSON.stringify(report, null, 2))
  return report
}

function plannerPrompt(goal: string, count: number): string {
  return [
    'You are the planning tier of a multi-candidate implementation system.',
    `GOAL: ${goal}`,
    '',
    `Produce exactly ${count} distinct implementation briefs, one per candidate worker.`,
    'Each brief must be self-contained, concrete, and independently implementable as a small diff.',
    'Where the goal allows more than one approach, vary the approach across briefs.',
    'Do not reference "the other briefs"; each worker sees only its own.',
    '',
    `Output ONLY a JSON array of ${count} strings. No markdown fences, no commentary.`,
  ].join('\n')
}

const MAX_DIFF_CHARS = 30_000

function reviewerPrompt(brief: string, workspacePath: string, diff: string, gateLines: string[]): string {
  const truncated = diff.length > MAX_DIFF_CHARS
  return [
    'You are the review tier of a multi-candidate implementation system.',
    'A worker implemented a brief and all machine gates passed.',
    'Produce advisory observations for a human reviewer. You never decide survival.',
    '',
    'Do not modify any files. Reading the repository below for context is encouraged.',
    `  ${workspacePath}`,
    '',
    `BRIEF the worker was given:`,
    brief,
    '',
    'MACHINE GATE RESULTS:',
    ...gateLines,
    '',
    `CANDIDATE DIFF${truncated ? ` (truncated to ${MAX_DIFF_CHARS} chars)` : ''}:`,
    diff.slice(0, MAX_DIFF_CHARS),
    '',
    'Output ONLY a JSON object, no markdown fences, no commentary:',
    '{"observations": [{"finding": "<one concrete observation>", "severity": "info" | "concern" | "blocker-advisory", "evidence": "<what you looked at>"}]}',
    'Give 2 to 6 observations. severities: info = worth knowing, concern = possible problem,',
    'blocker-advisory = would block merge if a human agrees.',
  ].join('\n')
}

async function runPlannerPhase(opts: SkeletonOptions): Promise<PlannerReport> {
  const count = opts.candidateIds.length
  const prompt = plannerPrompt(opts.goal, count)
  const logPath = join(opts.artifactsDir, 'planner.log')
  const rawOutputPath = join(opts.artifactsDir, 'planner-raw.txt')
  const started = Date.now()

  // The planner may read the repo to write informed briefs, but must not
  // modify it; enforcement moves into capability restrictions later.
  const baseReq = { model: opts.plannerModel!, cwd: opts.repo, logPath, timeoutMs: opts.timeoutMs }
  let result = await opts.worker.execute({ ...baseReq, prompt })
  let attempts = 1
  let briefs = result.ok ? parseBriefs(result.responseTail, count) : null

  if (!briefs && !result.timedOut) {
    attempts = 2
    console.log('planner: output was not a valid JSON array, running one bounded repair attempt')
    result = await opts.worker.execute({
      ...baseReq,
      prompt: [
        prompt,
        '',
        'Your previous response was not a valid JSON array of strings. Previous response:',
        result.responseTail,
        '',
        'Output ONLY the JSON array. No other text.',
      ].join('\n'),
    })
    briefs = result.ok ? parseBriefs(result.responseTail, count) : null
  }

  writeFileSync(rawOutputPath, result.responseTail)
  return {
    model: opts.plannerModel!,
    ok: briefs !== null,
    attempts,
    durationMs: Date.now() - started,
    briefs: briefs ?? [],
    fallbackUsed: briefs === null,
    rawOutputPath,
  }
}

async function runReview(
  opts: SkeletonOptions,
  ctx: { id: string; dir: string; workspacePath: string; brief: string; diff: string; gateLines: string[] },
): Promise<ReviewReport> {
  const prompt = reviewerPrompt(ctx.brief, ctx.workspacePath, ctx.diff, ctx.gateLines)
  const logPath = join(ctx.dir, 'reviewer.log')
  const rawOutputPath = join(ctx.dir, 'review-raw.txt')
  const started = Date.now()

  // Read-only posture is prompt-reinforced only for now (VERIFICATION.md
  // Known issues #6); the reviewer runs in the candidate worktree, so the
  // canonical repo is never exposed either way.
  const baseReq = { model: opts.reviewerModel!, cwd: ctx.workspacePath, logPath, timeoutMs: opts.timeoutMs }
  let result = await opts.worker.execute({ ...baseReq, prompt })
  let attempts = 1
  let review = result.ok ? parseReview(result.responseTail) : null

  if (!review && !result.timedOut) {
    attempts = 2
    console.log(`[${ctx.id}] review: output was not a valid observation object, running one bounded repair attempt`)
    result = await opts.worker.execute({
      ...baseReq,
      prompt: [
        prompt,
        '',
        'Your previous response was not a valid JSON observations object. Previous response:',
        result.responseTail,
        '',
        'Output ONLY the JSON object: {"observations": [{"finding": "...", "severity": "info" | "concern" | "blocker-advisory", "evidence": "..."}]}. No other text.',
      ].join('\n'),
    })
    review = result.ok ? parseReview(result.responseTail) : null
  }

  writeFileSync(rawOutputPath, result.responseTail)
  const report: ReviewReport = {
    ok: review !== null,
    attempts,
    model: opts.reviewerModel!,
    observations: review?.observations ?? [],
    rawOutputPath,
  }
  writeFileSync(join(ctx.dir, 'review.json'), JSON.stringify(report, null, 2))
  const severities = report.observations.map((o) => o.severity).join(', ')
  console.log(`[${ctx.id}] review: ${report.observations.length} observation(s) in ${((Date.now() - started) / 1000).toFixed(0)}s${report.observations.length > 0 ? ` (${severities})` : ''}${report.ok ? '' : ' — PARSE FAILED after repair'}`)
  return report
}

/** §7.7 context fingerprint, narrowed to what has a producer: sha256 over
 *  brief + model + the composed prompt with the workspace-path line excluded,
 *  so the same brief+model hashes identically across attempts (an
 *  input-context hash compares inputs, not worktree paths). The full
 *  fingerprint adds prompt version, role version, selected artifact
 *  IDs/hashes, reasoning configuration, and project-manifest version
 *  (§7.7:615-620) — none has a producer until the Milestone-2 context
 *  system. */
function inputContextHash(brief: string, model: string, workspacePath: string): string {
  const promptWithoutWorkspace = builderPrompt(brief, workspacePath)
    .split('\n')
    .filter((line) => line !== `  ${workspacePath}`)
    .join('\n')
  return createHash('sha256').update(`${brief}\n${model}\n${promptWithoutWorkspace}`).digest('hex')
}

async function runCandidate(id: string, firstLease: WorkspaceLease, brief: string, opts: SkeletonOptions): Promise<CandidateReport> {
  const dir = join(opts.artifactsDir, id)
  mkdirSync(dir, { recursive: true })
  const base: CandidateReport = {
    id,
    workerId: opts.worker.id,
    model: opts.model,
    brief,
    workspacePath: firstLease.path,
    workerOk: false,
    workerTimedOut: false,
    workerDurationMs: 0,
    diffPath: null,
    diffBytes: 0,
    gates: [],
    passedAllGates: false,
    attempts: [],
  }

  // Bounded same-config retry (T-007): a mechanical failure re-runs as a
  // fresh attempt in a fresh worktree at the same baseSha — a fresh attempt
  // adopts nothing from the prior attempt's worktree, branch, or process
  // state (spec §15.1). Retries stay inside the candidate's lane, so
  // lane/concurrency semantics are untouched.
  let lease = firstLease
  for (let n = 1; ; n++) {
    if (n >= 2) {
      // Attempt-scoped lease id: two leases on `wt/<id>` would both derive
      // `swarm/wt-<id>` (the T-004 branch-collision hazard), and attempt 2
      // would overwrite attempt 1's worker.log. Attempts ≥ 2 get their own
      // evidence directory too.
      lease = opts.workspaces.lease(`wt/${id}-a${n}`, opts.baseSha)
      base.workspacePath = lease.path
    }
    const evidenceDir = n === 1 ? dir : join(dir, `attempt-${n}`)
    mkdirSync(evidenceDir, { recursive: true })
    const logPath = join(evidenceDir, 'worker.log')
    const diffPath = join(evidenceDir, 'diff.patch')

    const attempt: Attempt = {
      id: `${id}-a${n}`,
      jobId: id,
      number: n,
      state: 'running',
      startedAt: new Date().toISOString(),
      inputContextHash: inputContextHash(brief, opts.model, lease.path),
      promptVersion: null,
      outputArtifacts: [logPath],
    }
    base.attempts.push(attempt)

    try {
      console.log(`[${id}] attempt ${n}: worker start (${opts.worker.id}, model=${opts.model})`)
      const result = await opts.worker.execute({
        prompt: builderPrompt(brief, lease.path),
        model: opts.model,
        cwd: lease.path,
        logPath,
        timeoutMs: opts.timeoutMs,
      })
      attempt.endedAt = new Date().toISOString()
      console.log(`[${id}] attempt ${n}: worker done in ${(result.durationMs / 1000).toFixed(0)}s ok=${result.ok} exit=${result.exitCode}`)

      // A failed worker is the only worker-side retryable leg. A worker that
      // SUCCEEDED is final no matter what the verdict will be: zero-byte
      // diffs and failed gates are ladder verdicts, and re-rolling them
      // would be model-shopping around a machine verdict (decisions.md:
      // gates decide survival).
      const failure: FailureRecord | null = result.ok ? null : {
        reason: 'worker-failed',
        message: result.timedOut ? `worker timed out after ${opts.timeoutMs}ms` : `worker exited with code ${result.exitCode}`,
        timedOut: result.timedOut,
        exitCode: result.exitCode,
      }

      // Diff evidence is captured on every attempt — a retried leg's diff is
      // still audit history (spec §6.5). Gates do NOT run here: retryable
      // legs never reach them.
      let diff = ''
      let diffCaptured = false
      try {
        diff = opts.workspaces.diff(lease)
        writeFileSync(diffPath, diff)
        attempt.outputArtifacts.push(diffPath)
        diffCaptured = true
        console.log(`[${id}] attempt ${n}: diff captured: ${Buffer.byteLength(diff)} bytes`)
      } catch (e) {
        console.log(`[${id}] attempt ${n}: diff capture failed: ${errorMessage(e)}`)
      }

      if (failure && base.attempts.length < opts.maxAttempts) {
        attempt.state = 'failed'
        attempt.failure = failure
        console.log(`[${id}] attempt ${n} failed (${failure.reason}); retrying with a fresh workspace (${base.attempts.length}/${opts.maxAttempts})`)
        if (opts.cleanWorkspaces) {
          try {
            opts.workspaces.dispose(lease)
          } catch (e) {
            console.log(`[${id}] workspace dispose failed: ${errorMessage(e)}`)
          }
        }
        continue
      }

      // Final attempt (worker succeeded, or the bound was reached): the
      // candidate's top-level fields are this attempt's values — the exact
      // flow and verdict ladder the runner had before T-007, so the run
      // summary, the store's per-candidate writes, and clean/integrate
      // discovery are unchanged.
      attempt.state = result.ok ? 'succeeded' : 'failed'
      if (failure) attempt.failure = failure
      base.workerOk = result.ok
      base.workerTimedOut = result.timedOut
      base.workerDurationMs = result.durationMs
      if (diffCaptured) {
        base.diffPath = diffPath
        base.diffBytes = Buffer.byteLength(diff)
      }

      for (const gate of opts.gates) {
        const r: GateResult = await gate.run(lease.path)
        base.gates.push(r)
        console.log(`[${id}] gate ${r.name}: ${r.passed ? 'PASS' : 'FAIL'} (${(r.durationMs / 1000).toFixed(1)}s)`)
      }
      base.passedAllGates = base.gates.length > 0 && base.gates.every((g) => g.passed) && base.diffBytes > 0

      if (opts.reviewerModel && base.passedAllGates) {
        base.review = await runReview(opts, {
          id,
          dir,
          workspacePath: lease.path,
          brief,
          diff,
          gateLines: base.gates.map((g) => `- ${g.name}: ${g.passed ? 'PASS' : 'FAIL'}`),
        })
      }
      break
    } catch (e) {
      attempt.endedAt = new Date().toISOString()
      attempt.state = 'failed'
      attempt.failure = { reason: 'error', message: errorMessage(e), timedOut: false, exitCode: null }
      console.log(`[${id}] attempt ${n} errored: ${attempt.failure.message}`)
      if (base.attempts.length < opts.maxAttempts) {
        console.log(`[${id}] attempt ${n} → retrying with a fresh workspace (${base.attempts.length}/${opts.maxAttempts})`)
        if (opts.cleanWorkspaces) {
          try {
            opts.workspaces.dispose(lease)
          } catch (e2) {
            console.log(`[${id}] workspace dispose failed: ${errorMessage(e2)}`)
          }
        }
        continue
      }
      base.error = attempt.failure.message
      console.log(`[${id}] candidate errored: ${base.error}`)
      break
    }
  }

  if (opts.cleanWorkspaces) {
    try {
      opts.workspaces.dispose(lease)
      base.workspacePath = null
    } catch (e) {
      console.log(`[${id}] workspace dispose failed: ${errorMessage(e)}`)
    }
  }

  return base
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
