// Approval-gate records CLI (T-008) — durable human decisions over the store.
//
//   npm run approvals -- request --run <runId> [--job <jobId>] [--db <path>] [--by <who>] [--note "..."]
//   npm run approvals -- list [--run <runId>] [--db <path>] [--json]
//   npm run approvals -- decide --run <runId> --job <jobId> --decision approved|rejected
//                        [--by <who>] [--db <path>] [--note "..."]
//
// The standalone-entry pattern (tsx src/approvals.ts, like src/clean.ts /
// src/integrate.ts / T-006's src/dag.ts). All approval state is written by
// explicit operator action through this CLI — plain ingest is approval-blind
// and nothing in the run path calls the store's approval writers. Zero
// behavior change to the pipeline; zero model/harness knowledge
// (decisions.md: the engine is harness-agnostic).
//
// Refusals exit non-zero, write nothing, and happen before any write: missing
// DB file (no subcommand ever creates a refinery.db as a side effect — the
// T-006 refusal pattern), unknown runId, unknown/non-survivor job (gates
// decide survival — an approval must not resurrect an eliminated candidate),
// double-decide (the audit record is not rewritable; the refusal names the
// current state), unknown --decision value, missing flags. `list` is
// read-only: the DB opens readOnly and the file is never touched.
import { existsSync } from 'node:fs'
import { decideApproval, listPendingApprovals, requestApproval } from './store/index.js'

const usage = `Approval-gate records over the durable run store (T-008).

Usage:
  npm run approvals -- request --run <runId> [options]
  npm run approvals -- list [options]
  npm run approvals -- decide --run <runId> --job <jobId> --decision approved|rejected [options]

Subcommands:
  request  Record waiting_for_approval for the finished run's survivors
           (jobs whose candidate passed all gates). --job narrows to a single
           job; an eliminated candidate is refused — gates decide survival.
           Jobs already carrying an approval record are skipped, not
           re-requested (writes are additive-only).
  list     The pending-approval queue: rows in waiting_for_approval. Read-only.
  decide   Record approved/rejected on one pending approval. The audit record
           is not rewritable: a decided row refuses further decisions.

Options:
  --run <runId>         Run to operate on (required for request/decide;
                        optional filter for list)
  --job <jobId>         One job (= candidate id) (required for decide)
  --decision <value>    approved | rejected (required for decide)
  --by <who>            Who acts (default: the OS username)
  --note <text>         A note recorded on the row (decide replaces the
                        row's note only when provided)
  --db <path>           SQLite DB holding the durable run records (default:
                        C:\\swarm\\refinery.db)
  --json                list only: emit the same structure as JSON
  --help                Show this help

Refusals exit non-zero and write nothing: missing DB file, unknown runId,
unknown or non-survivor job, double-decide, unknown --decision, missing
flags. Nothing automated consumes a decision this slice — the value is the
durable decision record and the queue.`

interface BaseOptions {
  run: string | null
  job: string | null
  decision: string | null
  by: string | null
  note: string | null
  db: string
  json: boolean
}

function refuse(message: string): never {
  console.error(`refused: ${message}`)
  process.exit(1)
}

function parseArgs(argv: string[]): { subcommand: string; opts: BaseOptions } {
  const subcommand = argv[0]
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(usage)
    process.exit(subcommand === undefined ? 1 : 0)
  }
  if (subcommand !== 'request' && subcommand !== 'list' && subcommand !== 'decide') {
    refuse(`unknown subcommand '${subcommand}' (expected request|list|decide)\n\n${usage}`)
  }
  const opts: BaseOptions = { run: null, job: null, decision: null, by: null, note: null, db: 'C:\\swarm\\refinery.db', json: false }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) refuse(`missing value for ${arg}`)
      return v!
    }
    switch (arg) {
      case '--run': opts.run = value(); break
      case '--job': opts.job = value(); break
      case '--decision': opts.decision = value(); break
      case '--by': opts.by = value(); break
      case '--note': opts.note = value(); break
      case '--db': opts.db = value(); break
      case '--json': opts.json = true; break
      case '--help': case '-h': console.log(usage); process.exit(0); break
      default: refuse(`unknown option: ${arg}\n\n${usage}`)
    }
  }
  return { subcommand, opts }
}

function main(): void {
  const { subcommand, opts } = parseArgs(process.argv.slice(2))
  // Before anything is opened: a subcommand must never create an empty
  // refinery.db as a side effect (the T-006 refusal pattern).
  if (!existsSync(opts.db)) refuse(`no database at ${opts.db} (ingest creates it; approvals never do)`)

  if (subcommand === 'request') {
    if (!opts.run) refuse(`--run <runId> is required\n\n${usage}`)
    const rows = requestApproval(opts.db, { runId: opts.run, jobId: opts.job ?? undefined, by: opts.by ?? undefined, note: opts.note ?? undefined })
    if (rows.length === 0) {
      console.log(`nothing to request${opts.job ? ` for job '${opts.job}'` : ''} — already carried an approval record (additive-only, nothing rewritten)`)
    } else {
      console.log(`requested approval for ${rows.length} job(s) of run ${opts.run}:`)
      for (const r of rows) {
        console.log(`  ${r.phaseId}/${r.jobId}  state=${r.state}  requested_at=${r.requestedAt}  requested_by=${r.requestedBy}${r.note ? `  note=${r.note}` : ''}`)
      }
    }
    return
  }

  if (subcommand === 'decide') {
    if (!opts.run) refuse(`--run <runId> is required\n\n${usage}`)
    if (!opts.job) refuse(`--job <jobId> is required\n\n${usage}`)
    if (!opts.decision) refuse(`--decision approved|rejected is required\n\n${usage}`)
    if (opts.decision !== 'approved' && opts.decision !== 'rejected') {
      refuse(`unknown --decision '${opts.decision}' (expected approved|rejected)`)
    }
    const row = decideApproval(opts.db, {
      runId: opts.run,
      jobId: opts.job,
      decision: opts.decision,
      by: opts.by ?? undefined,
      note: opts.note ?? undefined,
    })
    console.log(`${row.phaseId}/${row.jobId} of run ${opts.run}: ${row.state}`)
    console.log(`  decided_at=${row.decidedAt}  decided_by=${row.decidedBy}${row.note ? `  note=${row.note}` : ''}`)
    return
  }

  // list — the pending-approval queue. Read-only: readOnly open (list and
  // its --json form never write; Gate 1.9 pins the file byte-identical).
  if (opts.decision !== null) refuse(`--decision belongs to 'decide'; 'list' takes no decision`)
  const pending = listPendingApprovals(opts.db, opts.run ?? undefined)
  if (opts.json) {
    console.log(JSON.stringify(pending, null, 2))
    return
  }
  if (pending.length === 0) {
    console.log(`no pending approvals${opts.run ? ` for run ${opts.run}` : ''}.`)
    return
  }
  console.log(`pending approvals (${pending.length})${opts.run ? ` for run ${opts.run}` : ''}:`)
  for (const r of pending) {
    console.log(`  ${r.runId}  ${r.phaseId}/${r.jobId}  state=${r.state}  requested_at=${r.requestedAt}  requested_by=${r.requestedBy}${r.note ? `  note=${r.note}` : ''}`)
  }
}

try {
  main()
} catch (e: unknown) {
  console.error(`refused: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}
