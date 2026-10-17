import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBriefs, parseReview } from './parse.js'
import { evidenceBundlePath, failedBundle, writeEvidenceBundle } from './probe.js'
import type { Probe } from './probe.js'
import { buildSchedule, readyJobs } from './scheduler.js'
import type { PhaseSpec } from './scheduler.js'
import { DERIVED_PHASE_ID } from './store/index.js'
import type { Attempt, CandidateReport, FailureRecord, Gate, GateResult, PlannerReport, ProbeRunSummary, ReviewReport, RunReport, WorkerAdapter, WorkspaceLease, WorkspaceProvider } from './types.js'

/**
 * Best-effort append to <runDir>/dispatch.jsonl (T-010) — the in-run evidence
 * artifact startup reconciliation consumes. The store is post-hoc only (ingest
 * runs after runSkeleton returns), so a hard-killed run would leave zero DB
 * rows; this file leaves partial evidence instead of nothing. Appends can
 * never break a run (the adapter's appendLog posture,
 * src/worker/opencode.ts). The file is part of the run's evidence set:
 * `clean` never deletes it (it sweeps worktrees and swarm/* branches only),
 * and `recover` reads it after a crash. Line shapes (one JSON object per
 * line, appended in this order per attempt):
 *   {type:'run', runId, repo, baseSha, goal, model, maxAttempts, startedAt}
 *   {type:'dispatch', jobId, attempt, leaseId, branch, worktreePath, startedAt}
 *   {type:'pid', jobId, attempt, pid, at}
 *   {type:'completion', jobId, attempt, ok, timedOut, exitCode, diffBytes, endedAt}
 *     (diffBytes is null when the diff capture failed — a failed capture is
 *      never readable as the machine-answered zero-byte NO-OP verdict)
 */
function appendDispatchEvidence(artifactsDir: string, line: object): void {
  try {
    appendFileSync(join(artifactsDir, 'dispatch.jsonl'), `${JSON.stringify(line)}\n`)
  } catch {
    // Evidence appends must never break a run.
  }
}

/** One fully-resolved executable job (T-009 --jobs mode): the spec's
 *  scheduling fields with the run-level flags applied as defaults
 *  (model/worker/timeoutMs/gates) and the adapter/gate objects bound. The
 *  engine stays harness-agnostic: adapters and gates arrive behind the
 *  WorkerAdapter/Gate seams (src/types.ts), model IDs only as strings. */
export interface ResolvedJob {
  id: string
  phaseId: string
  /** Expanded edges (job deps + phase-dep expansion) the ready function enforces. */
  dependencies: string[]
  brief: string
  model: string
  worker: WorkerAdapter
  timeoutMs: number
  gates: Gate[]
  /** Evidence probes (T-015, spec §12) behind the Probe seam. Absent when
   *  the job has none — default-mode jobs never carry probes. */
  probes?: Probe[]
}

/** The validated spec a --jobs run drives: the declared phases (for the
 *  recorded schedule) plus the resolved jobs. */
export interface ScheduledRunSpec {
  phases: PhaseSpec[]
  jobs: ResolvedJob[]
}

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
  /**
   * T-009 --jobs mode: the validated job spec's phases and fully resolved
   * jobs. Present ⇒ DAG-driven: no planner (briefs come from the jobs),
   * dispatch follows the deterministic ready function, and the run report
   * carries the schedule block. Absent ⇒ default mode: the degenerate
   * one-phase spec is synthesized from candidateIds + briefs and driven
   * through the same loop, with NO schedule block — today's behavior.
   */
  scheduled?: ScheduledRunSpec
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
  // T-010: the run header is the first dispatch.jsonl line — recovery derives
  // the target repo and the retry bound (maxAttempts) from it after a crash.
  appendDispatchEvidence(opts.artifactsDir, {
    type: 'run',
    runId: opts.runId,
    repo: opts.repo,
    baseSha: opts.baseSha,
    goal: opts.goal,
    model: opts.model,
    maxAttempts: opts.maxAttempts,
    startedAt,
  })

  // Planning tier (default mode only): one smart-model job turns the goal
  // into N distinct briefs. Failure here degrades gracefully — candidates
  // fall back to the raw goal. --jobs mode skips it entirely: briefs come
  // from the spec and the goal is not required.
  let briefs: string[] = opts.candidateIds.map(() => opts.goal)
  let planner: PlannerReport | undefined
  if (!opts.scheduled && opts.plannerModel) {
    planner = await runPlannerPhase(opts)
    if (planner.ok) briefs = planner.briefs
    console.log(`planner: ${planner.ok ? `${briefs.length} briefs` : 'no valid output, using raw goal'} in ${(planner.durationMs / 1000).toFixed(0)}s (${planner.attempts} attempt${planner.attempts > 1 ? 's' : ''})`)
    console.log('')
  }

  // The job list the scheduler drives (T-009). --jobs mode: the resolved
  // specs. Default mode: the degenerate one-phase spec — one dependency-free
  // job per candidate, exactly T-006's derived DAG — so both modes run the
  // same loop; only the schedule recording differs.
  const jobs: ResolvedJob[] = opts.scheduled?.jobs ?? opts.candidateIds.map((id, i) => ({
    id,
    phaseId: DERIVED_PHASE_ID,
    dependencies: [],
    brief: briefs[i]!,
    model: opts.model,
    worker: opts.worker,
    timeoutMs: opts.timeoutMs,
    gates: opts.gates,
  }))

  // Scheduler loop (T-009): repeatedly take the deterministic ready list and
  // dispatch up to the concurrency cap. dispatchIndex is a job's position in
  // the run's dispatch order; terminal states feed the next ready call. A
  // job whose dependencies can never reach terminal success (an upstream
  // failure) is simply never dispatched — recorded, not fabricated.
  const nodes = jobs.map((j) => ({ id: j.id, phaseId: j.phaseId, dependencies: j.dependencies }))
  const byId = new Map(jobs.map((j) => [j.id, j]))
  const terminal = new Map<string, 'succeeded' | 'failed'>()
  const running = new Set<string>()
  const inFlight = new Set<Promise<void>>()
  const dispatchIndexOf = new Map<string, number>()
  const reports = new Map<string, CandidateReport>()
  let dispatched = 0
  for (;;) {
    for (const id of readyJobs(nodes, terminal, running, opts.concurrency)) {
      const job = byId.get(id)!
      dispatchIndexOf.set(id, dispatched++)
      running.add(id)
      const p = runJob(job, opts).then((rep) => {
        reports.set(id, rep)
        terminal.set(id, rep.passedAllGates ? 'succeeded' : 'failed')
      }).finally(() => {
        running.delete(id)
        inFlight.delete(p)
      })
      inFlight.add(p)
    }
    if (inFlight.size === 0) break
    await Promise.race([...inFlight])
  }

  const report: RunReport = {
    runId: opts.runId,
    repo: opts.repo,
    baseSha: opts.baseSha,
    goal: opts.goal,
    model: opts.model,
    planner,
    startedAt,
    finishedAt: new Date().toISOString(),
    // Report order follows the spec order (candidateIds order in default
    // mode) — today's summary/ingest order. Only dispatched jobs appear: a
    // never-dispatched job is recorded as not-dispatched in the schedule
    // block, never fabricated as a candidate.
    candidates: jobs.map((j) => reports.get(j.id)).filter((r): r is CandidateReport => r !== undefined),
  }
  if (opts.scheduled) {
    report.schedule = buildSchedule(opts.scheduled.phases, nodes, terminal, dispatchIndexOf)
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

/** Execute one job (T-009): the T-007 attempt loop verbatim, with the job's
 *  resolved config in place of the run-level fields. The first attempt's
 *  worktree is leased LAZILY here — when the scheduler dispatches the job —
 *  at the run's baseSha, never up front; retry attempts lease their own
 *  fresh worktree (wt/<jobId>-a<n>) at the same baseSha. A mechanical
 *  failure (throw or !workerOk) requeues as a fresh attempt while the
 *  maxAttempts bound allows; a succeeded-but-no-op or gates-failed leg is a
 *  verdict and is never re-rolled (decisions.md: gates decide survival). */
async function runJob(job: ResolvedJob, opts: SkeletonOptions): Promise<CandidateReport> {
  const id = job.id
  const dir = join(opts.artifactsDir, id)
  mkdirSync(dir, { recursive: true })
  const base: CandidateReport = {
    id,
    workerId: job.worker.id,
    model: job.model,
    brief: job.brief,
    workspacePath: null,
    workerOk: false,
    workerTimedOut: false,
    workerDurationMs: 0,
    diffPath: null,
    diffBytes: 0,
    gates: [],
    passedAllGates: false,
    attempts: [],
  }

  let lease: WorkspaceLease | null = null
  // T-011: cleanup failures accumulate across the job's attempts (worker-side
  // from every executed attempt, gate-side from the final one) and land on
  // the candidate report — recorded evidence that never changes a verdict
  // (decisions.md: gates decide survival).
  const cleanupFailures: string[] = []
  for (let n = 1; ; n++) {
    // Attempt-scoped lease id (T-007): two leases on `wt/<id>` would both
    // derive `swarm/wt-<id>` (the T-004 branch-collision hazard), and
    // attempt 2 would overwrite attempt 1's worker.log. Job ids are unique
    // per spec and charset-restricted (src/scheduler.ts), so the branches
    // cannot collide mid-run. Attempts ≥ 2 get their own evidence directory.
    lease = opts.workspaces.lease(n === 1 ? `wt/${id}` : `wt/${id}-a${n}`, opts.baseSha)
    base.workspacePath = lease.path
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
      inputContextHash: inputContextHash(job.brief, job.model, lease.path),
      promptVersion: null,
      outputArtifacts: [logPath],
    }
    base.attempts.push(attempt)
    // T-010: the dispatch is on disk the moment the lease exists — a crash
    // after this point leaves the worktree discoverable and the attempt
    // reconcilable (dispatch without a completion line = recorded-running).
    appendDispatchEvidence(opts.artifactsDir, {
      type: 'dispatch',
      jobId: id,
      attempt: n,
      leaseId: lease.id,
      branch: lease.branch,
      worktreePath: lease.path,
      startedAt: attempt.startedAt,
    })

    try {
      console.log(`[${id}] attempt ${n}: worker start (${job.worker.id}, model=${job.model})`)
      const result = await job.worker.execute({
        prompt: builderPrompt(job.brief, lease.path),
        model: job.model,
        cwd: lease.path,
        logPath,
        timeoutMs: job.timeoutMs,
        // T-010: the pid line lands as soon as the adapter knows its root
        // pid — before any hang — so recovery can find it after a crash
        // while execute() never resolves.
        onSpawn: (pid) => appendDispatchEvidence(opts.artifactsDir, {
          type: 'pid',
          jobId: id,
          attempt: n,
          pid,
          at: new Date().toISOString(),
        }),
      })
      attempt.endedAt = new Date().toISOString()
      console.log(`[${id}] attempt ${n}: worker done in ${(result.durationMs / 1000).toFixed(0)}s ok=${result.ok} exit=${result.exitCode}`)
      // T-011: worker-side cleanup failures (a timeout kill that could not be
      // verified) are evidence on the candidate, never a retry/verdict input.
      cleanupFailures.push(...(result.cleanupFailures ?? []))

      // A failed worker is the only worker-side retryable leg. A worker that
      // SUCCEEDED is final no matter what the verdict will be: zero-byte
      // diffs and failed gates are ladder verdicts, and re-rolling them
      // would be model-shopping around a machine verdict (decisions.md:
      // gates decide survival).
      const failure: FailureRecord | null = result.ok ? null : {
        reason: 'worker-failed',
        message: result.timedOut ? `worker timed out after ${job.timeoutMs}ms` : `worker exited with code ${result.exitCode}`,
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

      // T-010: the attempt's completion line — written only when the adapter
      // RESOLVED (a thrown attempt gets none, so recovery conservatively
      // treats it as recorded-running and can still kill its recorded pid).
      // diffBytes is the captured diff's size; a FAILED capture is recorded
      // as null, never as 0 — a zero-byte diff is a machine verdict (the
      // NO-OP rule), and absent evidence must not be readable as one.
      appendDispatchEvidence(opts.artifactsDir, {
        type: 'completion',
        jobId: id,
        attempt: n,
        ok: result.ok,
        timedOut: result.timedOut,
        exitCode: result.exitCode,
        diffBytes: diffCaptured ? Buffer.byteLength(diff) : null,
        endedAt: attempt.endedAt,
      })

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
      // job's top-level fields are this attempt's values — the exact flow
      // and verdict ladder the runner had before T-009, so the run summary,
      // the store's per-candidate writes, and clean/integrate discovery are
      // unchanged.
      attempt.state = result.ok ? 'succeeded' : 'failed'
      if (failure) attempt.failure = failure
      base.workerOk = result.ok
      base.workerTimedOut = result.timedOut
      base.workerDurationMs = result.durationMs
      if (diffCaptured) {
        base.diffPath = diffPath
        base.diffBytes = Buffer.byteLength(diff)
      }

      for (const gate of job.gates) {
        const r: GateResult = await gate.run(lease.path)
        base.gates.push(r)
        // T-011: gate-side cleanup failures (a timed-out gate whose tree kill
        // was not proven good) join the candidate's evidence, named by gate.
        cleanupFailures.push(...(r.cleanupFailures ?? []).map((line) => `gate ${r.name}: ${line}`))
        console.log(`[${id}] gate ${r.name}: ${r.passed ? 'PASS' : 'FAIL'} (${(r.durationMs / 1000).toFixed(1)}s)`)
      }
      base.passedAllGates = base.gates.length > 0 && base.gates.every((g) => g.passed) && base.diffBytes > 0

      // T-015: probes ride beside the ladder as a parallel evidence seam —
      // run on the final completed attempt immediately after the gate loop,
      // before review and workspace dispose, REGARDLESS of gate outcomes
      // (evidence about failures is evidence). The expression above is
      // byte-identical to the pre-probe ladder and stays the only verdict
      // input: a probe result, including a success:false bundle, never
      // changes a verdict or a gate PASS/FAIL (decisions.md 2026-10-10:
      // machine gates decide survival; probes advise/record).
      if (job.probes && job.probes.length > 0) {
        base.probes = await runProbes(job, opts, lease)
      }

      if (opts.reviewerModel && base.passedAllGates) {
        base.review = await runReview(opts, {
          id,
          dir,
          workspacePath: lease.path,
          brief: job.brief,
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
      console.log(`[${id}] job errored: ${base.error}`)
      break
    }
  }

  if (opts.cleanWorkspaces) {
    try {
      opts.workspaces.dispose(lease!)
      base.workspacePath = null
    } catch (e) {
      console.log(`[${id}] workspace dispose failed: ${errorMessage(e)}`)
    }
  }

  // T-011: the candidate report's one place answering "did anything survive a
  // timeout". Absent when nothing failed — happy-path reports are unchanged —
  // and never an input to any verdict.
  if (cleanupFailures.length > 0) base.cleanupFailures = cleanupFailures

  return base
}

/** Execute one job's probes on its final completed attempt (T-015, spec
 *  §12): each probe runs behind the Probe seam, its EvidenceBundle is
 *  validated and written to <artifactsDir>/probes/<candidateId>/<probeId>.json
 *  under the run's artifacts dir (decisions.md 2026-10-10: run root
 *  C:\swarm\; never the worktree as the durable copy), and the summary
 *  lands on the candidate report. A probe that throws records a
 *  success:false bundle with the error and never breaks the run; a bundle
 *  that cannot be written is logged and skipped (no summary ever names a
 *  file that is not on disk). Nothing here touches any verdict. */
async function runProbes(job: ResolvedJob, opts: SkeletonOptions, lease: WorkspaceLease): Promise<ProbeRunSummary[]> {
  const summaries: ProbeRunSummary[] = []
  for (const probe of job.probes ?? []) {
    const started = Date.now()
    let bundle
    try {
      bundle = await probe.run({
        workspace: lease,
        scenario: probe.scenario,
        environment: { artifactsDir: opts.artifactsDir, candidateId: job.id },
      })
    } catch (e) {
      bundle = failedBundle(probe.id, probe.scenario.id, errorMessage(e))
    }
    console.log(`[${job.id}] probe ${probe.id}: ${bundle.success ? 'PASS' : 'FAIL'} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    try {
      const bundlePath = writeEvidenceBundle(bundle, { artifactsDir: opts.artifactsDir, candidateId: job.id })
      summaries.push({
        probeId: probe.id,
        scenarioId: probe.scenario.id,
        success: bundle.success,
        durationMs: Date.now() - started,
        bundlePath,
      })
    } catch (e) {
      console.log(`[${job.id}] probe ${probe.id}: evidence write failed: ${errorMessage(e)}`)
    }
  }
  return summaries
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
