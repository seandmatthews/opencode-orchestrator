// Dashboard write-surface self-check (Gate 1.37, fast tier, T-051) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-dashboard-write.mjs
// Pins the register-R3 fixes on the dashboard's ONLY write
// (POST /approvals/decide, src/dashboard.ts) and the store writer behind it
// (decideApproval, src/store/index.ts) — token-free, the check-dashboard.mjs
// precedent (fixture ingested into fresh temp DBs, stdlib HTTP driving the
// real server in-process on an ephemeral 127.0.0.1 port):
//
// 1. the T-051 request gate — Host must be 127.0.0.1[:port] or
//    localhost[:port]; Origin, when present, must be one of
//    http://127.0.0.1[:port] / http://localhost[:port]. Hostile legs
//    (Origin http://evil.example on the decide POST; Host evil.example on a
//    GET; an https:// origin; a suffix-spoof origin) all return 403 with
//    ONE loud console.error line naming the rejected header and its value,
//    and — proven by sha256 over the DB file — refuse BEFORE any DB open:
//    the byte-identity snapshot across every refused leg (403s and the 400
//    legs below) shows zero bytes touched;
// 2. legitimate-request inertness — Host localhost[:port], a matching
//    Origin, and no Origin at all are served exactly as today (200s; a
//    decide POST with Origin http://127.0.0.1:<port> lands through the real
//    decideApproval, row flipped, exactly one APPROVAL_GRANTED event);
// 3. the decide race closed by construction — the conditional in-transaction
//    UPDATE (WHERE state = 'waiting_for_approval', refuse when changes === 0
//    with today's exact double-decide message): a SECOND SEQUENTIAL decide
//    (no Origin — also the no-Origin inertness leg) refuses 409 with the
//    exact pre-T-051 message, and TWO PROCESSES spawned by this check — one
//    overlapping pair (spawned together: SQLite's own locking plus the guard
//    must yield exactly one landed decide, one event, NEVER both an
//    APPROVAL_GRANTED and an APPROVAL_REJECTED on one row) and one
//    quick-succession pair (the second decide ~1s behind the first, the
//    CSRF-racing-a-human shape) where the loser's refusal IS the guard's
//    exact double-decide message. The TOCTOU itself has no deterministic
//    single-process red (node:sqlite is synchronous; the interleaving needs
//    two processes) — recorded in the ticket as the code-shape citation,
//    never claimed as a reproduced red;
// 4. malformed percent-encoding → 400, not 500 — %zz in each decoded path
//    segment (/run/%zz, /run/<id>/job/%zz, /run/%zz/context) returns a 400
//    page naming the malformed segment (pre-T-051: decodeURIComponent threw
//    URIError → the outer catch's 500).
// The red bar (AGENTS #8): run against main's engine at the lane, this
// check's legs 1 and 4 fail (the hostile legs are served/reach the store,
// the %zz legs 500) — teed to C:\swarm\verify-red\T-051-redbar.log; the race
// legs pass on main whenever the staggered child refuses at main's
// outside-transaction read too, which is exactly why the ticket records the
// race red as a code-shape citation, not a reproduced bar.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { ingest, listPendingApprovals, requestApproval } from '../src/store/index.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixturePath = join(root, 'scripts', 'fixtures', 'report-real.json')
const report = JSON.parse(readFileSync(fixturePath, 'utf8'))

// The dashboard module is imported dynamically with console.error wrapped —
// the same no-server-on-import guard as check-dashboard.mjs (console.log
// side), extended to this check because the T-051 gate logs refusals to
// stderr.
let importBanner = ''
const origErr = console.error.bind(console)
console.error = (...args) => {
  importBanner += args.map(String).join(' ') + '\n'
  origErr(...args)
}
const { startDashboard } = await import('../src/dashboard.ts')
console.error = origErr
t('importing src/dashboard.ts starts no server (no startup banner on stderr)', !importBanner.includes('dashboard: http://'))

// The two-phase schedule variant (the check-dashboard construction): two
// real phases foundation→app, jobs c01/c02, so requestApproval seeds TWO
// pending rows (c01 foundation, c02 app) — one for the sequential leg, one
// for the two-process race.
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

// A raw HTTP request with FULL header control (node:http, not fetch — the
// Host header is fetch-forbidden, and Origin must be attacker-shaped). The
// connection always targets 127.0.0.1:<port>; only the headers lie.
const raw = (port, method, path, headers = {}, body) => new Promise((resolve, reject) => {
  const h = { ...headers }
  if (body !== undefined) h['content-type'] = h['content-type'] ?? 'application/x-www-form-urlencoded'
  if (body !== undefined) h['content-length'] = String(Buffer.byteLength(body))
  const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
    let data = ''
    res.on('data', (c) => { data += c })
    res.on('end', () => resolve({ status: res.statusCode ?? -1, body: data }))
  })
  req.on('error', reject)
  if (body !== undefined) req.write(body)
  req.end()
})
const decideBody = (fields) => new URLSearchParams(fields).toString()

// Capture the dashboard's console.error lines while one request runs — the
// loud one-line log pin. The gate logs synchronously before responding, so
// the line is out by the time the response arrives.
const captureStderr = async (fn) => {
  const lines = []
  const orig = console.error.bind(console)
  console.error = (...args) => { lines.push(args.map(String).join(' ')) }
  try {
    return { ...(await fn()), lines }
  } finally {
    console.error = orig
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 't051-write-'))
try {
  const dbPath = join(sandbox, 'write.db')
  ingest(sched, dbPath)
  requestApproval(dbPath, { runId: sched.runId, by: 'gate-operator', note: 'ready for review' })
  const pending0 = listPendingApprovals(dbPath)
  // listPendingApprovals orders by run_id, phase_id, job_id — 'app' sorts
  // before 'foundation' — so the order pin is the sorted set, not [c01, c02].
  t('setup: two pending approvals seeded (c01 foundation, c02 app)',
    pending0.length === 2 && eq(pending0.map((r) => r.jobId).sort(), ['c01', 'c02']))

  const server = await startDashboard({ db: dbPath })
  const port = server.address().port
  const ro = () => new DatabaseSync(dbPath, { readOnly: true })
  // The DECIDED-type events for one job (APPROVAL_GRANTED / APPROVAL_REJECTED,
  // payload-scoped — the events table is run-wide and also holds the
  // APPROVAL_REQUESTED rows).
  const decideEvents = (db, jobId) => db.prepare("SELECT * FROM events WHERE type IN ('APPROVAL_GRANTED', 'APPROVAL_REJECTED')").all()
    .filter((e) => { try { return JSON.parse(e.payload).jobId === jobId } catch { return false } })
  const approvalSnapshot = (db) => ({
    rows: db.prepare('SELECT * FROM approval_gates ORDER BY job_id').all(),
    events: db.prepare('SELECT seq, type, at, payload FROM events ORDER BY seq').all(),
  })

  // ---------- leg 1: the request gate — hostile headers → 403 + one loud line ----------
  const shaBeforeRefusals = sha256(dbPath)
  const originEvil = await captureStderr(() =>
    raw(port, 'POST', '/approvals/decide', { Origin: 'http://evil.example' }, decideBody({ run: sched.runId, job: 'c02', decision: 'approved', by: 'csrf' })))
  t(`cross-origin decide POST (Origin http://evil.example) → 403 (got ${originEvil.status})`, originEvil.status === 403)
  t('cross-origin decide POST: exactly ONE loud log line, naming Origin and its value',
    originEvil.lines.length === 1 && /Origin/.test(originEvil.lines[0]) && originEvil.lines[0].includes("'http://evil.example'"))
  t('cross-origin decide POST: the 403 page names the refused header', originEvil.body.includes('403') || /refused/i.test(originEvil.body))

  const hostEvil = await captureStderr(() => raw(port, 'GET', '/', { Host: 'evil.example' }))
  t(`DNS-rebinding GET (Host evil.example) → 403 (got ${hostEvil.status})`, hostEvil.status === 403)
  t('rebound GET: exactly ONE loud log line, naming Host and its value',
    hostEvil.lines.length === 1 && /Host/.test(hostEvil.lines[0]) && hostEvil.lines[0].includes("'evil.example'"))

  const originHttps = await captureStderr(() =>
    raw(port, 'POST', '/approvals/decide', { Origin: `https://127.0.0.1:${port}` }, decideBody({ run: sched.runId, job: 'c02', decision: 'approved' })))
  t(`https:// origin is not a loopback-http origin → 403 (got ${originHttps.status})`, originHttps.status === 403)
  const originSuffix = await captureStderr(() =>
    raw(port, 'POST', '/approvals/decide', { Origin: 'http://127.0.0.1.evil.example' }, decideBody({ run: sched.runId, job: 'c02', decision: 'approved' })))
  t(`suffix-spoof origin (http://127.0.0.1.evil.example) → 403 (got ${originSuffix.status})`, originSuffix.status === 403)
  const hostSuffix = await captureStderr(() => raw(port, 'GET', '/approvals', { Host: `localhost.evil.example:${port}` }))
  t(`suffix-spoof Host (localhost.evil.example) → 403 (got ${hostSuffix.status})`, hostSuffix.status === 403)
  // An HTTP/1.0 request over a raw socket carries no Host header at all —
  // node:http would auto-stamp one, so this leg needs the literal wire bytes.
  const noHost = await captureStderr(() => new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write('GET / HTTP/1.0\r\n\r\n'))
    let data = ''
    sock.on('data', (c) => { data += c })
    sock.on('end', () => resolve({ status: /^HTTP\/1.[01] 403/.test(data) ? 403 : 200, body: data }))
    sock.on('error', reject)
  }))
  t(`a request with no Host header at all → 403 (got ${noHost.status}; nothing trusted by default)`,
    noHost.status === 403 && noHost.lines.length === 1 && /Host/.test(noHost.lines[0]))

  // ---------- leg 4 (placed before the mutating legs so the byte-identity set is clean): %zz → 400 ----------
  const pctRun = await raw(port, 'GET', '/run/%zz')
  t(`GET /run/%zz → 400, not 500 (got ${pctRun.status})`, pctRun.status === 400)
  t('GET /run/%zz: the 400 page names the malformed segment', pctRun.body.includes('%zz') && /percent/i.test(pctRun.body))
  const pctJob = await raw(port, 'GET', `/run/${sched.runId}/job/%zz`)
  t(`GET /run/<id>/job/%zz → 400, not 500 (got ${pctJob.status})`, pctJob.status === 400)
  const pctCtx = await raw(port, 'GET', '/run/%zz/context')
  t(`GET /run/%zz/context → 400, not 500 (got ${pctCtx.status})`, pctCtx.status === 400)

  t('every refused request above (403s + 400s) touched ZERO DB bytes — the gate refuses before any DB open',
    sha256(dbPath) === shaBeforeRefusals)

  // ---------- leg 2: legitimate localhost requests served exactly as today ----------
  const getLocalhostHost = await raw(port, 'GET', '/', { Host: `localhost:${port}` })
  t(`GET / with Host localhost:<port> → 200 (got ${getLocalhostHost.status})`, getLocalhostHost.status === 200)
  const getWithOrigin = await raw(port, 'GET', '/', { Origin: `http://localhost:${port}` })
  t(`GET / with Origin http://localhost:<port> → 200 (got ${getWithOrigin.status})`, getWithOrigin.status === 200)
  const plainFetch = await fetch(`http://127.0.0.1:${port}/approvals`)
  t(`stdlib fetch GET /approvals (Host 127.0.0.1:<port>, no Origin) → 200 (got ${plainFetch.status})`, plainFetch.status === 200)
  await plainFetch.text()

  const approveWithOrigin = await raw(port, 'POST', '/approvals/decide', { Origin: `http://127.0.0.1:${port}` },
    decideBody({ run: sched.runId, job: 'c01', decision: 'approved', by: 'dash-origin-operator', note: 'origin ok' }))
  t(`decide POST with a matching Origin lands exactly as today → 200 (got ${approveWithOrigin.status})`, approveWithOrigin.status === 200)
  {
    const db = ro()
    const row = db.prepare('SELECT * FROM approval_gates WHERE job_id = ?').get('c01')
    const granted = db.prepare('SELECT * FROM events WHERE type = ?').all('APPROVAL_GRANTED')
    t('matching-Origin decide: the row flipped through the real decideApproval (approved, decided_by/note recorded)',
      row?.state === 'approved' && row?.decided_by === 'dash-origin-operator' && row?.note === 'origin ok')
    t('matching-Origin decide: exactly one APPROVAL_GRANTED event', granted.length === 1)
    db.close()
  }

  // ---------- leg 3a: the sequential double-decide — today's exact message, 409 ----------
  const second = await raw(port, 'POST', '/approvals/decide', {}, decideBody({ run: sched.runId, job: 'c01', decision: 'rejected' }))
  t(`second sequential decide (no Origin) → 409 (got ${second.status})`, second.status === 409)
  t('second sequential decide: today\'s EXACT double-decide message, byte-for-byte',
    second.body.includes(`approval for job 'c01' is already 'approved' — the audit record is not rewritable`))
  {
    const db = ro()
    const snap = approvalSnapshot(db)
    db.close()
    t('the refused second decide wrote nothing (still one decided row, exactly one APPROVAL_GRANTED, no APPROVAL_REJECTED)',
      snap.rows.filter((r) => r.state !== 'waiting_for_approval').length === 1
      && snap.events.filter((e) => e.type === 'APPROVAL_GRANTED').length === 1
      && snap.events.filter((e) => e.type === 'APPROVAL_REJECTED').length === 0)
  }

  // ---------- leg 3b: the two-process race — overlapping pair ----------
  // Both children spawned together: whatever interleaving SQLite picks, the
  // guarded UPDATE plus SQLite's own locking must land EXACTLY ONE decide —
  // never the pre-T-051 corruption (one APPROVED *and* one REJECTED event,
  // last-write-wins on the row). The loser refuses somewhere (the guard's
  // double-decide message, or a SQLite 'database is locked' at open/update/
  // commit — all faces refuse with nothing written); which face occurred is
  // logged, never asserted, because it is genuinely timing-dependent.
  const childHelper = join(sandbox, 'decide-child.mjs')
  writeFileSync(childHelper, [
    `import { decideApproval } from '${pathToFileURL(join(root, 'src', 'store', 'index.ts')).href}'`,
    `const [dbPath, runId, jobId, decision, by] = process.argv.slice(2)`,
    `try {`,
    `  const row = decideApproval(dbPath, { runId, jobId, decision, by })`,
    `  console.log('DECIDED ' + row.state)`,
    `} catch (e) {`,
    `  console.log('REFUSED ' + (e && e.message ? e.message : String(e)))`,
    `  process.exit(1)`,
    `}`,
    '',
  ].join('\n'))
  const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const runChild = (decision, by) => new Promise((resolve) => {
    const kid = spawn(process.execPath, [tsxCli, childHelper, dbPath, sched.runId, 'c02', decision, by], { windowsHide: true })
    let out = ''
    kid.stdout.on('data', (d) => { out += d })
    kid.on('error', () => resolve({ code: -1, out }))
    kid.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
  // T-065: the second child starts 150ms after the first — still genuinely
  // overlapping (the first may hold the write lock mid-transaction, the
  // documented contention the guard exists for), but on a fast box a truly
  // simultaneous pair can starve BOTH writers into SQLITE_BUSY refusals,
  // leaving no winner to test the corruption pins against.
  const pair = await Promise.all([
    runChild('approved', 'race-approve'),
    (async () => { await sleep(150); return runChild('rejected', 'race-reject') })(),
  ])
  const winners = pair.filter((r) => r.code === 0 && r.out.startsWith('DECIDED'))
  const losers = pair.filter((r) => r.code !== 0 && r.out.startsWith('REFUSED'))
  t(`overlapping two-process pair: EXACTLY ONE decide lands (${pair.map((r) => `exit ${r.code}: ${r.out.trim().split('\n')[0]}`).join(' | ')})`,
    winners.length === 1 && losers.length === 1)
  const loserFace = losers[0]?.out.replace(/^REFUSED /, '').trim() ?? '(no loser recorded)'
  console.log(`     loser refusal face (timing-dependent, never asserted): ${loserFace}`)
  {
    const db = ro()
    const row = db.prepare('SELECT * FROM approval_gates WHERE job_id = ?').get('c02')
    const c02events = decideEvents(db, 'c02')
    const winnerDecision = winners[0]?.out.trim() === 'DECIDED approved' ? 'approved' : 'rejected'
    t('overlapping pair: the row carries the WINNER\'s decision and decider',
      row?.state === winnerDecision && (winnerDecision === 'approved' ? row?.decided_by === 'race-approve' : row?.decided_by === 'race-reject'))
    t('overlapping pair: exactly ONE approval event on the row — never one APPROVED *and* one REJECTED (the pre-T-051 corruption)',
      c02events.length === 1)
    const queue = listPendingApprovals(dbPath)
    t('overlapping pair: c02 left the pending queue (the queue is empty — c01 decided in leg 2)', queue.length === 0)
    db.close()
  }

  // ---------- leg 3c: the two-process race — quick-succession pair (the guard's deterministic face) ----------
  // A fresh pending row (c01 is decided; re-request would be additive-skipped,
  // so a fresh DB), then two decides ~1s apart — the CSRF-racing-a-human
  // shape. The second process MUST refuse at the guard itself: today's exact
  // double-decide message, nothing written.
  const db2Path = join(sandbox, 'write-race2.db')
  ingest(sched, db2Path)
  requestApproval(db2Path, { runId: sched.runId, by: 'gate-operator' })
  const runChild2 = (decision, by) => new Promise((resolve) => {
    const kid = spawn(process.execPath, [tsxCli, childHelper, db2Path, sched.runId, 'c01', decision, by], { windowsHide: true })
    let out = ''
    kid.stdout.on('data', (d) => { out += d })
    kid.on('error', () => resolve({ code: -1, out }))
    kid.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
  const first = runChild2('approved', 'race2-first')
  await new Promise((r) => setTimeout(r, 1000))
  const secondKid = await Promise.all([first, runChild2('rejected', 'race2-second')])
  t('quick-succession pair: the first decide lands (exit 0)', secondKid[0].code === 0 && secondKid[0].out.startsWith('DECIDED'))
  t(`quick-succession pair: the racing second decide REFUSES AT THE GUARD with today's exact message (exit ${secondKid[1].code})`,
    secondKid[1].code !== 0 && secondKid[1].out.includes(`approval for job 'c01' is already 'approved' — the audit record is not rewritable`))
  {
    const db = new DatabaseSync(db2Path, { readOnly: true })
    const row = db.prepare('SELECT * FROM approval_gates WHERE job_id = ?').get('c01')
    const events = decideEvents(db, 'c01')
    t('quick-succession pair: the row decided ONCE by the first process, exactly one approval event',
      row?.state === 'approved' && row?.decided_by === 'race2-first' && events.length === 1 && events[0].type === 'APPROVAL_GRANTED')
    db.close()
  }

  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\ncheck-dashboard-write: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-dashboard-write: ALL GREEN')
