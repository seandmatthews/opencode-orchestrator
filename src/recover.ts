// Startup reconciliation (T-010): reconcile a run the orchestrator died in
// (spec §15.2, §29, §15.3; the Milestone-3 "abandoned-job recovery" build
// item). House standalone-entry pattern (like src/clean.ts / src/integrate.ts):
//
//   npm run recover -- --run <runId> [--db <path>] [--run-root <path>] [--force-lock]
//
// Marks the recorded-`running` attempts `abandoned` in the store, kills the
// recorded worker process trees after identity verification, inspects the
// temporary workspaces, computes each job's retryable-or-terminal disposition
// from T-007's retry policy, and writes <runDir>/recovery.json. Recovery
// NEVER reruns anything — no lease is taken, no worker spawned, no scheduling
// happens; it is marks + kills + inspection + disposition, and recovery.json
// has no consumer this slice.
//
// Refusals happen before any write (the T-006 pattern): a finished run
// (report.json present — its records come from ingest) and an
// already-reconciled run (recovery.json present — re-reading a reconciliation
// is `cat`, not a second pass) exit non-zero touching nothing. A run with no
// readable dispatch.jsonl (a pre-T-010 crash) gets inspection-only: nothing
// to mark, no pids known, exit 0 — disposal for such runs stays
// `clean` + `--force-lock`, exactly today's manual path.
//
// Every git subprocess is list-form, never through a shell (AGENTS.md #4).
// The T-004 checkout lock serializes recovery against live runs and clean on
// the same target repo; a hard-killed run's lock blocks until a human
// overrides — recover honors --force-lock exactly as clean does, and nothing
// ever auto-reaps a lock. The lock file's own pid is never used for
// anything: it belongs to the dead orchestrator and is useless for tree-kill
// by construction — only per-attempt pids recorded in dispatch.jsonl are.
import { defaultRunRoot, defaultStoreDb } from './run-root.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { killTree } from './kill-tree.js'
import { acquireCheckoutLock, CheckoutLockRefused, releaseCheckoutLock } from './lock.js'
import { recordAbandonedAttempts } from './store/index.js'
import type { AbandonedAttemptInput } from './store/index.js'
import { normPath, registeredWorktrees, sniffRepo } from './workspace/worktree.js'

const usage = `Reconcile a run the orchestrator died in (T-010): mark recorded-running
attempts abandoned, kill the recorded worker process trees after identity
verification, inspect the temporary workspaces, compute retry dispositions.

Usage:
  npm run recover -- --run <runId> [options]

Options:
  --run <runId>        The run directory under the run root to reconcile
  --db <path>          SQLite DB for the abandonment marks (default:
                       ${defaultStoreDb()})
  --run-root <path>    Where runs live (default: ${defaultRunRoot()})
  --force-lock         Take the checkout lock even if another (suspected-
                       stale) holder still owns it
  --help               Show this help

Refuses a finished run (report.json present — its records come from ingest)
and an already-reconciled run (recovery.json present). A run with no
dispatch.jsonl evidence (a pre-T-010 crash) is inspected report-only.
Recovery removes nothing: worktrees, branches, and evidence stay; disposal
remains clean's job. Exit 0 when every step executed; 1 when any cleanup or
write failed (the failure is recorded in recovery.json).`

interface Options {
  runRoot: string
  run: string
  db: string
  forceLock: boolean
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { runRoot: defaultRunRoot(), run: '', db: defaultStoreDb(), forceLock: false }
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
      case '--run-root': opts.runRoot = value(); break
      case '--force-lock': opts.forceLock = true; break
      case '--help': case '-h': console.log(usage); process.exit(0)
      default: throw new Error(`unknown option: ${arg}\n\n${usage}`)
    }
  }
  if (!opts.run) throw new Error(`--run <runId> is required\n\n${usage}`)
  return opts
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** True only when a real FILE sits at the path (a directory squatting on the
 *  artifact path is not a reconciliation record — the write below then fails
 *  loudly, and the lock still releases). */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// ---------- dispatch.jsonl evidence (written in-run by src/runner.ts, T-010) ----------

interface RunHeader {
  type: 'run'
  runId?: string
  repo?: string
  baseSha?: string
  goal?: string
  model?: string
  maxAttempts?: number
  /** T-038: the run granted each candidate the one bounded feedback-informed
   *  gate retry — the effective bound is one attempt taller while a job's
   *  retry is unconsumed (derived from the dispatch records, see
   *  `gateRetryConsumed`). Absent on pre-T-038 and flag-less runs. */
  gateRetry?: boolean
  startedAt?: string
}

export interface DispatchRecord {
  type: 'dispatch'
  jobId: string
  attempt: number
  leaseId?: string
  branch?: string
  worktreePath?: string
  startedAt?: string
}

export interface PidRecord {
  type: 'pid'
  jobId: string
  attempt: number
  pid: number
  at?: string
}

interface CompletionRecord {
  type: 'completion'
  jobId: string
  attempt: number
  ok?: boolean
  timedOut?: boolean
  exitCode?: number | null
  diffBytes?: number | null
  endedAt?: string
}

interface RunEvidence {
  header: RunHeader | null
  dispatches: DispatchRecord[]
  pids: Map<string, PidRecord>
  completions: Map<string, CompletionRecord>
}

const attemptKey = (jobId: string, attempt: number): string => `${jobId}#${attempt}`

/**
 * Parse <runDir>/dispatch.jsonl. Null when the file is absent or carries no
 * readable line (a pre-T-010 crash): recovery then inspects report-only. A
 * truncated final line (the crash landing mid-write) is skipped — partial
 * evidence is the point of the file.
 */
function readDispatchEvidence(runDir: string): RunEvidence | null {
  let raw: string
  try {
    raw = readFileSync(join(runDir, 'dispatch.jsonl'), 'utf8')
  } catch {
    return null
  }
  const ev: RunEvidence = { header: null, dispatches: [], pids: new Map(), completions: new Map() }
  let readable = 0
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(t) as Record<string, unknown>
    } catch {
      continue
    }
    if (obj === null || typeof obj !== 'object') continue
    const type = obj.type
    const jobId = obj.jobId
    const attempt = obj.attempt
    if (type === 'run') {
      if (ev.header === null) ev.header = obj as unknown as RunHeader
      readable++
    } else if (type === 'dispatch' && typeof jobId === 'string' && Number.isInteger(attempt)) {
      ev.dispatches.push(obj as unknown as DispatchRecord)
      readable++
    } else if (type === 'pid' && typeof jobId === 'string' && Number.isInteger(attempt) && Number.isInteger(obj.pid)) {
      ev.pids.set(attemptKey(jobId, attempt as number), obj as unknown as PidRecord)
      readable++
    } else if (type === 'completion' && typeof jobId === 'string' && Number.isInteger(attempt)) {
      ev.completions.set(attemptKey(jobId, attempt as number), obj as unknown as CompletionRecord)
      readable++
    }
  }
  return readable > 0 ? ev : null
}

// ---------- verify-before-kill (spec §15.2:1071, §15.3:1073-1080) ----------

/** Alive check without side effects: ESRCH = gone, EPERM = exists but denied.
 *  On POSIX a SIGKILLed-but-not-yet-reaped child answers kill(pid, 0) — a
 *  zombie, /proc state Z. The kill is done and the process is dead for every
 *  purpose here (nothing left to kill, no identity to reuse); /proc/state is
 *  the honest answer (T-065). Windows has no zombie state — the signal-0
 *  answer is already exact. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
  if (process.platform !== 'win32') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
      return state !== 'Z' && state !== 'X'
    } catch {
      // /proc/<pid> vanished between the two probes — the process is gone.
      return false
    }
  }
  return true
}

/** A SIGKILL needs a moment to leave the process table (POSIX signal
 *  delivery is asynchronous; Windows' taskkill returns after the kill).
 *  A small bounded synchronous settle before declaring the kill failed —
 *  the T-046 settle posture, without the wider machinery (T-065). The
 *  zombie-aware isAlive above makes the wait exit the moment the kernel
 *  processes the signal, reaping or no reaping. */
function settledDead(pid: number, deadlineMs: number): boolean {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
  return !isAlive(pid)
}

/** The creation-time probe: pid → ISO creation stamp, null when unavailable
 *  (PowerShell missing/blocked, a protected process, a non-Windows host).
 *  Injectable (T-052) so the unavailable path is deterministic to test; the
 *  default is the real spawn below. */
export type CreationTimeProbe = (pid: number) => string | null

/** The process's creation time as an ISO stamp; null when the platform does
 *  not expose it (non-Windows) or the query fails. Windows-only via
 *  PowerShell, list-form spawn (AGENTS.md #4) — never through a shell. */
function processCreatedAt(pid: number): string | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    )
    const s = out.trim()
    return s !== '' && !Number.isNaN(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : null
  } catch {
    return null
  }
}

/** How far a process's creation time may sit outside the dispatch stamps
 *  (spawn lands between the dispatch line and the pid line) before the
 *  process cannot be the recorded worker. */
const IDENTITY_WINDOW_MS = 10_000

export interface IdentityVerdict {
  ok: boolean
  note: string
  /** T-052: true when identity could not be ESTABLISHED at all (probe
   *  unavailable, dispatch stamp unreadable, creation time unparseable) —
   *  refuse-to-kill, a distinct class from a verified mismatch. */
  unavailable: boolean
}

/**
 * Windows reuses pids, and §15.2:1071's "no live process is silently
 * reattached based on stale PID metadata" applies symmetrically to killing:
 * a recorded pid is killed only when the live process's creation time falls
 * inside the dispatch evidence's window. A process created before the
 * dispatch stamp (minus a small tolerance) cannot be a worker the run
 * spawned; a process created after the pid stamp (plus tolerance) is
 * necessarily a reused pid.
 *
 * T-052 — FAIL CLOSED: when identity cannot be established (the probe
 * unavailable, the dispatch stamp unreadable, or the creation time
 * unparseable), the verdict REFUSES the kill. The pre-T-052 posture
 * (alive-check-only, ok) was fail-open in exactly the degraded environments
 * recovery exists for: on a machine where PowerShell cannot run, EVERY kill
 * degraded to alive-check-only, and Windows pid reuse means a stale dispatch
 * pid can name an unrelated live process that recover would tree-kill —
 * unrecoverable — while a skipped leftover is a human's one-line fix. The
 * accepted degradation: machines where PowerShell cannot run get
 * report-only recovery (VERIFICATION.md, stated there, not discovered in an
 * incident).
 */
export function identityMatches(
  dispatch: DispatchRecord,
  pidRecord: PidRecord,
  probe: CreationTimeProbe = processCreatedAt,
): IdentityVerdict {
  const created = probe(pidRecord.pid)
  if (created === null) {
    return { ok: false, unavailable: true, note: 'creation time unavailable — the creation-time probe could not establish process identity' }
  }
  const createdMs = Date.parse(created)
  const lo = typeof dispatch.startedAt === 'string' ? Date.parse(dispatch.startedAt) - IDENTITY_WINDOW_MS : Number.NaN
  const hi = typeof pidRecord.at === 'string' ? Date.parse(pidRecord.at) + IDENTITY_WINDOW_MS : Number.NaN
  if (!Number.isFinite(lo)) {
    return { ok: false, unavailable: true, note: `created ${created}; dispatch stamp unreadable` }
  }
  if (!Number.isFinite(createdMs)) {
    return { ok: false, unavailable: true, note: `creation time unparseable (${created})` }
  }
  if (createdMs < lo) {
    return { ok: false, unavailable: false, note: `process created ${created}, before the dispatch stamp ${dispatch.startedAt} — a pid the run never owned` }
  }
  if (Number.isFinite(hi) && createdMs > hi) {
    return { ok: false, unavailable: false, note: `process created ${created}, after the pid was recorded at ${pidRecord.at} — a reused pid` }
  }
  return { ok: true, unavailable: false, note: `created ${created}, inside the dispatch evidence window` }
}

// ---------- workspace inspection (report-only) ----------

interface WorkspaceReport {
  path: string
  branch: string | null
  exists: boolean
  dirty: boolean | null
}

/**
 * Worktrees from the dispatch records plus wt/-discovery (the src/clean.ts
 * logic — T-002's crash-mid-run path), each with its branch (observed from
 * `git worktree list --porcelain`, falling back to the dispatch record's)
 * and dirty state. Recovery removes nothing — disposal stays clean's job.
 */
function inspectWorkspaces(
  runDir: string,
  repo: string | null,
  recordedPaths: string[],
  recordedBranches: Map<string, string>,
): WorkspaceReport[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const p of recordedPaths) {
    if (!seen.has(normPath(p))) {
      seen.add(normPath(p))
      paths.push(p)
    }
  }
  const wtDir = join(runDir, 'wt')
  if (existsSync(wtDir)) {
    for (const name of readdirSync(wtDir)) {
      const p = join(wtDir, name)
      if (!seen.has(normPath(p))) {
        seen.add(normPath(p))
        paths.push(p)
      }
    }
  }
  const registered = repo !== null && existsSync(repo)
    ? registeredWorktrees(repo)
    : new Map<string, string | null>()
  return paths.map((p) => {
    const exists = existsSync(p)
    let dirty: boolean | null = null
    if (exists) {
      try {
        dirty = execFileSync('git', ['-C', p, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim() !== ''
      } catch {
        dirty = null
      }
    }
    return {
      path: p,
      branch: registered.get(normPath(p)) ?? recordedBranches.get(normPath(p)) ?? null,
      exists,
      dirty,
    }
  })
}

// ---------- the kill decision (§15.2 step 6, verify-before-kill) ----------

export interface CleanupFailure {
  jobId: string
  attempt: number
  pid: number | null
  reason: 'no-pid-recorded' | 'pid-not-alive' | 'identity-mismatch' | 'identity-unavailable' | 'kill-failed'
  message: string
}

export interface KillRecord {
  jobId: string
  attempt: number
  pid: number
  note: string
}

/**
 * One kill decision per recorded-running attempt (T-052: extracted from
 * main, probe-injectable, so the identity legs — unavailable / matching /
 * mismatched — are deterministic to pin). Never blindly kills (§15.3:1080):
 * never-recorded, already-dead, mismatched, and — since T-052 —
 * UNVERIFIABLE pids are cleanup failures; identity-available-and-matching
 * pids are tree-killed exactly as before, and the outcome re-checked on the
 * real process table.
 */
export function reconcileKills(
  abandoned: DispatchRecord[],
  pids: Map<string, PidRecord>,
  probe: CreationTimeProbe = processCreatedAt,
): { kills: KillRecord[]; cleanupFailures: CleanupFailure[] } {
  const kills: KillRecord[] = []
  const cleanupFailures: CleanupFailure[] = []
  for (const d of abandoned) {
    const label = `${d.jobId}-a${d.attempt}`
    const pidRecord = pids.get(attemptKey(d.jobId, d.attempt))
    if (!pidRecord) {
      cleanupFailures.push({ jobId: d.jobId, attempt: d.attempt, pid: null, reason: 'no-pid-recorded', message: `no pid was recorded for ${label} — report-only, never blind-killed` })
      console.log(`cleanup failure (${label}): no pid recorded — report-only`)
      continue
    }
    if (!isAlive(pidRecord.pid)) {
      cleanupFailures.push({ jobId: d.jobId, attempt: d.attempt, pid: pidRecord.pid, reason: 'pid-not-alive', message: `pid ${pidRecord.pid} is not alive — nothing to kill` })
      console.log(`cleanup failure (${label}): pid ${pidRecord.pid} not alive — nothing to kill`)
      continue
    }
    const verdict = identityMatches(d, pidRecord, probe)
    if (!verdict.ok) {
      if (verdict.unavailable) {
        // T-052 fail-closed: identity could not be established — refuse the
        // kill. Tree-killing an innocent reused pid is unrecoverable; a
        // skipped leftover is a human's one-line fix.
        cleanupFailures.push({
          jobId: d.jobId, attempt: d.attempt, pid: pidRecord.pid, reason: 'identity-unavailable',
          message: `identity could not be established (${verdict.note}) — NOT killing pid ${pidRecord.pid}; kill it manually if it is a leftover`,
        })
        console.log(`cleanup failure (${label}): identity could not be established (${verdict.note}) — NOT killing pid ${pidRecord.pid}; kill it manually if it is a leftover`)
        continue
      }
      cleanupFailures.push({ jobId: d.jobId, attempt: d.attempt, pid: pidRecord.pid, reason: 'identity-mismatch', message: `pid ${pidRecord.pid} is live but not the recorded worker: ${verdict.note}` })
      console.log(`cleanup failure (${label}): pid ${pidRecord.pid} failed identity verification — ${verdict.note}`)
      continue
    }
    killTree(pidRecord.pid)
    if (!settledDead(pidRecord.pid, 2_000)) {
      cleanupFailures.push({ jobId: d.jobId, attempt: d.attempt, pid: pidRecord.pid, reason: 'kill-failed', message: `pid ${pidRecord.pid} survived the tree kill` })
      console.log(`cleanup failure (${label}): pid ${pidRecord.pid} survived the tree kill`)
    } else {
      kills.push({ jobId: d.jobId, attempt: d.attempt, pid: pidRecord.pid, note: verdict.note })
      console.log(`killed process tree (${verdict.note}): pid ${pidRecord.pid} (${label})`)
    }
  }
  return { kills, cleanupFailures }
}

// ---------- retry disposition (T-007's policy, from dispatch records only) ----------

interface JobDisposition {
  jobId: string
  attemptsUsed: number
  maxAttempts: number
  disposition: 'retryable' | 'terminal'
  reason: string | null
}

/**
 * One disposition per job, from dispatch records only (spec §15.2 step 4):
 * a completion with ok + diffBytes EXACTLY 0 is a NO-OP machine verdict —
 * terminal, never re-rolled (decisions.md; AGENTS.md #7). A null diffBytes
 * (the runner's encoding for a FAILED diff capture) is not a machine
 * verdict and never counts as a no-op — absent evidence is not an answer.
 * The bound spent is terminal bound-exhausted; everything else (never
 * completed, !ok, timedOut, or completed with a diff but no durably recorded
 * verdict — report.json was never written) is retryable while the bound
 * allows, because no machine verdict was ever produced. T-038: a gates-failed
 * leg CAN occur in-run since then (the pre-retry leg of the bounded
 * feedback-informed gate retry) — it is visible here only as a CONSUMED
 * retry (`gateRetryConsumed` below): the bound derivation accounts for it,
 * one attempt taller while the job's retry is unspent.
 */
function dispositionFor(jobId: string, ev: RunEvidence, maxAttempts: number, gateRetryRemaining: boolean): JobDisposition {
  const dispatches = ev.dispatches.filter((d) => d.jobId === jobId)
  const completions = dispatches
    .map((d) => ev.completions.get(attemptKey(d.jobId, d.attempt)))
    .filter((c): c is CompletionRecord => c !== undefined)
  const attemptsUsed = dispatches.length
  if (completions.some((c) => c.ok === true && c.diffBytes === 0)) {
    return { jobId, attemptsUsed, maxAttempts, disposition: 'terminal', reason: 'no-op' }
  }
  // T-038: an unconsumed gate retry adds exactly one attempt to the bound.
  // `maxAttempts` stays the header's declared value — the derived bound is
  // visible through the disposition itself.
  const bound = gateRetryRemaining ? maxAttempts + 1 : maxAttempts
  if (attemptsUsed >= bound) {
    return { jobId, attemptsUsed, maxAttempts, disposition: 'terminal', reason: 'bound-exhausted' }
  }
  return { jobId, attemptsUsed, maxAttempts, disposition: 'retryable', reason: null }
}

/**
 * T-038: whether a job's one gate retry is already spent, from dispatch
 * records only. The retry leg dispatches only after a completion with ok and
 * a captured non-zero diff — a shape a mechanical retry can never produce
 * (an ok completion is never re-rolled mechanically) — so that shape
 * followed by another dispatch of the same job IS the consumed retry. The
 * consumed leg's own crash (a dispatch with no completion) reads
 * recorded-running like any attempt; the bound no longer includes the
 * spent retry.
 */
function gateRetryConsumed(ev: RunEvidence, jobId: string): boolean {
  return ev.dispatches.some((d) => {
    if (d.jobId !== jobId) return false
    const c = ev.completions.get(attemptKey(jobId, d.attempt))
    return c !== undefined && c.ok === true
      && typeof c.diffBytes === 'number' && c.diffBytes > 0
      && ev.dispatches.some((d2) => d2.jobId === jobId && d2.attempt === d.attempt + 1)
  })
}

// ---------- the command ----------

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  if (!existsSync(opts.runRoot)) {
    console.error(`run root does not exist: ${opts.runRoot}`)
    process.exit(1)
  }
  const runDir = join(opts.runRoot, opts.run)
  if (!existsSync(runDir)) {
    console.error(`no such run directory: ${runDir}`)
    process.exit(1)
  }
  // Refusal 1 — a finished run: report.json exists ⇒ the run completed, its
  // records come from ingest, nothing to reconcile.
  if (existsSync(join(runDir, 'report.json'))) {
    console.error(`run ${opts.run} completed (report.json present) — its records come from ingest; there is nothing to reconcile`)
    process.exit(1)
  }
  // Refusal 2 — an already-reconciled run: a reconciliation REPORT exists ⇒
  // no duplicate abandonment events; re-reading a reconciliation is cat.
  const recoveryPath = join(runDir, 'recovery.json')
  if (isFile(recoveryPath)) {
    console.error(`run ${opts.run} was already reconciled — ${recoveryPath} exists; re-reading a reconciliation is cat, not a second pass`)
    process.exit(1)
  }

  console.log(`=== recover run ${opts.run} ===`)

  // Step 3 — read dispatch.jsonl. Absent/unreadable (a pre-T-010 crash) ⇒
  // inspection-only: workspaces are still listed and reported, with nothing
  // to mark and no pids known; exit 0 (disposal stays clean + --force-lock).
  const ev = readDispatchEvidence(runDir)
  if (ev === null) {
    console.log('no in-run evidence recorded — nothing to mark, no pids known')
    const wtDir = join(runDir, 'wt')
    const wtPaths = existsSync(wtDir) ? readdirSync(wtDir).map((n) => join(wtDir, n)) : []
    const repo = wtPaths.map((p) => sniffRepo(p)).find((r): r is string => r !== null) ?? null
    const workspaces = inspectWorkspaces(runDir, repo, [], new Map())
    for (const w of workspaces) {
      console.log(`workspace: ${w.path}${w.exists ? '' : ' (missing on disk)'} branch=${w.branch ?? '?'} dirty=${w.dirty === null ? '?' : w.dirty}`)
    }
    const report = {
      runId: opts.run,
      recoveredAt: new Date().toISOString(),
      abandonedAttempts: [] as AbandonedAttemptInput[],
      kills: [] as KillRecord[],
      cleanupFailures: [] as CleanupFailure[],
      workspaces,
      jobs: [] as JobDisposition[],
      note: 'no in-run evidence recorded (no dispatch.jsonl) — nothing to mark, no pids known; disposal stays clean + --force-lock',
    }
    writeFileSync(recoveryPath, JSON.stringify(report, null, 2))
    console.log(`\nrecover: inspection-only (pre-T-010 crash), ${workspaces.length} workspace(s) inspected`)
    console.log(`report: ${recoveryPath}`)
    process.exit(0)
  }

  // Step 4 — derive the target repo from the dispatch header, falling back
  // to the worktrees' own .git pointers (the crash-mid-run pattern).
  const wtDir = join(runDir, 'wt')
  const wtCandidates = [
    ...ev.dispatches.map((d) => d.worktreePath).filter((p): p is string => typeof p === 'string'),
    ...(existsSync(wtDir)
      ? readdirSync(wtDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(wtDir, d.name))
      : []),
  ]
  let repo = typeof ev.header?.repo === 'string' && existsSync(ev.header.repo) ? ev.header.repo : null
  if (repo === null) {
    repo = wtCandidates.map((p) => sniffRepo(p)).find((r): r is string => r !== null && existsSync(r)) ?? null
  }
  if (repo === null) {
    console.error(`failed: cannot determine the target repository for ${runDir} (no dispatch header repo, no readable worktree .git)`)
    process.exit(1)
  }

  // Step 5 — the T-004 checkout lock, refused without --force-lock (the
  // never-auto-reap policy: a hard-killed run's lock blocks until a human
  // overrides; recover is not an override).
  let lockPath: string | null = null
  let exitCode = 0
  try {
    try {
      lockPath = acquireCheckoutLock(opts.runRoot, repo, { cmd: 'recover', runId: opts.run }, opts.forceLock)
    } catch (e) {
      if (e instanceof CheckoutLockRefused) {
        console.error(`refused (checkout lock held) — nothing was reconciled for run ${opts.run}`)
        console.error(e.message)
        process.exit(1)
      }
      throw e
    }

    // The recorded-`running` attempts: dispatches without a matching
    // completion line (§15.2:1067).
    const abandoned = ev.dispatches.filter((d) => !ev.completions.has(attemptKey(d.jobId, d.attempt)))
    const abandonedInputs: AbandonedAttemptInput[] = abandoned.map((d) => ({
      jobId: d.jobId,
      attemptNumber: d.attempt,
      startedAt: d.startedAt ?? null,
      processIdentity: {
        pid: ev.pids.get(attemptKey(d.jobId, d.attempt))?.pid ?? null,
        startedAt: d.startedAt ?? null,
        leaseId: d.leaseId ?? null,
        branch: d.branch ?? null,
      },
    }))

    // Abandonment marks (spec §15.2 step 1) — durable, one transaction.
    let marked = 0
    let dbFailed = false
    let writeFailed = false
    if (abandonedInputs.length > 0) {
      try {
        recordAbandonedAttempts(opts.run, abandonedInputs, opts.db)
        marked = abandonedInputs.length
        console.log(`marked ${marked} attempt(s) abandoned in ${opts.db}`)
      } catch (e) {
        console.error(`failed (abandonment marks in ${opts.db}): ${errorMessage(e)}`)
        dbFailed = true
      }
    }

    // Step 6 — kill the recorded trees, verify-before-kill (T-052: the
    // extracted, probe-injectable decision loop). Already-gone, mismatched,
    // UNVERIFIABLE, and never-recorded pids are cleanup failures
    // (§15.3:1080), never blind-killed.
    const { kills, cleanupFailures } = reconcileKills(abandoned, ev.pids)

    // Step 7 — inspect the temporary workspaces, report-only.
    const recordedBranches = new Map<string, string>()
    for (const d of ev.dispatches) {
      if (typeof d.worktreePath === 'string' && typeof d.branch === 'string') {
        recordedBranches.set(normPath(d.worktreePath), d.branch)
      }
    }
    const workspaces = inspectWorkspaces(runDir, repo, wtCandidates, recordedBranches)
    for (const w of workspaces) {
      console.log(`workspace: ${w.path}${w.exists ? '' : ' (missing on disk)'} branch=${w.branch ?? '?'} dirty=${w.dirty === null ? '?' : w.dirty}`)
    }

    // Step 8 — retry disposition per job, from T-007's policy. maxAttempts
    // comes from the dispatch header (the CLI default 1 when unreadable).
    // T-038: a header carrying `gateRetry: true` raises the effective bound
    // by exactly one attempt per job whose gate retry the dispatch records
    // show is still unspent.
    const headerMax = ev.header?.maxAttempts
    const maxAttempts = typeof headerMax === 'number' && Number.isInteger(headerMax) && headerMax >= 1 ? headerMax : 1
    const gateRetryEnabled = ev.header?.gateRetry === true
    const jobIds = [...new Set(ev.dispatches.map((d) => d.jobId))].sort()
    const jobs = jobIds.map((j) => dispositionFor(j, ev, maxAttempts, gateRetryEnabled && !gateRetryConsumed(ev, j)))
    for (const j of jobs) {
      console.log(`disposition: ${j.jobId} attemptsUsed=${j.attemptsUsed}/${j.maxAttempts} -> ${j.disposition}${j.reason ? ` (${j.reason})` : ''}`)
    }

    // Step 9 — write <runDir>/recovery.json.
    const report = {
      runId: opts.run,
      recoveredAt: new Date().toISOString(),
      abandonedAttempts: abandonedInputs,
      kills,
      cleanupFailures,
      workspaces,
      jobs,
    }
    try {
      writeFileSync(recoveryPath, JSON.stringify(report, null, 2))
    } catch (e) {
      // Recorded, not fatal here: the lock MUST be released on this path
      // (the finally below), so the exit happens after it, not inside.
      console.error(`failed (write ${recoveryPath}): ${errorMessage(e)}`)
      writeFailed = true
    }

    console.log(`\nrecover: ${marked} abandoned, ${kills.length} killed, ${cleanupFailures.length} cleanup failure(s), ${workspaces.length} workspace(s) inspected`)
    console.log(`report: ${recoveryPath}`)
    exitCode = cleanupFailures.length > 0 || dbFailed || writeFailed ? 1 : 0
  } finally {
    if (lockPath) releaseCheckoutLock(lockPath)
  }
  process.exit(exitCode)
}

// CLI entry only when run directly (npm run recover / tsx src/recover.ts);
// imports never trigger it (the src/lock.ts pattern, T-052) — the identity
// machinery and the kill decision are exported so checks can inject the
// creation-time probe without executing a reconciliation.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main()
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
}
