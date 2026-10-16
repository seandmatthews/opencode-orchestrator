// Durable run records (T-003 store, T-006 job DAG) — slices of the stage-1
// state store (spec §27 Persistence Model, §28 Event Log, §34 Milestone 1).
//
// Zero npm dependencies: Node's built-in `node:sqlite` (DatabaseSync).
// node:sqlite is experimental on Node 22 — see VERIFICATION.md Known issues.
//
// The store is harness-agnostic (decisions.md): model IDs arrive only as
// strings copied out of `RunReport` fields. `ingest` is a pure function of
// the report — event timestamps derive from the report's own stamps and
// durations, never from the wall clock — so re-ingest is deterministic.
// Persistence records verdicts; it never influences them.

import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CandidateReport, RunReport } from '../types.js'

export const SCHEMA_VERSION = 2

// Schema v2 (T-006): the four v1 tables plus spec §27's `phases`/`jobs`/
// `job_dependencies`. Everything is CREATE TABLE IF NOT EXISTS, so an existing
// v1 refinery.db gains the new tables on its next ingest — no migration
// machinery, no backfill: old runs gain DAG rows only when re-ingested, which
// appends a fresh event block by design (Gate 1.6 re-ingest semantics). The
// §6.3/§6.4 policy columns are nullable and stay null this slice:
// RunReport/CandidateReport carry none of those fields, so there is no
// producer — stated honestly, not smoothed over.
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
`

// Event vocabulary — spec §28. This slice emits only these three; live
// in-run emission is carved off (would touch the runner).
// node:sqlite binds null/number/bigint/string/Buffer only, hence 1|0 booleans.

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
 * edges. There is no producer of non-trivial DAG data today — the report
 * types carry no phase/job/policy fields — so this slice lands the shape and
 * the derivation rather than pretend today's graph is interesting.
 */
export function deriveDag(report: RunReport): { phaseId: string; jobs: DagJobSpec[] } {
  return {
    phaseId: DERIVED_PHASE_ID,
    jobs: report.candidates.map((c) => ({ id: c.id, dependencies: [] })),
  }
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
 * `runs`/`candidates`/`gate_results`/`phases`/`jobs` upsert by natural key;
 * `job_dependencies` is re-derived (delete + insert) so re-ingest stays
 * idempotent; `events` is append-only and never rewrites prior rows. The DAG
 * is derived from the report — a pure function, validated before any DB side
 * effect (acyclic by construction today; the interesting inputs are synthetic
 * and live in the gate). Throws on failure — the caller (src/cli.ts) logs
 * loudly and continues.
 */
export function ingest(report: RunReport, dbPath: string): void {
  const dag = deriveDag(report)
  const refusal = unknownDependencyRefusal(dag.jobs) ?? cycleRefusal(dag.jobs)
  if (refusal) throw new Error(`derived job DAG for run ${report.runId} refused: ${refusal}`)

  const db = new DatabaseSync(dbPath)
  try {
    db.exec(SCHEMA_SQL)
    db.exec('BEGIN')
    try {
      upsertRun(db, report)
      upsertPhase(db, report.runId)
      insertEvent(db, report.runId, 'RUN_CREATED', report.startedAt, {
        repo: report.repo,
        baseSha: report.baseSha,
        goal: report.goal,
        model: report.model,
      })
      for (const c of report.candidates) {
        upsertCandidate(db, report.runId, c)
        upsertJob(db, report.runId, c)
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
      rederiveJobDependencies(db, report.runId, dag.jobs)
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

/** The derived phase: `main`, no dependencies. §6.3 policy columns
 *  (`completion`, `earlyStop`, `approvalGate`) stay null — no producer in
 *  `RunReport` this slice. */
function upsertPhase(db: DatabaseSync, runId: string): void {
  db.prepare(
    `INSERT INTO phases (run_id, phase_id, dependencies_json, completion, early_stop_json, approval_gate_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, phase_id) DO UPDATE SET
       dependencies_json = excluded.dependencies_json, completion = excluded.completion,
       early_stop_json = excluded.early_stop_json, approval_gate_json = excluded.approval_gate_json`,
  ).run(runId, DERIVED_PHASE_ID, JSON.stringify([]), null, null, null)
}

/** One job per candidate: `job_id` IS the candidate id, in the run's single
 *  phase, with the worker/model/brief strings copied out of `CandidateReport`.
 *  Every §6.4 policy column stays null — no producer in
 *  `RunReport`/`CandidateReport` this slice. */
function upsertJob(db: DatabaseSync, runId: string, c: CandidateReport): void {
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
    c.id,
    DERIVED_PHASE_ID,
    c.workerId,
    c.model,
    c.brief,
    JSON.stringify([]),
    null, null, null, null, null, null, null, null, null, null,
  )
}

/** Dependency edges are re-derived (delete + insert) so re-ingest stays
 *  idempotent while `events` appends. Zero rows today — the derived DAG is a
 *  flat fan-out. */
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
