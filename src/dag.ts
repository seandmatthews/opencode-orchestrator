// Read-only dump of a run's job DAG (T-006) — the repo's first DB readback.
//
//   npm run dag -- --run <runId> [--db <path>] [--json]
//
// Post-hoc inspection of what ingest (src/store/index.ts) already recorded:
// the dump never writes — the DB opens readOnly — and never influences
// verdicts (decisions.md: machine gates decide survival). Refusals exit
// non-zero and print no DAG body (the T-005 refusal pattern): missing --run,
// a DB file that does not exist (a dump must never create an empty
// refinery.db as a side effect), a runId with no rows.
import { defaultStoreDb } from './run-root.js'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const usage = `Dump a run's job DAG (read-only).

Usage:
  npm run dag -- --run <runId> [options]

Options:
  --run <runId>    Run to dump (required)
  --db <path>      SQLite DB holding the durable run records (default:
                   ${defaultStoreDb()})
  --json           Emit the same structure as JSON
  --help           Show this help

Prints the run's phases, jobs, and dependency edges. Refusals exit non-zero
and print no DAG body: unknown runId, missing DB file, missing --run. The
database is opened read-only; the dump never writes.`

interface Options {
  run: string
  db: string
  json: boolean
}

function parseArgs(argv: string[]): Options {
  const opts: { run: string | null; db: string; json: boolean } = { run: null, db: defaultStoreDb(), json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${arg}`)
      return v
    }
    switch (arg) {
      case '--run': opts.run = value(); break
      case '--db': opts.db = value(); break
      case '--json': opts.json = true; break
      case '--help': case '-h': console.log(usage); process.exit(0)
      default: throw new Error(`unknown option: ${arg}\n\n${usage}`)
    }
  }
  if (!opts.run) throw new Error(`--run <runId> is required\n\n${usage}`)
  return { run: opts.run, db: opts.db, json: opts.json }
}

function refuse(message: string): never {
  console.error(`refused: ${message}`)
  process.exit(1)
}

interface DagDump {
  runId: string
  phases: { phaseId: string; dependencies: string[] }[]
  jobs: { jobId: string; phaseId: string; workerId: string; model: string; brief: string; dependencies: string[] }[]
  edges: { jobId: string; dependsOnJobId: string }[]
}

function openReadOnly(dbPath: string): DatabaseSync {
  try {
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch (e) {
    return refuse(`cannot open ${dbPath} read-only: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function readDag(db: DatabaseSync, runId: string): DagDump {
  const phases = db
    .prepare('SELECT phase_id, dependencies_json FROM phases WHERE run_id = ? ORDER BY phase_id')
    .all(runId)
    .map((r) => ({ phaseId: r.phase_id as string, dependencies: JSON.parse((r.dependencies_json as string | null) ?? '[]') }))
  const jobs = db
    .prepare('SELECT job_id, phase_id, worker_id, model, brief, dependencies_json FROM jobs WHERE run_id = ? ORDER BY job_id')
    .all(runId)
    .map((r) => ({
      jobId: r.job_id as string,
      phaseId: r.phase_id as string,
      workerId: r.worker_id as string,
      model: r.model as string,
      brief: r.brief as string,
      dependencies: JSON.parse((r.dependencies_json as string | null) ?? '[]'),
    }))
  const edges = db
    .prepare('SELECT job_id, depends_on_job_id FROM job_dependencies WHERE run_id = ? ORDER BY job_id, depends_on_job_id')
    .all(runId)
    .map((r) => ({ jobId: r.job_id as string, dependsOnJobId: r.depends_on_job_id as string }))
  return { runId, phases, jobs, edges }
}

function printText(dump: DagDump, dbPath: string): void {
  console.log(`run ${dump.runId} (db: ${dbPath})`)
  console.log('')
  console.log(`phases (${dump.phases.length}):`)
  for (const p of dump.phases) {
    console.log(`  ${p.phaseId}  dependencies: ${p.dependencies.length === 0 ? '(none)' : p.dependencies.join(', ')}`)
  }
  console.log(`jobs (${dump.jobs.length}):`)
  for (const j of dump.jobs) {
    console.log(
      `  ${j.jobId}  phase=${j.phaseId}  worker=${j.workerId}  model=${j.model}` +
      `  dependencies: ${j.dependencies.length === 0 ? '(none)' : j.dependencies.join(', ')}`,
    )
  }
  console.log(`edges (${dump.edges.length}): ${dump.edges.length === 0 ? '(none)' : ''}`)
  for (const e of dump.edges) {
    console.log(`  ${e.jobId} -> ${e.dependsOnJobId}`)
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  // Refusals before anything is opened or printed: a dump must never create
  // an empty refinery.db as a side effect, so the existence check precedes
  // the open (readOnly would refuse to create it anyway — belt and braces).
  if (!existsSync(opts.db)) refuse(`no database at ${opts.db} (ingest creates it; a dump never does)`)

  const db = openReadOnly(opts.db)
  let dump: DagDump
  try {
    dump = readDag(db, opts.run)
  } finally {
    db.close()
  }
  if (dump.phases.length === 0 && dump.jobs.length === 0) {
    refuse(`no recorded run '${opts.run}' in ${opts.db}`)
  }

  if (opts.json) console.log(JSON.stringify(dump, null, 2))
  else printText(dump, opts.db)
}

try {
  main()
} catch (e: unknown) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
