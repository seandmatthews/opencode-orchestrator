// Approvals self-check (Gate 1.9, fast tier, T-008) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-approvals.mjs
// Pins the approval-gate slice against the vendored fixture
// (scripts/fixtures/report-real.json) ingested into fresh temp DBs, driving
// ingest and the new CLI (src/approvals.ts) as separate subprocess
// invocations — state must live in the DB, not in any process. Pins: plain
// ingest is approval-blind, request records one row + one event per survivor
// (--job narrows), approve/reject transitions with their events, rejection
// corrupting nothing (full-table before/after + integrity_check), the queue
// view (text + --json), read-only list (DB byte-identical), every refusal
// (exit non-zero, nothing on stdout, no DB side effects), and the documented
// wall-clock scoping (approval stamps are ISO wall-clock, report-derived
// stamps stay deterministic) — all without model tokens.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
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
// ISO-8601 and NOT report-derived (the report is dated 2026-10-11; a
// wall-clock stamp from today parses and differs).
const isWallClock = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s) && s !== report.startedAt

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const approvalsTs = join(root, 'src', 'approvals.ts')
const fixturePath = join(root, 'scripts', 'fixtures', 'report-real.json')
const report = JSON.parse(readFileSync(fixturePath, 'utf8'))

// Every invocation is its own process: request, decide, and list share
// nothing but the DB file — the exercisable form of "survives orchestrator
// restart" today (the paused-execution form is carved, T-008's What).
const runApprovals = (args) => {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [tsxCli, approvalsTs, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message) }
  }
}

// The elim-variant (check-store's pattern): c02's build gate fails, so c02 is
// eliminated and only c01 survives — the non-survivor refusal needs a run
// whose survivor set is not "everyone".
const elim = structuredClone(report)
const victim = elim.candidates[1]
victim.gates[0].passed = false
victim.gates[0].exitCode = 1
victim.passedAllGates = false

const openDb = (p) => new DatabaseSync(p)
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
const approvalEvents = (db, type) => db.prepare('SELECT seq, type, at, payload FROM events WHERE type = ? ORDER BY seq').all(type)
const snapshot = (db, runId) => ({
  runs: db.prepare('SELECT * FROM runs WHERE run_id = ?').all(runId),
  candidates: db.prepare('SELECT * FROM candidates WHERE run_id = ? ORDER BY candidate_id').all(runId),
  gateResults: db.prepare('SELECT * FROM gate_results WHERE run_id = ? ORDER BY candidate_id, gate_name').all(runId),
  events: db.prepare('SELECT seq, type, at, payload FROM events ORDER BY seq').all(),
})

const sandbox = mkdtempSync(join(tmpdir(), 't008-approvals-'))
try {
  // ---------- AC: plain ingest is approval-blind ----------
  const dbMainPath = join(sandbox, 'main.db')
  ingest(report, dbMainPath)
  const dbMain = openDb(dbMainPath)
  t('plain ingest: zero approval_gates rows', count(dbMain, 'approval_gates') === 0)
  t('plain ingest: no approval events of any kind',
    dbMain.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'APPROVAL%'").get().n === 0)
  t('plain ingest: report-derived stamps stay deterministic (RUN_CREATED at startedAt)',
    dbMain.prepare("SELECT at FROM events WHERE type = 'RUN_CREATED'").get().at === report.startedAt)

  // ---------- AC: request records the queue (one row + one event per survivor) ----------
  const req = runApprovals(['request', '--run', report.runId, '--db', dbMainPath, '--by', 'gate-operator', '--note', 'ready for human review'])
  t(`request against an ingested DB exits 0 (got ${req.code})`, req.code === 0)
  t('request stdout names both survivors', req.stdout.includes('c01') && req.stdout.includes('c02'))
  const rows = dbMain.prepare('SELECT * FROM approval_gates ORDER BY job_id').all()
  t('exactly one approval_gates row per surviving candidate (both fixture candidates survive)',
    rows.length === report.candidates.length)
  for (const c of report.candidates) {
    const row = dbMain.prepare('SELECT * FROM approval_gates WHERE run_id = ? AND job_id = ?').get(report.runId, c.id)
    t(`${c.id}: keyed (run_id, phase_id, job_id) with phase_id from T-006's derived phase, state waiting_for_approval`,
      row?.run_id === report.runId && row?.phase_id === 'main' && row?.job_id === c.id
      && row?.state === 'waiting_for_approval')
    t(`${c.id}: requested_at is wall-clock ISO-8601, not report-derived`, isWallClock(row?.requested_at))
    t(`${c.id}: requested_by recorded, decided_* still null`,
      row?.requested_by === 'gate-operator' && row?.decided_at == null && row?.decided_by == null)
    t(`${c.id}: note recorded`, row?.note === 'ready for human review')
  }
  const requestedEvents = approvalEvents(dbMain, 'APPROVAL_REQUESTED')
  t('exactly one APPROVAL_REQUESTED event per requested row', requestedEvents.length === rows.length)
  for (const c of report.candidates) {
    const ev = requestedEvents.find((e) => JSON.parse(e.payload).jobId === c.id)
    const row = dbMain.prepare('SELECT * FROM approval_gates WHERE job_id = ?').get(c.id)
    t(`${c.id}: APPROVAL_REQUESTED payload names phase/job/requester and at is the row's wall-clock stamp`,
      ev !== undefined && eq(JSON.parse(ev.payload), { phaseId: 'main', jobId: c.id, requestedBy: 'gate-operator' })
      && ev.at === row?.requested_at && isWallClock(ev.at))
  }

  // ---------- AC: the record survives process death + the queue view ----------
  const hashBeforeReads = sha256(dbMainPath)
  const list1 = runApprovals(['list', '--run', report.runId, '--db', dbMainPath])
  t(`list (its own process) sees the state the request process persisted, exits 0 (got ${list1.code})`,
    list1.code === 0 && report.candidates.every((c) => list1.stdout.includes(c.id)))
  t('list prints pending rows as waiting_for_approval', list1.stdout.includes('waiting_for_approval'))
  const listJson1 = runApprovals(['list', '--run', report.runId, '--db', dbMainPath, '--json'])
  t(`list --json exits 0 (got ${listJson1.code})`, listJson1.code === 0)
  const queue = JSON.parse(listJson1.stdout)
  t('--json emits the same structure as JSON (one pending row per survivor)',
    Array.isArray(queue) && queue.length === report.candidates.length
    && report.candidates.every((c) => queue.some((r) => r.runId === report.runId && r.phaseId === 'main'
      && r.jobId === c.id && r.state === 'waiting_for_approval' && typeof r.requestedAt === 'string'
      && r.requestedBy === 'gate-operator' && r.note === 'ready for human review')))

  // ---------- AC: read-only views never write ----------
  t('DB byte-identical after list and list --json', sha256(dbMainPath) === hashBeforeReads)

  // ---------- AC: approve transitions per §21 ----------
  const approve = runApprovals(['decide', '--run', report.runId, '--job', 'c01', '--decision', 'approved', '--db', dbMainPath, '--by', 'decide-operator'])
  t(`decide --decision approved exits 0 (got ${approve.code})`, approve.code === 0)
  const approvedRow = dbMain.prepare('SELECT * FROM approval_gates WHERE job_id = ?').get('c01')
  t('approved: row flips to approved with decided_at/decided_by recorded',
    approvedRow?.state === 'approved' && isWallClock(approvedRow?.decided_at) && approvedRow?.decided_by === 'decide-operator')
  const grantedEvents = approvalEvents(dbMain, 'APPROVAL_GRANTED')
  t('approved: exactly one APPROVAL_GRANTED event, at the decided_at stamp, payload naming phase/job/decider',
    grantedEvents.length === 1 && grantedEvents[0]?.at === approvedRow?.decided_at
    && eq(JSON.parse(grantedEvents[0]?.payload), { phaseId: 'main', jobId: 'c01', decidedBy: 'decide-operator' }))
  const list2 = runApprovals(['list', '--run', report.runId, '--db', dbMainPath])
  t('after approve, the decided row drops out of the default queue (its own process sees only c02 pending)',
    list2.code === 0 && list2.stdout.includes('c02') && !list2.stdout.includes('c01'))

  // ---------- AC: reject transitions + the documented event extension ----------
  const before = snapshot(dbMain, report.runId)
  const reject = runApprovals(['decide', '--run', report.runId, '--job', 'c02', '--decision', 'rejected', '--db', dbMainPath, '--by', 'reject-operator'])
  t(`decide --decision rejected exits 0 (got ${reject.code})`, reject.code === 0)
  const rejectedRow = dbMain.prepare('SELECT * FROM approval_gates WHERE job_id = ?').get('c02')
  t('rejected: row flips to rejected with decided_at/decided_by recorded',
    rejectedRow?.state === 'rejected' && isWallClock(rejectedRow?.decided_at) && rejectedRow?.decided_by === 'reject-operator')
  const rejectedEvents = approvalEvents(dbMain, 'APPROVAL_REJECTED')
  t('rejected: exactly one APPROVAL_REJECTED event (the documented vocabulary extension), at the decided_at stamp',
    rejectedEvents.length === 1 && rejectedEvents[0]?.at === rejectedRow?.decided_at
    && eq(JSON.parse(rejectedEvents[0]?.payload), { phaseId: 'main', jobId: 'c02', decidedBy: 'reject-operator' }))

  // ---------- AC: rejection corrupts nothing (full-table comparisons) ----------
  const after = snapshot(dbMain, report.runId)
  t('after reject: runs rows value-identical', eq(after.runs, before.runs))
  t('after reject: candidates rows value-identical', eq(after.candidates, before.candidates))
  t('after reject: gate_results rows value-identical', eq(after.gateResults, before.gateResults))
  t('after reject: every prior event row (seq, type, at, payload) unchanged, exactly one appended',
    after.events.length === before.events.length + 1 && eq(after.events.slice(0, before.events.length), before.events)
    && after.events[after.events.length - 1]?.type === 'APPROVAL_REJECTED')
  t('after reject: PRAGMA integrity_check ok', dbMain.prepare('PRAGMA integrity_check').get()['integrity_check'] === 'ok')
  const list3 = runApprovals(['list', '--run', report.runId, '--db', dbMainPath])
  t('after reject: the default queue is empty, exit 0', list3.code === 0 && /no pending approvals/.test(list3.stdout))

  // ---------- AC: double-decide refuses, naming the current state ----------
  const reApprove = runApprovals(['decide', '--run', report.runId, '--job', 'c01', '--decision', 'approved', '--db', dbMainPath])
  t(`double-decide (already approved) exits non-zero (got ${reApprove.code})`, reApprove.code !== 0)
  t('double-decide: nothing on stdout', reApprove.stdout.trim() === '')
  t('double-decide: refusal names the current state', /already 'approved'/.test(reApprove.stderr))
  const reReject = runApprovals(['decide', '--run', report.runId, '--job', 'c02', '--decision', 'rejected', '--db', dbMainPath])
  t(`double-decide (already rejected) exits non-zero (got ${reReject.code})`, reReject.code !== 0)
  t('double-decide (rejected): refusal names the current state', /already 'rejected'/.test(reReject.stderr))
  t('double-decides wrote nothing (still exactly one GRANTED/REJECTED event each)',
    approvalEvents(dbMain, 'APPROVAL_GRANTED').length === 1 && approvalEvents(dbMain, 'APPROVAL_REJECTED').length === 1)
  dbMain.close()

  // ---------- AC: --job narrows to one; the requested_by default ----------
  const dbJobPath = join(sandbox, 'job.db')
  ingest(report, dbJobPath)
  const reqOne = runApprovals(['request', '--run', report.runId, '--job', 'c01', '--db', dbJobPath])
  t(`request --job narrows to a single job, exits 0 (got ${reqOne.code})`, reqOne.code === 0)
  const dbJob = openDb(dbJobPath)
  t('--job: exactly one row (c01), none for c02',
    dbJob.prepare('SELECT COUNT(*) AS n FROM approval_gates').get().n === 1
    && dbJob.prepare('SELECT COUNT(*) AS n FROM approval_gates WHERE job_id = ?').get('c02').n === 0)
  const jobRow = dbJob.prepare('SELECT * FROM approval_gates WHERE job_id = ?').get('c01')
  t('--job: requested_by defaults to the OS username', jobRow?.requested_by === userInfo().username)
  t('--job: exactly one APPROVAL_REQUESTED event', approvalEvents(dbJob, 'APPROVAL_REQUESTED').length === 1)
  const decideUnrequested = runApprovals(['decide', '--run', report.runId, '--job', 'c02', '--decision', 'approved', '--db', dbJobPath])
  t(`decide on a survivor with no recorded request refuses (got ${decideUnrequested.code})`, decideUnrequested.code !== 0)
  t('decide without a request: refusal names the missing request', /no approval request recorded/.test(decideUnrequested.stderr))
  dbJob.close()

  // ---------- AC: survivors only; non-survivor and unknown-job refusals ----------
  const dbElimPath = join(sandbox, 'elim.db')
  ingest(elim, dbElimPath)
  const reqSurvivors = runApprovals(['request', '--run', elim.runId, '--db', dbElimPath])
  t(`request on a run with an eliminated candidate exits 0 (got ${reqSurvivors.code})`, reqSurvivors.code === 0)
  const dbElim = openDb(dbElimPath)
  t('request records rows for survivors only (c01, not the eliminated c02)',
    dbElim.prepare('SELECT COUNT(*) AS n FROM approval_gates').get().n === 1
    && dbElim.prepare('SELECT COUNT(*) AS n FROM approval_gates WHERE job_id = ?').get('c01').n === 1
    && dbElim.prepare('SELECT COUNT(*) AS n FROM approval_gates WHERE job_id = ?').get('c02').n === 0)
  dbElim.close()
  const reqEliminated = runApprovals(['request', '--run', elim.runId, '--job', 'c02', '--db', dbElimPath])
  t(`request for an eliminated candidate exits non-zero (got ${reqEliminated.code})`, reqEliminated.code !== 0)
  t('request non-survivor: nothing on stdout', reqEliminated.stdout.trim() === '')
  t('request non-survivor: refusal names the resurrect rule', /not a survivor/.test(reqEliminated.stderr) && /resurrect/.test(reqEliminated.stderr))
  const decideEliminated = runApprovals(['decide', '--run', elim.runId, '--job', 'c02', '--decision', 'approved', '--db', dbElimPath])
  t(`decide for an eliminated candidate exits non-zero (got ${decideEliminated.code})`, decideEliminated.code !== 0)
  t('decide non-survivor: refusal names the resurrect rule', /not a survivor/.test(decideEliminated.stderr))
  const decideUnknownJob = runApprovals(['decide', '--run', elim.runId, '--job', 'c99', '--decision', 'approved', '--db', dbElimPath])
  t(`decide for an unknown job exits non-zero (got ${decideUnknownJob.code})`, decideUnknownJob.code !== 0)
  t("decide unknown job: refusal names the offense", /no candidate 'c99'/.test(decideUnknownJob.stderr))
  const dbElimCheck = openDb(dbElimPath)
  t('non-survivor/unknown refusals wrote nothing (still 1 row, 1 APPROVAL_REQUESTED event)',
    dbElimCheck.prepare('SELECT COUNT(*) AS n FROM approval_gates').get().n === 1
    && approvalEvents(dbElimCheck, 'APPROVAL_REQUESTED').length === 1)
  dbElimCheck.close()

  // ---------- AC: unknown runId ----------
  const dbUnkPath = join(sandbox, 'unknown.db')
  ingest(report, dbUnkPath)
  const reqUnknownRun = runApprovals(['request', '--run', '19990101000000', '--db', dbUnkPath])
  t(`request for an unknown runId exits non-zero (got ${reqUnknownRun.code})`, reqUnknownRun.code !== 0)
  t('request unknown runId: refusal names it', /no recorded run/.test(reqUnknownRun.stderr))
  const decideUnknownRun = runApprovals(['decide', '--run', '19990101000000', '--job', 'c01', '--decision', 'approved', '--db', dbUnkPath])
  t(`decide for an unknown runId exits non-zero (got ${decideUnknownRun.code})`, decideUnknownRun.code !== 0)
  t('decide unknown runId: refusal names it', /no recorded run/.test(decideUnknownRun.stderr))
  const dbUnkCheck = openDb(dbUnkPath)
  t('unknown-runId refusals wrote nothing (zero approval rows/events)',
    dbUnkCheck.prepare('SELECT COUNT(*) AS n FROM approval_gates').get().n === 0
    && dbUnkCheck.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'APPROVAL%'").get().n === 0)
  dbUnkCheck.close()

  // ---------- AC: missing DB file — no empty DB created as a side effect ----------
  const absentDb = join(sandbox, 'absent.db')
  for (const [label, args] of [
    ['request', ['request', '--run', report.runId, '--db', absentDb]],
    ['list', ['list', '--db', absentDb]],
    ['decide', ['decide', '--run', report.runId, '--job', 'c01', '--decision', 'approved', '--db', absentDb]],
  ]) {
    const r = runApprovals(args)
    t(`${label} against a missing DB file exits non-zero (got ${r.code})`, r.code !== 0)
    t(`${label} missing DB: nothing on stdout`, r.stdout.trim() === '')
    t(`${label} missing DB: no empty DB created as a side effect`, !existsSync(absentDb))
  }

  // ---------- AC: missing flags and bad values ----------
  const dbFlagPath = join(sandbox, 'flags.db')
  ingest(report, dbFlagPath)
  const noRun = runApprovals(['request', '--db', dbFlagPath])
  t(`request without --run exits non-zero (got ${noRun.code})`, noRun.code !== 0)
  t('request without --run: refusal names the requirement', /--run/.test(noRun.stderr))
  const noJob = runApprovals(['decide', '--run', report.runId, '--db', dbFlagPath, '--decision', 'approved'])
  t(`decide without --job exits non-zero (got ${noJob.code})`, noJob.code !== 0)
  t('decide without --job: refusal names the requirement', /--job/.test(noJob.stderr))
  const noDecision = runApprovals(['decide', '--run', report.runId, '--job', 'c01', '--db', dbFlagPath])
  t(`decide without --decision exits non-zero (got ${noDecision.code})`, noDecision.code !== 0)
  t('decide without --decision: refusal names the requirement', /--decision/.test(noDecision.stderr))
  const badDecision = runApprovals(['decide', '--run', report.runId, '--job', 'c01', '--decision', 'maybe', '--db', dbFlagPath])
  t(`decide with an unknown --decision exits non-zero (got ${badDecision.code})`, badDecision.code !== 0)
  t('unknown --decision: refusal names the value and the vocabulary', /unknown --decision 'maybe'/.test(badDecision.stderr) && /approved\|rejected/.test(badDecision.stderr))
  const badSub = runApprovals(['frobnicate', '--db', dbFlagPath])
  t(`unknown subcommand exits non-zero (got ${badSub.code})`, badSub.code !== 0)
  const dbFlagCheck = openDb(dbFlagPath)
  t('flag/bad-value refusals wrote nothing (zero approval rows)',
    dbFlagCheck.prepare('SELECT COUNT(*) AS n FROM approval_gates').get().n === 0)
  dbFlagCheck.close()

  // ---------- readOnly is enforced at the API level ----------
  // Guards the open option against node:sqlite churn across Node minors
  // (Known issues #7) — same check as Gate 1.7.
  const db = new DatabaseSync(dbFlagPath, { readOnly: true })
  let refusedWrite = false
  try {
    db.exec("INSERT INTO approval_gates VALUES ('x', 'main', 'cx', 'waiting_for_approval', 'at', 'by', NULL, NULL, NULL)")
  } catch {
    refusedWrite = true
  }
  db.close()
  t('a write against a readOnly-opened DB throws (the option is honored)', refusedWrite)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\ncheck-approvals: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-approvals: ALL GREEN')
