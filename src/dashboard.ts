// Run dashboard (T-034 first slice; T-035 per-job drill-down) — a local,
// read-only HTTP view over the recorded store (spec §26.1 run overview,
// §26.2 DAG view plus its node-click drill-down's store-backed text/table
// slice, §26.6 approval queue; ROADMAP stage 7, spec §34 Milestone 7).
//
//   npm run dashboard -- [--port <port>] [--db <path>]
//
// The standalone-entry pattern (src/clean.ts / src/dag.ts / src/approvals.ts).
// A consumer of recorded state ONLY: it knows no harness, spawns no models,
// spawns no processes, and touches no repository (decisions.md 2026-10-10:
// the engine is harness-agnostic; gates decide survival — the dashboard
// renders recorded verdicts and produces none). Zero new npm dependencies:
// plain `node:http` for serving plus the store's own `node:sqlite` reads;
// the only store functions reused verbatim are the approval queue/decide
// pair (`listPendingApprovals` / `decideApproval`); every other table is
// read with direct SELECTs through a `readOnly` open (the src/dag.ts:69-98
// pattern). Binds 127.0.0.1 only; no auth — operator-local tooling, the
// same trust domain as the CLI precursors.
//
// What this page does NOT claim — stated, not smoothed (the ticket's carve
// list; every line here is a boundary, not an omission):
// - No live monitoring. The store has no run-status column and ingest is
//   post-hoc and derived — the pages show only INGESTED (finished) runs'
//   derived state, labeled as such on the page itself.
// - No §26.1 fields without a store producer (token usage, disk usage,
//   worktree count) — they stay off the page.
// - No dispatch order: `dispatchIndex` lives only in report.json's schedule
//   block; the store tables carry no dispatch-index column.
// - No artifact contents — pointers only (path / size_bytes / content_hash;
//   a NULL renders as "missing", never fabricated — AGENTS.md #7). The
//   drill-down keeps that posture: no per-job artifact filtering, no
//   artifact contents (§26.5 stays carved); the run page keeps its full
//   artifacts table.
// - No context-inspector page (§26.4): carved, and BLOCKED ON A PRODUCER —
//   nothing persists ContextPlan/Packet into the store (the ingest upsert
//   binds jobs.context_plan_json literal null), so there is literally
//   nothing store-backed to render; persisting it is the producer-first
//   successor ticket and owns its own Gate 2.
// - No interactive graph — the DAG renders as text/table; the drill-down
//   links are plain <a href> (zero client-side JS). Dispatch order and
//   phase/job-status rendering stay carved (report.json-only).
// - Nothing rendered can influence a verdict. The only mutation is the
//   human POST /approvals/decide through the store's `decideApproval`
//   writer — the documented T-008 wall-clock scoping case; every store
//   refusal surfaces as an HTTP 4xx carrying the refusal message, with
//   nothing written.
//
// node:sqlite is experimental on Node 22 (VERIFICATION.md Known issue #7) —
// the dashboard rides the same engine as the store.
import { existsSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decideApproval, listPendingApprovals, type ApprovalDecision, type ApprovalRow } from './store/index.js'

const DEFAULT_DB = 'C:\\swarm\\refinery.db'

const usage = `Run dashboard: a local, read-only HTTP view over the recorded store (T-034, T-035).

Usage:
  npm run dashboard -- [--port <port>] [--db <path>]

Options:
  --port <port>    TCP port to bind on 127.0.0.1 (default: an ephemeral free port)
  --db <path>      SQLite DB holding the durable run records (default:
                   C:\\swarm\\refinery.db)
  --help           Show this help

Routes:
  GET  /                    the run list (ingested post-hoc state — never live)
  GET  /run/<id>            one run's candidates, gate results, evidence
                            pointers, probe runs, and recorded DAG
  GET  /run/<id>/job/<jobId>
                            one job's drill-down: the job row, the machine
                            verdict, its gate results, attempt history, and
                            probe runs (never-dispatched jobs say so)
  GET  /approvals           the pending-approval queue (read-only)
  POST /approvals/decide    record an operator decision (form fields: run,
                            job, decision, optional by/note) — the ONLY write

Read routes open the database read-only and never write; a missing DB file
refuses startup and never creates a refinery.db as a side effect. Binds
127.0.0.1 only; no auth (operator-local tooling).`

export interface DashboardOptions {
  /** Path to the store DB. Must already exist — the dashboard never creates one. */
  db: string
  /** TCP port; default an ephemeral free port. Always bound on 127.0.0.1. */
  port?: number
}

/**
 * Start the dashboard server. Refuses (throws) when the DB file does not
 * exist — a missing store is a startup refusal, never an empty refinery.db
 * created as a side effect (the src/dag.ts:125 / src/approvals.ts:111
 * refusal pattern). Resolves once the server is listening on 127.0.0.1.
 */
export async function startDashboard(opts: DashboardOptions): Promise<Server> {
  // Before anything is opened: the dashboard must never create an empty
  // refinery.db as a side effect (readOnly would refuse anyway — belt and
  // braces, the dag/approvals pattern).
  if (!existsSync(opts.db)) {
    throw new Error(`no database at ${opts.db} (ingest creates it; the dashboard never does)`)
  }
  const server = createServer((req, res) => {
    void handle(req, res, opts.db)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  return server
}

// ---------- HTML rendering (stdlib string templates; no framework, no client-side JS) ----------

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function page(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${esc(title)}</title>`,
    '<style>body{font-family:monospace;margin:1.5em}table{border-collapse:collapse}th,td{border:1px solid #999;padding:2px 8px;text-align:left;vertical-align:top}th{background:#eee}.refusal{color:#900}</style>',
    '</head><body>',
    `<h1>${esc(title)}</h1>`,
    `<p><a href="/">&larr; run list</a> · <a href="/approvals">pending approvals</a></p>`,
    body,
    '</body></html>',
    '',
  ].join('\n')
}

const INGESTED_LABEL =
  'ingested post-hoc state &mdash; never live: the store records finished runs ' +
  '(ingest is post-hoc and derived), so these pages show only ingested runs&rsquo; ' +
  'derived verdicts, never in-flight progress'

interface RunListRow {
  runId: string
  repo: string
  baseSha: string
  goal: string
  model: string
  startedAt: string
  finishedAt: string
  survivors: number
  eliminated: number
}

function readRunList(db: DatabaseSync): RunListRow[] {
  const rows = db.prepare(
    `SELECT r.run_id, r.repo, r.base_sha, r.goal, r.model, r.started_at, r.finished_at,
       (SELECT COUNT(*) FROM candidates c WHERE c.run_id = r.run_id AND c.passed_all_gates = 1) AS survivors,
       (SELECT COUNT(*) FROM candidates c WHERE c.run_id = r.run_id AND c.passed_all_gates = 0) AS eliminated
     FROM runs r ORDER BY r.run_id`,
  ).all() as Record<string, unknown>[]
  return rows.map((r) => ({
    runId: r.run_id as string,
    repo: r.repo as string,
    baseSha: r.base_sha as string,
    goal: r.goal as string,
    model: r.model as string,
    startedAt: r.started_at as string,
    finishedAt: r.finished_at as string,
    survivors: r.survivors as number,
    eliminated: r.eliminated as number,
  }))
}

function renderRunList(dbPath: string): string {
  const db = openReadOnly(dbPath)
  try {
    const runs = readRunList(db)
    const rows = runs.map((r) =>
      `<tr><td><a href="/run/${esc(r.runId)}">${esc(r.runId)}</a></td><td>${esc(r.repo)}</td>` +
      `<td>${esc(r.baseSha)}</td><td>${esc(r.goal)}</td><td>${esc(r.model)}</td>` +
      `<td>${esc(r.startedAt)}</td><td>${esc(r.finishedAt)}</td>` +
      `<td>${r.survivors} survivor(s) &middot; ${r.eliminated} eliminated</td></tr>`,
    )
    return [
      `<p>${INGESTED_LABEL}</p>`,
      `<p>survivor/eliminated counts derive from <code>candidates.passed_all_gates</code> (machine-gate verdicts &mdash; the dashboard renders them, never produces them).</p>`,
      `<p>runs recorded: ${runs.length}</p>`,
      '<table><tr><th>run</th><th>repo</th><th>base_sha</th><th>goal</th><th>model</th><th>started_at</th><th>finished_at</th><th>verdicts</th></tr>',
      ...rows,
      '</table>',
      '',
    ].join('\n')
  } finally {
    db.close()
  }
}

interface GateRow {
  candidateId: string
  gateName: string
  passed: boolean
  exitCode: number | null
  durationMs: number
  outputTail: string
}

interface ArtifactRow {
  artifactId: string
  kind: string
  jobId: string | null
  attemptNumber: number | null
  path: string
  sizeBytes: number | null
  contentHash: string | null
}

interface ProbeRunRow {
  jobId: string
  probeId: string
  scenarioId: string
  success: boolean
  durationMs: number
  bundlePath: string
}

interface CandidateRow {
  candidateId: string
  workerId: string
  model: string
  brief: string
  workerOk: boolean
  workerTimedOut: boolean
  workerDurationMs: number
  diffBytes: number
  passedAllGates: boolean
  error: string | null
}

interface DagSection {
  phases: { phaseId: string; dependencies: string[] }[]
  jobs: { jobId: string; phaseId: string; workerId: string; model: string; brief: string; dependencies: string[] }[]
  edges: { jobId: string; dependsOnJobId: string }[]
}

function renderDag(runId: string, dag: DagSection): string {
  const phases = dag.phases.map((p) =>
    `<li>${esc(p.phaseId)} &mdash; dependencies: ${p.dependencies.length === 0 ? '(none)' : esc(p.dependencies.join(', '))}</li>`)
  // T-035: each job id links to its drill-down page — a plain <a href>, no
  // client-side JS (the zero-JS posture holds).
  const jobs = dag.jobs.map((j) =>
    `<li><a href="/run/${esc(runId)}/job/${esc(j.jobId)}">${esc(j.jobId)}</a> (phase ${esc(j.phaseId)}, worker ${esc(j.workerId)}, model ${esc(j.model)}) &mdash; dependencies: ${j.dependencies.length === 0 ? '(none)' : esc(j.dependencies.join(', '))}</li>`)
  const edges = dag.edges.length === 0
    ? ['<li>(none)</li>']
    : dag.edges.map((e) => `<li>${esc(e.jobId)} -&gt; ${esc(e.dependsOnJobId)}</li>`)
  return [
    `<h2>recorded job DAG (from phases / jobs / job_dependencies &mdash; the structure src/dag.ts reads)</h2>`,
    `<p>phases (${dag.phases.length}):</p><ul>`,
    ...phases,
    '</ul>',
    `<p>jobs (${dag.jobs.length}):</p><ul>`,
    ...jobs,
    '</ul>',
    `<p>edges (${dag.edges.length}):</p><ul>`,
    ...edges,
    '</ul>',
    '',
  ].join('\n')
}

function renderRun(dbPath: string, runId: string): string | null {
  const db = openReadOnly(dbPath)
  try {
    const run = db.prepare(
      'SELECT run_id, repo, base_sha, goal, model, started_at, finished_at FROM runs WHERE run_id = ?',
    ).get(runId) as Record<string, unknown> | undefined
    if (run === undefined) return null

    const candidates = (db.prepare(
      `SELECT candidate_id, worker_id, model, brief, worker_ok, worker_timed_out,
              worker_duration_ms, diff_bytes, passed_all_gates, error
       FROM candidates WHERE run_id = ? ORDER BY candidate_id`,
    ).all(runId) as Record<string, unknown>[]).map((c): CandidateRow => ({
      candidateId: c.candidate_id as string,
      workerId: c.worker_id as string,
      model: c.model as string,
      brief: c.brief as string,
      workerOk: c.worker_ok === 1,
      workerTimedOut: c.worker_timed_out === 1,
      workerDurationMs: c.worker_duration_ms as number,
      diffBytes: c.diff_bytes as number,
      passedAllGates: c.passed_all_gates === 1,
      error: (c.error as string | null) ?? null,
    }))

    const gates = (db.prepare(
      `SELECT candidate_id, gate_name, passed, exit_code, duration_ms, output_tail
       FROM gate_results WHERE run_id = ? ORDER BY candidate_id, gate_name`,
    ).all(runId) as Record<string, unknown>[]).map((g): GateRow => ({
      candidateId: g.candidate_id as string,
      gateName: g.gate_name as string,
      passed: g.passed === 1,
      exitCode: (g.exit_code as number | null) ?? null,
      durationMs: g.duration_ms as number,
      outputTail: g.output_tail as string,
    }))

    const artifacts = (db.prepare(
      `SELECT artifact_id, kind, job_id, attempt_number, path, size_bytes, content_hash
       FROM artifacts WHERE run_id = ? ORDER BY artifact_id`,
    ).all(runId) as Record<string, unknown>[]).map((a): ArtifactRow => ({
      artifactId: a.artifact_id as string,
      kind: a.kind as string,
      jobId: (a.job_id as string | null) ?? null,
      attemptNumber: (a.attempt_number as number | null) ?? null,
      path: a.path as string,
      sizeBytes: (a.size_bytes as number | null) ?? null,
      contentHash: (a.content_hash as string | null) ?? null,
    }))

    const probes = (db.prepare(
      `SELECT job_id, probe_id, scenario_id, success, duration_ms, bundle_path
       FROM probe_runs WHERE run_id = ? ORDER BY job_id, probe_id`,
    ).all(runId) as Record<string, unknown>[]).map((p): ProbeRunRow => ({
      jobId: p.job_id as string,
      probeId: p.probe_id as string,
      scenarioId: p.scenario_id as string,
      success: p.success === 1,
      durationMs: p.duration_ms as number,
      bundlePath: p.bundle_path as string,
    }))

    const dag: DagSection = {
      phases: db.prepare(
        'SELECT phase_id, dependencies_json FROM phases WHERE run_id = ? ORDER BY phase_id',
      ).all(runId).map((r) => ({
        phaseId: (r as Record<string, unknown>).phase_id as string,
        dependencies: JSON.parse((((r as Record<string, unknown>).dependencies_json as string | null)) ?? '[]') as string[],
      })),
      jobs: db.prepare(
        'SELECT job_id, phase_id, worker_id, model, brief, dependencies_json FROM jobs WHERE run_id = ? ORDER BY job_id',
      ).all(runId).map((r) => {
        const j = r as Record<string, unknown>
        return {
          jobId: j.job_id as string,
          phaseId: j.phase_id as string,
          workerId: j.worker_id as string,
          model: j.model as string,
          brief: j.brief as string,
          dependencies: JSON.parse((j.dependencies_json as string | null) ?? '[]') as string[],
        }
      }),
      edges: db.prepare(
        'SELECT job_id, depends_on_job_id FROM job_dependencies WHERE run_id = ? ORDER BY job_id, depends_on_job_id',
      ).all(runId).map((r) => {
        const e = r as Record<string, unknown>
        return { jobId: e.job_id as string, dependsOnJobId: e.depends_on_job_id as string }
      }),
    }

    const candidateRows = candidates.map((c) =>
      `<tr><td>${esc(c.candidateId)}</td><td>${esc(c.workerId)}</td><td>${esc(c.model)}</td>` +
      `<td>${esc(c.brief)}</td><td>${c.workerOk ? 'ok' : 'FAILED'}</td><td>${c.workerTimedOut ? 'timed out' : 'no'}</td>` +
      `<td>${c.workerDurationMs} ms</td><td>${c.diffBytes}</td><td>${c.passedAllGates ? 'survivor' : 'eliminated'}</td>` +
      `<td>${c.error === null ? 'missing' : esc(c.error)}</td></tr>`)
    const gateRows = gates.map((g) =>
      `<tr><td>${esc(g.candidateId)}</td><td>${esc(g.gateName)}</td><td>${g.passed ? 'pass' : 'FAIL'}</td>` +
      `<td>${g.exitCode === null ? 'missing' : String(g.exitCode)}</td><td>${g.durationMs} ms</td>` +
      `<td>${esc(g.outputTail)}</td></tr>`)
    const artifactRows = artifacts.map((a) =>
      `<tr><td>${esc(a.artifactId)}</td><td>${esc(a.kind)}</td>` +
      `<td>${a.jobId === null ? 'missing' : esc(a.jobId)}</td>` +
      `<td>${a.attemptNumber === null ? 'missing' : String(a.attemptNumber)}</td>` +
      `<td>${esc(a.path)}</td>` +
      `<td>${a.sizeBytes === null ? 'missing' : String(a.sizeBytes)}</td>` +
      `<td>${a.contentHash === null ? 'missing' : esc(a.contentHash)}</td></tr>`)
    const probeRows = probes.length === 0
      ? ['<tr><td colspan="6">(none recorded)</td></tr>']
      : probes.map((p) =>
        `<tr><td>${esc(p.jobId)}</td><td>${esc(p.probeId)}</td><td>${esc(p.scenarioId)}</td>` +
        `<td>${p.success ? 'success' : 'failure'}</td><td>${p.durationMs} ms</td><td>${esc(p.bundlePath)}</td></tr>`)

    return [
      '<table><tr><th>run</th><th>repo</th><th>base_sha</th><th>goal</th><th>model</th><th>started_at</th><th>finished_at</th></tr>',
      `<tr><td>${esc(run.run_id as string)}</td><td>${esc(run.repo as string)}</td><td>${esc(run.base_sha as string)}</td>` +
      `<td>${esc(run.goal as string)}</td><td>${esc(run.model as string)}</td>` +
      `<td>${esc(run.started_at as string)}</td><td>${esc(run.finished_at as string)}</td></tr></table>`,
      `<p>${INGESTED_LABEL}</p>`,
      `<h2>candidates (${candidates.length})</h2>`,
      '<table><tr><th>candidate</th><th>worker</th><th>model</th><th>brief</th><th>worker</th><th>timeout</th><th>duration</th><th>diff bytes</th><th>verdict</th><th>error</th></tr>',
      ...candidateRows,
      '</table>',
      `<h2>gate results (${gates.length})</h2>`,
      '<table><tr><th>candidate</th><th>gate</th><th>verdict</th><th>exit code</th><th>duration</th><th>output tail</th></tr>',
      ...gateRows,
      '</table>',
      `<h2>evidence pointers &mdash; artifacts (${artifacts.length})</h2>`,
      '<p>pointers only; contents are not served (the artifact viewer is a later carve). NULL size/hash renders as missing &mdash; never fabricated.</p>',
      '<table><tr><th>artifact</th><th>kind</th><th>job</th><th>attempt</th><th>path</th><th>size_bytes</th><th>content_hash</th></tr>',
      ...artifactRows,
      '</table>',
      `<h2>probe runs (${probes.length})</h2>`,
      '<table><tr><th>job</th><th>probe</th><th>scenario</th><th>outcome</th><th>duration</th><th>bundle path</th></tr>',
      ...probeRows,
      '</table>',
      renderDag(runId, dag),
      '',
    ].join('\n')
  } finally {
    db.close()
  }
}

// ---------- T-035: the per-job drill-down page ----------

interface JobPageJob {
  jobId: string
  phaseId: string
  workerId: string
  model: string
  brief: string
  dependencies: string[]
}

interface AttemptRow {
  attemptNumber: number
  state: string
  startedAt: string | null
  endedAt: string | null
  inputContextHash: string
  promptVersion: string | null
  processIdentityJson: string | null
  workerSessionId: string | null
  outputArtifactsJson: string
  failureJson: string | null
}

/**
 * One job's drill-down page. Every value is a direct SELECT on the
 * schema-v5 store tables through the same readOnly open — nothing is
 * recomputed and nothing comes from report.json. The verdict is the
 * candidates.passed_all_gates row (job_id IS the candidate id in the
 * derived DAG), rendered as survivor/eliminated — the machine verdict,
 * rendered, never produced. NULLs render as "missing", never fabricated
 * (AGENTS.md #7). The never-dispatched face — a jobs row with empty
 * worker/model/brief and NO candidate row (the T-009/T-031 derivation for
 * a declared-but-never-dispatched job) — renders as never-dispatched with
 * no verdict, no gates, no attempts, nothing fabricated. An id with no
 * jobs row at all returns null → the caller's 404.
 */
function renderJob(dbPath: string, runId: string, jobId: string): string | null {
  const db = openReadOnly(dbPath)
  try {
    const job = db.prepare(
      'SELECT job_id, phase_id, worker_id, model, brief, dependencies_json FROM jobs WHERE run_id = ? AND job_id = ?',
    ).get(runId, jobId) as Record<string, unknown> | undefined
    if (job === undefined) return null
    const jobRow: JobPageJob = {
      jobId: job.job_id as string,
      phaseId: job.phase_id as string,
      workerId: job.worker_id as string,
      model: job.model as string,
      brief: job.brief as string,
      dependencies: JSON.parse((job.dependencies_json as string | null) ?? '[]') as string[],
    }

    // The verdict: the candidates row keyed by the job id (the derived DAG's
    // job_id IS the candidate id). No row → never-dispatched check below.
    const candidate = db.prepare(
      'SELECT candidate_id, passed_all_gates FROM candidates WHERE run_id = ? AND candidate_id = ?',
    ).get(runId, jobId) as Record<string, unknown> | undefined

    const gates = (db.prepare(
      `SELECT gate_name, passed, exit_code, duration_ms, output_tail
       FROM gate_results WHERE run_id = ? AND candidate_id = ? ORDER BY gate_name`,
    ).all(runId, jobId) as Record<string, unknown>[]).map((g): GateRow => ({
      candidateId: jobId,
      gateName: g.gate_name as string,
      passed: g.passed === 1,
      exitCode: (g.exit_code as number | null) ?? null,
      durationMs: g.duration_ms as number,
      outputTail: g.output_tail as string,
    }))

    const attempts = (db.prepare(
      `SELECT attempt_number, state, started_at, ended_at, input_context_hash,
              prompt_version, process_identity_json, worker_session_id,
              output_artifacts_json, failure_json
       FROM attempts WHERE run_id = ? AND job_id = ? ORDER BY attempt_number`,
    ).all(runId, jobId) as Record<string, unknown>[]).map((a): AttemptRow => ({
      attemptNumber: a.attempt_number as number,
      state: a.state as string,
      startedAt: (a.started_at as string | null) ?? null,
      endedAt: (a.ended_at as string | null) ?? null,
      inputContextHash: a.input_context_hash as string,
      promptVersion: (a.prompt_version as string | null) ?? null,
      processIdentityJson: (a.process_identity_json as string | null) ?? null,
      workerSessionId: (a.worker_session_id as string | null) ?? null,
      outputArtifactsJson: a.output_artifacts_json as string,
      failureJson: (a.failure_json as string | null) ?? null,
    }))

    const probes = (db.prepare(
      `SELECT probe_id, scenario_id, success, duration_ms, bundle_path
       FROM probe_runs WHERE run_id = ? AND job_id = ? ORDER BY probe_id`,
    ).all(runId, jobId) as Record<string, unknown>[]).map((p): ProbeRunRow => ({
      jobId,
      probeId: p.probe_id as string,
      scenarioId: p.scenario_id as string,
      success: p.success === 1,
      durationMs: p.duration_ms as number,
      bundlePath: p.bundle_path as string,
    }))

    const deps = jobRow.dependencies.length === 0 ? '(none)' : esc(jobRow.dependencies.join(', '))
    const parts: string[] = [
      '<table><tr><th>job</th><th>phase</th><th>worker</th><th>model</th><th>brief</th><th>dependencies</th></tr>',
      `<tr><td>${esc(jobRow.jobId)}</td><td>${esc(jobRow.phaseId)}</td><td>${esc(jobRow.workerId)}</td>` +
      `<td>${esc(jobRow.model)}</td><td>${esc(jobRow.brief)}</td><td>${deps}</td></tr>`,
      '</table>',
      `<p>${INGESTED_LABEL}</p>`,
      `<p><a href="/run/${esc(runId)}">&larr; back to run ${esc(runId)}</a></p>`,
    ]

    // The never-dispatched face: empty worker/model/brief AND no candidate
    // row — nothing executed, so nothing is rendered beyond the job row
    // itself (no verdict, no gates, no attempts, nothing fabricated).
    const neverDispatched =
      candidate === undefined && jobRow.workerId === '' && jobRow.model === '' && jobRow.brief === ''
    if (neverDispatched) {
      parts.push(
        '<p class="refusal">never-dispatched: this job carries an empty worker/model/brief and no candidate row ' +
        '&mdash; nothing executed, so there is no verdict, no gate results, and no attempt history ' +
        '(nothing fabricated &mdash; AGENTS.md #7).</p>',
        '',
      )
      return parts.join('\n')
    }

    if (candidate === undefined) {
      // A jobs row with dispatch metadata but no candidate row is not a
      // never-dispatched shape; render the absence honestly instead of a
      // fabricated verdict.
      parts.push('<h2>verdict</h2>', '<p>no candidate row is recorded for this job &mdash; no verdict rendered (nothing fabricated).</p>')
    } else {
      parts.push(
        `<h2>verdict (candidates.passed_all_gates &mdash; the machine verdict)</h2>`,
        '<table><tr><th>candidate</th><th>verdict</th></tr>',
        `<tr><td>${esc(jobId)}</td><td>${candidate.passed_all_gates === 1 ? 'survivor' : 'eliminated'}</td></tr>`,
        '</table>',
      )
    }

    const gateRows = gates.length === 0
      ? ['<tr><td colspan="5">(none recorded)</td></tr>']
      : gates.map((g) =>
        `<tr><td>${esc(g.gateName)}</td><td>${g.passed ? 'pass' : 'FAIL'}</td>` +
        `<td>${g.exitCode === null ? 'missing' : String(g.exitCode)}</td><td>${g.durationMs} ms</td>` +
        `<td>${esc(g.outputTail)}</td></tr>`)
    parts.push(
      `<h2>gate results (${gates.length})</h2>`,
      '<table><tr><th>gate</th><th>verdict</th><th>exit code</th><th>duration</th><th>output tail</th></tr>',
      ...gateRows,
      '</table>',
    )

    const attemptRows = attempts.length === 0
      ? ['<tr><td colspan="10">(none recorded)</td></tr>']
      : attempts.map((a) =>
        `<tr><td>${a.attemptNumber}</td><td>${esc(a.state)}</td>` +
        `<td>${a.startedAt === null ? 'missing' : esc(a.startedAt)}</td>` +
        `<td>${a.endedAt === null ? 'missing' : esc(a.endedAt)}</td>` +
        `<td>${esc(a.inputContextHash)}</td>` +
        `<td>${a.promptVersion === null ? 'missing' : esc(a.promptVersion)}</td>` +
        `<td>${a.processIdentityJson === null ? 'missing' : esc(a.processIdentityJson)}</td>` +
        `<td>${a.workerSessionId === null ? 'missing' : esc(a.workerSessionId)}</td>` +
        `<td>${esc(a.outputArtifactsJson)}</td>` +
        `<td>${a.failureJson === null ? 'missing' : esc(a.failureJson)}</td></tr>`)
    parts.push(
      `<h2>attempts (${attempts.length})</h2>`,
      '<p>as recorded &mdash; output_artifacts_json/failure_json verbatim; producer-less columns (process_identity_json, worker_session_id) render as missing.</p>',
      '<table><tr><th>attempt</th><th>state</th><th>started_at</th><th>ended_at</th><th>input_context_hash</th><th>prompt_version</th><th>process_identity_json</th><th>worker_session_id</th><th>output_artifacts_json</th><th>failure_json</th></tr>',
      ...attemptRows,
      '</table>',
    )

    const probeRows = probes.length === 0
      ? ['<tr><td colspan="5">(none recorded)</td></tr>']
      : probes.map((p) =>
        `<tr><td>${esc(p.probeId)}</td><td>${esc(p.scenarioId)}</td>` +
        `<td>${p.success ? 'success' : 'failure'}</td><td>${p.durationMs} ms</td><td>${esc(p.bundlePath)}</td></tr>`)
    parts.push(
      `<h2>probe runs (${probes.length})</h2>`,
      '<table><tr><th>probe</th><th>scenario</th><th>outcome</th><th>duration</th><th>bundle path</th></tr>',
      ...probeRows,
      '</table>',
      '',
    )
    return parts.join('\n')
  } finally {
    db.close()
  }
}

function renderApprovals(dbPath: string): string {
  // The ticketed reuse: the pending queue comes from the store's own
  // readOnly reader, called verbatim — no duplicated SQL.
  const pending: ApprovalRow[] = listPendingApprovals(dbPath)
  const rows = pending.length === 0
    ? ['<tr><td colspan="6">no pending approvals</td></tr>']
    : pending.map((r) =>
      `<tr><td>${esc(r.runId)}</td><td>${esc(r.phaseId)}</td><td>${esc(r.jobId)}</td><td>${esc(r.state)}</td>` +
      `<td>${esc(r.requestedAt)}</td><td>${esc(r.requestedBy)}</td></tr>`)
  return [
    `<p>rows in <code>waiting_for_approval</code> via <code>listPendingApprovals</code>. The only write on this dashboard is the decide form below.</p>`,
    '<table><tr><th>run</th><th>phase</th><th>job</th><th>state</th><th>requested_at</th><th>requested_by</th></tr>',
    ...rows,
    '</table>',
    decideForm(),
    '',
  ].join('\n')
}

function decideForm(): string {
  return [
    '<h2>decide one approval</h2>',
    '<form method="post" action="/approvals/decide">',
    '<p>run: <input name="run"> job: <input name="job"> decision: <select name="decision"><option>approved</option><option>rejected</option></select></p>',
    '<p>by (optional): <input name="by"> note (optional): <input name="note"></p>',
    '<p><button type="submit">record decision</button></p>',
    '</form>',
    '',
  ].join('\n')
}

// ---------- routing ----------

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

function notFound(res: ServerResponse, message: string): void {
  send(res, 404, page('not found', `<p class="refusal">${esc(message)}</p>`))
}

function methodNotAllowed(res: ServerResponse): void {
  send(res, 405, page('method not allowed', '<p class="refusal">method not allowed</p>'))
}

/** Map a store refusal to its HTTP status — always a 4xx (the ticket's
 *  contract: every store refusal surfaces as HTTP 4xx carrying the refusal
 *  message, with nothing written). */
function statusForRefusal(message: string): number {
  if (/no recorded run |no candidate '|no derived job row /.test(message)) return 404
  if (/^unknown --decision/.test(message)) return 400
  return 409 // non-survivor, no recorded request, double-decide — state conflicts
}

const MAX_FORM_BYTES = 64 * 1024

function readBody(req: IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > cap) {
        reject(new Error(`form body exceeds ${cap} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function handleDecide(req: IncomingMessage, res: ServerResponse, dbPath: string): Promise<void> {
  let body: string
  try {
    body = await readBody(req, MAX_FORM_BYTES)
  } catch (e) {
    send(res, 400, page('refused', `<p class="refusal">refused: ${esc(e instanceof Error ? e.message : String(e))}</p>`))
    return
  }
  const form = new URLSearchParams(body)
  const run = form.get('run')
  const job = form.get('job')
  const decision = form.get('decision')
  const missing = [
    ['run', run],
    ['job', job],
    ['decision', decision],
  ].filter(([, v]) => v === null || v === '').map(([k]) => k)
  if (missing.length > 0) {
    send(res, 400, page('refused', `<p class="refusal">refused: missing form field(s): ${esc(missing.join(', '))}</p>`))
    return
  }
  try {
    // The dashboard's ONLY write — the store's own decideApproval, called
    // verbatim. Every refusal below is the store's refusal (T-008's
    // contract unchanged); its message surfaces as an HTTP 4xx body.
    const row = decideApproval(dbPath, {
      runId: run as string,
      jobId: job as string,
      decision: decision as ApprovalDecision,
      by: form.get('by') ?? undefined,
      note: form.get('note') ?? undefined,
    })
    send(res, 200, page('approval decided',
      `<p>${esc(row.runId)} ${esc(row.phaseId)}/${esc(row.jobId)}: <strong>${esc(row.state)}</strong></p>` +
      `<p>decided_at=${esc(row.decidedAt ?? 'missing')} decided_by=${esc(row.decidedBy ?? 'missing')}` +
      `${row.note === null ? '' : ` note=${esc(row.note)}`}</p>` +
      '<p><a href="/approvals">back to the queue</a></p>'))
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    send(res, statusForRefusal(message), page('refused', `<p class="refusal">refused: ${esc(message)}</p>`))
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, dbPath: string): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = req.method ?? 'GET'
    if (url.pathname === '/') {
      if (method !== 'GET') return methodNotAllowed(res)
      return send(res, 200, page('Inference Refinery — runs', renderRunList(dbPath)))
    }
    if (url.pathname === '/approvals') {
      if (method !== 'GET') return methodNotAllowed(res)
      return send(res, 200, page('pending approvals', renderApprovals(dbPath)))
    }
    if (url.pathname === '/approvals/decide') {
      if (method !== 'POST') return methodNotAllowed(res)
      return await handleDecide(req, res, dbPath)
    }
    if (url.pathname.startsWith('/run/')) {
      if (method !== 'GET') return methodNotAllowed(res)
      const rest = url.pathname.slice('/run/'.length)
      const jobSep = rest.indexOf('/job/')
      if (jobSep !== -1) {
        // T-035: the per-job drill-down route. An id with no jobs row at
        // all (unknown job OR unknown run — either way the store holds no
        // such row) is a 404 carrying the refusal message.
        const runId = decodeURIComponent(rest.slice(0, jobSep))
        const jobId = decodeURIComponent(rest.slice(jobSep + '/job/'.length))
        if (jobId.length === 0) return notFound(res, 'missing job id')
        const body = renderJob(dbPath, runId, jobId)
        if (body === null) {
          return notFound(res, `no recorded job '${jobId}' in run '${runId}' in ${dbPath}`)
        }
        return send(res, 200, page(`job ${jobId} (run ${runId})`, body))
      }
      const runId = decodeURIComponent(rest)
      if (runId.length === 0) return notFound(res, 'missing run id')
      const body = renderRun(dbPath, runId)
      if (body === null) return notFound(res, `no recorded run '${runId}' in ${dbPath}`)
      return send(res, 200, page(`run ${runId}`, body))
    }
    return notFound(res, `no route for ${method} ${url.pathname}`)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    try {
      send(res, 500, page('internal error', `<p class="refusal">${esc(message)}</p>`))
    } catch {
      // response already closed — nothing more to do
    }
  }
}

function openReadOnly(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true })
}

// ---------- CLI entry ----------

/**
 * Whether THIS process was invoked to run the dashboard CLI (as opposed to
 * importing the module — the fast-tier gate drives `startDashboard`
 * in-process). Importing must never start a server, least of all one bound
 * to the DEFAULT store path: a module-level side effect would be exactly
 * the consult-the-live-store accident the T-028 review round 1 fixed for
 * integrate. The standard entry-module check: argv[1] resolves to this file
 * only when `tsx src/dashboard.ts` ran.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return resolvePath(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

interface CliOptions {
  port: number | null
  db: string
}

function refuse(message: string): never {
  console.error(`refused: ${message}`)
  process.exit(1)
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { port: null, db: DEFAULT_DB }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) refuse(`missing value for ${arg}`)
      return v as string
    }
    switch (arg) {
      case '--port': {
        const raw = value()
        const port = Number(raw)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          refuse(`--port must be an integer 1..65535 (got '${raw}')`)
        }
        opts.port = port
        break
      }
      case '--db': opts.db = value(); break
      case '--help': case '-h': console.log(usage); process.exit(0); break
      default: refuse(`unknown option: ${arg}\n\n${usage}`)
    }
  }
  return opts
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  // Startup refusal before anything is opened: a missing DB file never
  // becomes an empty refinery.db created as a side effect (the T-006/T-008
  // refusal pattern; startDashboard re-checks — belt and braces).
  if (!existsSync(opts.db)) {
    refuse(`no database at ${opts.db} (ingest creates it; the dashboard never does)`)
  }
  const server = await startDashboard({ db: opts.db, port: opts.port ?? undefined })
  const addr = server.address()
  const port = addr !== null && typeof addr === 'object' ? addr.port : opts.port
  console.log(`dashboard: http://127.0.0.1:${port}/  (db: ${opts.db})`)
  console.log('read-only except POST /approvals/decide; Ctrl+C to stop')
}

if (invokedDirectly()) {
  // main() is async: its refusals reject the promise — routed through the
  // catch so an async startup failure exits 1 with the message, never an
  // unhandled rejection.
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
