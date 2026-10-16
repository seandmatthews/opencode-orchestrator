// Dag-dump self-check (Gate 1.7, fast tier, T-006) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-dag.mjs
// Pins the read-only dump CLI (src/dag.ts) against the vendored fixture
// ingested into a fresh temp DB: --json structure, text body, every refusal
// (exit non-zero, no DAG body on stdout, no empty DB created as a side
// effect), and proof the dump never writes (DB byte-identical, a write
// against a readOnly-opened handle throws) — without model tokens.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const dagTs = join(root, 'src', 'dag.ts')
const fixturePath = join(root, 'scripts', 'fixtures', 'report-real.json')
const report = JSON.parse(readFileSync(fixturePath, 'utf8'))

const runDag = (args) => {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [tsxCli, dagTs, ...args], { encoding: 'utf8', windowsHide: true }), stderr: '' }
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message) }
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 't006-dag-'))
try {
  const dbPath = join(sandbox, 'refinery.db')
  ingest(report, dbPath)
  const shaBefore = sha256(dbPath)

  // ---------- the happy path: text dump ----------
  const text = runDag(['--run', report.runId, '--db', dbPath])
  t(`--run against an ingested DB exits 0 (got ${text.code})`, text.code === 0)
  t('text dump names the run', text.stdout.includes(report.runId))
  t('text dump has phases, jobs, and edges sections',
    /phases \(\d+\):/.test(text.stdout) && /jobs \(\d+\):/.test(text.stdout) && /edges \(\d+\):/.test(text.stdout))
  t('text dump prints the derived phase', text.stdout.includes('main'))
  t('text dump prints every candidate job', report.candidates.every((c) => text.stdout.includes(c.id)))
  t('text dump prints the (empty) dependency edges', text.stdout.includes('(none)'))

  // ---------- --json: the same structure as JSON ----------
  const json = runDag(['--run', report.runId, '--db', dbPath, '--json'])
  t(`--json exits 0 (got ${json.code})`, json.code === 0)
  const dump = JSON.parse(json.stdout)
  t('json: runId matches', dump.runId === report.runId)
  t('json: exactly one phase (main) with no dependencies',
    dump.phases.length === 1 && dump.phases[0]?.phaseId === 'main' && eq(dump.phases[0]?.dependencies, []))
  const byId = new Map(dump.jobs.map((j) => [j.jobId, j]))
  t('json: one job per candidate — job_id = candidate id, worker/model/brief verbatim, empty dependencies',
    dump.jobs.length === report.candidates.length
    && report.candidates.every((c) => {
      const j = byId.get(c.id)
      return j?.phaseId === 'main' && j?.workerId === c.workerId && j?.model === c.model
        && j?.brief === c.brief && eq(j?.dependencies, [])
    }))
  t('json: zero edges', eq(dump.edges, []))

  // ---------- the dump never writes ----------
  t('DB byte-identical after both dumps', sha256(dbPath) === shaBefore)

  // ---------- refusals: non-zero, no DAG body on stdout ----------
  const unknown = runDag(['--run', '19990101000000', '--db', dbPath])
  t(`unknown runId exits non-zero (got ${unknown.code})`, unknown.code !== 0)
  t('unknown runId: no DAG body on stdout', unknown.stdout.trim() === '')
  t('unknown runId: refusal names the offense', /no recorded run/i.test(unknown.stderr))

  const missingDb = join(sandbox, 'absent.db')
  const noDb = runDag(['--run', report.runId, '--db', missingDb])
  t(`missing DB file exits non-zero (got ${noDb.code})`, noDb.code !== 0)
  t('missing DB file: no DAG body on stdout', noDb.stdout.trim() === '')
  t('missing DB file: the dump created no empty DB as a side effect', !existsSync(missingDb))

  const noRun = runDag(['--db', dbPath])
  t(`missing --run exits non-zero (got ${noRun.code})`, noRun.code !== 0)
  t('missing --run: no DAG body on stdout', noRun.stdout.trim() === '')
  t('missing --run: refusal names the requirement', /--run/.test(noRun.stderr))

  // ---------- readOnly is enforced at the API level ----------
  // Guards the open option itself against node:sqlite churn across Node
  // minors (VERIFICATION.md Known issues #7): if the option name were ever
  // dropped, the write below would succeed and this check would fail.
  const db = new DatabaseSync(dbPath, { readOnly: true })
  let refusedWrite = false
  try {
    db.exec("INSERT INTO phases VALUES ('x', 'y', '[]', NULL, NULL, NULL)")
  } catch {
    refusedWrite = true
  }
  db.close()
  t('a write against a readOnly-opened DB throws (the option is honored)', refusedWrite)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\ncheck-dag: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-dag: ALL GREEN')
