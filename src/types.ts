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
  /**
   * Hard wall-clock limit; at expiry the worker process tree is killed with
   * list-form `taskkill /pid X /T /F` and the kill is VERIFIED (T-011, spec
   * §15.3): every descendant captured in the pre-kill snapshot must be gone
   * afterwards — survivors are reported as cleanup failures, never silently
   * ignored and never asserted.
   */
  timeoutMs: number
  /**
   * Engine-supplied (T-010): called by an adapter ONCE, right after spawn,
   * when it knows its root process id. Not the same as `WorkerResult.pid` —
   * the result only exists at completion, while startup reconciliation must
   * find the pid on disk after a crash, while `execute()` never resolves.
   * An adapter that cannot know a root pid never calls this and returns
   * `pid: null`; recovery treats a dispatch without a recorded pid as
   * report-not-kill.
   */
  onSpawn?: (pid: number) => void
}

export interface WorkerResult {
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  logPath: string
  /** Tail of the worker's stdout (ANSI stripped), for response parsing. */
  responseTail: string
  /**
   * The adapter's root process id, for the completion record (T-010); null
   * when the adapter cannot know one. Adapters that call `onSpawn` return
   * the same pid here.
   */
  pid: number | null
  /**
   * Present only when a timeout's verified tree kill could not fully prove
   * the tree dead (survivors, an already-gone root, or verification
   * impossible — T-011, spec §15.3): loud evidence for the human, aggregated
   * onto the candidate report by the runner. Never a verdict — gates decide
   * survival (decisions.md 2026-10-10). Absent on every non-timeout path.
   */
  cleanupFailures?: string[]
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
  /**
   * Present only when this gate timed out and its verified process-tree kill
   * could not fully prove the tree dead (T-011, spec §15.3). Evidence only,
   * never a verdict. Absent on every non-timeout path.
   */
  cleanupFailures?: string[]
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
 * have a producer in a finished-run store; 'abandoned' (spec §15.2:1067 /
 * §29:1874 vocabulary) is written by the startup-reconciliation slice
 * (T-010's `recordAbandonedAttempts`, src/store/index.ts) for attempts whose
 * dispatch was recorded but never completed — the only producer it has.
 */
export type AttemptState = 'running' | 'succeeded' | 'failed' | 'abandoned'

/**
 * Why an attempt failed. Reuses the elimination-ladder vocabulary
 * (`eliminationReason`, src/store/index.ts). Retryable attempts only ever
 * produce 'error' (the attempt threw) or 'worker-failed' (non-zero exit or
 * timeout); 'no-op'/'no-gates'/'gates-failed' are candidate verdicts on the
 * ladder, never attempt failures — a worker that succeeded is never re-rolled
 * around a machine verdict (decisions.md: gates decide survival).
 * 'abandoned' (T-010) documents the vocabulary extension: spec §28:1863 names
 * ATTEMPT_ABANDONED but no reason vocabulary, so the abandonment failure
 * record chooses 'abandoned' per the T-008 APPROVAL_REJECTED
 * choose-and-document precedent.
 */
export type FailureReason = 'error' | 'worker-failed' | 'no-op' | 'no-gates' | 'gates-failed' | 'abandoned'

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
 * Same shape the checkout lock records (src/lock.ts). The in-run producer is
 * the dispatch evidence (T-010): the runner appends a `pid` line to
 * <runDir>/dispatch.jsonl via `WorkerExecutionRequest.onSpawn`, and recovery
 * writes abandonment rows whose `process_identity_json` extends this shape
 * with the dispatch record's lease/branch ({pid, startedAt, leaseId, branch}).
 * Attempt rows derived by `ingest` from a finished report still record it
 * absent (the report carries no pids); `WorkerResult.pid` (T-010) feeds the
 * completion evidence, not the report.
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
 * Date.now()). processIdentity/workerSessionId stay absent from
 * report-carried attempts — the in-run pid evidence lives in
 * <runDir>/dispatch.jsonl (T-010), which ingest never reads; promptVersion
 * is null until prompt versioning exists (§6.7:446/§18:1207).
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
  /**
   * Aggregated worker-side + gate-side cleanup failures (T-011) — the one
   * place report.json answers "did anything survive a timeout". Absent on
   * every non-timeout path; a cleanup failure never changes `workerOk`,
   * `passedAllGates`, or any verdict (decisions.md 2026-10-10: gates decide
   * survival).
   */
  cleanupFailures?: string[]
  /** Present only for candidates that passed all gates (when review is enabled). */
  review?: ReviewReport
  error?: string
}

// ---------- Schedule (T-009, spec §22:1329 — deterministic, persisted transitions) ----------

/**
 * Phase status under the `all` completion policy (§6.3). 'blocked' = the
 * phase's jobs were never dispatched because an upstream phase failed —
 * recorded as not-dispatched, never fabricated as terminal.
 */
export type PhaseStatus = 'completed' | 'failed' | 'blocked'

export interface SchedulePhase {
  id: string
  /** Declared phase-level dependencies, as written in the spec. */
  dependencies: string[]
  /** The one completion policy this slice implements. */
  completion: 'all'
  status: PhaseStatus
}

export interface ScheduleJob {
  id: string
  phaseId: string
  /** The expanded edges the ready function enforced (job deps + phase-dep
   *  expansion) — what a post-hoc determinism check compares. */
  dependencies: string[]
  /** 0-based position in the run's dispatch order; null = never dispatched. */
  dispatchIndex: number | null
}

/** The recorded dispatch order that makes a schedule checkable post-hoc
 *  (§22:1329). Carried only by --jobs runs; default-mode reports leave it
 *  undefined, so existing consumers see no change. */
export interface RunSchedule {
  phases: SchedulePhase[]
  jobs: ScheduleJob[]
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
  /** Present only in --jobs mode (T-009): the recorded schedule. */
  schedule?: RunSchedule
}
