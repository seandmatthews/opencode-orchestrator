// Durable run records (T-003 store, T-006 job DAG, T-007 attempts, T-008
// approval gates) — slices of the stage-1 state store (spec §27 Persistence
// Model, §28 Event Log, §34 Milestone 1).
//
// Zero npm dependencies: Node's built-in `node:sqlite` (DatabaseSync).
// node:sqlite is experimental on Node 22 — see VERIFICATION.md Known issues.
//
// The store is harness-agnostic (decisions.md): model IDs arrive only as
// strings copied out of `RunReport` fields. `ingest` is a pure function of
// the report — event timestamps derive from the report's own stamps and
// durations, never from the wall clock — so re-ingest is deterministic.
// Persistence records verdicts; it never influences them.
//
// Scoping of that line (T-028): T-028 makes the store's first READ that
// gates an action — `npm run integrate` verifies the candidate's diff
// against the hash recorded at ingest and refuses to replay a diff that
// mutated since ingest. The refusal is post-hoc and human-facing (a replay
// the operator asked for), while the run pipeline itself still never reads
// the DB back; and the refusal is machine evidence only — a sha256
// equality check, zero model involvement (decisions.md 2026-10-10).
// Nothing that decides a run's survival reads the store.
//
// Wall-clock scoping of the determinism rule (T-008): approval requests and
// decisions are primary human facts no report carries, so their rows
// (`requested_at`/`decided_at`) and events (`APPROVAL_REQUESTED` /
// `APPROVAL_GRANTED` / `APPROVAL_REJECTED`) are legitimately wall-clock
// stamped — written only by `requestApproval`/`decideApproval`, the only
// approval writers, always operator-driven through src/approvals.ts. The
// determinism rule continues to govern everything derived from the report:
// `ingest` is untouched and stays a pure function of the report.
//
// Wall-clock scoping, second case (T-010): abandonment marks are primary
// recovery facts no report carries — the report was never written, the run
// died — so the `attempts` rows and `ATTEMPT_ABANDONED` events written by
// `recordAbandonedAttempts` (the second DB writer, driven by the standalone
// `npm run recover`) are legitimately wall-clock stamped: `started_at` comes
// from the crashed run's dispatch evidence, while the abandonment stamp
// itself (`ended_at` and the event's `at`) is the moment of recovery. No
// report exists to derive from, so the deviation is documented, not
// smoothed: `ingest` is untouched and stays a pure function of the report.
//
// Wall-clock scoping, fourth case (T-028): an integration replay's verdict
// is a primary fact the replay produced that no report carries — the run
// finished long before, and §28 names no integration event — so the
// `INTEGRATE_REPLAYED` event and the verdict's `artifacts` row written by
// `recordIntegrateVerdict` (the third DB writer, driven by the standalone
// `npm run integrate`) are legitimately wall-clock stamped: the event's
// `at` is the verdict's own `appliedAt` (the wall-clock stamp the replay
// wrote into its verdict artifact), and the verdict file's
// `size_bytes`/`content_hash` are hash-at-ingest of the replay's own
// evidence, same as the run's. `ingest` is untouched and stays a pure
// function of the report.
//
// Hash-at-ingest scoping, third case (T-016): ingest is deterministic as a
// function of *(report, the evidence files it names)*. Every report-named
// artifact path (report.json, the planner raw output; per candidate: the
// diff, every attempt's outputArtifacts, the review raw output, probe
// bundles) is stat-ed and sha256-hashed at ingest — a READ of evidence,
// never a write; a missing or unreadable file records NULL in both
// `size_bytes` and `content_hash`, never a fabricated value (AGENTS.md #7,
// the diffBytes-null precedent). The wall clock still never enters any
// stamp: re-ingest over unchanged files reproduces byte-identical rows.
// The alternative — hashes captured into the report at capture time — is a
// report-shape change that owns its own Gate 2 run; deliberately not this
// slice. Recorded hashes and artifact rows are evidence only: they never
// enter promotion or elimination (decisions.md 2026-10-10: gates decide
// survival).

import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Attempt, CandidateReport, RunReport, RunSchedule } from '../types.js'

export const SCHEMA_VERSION = 5

// Schema v5 (T-016): the v4 tables plus spec §27's `artifacts` and
// `probe_runs`, narrowed to the columns with a producer. §6.8's
// `producerAttemptId` narrows to the `(job_id, attempt_number)` pair (the
// T-007 attempts PK; probes attach to the final attempt, src/types.ts) —
// nullable: run-level artifacts (report.json, the planner raw output) have
// no producer attempt, and pre-T-007 reports carry no attempts array. The
// §6.8 columns without a producer are OMITTED, not pre-defined (the
// documented-narrowing precedent, T-006's policy columns): `media_type`,
// `lineage`, `metadata`, `retention_class` — stated honestly, not smoothed
// over. Everything is CREATE TABLE IF NOT EXISTS, so an existing
// v1/v2/v3/v4 refinery.db gains the new tables on its next use — no
// migration machinery, no backfill. Schema v2 (T-006) added
// `phases`/`jobs`/`job_dependencies`, schema v3 (T-007) `attempts`,
// schema v4 (T-008) `approval_gates`. The §6.3/§6.4 policy columns are
// nullable and stay null this slice: RunReport/CandidateReport carry none
// of those fields, so there is no producer — stated honestly, not smoothed
// over.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  repo         TEXT NOT NULL,
  base_sha     TEXT NOT NULL,
  goal         TEXT NOT NULL,
  model        TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  planner_json TEXT,
  report_path  TEXT
);
CREATE TABLE IF NOT EXISTS candidates (
  run_id             TEXT NOT NULL REFERENCES runs(run_id),
  candidate_id       TEXT NOT NULL,
  worker_id          TEXT NOT NULL,
  model              TEXT NOT NULL,
  brief              TEXT NOT NULL,
  worker_ok          INTEGER NOT NULL,
  worker_timed_out   INTEGER NOT NULL,
  worker_duration_ms INTEGER NOT NULL,
  diff_bytes         INTEGER NOT NULL,
  passed_all_gates   INTEGER NOT NULL,
  review_json        TEXT,
  error              TEXT,
  PRIMARY KEY (run_id, candidate_id)
);
CREATE TABLE IF NOT EXISTS gate_results (
  run_id       TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  gate_name    TEXT NOT NULL,
  passed       INTEGER NOT NULL,
  exit_code    INTEGER,
  duration_ms  INTEGER NOT NULL,
  output_tail  TEXT NOT NULL,
  PRIMARY KEY (run_id, candidate_id, gate_name)
);
CREATE TABLE IF NOT EXISTS events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL,
  type    TEXT NOT NULL,
  at      TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS phases (
  run_id             TEXT NOT NULL REFERENCES runs(run_id),
  phase_id           TEXT NOT NULL,
  dependencies_json  TEXT,
  completion         TEXT,
  early_stop_json    TEXT,
  approval_gate_json TEXT,
  PRIMARY KEY (run_id, phase_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  run_id                TEXT NOT NULL REFERENCES runs(run_id),
  job_id                TEXT NOT NULL,
  phase_id              TEXT NOT NULL,
  worker_id             TEXT NOT NULL,
  model                 TEXT NOT NULL,
  brief                 TEXT NOT NULL,
  dependencies_json     TEXT,
  role_json             TEXT,
  workspace_json        TEXT,
  permissions_json      TEXT,
  prompt_json           TEXT,
  context_plan_json     TEXT,
  input_artifacts_json  TEXT,
  expected_outputs_json TEXT,
  retry_policy_json     TEXT,
  timeout_policy_json   TEXT,
  gate_policy_json      TEXT,
  PRIMARY KEY (run_id, job_id)
);
CREATE TABLE IF NOT EXISTS job_dependencies (
  run_id            TEXT NOT NULL REFERENCES runs(run_id),
  job_id            TEXT NOT NULL,
  depends_on_job_id TEXT NOT NULL,
  PRIMARY KEY (run_id, job_id, depends_on_job_id)
);
CREATE TABLE IF NOT EXISTS attempts (
  run_id                TEXT NOT NULL REFERENCES runs(run_id),
  job_id                TEXT NOT NULL,
  attempt_number        INTEGER NOT NULL,
  state                 TEXT NOT NULL,
  started_at            TEXT,
  ended_at              TEXT,
  input_context_hash    TEXT NOT NULL,
  prompt_version        TEXT,
  process_identity_json TEXT,
  worker_session_id     TEXT,
  output_artifacts_json TEXT,
  failure_json          TEXT,
  PRIMARY KEY (run_id, job_id, attempt_number)
);
CREATE TABLE IF NOT EXISTS approval_gates (
  run_id       TEXT NOT NULL REFERENCES runs(run_id),
  phase_id     TEXT NOT NULL,
  job_id       TEXT NOT NULL,
  state        TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  decided_at   TEXT,
  decided_by   TEXT,
  note         TEXT,
  PRIMARY KEY (run_id, phase_id, job_id)
);
CREATE TABLE IF NOT EXISTS artifacts (
  run_id         TEXT NOT NULL REFERENCES runs(run_id),
  artifact_id    TEXT NOT NULL,
  kind           TEXT NOT NULL,
  job_id         TEXT,
  attempt_number INTEGER,
  path           TEXT NOT NULL,
  size_bytes     INTEGER,
  content_hash   TEXT,
  PRIMARY KEY (run_id, artifact_id)
);
CREATE TABLE IF NOT EXISTS probe_runs (
  run_id      TEXT NOT NULL REFERENCES runs(run_id),
  job_id      TEXT NOT NULL,
  probe_id    TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  success     INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  bundle_path TEXT NOT NULL,
  PRIMARY KEY (run_id, job_id, probe_id)
);
`

// Event vocabulary — spec §28. This slice emits ATTEMPT_STARTED (T-007,
// derived per recorded attempt) on top of T-003's three; live in-run
// emission is carved off (would touch the runner). ATTEMPT_ABANDONED
// (§28:1863) is written by T-010's `recordAbandonedAttempts` — the only
// producer, for attempts whose dispatch was recorded but never completed —
// wall-clock stamped per the header's second scoping case.
// T-008 adds the approval events: APPROVAL_REQUESTED / APPROVAL_GRANTED
// (§28:1861-1862) and APPROVAL_REJECTED — §28 names no rejection event, so
// this vocabulary extension is chosen and recorded here (T-008's ticket
// documents it). APPROVAL_CANCELLED is not defined: no producer until an
// abort/cancel slice. T-009 adds the schedule events, all ingest-derived
// post-hoc from the recorded schedule block (never live in-run):
// JOB_READY (§28:1852) per dispatched job, plus three documented vocabulary
// extensions chosen per the T-008 precedent — §28 names no job-terminal or
// phase events, so JOB_SUCCEEDED / JOB_FAILED / PHASE_COMPLETED are defined
// here and pinned by the extended Gate 1.6. Never-dispatched jobs get no
// events: they are recorded as not-dispatched, never fabricated as
// terminal. node:sqlite binds null/number/bigint/string/Buffer only, hence
// 1|0 booleans. T-016 adds ARTIFACT_CREATED (§28:1854), ingest-derived
// post-hoc: exactly one per `artifacts` row, appended after every existing
// derived block, every `at` a pure function of the report's stamps (never
// `Date.now()`), so re-ingest appends a fresh deterministic block.
// T-028 adds INTEGRATE_REPLAYED — §28:1844-1864 names no integration event,
// so this vocabulary extension is chosen and recorded here per the T-008/
// T-009 precedent: one event per recorded integration replay, written by
// `recordIntegrateVerdict` (the only producer), `at` stamped from the
// verdict's own `appliedAt` (the header's fourth wall-clock scoping case),
// payload naming candidateId/targetHead/applied/treeChanged/passed/
// worktreePath/verdictPath. A replay never writes `gate_results` — the
// table's PK would overwrite the run's own recorded verdicts.

// ---------- T-016: the filesystem artifact store ----------

/**
 * Kind of one recorded artifact (§6.8's `ArtifactType` narrowed to this
 * slice's producers). The report names evidence only as path strings — no
 * producer carries a kind — so the kind derives from the named path:
 * `.patch` → 'diff' (the worktree diff capture), `.json` → 'report'
 * (report.json, probe evidence bundles), anything else → 'log'
 * (worker.log, the planner/review raw model output). One deterministic
 * rule covers exactly what the runner writes (src/runner.ts) and stays
 * stable no matter which report field derived the row first: a path named
 * twice under the same producer triple (diffPath also inside a final
 * attempt's outputArtifacts) yields ONE deduplicated row with one kind.
 */
export type ArtifactKind = 'diff' | 'log' | 'report'

export function artifactKindOf(path: string): ArtifactKind {
  if (path.endsWith('.patch')) return 'diff'
  if (path.endsWith('.json')) return 'report'
  return 'log'
}

/**
 * Deterministic artifact id over the producer triple (candidateId, attempt
 * number, path) — stable across re-ingest. Shape:
 * `<scope>/<basename>-<sha256(triple).slice(0,16)>`, where scope is `run`
 * for run-level artifacts (report.json, the planner raw output), `j:<id>`
 * for candidate-scoped ones with no recorded attempt, and `j:<id>@a<n>`
 * for attempt-scoped ones. Job ids are charset-restricted to
 * `[a-z0-9][a-z0-9-]*` (src/scheduler.ts), so the `:`/`@` punctuation
 * keeps the three scopes collision-free; the 16-hex digest over the FULL
 * triple keeps same-named basenames and one path under different producers
 * apart. Pinned by exact literal in Gate 1.6.
 */
export function artifactId(candidateId: string | null, attemptNumber: number | null, path: string): string {
  const scope = candidateId === null
    ? 'run'
    : attemptNumber === null
      ? `j:${candidateId}`
      : `j:${candidateId}@a${attemptNumber}`
  const digest = createHash('sha256')
    .update(`${candidateId ?? ''}\u0000${attemptNumber ?? ''}\u0000${path}`)
    .digest('hex')
    .slice(0, 16)
  return `${scope}/${basename(path)}-${digest}`
}

/** 1 MiB read chunks — evidence files (worker logs, diffs, bundles) hash
 *  without being loaded whole into memory. */
const HASH_CHUNK_BYTES = 1024 * 1024

/**
 * stat + sha256 one evidence file, reading ONLY (never writing — evidence
 * is read-only over, the T-002 rule). A missing, unreadable, or
 * non-regular file records NULL in both fields — never a fabricated value
 * (AGENTS.md #7, the diffBytes-null precedent). `sizeBytes` is the byte
 * count actually hashed, so size and hash always describe the same read.
 */
function measureEvidenceFile(path: string): { sizeBytes: number | null; contentHash: string | null } {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return { sizeBytes: null, contentHash: null }
  }
  try {
    if (!fstatSync(fd).isFile()) return { sizeBytes: null, contentHash: null }
    const hash = createHash('sha256')
    const chunk = Buffer.alloc(HASH_CHUNK_BYTES)
    let total = 0
    for (;;) {
      const n = readSync(fd, chunk, 0, HASH_CHUNK_BYTES, null)
      if (n === 0) break
      hash.update(chunk.subarray(0, n))
      total += n
    }
    return { sizeBytes: total, contentHash: hash.digest('hex') }
  } catch {
    return { sizeBytes: null, contentHash: null }
  } finally {
    closeSync(fd)
  }
}

/** One row of the artifacts derivation, before its evidence file is
 *  measured. Internal — the shape the upsert writes. */
interface DerivedArtifact {
  artifactId: string
  kind: ArtifactKind
  jobId: string | null
  attemptNumber: number | null
  path: string
}

/** The final attempt's number for a candidate report — the attempt the
 *  candidate's top-level fields (diffPath, review) and its probes belong to
 *  (src/types.ts: top-level fields keep the FINAL attempt's values; probes
 *  run on the final completed attempt). Null for pre-T-007 reports that
 *  carry no attempts array. */
function finalAttemptNumber(c: CandidateReport): number | null {
  const arr = c.attempts ?? []
  return arr.length > 0 ? arr[arr.length - 1]!.number : null
}

/**
 * The artifacts derivation (T-016): one row per evidence path the finished
 * RunReport itself names — never path guessing. In derivation order:
 * report.json (recovered via the reportPathOf heuristic), the planner raw
 * output, then per candidate in report order: the diff, every recorded
 * attempt's outputArtifacts (attempt order, then array order), the review
 * raw output, the probe bundles (summary order). A path named twice under
 * the same producer triple yields ONE deduplicated row (first occurrence
 * wins — the only overlap the runner writes is diffPath also inside the
 * final attempt's outputArtifacts, same triple, same id). Files the report
 * does not name (dispatch.jsonl, planner.log, review.json, probe .log
 * artifacts living inside bundles) get no row.
 */
function deriveArtifacts(report: RunReport): DerivedArtifact[] {
  const out: DerivedArtifact[] = []
  const seen = new Set<string>()
  const push = (candidateId: string | null, attemptNumber: number | null, path: string): void => {
    const id = artifactId(candidateId, attemptNumber, path)
    if (seen.has(id)) return
    seen.add(id)
    out.push({ artifactId: id, kind: artifactKindOf(path), jobId: candidateId, attemptNumber, path })
  }
  const reportPath = reportPathOf(report)
  if (reportPath) push(null, null, reportPath)
  if (report.planner?.rawOutputPath) push(null, null, report.planner.rawOutputPath)
  for (const c of report.candidates) {
    const fin = finalAttemptNumber(c)
    if (c.diffPath) push(c.id, fin, c.diffPath)
    for (const a of c.attempts ?? []) {
      for (const p of a.outputArtifacts ?? []) push(c.id, a.number, p)
    }
    if (c.review?.rawOutputPath) push(c.id, fin, c.review.rawOutputPath)
    for (const pr of c.probes ?? []) push(c.id, fin, pr.bundlePath)
  }
  return out
}

/**
 * The artifact handle of one candidate's captured diff — exactly the id the
 * ingest derivation pushes for it (`deriveArtifacts`:
 * `push(c.id, fin, c.diffPath)`), computed by the same `artifactId` over the
 * same producer triple `(candidateId, finalAttemptNumber, diffPath)`. Null
 * when the candidate carries no diffPath — nothing to verify. Computable
 * from report.json alone, and living beside the derivation it mirrors so
 * the handle can never drift from the ingested row's id. First consumer:
 * integrate's verify-when-recorded check (T-028). Pinned by exact literal
 * in Gate 1.6 for both scopes (pre-T-007 `j:<id>`, T-007 `j:<id>@a<n>`).
 */
export function diffArtifactId(c: CandidateReport): string | null {
  if (!c.diffPath) return null
  return artifactId(c.id, finalAttemptNumber(c), c.diffPath)
}

/**
 * Re-verification primitive (spec §29:1877's "validate artifact files/
 * hashes" face): re-hashes one run's recorded artifacts against the files
 * on disk. Per row: 'verified' (the file's hash matches the recorded one),
 * 'mutated' (the file exists but its hash differs), 'missing' (the named
 * file is gone), 'unverified' (the row was recorded null — nothing to
 * check, never readable as 'mutated'). Read-only over both sides: the DB
 * opens readOnly and evidence files are only read. A later recovery slice
 * integrates this into `npm run recover`; deliberately no CLI this slice
 * (T-016). Rows come back ordered by artifact_id, so the result is
 * deterministic.
 */
export type ArtifactVerificationStatus = 'verified' | 'mutated' | 'missing' | 'unverified'

export interface ArtifactVerification {
  artifactId: string
  path: string
  status: ArtifactVerificationStatus
}

export function verifyRunArtifacts(runId: string, dbPath: string): ArtifactVerification[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare(
      'SELECT artifact_id, path, content_hash FROM artifacts WHERE run_id = ? ORDER BY artifact_id',
    ).all(runId) as { artifact_id: string; path: string; content_hash: string | null }[]
    return rows.map((r) => {
      let status: ArtifactVerificationStatus
      if (r.content_hash === null) {
        status = 'unverified'
      } else {
        const measured = measureEvidenceFile(r.path)
        status = measured.contentHash === null
          ? 'missing'
          : measured.contentHash === r.content_hash ? 'verified' : 'mutated'
      }
      return { artifactId: r.artifact_id, path: r.path, status }
    })
  } finally {
    db.close()
  }
}

// ---------- T-028: integration replay verdicts ----------

/**
 * One integration replay verdict, as recorded by `recordIntegrateVerdict`.
 * Mirrors the durable fields of the on-disk verdict artifact
 * (`<runDir>/integrate/<id>.json`, src/integrate.ts) — the store writer
 * hashes whatever that file contains and never interprets the rest.
 */
export interface IntegrateReplayRecord {
  candidateId: string
  /** The verdict's own `appliedAt` — the event's `at` stamp. */
  appliedAt: string
  targetHead: string
  applied: boolean
  treeChanged: boolean
  passed: boolean
  worktreePath: string
  verdictPath: string
}

/**
 * Record one integration replay verdict (T-028) — the third DB writer after
 * `ingest` and `recordAbandonedAttempts`, called by `npm run integrate` on
 * every replay that writes its verdict artifact (both the normal and the
 * NO-OP-refusal path). Upserts ONE `artifacts` row for the verdict file
 * under the producer triple `(candidateId, NULL, verdictPath)` — attempt
 * NULL, because the replay is not an attempt of the run's job — with kind
 * `'report'` by the path rule and `size_bytes`/`content_hash` measured by
 * the same `measureEvidenceFile` read the run's own evidence gets, here
 * after the file is written: hash-at-ingest of the replay's own evidence.
 * Appends exactly one `INTEGRATE_REPLAYED` event whose `at` is the verdict's
 * own `appliedAt` — the header's fourth wall-clock scoping case (a primary
 * fact the replay produced that no report carries). Idempotent on the row
 * (upsert by natural key; a re-record of the same verdict rewrites one row),
 * append-only on events. NEVER writes `gate_results`: the table's PK
 * `(run_id, candidate_id, gate_name)` with its upsert would OVERWRITE the
 * run's own recorded verdicts — evidence mutated by a replay; the replay's
 * per-gate outcomes ride inside the hashed verdict file and the event
 * payload only.
 *
 * The connection opens with foreign-key constraints disabled
 * (`recordAbandonedAttempts` precedent): the replayed run may never have
 * been ingested, so no `runs` row need exist, and this writer must not
 * fabricate one. Throws on failure — the caller (src/integrate.ts) logs
 * loudly and continues; the replay's exit code stays gate-determined.
 */
export function recordIntegrateVerdict(dbPath: string, runId: string, verdict: IntegrateReplayRecord): void {
  // Hash-at-ingest of the replay's own evidence: the verdict file exists by
  // the time this is called (writeVerdict fires first); a now-missing file
  // records NULL for both, never a fabricated value (AGENTS.md #7).
  const measured = measureEvidenceFile(verdict.verdictPath)
  const row: DerivedArtifact & { sizeBytes: number | null; contentHash: string | null } = {
    artifactId: artifactId(verdict.candidateId, null, verdict.verdictPath),
    kind: artifactKindOf(verdict.verdictPath),
    jobId: verdict.candidateId,
    attemptNumber: null,
    path: verdict.verdictPath,
    ...measured,
  }
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false })
  try {
    db.exec(SCHEMA_SQL)
    db.exec('BEGIN')
    try {
      upsertArtifact(db, runId, row)
      insertEvent(db, runId, 'INTEGRATE_REPLAYED', verdict.appliedAt, {
        candidateId: verdict.candidateId,
        targetHead: verdict.targetHead,
        applied: verdict.applied,
        treeChanged: verdict.treeChanged,
        passed: verdict.passed,
        worktreePath: verdict.worktreePath,
        verdictPath: verdict.verdictPath,
      })
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* nothing to undo */ }
      throw e
    }
  } finally {
    db.close()
  }
}

// ---------- T-008: approval gates ----------

/**
 * Lifecycle of one approval (spec §21:1289-1294 names four states; only the
 * three with a producer are defined here — a human request/decision through
 * src/approvals.ts). `'cancelled'` has no producer until an abort/cancel
 * slice exists and is deliberately not pre-defined (the T-007 'abandoned'
 * precedent).
 */
export type ApprovalState = 'waiting_for_approval' | 'approved' | 'rejected'

/** The decisions an operator can record. §24's other outcomes (`return to
 *  generation`, `pin candidate for later`) have no downstream model — carved
 *  off (T-008's Does-NOT-claim). */
export type ApprovalDecision = 'approved' | 'rejected'

export interface ApprovalRequestOptions {
  runId: string
  /** Narrow to one job; omit to request every survivor of the run. */
  jobId?: string
  /** Who asks; defaults to the OS username. */
  by?: string
  note?: string
}

export interface ApprovalDecisionOptions {
  runId: string
  jobId: string
  decision: ApprovalDecision
  /** Who decides; defaults to the OS username. */
  by?: string
  /** The decider's note; replaces the row's note only when provided. */
  note?: string
}

export interface ApprovalRow {
  runId: string
  phaseId: string
  jobId: string
  state: ApprovalState
  requestedAt: string
  requestedBy: string
  decidedAt: string | null
  decidedBy: string | null
  note: string | null
}

/**
 * Record `waiting_for_approval` for a finished run's survivors — the jobs
 * whose candidate passed all gates (`candidates.passed_all_gates`), keyed on
 * T-006's derived phase/job rows. One `approval_gates` row plus exactly one
 * `APPROVAL_REQUESTED` event per requested job, in one transaction. Jobs that
 * already carry an approval row (any state) are skipped, never rewritten —
 * writes are additive-only. An eliminated candidate is refused: gates decide
 * survival (decisions.md 2026-10-10), and a human approval must not resurrect
 * one. Throws on every refusal before any write. The stamps are wall-clock —
 * see the header comment's scoping of the determinism rule.
 */
export function requestApproval(dbPath: string, opts: ApprovalRequestOptions): ApprovalRow[] {
  if (!opts.runId) throw new Error('--run <runId> is required')
  const db = openApprovalWriter(dbPath)
  try {
    const run = db.prepare('SELECT run_id FROM runs WHERE run_id = ?').get(opts.runId)
    if (!run) throw new Error(`no recorded run '${opts.runId}' in ${dbPath}`)
    const survivors = new Set(
      db.prepare('SELECT candidate_id FROM candidates WHERE run_id = ? AND passed_all_gates = 1')
        .all(opts.runId).map((r) => r.candidate_id as string),
    )
    const jobs = db.prepare('SELECT job_id, phase_id FROM jobs WHERE run_id = ? ORDER BY job_id')
      .all(opts.runId) as { job_id: string; phase_id: string }[]
    // Without --job: every survivor of the run. With --job: exactly that
    // job — refused when unknown or eliminated; a human approval must not
    // resurrect a candidate the gates decided out (decisions.md).
    if (opts.jobId !== undefined) {
      if (!candidateExists(db, opts.runId, opts.jobId)) {
        throw new Error(`no candidate '${opts.jobId}' in run '${opts.runId}'`)
      }
      if (!survivors.has(opts.jobId)) throw new Error(survivorRefusal(opts.jobId))
      if (!jobs.some((j) => j.job_id === opts.jobId)) {
        throw new Error(`no derived job row for '${opts.jobId}' — ingest the run with a T-006-era store first`)
      }
    }
    const targets = opts.jobId === undefined
      ? jobs.filter((j) => survivors.has(j.job_id))
      : jobs.filter((j) => j.job_id === opts.jobId)

    const existing = new Set(
      db.prepare('SELECT job_id FROM approval_gates WHERE run_id = ?').all(opts.runId).map((r) => r.job_id as string),
    )
    // One wall-clock stamp per request invocation — the documented deviation
    // for primary human facts (header comment), never report-derived.
    const at = new Date().toISOString()
    const by = opts.by ?? osUsername()
    const rows: ApprovalRow[] = []
    db.exec('BEGIN')
    try {
      const insert = db.prepare(
        `INSERT INTO approval_gates (run_id, phase_id, job_id, state, requested_at, requested_by, decided_at, decided_by, note)
         VALUES (?, ?, ?, 'waiting_for_approval', ?, ?, NULL, NULL, ?)`,
      )
      for (const j of targets) {
        if (existing.has(j.job_id)) continue // additive-only: an existing record is never rewritten
        insert.run(opts.runId, j.phase_id, j.job_id, at, by, opts.note ?? null)
        insertEvent(db, opts.runId, 'APPROVAL_REQUESTED', at, {
          phaseId: j.phase_id,
          jobId: j.job_id,
          requestedBy: by,
        })
        rows.push({
          runId: opts.runId, phaseId: j.phase_id, jobId: j.job_id, state: 'waiting_for_approval',
          requestedAt: at, requestedBy: by, decidedAt: null, decidedBy: null, note: opts.note ?? null,
        })
      }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* nothing to undo */ }
      throw e
    }
    return rows
  } finally {
    db.close()
  }
}

/**
 * Record an operator's approve/reject on one pending approval: upserts the
 * row's state/`decided_at`/`decided_by` (and `note` when provided) and
 * appends exactly one `APPROVAL_GRANTED`/`APPROVAL_REJECTED` event, inside
 * one transaction. Nothing else is touched — runs, candidates, gate_results,
 * artifacts, and prior event rows stay byte-for-byte as they were
 * (rejection appends, it never rewrites). Throws on every refusal before any
 * write; a double-decide refusal names the row's current state — the audit
 * record is not rewritable. The stamps are wall-clock — see the header
 * comment's scoping of the determinism rule.
 *
 * T-051: the double-decide race is closed BY CONSTRUCTION. The state read
 * lives INSIDE the transaction and the UPDATE is conditional on
 * `state = 'waiting_for_approval'`, refused with the same message when
 * `changes === 0` — so a second concurrent decide (a second browser tab, a
 * CSRF racing a human, another process) can never flip a decided row or
 * append a second, contradictory event: it either reads the committed state
 * and refuses, or loses SQLite's write lock and throws. node:sqlite is
 * synchronous, so within one process the interleaving cannot happen at all;
 * the conditional UPDATE is the cross-process guard (and belt-and-braces
 * against the read changing between read and write, which the transaction's
 * own locks make unreachable).
 */
export function decideApproval(dbPath: string, opts: ApprovalDecisionOptions): ApprovalRow {
  if (opts.decision !== 'approved' && opts.decision !== 'rejected') {
    throw new Error(`unknown --decision '${String(opts.decision)}' (expected approved|rejected)`)
  }
  const db = openApprovalWriter(dbPath)
  try {
    const run = db.prepare('SELECT run_id FROM runs WHERE run_id = ?').get(opts.runId)
    if (!run) throw new Error(`no recorded run '${opts.runId}' in ${dbPath}`)
    const job = db.prepare('SELECT job_id, phase_id FROM jobs WHERE run_id = ? AND job_id = ?')
      .get(opts.runId, opts.jobId) as { job_id: string; phase_id: string } | undefined
    if (!job) {
      if (!candidateExists(db, opts.runId, opts.jobId)) {
        throw new Error(`no candidate '${opts.jobId}' in run '${opts.runId}'`)
      }
      throw new Error(`no derived job row for '${opts.jobId}' — ingest the run with a T-006-era store first`)
    }
    if (!candidateIsSurvivor(db, opts.runId, opts.jobId)) throw new Error(survivorRefusal(opts.jobId))
    const at = new Date().toISOString()
    const by = opts.by ?? osUsername()
    db.exec('BEGIN')
    try {
      // T-051: the state read rides INSIDE the transaction — a concurrent
      // decider's committed flip is what this read sees, never a stale
      // pre-decide snapshot.
      const row = db.prepare('SELECT * FROM approval_gates WHERE run_id = ? AND phase_id = ? AND job_id = ?')
        .get(opts.runId, job.phase_id, opts.jobId) as Record<string, unknown> | undefined
      if (!row) throw new Error(`no approval request recorded for job '${opts.jobId}' — request one first`)
      if (row.state !== 'waiting_for_approval') {
        throw new Error(`approval for job '${opts.jobId}' is already '${String(row.state)}' — the audit record is not rewritable`)
      }
      const flipped = db.prepare(
        `UPDATE approval_gates SET state = ?, decided_at = ?, decided_by = ?,
           note = COALESCE(?, note)
         WHERE run_id = ? AND phase_id = ? AND job_id = ? AND state = 'waiting_for_approval'`,
      ).run(opts.decision, at, by, opts.note ?? null, opts.runId, job.phase_id, opts.jobId)
      // The guard: zero matched rows means someone else flipped it between
      // this transaction's read and write — unreachable under the
      // transaction's own locks, refused with the same message regardless.
      if (Number(flipped.changes) === 0) {
        throw new Error(`approval for job '${opts.jobId}' is already '${String(row.state)}' — the audit record is not rewritable`)
      }
      insertEvent(db, opts.runId, opts.decision === 'approved' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED', at, {
        phaseId: job.phase_id,
        jobId: opts.jobId,
        decidedBy: by,
      })
      db.exec('COMMIT')
      return {
        runId: opts.runId, phaseId: job.phase_id, jobId: opts.jobId, state: opts.decision,
        requestedAt: row.requested_at as string, requestedBy: row.requested_by as string,
        decidedAt: at, decidedBy: by, note: opts.note ?? (row.note as string | null),
      }
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* nothing to undo */ }
      throw e
    }
  } finally {
    db.close()
  }
}

/**
 * The pending-approval queue (spec §26.6's Milestone-7 UI, token-free CLI
 * precursor): rows in `waiting_for_approval`, optionally narrowed to one run.
 * Read-only — the DB opens readOnly and nothing here ever writes.
 */
export function listPendingApprovals(dbPath: string, runId?: string): ApprovalRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const sql = `SELECT * FROM approval_gates WHERE state = 'waiting_for_approval'${runId ? ' AND run_id = ?' : ''} ORDER BY run_id, phase_id, job_id`
    const stmt = db.prepare(sql)
    const rows = (runId ? stmt.all(runId) : stmt.all()) as Record<string, unknown>[]
    return rows.map(rowApproval)
  } finally {
    db.close()
  }
}

function rowApproval(r: Record<string, unknown>): ApprovalRow {
  return {
    runId: r.run_id as string,
    phaseId: r.phase_id as string,
    jobId: r.job_id as string,
    state: r.state as ApprovalState,
    requestedAt: r.requested_at as string,
    requestedBy: r.requested_by as string,
    decidedAt: (r.decided_at as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  }
}

/** Every approval writer opens through here: the schema runs first (CREATE
 *  TABLE IF NOT EXISTS, so an older DB gains the table on next use — no
 *  migration machinery) but never a missing DB file — the caller refuses
 *  those before any open, so no subcommand creates a refinery.db as a side
 *  effect (the T-006 refusal pattern). */
function openApprovalWriter(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA_SQL)
  return db
}

/** Gates decide survival (decisions.md 2026-10-10): an approval for an
 *  eliminated candidate is refused — a human approval must not resurrect one. */
function survivorRefusal(jobId: string): string {
  return `job '${jobId}' is not a survivor — gates decided it out, and an approval must not resurrect an eliminated candidate`
}

function candidateExists(db: DatabaseSync, runId: string, candidateId: string): boolean {
  return db.prepare('SELECT 1 AS one FROM candidates WHERE run_id = ? AND candidate_id = ?')
    .get(runId, candidateId) !== undefined
}

function candidateIsSurvivor(db: DatabaseSync, runId: string, candidateId: string): boolean {
  return db.prepare('SELECT 1 AS one FROM candidates WHERE run_id = ? AND candidate_id = ? AND passed_all_gates = 1')
    .get(runId, candidateId) !== undefined
}

/** The OS username is the `requested_by`/`decided_by` default (T-008). */
function osUsername(): string {
  return userInfo().username
}

// ---------- T-010: startup reconciliation ----------

/**
 * One abandoned attempt of a crashed run, as read from the run's
 * `<runDir>/dispatch.jsonl` evidence (src/recover.ts). `startedAt` is the
 * dispatch record's stamp (when the attempt actually started);
 * `processIdentity` extends ProcessIdentity with the dispatch record's
 * lease/branch — the process-identity field T-007 recorded null now has a
 * producer.
 */
export interface AbandonedAttemptInput {
  jobId: string
  attemptNumber: number
  startedAt: string | null
  processIdentity: {
    pid: number | null
    startedAt: string | null
    leaseId: string | null
    branch: string | null
  }
}

/**
 * Mark a crashed run's recorded-`running` attempts abandoned (spec §15.2
 * step 1) — the second DB writer after `ingest`. One `attempts` row per
 * attempt (state 'abandoned', a failure record with reason 'abandoned',
 * `process_identity_json` from the dispatch record, `started_at` from the
 * dispatch stamp) plus exactly one `ATTEMPT_ABANDONED` event per attempt,
 * inside one transaction. Never touches `runs`/`candidates`/`gate_results`
 * or any prior event row, and never fabricates completed attempts of the
 * crashed run — their evidence lives in dispatch.jsonl; the store records
 * only what §15.2 step 1 requires.
 *
 * The abandonment stamp (the rows' `ended_at` and the events' `at`) is the
 * wall-clock moment of recovery — the header's second scoping case: the
 * report was never written, so there is no report-derived stamp to take.
 * `input_context_hash` is '' (a NOT NULL column with no producer in dispatch
 * evidence), `prompt_version`/`worker_session_id` null, `output_artifacts_json`
 * '[]' — stated, not smoothed. The connection opens with foreign-key
 * constraints disabled: a crashed run was never ingested, so no `runs` row
 * exists, and this writer must not fabricate one. Zero attempts is a no-op
 * that never opens the DB (recovering a run with nothing to mark writes
 * nothing — no refinery.db created as a side effect).
 */
export function recordAbandonedAttempts(runId: string, attempts: AbandonedAttemptInput[], dbPath: string): void {
  if (attempts.length === 0) return
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false })
  try {
    db.exec(SCHEMA_SQL)
    const abandonedAt = new Date().toISOString()
    const failure = {
      reason: 'abandoned',
      message: `run ${runId} died before this attempt completed; marked abandoned by startup reconciliation`,
      timedOut: false,
      exitCode: null,
    }
    db.exec('BEGIN')
    try {
      const insertAttempt = db.prepare(
        `INSERT INTO attempts (run_id, job_id, attempt_number, state, started_at, ended_at,
           input_context_hash, prompt_version, process_identity_json, worker_session_id,
           output_artifacts_json, failure_json)
         VALUES (?, ?, ?, 'abandoned', ?, ?, '', NULL, ?, NULL, '[]', ?)`,
      )
      for (const a of attempts) {
        insertAttempt.run(
          runId,
          a.jobId,
          a.attemptNumber,
          a.startedAt ?? null,
          abandonedAt,
          JSON.stringify(a.processIdentity),
          JSON.stringify(failure),
        )
        insertEvent(db, runId, 'ATTEMPT_ABANDONED', abandonedAt, {
          jobId: a.jobId,
          attemptId: `${a.jobId}-a${a.attemptNumber}`,
          attemptNumber: a.attemptNumber,
          pid: a.processIdentity.pid,
        })
      }
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // transaction was already rolled back or never opened — nothing to undo
      }
      throw e
    }
  } finally {
    db.close()
  }
}

// ---------- T-006: the derived job DAG ----------

/** The one phase every run derives from. Today's pipeline (src/runner.ts) is
 *  a flat fan-out with no phase domain object, so ingest records the whole
 *  run as a single dependency-free phase. */
export const DERIVED_PHASE_ID = 'main'

/** Minimal DAG shape the validators and ingest operate on: nodes by id, each
 *  with the ids it depends on. Fits jobs today; a later slice can reuse it
 *  for phase-level dependencies. */
export interface DagJobSpec {
  readonly id: string
  readonly dependencies: readonly string[]
}

/**
 * The run's actual DAG, derived purely from the report: exactly one phase
 * (`main`, no dependencies), one dependency-free job per candidate, zero
 * edges. The flat fallback for schedule-less reports — a report carrying a
 * schedule block (T-009 --jobs mode) derives its REAL structure in `ingest`
 * instead (multiple phases, expanded dependency edges), making this slice
 * the non-trivial-DAG producer T-006 flagged as absent.
 */
export function deriveDag(report: RunReport): { phaseId: string; jobs: DagJobSpec[] } {
  return {
    phaseId: DERIVED_PHASE_ID,
    jobs: report.candidates.map((c) => ({ id: c.id, dependencies: [] })),
  }
}

/** Phase row source: the flat derivation (`main`, null completion) or a
 *  schedule block's declared phases (T-009 — `completion`'s first producer). */
interface DagPhase {
  id: string
  dependencies: string[]
  completion: string | null
}

/** Job row source: node id, its phase, and the expanded edges the ready
 *  function enforced (flat derivation: candidate id, `main`, none). */
interface DagJobRow {
  id: string
  phaseId: string
  dependencies: string[]
}

/**
 * Refusal message when some dependency names an id that is not in the set;
 * null when every reference resolves. Pure: no I/O, no model involvement.
 */
export function unknownDependencyRefusal(jobs: readonly DagJobSpec[]): string | null {
  const known = new Set(jobs.map((j) => j.id))
  for (const j of jobs) {
    for (const d of j.dependencies) {
      if (!known.has(d)) {
        return `job '${j.id}' depends on '${d}', which is not in the job set`
      }
    }
  }
  return null
}

/**
 * Refusal message naming a concrete dependency cycle (`a -> b -> a`), found
 * by topological sort (Kahn's layering): nodes the sort cannot consume are in
 * or downstream of a cycle, and every leftover node depends on another
 * leftover node, so one walk over the leftovers must revisit a node — that
 * loop is the named cycle. Null when the graph is acyclic. Pure.
 */
export function cycleRefusal(jobs: readonly DagJobSpec[]): string | null {
  const byId = new Map(jobs.map((j) => [j.id, j]))
  const removed = new Set<string>()
  const remaining = new Set(byId.keys())
  let progress = true
  while (progress && remaining.size > 0) {
    progress = false
    for (const id of remaining) {
      if ((byId.get(id)?.dependencies ?? []).every((d) => removed.has(d))) {
        removed.add(id)
        remaining.delete(id)
        progress = true
      }
    }
  }
  if (remaining.size === 0) return null
  const seen = new Map<string, number>()
  const walk: string[] = []
  let cur = [...remaining][0]!
  while (!seen.has(cur)) {
    seen.set(cur, walk.length)
    walk.push(cur)
    cur = (byId.get(cur)?.dependencies ?? []).find((d) => remaining.has(d))!
  }
  const cycle = walk.slice(seen.get(cur)!)
  cycle.push(cur)
  return `dependency cycle: ${cycle.join(' -> ')}`
}

/**
 * Persist one finished run. The only DB writer in the store.
 *
 * `runs`/`candidates`/`gate_results`/`phases`/`jobs`/`attempts`/`artifacts`/
 * `probe_runs` upsert by natural key; `job_dependencies` is re-derived
 * (delete + insert) so re-ingest stays idempotent; `events` is append-only
 * and never rewrites prior rows. The DAG is derived from the report — a
 * pure function, validated before any DB side effect. A report carrying a
 * schedule block (T-009 --jobs mode) derives the REAL phases/jobs/edges
 * from it; otherwise T-006's flat derivation stands. Attempt and schedule
 * stamps are copied from report-carried values, never `Date.now()`.
 * Artifact rows (T-016) are measured at ingest — the header's third
 * scoping case: a read of the evidence files the report names, NULL when a
 * file is missing, never a fabricated value. Throws on failure — the
 * caller (src/cli.ts) logs loudly and continues.
 */
export function ingest(report: RunReport, dbPath: string): void {
  const schedule = report.schedule
  const phases: DagPhase[] = schedule
    ? schedule.phases.map((p) => ({ id: p.id, dependencies: [...p.dependencies], completion: p.completion }))
    : [{ id: DERIVED_PHASE_ID, dependencies: [], completion: null }]
  const dagJobs: DagJobRow[] = schedule
    ? schedule.jobs.map((j) => ({ id: j.id, phaseId: j.phaseId, dependencies: [...j.dependencies] }))
    : report.candidates.map((c) => ({ id: c.id, phaseId: DERIVED_PHASE_ID, dependencies: [] }))
  const refusal = unknownDependencyRefusal(dagJobs) ?? cycleRefusal(dagJobs)
  if (refusal) throw new Error(`derived job DAG for run ${report.runId} refused: ${refusal}`)

  // T-016 hash-at-ingest: every report-named evidence path is measured
  // BEFORE the DB opens (the header's third scoping case — ingest is a
  // function of the report and the evidence files it names; the wall clock
  // enters nowhere).
  const artifacts: (DerivedArtifact & { sizeBytes: number | null; contentHash: string | null })[] =
    deriveArtifacts(report).map((a) => ({ ...a, ...measureEvidenceFile(a.path) }))
  const probeRuns = report.candidates.flatMap((c) => (c.probes ?? []).map((p) => ({
    jobId: c.id,
    probeId: p.probeId,
    scenarioId: p.scenarioId,
    success: p.success,
    durationMs: p.durationMs,
    bundlePath: p.bundlePath,
  })))

  const db = new DatabaseSync(dbPath)
  try {
    db.exec(SCHEMA_SQL)
    db.exec('BEGIN')
    try {
      upsertRun(db, report)
      for (const p of phases) {
        upsertPhase(db, report.runId, p)
      }
      insertEvent(db, report.runId, 'RUN_CREATED', report.startedAt, {
        repo: report.repo,
        baseSha: report.baseSha,
        goal: report.goal,
        model: report.model,
      })
      for (const c of report.candidates) {
        upsertCandidate(db, report.runId, c)
        // Attempts (T-007): one row and one derived ATTEMPT_STARTED event per
        // recorded attempt, keyed (run_id, job_id, attempt_number). Reports
        // that predate T-007 carry no attempts array — zero rows, unchanged
        // otherwise. `at` comes from the attempt's own startedAt (never the
        // wall clock), so re-ingest is deterministic; the fallback to the
        // run's start only covers spec-optional missing stamps.
        for (const a of c.attempts ?? []) {
          upsertAttempt(db, report.runId, c.id, a)
          insertEvent(db, report.runId, 'ATTEMPT_STARTED', a.startedAt ?? report.startedAt, {
            jobId: c.id,
            attemptId: a.id,
            attemptNumber: a.number,
          })
        }
        for (const g of c.gates) {
          upsertGateResult(db, report.runId, c.id, g)
          if (!g.passed) {
            insertEvent(db, report.runId, 'GATE_FAILED', candidateAt(report, c), {
              candidateId: c.id,
              gate: g.name,
              exitCode: g.exitCode,
            })
          }
        }
        if (!c.passedAllGates) {
          insertEvent(db, report.runId, 'CANDIDATE_ELIMINATED', candidateAt(report, c), {
            candidateId: c.id,
            reason: eliminationReason(c),
          })
        }
      }
      // Job rows: from the schedule when present — the real structure,
      // including never-dispatched jobs (worker/model/brief written empty:
      // nothing executed, nothing fabricated); else one job per candidate,
      // T-006's derivation verbatim.
      const byId = new Map(report.candidates.map((c) => [c.id, c]))
      for (const j of dagJobs) {
        const c = byId.get(j.id)
        upsertJobRow(db, report.runId, j, c?.workerId ?? '', c?.model ?? '', c?.brief ?? '')
      }
      rederiveJobDependencies(db, report.runId, dagJobs)
      // Derived schedule events (T-009) — post-hoc and report-derived, so
      // re-ingest stays deterministic and a DB failure can never influence a
      // run. Appended after the per-candidate block, in schedule order.
      if (schedule) insertScheduleEvents(db, report, schedule)
      // T-016: the artifacts + probe_runs rows (upserts; hash columns
      // recompute from the files, which are immutable-by-convention),
      // then the derived ARTIFACT_CREATED block (§28:1854) — one event per
      // artifacts row, appended after every existing derived block in
      // derivation order, every `at` a pure function of the report's stamps
      // (never `Date.now()`): run-level artifacts at finishedAt,
      // candidate-scoped ones at the shared job finish-stamp derivation.
      // Re-ingest leaves the rows idempotent while events append a fresh
      // deterministic block. Recorded evidence only — never a verdict input
      // (decisions.md: gates decide survival).
      const byCandidateId = new Map(report.candidates.map((c) => [c.id, c]))
      for (const a of artifacts) {
        upsertArtifact(db, report.runId, a)
      }
      for (const p of probeRuns) {
        upsertProbeRun(db, report.runId, p)
      }
      for (const a of artifacts) {
        const c = a.jobId === null ? undefined : byCandidateId.get(a.jobId)
        const at = c === undefined ? report.finishedAt : jobFinishAt(report, c)
        insertEvent(db, report.runId, 'ARTIFACT_CREATED', at, {
          artifactId: a.artifactId,
          path: a.path,
          kind: a.kind,
          jobId: a.jobId,
          attemptNumber: a.attemptNumber,
        })
      }
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // transaction was already rolled back or never opened — nothing to undo
      }
      throw e
    }
  } finally {
    db.close()
  }
}

function upsertRun(db: DatabaseSync, report: RunReport): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo, base_sha, goal, model, started_at, finished_at, planner_json, report_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       repo = excluded.repo, base_sha = excluded.base_sha, goal = excluded.goal,
       model = excluded.model, started_at = excluded.started_at,
       finished_at = excluded.finished_at, planner_json = excluded.planner_json,
       report_path = excluded.report_path`,
  ).run(
    report.runId,
    report.repo,
    report.baseSha,
    report.goal,
    report.model,
    report.startedAt,
    report.finishedAt,
    report.planner ? JSON.stringify(report.planner) : null,
    reportPathOf(report),
  )
}

/** One row per phase. Flat derivation: `main`, no dependencies, §6.3 policy
 *  columns null. Schedule derivation (T-009): the real phases, with the
 *  declared dependencies and the completion policy — `completion`'s first
 *  producer. `earlyStop` HAS a producer since T-031 (the `--jobs` spec
 *  parses `EarlyStopPolicy`), but its record lives in the report's additive
 *  `earlyStops` block, not in this column — the store keeps persisting
 *  verdicts only (the rounds store-invisible precedent), so
 *  `early_stop_json` stays null this slice and its producer is a later
 *  ticket. `approvalGate` still has no producer (refused in the --jobs
 *  spec). */
function upsertPhase(db: DatabaseSync, runId: string, p: DagPhase): void {
  db.prepare(
    `INSERT INTO phases (run_id, phase_id, dependencies_json, completion, early_stop_json, approval_gate_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, phase_id) DO UPDATE SET
       dependencies_json = excluded.dependencies_json, completion = excluded.completion,
       early_stop_json = excluded.early_stop_json, approval_gate_json = excluded.approval_gate_json`,
  ).run(runId, p.id, JSON.stringify(p.dependencies), p.completion, null, null)
}

/** One row per job. Flat derivation: `job_id` IS the candidate id, in the
 *  run's single phase, empty dependencies. Schedule derivation (T-009): the
 *  real phase id and expanded dependency edges; a never-dispatched job
 *  carries empty worker/model/brief (nothing executed — stated, not
 *  smoothed). Every §6.4 policy column stays null — no producer in
 *  `RunReport`/`CandidateReport` this slice. */
function upsertJobRow(
  db: DatabaseSync,
  runId: string,
  j: DagJobRow,
  workerId: string,
  model: string,
  brief: string,
): void {
  db.prepare(
    `INSERT INTO jobs (run_id, job_id, phase_id, worker_id, model, brief, dependencies_json,
       role_json, workspace_json, permissions_json, prompt_json, context_plan_json,
       input_artifacts_json, expected_outputs_json, retry_policy_json, timeout_policy_json, gate_policy_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, job_id) DO UPDATE SET
       phase_id = excluded.phase_id, worker_id = excluded.worker_id, model = excluded.model,
       brief = excluded.brief, dependencies_json = excluded.dependencies_json,
       role_json = excluded.role_json, workspace_json = excluded.workspace_json,
       permissions_json = excluded.permissions_json, prompt_json = excluded.prompt_json,
       context_plan_json = excluded.context_plan_json,
       input_artifacts_json = excluded.input_artifacts_json,
       expected_outputs_json = excluded.expected_outputs_json,
       retry_policy_json = excluded.retry_policy_json,
       timeout_policy_json = excluded.timeout_policy_json,
       gate_policy_json = excluded.gate_policy_json`,
  ).run(
    runId,
    j.id,
    j.phaseId,
    workerId,
    model,
    brief,
    JSON.stringify(j.dependencies),
    null, null, null, null, null, null, null, null, null, null,
  )
}

/** One row per recorded attempt of a job: `job_id` is the candidate id
 *  (T-006 derives one job per candidate), `attempt_number` is 1-based.
 *  Stamps and hashes are copied verbatim out of the report's Attempt record.
 *  `prompt_version`/`process_identity_json`/`worker_session_id` are written
 *  null this slice — no producer in `Attempt` (T-007). */
function upsertAttempt(db: DatabaseSync, runId: string, jobId: string, a: Attempt): void {
  db.prepare(
    `INSERT INTO attempts (run_id, job_id, attempt_number, state, started_at, ended_at,
       input_context_hash, prompt_version, process_identity_json, worker_session_id,
       output_artifacts_json, failure_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, job_id, attempt_number) DO UPDATE SET
       state = excluded.state, started_at = excluded.started_at, ended_at = excluded.ended_at,
       input_context_hash = excluded.input_context_hash, prompt_version = excluded.prompt_version,
       process_identity_json = excluded.process_identity_json,
       worker_session_id = excluded.worker_session_id,
       output_artifacts_json = excluded.output_artifacts_json,
       failure_json = excluded.failure_json`,
  ).run(
    runId,
    jobId,
    a.number,
    a.state,
    a.startedAt ?? null,
    a.endedAt ?? null,
    a.inputContextHash,
    a.promptVersion ?? null,
    a.processIdentity ? JSON.stringify(a.processIdentity) : null,
    a.workerSessionId ?? null,
    JSON.stringify(a.outputArtifacts ?? []),
    a.failure ? JSON.stringify(a.failure) : null,
  )
}

/** Dependency edges are re-derived (delete + insert) so re-ingest stays
 *  idempotent while `events` appends. Flat reports derive zero edges; a
 *  schedule-carrying report (T-009) derives its real expanded edges. */
function rederiveJobDependencies(db: DatabaseSync, runId: string, jobs: readonly DagJobSpec[]): void {
  db.prepare('DELETE FROM job_dependencies WHERE run_id = ?').run(runId)
  const insert = db.prepare(
    'INSERT INTO job_dependencies (run_id, job_id, depends_on_job_id) VALUES (?, ?, ?)',
  )
  for (const j of jobs) {
    for (const d of j.dependencies) {
      insert.run(runId, j.id, d)
    }
  }
}

// ---------- T-009: derived schedule events ----------

/**
 * The derived schedule events, appended after the per-candidate block in
 * schedule order — all ingest-derived post-hoc from the recorded schedule,
 * never live in-run, all stamps pure functions of the report (never
 * `Date.now()`), so re-ingest is deterministic:
 *
 * - `JOB_READY` (§28:1852) per DISPATCHED job, `at` = the max of its
 *   dependencies' finish stamps (the run's `startedAt` for dependency-free
 *   jobs). Never-dispatched jobs get no events — they are recorded as
 *   not-dispatched in the schedule block, never fabricated as terminal.
 * - `JOB_SUCCEEDED` / `JOB_FAILED` per dispatched job (the documented §28
 *   vocabulary extensions — §28 names no job-terminal events), `at` = the
 *   job's own finish stamp, payload naming job and phase.
 * - `PHASE_COMPLETED` per phase that reached terminal success on every job
 *   (the `all` completion policy), `at` = the max finish stamp of its jobs.
 *   A failed or blocked phase gets no event — §28 names no such event and
 *   this slice defines none (the T-008 extension precedent covers only what
 *   has a producer).
 */
function insertScheduleEvents(db: DatabaseSync, report: RunReport, schedule: RunSchedule): void {
  const byId = new Map(report.candidates.map((c) => [c.id, c]))
  const finishAt = new Map<string, string>()
  for (const c of report.candidates) finishAt.set(c.id, jobFinishAt(report, c))
  for (const j of schedule.jobs) {
    if (j.dispatchIndex === null) continue
    const c = byId.get(j.id)
    if (!c) {
      throw new Error(`schedule job '${j.id}' dispatched at index ${j.dispatchIndex} but carries no candidate report`)
    }
    const deps = j.dependencies
      .map((d) => finishAt.get(d))
      .filter((s): s is string => s !== undefined)
    const readyAt = deps.length === 0
      ? report.startedAt
      : deps.reduce((max, s) => (Date.parse(s) > Date.parse(max) ? s : max), report.startedAt)
    insertEvent(db, report.runId, 'JOB_READY', readyAt, { jobId: j.id, phaseId: j.phaseId })
    insertEvent(db, report.runId, c.passedAllGates ? 'JOB_SUCCEEDED' : 'JOB_FAILED', finishAt.get(c.id)!, {
      jobId: j.id,
      phaseId: j.phaseId,
    })
  }
  for (const p of schedule.phases) {
    if (p.status !== 'completed') continue
    const stamps = schedule.jobs
      .filter((j) => j.phaseId === p.id && j.dispatchIndex !== null)
      .map((j) => finishAt.get(j.id))
      .filter((s): s is string => s !== undefined)
    const at = stamps.length === 0
      ? report.startedAt
      : stamps.reduce((max, s) => (Date.parse(s) > Date.parse(max) ? s : max), report.startedAt)
    insertEvent(db, report.runId, 'PHASE_COMPLETED', at, { phaseId: p.id })
  }
}

/** A dispatched job's finish stamp: its last attempt's `endedAt` when the
 *  report carries attempts, else the candidate-ladder derivation
 *  (`candidateAt`: startedAt + worker duration). Pure function of the
 *  report — never the wall clock. */
function jobFinishAt(report: RunReport, c: CandidateReport): string {
  const ended = (c.attempts ?? [])
    .map((a) => a.endedAt)
    .filter((s): s is string => typeof s === 'string' && !Number.isNaN(Date.parse(s)))
  if (ended.length === 0) return candidateAt(report, c)
  return ended.reduce((max, s) => (Date.parse(s) > Date.parse(max) ? s : max))
}

function upsertCandidate(db: DatabaseSync, runId: string, c: CandidateReport): void {
  db.prepare(
    `INSERT INTO candidates (run_id, candidate_id, worker_id, model, brief, worker_ok,
       worker_timed_out, worker_duration_ms, diff_bytes, passed_all_gates, review_json, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, candidate_id) DO UPDATE SET
       worker_id = excluded.worker_id, model = excluded.model, brief = excluded.brief,
       worker_ok = excluded.worker_ok, worker_timed_out = excluded.worker_timed_out,
       worker_duration_ms = excluded.worker_duration_ms, diff_bytes = excluded.diff_bytes,
       passed_all_gates = excluded.passed_all_gates, review_json = excluded.review_json,
       error = excluded.error`,
  ).run(
    runId,
    c.id,
    c.workerId,
    c.model,
    c.brief,
    c.workerOk ? 1 : 0,
    c.workerTimedOut ? 1 : 0,
    c.workerDurationMs,
    c.diffBytes,
    c.passedAllGates ? 1 : 0,
    c.review ? JSON.stringify(c.review) : null,
    c.error ?? null,
  )
}

function upsertGateResult(
  db: DatabaseSync,
  runId: string,
  candidateId: string,
  g: { name: string; passed: boolean; exitCode: number | null; durationMs: number; outputTail: string },
): void {
  db.prepare(
    `INSERT INTO gate_results (run_id, candidate_id, gate_name, passed, exit_code, duration_ms, output_tail)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, candidate_id, gate_name) DO UPDATE SET
       passed = excluded.passed, exit_code = excluded.exit_code,
       duration_ms = excluded.duration_ms, output_tail = excluded.output_tail`,
  ).run(runId, candidateId, g.name, g.passed ? 1 : 0, g.exitCode, g.durationMs, g.outputTail)
}

function insertEvent(
  db: DatabaseSync,
  runId: string,
  type: string,
  at: string,
  payload: object,
): void {
  db.prepare('INSERT INTO events (run_id, type, at, payload) VALUES (?, ?, ?, ?)')
    .run(runId, type, at, JSON.stringify(payload))
}

/** One row per report-named evidence path (T-016): `artifact_id` is the
 *  deterministic producer-triple id (`artifactId`), `kind` the path-derived
 *  `ArtifactKind`, `size_bytes`/`content_hash` what hash-at-ingest measured
 *  (NULL when the file was missing — never fabricated). Upsert by natural
 *  key, so re-ingest recomputes the hashes from unchanged files and the
 *  rows come out identical. */
function upsertArtifact(
  db: DatabaseSync,
  runId: string,
  a: DerivedArtifact & { sizeBytes: number | null; contentHash: string | null },
): void {
  db.prepare(
    `INSERT INTO artifacts (run_id, artifact_id, kind, job_id, attempt_number, path, size_bytes, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, artifact_id) DO UPDATE SET
       kind = excluded.kind, job_id = excluded.job_id, attempt_number = excluded.attempt_number,
       path = excluded.path, size_bytes = excluded.size_bytes, content_hash = excluded.content_hash`,
  ).run(runId, a.artifactId, a.kind, a.jobId, a.attemptNumber, a.path, a.sizeBytes, a.contentHash)
}

/** One row per probe summary the report carries (T-016), field-for-field
 *  the `ProbeRunSummary` shape (src/types.ts) keyed (run_id, job_id,
 *  probe_id) — the bundle's own artifacts row lives in `artifacts` (the
 *  bundle is the addressable evidence unit; its internal .log files get no
 *  row this slice). */
function upsertProbeRun(
  db: DatabaseSync,
  runId: string,
  p: { jobId: string; probeId: string; scenarioId: string; success: boolean; durationMs: number; bundlePath: string },
): void {
  db.prepare(
    `INSERT INTO probe_runs (run_id, job_id, probe_id, scenario_id, success, duration_ms, bundle_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, job_id, probe_id) DO UPDATE SET
       scenario_id = excluded.scenario_id, success = excluded.success,
       duration_ms = excluded.duration_ms, bundle_path = excluded.bundle_path`,
  ).run(runId, p.jobId, p.probeId, p.scenarioId, p.success ? 1 : 0, p.durationMs, p.bundlePath)
}

/** Report's own clock: worker finished at startedAt + its duration; gates and
 *  the elimination verdict follow immediately after. */
function candidateAt(report: RunReport, c: CandidateReport): string {
  const t = Date.parse(report.startedAt) + c.workerDurationMs
  return Number.isFinite(t) ? new Date(t).toISOString() : report.finishedAt
}

/** Matches the verdict ladder in src/cli.ts: error → worker → no-op → gates. */
function eliminationReason(c: CandidateReport): string {
  if (c.error) return 'error'
  if (!c.workerOk) return 'worker-failed'
  if (c.diffBytes === 0) return 'no-op'
  if (c.gates.length === 0) return 'no-gates'
  return 'gates-failed'
}

/** The artifacts dir is not a RunReport field; recover the report.json path
 *  from the artifact paths the report does carry (planner raw output lives at
 *  the run dir root, candidate evidence one level below it). Null when the
 *  report carries no artifact paths at all. */
function reportPathOf(report: RunReport): string | null {
  if (report.planner?.rawOutputPath) return join(dirname(report.planner.rawOutputPath), 'report.json')
  for (const c of report.candidates) {
    const ref = c.review?.rawOutputPath ?? c.diffPath
    if (ref) return join(dirname(dirname(ref)), 'report.json')
  }
  return null
}
