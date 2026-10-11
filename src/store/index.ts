// Durable run records (T-003) — first slice of the stage-1 state store
// (spec §27 Persistence Model, §28 Event Log, §34 Milestone 1).
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

export const SCHEMA_VERSION = 1

// Schema v1: exactly the four in-scope tables of this slice. Later stage-1
// slices add jobs/attempts/approval_gates/phases (spec §27's full list).
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
`

// Event vocabulary — spec §28. This slice emits only these three; live
// in-run emission is carved off (would touch the runner).
// node:sqlite binds null/number/bigint/string/Buffer only, hence 1|0 booleans.

/**
 * Persist one finished run. The only DB writer in this slice.
 *
 * `runs`/`candidates`/`gate_results` upsert by natural key; `events` is
 * append-only and never rewrites prior rows. Throws on failure — the caller
 * (src/cli.ts) logs loudly and continues.
 */
export function ingest(report: RunReport, dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(SCHEMA_SQL)
    db.exec('BEGIN')
    try {
      upsertRun(db, report)
      insertEvent(db, report.runId, 'RUN_CREATED', report.startedAt, {
        repo: report.repo,
        baseSha: report.baseSha,
        goal: report.goal,
        model: report.model,
      })
      for (const c of report.candidates) {
        upsertCandidate(db, report.runId, c)
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
