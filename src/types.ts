// Core domain types for the stage-0 walking skeleton.
//
// The engine knows nothing about specific models, providers, or harnesses.
// Model IDs and harness specifics appear only as configuration passed to
// worker adapters. OpenCode is one adapter among future ones (Codex, a
// local OpenAI-compatible endpoint, ...), never an engine assumption.

export interface WorkerExecutionRequest {
  /** Fully composed prompt for this job. */
  prompt: string
  /** Model ID in the adapter's own vocabulary, e.g. "vendor/model-name". */
  model: string
  /** Absolute path of the directory the worker operates in. */
  cwd: string
  /** Absolute path of the file stdout/stderr are appended to. */
  logPath: string
  /** Hard wall-clock limit; the worker process tree is killed at expiry. */
  timeoutMs: number
}

export interface WorkerResult {
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  logPath: string
  /** Tail of the worker's stdout (ANSI stripped), for response parsing. */
  responseTail: string
}

/**
 * The only worker abstraction the engine ever sees. An adapter hides a
 * model + harness pairing behind spawn/collect semantics.
 */
export interface WorkerAdapter {
  readonly id: string
  execute(req: WorkerExecutionRequest): Promise<WorkerResult>
}

export interface WorkspaceLease {
  id: string
  path: string
  branch: string
  baseSha: string
}

/** Isolated, disposable candidate workspaces. */
export interface WorkspaceProvider {
  /** Create an isolated writable workspace pinned to `baseRef` (SHA preferred). */
  lease(id: string, baseRef: string): WorkspaceLease
  /** Unified diff of all changes (including new files) against the base. */
  diff(lease: WorkspaceLease): string
  /** Release the workspace; evidence must be collected beforehand. */
  dispose(lease: WorkspaceLease): void
}

export interface GateResult {
  name: string
  passed: boolean
  exitCode: number | null
  durationMs: number
  outputTail: string
}

/**
 * A deterministic check. Candidate survival is decided by gates,
 * never by a model's opinion.
 */
export interface Gate {
  readonly name: string
  run(cwd: string): Promise<GateResult>
}

// ---------- Attempts (T-007, spec §6.5) ----------
//
// The spec uses AttemptState/FailureRecord/ProcessIdentity/RetryPolicy only
// as field types (§6.4:364, §6.5:379,384,391) and never defines any of them;
// these are the vocabulary choices this repo locks, documented here.

/**
 * Lifecycle of one attempt of one job (spec §6.5). Only 'succeeded'/'failed'
 * have a producer in a finished-run store; 'abandoned' (the spec §15.2:1067 /
 * §29:1874 vocabulary) is added by the startup-reconciliation slice, which is
 * its only producer — not pre-defined here.
 */
export type AttemptState = 'running' | 'succeeded' | 'failed'

/**
 * Why an attempt failed. Reuses the elimination-ladder vocabulary
 * (`eliminationReason`, src/store/index.ts). Retryable attempts only ever
 * produce 'error' (the attempt threw) or 'worker-failed' (non-zero exit or
 * timeout); 'no-op'/'no-gates'/'gates-failed' are candidate verdicts on the
 * ladder, never attempt failures — a worker that succeeded is never re-rolled
 * around a machine verdict (decisions.md: gates decide survival).
 */
export type FailureReason = 'error' | 'worker-failed' | 'no-op' | 'no-gates' | 'gates-failed'

export interface FailureRecord {
  reason: FailureReason
  message: string
  timedOut: boolean
  exitCode: number | null
}

/**
 * The one failure policy this slice drives (§30:1893 "retry same worker
 * once", generalized to a bound). §30's other policies — alternate model,
 * schema repair, switch-worker, quorum, pause-for-human, abort — are carved
 * off until they have a producer.
 */
export interface RetryPolicy {
  maxAttempts: number
}

/**
 * Identity of the OS process tree running an attempt — what reconciliation
 * (spec §15.2/§29: stale-PID sweeps) and adapter cancel(§11:847) would need.
 * Same shape the checkout lock records (src/lock.ts). No producer this slice:
 * `WorkerResult` carries none of it and the harness child pid is unreturned,
 * so attempts record it as absent; fields land with T-010/T-011.
 */
export interface ProcessIdentity {
  pid: number
  startedAt: string
}

/**
 * One execution of one job (spec §6.5:374-393 — "retrying with a fresh
 * session … and complete audit history"). jobId is the candidate id (T-006
 * derives one job per candidate); number is 1-based within the job.
 * startedAt/endedAt are stamped in-run and carried in the report artifact,
 * so the store's ingest stays a pure function of the report (never
 * Date.now()). processIdentity/workerSessionId are absent this slice — no
 * producer; promptVersion is null until prompt versioning exists
 * (§6.7:446/§18:1207).
 */
export interface Attempt {
  /** `<candidateId>-a<n>` — unique within the run. */
  id: string
  jobId: string
  number: number
  state: AttemptState
  startedAt?: string
  endedAt?: string
  processIdentity?: ProcessIdentity
  workerSessionId?: string
  inputContextHash: string
  promptVersion: string | null
  outputArtifacts: string[]
  failure?: FailureRecord
}

export interface PlannerReport {
  model: string
  ok: boolean
  attempts: number
  durationMs: number
  /** Briefs actually used (empty when fallback to the raw goal kicked in). */
  briefs: string[]
  fallbackUsed: boolean
  rawOutputPath: string
}

export interface ReviewObservation {
  finding: string
  severity: 'info' | 'concern' | 'blocker-advisory'
  evidence?: string
}

/**
 * Advisory post-gate review (spec §9.2): findings, never verdicts.
 * Survival stays with the gates; this informs the human.
 */
export interface ReviewReport {
  ok: boolean
  attempts: number
  model: string
  observations: ReviewObservation[]
  rawOutputPath: string
}

export interface CandidateReport {
  id: string
  workerId: string
  model: string
  /** The brief this candidate was given (the raw goal when no planner). */
  brief: string
  /** Null when the workspace was disposed after evidence capture. */
  workspacePath: string | null
  workerOk: boolean
  workerTimedOut: boolean
  workerDurationMs: number
  diffPath: string | null
  diffBytes: number
  gates: GateResult[]
  passedAllGates: boolean
  /**
   * One Attempt record per execution of this candidate (T-007). The
   * top-level fields above keep their meaning as the FINAL attempt's
   * values; gates attach only to the final attempt.
   */
  attempts: Attempt[]
  /** Present only for candidates that passed all gates (when review is enabled). */
  review?: ReviewReport
  error?: string
}

export interface RunReport {
  runId: string
  repo: string
  baseSha: string
  goal: string
  model: string
  planner?: PlannerReport
  startedAt: string
  finishedAt: string
  candidates: CandidateReport[]
}
