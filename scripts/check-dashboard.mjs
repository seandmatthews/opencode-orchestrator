// Dashboard self-check (Gate 1.23, fast tier, T-034) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-dashboard.mjs
// Pins the read-only HTTP dashboard (src/dashboard.ts) against the vendored
// fixture (scripts/fixtures/report-real.json) ingested into fresh temp DBs
// (the Gate 1.6/1.9 pattern), stdlib `fetch` driving the server on an
// ephemeral localhost port (the T-024 WebProbe client precedent) — zero
// model tokens. Pins: the run list with derived survivor/eliminated counts
// labeled ingested post-hoc, the per-run page (candidates, gate results,
// artifact pointers with nulls rendered as missing, probe runs) equal to the
// temp DB's rows, the DAG section cross-checked against src/dag.ts's own
// read of the same DB (via `dag --json`, the Gate 1.7 surface), the
// approvals page equal to a direct `listPendingApprovals` call, the decide
// POST flipping rows through the real `decideApproval` (one
// APPROVAL_GRANTED/APPROVAL_REJECTED event each, queue updates) with every
// store refusal surfacing as HTTP 4xx carrying the refusal message and
// nothing written, byte-identity of the DB across ALL GET routes (the
// decide POST is expected to mutate and is outside the set), the startup
// refusal for a missing DB file (never creating one), and the zero-new-
// npm-dependencies pin (package.json dependency blocks unchanged).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { ingest, listPendingApprovals, requestApproval } from '../src/store/index.ts'

// The dashboard module is imported DYNAMICALLY, with console.log wrapped:
// importing src/dashboard.ts must start NO server (a module-level main() —
// observed once at authoring and fixed with the entry-module guard — bound
// the DEFAULT store C:\swarm\refinery.db inside this check's own process;
// the banner line is its telltale).
let importBanner = ''
const origLog = console.log.bind(console)
console.log = (...args) => {
  importBanner += args.map(String).join(' ') + '\n'
  origLog(...args)
}
const { startDashboard } = await import('../src/dashboard.ts')
console.log = origLog
console.log(`${importBanner.includes('dashboard: http://') ? 'FAIL' : 'ok'}: importing src/dashboard.ts starts no server (no startup banner, no default-store side effect)`)
if (importBanner.includes('dashboard: http://')) failures.push('importing src/dashboard.ts starts no server')

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1
// ISO-8601 wall-clock, NOT report-derived (the report is dated 2026-10-11).
const isWallClock = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s))
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s) && s !== report.startedAt

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const dashboardTs = join(root, 'src', 'dashboard.ts')
const fixturePath = join(root, 'scripts', 'fixtures', 'report-real.json')
const report = JSON.parse(readFileSync(fixturePath, 'utf8'))

// The dashboard CLI as a subprocess — for the flag/usage faces and the
// missing-DB startup refusal (which exits; the server faces below drive the
// same module in-process over an ephemeral port, so no long-running
// subprocess tree has to be spawned and reaped).
const runDashboardCli = (args) => {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [tsxCli, dashboardTs, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message) }
  }
}
// src/dag.ts's own read of a DB — the cross-check surface for the run page's
// DAG section (the ticket: "cross-check against src/dag.ts's read of the
// same file").
const runDagCli = (dbPath, runId) => {
  const out = execFileSync(process.execPath, [tsxCli, join(root, 'src', 'dag.ts'), '--run', runId, '--db', dbPath, '--json'], { encoding: 'utf8', windowsHide: true })
  return JSON.parse(out)
}

const startServer = async (dbPath, port) => {
  const server = await startDashboard(port === undefined ? { db: dbPath } : { db: dbPath, port })
  const addr = server.address()
  return { server, base: `http://127.0.0.1:${addr.port}`, addr }
}
const stopServer = async (server) => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
const get = async (base, path) => {
  const res = await fetch(base + path)
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() }
}
const postForm = async (base, fields) => {
  const res = await fetch(`${base}/approvals/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  return { status: res.status, body: await res.text() }
}

const openDb = (p) => new DatabaseSync(p, { readOnly: true })
const survivorsIn = (db, runId) => db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE run_id = ? AND passed_all_gates = 1').get(runId).n
const eliminatedIn = (db, runId) => db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE run_id = ? AND passed_all_gates = 0').get(runId).n

// The DAG section of a run page must render exactly the structure
// src/dag.ts reads over the same DB (its phases, jobs, and edges — the
// Gate 1.7 --json shape), count lines included.
const depsTxt = (deps) => deps.length === 0 ? '(none)' : deps.join(', ')
const assertDagSection = (body, dump, label) => {
  let good = body.includes(`phases (${dump.phases.length}):`)
    && body.includes(`jobs (${dump.jobs.length}):`)
    && body.includes(`edges (${dump.edges.length}):`)
  for (const p of dump.phases) {
    good = good && body.includes(`<li>${p.phaseId} &mdash; dependencies: ${depsTxt(p.dependencies)}</li>`)
  }
  for (const j of dump.jobs) {
    good = good && body.includes(`<li>${j.jobId} (phase ${j.phaseId}, worker ${j.workerId}, model ${j.model}) &mdash; dependencies: ${depsTxt(j.dependencies)}</li>`)
  }
  for (const e of dump.edges) {
    good = good && body.includes(`<li>${e.jobId} -&gt; ${e.dependsOnJobId}</li>`)
  }
  t(`${label}: the DAG section renders exactly src/dag.ts's read of the same DB (cross-checked via dag --json)`, good)
}

// The ticket's hand-built variants (the Gate 1.9 elim-variant pattern):
const sched = structuredClone(report)
sched.schedule = {
  phases: [
    { id: 'foundation', dependencies: [], completion: 'all', status: 'completed' },
    { id: 'app', dependencies: ['foundation'], completion: 'all', status: 'completed' },
  ],
  jobs: [
    { id: 'c01', phaseId: 'foundation', dependencies: [], dispatchIndex: 0 },
    { id: 'c02', phaseId: 'app', dependencies: ['c01'], dispatchIndex: 1 },
  ],
}
const elimSched = structuredClone(sched)
const elimVictim = elimSched.candidates[1]
elimVictim.gates[0].passed = false
elimVictim.gates[0].exitCode = 1
elimVictim.passedAllGates = false
elimSched.schedule.phases[1].status = 'failed'

const approvalSnapshot = (db) => ({
  rows: db.prepare('SELECT * FROM approval_gates ORDER BY run_id, phase_id, job_id').all(),
  events: db.prepare('SELECT seq, type, at, payload FROM events ORDER BY seq').all(),
})

const sandbox = mkdtempSync(join(tmpdir(), 't034-dashboard-'))
try {
  // ---------- AC: zero new npm dependencies ----------
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  t('package.json: gains exactly the one dashboard script', pkg.scripts.dashboard === 'tsx src/dashboard.ts')
  t('package.json: dependencies unchanged (zero new npm dependencies)', eq(pkg.dependencies, { 'opencode-ai': '^1.18.35' }))
  t('package.json: devDependencies unchanged', eq(pkg.devDependencies, { '@types/node': '^26.6.5', 'tsx': '^4.23.15', 'typescript': '^7.0.2' }))

  // ---------- AC1: CLI faces — usage, missing-DB startup refusal, --port ----------
  const help = runDashboardCli(['--help'])
  t(`dashboard --help exits 0 (got ${help.code})`, help.code === 0)
  t('usage documents --port', help.stdout.includes('--port <port>'))
  t('usage documents --db with its default C:\\swarm\\refinery.db', help.stdout.includes('--db <path>') && help.stdout.includes('C:\\swarm\\refinery.db'))

  const absentDb = join(sandbox, 'absent.db')
  const noDb = runDashboardCli(['--db', absentDb])
  t(`a missing DB file refuses startup with exit non-zero (got ${noDb.code})`, noDb.code !== 0)
  t('missing DB: the refusal names the path and is a startup refusal', noDb.stderr.includes(absentDb) && /no database at /.test(noDb.stderr))
  t('missing DB: nothing on stdout', noDb.stdout.trim() === '')
  t('missing DB: no refinery.db created as a side effect', !existsSync(absentDb))

  // ---------- the main fixture DB ----------
  const dbMainPath = join(sandbox, 'main.db')
  ingest(report, dbMainPath)
  const dbMain = openDb(dbMainPath)

  const badPort = runDashboardCli(['--port', 'not-a-port', '--db', dbMainPath])
  t(`--port with a non-integer refuses (got ${badPort.code})`, badPort.code !== 0 && /--port/.test(badPort.stderr))
  const zeroPort = runDashboardCli(['--port', '0', '--db', dbMainPath])
  t(`--port 0 refuses (1..65535) (got ${zeroPort.code})`, zeroPort.code !== 0 && /--port/.test(zeroPort.stderr))

  // An explicit --port is honored (the free port is claimed just before use —
  // the standard ephemeral-port race, acceptable for a loopback check).
  const freePort = await new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
    s.on('error', reject)
  })
  const explicit = await startServer(dbMainPath, freePort)
  t('the server binds 127.0.0.1 only', explicit.addr.address === '127.0.0.1')
  t('an explicit --port is honored', explicit.addr.port === freePort)

  // ---------- AC2: GET / — the run list, counts derived from the DB ----------
  const list0 = await get(explicit.base, '/')
  t(`GET / exits 200 (got ${list0.status})`, list0.status === 200)
  t('GET / serves HTML', list0.contentType.startsWith('text/html'))
  const dbRunList = dbMain.prepare('SELECT run_id, repo, base_sha, goal, model, started_at, finished_at FROM runs WHERE run_id = ?').get(report.runId)
  t('run list: renders the ingested fixture run id', list0.body.includes(report.runId))
  t('run list: repo/base_sha/goal/model/date fields equal the runs row',
    list0.body.includes(dbRunList.repo) && list0.body.includes(dbRunList.base_sha)
    && list0.body.includes(dbRunList.goal) && list0.body.includes(dbRunList.model)
    && list0.body.includes(dbRunList.started_at) && list0.body.includes(dbRunList.finished_at))
  const survivors = survivorsIn(dbMain, report.runId)
  const eliminated = eliminatedIn(dbMain, report.runId)
  t(`run list: survivor/eliminated counts equal the candidates.passed_all_gates rows (${survivors} survivor(s), ${eliminated} eliminated)`,
    list0.body.includes(`${survivors} survivor(s) &middot; ${eliminated} eliminated`))
  t('run list: labeled as ingested post-hoc state — never live',
    list0.body.includes('ingested post-hoc state') && list0.body.includes('never live'))

  // ---------- AC3: GET /run/<id> — candidates, gates, artifact pointers, DAG ----------
  const shaMain0 = sha256(dbMainPath)
  const runPage = await get(explicit.base, `/run/${report.runId}`)
  t(`GET /run/<id> exits 200 (got ${runPage.status})`, runPage.status === 200)
  const candRows = dbMain.prepare('SELECT candidate_id, worker_id, model, passed_all_gates, worker_ok, diff_bytes FROM candidates WHERE run_id = ? ORDER BY candidate_id').all(report.runId)
  t('run page: renders every candidate id', candRows.every((c) => runPage.body.includes(`<td>${c.candidate_id}</td><td>${c.worker_id}</td><td>${c.model}</td>`)))
  t('run page: renders each candidate verdict from passed_all_gates',
    candRows.every((c) => runPage.body.includes(`<td>${c.passed_all_gates === 1 ? 'survivor' : 'eliminated'}</td>`)))
  const gateRows = dbMain.prepare('SELECT candidate_id, gate_name, passed, exit_code, duration_ms FROM gate_results WHERE run_id = ? ORDER BY candidate_id, gate_name').all(report.runId)
  t('run page: every gate row renders name/pass/exit/duration equal to the DB row',
    gateRows.every((g) => runPage.body.includes(
      `<td>${g.candidate_id}</td><td>${g.gate_name}</td><td>${g.passed === 1 ? 'pass' : 'FAIL'}</td>`
      + `<td>${g.exit_code === null ? 'missing' : String(g.exit_code)}</td><td>${g.duration_ms} ms</td>`)))
  const artifactRows = dbMain.prepare('SELECT artifact_id, kind, job_id, attempt_number, path, size_bytes, content_hash FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(report.runId)
  t('run page: every artifact evidence pointer renders equal to the DB row (null renders as missing, never fabricated)',
    artifactRows.length > 0 && artifactRows.every((a) => runPage.body.includes(
      `<td>${a.artifact_id}</td><td>${a.kind}</td><td>${a.job_id ?? 'missing'}</td>`
      + `<td>${a.attempt_number ?? 'missing'}</td><td>${a.path}</td>`
      + `<td>${a.size_bytes ?? 'missing'}</td><td>${a.content_hash ?? 'missing'}</td>`)))
  t('main fixture run page: the flat derived DAG renders (one main phase, one job per candidate, zero edges)',
    runPage.body.includes('phases (1):') && runPage.body.includes(`jobs (${report.candidates.length}):`) && runPage.body.includes('edges (0):'))
  assertDagSection(runPage.body, runDagCli(dbMainPath, report.runId), 'main fixture')

  const unknownRun = await get(explicit.base, '/run/19990101000000')
  t(`GET /run/<unknown> exits 404 (got ${unknownRun.status})`, unknownRun.status === 404)
  t('unknown run: the page carries the refusal message', unknownRun.body.includes(`no recorded run '19990101000000'`))

  // ---------- read-only proof: the DB is byte-identical across ALL GET routes ----------
  const list1 = await get(explicit.base, '/')
  const approvals0 = await get(explicit.base, '/approvals')
  t(`GET /approvals exits 200 on an approval-less DB (got ${approvals0.status})`, approvals0.status === 200)
  t('approvals page: an empty queue says so', approvals0.body.includes('no pending approvals'))
  t(`DB byte-identical across ALL GET routes (/, /run/<id>, /approvals, 404, / again)`, sha256(dbMainPath) === shaMain0)
  await stopServer(explicit.server)

  // ---------- AC3: the hand-built schedule+approval variant (phases/jobs/edges + queue) ----------
  const dbSchedPath = join(sandbox, 'scheduled.db')
  ingest(sched, dbSchedPath)
  const seeded = requestApproval(dbSchedPath, { runId: sched.runId, by: 'gate-operator', note: 'ready for review' })
  const pendingDirect = listPendingApprovals(dbSchedPath)
  t('scheduled variant: the store itself holds two pending rows after requestApproval',
    seeded.length === 2 && pendingDirect.length === 2)

  const shaSched0 = sha256(dbSchedPath)
  const schedSrv = await startServer(dbSchedPath)
  const schedPage = await get(schedSrv.base, `/run/${sched.runId}`)
  t(`scheduled variant run page exits 200 (got ${schedPage.status})`, schedPage.status === 200)
  assertDagSection(schedPage.body, runDagCli(dbSchedPath, sched.runId), 'scheduled variant')
  t('scheduled variant: the page renders the real two-phase structure and its one expanded edge',
    schedPage.body.includes('<li>foundation &mdash; dependencies: (none)</li>')
    && schedPage.body.includes('<li>app &mdash; dependencies: foundation</li>')
    && schedPage.body.includes('<li>c02 -&gt; c01</li>'))

  // ---------- AC4: GET /approvals renders exactly listPendingApprovals's rows ----------
  const approvalsPage = await get(schedSrv.base, '/approvals')
  t(`GET /approvals exits 200 (got ${approvalsPage.status})`, approvalsPage.status === 200)
  const pendingRowString = (r) => `<tr><td>${r.runId}</td><td>${r.phaseId}</td><td>${r.jobId}</td><td>${r.state}</td><td>${r.requestedAt}</td><td>${r.requestedBy}</td></tr>`
  t('approvals page: renders exactly listPendingApprovals\'s rows (every row, no others)',
    pendingDirect.every((r) => approvalsPage.body.includes(pendingRowString(r)))
    && countOccurrences(approvalsPage.body, '<td>waiting_for_approval</td>') === pendingDirect.length)
  const shaSchedAfterGets = sha256(dbSchedPath)
  t('scheduled DB byte-identical across its GET routes', shaSchedAfterGets === shaSched0)

  // ---------- AC5: POST /approvals/decide — the only write, through decideApproval ----------
  const dbSched = new DatabaseSync(dbSchedPath)
  const verdictsBeforeDecides = {
    candidates: dbSched.prepare('SELECT * FROM candidates ORDER BY candidate_id').all(),
    gateResults: dbSched.prepare('SELECT * FROM gate_results ORDER BY candidate_id, gate_name').all(),
  }
  const approve = await postForm(schedSrv.base, { run: sched.runId, job: 'c01', decision: 'approved', by: 'dash-operator', note: 'looks good' })
  t(`POST decide approved exits 200 (got ${approve.status})`, approve.status === 200)
  const approvedRow = dbSched.prepare('SELECT * FROM approval_gates WHERE job_id = ?').get('c01')
  t('approved: the row flipped through the real decideApproval (state approved, decided_at/decided_by recorded, note kept)',
    approvedRow?.state === 'approved' && isWallClock(approvedRow?.decided_at) && approvedRow?.decided_by === 'dash-operator'
    && approvedRow?.note === 'looks good')
  const grantedEvents = dbSched.prepare('SELECT * FROM events WHERE type = ? ORDER BY seq').all('APPROVAL_GRANTED')
  t('approved: exactly one APPROVAL_GRANTED event, at the row stamp, payload naming phase/job/decider',
    grantedEvents.length === 1 && grantedEvents[0].at === approvedRow?.decided_at
    && eq(JSON.parse(grantedEvents[0].payload), { phaseId: 'foundation', jobId: 'c01', decidedBy: 'dash-operator' }))
  const queueAfterApprove = await get(schedSrv.base, '/approvals')
  t('after approve, the decided row drops out of the rendered queue (c02 still pending)',
    !queueAfterApprove.body.includes(pendingRowString({ ...pendingDirect.find((r) => r.jobId === 'c01'), state: 'waiting_for_approval' }))
    && queueAfterApprove.body.includes('<td>c02</td><td>waiting_for_approval</td>'))

  const reject = await postForm(schedSrv.base, { run: sched.runId, job: 'c02', decision: 'rejected' })
  t(`POST decide rejected exits 200 (got ${reject.status})`, reject.status === 200)
  const rejectedRow = dbSched.prepare('SELECT * FROM approval_gates WHERE job_id = ?').get('c02')
  t('rejected: the row flipped (state rejected); decided_by defaults to the OS username',
    rejectedRow?.state === 'rejected' && isWallClock(rejectedRow?.decided_at) && rejectedRow?.decided_by === userInfo().username)
  const rejectedEvents = dbSched.prepare('SELECT * FROM events WHERE type = ? ORDER BY seq').all('APPROVAL_REJECTED')
  t('rejected: exactly one APPROVAL_REJECTED event (the documented vocabulary extension), at the row stamp',
    rejectedEvents.length === 1 && rejectedEvents[0].at === rejectedRow?.decided_at
    && eq(JSON.parse(rejectedEvents[0].payload), { phaseId: 'app', jobId: 'c02', decidedBy: userInfo().username }))
  const queueAfterReject = await get(schedSrv.base, '/approvals')
  t('after both decides, the queue renders empty', queueAfterReject.body.includes('no pending approvals'))
  t('the decides touched nothing outside the approval rows and their two events (candidates/gate_results value-identical)',
    eq(dbSched.prepare('SELECT * FROM candidates ORDER BY candidate_id').all(), verdictsBeforeDecides.candidates)
    && eq(dbSched.prepare('SELECT * FROM gate_results ORDER BY candidate_id, gate_name').all(), verdictsBeforeDecides.gateResults))
  dbSched.close()

  // ---------- AC5: every store refusal surfaces as HTTP 4xx, nothing written ----------
  const dbSchedRo = openDb(dbSchedPath)
  const beforeRefusals = approvalSnapshot(dbSchedRo)
  dbSchedRo.close()
  const refusalCases = [
    ['unknown run', { run: '19990101000000', job: 'c01', decision: 'approved' }, 404, /no recorded run '19990101000000'/],
    ['unknown job', { run: sched.runId, job: 'c99', decision: 'approved' }, 404, /no candidate 'c99'/],
    ['double-decide', { run: sched.runId, job: 'c01', decision: 'approved' }, 409, /already 'approved'/],
    ['unknown decision', { run: sched.runId, job: 'c01', decision: 'maybe' }, 400, /unknown --decision 'maybe'/],
    ['missing form field', { run: sched.runId, job: 'c01' }, 400, /missing form field\(s\): decision/],
  ]
  for (const [label, fields, expectedStatus, expectedMessage] of refusalCases) {
    const r = await postForm(schedSrv.base, fields)
    t(`${label}: POST decide surfaces an HTTP 4xx (got ${r.status})`, r.status >= 400 && r.status < 500)
    if (expectedStatus !== null) t(`${label}: status is ${expectedStatus}`, r.status === expectedStatus)
    if (expectedMessage !== null) t(`${label}: the body carries the refusal message`, expectedMessage.test(r.body))
  }
  const dbSchedRo2 = openDb(dbSchedPath)
  const afterRefusals = approvalSnapshot(dbSchedRo2)
  dbSchedRo2.close()
  t('the refusals wrote nothing (approval rows and the full event log value-identical)',
    eq(afterRefusals.rows, beforeRefusals.rows) && eq(afterRefusals.events, beforeRefusals.events))
  await stopServer(schedSrv.server)

  // ---------- AC5: the non-survivor refusal (gates decide survival) ----------
  const dbElimPath = join(sandbox, 'elim.db')
  ingest(elimSched, dbElimPath)
  requestApproval(dbElimPath, { runId: elimSched.runId, by: 'gate-operator' })
  const elimSrv = await startServer(dbElimPath)
  const elimPost = await postForm(elimSrv.base, { run: elimSched.runId, job: 'c02', decision: 'approved' })
  t(`non-survivor: POST decide for the eliminated candidate is an HTTP 4xx (got ${elimPost.status})`,
    elimPost.status >= 400 && elimPost.status < 500)
  t('non-survivor: the refusal names the resurrect rule (gates decided it out)',
    /not a survivor/.test(elimPost.body) && /resurrect/.test(elimPost.body))
  const dbElimRo = openDb(dbElimPath)
  const elimAfter = approvalSnapshot(dbElimRo)
  dbElimRo.close()
  t('non-survivor: nothing written (still exactly the one survivor row, no approval events beyond the request)',
    elimAfter.rows.length === 1 && elimAfter.rows[0].job_id === 'c01'
    && elimAfter.events.filter((e) => e.type.startsWith('APPROVAL_')).length === 1)
  await stopServer(elimSrv.server)

  // ---------- the probes leg: probe_runs bundle_path renders on the run page ----------
  const dbProbesPath = join(sandbox, 'probes.db')
  const probed = structuredClone(report)
  const bundlePath = join(sandbox, 'probe-bundle.json')
  writeFileSync(bundlePath, JSON.stringify({ probeId: 'p1', scenarioId: 's1', success: true }, null, 2))
  probed.candidates[0].probes = [{ probeId: 'p1', scenarioId: 's1', success: true, durationMs: 12, bundlePath }]
  ingest(probed, dbProbesPath)
  const shaProbes0 = sha256(dbProbesPath)
  const probesSrv = await startServer(dbProbesPath)
  const probesPage = await get(probesSrv.base, `/run/${probed.runId}`)
  t(`probes variant run page exits 200 (got ${probesPage.status})`, probesPage.status === 200)
  t('probes variant: the probe_runs row renders job/probe/scenario/outcome/duration/bundle_path equal to the DB row',
    probesPage.body.includes(`<tr><td>c01</td><td>p1</td><td>s1</td><td>success</td><td>12 ms</td><td>${bundlePath}</td></tr>`))
  t('probes DB byte-identical across its GET route', sha256(dbProbesPath) === shaProbes0)
  await stopServer(probesSrv.server)

  // ---------- readOnly is enforced at the API level ----------
  // Guards the open option itself against node:sqlite churn across Node
  // minors (VERIFICATION.md Known issues #7) — same guard as Gates 1.7/1.9.
  const ro = new DatabaseSync(dbMainPath, { readOnly: true })
  let refusedWrite = false
  try {
    ro.exec("INSERT INTO approval_gates VALUES ('x', 'main', 'cx', 'waiting_for_approval', 'at', 'by', NULL, NULL, NULL)")
  } catch {
    refusedWrite = true
  }
  ro.close()
  t('a write against a readOnly-opened DB throws (the option is honored)', refusedWrite)
  dbMain.close()
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\ncheck-dashboard: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-dashboard: ALL GREEN')
