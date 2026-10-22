// Core domain types for the stage-0 walking skeleton.
//
// The engine knows nothing about specific models, providers, or harnesses.
// Model IDs and harness specifics appear only as configuration passed to
// worker adapters. OpenCode is one adapter among future ones (Codex, a
// local OpenAI-compatible endpoint, ...), never an engine assumption.

/**
 * Execution capability policy for one dispatch (spec §14, T-023). The spec
 * never defines PermissionPolicy (§6.6:409 names it without a type); this
 * union is the repo's documented narrowing (the T-013 types.ts:110-114
 * choose-and-document precedent) — exactly the three postures with a
 * producer. An adapter that receives a non-`worktree-write` policy it
 * cannot honor must refuse the dispatch at spawn time, never silently
 * downgrade (§14.3:1039 — "The implementation can vary. The contract does
 * not.").
 */
export type ExecutionPolicy =
  /** No repo checkout is this dispatch's cwd (§14.2 "artifact-only"). */
  | 'artifact-only'
  /** Tool-restricted read over the supplied disposable worktree (§14.3 "tool restriction"). */
  | 'worktree-read'
  /** Builder posture: full tools inside the candidate worktree. */
  | 'worktree-write'

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
  /**
   * Execution capability policy for this dispatch (T-023, spec §14). Absent
   * ≡ 'worktree-write' — the builder posture every pre-T-023 dispatch had —
   * so existing adapters compile unchanged. The runner passes it explicitly
   * on every dispatch site (planner 'artifact-only', reviewer 'worktree-read',
   * verifier 'worktree-read' (T-039 — the step-one probe,
   * scripts/diag-execute.mjs, found this posture execute-capable), worker
   * 'worktree-write'); the OpenCode adapter translates the restricted
   * postures to its plan agent (the only OpenCode-aware file). A
   * non-'worktree-write' policy is a mechanism-level restriction
   * (decisions.md 2026-10-10: mechanism over prompts), never a gate result —
   * a restricted role's failure degrades through the existing
   * planner-fallback/reviewer-parse/verifier-parse paths, never into a
   * candidate verdict.
   */
  executionPolicy?: ExecutionPolicy
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
   * The shell command that produced this verdict (T-027), present when the
   * gate was a shell command (`CommandGate`, the only real producer); absent
   * for non-shell gates and pre-existing reports. Same optional-field pattern
   * as `cleanupFailures`: evidence only, never a verdict — nothing in the
   * elimination ladder reads it (the ladder computes from `passed` and
   * `diffBytes` alone), and `integrate`'s compare-when-recorded contract uses
   * it only to refuse a replay that would exercise a different command than
   * the run survived.
   */
  command?: string
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
 * (`eliminationReason`, src/store/index.ts). Retryable attempts produce
 * 'error' (the attempt threw), 'worker-failed' (non-zero exit or timeout),
 * and — under the T-038 `--gate-retry` flag ONLY — 'gates-failed' as a
 * NON-final attempt's failure reason: the pre-retry leg of the one bounded
 * feedback-informed gate retry (decisions.md 2026-10-21). The FINAL attempt
 * keeps today's semantics byte-for-byte: a succeeded worker records
 * 'succeeded' even when gates fail — the gates-failed verdict lives in
 * `passedAllGates` and the elimination vocabulary is unchanged. 'no-op' and
 * 'no-gates' remain candidate verdicts on the ladder, never attempt
 * failures; 'abandoned' (T-010) documents the vocabulary extension: spec
 * §28:1863 names ATTEMPT_ABANDONED but no reason vocabulary, so the
 * abandonment failure record chooses 'abandoned' per the T-008
 * APPROVAL_REJECTED choose-and-document precedent.
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
 * is the sha256 hex of the exact builder prompt text sent to the adapter,
 * derived at composition time (T-029, §6.7:446/§18:1207) — a content hash,
 * never a looked-up registry version (the §27 prompts/prompt_versions
 * tables are deliberately not built).
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
  /**
   * The gate results recorded on THIS attempt (T-038), present ONLY when the
   * attempt ran the machine gates as a NON-final leg — the pre-retry leg of
   * the one bounded gate retry. The final attempt's gates attach to the
   * candidate report (`CandidateReport.gates`) exactly as before; without
   * this field a pre-retry leg's `GateResult[]` would be lost. Evidence
   * only, never a verdict input (decisions.md 2026-10-10: gates decide
   * survival). Absent on every other attempt, so flag-less reports are
   * unchanged (the probes/rounds optional-field pattern).
   */
  gateResults?: GateResult[]
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

/**
 * Active pre-disposition verification (T-039, spec §10.1/§9.2): a fourth
 * model role beside planner/worker/reviewer. Where the reviewer READS the
 * diff post-gate on survivors, the verifier ACTIVELY TESTS — it runs new
 * checks against the candidate's work itself and returns findings citing
 * the commands it ran and the output it saw (spec §3.3: evidence before
 * interpretation). Same field pattern as `ReviewReport` and the same
 * `ReviewObservation` shape, under this DISTINCT report block. Findings,
 * never verdicts: recorded evidence for the human (and, later, the retry
 * seam T-040 and the cross-run ratchet T-041) — a model-authored check
 * never decides survival in the run that produced it (decisions.md
 * 2026-10-21); promotion into a gate set is human-owned and crosses runs.
 */
export interface VerifierReport {
  model: string
  ok: boolean
  attempts: number
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
   * values; gates attach only to the final attempt (a pre-retry leg's gate
   * results attach to their own attempt — `Attempt.gateResults`, T-038).
   */
  attempts: Attempt[]
  /**
   * The one bounded gate-failure retry (T-038, decisions.md 2026-10-21):
   * present only when `--gate-retry` fired for this candidate — absent
   * otherwise, so flag-less reports are unchanged (the probes/rounds
   * optional-block pattern). `brief` above stays the ORIGINAL brief; the
   * composed retry brief is attempt-scoped evidence in the retry attempt's
   * evidence dir (`retry-brief.txt`), never a replacement. Recorded
   * evidence only: never a verdict input (decisions.md 2026-10-10 — gates
   * decide survival).
   */
  gateRetry?: GateRetryRecord
  /**
   * Aggregated worker-side + gate-side cleanup failures (T-011) — the one
   * place report.json answers "did anything survive a timeout". Absent on
   * every non-timeout path; a cleanup failure never changes `workerOk`,
   * `passedAllGates`, or any verdict (decisions.md 2026-10-10: gates decide
   * survival).
   */
  cleanupFailures?: string[]
  /**
   * Evidence summary for the probes that ran on the final attempt (T-015,
   * spec §12) — pointers at the validated EvidenceBundle artifacts the run
   * wrote under <artifactsDir>/probes/<id>/. Present only when the job had
   * probes; absent otherwise, so default-mode reports are unchanged. A probe
   * summary is evidence, never a verdict input: probes advise/record, gates
   * decide survival (decisions.md 2026-10-10).
   */
  probes?: ProbeRunSummary[]
  /** Present only for candidates that passed all gates (when review is enabled). */
  review?: ReviewReport
  /**
   * Active pre-disposition verification on the final completed attempt
   * (T-039, spec §10.1/§9.2) — present only when the run carried
   * `--verifier-model` (the `probes`/`rounds` producer-only pattern; absent
   * otherwise, so flag-less reports are unchanged). Runs regardless of gate
   * outcome (the T-015 posture: evidence about failures is evidence).
   * Findings, never verdicts: nothing in the elimination ladder reads this
   * block, and a blocker-advisory observation eliminates nothing, promotes
   * nothing, reorders nothing (decisions.md 2026-10-21: a model-authored
   * check never decides survival in the run that produced it).
   */
  verifier?: VerifierReport
  error?: string
}

/**
 * One executed probe's summary in the report (T-015, spec §12): who ran,
 * whether it succeeded, how long it took, and where its validated
 * EvidenceBundle artifact lives on disk. The bundle itself carries the full
 * evidence (artifacts, measurements, gateResults) — the summary only points
 * at it. Never a verdict input.
 */
export interface ProbeRunSummary {
  probeId: string
  scenarioId: string
  success: boolean
  durationMs: number
  bundlePath: string
}

/**
 * The one bounded gate-failure retry's record (T-038, decisions.md
 * 2026-10-21), carried on `CandidateReport.gateRetry` ONLY when the flag
 * fired for this candidate. Evidence of the composition — never a verdict
 * input: the final attempt's `passedAllGates` alone decides survival
 * (decisions.md 2026-10-10 — gates decide survival; the same Gate objects
 * re-run unchanged on the retry).
 */
export interface GateRetryRecord {
  /** The 1-based attempt number whose gate failure seeded the feedback. */
  fromAttempt: number
  /** The 1-based attempt number the feedback-informed retry dispatched. */
  toAttempt: number
  /** The failing gates whose recorded output composed the retry brief, in
   *  job gate order. */
  gates: string[]
  /** sha256 of the exact composed retry-brief text — the bytes written to
   *  `<retry attempt evidence dir>/retry-brief.txt` and wrapped, verbatim,
   *  into the retry attempt's builder prompt (whose own exact-text hash is
   *  that attempt's `promptVersion`, T-029). The T-030 `packetFingerprint`
   *  pattern. */
  fingerprint: string
}

// ---------- Schedule (T-009, spec §22:1329 — deterministic, persisted transitions) ----------

/**
 * Phase status under the `all` completion policy (§6.3). 'blocked' = the
 * phase's jobs were never dispatched because an upstream phase failed —
 * recorded as not-dispatched, never fabricated as terminal.
 * 'concluded-early' (T-031, spec §20) = the phase DECLARED an
 * `EarlyStopPolicy`, the policy was MET, and at least one of its jobs was
 * never dispatched because the stop suppressed dispatch — precedence
 * `failed` > `concluded-early` > `completed` > `blocked`; a
 * declared-but-unmet policy changes no status.
 */
export type PhaseStatus = 'completed' | 'failed' | 'blocked' | 'concluded-early'

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

/**
 * One executed round of the bounded R&D loop (T-030), in the additive
 * `RunReport.rounds` block — present only when `--rounds 2` was given;
 * absent otherwise, so default-mode report.json is unchanged (the
 * `CandidateReport.probes` pattern: optional fields present only when they
 * have a producer). Per round the block records the executed flag, the
 * round's gate survivors, and — only on a round that was seeded by the
 * composer (round ≥ 2 that ran) — the composed context packet's §7.7
 * fingerprint and where the rendered block lives under the run artifacts
 * dir. Recorded evidence only: never a verdict input (decisions.md
 * 2026-10-10 — gates decide survival; the composer feeds planning prompts,
 * never the ladder).
 */
export interface RoundRecord {
  /** 1-based round index. */
  round: number
  /** False = the round did not run (round 2 with no round-1 survivor, or a
   *  direct-caller shape the loop does not drive — no planner, or a
   *  scheduled/DAG run). Recorded, never fabricated as executed. */
  executed: boolean
  /** The gate survivors of THIS round (`passedAllGates`, in report order).
   *  Round 2's survivors are its own candidates' verdicts — the loop never
   *  advances past 2 this slice, so they feed nothing yet; recorded because
   *  they are the round's outcome. */
  survivorIds: string[]
  /** Present only on a composed round (round ≥ 2 that executed): the
   *  fingerprint of the context packet composed from the previous round's
   *  survivors — the packet the round's planner prompt was seeded with.
   *  Disjoint from T-007's per-attempt `input_context_hash` (the
   *  relationship is documented in src/rounds.ts's header; both ride the
   *  report side by side, neither ever a verdict input). */
  packetFingerprint?: string
  /** Present only on a composed round: where the rendered context block
   *  lives under the run artifacts dir (decisions.md 2026-10-10: run
   *  evidence lives under the run root). */
  renderedBlockPath?: string
}

/**
 * One phase-level early-stop record (T-031, spec §20:1265-1281 "Early Stop
 * and Bounded Waste"), in the additive `RunReport.earlyStops` block —
 * present only when a `--jobs` phase DECLARED an `EarlyStopPolicy`; default
 * mode AND policy-less `--jobs` reports carry no block (the
 * `CandidateReport.probes` / `RunReport.rounds` pattern: optional fields
 * present only when they have a producer). One record per declaring phase,
 * in spec phase order. `met: true` entries are the stop's evidence — which
 * condition fired, who survived, who was never dispatched — recorded as
 * evidence rather than silently truncating; `met: false` entries record
 * that a declared policy was evaluated and never fired (the
 * `RoundRecord.executed: false` posture — a policy that silently vanished
 * would be indistinguishable from a bug). Recorded evidence only: the stop
 * suppresses dispatch, never a verdict (decisions.md 2026-10-10 — machine
 * gates decide survival; models advise).
 */
export interface EarlyStopRecord {
  /** The declaring phase's id. */
  phaseId: string
  /** The one machine-computed condition this slice implements; the literal
   *  keeps future conditions additive. */
  condition: 'minSurvivors'
  /** The declared threshold (`EarlyStopPolicy.minSurvivors`), verbatim. */
  threshold: number
  /** True = the condition fired (terminal survivors ≥ threshold) and the
   *  phase's ready-but-undispatched jobs were suppressed from dispatch.
   *  False = declared, evaluated, never fired. */
  met: boolean
  /** The phase's terminal-SUCCEEDED jobs, in report order. */
  survivorIds: string[]
  /** The phase's never-dispatched jobs (`dispatchIndex: null`), in spec
   *  order — suppressed by the stop when met, starved by an upstream
   *  failure when not. Agrees exactly with the schedule block. */
  neverDispatchedIds: string[]
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
  /** Present only when `--rounds 2` (T-030): the bounded R&D loop's
   *  per-round record. Absent otherwise — default-mode report.json is
   *  unchanged byte-for-byte in shape. */
  rounds?: RoundRecord[]
  /** Present only when a `--jobs` phase declared an `EarlyStopPolicy`
   *  (T-031): one record per declaring phase, in spec phase order. Absent
   *  otherwise — default-mode AND policy-less `--jobs` reports are
   *  unchanged. The store never reads it (verdicts only; the rounds
   *  store-invisible precedent). */
  earlyStops?: EarlyStopRecord[]
}
