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
// derivation, and re-ingest idempotency with append-only events. T-009
// extends it with a schedule-carrying DAG variant: the REAL multi-phase
// structure in phases/jobs/job_dependencies, the derived schedule events
// (JOB_READY / JOB_SUCCEEDED / JOB_FAILED / PHASE_COMPLETED) at
// report-carried stamps, and re-ingest idempotency. T-016 extends it with
// the filesystem artifact store (schema v5): the artifacts + probe_runs
// rows, hash-at-ingest pinned on a controlled sandbox variant, and the
// derived ARTIFACT_CREATED block at report-carried stamps — re-ingest stays
// idempotent over state rows while events append.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, artifactId, cycleRefusal, deriveDag, ingest, unknownDependencyRefusal } from '../src/store/index.ts'

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
  t('RUN_CREATED at derived from startedAt', events1[0]?.at === report.startedAt)
  t('RUN_CREATED payload round-trips', eq(JSON.parse(events1[0]?.payload), {
    repo: report.repo, baseSha: report.baseSha, goal: report.goal, model: report.model,
  }))

  // ---------- T-016: the artifacts rows + the derived ARTIFACT_CREATED block ----------
  // One row per report-named path. The fixture predates attempts and probes,
  // so the derivation is exactly: report.json (via the reportPathOf
  // recovery), the planner raw output, and per candidate the diff + review
  // raw output — 6 rows, candidate-scoped with attempt_number null. Exact
  // hash values are deliberately NOT pinned on this fixture: its real
  // run-dir files may or may not exist on a given machine (the sandbox
  // variant below pins exact values on controlled files).
  const artifactRows = db.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(report.runId)
  t('exactly one artifacts row per report-named path (6: report.json + planner raw + per candidate diff + review raw)',
    artifactRows.length === 6)
  t('artifacts paths verbatim, kind/job/attempt as derived (attempt null: the fixture predates attempts)',
    eq(artifactRows.map((r) => [r.path, r.kind, r.job_id, r.attempt_number]).sort((a, b) => (a[0] < b[0] ? -1 : 1)), [
      ['C:\\swarm\\verify\\20261011022419\\c01\\diff.patch', 'diff', 'c01', null],
      ['C:\\swarm\\verify\\20261011022419\\c01\\review-raw.txt', 'log', 'c01', null],
      ['C:\\swarm\\verify\\20261011022419\\c02\\diff.patch', 'diff', 'c02', null],
      ['C:\\swarm\\verify\\20261011022419\\c02\\review-raw.txt', 'log', 'c02', null],
      ['C:\\swarm\\verify\\20261011022419\\planner-raw.txt', 'log', null, null],
      ['C:\\swarm\\verify\\20261011022419\\report.json', 'report', null, null],
    ]))
  t('the fixture predates probes: zero probe_runs rows', count('probe_runs') === 0)
  // The exact id scheme, pinned twice: once by fixed-input literals over the
  // exported function, once by the full literal id of a known fixture row
  // (breaking any tautology with the import).
  t('artifactId scheme pinned: run-level scope literal',
    artifactId(null, null, 'C:\\fixed\\report.json') === 'run/report.json-214a82cf9c7c2793')
  t('artifactId scheme pinned: attempt-scoped scope literal',
    artifactId('c01', 2, 'X:\\y\\diff.patch') === 'j:c01@a2/diff.patch-d70d8dd8fa28ee1b')
  t('artifactId scheme pinned: candidate scope without a recorded attempt literal',
    artifactId('c02', null, 'C:\\r\\c02\\diff.patch') === 'j:c02/diff.patch-4a4fddce720a60b1')
  t('report.json artifact_id is the pinned full literal for its fixture path',
    artifactRows.some((r) => r.path === 'C:\\swarm\\verify\\20261011022419\\report.json'
      && r.artifact_id === 'run/report.json-68bcbb91f2647d56'))

  const c01FinishAt = new Date(Date.parse(report.startedAt) + report.candidates[0].workerDurationMs).toISOString()
  const c02FinishAt = new Date(Date.parse(report.startedAt) + report.candidates[1].workerDurationMs).toISOString()
  t('all-pass fixture emits RUN_CREATED then one ARTIFACT_CREATED per artifact row (§28:1854, post-hoc)',
    events1.length === 7 && events1[0]?.type === 'RUN_CREATED'
    && events1.slice(1).every((e) => e.type === 'ARTIFACT_CREATED'))
  t('ARTIFACT_CREATED block in derivation order, paths verbatim',
    eq(events1.slice(1).map((e) => JSON.parse(e.payload).path), [
      'C:\\swarm\\verify\\20261011022419\\report.json',
      'C:\\swarm\\verify\\20261011022419\\planner-raw.txt',
      'C:\\swarm\\verify\\20261011022419\\c01\\diff.patch',
      'C:\\swarm\\verify\\20261011022419\\c01\\review-raw.txt',
      'C:\\swarm\\verify\\20261011022419\\c02\\diff.patch',
      'C:\\swarm\\verify\\20261011022419\\c02\\review-raw.txt',
    ]))
  t('run-level ARTIFACT_CREATED at finishedAt; candidate-scoped at the shared finish-stamp derivation (never Date.now())',
    events1[1]?.at === report.finishedAt && events1[2]?.at === report.finishedAt
    && events1[3]?.at === c01FinishAt && events1[4]?.at === c01FinishAt
    && events1[5]?.at === c02FinishAt && events1[6]?.at === c02FinishAt)
  t('ARTIFACT_CREATED payloads name artifactId/path/kind/jobId/attemptNumber',
    eq(JSON.parse(events1[1]?.payload), {
      artifactId: 'run/report.json-68bcbb91f2647d56',
      path: 'C:\\swarm\\verify\\20261011022419\\report.json',
      kind: 'report', jobId: null, attemptNumber: null,
    })
    && eq(JSON.parse(events1[3]?.payload), {
      artifactId: artifactId('c01', null, 'C:\\swarm\\verify\\20261011022419\\c01\\diff.patch'),
      path: 'C:\\swarm\\verify\\20261011022419\\c01\\diff.patch',
      kind: 'diff', jobId: 'c01', attemptNumber: null,
    }))

  // ---------- T-006: the derived DAG matches the report's real fan-out ----------
  // Version bumped 4 -> 5 by T-016 (the artifact-store slice); each schema
  // slice moves this pinned assertion in its own change-set.
  t('SCHEMA_VERSION is 5', SCHEMA_VERSION === 5)
  // T-016: the table census — exactly the prior 9 tables + artifacts +
  // probe_runs. (Internal sqlite_* tables — sqlite_sequence exists because
  // `events` uses AUTOINCREMENT — are excluded from the census.)
  const tableNames = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((r) => r.name)
  t('fresh ingest materializes exactly 11 tables (the prior 9 + artifacts + probe_runs)',
    tableNames.length === 11
    && eq(tableNames, ['approval_gates', 'artifacts', 'attempts', 'candidates', 'events',
      'gate_results', 'job_dependencies', 'jobs', 'phases', 'probe_runs', 'runs']))
  t('artifacts columns are exactly the producer-narrowed set (media_type/lineage/metadata/retention_class omitted, not pre-defined)',
    eq(db.prepare('PRAGMA table_info(artifacts)').all().map((r) => r.name),
      ['run_id', 'artifact_id', 'kind', 'job_id', 'attempt_number', 'path', 'size_bytes', 'content_hash']))
  t('probe_runs columns are exactly the ProbeRunSummary shape (src/types.ts)',
    eq(db.prepare('PRAGMA table_info(probe_runs)').all().map((r) => r.name),
      ['run_id', 'job_id', 'probe_id', 'scenario_id', 'success', 'duration_ms', 'bundle_path']))
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
  t('re-ingest: events appended (a fresh deterministic block), prior rows untouched',
    events2.length === events1.length * 2
    && eq(events2.slice(0, events1.length), events1)
    && eq(events2.slice(events1.length).map((e) => [e.type, e.at, e.payload]), events1.map((e) => [e.type, e.at, e.payload])))
  t('re-ingest: phases unchanged (upsert)',
    count('phases') === 1 && eq(db.prepare('SELECT * FROM phases WHERE run_id = ?').get(report.runId), phase))
  t('re-ingest: jobs unchanged (upsert)',
    count('jobs') === report.candidates.length
    && eq(db.prepare('SELECT * FROM jobs WHERE run_id = ? ORDER BY job_id').all(report.runId), jobsBefore))
  t('re-ingest: job_dependencies still zero (edges re-derived)', count('job_dependencies') === 0)
  t('re-ingest: artifacts unchanged (upsert; hashes recompute from the files, which are immutable-by-convention)',
    eq(db.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(report.runId), artifactRows))
  t('re-ingest: probe_runs still zero', count('probe_runs') === 0)
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
  t('elimination emits RUN_CREATED, GATE_FAILED, CANDIDATE_ELIMINATED, then the artifact block',
    eq(elimEvents.slice(0, 3).map((e) => e.type), ['RUN_CREATED', 'GATE_FAILED', 'CANDIDATE_ELIMINATED'])
    && elimEvents.length === 9 && elimEvents.slice(3).every((e) => e.type === 'ARTIFACT_CREATED'))
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
    eq(retriedEvents.slice(0, 3).map((e) => e.type), ['RUN_CREATED', 'ATTEMPT_STARTED', 'ATTEMPT_STARTED'])
    && retriedEvents[1]?.at === attempt1.startedAt && retriedEvents[2]?.at === attempt2.startedAt)
  t('retried variant: ATTEMPT_STARTED payloads name the job, attempt id, and number',
    eq(JSON.parse(retriedEvents[1]?.payload), { jobId: rc.id, attemptId: attempt1.id, attemptNumber: 1 })
    && eq(JSON.parse(retriedEvents[2]?.payload), { jobId: rc.id, attemptId: attempt2.id, attemptNumber: 2 }))
  // T-016 on the retried variant: attempt-scoped rows carry their own
  // attempt number; the candidate's diffPath and review raw attribute the
  // FINAL attempt (src/types.ts: top-level fields are the FINAL attempt's
  // values) — so c01\diff.patch is TWO rows (attempt 1's outputArtifacts vs
  // the final attempt's diffPath), while c02 (no attempts array) stays
  // attempt-null. 10 rows: 2 run-level + 2 + 4 + 2.
  const retriedArtifacts = retriedDb.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(retried.runId)
  t('retried variant: 10 artifact rows — outputArtifacts are attempt-scoped, diffPath/review attribute the FINAL attempt, c02 stays attempt-null',
    retriedArtifacts.length === 10
    && retriedArtifacts.filter((r) => r.job_id === null && r.attempt_number === null).length === 2
    && retriedArtifacts.filter((r) => r.job_id === 'c01' && r.attempt_number === 1).length === 2
    && retriedArtifacts.filter((r) => r.job_id === 'c01' && r.attempt_number === 2).length === 4
    && retriedArtifacts.filter((r) => r.job_id === 'c02' && r.attempt_number === null).length === 2
    && retriedArtifacts.filter((r) => r.path === 'C:\\swarm\\verify\\20261011022419\\c01\\diff.patch').length === 2)
  t('retried variant: ARTIFACT_CREATED block after the attempt events, at report-carried stamps (final attempt endedAt for c01; the ladder derivation for c02; finishedAt for run-level)',
    retriedEvents.length === 13 && retriedEvents.slice(3).every((e) => e.type === 'ARTIFACT_CREATED')
    && retriedEvents[3]?.at === retried.finishedAt && retriedEvents[4]?.at === retried.finishedAt
    && retriedEvents.slice(5, 11).every((e) => e.at === attempt2.endedAt)
    && retriedEvents.slice(11).every((e) => e.at === new Date(Date.parse(retried.startedAt) + retried.candidates[1].workerDurationMs).toISOString()))
  const attemptRowsBefore = retriedDb.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY attempt_number').all(retried.runId)
  const retriedArtifactsBefore = retriedDb.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(retried.runId)
  const retriedEventsBefore = retriedDb.prepare('SELECT seq, type, at, payload FROM events ORDER BY seq').all()
  retriedDb.close()

  // re-ingest of the retried variant: attempt rows idempotent, events append-only
  ingest(retried, retriedDbPath)
  const retriedDb2 = new DatabaseSync(retriedDbPath)
  t('retried re-ingest: attempt rows unchanged (upsert by natural key)',
    eq(retriedDb2.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY attempt_number').all(retried.runId), attemptRowsBefore))
  t('retried re-ingest: artifacts unchanged (upsert by natural key; hashes recompute identically)',
    eq(retriedDb2.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(retried.runId), retriedArtifactsBefore))
  const retriedEventsAfter = retriedDb2.prepare('SELECT seq, type, at, payload FROM events ORDER BY seq').all()
  t('retried re-ingest: events appended (a fresh deterministic block), prior rows untouched',
    retriedEventsAfter.length === retriedEventsBefore.length * 2
    && eq(retriedEventsAfter.slice(0, retriedEventsBefore.length), retriedEventsBefore)
    && eq(retriedEventsAfter.slice(retriedEventsBefore.length).map((e) => e.type), retriedEventsBefore.map((e) => e.type)))
  t('retried re-ingest: integrity_check ok', retriedDb2.prepare('PRAGMA integrity_check').get()['integrity_check'] === 'ok')
  retriedDb2.close()

  // ---------- T-009: a schedule-carrying report — the real multi-phase DAG ----------
  // Hand-built DAG variant of the fixture (the elim-variant pattern): two
  // real phases, foundation -> app with the expanded edge c02 -> c01; c02
  // fails its gates, so phase `app` is 'failed' and PHASE_COMPLETED derives
  // for `foundation` only. Pins the phases/jobs/job_dependencies rows, the
  // derived schedule events with report-carried stamps (never Date.now()),
  // and re-ingest idempotency with append-only events.
  const dag = structuredClone(report)
  dag.schedule = {
    phases: [
      { id: 'foundation', dependencies: [], completion: 'all', status: 'completed' },
      { id: 'app', dependencies: ['foundation'], completion: 'all', status: 'failed' },
    ],
    jobs: [
      { id: 'c01', phaseId: 'foundation', dependencies: [], dispatchIndex: 0 },
      { id: 'c02', phaseId: 'app', dependencies: ['c01'], dispatchIndex: 1 },
    ],
  }
  const dagVictim = dag.candidates[1]
  dagVictim.gates[0].passed = false
  dagVictim.gates[0].exitCode = 1
  dagVictim.passedAllGates = false
  const dagDbPath = join(sandbox, 'scheduled.db')
  ingest(dag, dagDbPath)
  const dagDb = new DatabaseSync(dagDbPath)
  const dagPhases = dagDb.prepare('SELECT * FROM phases WHERE run_id = ? ORDER BY phase_id').all(dag.runId)
  t('scheduled variant: two phase rows with the real ids',
    dagPhases.length === 2 && dagPhases[0]?.phase_id === 'app' && dagPhases[1]?.phase_id === 'foundation')
  t('scheduled variant: phase dependencies copied and completion policy recorded (its first producer)',
    eq(JSON.parse(dagPhases[0]?.dependencies_json), ['foundation']) && dagPhases[0]?.completion === 'all'
    && eq(JSON.parse(dagPhases[1]?.dependencies_json), []) && dagPhases[1]?.completion === 'all')
  t('scheduled variant: phase policy columns without producers stay null',
    dagPhases.every((p) => p.early_stop_json == null && p.approval_gate_json == null))
  for (const c of dag.candidates) {
    const job = dagDb.prepare('SELECT * FROM jobs WHERE run_id = ? AND job_id = ?').get(dag.runId, c.id)
    const expectedPhase = c.id === 'c01' ? 'foundation' : 'app'
    const expectedDeps = c.id === 'c01' ? [] : ['c01']
    t(`scheduled variant: ${c.id} job row carries its real phase and edges`,
      job?.phase_id === expectedPhase && eq(JSON.parse(job?.dependencies_json), expectedDeps)
      && job?.worker_id === c.workerId && job?.model === c.model && job?.brief === c.brief)
  }
  const dagEdges = dagDb.prepare('SELECT job_id, depends_on_job_id FROM job_dependencies WHERE run_id = ? ORDER BY job_id').all(dag.runId)
  t('scheduled variant: exactly one real dependency edge (c02 -> c01)',
    dagEdges.length === 1 && dagEdges[0]?.job_id === 'c02' && dagEdges[0]?.depends_on_job_id === 'c01')

  const dagEvents = dagDb.prepare('SELECT seq, type, at, payload FROM events ORDER BY seq').all()
  t('scheduled variant: per-candidate block first, then the schedule block in schedule order, then the artifact block',
    eq(dagEvents.slice(0, 8).map((e) => e.type), [
      'RUN_CREATED', 'GATE_FAILED', 'CANDIDATE_ELIMINATED',
      'JOB_READY', 'JOB_SUCCEEDED', 'JOB_READY', 'JOB_FAILED', 'PHASE_COMPLETED',
    ])
    && dagEvents.length === 14 && dagEvents.slice(8).every((e) => e.type === 'ARTIFACT_CREATED'))
  const startedAt = dag.startedAt
  const c01At = new Date(Date.parse(startedAt) + dag.candidates[0].workerDurationMs).toISOString()
  const c02At = new Date(Date.parse(startedAt) + dagVictim.workerDurationMs).toISOString()
  const [readyC01, okC01, readyC02, failC02, phaseDone] = dagEvents.slice(3)
  t('scheduled variant: JOB_READY at the max of the dependencies\' finish stamps (startedAt for dependency-free)',
    readyC01?.at === startedAt && readyC02?.at === c01At)
  t('scheduled variant: JOB_SUCCEEDED/JOB_FAILED at each job\'s own finish stamp (startedAt + worker duration)',
    okC01?.at === c01At && failC02?.at === c02At)
  t('scheduled variant: PHASE_COMPLETED only for the completed phase, at its max job finish stamp',
    phaseDone?.type === 'PHASE_COMPLETED' && phaseDone?.at === c01At)
  t('scheduled variant: schedule event payloads name job and phase',
    eq(JSON.parse(readyC01?.payload), { jobId: 'c01', phaseId: 'foundation' })
    && eq(JSON.parse(okC01?.payload), { jobId: 'c01', phaseId: 'foundation' })
    && eq(JSON.parse(readyC02?.payload), { jobId: 'c02', phaseId: 'app' })
    && eq(JSON.parse(failC02?.payload), { jobId: 'c02', phaseId: 'app' })
    && eq(JSON.parse(phaseDone?.payload), { phaseId: 'foundation' }))
  const dagPhasesBefore = dagPhases
  const dagJobsBefore = dagDb.prepare('SELECT * FROM jobs WHERE run_id = ? ORDER BY job_id').all(dag.runId)
  const dagEdgesBefore = dagEdges
  const dagEventsBefore = dagEvents
  dagDb.close()

  // re-ingest of the scheduled variant: DAG rows idempotent, events append-only
  ingest(dag, dagDbPath)
  const dagDb2 = new DatabaseSync(dagDbPath)
  t('scheduled re-ingest: phases/jobs/job_dependencies idempotent',
    eq(dagDb2.prepare('SELECT * FROM phases WHERE run_id = ? ORDER BY phase_id').all(dag.runId), dagPhasesBefore)
    && eq(dagDb2.prepare('SELECT * FROM jobs WHERE run_id = ? ORDER BY job_id').all(dag.runId), dagJobsBefore)
    && eq(dagDb2.prepare('SELECT job_id, depends_on_job_id FROM job_dependencies WHERE run_id = ? ORDER BY job_id').all(dag.runId), dagEdgesBefore))
  const dagEventsAfter = dagDb2.prepare('SELECT seq, type, at, payload FROM events ORDER BY seq').all()
  t('scheduled re-ingest: events appended (a fresh deterministic block), prior rows untouched',
    dagEventsAfter.length === dagEventsBefore.length * 2
    && eq(dagEventsAfter.slice(0, dagEventsBefore.length), dagEventsBefore)
    && eq(dagEventsAfter.slice(dagEventsBefore.length).map((e) => [e.type, e.at, e.payload]),
      dagEventsBefore.map((e) => [e.type, e.at, e.payload])))
  t('scheduled re-ingest: integrity_check ok', dagDb2.prepare('PRAGMA integrity_check').get()['integrity_check'] === 'ok')
  dagDb2.close()

  // ---------- T-016: probes variant — probe_runs rows + bundle artifacts ----------
  // Hand-built (the elim-variant pattern): c01 gains a one-attempt history
  // and two probe summaries pointing at sandbox-local bundle files written
  // here; c02 keeps the fixture shape. Pins the probe_runs rows
  // field-for-field (ProbeRunSummary, src/types.ts), the matching
  // probe-bundle artifacts rows (the bundle is the addressable evidence
  // unit — its internal .log files get no row), the final-attempt
  // attribution of the candidate-scoped rows, and exact sandbox-local hash
  // values.
  const probed = structuredClone(report)
  const pc = probed.candidates[0]
  const pBundleDir = join(sandbox, 'probe-bundles')
  mkdirSync(pBundleDir, { recursive: true })
  const bundle1Path = join(pBundleDir, 'p1.json')
  const bundle2Path = join(pBundleDir, 'p2.json')
  const bundle1Content = JSON.stringify({ probeId: 'p1', scenarioId: 'p1', success: true, artifacts: [], measurements: [], gateResults: [] }, null, 2)
  const bundle2Content = JSON.stringify({ probeId: 'p2', scenarioId: 'p2', success: false, artifacts: [], measurements: [], gateResults: [], error: 'command exited 3' }, null, 2)
  writeFileSync(bundle1Path, bundle1Content)
  writeFileSync(bundle2Path, bundle2Content)
  pc.attempts = [{
    id: `${pc.id}-a1`, jobId: pc.id, number: 1, state: 'succeeded',
    startedAt: '2026-10-11T02:24:20.500Z', endedAt: '2026-10-11T02:24:53.000Z',
    inputContextHash: hashA, promptVersion: null,
    outputArtifacts: ['C:\\swarm\\verify\\20261011022419\\c01\\worker.log'],
  }]
  pc.probes = [
    { probeId: 'p1', scenarioId: 'p1', success: true, durationMs: 1234, bundlePath: bundle1Path },
    { probeId: 'p2', scenarioId: 'p2', success: false, durationMs: 4321, bundlePath: bundle2Path },
  ]
  const probedDbPath = join(sandbox, 'probed.db')
  ingest(probed, probedDbPath)
  const probedDb = new DatabaseSync(probedDbPath)
  t('probes variant: one probe_runs row per summary',
    probedDb.prepare('SELECT COUNT(*) AS n FROM probe_runs').get().n === 2)
  for (const p of pc.probes) {
    const row = probedDb.prepare('SELECT * FROM probe_runs WHERE run_id = ? AND job_id = ? AND probe_id = ?')
      .get(probed.runId, pc.id, p.probeId)
    t(`probes variant: probe_runs row for ${p.probeId} matches the summary field-for-field (success as 1|0)`,
      row?.scenario_id === p.scenarioId && row?.success === (p.success ? 1 : 0)
      && row?.duration_ms === p.durationMs && row?.bundle_path === p.bundlePath)
    const bundleRow = probedDb.prepare('SELECT * FROM artifacts WHERE run_id = ? AND job_id = ? AND path = ?')
      .get(probed.runId, pc.id, p.bundlePath)
    const expectedBundle = p.probeId === 'p1' ? bundle1Content : bundle2Content
    t(`probes variant: ${p.probeId} bundle has a matching artifacts row (kind report, FINAL attempt, exact sandbox hash)`,
      bundleRow?.kind === 'report' && bundleRow?.attempt_number === 1
      && bundleRow?.size_bytes === Buffer.byteLength(expectedBundle)
      && bundleRow?.content_hash === createHash('sha256').update(expectedBundle).digest('hex'))
  }
  const probedArtifacts = probedDb.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(probed.runId)
  t('probes variant: 9 artifact rows (6 fixture + attempt worker.log + 2 bundles); diffPath and review attribute the FINAL attempt (1), c02 stays attempt-null',
    probedArtifacts.length === 9
    && probedArtifacts.filter((r) => r.path === 'C:\\swarm\\verify\\20261011022419\\c01\\diff.patch'
      && r.attempt_number === 1).length === 1
    && probedArtifacts.filter((r) => r.path === 'C:\\swarm\\verify\\20261011022419\\c01\\review-raw.txt'
      && r.attempt_number === 1).length === 1
    && probedArtifacts.filter((r) => r.job_id === 'c02' && r.attempt_number === null).length === 2
    && probedArtifacts.filter((r) => r.job_id === null && r.attempt_number === null).length === 2)
  t('probes variant: no .log artifact row inside the bundles (the bundle is the addressable unit)',
    probedArtifacts.every((r) => !r.path.includes('probes') || r.path.endsWith('.json')))
  t('probes variant: integrity_check ok', probedDb.prepare('PRAGMA integrity_check').get()['integrity_check'] === 'ok')
  probedDb.close()

  // ---------- T-016: hash-at-ingest, pinned on a controlled sandbox variant ----------
  // A hand-built report whose named evidence files live in the sandbox with
  // controlled content; c02's diff is named but never written (the
  // missing-file case). Exact sizes/hashes are pinned HERE only.
  const hashDir = join(sandbox, 'hashrun')
  mkdirSync(join(hashDir, 'c01'), { recursive: true })
  mkdirSync(join(hashDir, 'c02'), { recursive: true })
  const hashFiles = {
    planner: { path: join(hashDir, 'planner-raw.txt'), content: '["brief one","brief two"]\n' },
    workerLog: { path: join(hashDir, 'c01', 'worker.log'), content: 'worker log line one\nworker log line two\n' },
    diff: { path: join(hashDir, 'c01', 'diff.patch'), content: 'diff --git a/calc.js b/calc.js\n--- a/calc.js\n+++ b/calc.js\n@@ -1 +1 @@\n-old\n+new\n' },
    reviewRaw: { path: join(hashDir, 'c01', 'review-raw.txt'), content: '{"observations":[]}\n' },
  }
  const hashMissingDiff = join(hashDir, 'c02', 'diff.patch')
  const hashReport = {
    runId: '20261016000001',
    repo: 'C:\\swarm\\demo-target',
    baseSha: '4eabbb245b7f876b04fd4828dd729c7c624ddbe3',
    goal: 'hash-at-ingest sandbox',
    model: 'zai-coding-plan/glm-5.3-flash',
    planner: { model: 'zai-coding-plan/glm-5.3', ok: true, attempts: 1, durationMs: 5, briefs: ['b1'], fallbackUsed: false, rawOutputPath: hashFiles.planner.path },
    startedAt: '2026-10-16T10:00:00.000Z',
    finishedAt: '2026-10-16T10:01:00.000Z',
    candidates: [
      {
        id: 'c01', workerId: 'opencode', model: 'zai-coding-plan/glm-5.3-flash', brief: 'b1',
        workspacePath: null, workerOk: true, workerTimedOut: false, workerDurationMs: 1000,
        diffPath: hashFiles.diff.path, diffBytes: Buffer.byteLength(hashFiles.diff.content),
        gates: [{ name: 'build', passed: true, exitCode: 0, durationMs: 10, outputTail: 'ok' }],
        passedAllGates: true,
        attempts: [{
          id: 'c01-a1', jobId: 'c01', number: 1, state: 'succeeded',
          startedAt: '2026-10-16T10:00:01.000Z', endedAt: '2026-10-16T10:00:02.000Z',
          inputContextHash: hashA, promptVersion: null,
          outputArtifacts: [hashFiles.workerLog.path, hashFiles.diff.path],
        }],
        review: { ok: true, attempts: 1, model: 'zai-coding-plan/glm-5.3', observations: [], rawOutputPath: hashFiles.reviewRaw.path },
      },
      {
        id: 'c02', workerId: 'opencode', model: 'zai-coding-plan/glm-5.3-flash', brief: 'b2',
        workspacePath: null, workerOk: true, workerTimedOut: false, workerDurationMs: 4567,
        diffPath: hashMissingDiff, diffBytes: 12,
        gates: [], passedAllGates: false,
        attempts: [],
      },
    ],
  }
  const hashReportPath = join(hashDir, 'report.json')
  writeFileSync(hashReportPath, JSON.stringify(hashReport, null, 2))
  for (const f of Object.values(hashFiles)) writeFileSync(f.path, f.content)
  const hashEvidenceShaBefore = Object.fromEntries([
    ...Object.values(hashFiles).map((f) => [f.path, sha256(f.path)]),
    [hashReportPath, sha256(hashReportPath)],
  ])
  const hashDbPath = join(sandbox, 'hash.db')
  ingest(hashReport, hashDbPath)
  const hashDb = new DatabaseSync(hashDbPath)
  const hashRows = hashDb.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(hashReport.runId)
  t('hash sandbox: 6 rows — report.json, planner raw, worker.log, the deduped diff (named by diffPath AND outputArtifacts), review raw, c02 missing diff',
    hashRows.length === 6
    && hashRows.filter((r) => r.path === hashFiles.diff.path).length === 1)
  for (const [label, f] of [['report.json', { path: hashReportPath }], ...Object.entries(hashFiles)]) {
    const row = hashDb.prepare('SELECT * FROM artifacts WHERE run_id = ? AND path = ?').get(hashReport.runId, f.path)
    t(`hash sandbox: ${label} size/hash equal the controlled content`,
      row?.size_bytes === Buffer.byteLength(readFileSync(f.path))
      && row?.content_hash === sha256(f.path))
  }
  t('hash sandbox: a report-named path with no file on disk records NULL for both — never fabricated (AGENTS.md #7)',
    hashRows.some((r) => r.path === hashMissingDiff && r.size_bytes === null && r.content_hash === null))
  t('hash sandbox: read-only over evidence — every controlled file byte-identical after ingestion',
    Object.entries(hashEvidenceShaBefore).every(([p, h]) => sha256(p) === h))
  const hashRowsBefore = hashRows
  const hashEvents = hashDb.prepare('SELECT type, at, payload FROM events ORDER BY seq').all()
  t('hash sandbox: RUN_CREATED, ATTEMPT_STARTED (c01 carries an attempt), CANDIDATE_ELIMINATED (c02 has no gates), then the artifact block',
    hashEvents.length === 9 && hashEvents[0]?.type === 'RUN_CREATED'
    && hashEvents[1]?.type === 'ATTEMPT_STARTED' && hashEvents[2]?.type === 'CANDIDATE_ELIMINATED'
    && hashEvents.slice(3).every((e) => e.type === 'ARTIFACT_CREATED'))
  t('hash sandbox: ARTIFACT_CREATED at the shared finish-stamp derivation — finishedAt for run-level; the final attempt endedAt (10:00:02, NOT the 10:00:01 ladder derivation) for c01; the ladder derivation for attempt-less c02',
    hashEvents[3]?.at === hashReport.finishedAt && hashEvents[4]?.at === hashReport.finishedAt
    && hashEvents.slice(5, 8).every((e) => e.at === '2026-10-16T10:00:02.000Z')
    && hashEvents[8]?.at === new Date(Date.parse(hashReport.startedAt) + 4567).toISOString())
  t('hash sandbox: ARTIFACT_CREATED payload for the missing-file row still records the path verbatim (hash absent, never invented)',
    eq(JSON.parse(hashEvents[8]?.payload), {
      artifactId: artifactId('c02', null, hashMissingDiff),
      path: hashMissingDiff,
      kind: 'diff', jobId: 'c02', attemptNumber: null,
    }))
  ingest(hashReport, hashDbPath)
  t('hash sandbox: re-ingest leaves every artifacts row byte-identical (ids stable, hashes recompute identically)',
    eq(hashDb.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(hashReport.runId), hashRowsBefore))
  t('hash sandbox: re-ingest appends a fresh deterministic block (events double, content identical)',
    eq(hashDb.prepare('SELECT type, at, payload FROM events ORDER BY seq').all().slice(9).map((e) => [e.type, e.at, e.payload]),
      hashEvents.map((e) => [e.type, e.at, e.payload])))
  t('hash sandbox: integrity_check ok', hashDb.prepare('PRAGMA integrity_check').get()['integrity_check'] === 'ok')
  hashDb.close()

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
