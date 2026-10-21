import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBriefs, parseReview } from './parse.js'
import { evidenceBundlePath, failedBundle, writeEvidenceBundle } from './probe.js'
import type { Probe } from './probe.js'
import { composeRoundPacket } from './rounds.js'
import { buildEarlyStops, buildSchedule, earlyStopMet, readyJobs } from './scheduler.js'
import type { EarlyStopPolicy, PhaseSpec } from './scheduler.js'
import { DERIVED_PHASE_ID } from './store/index.js'
import type { Attempt, CandidateReport, FailureRecord, Gate, GateResult, PlannerReport, ProbeRunSummary, ReviewReport, RoundRecord, RunReport, WorkerAdapter, WorkspaceLease, WorkspaceProvider } from './types.js'

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
 *     (gains an optional `gateRetry: true` field when the T-038 flag is set —
 *      recovery derives the one-attempt-taller bound from it; absent otherwise,
 *      so a flag-less header is byte-identical)
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
  /**
   * T-038 bounded gate-failure retry: grant each candidate EXACTLY ONE extra
   * attempt when its worker succeeded but the machine gates rejected the
   * change, with the retry brief composed mechanically from the gates' own
   * recorded output (name, command, outputTail) plus the captured diff. The
   * bound is fixed at one — no numeric knob. Blind re-rolls stay banned:
   * zero-byte diffs, no-gates candidates, failed diff captures, and
   * worker-failed legs (T-007's `maxAttempts`) are never retried by this
   * flag. The same Gate objects re-run unchanged on the retry; both legs are
   * recorded; the final attempt's verdict stands (decisions.md 2026-10-21).
   * Absent/false = today's ladder exactly.
   */
  gateRetry?: boolean
  /**
   * T-025 per-role harness selection: the planner's and reviewer's own
   * adapters. Optional — absent (the default) resolves to `worker`, so all
   * three roles ride the run-level adapter exactly as before and direct
   * `runSkeleton` callers compile and behave unchanged. The CLI builds a
   * role's adapter through the same createWorker only for a non-default
   * `--planner-worker`/`--reviewer-worker` selection.
   */
  plannerWorker?: WorkerAdapter
  reviewerWorker?: WorkerAdapter
  /**
   * T-030 bounded R&D loop: total planning/implementation rounds (1..2 —
   * capped at 2 this slice, refused beyond that at the CLI). Default/absent
   * = 1 = the single-pass behavior exactly; no `rounds` block on the report.
   * At 2, round 1 runs as today and — when it produced at least one gate
   * survivor — the round composer (src/rounds.ts) renders the survivors'
   * evidence into the round-2 planner prompt, and a fresh candidate wave
   * (ids `<survivorId>-r2`, same baseSha) repeats the mechanics. Only
   * meaningful in planner mode (`--goal`): a `--jobs` run or `--no-planner`
   * has no planner phase to feed (refused at the CLI; a direct caller
   * passing `rounds: 2` with either gets round 2 recorded as not executed,
   * never fabricated).
   */
  rounds?: number
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
  // T-038: the header carries `gateRetry: true` when the flag is set, so
  // recovery derives the one-attempt-taller bound; the field is absent
  // otherwise (the flag-less header is byte-identical to today's).
  appendDispatchEvidence(opts.artifactsDir, {
    type: 'run',
    runId: opts.runId,
    repo: opts.repo,
    baseSha: opts.baseSha,
    goal: opts.goal,
    model: opts.model,
    maxAttempts: opts.maxAttempts,
    ...(opts.gateRetry === true ? { gateRetry: true } : {}),
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

  const round1 = await driveJobs(jobs, opts)
  let candidates = jobs.map((j) => round1.reports.get(j.id)).filter((r): r is CandidateReport => r !== undefined)
  const schedule = opts.scheduled
    ? buildSchedule(opts.scheduled.phases, round1.nodes, round1.terminal, round1.dispatchIndexOf)
    : undefined
  // T-031: the early-stop evidence block — one record per phase that
  // DECLARED a policy, derived from the same inputs as the schedule block.
  // Present only when a `--jobs` phase declared one; default mode AND
  // policy-less `--jobs` runs carry no block (the report is unchanged).
  const earlyStops = opts.scheduled
    ? buildEarlyStops(opts.scheduled.phases, round1.nodes, round1.terminal, round1.dispatchIndexOf)
    : undefined

  // The bounded R&D loop (T-030): round 1's survivors are planning evidence
  // for one more round. The composer (src/rounds.ts) is pure and renders a
  // fixed-framing text block; the block rides the round-2 planner prompt —
  // prompt text, never capability — and round 2 re-enters the SAME
  // mechanics: runPlannerPhase unchanged (same artifact-only scratch-dir
  // posture, parseBriefs unchanged), then a fresh candidate wave through the
  // same scheduler loop on fresh state, leased at the SAME baseSha (survivor
  // diffs are planning evidence, never stacked patches — candidate lineage
  // is M8). Round-2 ids are `<survivorId>-r2` (SPEC_ID_PATTERN-safe), so
  // branches, store rows, and report entries never collide across rounds.
  // One runId, one checkout lock (held by the caller across both rounds);
  // dispatch.jsonl keeps its line shapes — round 2 is just more dispatch
  // lines after the one run header written above.
  const roundsWanted = opts.rounds ?? 1
  let rounds: RoundRecord[] | undefined
  if (roundsWanted >= 2) {
    const round1Survivors = candidates.filter((c) => c.passedAllGates)
    rounds = [{ round: 1, executed: true, survivorIds: round1Survivors.map((c) => c.id) }]
    // Round 2 needs a planner phase to feed: --jobs mode has none (the CLI
    // refuses the combination; a direct caller gets the round recorded as
    // not executed, never fabricated), and so does --no-planner. No
    // round-1 survivor means there is no evidence to compose from — round 2
    // is recorded not-executed rather than run blind.
    if (!opts.scheduled && opts.plannerModel !== null && round1Survivors.length > 0) {
      const composition = composeRoundPacket({ candidates, model: opts.plannerModel, finishedRound: 1 })
      const renderedBlockPath = join(opts.artifactsDir, 'round-2-context-block.txt')
      writeFileSync(renderedBlockPath, composition.renderedBlock)
      const round2Ids = round1Survivors.map((s) => `${s.id}-r2`)
      let briefs2: string[] = round2Ids.map(() => opts.goal)
      const planner2 = await runPlannerPhase(opts, {
        count: round2Ids.length,
        contextBlock: composition.renderedBlock,
        evidenceTag: '-r2',
      })
      if (planner2.ok) briefs2 = planner2.briefs
      console.log(`planner (round 2): ${planner2.ok ? `${briefs2.length} briefs` : 'no valid output, using raw goal'} in ${(planner2.durationMs / 1000).toFixed(0)}s (${planner2.attempts} attempt${planner2.attempts > 1 ? 's' : ''})`)
      console.log('')
      const jobs2: ResolvedJob[] = round2Ids.map((id, i) => ({
        id,
        phaseId: DERIVED_PHASE_ID,
        dependencies: [],
        brief: briefs2[i]!,
        model: opts.model,
        worker: opts.worker,
        timeoutMs: opts.timeoutMs,
        gates: opts.gates,
      }))
      const round2 = await driveJobs(jobs2, opts)
      const candidates2 = jobs2.map((j) => round2.reports.get(j.id)).filter((r): r is CandidateReport => r !== undefined)
      rounds.push({
        round: 2,
        executed: true,
        survivorIds: candidates2.filter((c) => c.passedAllGates).map((c) => c.id),
        packetFingerprint: composition.packet.fingerprint.hash,
        renderedBlockPath,
      })
      candidates = [...candidates, ...candidates2]
      planner = planner2
    } else {
      rounds.push({ round: 2, executed: false, survivorIds: [] })
    }
  }

  const report: RunReport = {
    runId: opts.runId,
    repo: opts.repo,
    baseSha: opts.baseSha,
    goal: opts.goal,
    model: opts.model,
    // The last executed planner phase's report — round 2's when the loop
    // ran (the planner whose briefs the final candidate wave rode), round
    // 1's otherwise. Round 1's planner evidence stays on disk at today's
    // paths (planner.log / planner-raw.txt).
    planner,
    startedAt,
    finishedAt: new Date().toISOString(),
    // Report order follows the spec order (candidateIds order in default
    // mode) — today's summary/ingest order. Only dispatched jobs appear: a
    // never-dispatched job is recorded as not-dispatched in the schedule
    // block, never fabricated as a candidate. Round-2 candidates append
    // after round 1's, in round-1 survivor order.
    candidates,
  }
  if (schedule) {
    report.schedule = schedule
  }
  if (earlyStops !== undefined && earlyStops.length > 0) {
    report.earlyStops = earlyStops
  }
  if (rounds !== undefined) {
    report.rounds = rounds
  }
  writeFileSync(join(opts.artifactsDir, 'report.json'), JSON.stringify(report, null, 2))
  return report
}

/** The dispatch-eligible nodes: the job DAG minus the early-stop-suppressed
 *  jobs (T-031). This filtering MUST happen BEFORE `readyJobs` applies its
 *  concurrency-cap slice, not after it: a suppressed-but-ready job sorting
 *  ahead of another phase's ready job would otherwise occupy the whole cap
 *  slice every iteration, strand that phase's dispatchable work for the rest
 *  of the run, and record a false 'blocked' (review round 1 red — ES7 pins
 *  exactly that adversarial ordering). A stopped phase may only skip its OWN
 *  undispatched work; it never consumes another phase's dispatch capacity.
 *  Suppression is monotone (a met policy stays met), so recomputing the
 *  filter per iteration is stable. No policies ⇒ no suppression ⇒ the
 *  caller passes the input through unchanged. */
function eligibleForDispatch(
  nodes: { id: string; phaseId: string; dependencies: string[] }[],
  suppressed: ReadonlySet<string>,
): { id: string; phaseId: string; dependencies: string[] }[] {
  return suppressed.size === 0 ? nodes : nodes.filter((n) => !suppressed.has(n.id))
}

/** The scheduler loop (T-009): repeatedly take the deterministic ready list
 *  and dispatch up to the concurrency cap. dispatchIndex is a job's position
 *  in the run's dispatch order; terminal states feed the next ready call. A
 *  job whose dependencies can never reach terminal success (an upstream
 *  failure) is simply never dispatched — recorded, not fabricated. Each
 *  round of the bounded loop (T-030) drives its own job wave through this
 *  one loop with fresh state — the round-2 wave shares no terminal/dispatch
 *  bookkeeping with round 1's.
 *
 *  T-031 phase-level early stop (spec §20): policies come ONLY from the
 *  --jobs spec's phases (`opts.scheduled`); default mode has none and the
 *  loop is untouched. Per iteration, a phase whose policy is MET (the pure
 *  `earlyStopMet` — monotone, since terminal success never un-happens) has
 *  its not-yet-dispatched jobs filtered out of the dispatch-eligible input
 *  BEFORE the ready call's concurrency-cap slice (`eligibleForDispatch`) —
 *  a stopped phase never occupies another phase's dispatch capacity. The
 *  stop ONLY suppresses dispatch: an in-flight job runs to completion —
 *  never killed, no cancellation path; a suppressed job stays non-terminal,
 *  records `dispatchIndex: null` (not-dispatched, never fabricated as
 *  terminal), and its dependents are never ready (readyJobs requires
 *  dependencies at terminal success). Termination is unchanged: suppressed
 *  jobs never dispatch, `inFlight` drains, the `inFlight.size === 0` break
 *  fires exactly as before. A dispatched job's verdict ladder below dispatch
 *  is untouched by the stop. */
async function driveJobs(jobs: ResolvedJob[], opts: SkeletonOptions): Promise<{
  reports: Map<string, CandidateReport>
  terminal: Map<string, 'succeeded' | 'failed'>
  dispatchIndexOf: Map<string, number>
  nodes: { id: string; phaseId: string; dependencies: string[] }[]
}> {
  const nodes = jobs.map((j) => ({ id: j.id, phaseId: j.phaseId, dependencies: j.dependencies }))
  const byId = new Map(jobs.map((j) => [j.id, j]))
  const terminal = new Map<string, 'succeeded' | 'failed'>()
  const running = new Set<string>()
  const inFlight = new Set<Promise<void>>()
  const dispatchIndexOf = new Map<string, number>()
  const reports = new Map<string, CandidateReport>()
  let dispatched = 0
  // T-031: the declaring phases' policies, by phase id (default mode: empty
  // ⇒ no stop input anywhere). Once met, a policy stays met.
  const stopPolicies = new Map<string, EarlyStopPolicy>()
  for (const p of opts.scheduled?.phases ?? []) {
    if (p.earlyStop !== undefined) stopPolicies.set(p.id, p.earlyStop)
  }
  const suppressed = new Set<string>()
  for (;;) {
    if (stopPolicies.size > 0) {
      for (const [phaseId, policy] of stopPolicies) {
        if (earlyStopMet(policy, nodes.filter((n) => n.phaseId === phaseId), terminal)) {
          for (const n of nodes) {
            if (n.phaseId === phaseId) suppressed.add(n.id)
          }
        }
      }
    }
    for (const id of readyJobs(eligibleForDispatch(nodes, suppressed), terminal, running, opts.concurrency)) {
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
  return { reports, terminal, dispatchIndexOf, nodes }
}

function plannerPrompt(goal: string, count: number, contextBlock?: string): string {
  const lines = [
    'You are the planning tier of a multi-candidate implementation system.',
    `GOAL: ${goal}`,
  ]
  // T-030: the round composer's rendered block rides as an optional section
  // between the goal and the output contract — prompt text, never
  // capability: the planner keeps its artifact-only scratch-dir posture and
  // parseBriefs parses the reply exactly as round 1's. Absent (every n=1
  // run) ⇒ the prompt is byte-identical to the pre-T-030 text.
  if (contextBlock !== undefined) {
    lines.push('', contextBlock)
  }
  lines.push(
    '',
    `Produce exactly ${count} distinct implementation briefs, one per candidate worker.`,
    'Each brief must be self-contained, concrete, and independently implementable as a small diff.',
    'Where the goal allows more than one approach, vary the approach across briefs.',
    'Do not reference "the other briefs"; each worker sees only its own.',
    '',
    `Output ONLY a JSON array of ${count} strings. No markdown fences, no commentary.`,
  )
  return lines.join('\n')
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

/** One planner phase's round-scoped inputs (T-030): the candidate count the
 *  prompt asks briefs for, the composer's rendered context block to embed
 *  (round 2 only), and the evidence-filename tag keeping a second round's
 *  planner evidence from overwriting round 1's (round 2 writes
 *  planner-r2.log / planner-r2-raw.txt; round 1 keeps today's paths). */
interface PlannerRound {
  count: number
  contextBlock?: string
  evidenceTag?: string
}

async function runPlannerPhase(opts: SkeletonOptions, round?: PlannerRound): Promise<PlannerReport> {
  // T-025: the planner rides its own adapter when one was selected,
  // otherwise the run-level worker — the flags-absent default is today's
  // behavior exactly. One local covers both execute calls (they share baseReq).
  const worker = opts.plannerWorker ?? opts.worker
  const count = round?.count ?? opts.candidateIds.length
  const prompt = plannerPrompt(opts.goal, count, round?.contextBlock)
  const logPath = join(opts.artifactsDir, `planner${round?.evidenceTag ?? ''}.log`)
  const rawOutputPath = join(opts.artifactsDir, `planner${round?.evidenceTag ?? ''}-raw.txt`)
  const started = Date.now()

  // T-023 (spec §3.6:144, §14): the planner's capability posture is
  // mechanism-level now, not prompt-reinforced. Its cwd is a fresh disposable
  // scratch dir under the run artifacts — never the canonical checkout
  // (ground rule 3), never any repo — with the 'artifact-only' policy passed
  // explicitly so the adapter restricts the spawn. The prompt names no repo
  // path (plannerPrompt: goal + count only), so this removes an accidental
  // capability, not a used one. Scratch contents are never evidence:
  // planner evidence stays planner.log + planner-raw.txt. Both execute calls
  // (initial + repair) share baseReq, so one change covers both.
  const scratchDir = join(opts.artifactsDir, 'planner-scratch')
  mkdirSync(scratchDir, { recursive: true })
  try {
    const baseReq = {
      model: opts.plannerModel!,
      cwd: scratchDir,
      logPath,
      timeoutMs: opts.timeoutMs,
      executionPolicy: 'artifact-only',
    } as const
    let result = await worker.execute({ ...baseReq, prompt })
    let attempts = 1
    let briefs = result.ok ? parseBriefs(result.responseTail, count) : null

    if (!briefs && !result.timedOut) {
      attempts = 2
      console.log('planner: output was not a valid JSON array, running one bounded repair attempt')
      result = await worker.execute({
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
  } finally {
    // Best-effort removal — the scratch dir is never evidence, and cleanup
    // failure must not mask the planner's report.
    try {
      rmSync(scratchDir, { recursive: true, force: true })
    } catch {
      // Best-effort by contract.
    }
  }
}

async function runReview(
  opts: SkeletonOptions,
  ctx: { id: string; dir: string; workspacePath: string; brief: string; diff: string; gateLines: string[] },
): Promise<ReviewReport> {
  // T-025: the reviewer rides its own adapter when one was selected (in BOTH
  // modes — review runs post-gates in both), otherwise the run-level worker.
  // One local covers both execute calls (they share baseReq).
  const worker = opts.reviewerWorker ?? opts.worker
  const prompt = reviewerPrompt(ctx.brief, ctx.workspacePath, ctx.diff, ctx.gateLines)
  const logPath = join(ctx.dir, 'reviewer.log')
  const rawOutputPath = join(ctx.dir, 'review-raw.txt')
  const started = Date.now()

  // T-023 (spec §14): the reviewer's posture is mechanism-level now — the
  // 'worktree-read' policy is passed explicitly and the OpenCode adapter
  // restricts the spawn to its plan agent (edit tools deny-listed). The cwd
  // stays the candidate worktree lease: a disposable workspace whose diff
  // and gate results were already captured into evidence files before review
  // runs (the capture is above; review is invoked below), so the canonical
  // repo is never exposed either way. The prompt's "Do not modify any files"
  // line stays as reinforcement (decisions.md: prompts are
  // defense-in-depth, never the boundary).
  const baseReq = {
    model: opts.reviewerModel!,
    cwd: ctx.workspacePath,
    logPath,
    timeoutMs: opts.timeoutMs,
    executionPolicy: 'worktree-read',
  } as const
  let result = await worker.execute({ ...baseReq, prompt })
  let attempts = 1
  let review = result.ok ? parseReview(result.responseTail) : null

  if (!review && !result.timedOut) {
    attempts = 2
    console.log(`[${ctx.id}] review: output was not a valid observation object, running one bounded repair attempt`)
    result = await worker.execute({
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

/** T-038: the composed feedback brief for the one bounded gate retry — pure
 *  string assembly in the runner, no model call composes or adjudicates it
 *  (decisions.md 2026-10-21). Fixed framing: the change WAS applied and
 *  these machine gates rejected it; fix the failures — the same gates re-run
 *  unchanged on the new attempt. Content: the original brief, the failing
 *  attempt's captured diff (char-capped at MAX_DIFF_CHARS, the
 *  reviewer-prompt precedent), per FAILING gate its name, its recorded
 *  command (`GateResult.command`, T-027) and its `outputTail` (the 4000-byte
 *  tail, src/gate/command.ts), and the worker's attempt summary where the
 *  harness produced one. Passing gates contribute nothing. The returned
 *  fingerprint is the sha256 of the exact text — the bytes written to the
 *  retry attempt's `retry-brief.txt` AND wrapped into its prompt (the T-030
 *  packetFingerprint pattern; one composition, two consumers). */
function composeGateRetryBrief(
  brief: string,
  diff: string,
  failedGates: GateResult[],
  workerSummary: string,
): { text: string; fingerprint: string } {
  const truncated = diff.length > MAX_DIFF_CHARS
  const lines = [
    'Your previous attempt below WAS APPLIED to the workspace, but the machine gates REJECTED it.',
    'Fix the gate failures. The SAME machine gates re-run unchanged on this new attempt.',
    '',
    'ORIGINAL BRIEF:',
    brief,
    '',
    `YOUR PREVIOUS DIFF${truncated ? ` (truncated to ${MAX_DIFF_CHARS} chars)` : ''}:`,
    diff.slice(0, MAX_DIFF_CHARS),
    '',
  ]
  const summary = workerSummary.trim()
  if (summary !== '') {
    lines.push('YOUR PREVIOUS ATTEMPT SUMMARY:', summary, '')
  }
  lines.push('FAILED MACHINE GATES:')
  for (const g of failedGates) {
    lines.push(
      '',
      `GATE: ${g.name}`,
      `COMMAND: ${g.command ?? '(not recorded)'}`,
      'OUTPUT (tail):',
      g.outputTail,
    )
  }
  const text = lines.join('\n')
  return { text, fingerprint: createHash('sha256').update(text).digest('hex') }
}

/** Execute one job (T-009): the T-007 attempt loop verbatim, with the job's
 *  resolved config in place of the run-level fields. The first attempt's
 *  worktree is leased LAZILY here — when the scheduler dispatches the job —
 *  at the run's baseSha, never up front; retry attempts lease their own
 *  fresh worktree (wt/<jobId>-a<n>) at the same baseSha. A mechanical
 *  failure (throw or !workerOk) requeues as a fresh attempt while the
 *  maxAttempts bound allows; a succeeded-but-no-op or no-gates leg is a
 *  verdict and is never re-rolled (decisions.md: gates decide survival).
 *
 *  T-038: under `--gate-retry`, a worker-succeeded attempt whose captured
 *  diff is non-zero but whose machine gates reject it gets EXACTLY ONE more
 *  attempt (a flag-firing attempt is recorded 'failed' with reason
 *  'gates-failed', its gate results attached attempt-scoped) — the retry
 *  brief composed mechanically from the gates' own recorded output. The
 *  bound is one per candidate regardless of maxAttempts (total attempts
 *  ≤ maxAttempts + 1). The retry brief becomes the retry attempt's brief:
 *  its promptVersion and inputContextHash hash the composed text (the hash
 *  correctly differs from attempt 1's — the brief differs), while
 *  `base.brief` keeps the ORIGINAL brief. Blind re-rolls stay banned
 *  (decisions.md 2026-10-21). */
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
  // T-038: the brief the CURRENT attempt is dispatched with — the original
  // brief for attempt 1, the composed feedback brief for a gate-retry leg.
  // `base.brief` keeps the ORIGINAL brief; the composed text is attempt-scoped
  // evidence, never a replacement.
  let attemptBrief = job.brief
  // T-038: the composed retry brief, composed ONCE per retry (below) and
  // consumed at the top of the retry leg's iteration — one composition, two
  // consumers: the exact prompt text (hashed into that attempt's
  // promptVersion) and the `retry-brief.txt` evidence file.
  let pendingRetryBrief: string | null = null
  // T-038: the bound is one gate-retry per candidate, regardless of
  // maxAttempts (total attempts ≤ maxAttempts + 1).
  let gateRetryUsed = false
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

    // T-029 (spec §6.7:446 — "Every agent attempt records the exact prompt
    // version used"): the builder prompt is composed ONCE per attempt, and the
    // SAME variable is both hashed into `promptVersion` and sent to the
    // adapter below — the hashed bytes and the sent bytes cannot drift. The
    // version is an EXACT-TEXT sha256, not a workspace-normalized template
    // hash: the prompt embeds the lease path, whose runDir carries the
    // timestamped runId, and retry attempts lease fresh paths (wt/<id>-a<n>),
    // so promptVersion values are unique per attempt by construction. That is
    // the point: cross-attempt input comparability is `inputContextHash`'s job
    // (sha256 over brief + model + the prompt with the workspace-path line
    // excluded — identical across same-brief attempts). The two fields answer
    // different questions — inputContextHash: "was this attempt asked the same
    // thing as that one?"; promptVersion: "is this the hash of the exact text
    // that produced this attempt's evidence?" Both are audit provenance;
    // neither ever touches a verdict (decisions.md 2026-10-10: machine gates
    // decide survival; models advise).
    // T-038: on a gate-retry leg the brief IS the composed feedback text —
    // attempt 2's inputContextHash correctly differs from attempt 1's,
    // because its brief differs; the hash is doing its job.
    const prompt = builderPrompt(attemptBrief, lease.path)
    const promptVersion = createHash('sha256').update(prompt).digest('hex')

    const attempt: Attempt = {
      id: `${id}-a${n}`,
      jobId: id,
      number: n,
      state: 'running',
      startedAt: new Date().toISOString(),
      inputContextHash: inputContextHash(attemptBrief, job.model, lease.path),
      promptVersion,
      outputArtifacts: [logPath],
    }
    base.attempts.push(attempt)
    // T-038: a gate-retry leg's evidence dir carries the composed brief —
    // the exact text hashed into `gateRetry.fingerprint` below and wrapped
    // into this attempt's prompt above.
    if (pendingRetryBrief !== null) {
      const retryBriefPath = join(evidenceDir, 'retry-brief.txt')
      writeFileSync(retryBriefPath, pendingRetryBrief)
      attempt.outputArtifacts.push(retryBriefPath)
      pendingRetryBrief = null
    }
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
        // The exact text hashed into attempt.promptVersion above (T-029) —
        // one composition, two consumers, no drift possible.
        prompt,
        model: job.model,
        cwd: lease.path,
        logPath,
        timeoutMs: job.timeoutMs,
        // T-023: the builder posture, passed explicitly — the check pins what
        // was sent, never what was defaulted (§14.1:1014: a write-capable
        // worker's writable workspace is the worktree, never the canonical
        // checkout — already true here by the worktree lease).
        executionPolicy: 'worktree-write',
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

      // The gates run on every attempt that reaches here (a final attempt of
      // either kind, or a worker-succeeded candidate the gate-retry may
      // claim). T-038: the results land in an attempt-local array so a
      // pre-retry leg's verdicts attach to THEIR attempt
      // (`Attempt.gateResults`) and `base.gates` keeps meaning "the FINAL
      // attempt's gates" — the pre-T-038 semantics, byte-for-byte.
      const attemptGates: GateResult[] = []
      for (const gate of job.gates) {
        const r: GateResult = await gate.run(lease.path)
        attemptGates.push(r)
        // T-011: gate-side cleanup failures (a timed-out gate whose tree kill
        // was not proven good) join the candidate's evidence, named by gate.
        cleanupFailures.push(...(r.cleanupFailures ?? []).map((line) => `gate ${r.name}: ${line}`))
        console.log(`[${id}] gate ${r.name}: ${r.passed ? 'PASS' : 'FAIL'} (${(r.durationMs / 1000).toFixed(1)}s)`)
      }

      // T-038: the ONE bounded feedback-informed gate retry. Every condition
      // is machine-checked: the worker succeeded, the diff was captured and
      // is non-zero (a zero-byte NO-OP or a failed capture has no failure
      // output to feed back — AGENTS.md #7), at least one of a non-empty
      // gate set failed (no-gates stays terminal), the flag is set, and this
      // candidate has not spent its one retry. The bound is one regardless
      // of maxAttempts — total attempts ≤ maxAttempts + 1. Blind re-rolls
      // stay banned: this leg's inputs are NEW information the first attempt
      // never had — the gates' own recorded output (decisions.md
      // 2026-10-21). The same Gate objects re-run unchanged above; the final
      // attempt's verdict below stands either way.
      const failedGates = attemptGates.filter((g) => !g.passed)
      if (opts.gateRetry === true && !gateRetryUsed && result.ok
        && diffCaptured && Buffer.byteLength(diff) > 0
        && attemptGates.length > 0 && failedGates.length > 0) {
        gateRetryUsed = true
        attempt.state = 'failed'
        attempt.failure = {
          reason: 'gates-failed',
          message: `machine gates rejected the change (${failedGates.map((g) => g.name).join(', ')}); one feedback-informed retry follows, composed from the gates' recorded output`,
          timedOut: false,
          exitCode: failedGates[0]!.exitCode,
        }
        // Attempt-scoped gate evidence: the pre-retry leg's verdicts attach
        // to their own attempt and would otherwise be lost (the final
        // attempt's gates overwrite the candidate-level array below).
        attempt.gateResults = attemptGates
        const composed = composeGateRetryBrief(job.brief, diff, failedGates, result.responseTail)
        pendingRetryBrief = composed.text
        base.gateRetry = {
          fromAttempt: n,
          toAttempt: n + 1,
          gates: failedGates.map((g) => g.name),
          fingerprint: composed.fingerprint,
        }
        attemptBrief = composed.text
        console.log(`[${id}] attempt ${n}: gates rejected the change (${failedGates.map((g) => g.name).join(', ')}); composing the one feedback-informed gate retry (attempt ${n + 1})`)
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
      base.gates = attemptGates
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
