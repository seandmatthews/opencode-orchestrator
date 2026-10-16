// Store-ingest self-check (Gate 1.6, fast tier, T-003 + T-006 + T-007) — run
// under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-store.mjs
// Pins the durable run records against the vendored real report
// (scripts/fixtures/report-real.json): exact rows/fields, append-only events
// across re-ingest, integrity_check, read-only-over-evidence, and a throwing
// (loud, non-fatal at the CLI) failed-write path — without model tokens.
// T-006 extends it with the derived job DAG (phases/jobs/job_dependencies)
// and the pure validators on hand-built synthetic inputs (Gate 0.5's
// hand-built-input pattern — no pipeline, no model tokens). T-007 extends it
// with the attempts table: a hand-built retried-candidate variant of the
// fixture (the elim-variant pattern) pins row shape/values, ATTEMPT_STARTED
// derivation, and re-ingest idempotency with append-only events.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, cycleRefusal, deriveDag, ingest, unknownDependencyRefusal } from '../src/store/index.ts'

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
  t('fixture predates attempts: zero attempt rows (pre-T-007 reports ingest unchanged)', count('attempts') === 0)

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

  // ---------- T-006: the derived DAG matches the report's real fan-out ----------
  // Version bumped 3 -> 4 by T-008 (the approval_gates slice); each schema
  // slice moves this pinned assertion in its own change-set.
  t('SCHEMA_VERSION is 4', SCHEMA_VERSION === 4)
  t('one phase row for the run', count('phases') === 1)
  const phase = db.prepare('SELECT * FROM phases WHERE run_id = ?').get(report.runId)
  t("phase_id is 'main'", phase?.phase_id === 'main')
  t('phase dependencies_json is []', eq(JSON.parse(phase?.dependencies_json), []))
  t('phase policy columns null (no producer in RunReport)',
    phase?.completion == null && phase?.early_stop_json == null && phase?.approval_gate_json == null)
  t('one job row per candidate', count('jobs') === report.candidates.length)
  for (const c of report.candidates) {
    const job = db.prepare('SELECT * FROM jobs WHERE run_id = ? AND job_id = ?').get(report.runId, c.id)
    t(`${c.id}: job_id = candidate id, phase_id = 'main', worker/model/brief copied verbatim`,
      job?.job_id === c.id && job?.phase_id === 'main'
      && job?.worker_id === c.workerId && job?.model === c.model && job?.brief === c.brief)
    t(`${c.id}: dependencies [] and every policy column null (no producer this slice)`,
      eq(JSON.parse(job?.dependencies_json), [])
      && job?.role_json == null && job?.workspace_json == null && job?.permissions_json == null
      && job?.prompt_json == null && job?.context_plan_json == null
      && job?.input_artifacts_json == null && job?.expected_outputs_json == null
      && job?.retry_policy_json == null && job?.timeout_policy_json == null
      && job?.gate_policy_json == null)
  }
  t('zero job_dependencies rows (the pipeline is a flat fan-out)', count('job_dependencies') === 0)
  const jobsBefore = db.prepare('SELECT * FROM jobs WHERE run_id = ? ORDER BY job_id').all(report.runId)

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
  t('re-ingest: phases unchanged (upsert)',
    count('phases') === 1 && eq(db.prepare('SELECT * FROM phases WHERE run_id = ?').get(report.runId), phase))
  t('re-ingest: jobs unchanged (upsert)',
    count('jobs') === report.candidates.length
    && eq(db.prepare('SELECT * FROM jobs WHERE run_id = ? ORDER BY job_id').all(report.runId), jobsBefore))
  t('re-ingest: job_dependencies still zero (edges re-derived)', count('job_dependencies') === 0)
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

  // ---------- T-007: the attempts table on a hand-built retried candidate ----------
  // Exactly like the elim-variant: the vendored fixture cloned, one candidate
  // given an attempts array by hand. c01's attempt 2 mirrors its real final
  // values (the top-level fields are the FINAL attempt's values — T-007
  // semantics). c02 keeps the pre-T-007 shape (no attempts field) on purpose:
  // mixed runs stay ingestable.
  const retried = structuredClone(report)
  const rc = retried.candidates[0]
  const hashA = 'a'.repeat(64)
  const attempt1 = {
    id: `${rc.id}-a1`, jobId: rc.id, number: 1, state: 'failed',
    startedAt: '2026-10-11T02:24:20.100Z', endedAt: '2026-10-11T02:24:53.600Z',
    inputContextHash: hashA, promptVersion: null,
    outputArtifacts: [
      'C:\\swarm\\verify\\20261011022419\\c01\\worker.log',
      'C:\\swarm\\verify\\20261011022419\\c01\\diff.patch',
    ],
    failure: { reason: 'worker-failed', message: 'worker exited with code 1', timedOut: false, exitCode: 1 },
  }
  const attempt2 = {
    id: `${rc.id}-a2`, jobId: rc.id, number: 2, state: 'succeeded',
    startedAt: '2026-10-11T02:24:54.000Z', endedAt: '2026-10-11T02:25:27.400Z',
    inputContextHash: hashA, promptVersion: null,
    outputArtifacts: [
      'C:\\swarm\\verify\\20261011022419\\c01\\attempt-2\\worker.log',
      'C:\\swarm\\verify\\20261011022419\\c01\\attempt-2\\diff.patch',
    ],
  }
  rc.attempts = [attempt1, attempt2]
  const retriedDbPath = join(sandbox, 'retried.db')
  ingest(retried, retriedDbPath)
  const retriedDb = new DatabaseSync(retriedDbPath)
  t('retried variant: one attempts row per recorded attempt',
    retriedDb.prepare('SELECT COUNT(*) AS n FROM attempts').get().n === 2)
  for (const a of [attempt1, attempt2]) {
    const row = retriedDb.prepare('SELECT * FROM attempts WHERE run_id = ? AND job_id = ? AND attempt_number = ?')
      .get(retried.runId, rc.id, a.number)
    t(`retried variant: attempt ${a.number} row matches the report record (state/stamps/hash/artifacts/failure)`,
      row?.state === a.state && row?.started_at === a.startedAt && row?.ended_at === a.endedAt
      && row?.input_context_hash === a.inputContextHash
      && eq(JSON.parse(row?.output_artifacts_json), a.outputArtifacts)
      && (a.failure ? eq(JSON.parse(row?.failure_json), a.failure) : row?.failure_json == null))
    t(`retried variant: attempt ${a.number} producer-less columns null (prompt_version/process_identity/worker_session)`,
      row?.prompt_version == null && row?.process_identity_json == null && row?.worker_session_id == null)
  }
  t('retried variant: the candidate without an attempts field yields zero rows (pre-T-007 shape tolerated)',
    retriedDb.prepare('SELECT COUNT(*) AS n FROM attempts WHERE job_id = ?').get(retried.candidates[1].id).n === 0)
  const retriedEvents = retriedDb.prepare('SELECT type, at, payload FROM events ORDER BY seq').all()
  t('retried variant: exactly one ATTEMPT_STARTED per attempt, in order, after RUN_CREATED, at the attempt stamps',
    eq(retriedEvents.map((e) => e.type), ['RUN_CREATED', 'ATTEMPT_STARTED', 'ATTEMPT_STARTED'])
    && retriedEvents[1]?.at === attempt1.startedAt && retriedEvents[2]?.at === attempt2.startedAt)
  t('retried variant: ATTEMPT_STARTED payloads name the job, attempt id, and number',
    eq(JSON.parse(retriedEvents[1]?.payload), { jobId: rc.id, attemptId: attempt1.id, attemptNumber: 1 })
    && eq(JSON.parse(retriedEvents[2]?.payload), { jobId: rc.id, attemptId: attempt2.id, attemptNumber: 2 }))
  const attemptRowsBefore = retriedDb.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY attempt_number').all(retried.runId)
  const retriedEventsBefore = retriedDb.prepare('SELECT seq, type, at, payload FROM events ORDER BY seq').all()
  retriedDb.close()

  // re-ingest of the retried variant: attempt rows idempotent, events append-only
  ingest(retried, retriedDbPath)
  const retriedDb2 = new DatabaseSync(retriedDbPath)
  t('retried re-ingest: attempt rows unchanged (upsert by natural key)',
    eq(retriedDb2.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY attempt_number').all(retried.runId), attemptRowsBefore))
  const retriedEventsAfter = retriedDb2.prepare('SELECT seq, type, at, payload FROM events ORDER BY seq').all()
  t('retried re-ingest: events appended (a fresh deterministic block), prior rows untouched',
    retriedEventsAfter.length === retriedEventsBefore.length * 2
    && eq(retriedEventsAfter.slice(0, retriedEventsBefore.length), retriedEventsBefore)
    && eq(retriedEventsAfter.slice(retriedEventsBefore.length).map((e) => e.type),
      ['RUN_CREATED', 'ATTEMPT_STARTED', 'ATTEMPT_STARTED']))
  t('retried re-ingest: integrity_check ok', retriedDb2.prepare('PRAGMA integrity_check').get()['integrity_check'] === 'ok')
  retriedDb2.close()

  // ---------- T-006: pure validators on hand-built inputs (Gate 0.5 pattern) ----------
  // The derived DAG is acyclic by construction; the interesting validator
  // inputs are synthetic, built here by hand — no pipeline, no model tokens.
  const derived = deriveDag(report)
  t('deriveDag: main phase, one dependency-free job per candidate, in report order',
    derived.phaseId === 'main' && derived.jobs.length === report.candidates.length
    && report.candidates.every((c, i) => derived.jobs[i]?.id === c.id && eq(derived.jobs[i]?.dependencies, [])))
  t('validators accept the derived flat DAG',
    unknownDependencyRefusal(derived.jobs) == null && cycleRefusal(derived.jobs) == null)
  const cyclic = [{ id: 'a', dependencies: ['b'] }, { id: 'b', dependencies: ['c'] }, { id: 'c', dependencies: ['a'] }]
  const cycRefusal = cycleRefusal(cyclic)
  t('cycle detection refuses a synthetic 3-cycle and names every job on it',
    typeof cycRefusal === 'string' && ['a', 'b', 'c'].every((id) => cycRefusal.includes(id)))
  const selfRefusal = cycleRefusal([{ id: 'solo', dependencies: ['solo'] }])
  t('cycle detection refuses a self-dependency and names it',
    typeof selfRefusal === 'string' && selfRefusal.includes('solo'))
  const unknownRefusal = unknownDependencyRefusal([{ id: 'a', dependencies: ['ghost'] }])
  t('unknown-reference check refuses and names the offender and the missing id',
    typeof unknownRefusal === 'string' && unknownRefusal.includes('a') && unknownRefusal.includes('ghost'))

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
