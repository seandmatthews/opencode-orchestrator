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
