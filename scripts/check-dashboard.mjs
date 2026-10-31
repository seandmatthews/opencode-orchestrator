// Dashboard self-check (Gate 1.23, fast tier, T-034 + T-035) — run under tsx:
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
// T-035 extends every pin to the per-job drill-down route
// GET /run/<id>/job/<jobId>: the job row, the candidates.passed_all_gates
// verdict, the job's gate_results rows, its full attempts history (a
// hand-built retried variant, the check-store construction), its probe_runs
// rows (pinned only on the hand-built variant — the live store holds 0
// probe_runs rows), the never-dispatched face (empty worker/model/brief +
// no candidate row), the no-jobs-row 404, the run page's DAG job list
// linking the drill-downs with plain <a href>, and the --help route line —
// every value equal to a direct SELECT on the same temp DB, NULLs rendered
// as "missing", and the DB byte-identity proof extended across the new GET
// routes on every fixture DB.
// T-037 extends every pin to the per-run context route GET /run/<id>/context
// (spec §26.4's honest consumer slice): 200/405/404 faces, the store-backed
// face (attempts rows: job_id/attempt_number/state/started_at/
// input_context_hash grouped per job, EQUAL to direct SELECTs, each job
// linked to its drill-down; the flat fixture renders "(none recorded)"), the
// report-backed face pinned against hand-built rounds-report variants (a
// round-2 record with fingerprint + block path whose report FILE is written
// at the report_path ingest derives, plus an executed:false round record and
// a report_path pointing at a nonexistent file) with packetFingerprint
// rendered verbatim and renderedBlockPath as verbatim pointer text never
// served or linked, the honesty label "report.json read via
// runs.report_path — not store rows", both hash labels distinct (the
// attempts.input_context_hash vs rounds[].packetFingerprint disjointness per
// the src/rounds.ts header), every producer-less §26.4 field rendering its
// no-producer marker, the run page and drill-down attempts section linking
// the context page with plain <a href>, and the DB byte-identity set + the
// zero-<script> sweep extended across the new route on every fixture DB.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { defaultStoreDb } from '../src/run-root.ts'
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
// The dashboard's HTML escaper, mirrored — needed when the page renders
// recorded JSON verbatim (attempts.output_artifacts_json/failure_json):
// the check builds the expected escaped text and compares.
const escHtml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
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
// Every GET body the gate drives lands here — the no-client-side-JS sweep
// (the T-035 pin: the new pages carry zero <script> tags) runs over ALL of
// them at the end, not a hand-picked subset.
const fetchedPages = []
const get = async (base, path) => {
  const res = await fetch(base + path)
  const body = await res.text()
  fetchedPages.push({ path, body })
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body }
}
// A POST to a read route — must be refused (405); POST /approvals/decide
// stays the dashboard's ONLY write (the T-035 pin on the new route's face).
const post = async (base, path) => {
  const res = await fetch(base + path, { method: 'POST' })
  return { status: res.status, body: await res.text() }
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
// Gate 1.7 --json shape), count lines included. T-035: each job id is a
// plain <a href> link to its drill-down page (zero client-side JS) — the
// expected markup carries the anchor.
const depsTxt = (deps) => deps.length === 0 ? '(none)' : deps.join(', ')
const assertDagSection = (body, runId, dump, label) => {
  let good = body.includes(`phases (${dump.phases.length}):`)
    && body.includes(`jobs (${dump.jobs.length}):`)
    && body.includes(`edges (${dump.edges.length}):`)
  for (const p of dump.phases) {
    good = good && body.includes(`<li>${p.phaseId} &mdash; dependencies: ${depsTxt(p.dependencies)}</li>`)
  }
  for (const j of dump.jobs) {
    good = good && body.includes(`<li><a href="/run/${runId}/job/${j.jobId}">${j.jobId}</a> (phase ${j.phaseId}, worker ${j.workerId}, model ${j.model}) &mdash; dependencies: ${depsTxt(j.dependencies)}</li>`)
  }
  for (const e of dump.edges) {
    good = good && body.includes(`<li>${e.jobId} -&gt; ${e.dependsOnJobId}</li>`)
  }
  t(`${label}: the DAG section renders exactly src/dag.ts's read of the same DB (cross-checked via dag --json), every job id linked to its drill-down page`, good)
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

// T-037: spec §26.4's context-inspector fields — NONE has a producer
// anywhere in stage-0 (the ingest upsert binds jobs.context_plan_json
// literal null; no context_plans/context_packets/artifact_lineage table
// exists; the composer is pure/zero-I/O), so the context page must render
// each as an explicit no-producer marker, never fabricated structure.
const NO_PRODUCER_SPECS = [
  'token budget',
  'mandatory artifacts',
  'selected artifacts',
  'distilled artifacts',
  'excluded artifacts',
  'source chain',
  'plan/packet records (context_plans / context_packets / artifact_lineage)',
]
const noProducerMarkersOk = (body) =>
  NO_PRODUCER_SPECS.every((f) => body.includes(`<td>${f}</td><td class="refusal"`))
  && countOccurrences(body, '>no producer</td>') === NO_PRODUCER_SPECS.length
// The two hash kinds are disjoint by design (the src/rounds.ts header);
// the page must label them distinctly and never as one kind of value.
const bothHashLabelsOk = (body) =>
  body.includes('<strong>worker-attempt input hash</strong>')
  && body.includes('<strong>composed context packet fingerprint</strong>')
  && body.includes('<code>attempts.input_context_hash</code>')
  && body.includes('<code>rounds[].packetFingerprint</code>')
const HONESTY_LABEL = '<strong>report.json read via runs.report_path &mdash; not store rows</strong>'

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
  t('usage documents --db with its resolved default (defaultStoreDb(), T-065: platform-aware)', help.stdout.includes('--db <path>') && help.stdout.includes(defaultStoreDb()))
  t('usage documents the T-035 drill-down route /run/<id>/job/<jobId>', help.stdout.includes('/run/<id>/job/<jobId>'))
  t('usage documents the T-037 context route /run/<id>/context', help.stdout.includes('/run/<id>/context'))

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
  assertDagSection(runPage.body, report.runId, runDagCli(dbMainPath, report.runId), 'main fixture')
  // T-037: the run page links to the context page with a plain <a href>.
  t('run page: links to /run/<id>/context with a plain <a href> (zero client-side JS)',
    runPage.body.includes(`<a href="/run/${report.runId}/context">`))

  // ---------- T-035 AC: the drill-down pages on the flat fixture ----------
  // Every value a direct SELECT on the same temp DB; NULLs render as
  // "missing". The flat fixture predates attempts and carries no probes, so
  // those sections render "(none recorded)" — also asserted never-fabricated.
  for (const c of report.candidates) {
    const jobPage = await get(explicit.base, `/run/${report.runId}/job/${c.id}`)
    const jrow = dbMain.prepare('SELECT job_id, phase_id, worker_id, model, brief, dependencies_json FROM jobs WHERE run_id = ? AND job_id = ?').get(report.runId, c.id)
    const crow = dbMain.prepare('SELECT candidate_id, passed_all_gates FROM candidates WHERE run_id = ? AND candidate_id = ?').get(report.runId, c.id)
    t(`drill-down ${c.id}: GET exits 200 (got ${jobPage.status})`, jobPage.status === 200)
    t(`drill-down ${c.id}: the jobs row renders phase/worker/model/brief/expanded dependencies equal to the DB row`,
      jobPage.body.includes(`<tr><td>${jrow.job_id}</td><td>${jrow.phase_id}</td><td>${jrow.worker_id}</td><td>${jrow.model}</td><td>${escHtml(jrow.brief)}</td><td>${JSON.parse(jrow.dependencies_json).length === 0 ? '(none)' : JSON.parse(jrow.dependencies_json).join(', ')}</td></tr>`))
    t(`drill-down ${c.id}: the verdict renders survivor/eliminated equal to candidates.passed_all_gates (job_id IS the candidate id)`,
      jobPage.body.includes(`<tr><td>${crow.candidate_id}</td><td>${crow.passed_all_gates === 1 ? 'survivor' : 'eliminated'}</td></tr>`))
    const jgates = dbMain.prepare('SELECT gate_name, passed, exit_code, duration_ms, output_tail FROM gate_results WHERE run_id = ? AND candidate_id = ? ORDER BY gate_name').all(report.runId, c.id)
    t(`drill-down ${c.id}: every gate_results row renders name/pass/exit/duration/tail equal to the DB row (null exit as missing)`,
      jobPage.body.includes(`gate results (${jgates.length})`)
      && jgates.every((g) => jobPage.body.includes(
        `<td>${g.gate_name}</td><td>${g.passed === 1 ? 'pass' : 'FAIL'}</td>`
        + `<td>${g.exit_code === null ? 'missing' : String(g.exit_code)}</td><td>${g.duration_ms} ms</td>`
        + `<td>${escHtml(g.output_tail)}</td>`)))
    const jprobes = dbMain.prepare('SELECT COUNT(*) AS n FROM probe_runs WHERE run_id = ? AND job_id = ?').get(report.runId, c.id).n
    const jattempts = dbMain.prepare('SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND job_id = ?').get(report.runId, c.id).n
    t(`drill-down ${c.id}: attempts (${jattempts}) and probe runs (${jprobes}) render (none recorded) rows — the flat fixture predates both, nothing fabricated`,
      jobPage.body.includes(`<h2>attempts (${jattempts})</h2>`) && jobPage.body.includes('<tr><td colspan="10">(none recorded)</td></tr>')
      && jobPage.body.includes(`<h2>probe runs (${jprobes})</h2>`) && jobPage.body.includes('<tr><td colspan="5">(none recorded)</td></tr>'))
  }

  // ---------- T-037: the per-run context page on the flat fixture ----------
  // The flat fixture predates attempts: the store-backed face renders
  // "(none recorded)" — nothing fabricated. Its report-face STATE is
  // machine-dependent (the fixture's report_path is a heuristic
  // reconstruction pointing into the long-disposed verify sandbox), so the
  // rounds table is pinned only on the controlled variants below; here the
  // standing faces are pinned: the honesty label, the distinct hash labels,
  // and the no-producer markers.
  const ctxPage = await get(explicit.base, `/run/${report.runId}/context`)
  t(`context page: GET exits 200 (got ${ctxPage.status})`, ctxPage.status === 200)
  t('context page: the honesty label on the report-backed face reads "report.json read via runs.report_path — not store rows"',
    ctxPage.body.includes(HONESTY_LABEL))
  t('context page: the flat fixture predates attempts — (none recorded), no per-job attempt groups rendered',
    ctxPage.body.includes('(none recorded)') && !ctxPage.body.includes('<h3>job <a href='))
  t('context page: input_context_hash and packetFingerprint render under DISTINCT labels, never one kind of value',
    bothHashLabelsOk(ctxPage.body))
  t('context page: every producer-less §26.4 field renders an explicit no-producer marker (7 fields)',
    noProducerMarkersOk(ctxPage.body))

  const ctxUnknown = await get(explicit.base, '/run/19990101000000/context')
  t(`context page: GET /run/<unknown>/context exits 404 (got ${ctxUnknown.status})`, ctxUnknown.status === 404)
  t('context page: unknown run carries the refusal message', ctxUnknown.body.includes(`no recorded run '19990101000000'`))

  const unknownRun = await get(explicit.base, '/run/19990101000000')
  t(`GET /run/<unknown> exits 404 (got ${unknownRun.status})`, unknownRun.status === 404)
  t('unknown run: the page carries the refusal message', unknownRun.body.includes(`no recorded run '19990101000000'`))

  const unknownJob = await get(explicit.base, `/run/${report.runId}/job/c99`)
  t(`GET /run/<id>/job/<unknown> exits 404 (got ${unknownJob.status})`, unknownJob.status === 404)
  t('unknown job: the page carries the refusal message', unknownJob.body.includes(`no recorded job 'c99' in run '${report.runId}'`))
  const unknownRunJob = await get(explicit.base, `/run/19990101000000/job/c01`)
  t(`GET /run/<unknown>/job/<id> exits 404 (got ${unknownRunJob.status}) — no jobs row at all`, unknownRunJob.status === 404)
  t('unknown run drill-down: the page carries the refusal message', unknownRunJob.body.includes(`no recorded job 'c01' in run '19990101000000'`))

  // ---------- T-035 pin: POST /approvals/decide remains the ONLY write ----------
  const postToJobPage = await post(explicit.base, `/run/${report.runId}/job/c01`)
  t(`POST on the drill-down route is refused 405 (got ${postToJobPage.status}) — it is a read route`, postToJobPage.status === 405)
  // T-037: the context route is a read too — non-GET refused 405.
  const postToContext = await post(explicit.base, `/run/${report.runId}/context`)
  t(`POST on the context route is refused 405 (got ${postToContext.status}) — it is a read route`, postToContext.status === 405)

  // ---------- read-only proof: the DB is byte-identical across ALL GET routes ----------
  const list1 = await get(explicit.base, '/')
  const approvals0 = await get(explicit.base, '/approvals')
  t(`GET /approvals exits 200 on an approval-less DB (got ${approvals0.status})`, approvals0.status === 200)
  t('approvals page: an empty queue says so', approvals0.body.includes('no pending approvals'))
  t(`DB byte-identical across ALL GET routes plus the refused read-route POSTs (/, /run/<id>, /run/<id>/job/<jobId>, /run/<id>/context, the drill-down + context 404s, both 405s, /approvals, 404, / again)`, sha256(dbMainPath) === shaMain0)
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
  assertDagSection(schedPage.body, sched.runId, runDagCli(dbSchedPath, sched.runId), 'scheduled variant')
  t('scheduled variant: the page renders the real two-phase structure and its one expanded edge',
    schedPage.body.includes('<li>foundation &mdash; dependencies: (none)</li>')
    && schedPage.body.includes('<li>app &mdash; dependencies: foundation</li>')
    && schedPage.body.includes('<li>c02 -&gt; c01</li>'))

  // ---------- T-035 AC: drill-downs consistent with the hand-built schedule variant ----------
  // The gate keeps exercising this hand-built variant (two real phases
  // foundation→app, expanded edge c02→c01): no scheduled --jobs run has ever
  // been ingested — every phases row in the live C:\swarm\refinery.db is the
  // flat 'main' derivation (queried at T-035 authoring).
  const dbSchedRead = openDb(dbSchedPath)
  for (const jobId of ['c01', 'c02']) {
    const jobPage = await get(schedSrv.base, `/run/${sched.runId}/job/${jobId}`)
    const jrow = dbSchedRead.prepare('SELECT job_id, phase_id, worker_id, model, brief, dependencies_json FROM jobs WHERE run_id = ? AND job_id = ?').get(sched.runId, jobId)
    const crow = dbSchedRead.prepare('SELECT candidate_id, passed_all_gates FROM candidates WHERE run_id = ? AND candidate_id = ?').get(sched.runId, jobId)
    t(`scheduled variant drill-down ${jobId}: GET exits 200 (got ${jobPage.status})`, jobPage.status === 200)
    t(`scheduled variant drill-down ${jobId}: job row carries the REAL phase and expanded dependencies, equal to the store rows`,
      jobPage.body.includes(`<tr><td>${jrow.job_id}</td><td>${jrow.phase_id}</td><td>${jrow.worker_id}</td><td>${jrow.model}</td><td>${escHtml(jrow.brief)}</td><td>${depsTxt(JSON.parse(jrow.dependencies_json))}</td></tr>`))
    t(`scheduled variant drill-down ${jobId}: verdict equals candidates.passed_all_gates`,
      jobPage.body.includes(`<tr><td>${crow.candidate_id}</td><td>${crow.passed_all_gates === 1 ? 'survivor' : 'eliminated'}</td></tr>`))
  }
  dbSchedRead.close()

  // ---------- AC4: GET /approvals renders exactly listPendingApprovals's rows ----------
  const approvalsPage = await get(schedSrv.base, '/approvals')
  t(`GET /approvals exits 200 (got ${approvalsPage.status})`, approvalsPage.status === 200)
  const pendingRowString = (r) => `<tr><td>${r.runId}</td><td>${r.phaseId}</td><td>${r.jobId}</td><td>${r.state}</td><td>${r.requestedAt}</td><td>${r.requestedBy}</td></tr>`
  t('approvals page: renders exactly listPendingApprovals\'s rows (every row, no others)',
    pendingDirect.every((r) => approvalsPage.body.includes(pendingRowString(r)))
    && countOccurrences(approvalsPage.body, '<td>waiting_for_approval</td>') === pendingDirect.length)
  const shaSchedAfterGets = sha256(dbSchedPath)
  t('scheduled DB byte-identical across its GET routes (run page, both drill-downs, approvals)', shaSchedAfterGets === shaSched0)

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
  // T-035: the eliminated verdict face on the drill-down — the eliminated
  // candidate's page renders eliminated (the machine verdict) and its failed
  // gate FAILs with the recorded exit code, equal to the store rows.
  const elimPage = await get(elimSrv.base, `/run/${elimSched.runId}/job/c02`)
  const dbElimRead = openDb(dbElimPath)
  const elimCrow = dbElimRead.prepare('SELECT candidate_id, passed_all_gates FROM candidates WHERE candidate_id = ?').get('c02')
  t(`non-survivor drill-down: GET exits 200 (got ${elimPage.status})`, elimPage.status === 200)
  t('non-survivor drill-down: the verdict renders eliminated, equal to candidates.passed_all_gates',
    elimPage.body.includes(`<tr><td>${elimCrow.candidate_id}</td><td>${elimCrow.passed_all_gates === 1 ? 'survivor' : 'eliminated'}</td></tr>`) && elimCrow.passed_all_gates === 0)
  const elimGates = dbElimRead.prepare('SELECT gate_name, passed, exit_code FROM gate_results WHERE candidate_id = ? ORDER BY gate_name').all('c02')
  t('non-survivor drill-down: the failed gate renders FAIL with its recorded exit code',
    elimGates.some((g) => g.passed === 0)
    && elimGates.every((g) => elimPage.body.includes(`<td>${g.gate_name}</td><td>${g.passed === 1 ? 'pass' : 'FAIL'}</td><td>${g.exit_code === null ? 'missing' : String(g.exit_code)}</td>`)))
  dbElimRead.close()
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
  // T-035: the probe face on the drill-down — the live store currently holds
  // 0 probe_runs rows, so the probe face is pinned only on this hand-built
  // variant (stated in the ticket, not smoothed).
  const probeJobPage = await get(probesSrv.base, `/run/${probed.runId}/job/c01`)
  const dbProbesRead = openDb(dbProbesPath)
  const probeJobRow = dbProbesRead.prepare('SELECT probe_id, scenario_id, success, duration_ms, bundle_path FROM probe_runs WHERE run_id = ? AND job_id = ? ORDER BY probe_id').all(probed.runId, 'c01')
  t(`probes variant drill-down c01: GET exits 200 (got ${probeJobPage.status})`, probeJobPage.status === 200)
  t('probes variant drill-down c01: the probe_runs row renders probe/scenario/outcome/duration/bundle_path equal to the DB row',
    probeJobRow.length === 1 && probeJobPage.body.includes(
      `<tr><td>${probeJobRow[0].probe_id}</td><td>${probeJobRow[0].scenario_id}</td>`
      + `<td>${probeJobRow[0].success === 1 ? 'success' : 'failure'}</td><td>${probeJobRow[0].duration_ms} ms</td>`
      + `<td>${probeJobRow[0].bundle_path}</td></tr>`))
  t('probes DB byte-identical across its GET routes (run page + drill-down)', sha256(dbProbesPath) === shaProbes0)
  dbProbesRead.close()
  await stopServer(probesSrv.server)

  // ---------- T-035: the retried-attempts variant (the check-store retried construction) ----------
  // One candidate given two attempts by hand (attempt 2 mirrors its real
  // final values — top-level fields are the FINAL attempt's values); c02
  // keeps the pre-T-007 shape (zero attempt rows). attempt 1 carries a null
  // prompt_version (renders "missing"); attempt 2 carries a recorded 64-hex
  // prompt_version (renders verbatim) — both faces of the column in one
  // variant. The producer-less columns (process_identity_json /
  // worker_session_id) stay null on both and render "missing".
  const dbRetriedPath = join(sandbox, 'retried-dashboard.db')
  const retriedR = structuredClone(report)
  const rc = retriedR.candidates[0]
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
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
    inputContextHash: hashA, promptVersion: hashB,
    outputArtifacts: [
      'C:\\swarm\\verify\\20261011022419\\c01\\attempt-2\\worker.log',
      'C:\\swarm\\verify\\20261011022419\\c01\\attempt-2\\diff.patch',
    ],
  }
  rc.attempts = [attempt1, attempt2]
  ingest(retriedR, dbRetriedPath)
  const shaRetried0 = sha256(dbRetriedPath)
  const retriedSrv = await startServer(dbRetriedPath)
  const retriedDbRo = openDb(dbRetriedPath)
  const retriedJobPage = await get(retriedSrv.base, `/run/${retriedR.runId}/job/${rc.id}`)
  const retriedRows = retriedDbRo.prepare('SELECT * FROM attempts WHERE run_id = ? AND job_id = ? ORDER BY attempt_number').all(retriedR.runId, rc.id)
  t(`retried variant drill-down ${rc.id}: GET exits 200 (got ${retriedJobPage.status})`, retriedJobPage.status === 200)
  t(`retried variant drill-down ${rc.id}: the attempts section renders the FULL history (2 rows)`,
    retriedJobPage.body.includes('<h2>attempts (2)</h2>') && retriedRows.length === 2)
  for (const row of retriedRows) {
    const attempt = row.attempt_number === 1 ? attempt1 : attempt2
    const expected =
      `<tr><td>${row.attempt_number}</td><td>${row.state}</td>`
      + `<td>${row.started_at === null ? 'missing' : row.started_at}</td>`
      + `<td>${row.ended_at === null ? 'missing' : row.ended_at}</td>`
      + `<td>${row.input_context_hash}</td>`
      + `<td>${row.prompt_version === null ? 'missing' : row.prompt_version}</td>`
      + `<td>${row.process_identity_json === null ? 'missing' : escHtml(row.process_identity_json)}</td>`
      + `<td>${row.worker_session_id === null ? 'missing' : escHtml(row.worker_session_id)}</td>`
      + `<td>${escHtml(row.output_artifacts_json)}</td>`
      + `<td>${row.failure_json === null ? 'missing' : escHtml(row.failure_json)}</td></tr>`
    t(`retried variant drill-down: attempt ${row.attempt_number} renders state/stamps/hash/prompt_version/artifacts/failure equal to the DB row (nulls as missing, JSON as recorded)`,
      retriedJobPage.body.includes(expected)
      && row.state === attempt.state && row.input_context_hash === attempt.inputContextHash
      && eq(JSON.parse(row.output_artifacts_json), attempt.outputArtifacts)
      && (attempt.failure ? eq(JSON.parse(row.failure_json), attempt.failure) : row.failure_json === null)
      && (attempt.promptVersion === null ? row.prompt_version === null : row.prompt_version === attempt.promptVersion))
  }
  t('retried variant drill-down: producer-less columns (process_identity_json, worker_session_id) render as missing on both attempts',
    countOccurrences(retriedJobPage.body, '<td>missing</td>') >= 6)
  const retriedC02Page = await get(retriedSrv.base, `/run/${retriedR.runId}/job/c02`)
  t('retried variant drill-down c02: the pre-T-007 candidate renders attempts (0) — zero rows, nothing fabricated',
    retriedC02Page.status === 200 && retriedC02Page.body.includes('<h2>attempts (0)</h2>')
    && retriedC02Page.body.includes('<tr><td colspan="10">(none recorded)</td></tr>'))
  // T-037: the drill-down's attempts section links to the context page.
  t('retried variant drill-down: the attempts section links to /run/<id>/context with a plain <a href>',
    retriedJobPage.body.includes(`<a href="/run/${retriedR.runId}/context">`))
  // T-037: the context page's STORE-BACKED face equals direct read-only
  // SELECTs on the same DB — attempts grouped per job, each job linked to
  // its drill-down, state/started_at/input_context_hash rendered as
  // recorded (NULL started_at as missing).
  const retriedCtx = await get(retriedSrv.base, `/run/${retriedR.runId}/context`)
  t(`retried variant context page: GET exits 200 (got ${retriedCtx.status})`, retriedCtx.status === 200)
  const retriedCtxRows = retriedDbRo.prepare(
    'SELECT job_id, attempt_number, state, started_at, input_context_hash FROM attempts WHERE run_id = ? ORDER BY job_id, attempt_number',
  ).all(retriedR.runId)
  t(`retried variant context page: the store-backed face renders the attempts rows EQUAL to direct SELECTs, grouped per job (${retriedCtxRows.length} rows), c01 linked to its drill-down`,
    retriedCtxRows.length === 2
    && retriedCtxRows.every((r) => r.job_id === 'c01')
    && retriedCtx.body.includes(`<h3>job <a href="/run/${retriedR.runId}/job/c01">c01</a> (2 attempts)</h3>`)
    && retriedCtxRows.every((r) => retriedCtx.body.includes(
      `<tr><td>${r.attempt_number}</td><td>${r.state}</td>`
      + `<td>${r.started_at === null ? 'missing' : r.started_at}</td>`
      + `<td>${r.input_context_hash}</td></tr>`)))
  t('retried variant context page: c02 (pre-T-007, zero attempts) renders no job group — nothing fabricated',
    !retriedCtx.body.includes(`<h3>job <a href="/run/${retriedR.runId}/job/c02">`))
  t('retried variant context page: standing faces present (honesty label, distinct hash labels, no-producer markers)',
    retriedCtx.body.includes(HONESTY_LABEL) && bothHashLabelsOk(retriedCtx.body) && noProducerMarkersOk(retriedCtx.body))
  t('retried DB byte-identical across its GET routes (drill-downs + the context page)', sha256(dbRetriedPath) === shaRetried0)
  retriedDbRo.close()
  await stopServer(retriedSrv.server)

  // ---------- T-035: the never-dispatched face (the T-031 declared-but-suppressed shape) ----------
  // A schedule job with dispatchIndex null and NO candidate report ingests a
  // jobs row with empty worker/model/brief (the store's never-dispatched
  // derivation). Its page renders never-dispatched — no verdict, no gates,
  // no attempts, nothing fabricated; its dispatched siblings keep rendering.
  const dbNdPath = join(sandbox, 'never-dispatched.db')
  const nd = structuredClone(sched)
  nd.schedule.jobs.push({ id: 'c03', phaseId: 'app', dependencies: ['c02'], dispatchIndex: null })
  ingest(nd, dbNdPath)
  const shaNd0 = sha256(dbNdPath)
  const ndSrv = await startServer(dbNdPath)
  const ndPage = await get(ndSrv.base, `/run/${nd.runId}/job/c03`)
  t(`never-dispatched drill-down: GET exits 200 (got ${ndPage.status})`, ndPage.status === 200)
  t('never-dispatched drill-down: the page renders never-dispatched',
    ndPage.body.includes('never-dispatched'))
  t('never-dispatched drill-down: the jobs row renders the empty worker/model/brief verbatim (nothing fabricated)',
    ndPage.body.includes('<tr><td>c03</td><td>app</td><td></td><td></td><td></td><td>c02</td></tr>'))
  t('never-dispatched drill-down: no verdict, no gate results, no attempts, no probe runs rendered',
    !ndPage.body.includes('<h2>verdict') && !ndPage.body.includes('<h2>gate results')
    && !ndPage.body.includes('<h2>attempts') && !ndPage.body.includes('<h2>probe runs')
    && !ndPage.body.includes('>survivor<') && !ndPage.body.includes('>eliminated<'))
  const ndC01Page = await get(ndSrv.base, `/run/${nd.runId}/job/c01`)
  t('never-dispatched variant: a dispatched sibling job keeps rendering its full page (200 + verdict + sections)',
    ndC01Page.status === 200 && ndC01Page.body.includes('<h2>verdict') && !ndC01Page.body.includes('never-dispatched'))
  t('never-dispatched DB byte-identical across its GET routes', sha256(dbNdPath) === shaNd0)
  await stopServer(ndSrv.server)

  // ---------- T-037: the report-backed face — hand-built rounds-report variants ----------
  // The rounds block rides report.json ONLY (the store persists verdicts
  // alone), so its faces are pinned on hand-built variants, the
  // hand-built-variant pattern: ingest binds runs.report_path from
  // reportPathOf (planner.rawOutputPath → <dir>/report.json), so a variant
  // whose report FILE is written at that derived path exercises the
  // report-present face, one whose dir has no report.json exercises the
  // missing-file face. Verbatim rendering is the point: packetFingerprint is
  // never recomputed, renderedBlockPath is pointer text never served or
  // linked, and an executed:false round renders "not executed" — recorded,
  // never fabricated (AGENTS.md #7).
  const roundFp = 'f'.repeat(64)
  const roundsRunDir = join(sandbox, 'rounds-run')
  const roundsReportPath = join(roundsRunDir, 'report.json')
  const roundsBlockPath = join(roundsRunDir, 'round-2-context-block.txt')
  const roundsExec = structuredClone(report)
  roundsExec.planner.rawOutputPath = join(roundsRunDir, 'planner-raw.txt')
  roundsExec.rounds = [
    { round: 1, executed: true, survivorIds: ['c01', 'c02'] },
    { round: 2, executed: true, survivorIds: ['c01-r2'], packetFingerprint: roundFp, renderedBlockPath: roundsBlockPath },
  ]
  mkdirSync(roundsRunDir, { recursive: true })
  writeFileSync(roundsReportPath, JSON.stringify(roundsExec, null, 2))
  const dbRoundsPath = join(sandbox, 'rounds.db')
  ingest(roundsExec, dbRoundsPath)
  const dbRoundsRo = openDb(dbRoundsPath)
  t('rounds variant: ingest recorded report_path at the derived path where the report file was written',
    dbRoundsRo.prepare('SELECT report_path FROM runs WHERE run_id = ?').get(roundsExec.runId).report_path === roundsReportPath)
  const shaRounds0 = sha256(dbRoundsPath)
  const roundsSrv = await startServer(dbRoundsPath)
  const roundsCtx = await get(roundsSrv.base, `/run/${roundsExec.runId}/context`)
  t(`rounds variant context page: GET exits 200 (got ${roundsCtx.status})`, roundsCtx.status === 200)
  t('rounds variant: the honesty label reads "report.json read via runs.report_path — not store rows"',
    roundsCtx.body.includes(HONESTY_LABEL))
  t('rounds variant: round 1 renders executed with its survivorIds and no packet fields (nothing fabricated)',
    roundsCtx.body.includes('<tr><td>1</td><td>executed</td><td>c01, c02</td><td>missing</td><td>missing</td></tr>'))
  t('rounds variant: round 2 renders executed with the packetFingerprint VERBATIM (never recomputed) and the renderedBlockPath as pointer text',
    roundsCtx.body.includes(`<tr><td>2</td><td>executed</td><td>c01-r2</td><td>${roundFp}</td><td>${roundsBlockPath}</td></tr>`))
  t('rounds variant: the rendered block path is never served or linked to content (verbatim pointer only, §26.5 stays carved)',
    roundsCtx.body.includes(`<td>${roundsBlockPath}</td>`) && !roundsCtx.body.includes(`<a href="${roundsBlockPath}"`))
  t('rounds variant: both hash kinds render under DISTINCT labels (attempts.input_context_hash vs rounds[].packetFingerprint, disjoint per src/rounds.ts)',
    bothHashLabelsOk(roundsCtx.body))
  t('rounds variant: standing faces present (distinct hash labels, no-producer markers)',
    bothHashLabelsOk(roundsCtx.body) && noProducerMarkersOk(roundsCtx.body))
  t('rounds DB byte-identical across its GET routes (the report.json read touches no DB bytes)',
    sha256(dbRoundsPath) === shaRounds0)
  await stopServer(roundsSrv.server)
  dbRoundsRo.close()

  // The executed:false face (the runner records it when round 2 has no
  // round-1 survivor or no planner phase — src/runner.ts): rendered as
  // "not executed", never fabricated as executed.
  const notExecDir = join(sandbox, 'rounds-notexec-run')
  const roundsNotExec = structuredClone(report)
  roundsNotExec.planner.rawOutputPath = join(notExecDir, 'planner-raw.txt')
  roundsNotExec.rounds = [
    { round: 1, executed: true, survivorIds: ['c01'] },
    { round: 2, executed: false, survivorIds: [] },
  ]
  mkdirSync(notExecDir, { recursive: true })
  writeFileSync(join(notExecDir, 'report.json'), JSON.stringify(roundsNotExec, null, 2))
  const dbNotExecPath = join(sandbox, 'rounds-notexec.db')
  ingest(roundsNotExec, dbNotExecPath)
  const shaNotExec0 = sha256(dbNotExecPath)
  const notExecSrv = await startServer(dbNotExecPath)
  const notExecCtx = await get(notExecSrv.base, `/run/${roundsNotExec.runId}/context`)
  t(`not-executed variant context page: GET exits 200 (got ${notExecCtx.status})`, notExecCtx.status === 200)
  t('not-executed variant: the executed:false round renders "not executed" (recorded, never fabricated)',
    notExecCtx.body.includes('<tr><td>2</td><td>not executed</td><td></td><td>missing</td><td>missing</td></tr>')
    && notExecCtx.body.includes('<tr><td>1</td><td>executed</td><td>c01</td><td>missing</td><td>missing</td></tr>'))
  t('not-executed DB byte-identical across its GET routes', sha256(dbNotExecPath) === shaNotExec0)
  await stopServer(notExecSrv.server)

  // The missing-report face — report_path pointing at a nonexistent file
  // (the live state of most ingested runs: report_path is a heuristic
  // reconstruction into run dirs that clean/disposal may have removed). The
  // page renders the TRUE state and the store-backed face still stands.
  const missingDir = join(sandbox, 'missing-run')
  const missingRep = structuredClone(report)
  missingRep.planner.rawOutputPath = join(missingDir, 'planner-raw.txt')
  // report.json deliberately NOT written in missingDir.
  const dbMissingPath = join(sandbox, 'missing.db')
  ingest(missingRep, dbMissingPath)
  const missingReportPath = join(missingDir, 'report.json')
  const shaMissing0 = sha256(dbMissingPath)
  const missingSrv = await startServer(dbMissingPath)
  const missingCtx = await get(missingSrv.base, `/run/${missingRep.runId}/context`)
  t(`missing-report variant context page: GET exits 200 (got ${missingCtx.status})`, missingCtx.status === 200)
  t('missing-report variant: the page renders the true state — the report file is missing at its recorded report_path',
    missingCtx.body.includes(`report file missing at ${missingReportPath}`))
  t('missing-report variant: the honesty label still stands and the store-backed face is still present ((none recorded), hash labels, no-producer markers)',
    missingCtx.body.includes(HONESTY_LABEL) && missingCtx.body.includes('(none recorded)')
    && bothHashLabelsOk(missingCtx.body) && noProducerMarkersOk(missingCtx.body))
  t('missing DB byte-identical across its GET routes', sha256(dbMissingPath) === shaMissing0)
  await stopServer(missingSrv.server)

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
  // ---------- T-035 pin: zero client-side JS, swept over EVERY page the gate drove ----------
  // The stdlib-template posture holds only if NO served page carries a
  // script tag — the drill-down pages included — so the sweep runs over the
  // full fetch log, never a hand-picked subset.
  t(`no fetched page carries client-side JS (${fetchedPages.length} pages swept, zero <script> tags)`,
    fetchedPages.length > 0 && fetchedPages.every((p) => !p.body.includes('<script')))
  dbMain.close()
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\ncheck-dashboard: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-dashboard: ALL GREEN')
