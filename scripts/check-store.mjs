// Store-ingest self-check (Gate 1.6, fast tier, T-003) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-store.mjs
// Pins the durable run records against the vendored real report
// (scripts/fixtures/report-real.json): exact rows/fields, append-only events
// across re-ingest, integrity_check, read-only-over-evidence, and a throwing
// (loud, non-fatal at the CLI) failed-write path — without model tokens.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { ingest } from '../src/store/index.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'report-real.json')
const fixtureShaBefore = sha256(fixturePath)
const report = JSON.parse(readFileSync(fixturePath, 'utf8'))

const sandbox = mkdtempSync(join(tmpdir(), 't003-store-'))
try {
  // ---------- ingest #1: rows and fields exactly match the report ----------
  const dbPath = join(sandbox, 'refinery.db')
  ingest(report, dbPath)
  const db = new DatabaseSync(dbPath)

  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  t('one run row', count('runs') === 1)
  t('one row per candidate', count('candidates') === report.candidates.length)
  t('one row per candidate gate', count('gate_results') === report.candidates.reduce((n, c) => n + c.gates.length, 0))

  const run = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(report.runId)
  t('run_id matches', run?.run_id === report.runId)
  t('repo/base_sha/goal/model copied verbatim',
    run?.repo === report.repo && run?.base_sha === report.baseSha && run?.goal === report.goal && run?.model === report.model)
  t('started_at/finished_at copied verbatim', run?.started_at === report.startedAt && run?.finished_at === report.finishedAt)
  t('planner_json round-trips the planner summary', eq(JSON.parse(run?.planner_json), report.planner))
  t('report_path points at the real report.json artifact', run?.report_path === 'C:\\swarm\\verify\\20261011022419\\report.json')

  for (const c of report.candidates) {
    const row = db.prepare('SELECT * FROM candidates WHERE run_id = ? AND candidate_id = ?').get(report.runId, c.id)
    t(`${c.id}: worker/model/brief copied verbatim`,
      row?.worker_id === c.workerId && row?.model === c.model && row?.brief === c.brief)
    t(`${c.id}: worker verdicts and durations as integers`,
      row?.worker_ok === (c.workerOk ? 1 : 0) && row?.worker_timed_out === (c.workerTimedOut ? 1 : 0)
      && row?.worker_duration_ms === c.workerDurationMs && row?.diff_bytes === c.diffBytes
      && row?.passed_all_gates === (c.passedAllGates ? 1 : 0))
    t(`${c.id}: review_json round-trips the review`, c.review ? eq(JSON.parse(row?.review_json), c.review) : row?.review_json == null)
    t(`${c.id}: error is null`, row?.error == null)
    for (const g of c.gates) {
      const gr = db.prepare('SELECT * FROM gate_results WHERE run_id = ? AND candidate_id = ? AND gate_name = ?')
        .get(report.runId, c.id, g.name)
      t(`${c.id}/${g.name}: gate result fields match`,
        gr?.passed === (g.passed ? 1 : 0) && gr?.exit_code === g.exitCode
        && gr?.duration_ms === g.durationMs && gr?.output_tail === g.outputTail)
    }
  }

  const events1 = db.prepare('SELECT seq, type, at, payload FROM events ORDER BY seq').all()
  t('all-pass fixture emits exactly RUN_CREATED', events1.length === 1 && events1[0]?.type === 'RUN_CREATED')
  t('RUN_CREATED at derived from startedAt', events1[0]?.at === report.startedAt)
  t('RUN_CREATED payload round-trips', eq(JSON.parse(events1[0]?.payload), {
    repo: report.repo, baseSha: report.baseSha, goal: report.goal, model: report.model,
  }))

  t('integrity_check ok', db.prepare('PRAGMA integrity_check').get()['integrity_check'] === 'ok')

  // ---------- ingest #2: state idempotent, events append-only ----------
  ingest(report, dbPath)
  t('re-ingest: runs still one row', count('runs') === 1)
  t('re-ingest: candidates unchanged', count('candidates') === report.candidates.length)
  t('re-ingest: gate_results unchanged', count('gate_results') === report.candidates.reduce((n, c) => n + c.gates.length, 0))
  const runAfter = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(report.runId)
  t('re-ingest: run row values unchanged (upsert)', eq(runAfter, run))
  const events2 = db.prepare('SELECT seq, type, at, payload FROM events ORDER BY seq').all()
  t('re-ingest: events appended, prior row untouched',
    events2.length === 2 && eq(events2[0], events1[0]) && events2[1]?.type === 'RUN_CREATED')
  db.close()

  // ---------- event vocabulary on an eliminated candidate ----------
  const elim = structuredClone(report)
  const victim = elim.candidates[1]
  victim.gates[0].passed = false
  victim.gates[0].exitCode = 1
  victim.passedAllGates = false
  const elimDbPath = join(sandbox, 'eliminated.db')
  ingest(elim, elimDbPath)
  const elimDb = new DatabaseSync(elimDbPath)
  const elimEvents = elimDb.prepare('SELECT type, at, payload FROM events ORDER BY seq').all()
  t('elimination emits RUN_CREATED, GATE_FAILED, CANDIDATE_ELIMINATED in order',
    eq(elimEvents.map((e) => e.type), ['RUN_CREATED', 'GATE_FAILED', 'CANDIDATE_ELIMINATED']))
  const gateFail = elimEvents.find((e) => e.type === 'GATE_FAILED')
  t('GATE_FAILED payload names candidate and gate',
    eq(JSON.parse(gateFail?.payload), { candidateId: victim.id, gate: victim.gates[0].name, exitCode: 1 }))
  const eliminated = elimEvents.find((e) => e.type === 'CANDIDATE_ELIMINATED')
  t('CANDIDATE_ELIMINATED payload names candidate and reason',
    eq(JSON.parse(eliminated?.payload), { candidateId: victim.id, reason: 'gates-failed' }))
  const expectedAt = new Date(Date.parse(elim.startedAt) + victim.workerDurationMs).toISOString()
  t('candidate event at derived from startedAt + worker duration',
    gateFail?.at === expectedAt && eliminated?.at === expectedAt)
  elimDb.close()

  // ---------- evidence is read-only over ----------
  t('fixture report byte-identical after all ingests', sha256(fixturePath) === fixtureShaBefore)

  // ---------- failed DB write throws (CLI logs it and continues) ----------
  const blockedPath = join(sandbox, 'unopenable')
  mkdirSync(blockedPath)
  let threw = null
  try {
    ingest(report, blockedPath)
  } catch (e) {
    threw = e
  }
  t('ingest into an unopenable DB path throws instead of recording nothing', threw instanceof Error)
  let cantopen = null
  try {
    ingest(report, join(sandbox, 'missing-dir', 'refinery.db'))
  } catch (e) {
    cantopen = e
  }
  t('ingest into a missing directory throws too', cantopen instanceof Error)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\ncheck-store: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-store: ALL GREEN')
