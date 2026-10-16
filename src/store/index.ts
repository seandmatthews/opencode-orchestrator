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

import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Attempt, CandidateReport, RunReport, RunSchedule } from '../types.js'

export const SCHEMA_VERSION = 4

// Schema v4 (T-008): the v3 tables plus spec §27's `approval_gates`, narrowed
// to the columns with a producer (spec §21's `cancelled` state and the
// `APPROVAL_CANCELLED` event have none until an abort/cancel slice — not
// pre-defined, the T-007 'abandoned' precedent). Everything is CREATE TABLE IF
// NOT EXISTS, so an existing v1/v2/v3 refinery.db gains the new table on its
// next use — no migration machinery, no backfill. The §6.5 columns without a
// producer the attempts slice (`prompt_version`, `process_identity_json`,
// `worker_session_id`) are nullable and written null — stated honestly, not
// smoothed over. Schema v2 (T-006) added `phases`/`jobs`/`job_dependencies`,
// schema v3 (T-007) `attempts`. The §6.3/§6.4 policy columns are nullable and
// stay null this slice: RunReport/CandidateReport carry none of those fields,
// so there is no producer — stated honestly, not smoothed over.
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
// 1|0 booleans.

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
    const row = db.prepare('SELECT * FROM approval_gates WHERE run_id = ? AND phase_id = ? AND job_id = ?')
      .get(opts.runId, job.phase_id, opts.jobId) as Record<string, unknown> | undefined
    if (!row) throw new Error(`no approval request recorded for job '${opts.jobId}' — request one first`)
    if (row.state !== 'waiting_for_approval') {
      throw new Error(`approval for job '${opts.jobId}' is already '${String(row.state)}' — the audit record is not rewritable`)
    }

    const at = new Date().toISOString()
    const by = opts.by ?? osUsername()
    db.exec('BEGIN')
    try {
      db.prepare(
        `UPDATE approval_gates SET state = ?, decided_at = ?, decided_by = ?,
           note = COALESCE(?, note)
         WHERE run_id = ? AND phase_id = ? AND job_id = ?`,
      ).run(opts.decision, at, by, opts.note ?? null, opts.runId, job.phase_id, opts.jobId)
      insertEvent(db, opts.runId, opts.decision === 'approved' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED', at, {
        phaseId: job.phase_id,
        jobId: opts.jobId,
        decidedBy: by,
      })
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* nothing to undo */ }
      throw e
    }
    return {
      runId: opts.runId, phaseId: job.phase_id, jobId: opts.jobId, state: opts.decision,
      requestedAt: row.requested_at as string, requestedBy: row.requested_by as string,
      decidedAt: at, decidedBy: by, note: opts.note ?? (row.note as string | null),
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
 * `runs`/`candidates`/`gate_results`/`phases`/`jobs`/`attempts` upsert by
 * natural key; `job_dependencies` is re-derived (delete + insert) so re-ingest
 * stays idempotent; `events` is append-only and never rewrites prior rows.
 * The DAG is derived from the report — a pure function, validated before any
 * DB side effect. A report carrying a schedule block (T-009 --jobs mode)
 * derives the REAL phases/jobs/edges from it; otherwise T-006's flat
 * derivation stands. Attempt and schedule stamps are copied from
 * report-carried values, never `Date.now()`. Throws on failure — the caller
 * (src/cli.ts) logs loudly and continues.
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
 *  producer. `earlyStop`/`approvalGate` stay null (no producer; refused in
 *  the --jobs spec until their successor tickets land). */
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
