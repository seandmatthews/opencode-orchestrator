// Worktree lease GC (T-020): walk the run root, classify every run directory
// against the evidence the engine already produces, and dispose — through
// src/clean.ts's lock-serialized, evidence-parity-refusing disposal loop
// (src/disposal.ts, T-048) — only what is provably orphaned. Spec §16 makes worktrees
// leased resources whose branches carry no unique evidence (workers never
// commit — the diff is captured to diff.patch first; enforced, not assumed,
// since T-044: a branch beyond the run's baseSha is refused as evidence);
// §34 Milestone 3 names
// the GC build item; §29's recovery step 5 stops at validate — this command
// is the dispose half, separate from recover (which stays report-only,
// VERIFICATION.md Gate 1.11).
//
//   npm run gc -- [--run-root <path>] [--force-lock]
//
// Classification, per run directory (14-digit timestamp names — the clean
// --all convention, which keeps locks/, refinery.db, and fixture repos
// structurally outside the sweep):
//   live (lock held)      acquiring the per-repo checkout lock is refused ⇒
//                         the run MAY be live — the never-guess-liveness
//                         policy (T-004, spec §15.2): skip, print the holder
//                         pid/age/path, remove nothing. --force-lock is
//                         honored exactly as clean honors it — the explicit
//                         human override, never an automatic reaper.
//   crashed-unreconciled  no report.json and no recovery.json ⇒ report "run
//                         `npm run recover` first", skip, remove nothing —
//                         unreconciled debris may still have recorded-running
//                         workers whose trees only recovery's
//                         verify-before-kill may touch (T-010's posture).
//   crashed-reconciled    recovery.json present, no report.json ⇒ worktrees +
//                         branches are disposable: targets from the dispatch
//                         records' worktreePath/branch fields, the
//                         recovery.json workspaces, and wt/-discovery, fed
//                         through clean's per-worktree disposal loop
//                         (evidence-parity refusal (T-048), prune fallback,
//                         branch removal after removal — src/disposal.ts,
//                         unchanged).
//   finished              report.json present ⇒ the run completed; its
//                         workspaces were disposed in-run or are clean's
//                         ordinary business ⇒ no worktree disposal here;
//                         eligible only for the branch sweep.
//
// The repo-side branch sweep (the --clean leak fix: the in-run dispose is
// only `git worktree remove --force`, so every --clean run leaks its
// swarm/wt-<id> branches in the target repo). For the repo of each terminal
// run (class 3 or 4), list swarm/* branches (list-form `git branch --list`)
// and delete exactly those that (a) have no worktree currently registered on
// them, (b) are attributable to the terminal run via its dispatch records'
// branch fields, its report candidates (branchForLeaseId('wt/<id>'), retry
// legs swarm/wt-<id>-a<n> included), or its wt/ entry names, and (c) sit at
// the run's recorded baseSha — a branch beyond it carries worker commits,
// which removeBranch's guard REFUSES (T-044; the report's baseSha is the
// expected tip). Branches attributable to no terminal run are reported
// unowned and never deleted; branches on registered worktrees are never
// deleted.
//
// Never touched, by construction: wt/int-* worktrees (integration-replay
// leftovers, dirty by construction — spec §16.1 integration retention class)
// are excluded from every target set and reported as held; all evidence files
// (report.json, dispatch.jsonl, recovery.json, worker.log, diff.patch,
// integrate/<id>.json); a held lock; a live run's lease.
//
// Deliberately NO --force: GC never discards un-captured changes — a
// worktree that differs from its stored diff.patch evidence (or holds
// changes with none) is refused per-item, with a pointer at
// `npm run clean -- --run <id> --force` (today's manual path for exactly
// that case). The per-repo checkout lock is taken inside the per-run pass and
// released in a finally on every path. Every git subprocess is list-form,
// never through a shell (AGENTS.md #4). Exit 0 when the sweep completed —
// skipped-live and crashed-unreconciled runs are healthy classifications, not
// failures; exit 1 when any disposal item was refused or failed (clean's
// convention). Carved (T-020): no §27 workspace_leases table, no §28
// WORKTREE_* events, no retention policies, no recover changes, no pipeline
// changes, no startup-automatic GC.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { disposeTargets, readReport, removeBranch, type RunResult } from './disposal.js'
import { acquireCheckoutLock, CheckoutLockRefused, releaseCheckoutLock } from './lock.js'
import { branchForLeaseId, normPath, registeredWorktrees, sniffRepo } from './workspace/worktree.js'

const usage = `Worktree lease GC (T-020): dispose only what is provably orphaned.

Usage:
  npm run gc -- [options]

Options:
  --run-root <path>    Where runs live (default: C:\\swarm)
  --force-lock         Take the checkout lock even if another (suspected-
                       stale) holder still owns it — the same explicit human
                       override clean and recover honor; nothing ever reaps
                       a lock automatically
  --help               Show this help

Walks the run root (14-digit timestamp run directories, the clean --all
convention) and classifies every run dir: live (checkout lock held — the run
may be live; skip, name the holder, remove nothing), crashed-unreconciled
(no report.json, no recovery.json — run \`npm run recover\` first; remove
nothing), crashed-reconciled (recovery.json present — worktrees + swarm/*
branches disposed through clean's evidence-parity-refusing disposal
loop), or finished
(report.json present — branch sweep only). The branch sweep deletes only
swarm/* branches that have no registered worktree and are attributable to a
terminal run; unowned branches are reported and never deleted.

Deliberately no --force: GC never discards un-captured changes — a worktree
that differs from its stored diff.patch evidence (or holds changes with
none) is refused per-item, with a pointer at
\`npm run clean -- --run <id> --force\`. wt/int-* integration-replay worktrees
are never auto-disposed (reported as held). Evidence files are never deleted.
Exit 0 when the sweep completed; 1 when any disposal item was refused or
failed.`

interface Options {
  runRoot: string
  forceLock: boolean
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { runRoot: 'C:\\swarm', forceLock: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${arg}`)
      return v
    }
    switch (arg) {
      case '--run-root': opts.runRoot = value(); break
      case '--force-lock': opts.forceLock = true; break
      case '--help': case '-h': console.log(usage); process.exit(0)
      default: throw new Error(`unknown option: ${arg}\n\n${usage}`)
    }
  }
  return opts
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** True only when a real FILE sits at the path (recover's shape check). */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// ---------- the evidence GC classifies against (read-only) ----------

/**
 * The dispatch evidence GC consumes: the run header's repo and every dispatch
 * line's branch/worktreePath (written in-run by src/runner.ts, T-010). The
 * pid/completion records recovery needs have no GC consumer; a truncated or
 * unparseable line is skipped — partial evidence is the point of the file.
 */
interface GcEvidence {
  headerRepo: string | null
  dispatches: { branch: string | null; worktreePath: string | null }[]
}

function readDispatchEvidence(runDir: string): GcEvidence | null {
  let raw: string
  try {
    raw = readFileSync(join(runDir, 'dispatch.jsonl'), 'utf8')
  } catch {
    return null
  }
  const ev: GcEvidence = { headerRepo: null, dispatches: [] }
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
    if (obj.type === 'run') {
      if (ev.headerRepo === null && typeof obj.repo === 'string') ev.headerRepo = obj.repo
      readable++
    } else if (obj.type === 'dispatch') {
      ev.dispatches.push({
        branch: typeof obj.branch === 'string' ? obj.branch : null,
        worktreePath: typeof obj.worktreePath === 'string' ? obj.worktreePath : null,
      })
      readable++
    }
  }
  return readable > 0 ? ev : null
}

/** The recovery.json workspaces (written by src/recover.ts, T-010): the
 *  report-only inspection GC consumes — never produces. */
interface GcRecovery {
  workspaces: { path: string; branch: string | null }[]
}

function readRecovery(runDir: string): GcRecovery | null {
  let parsed: Partial<GcRecovery>
  try {
    parsed = JSON.parse(readFileSync(join(runDir, 'recovery.json'), 'utf8')) as Partial<GcRecovery>
  } catch {
    return null
  }
  const raw = parsed.workspaces
  const workspaces: unknown[] = Array.isArray(raw) ? raw : []
  return {
    workspaces: workspaces
      .filter((w): w is { path: string; branch?: unknown } =>
        w !== null && typeof w === 'object' && typeof (w as { path?: unknown }).path === 'string')
      .map((w) => ({ path: w.path, branch: typeof w.branch === 'string' ? w.branch : null })),
  }
}

// ---------- target collection + branch ownership ----------

/** Integration-replay worktrees (src/integrate.ts: wt/int-<candidate>,
 *  detached, dirty by construction) are never auto-disposed — spec §16.1's
 *  integration retention class: held until a human disposes them. */
const INT_WORKTREE_RE = /^int-/

/**
 * Disposal targets for a crashed-reconciled run, from the three evidence
 * sources the ticket names — dispatch records' worktreePath/branch, the
 * recovery.json workspaces, and wt/-discovery — deduped by path, with
 * wt/int-* paths excluded and reported as held.
 */
function collectTargets(
  runDir: string,
  ev: GcEvidence | null,
  recovery: GcRecovery | null,
): { targets: { path: string; fallbackBranch: string | null }[]; held: string[] } {
  const wtDir = join(runDir, 'wt')
  const seen = new Set<string>()
  const targets: { path: string; fallbackBranch: string | null }[] = []
  const held: string[] = []
  const consider = (path: string | null, fallbackBranch: string | null): void => {
    if (path === null) return
    if (INT_WORKTREE_RE.test(basename(path))) {
      if (!held.includes(path)) held.push(path)
      return
    }
    if (seen.has(normPath(path))) return
    seen.add(normPath(path))
    targets.push({ path, fallbackBranch })
  }
  for (const d of ev?.dispatches ?? []) consider(d.worktreePath, d.branch)
  for (const w of recovery?.workspaces ?? []) consider(w.path, w.branch)
  if (existsSync(wtDir)) {
    for (const name of readdirSync(wtDir)) {
      consider(join(wtDir, name), branchForLeaseId(`wt/${name}`))
    }
  }
  return { targets, held }
}

/**
 * Every swarm/* branch attributable to this run — the only branches its sweep
 * may delete: the dispatch records' branch fields, the recovery workspaces'
 * branches, the report candidates' lease branches (retry legs
 * `wt/<id>-a<n>` → `swarm/wt-<id>-a<n>` included), and the wt/ entry names.
 */
function ownedBranches(
  runDir: string,
  report: ReturnType<typeof readReport>,
  ev: GcEvidence | null,
  recovery: GcRecovery | null,
): Set<string> {
  const wtDir = join(runDir, 'wt')
  const owned = new Set<string>()
  for (const d of ev?.dispatches ?? []) {
    if (d.branch !== null) owned.add(d.branch)
  }
  for (const w of recovery?.workspaces ?? []) {
    if (w.branch !== null) owned.add(w.branch)
  }
  for (const c of report?.candidates ?? []) {
    if (typeof c.id !== 'string' || c.id === '') continue
    owned.add(branchForLeaseId(`wt/${c.id}`))
    const attempts = (c as { attempts?: { number?: unknown }[] }).attempts
    for (const a of Array.isArray(attempts) ? attempts : []) {
      if (a !== null && typeof a === 'object' && typeof a.number === 'number' && a.number >= 2) {
        owned.add(branchForLeaseId(`wt/${c.id}-a${a.number}`))
      }
    }
  }
  if (existsSync(wtDir)) {
    for (const name of readdirSync(wtDir)) {
      owned.add(branchForLeaseId(`wt/${name}`))
    }
  }
  return owned
}

/**
 * The repo-side branch sweep: delete exactly the swarm/* branches that have
 * no registered worktree and are attributable to a terminal run; report the
 * unowned ones and keep them; keep anything a registered worktree holds.
 * A branch whose tip sits beyond the run's baseSha carries worker commits —
 * evidence, refused by removeBranch's guard (T-044). The "workers never
 * commit" premise of the old comment is now ENFORCED here, not assumed: the
 * diff capture pins baseSha (src/workspace/worktree.ts), so a committing
 * worker's work survives in diff.patch and its branch is refused, never
 * silently shredded. A run with no recorded baseSha keeps the pre-T-044
 * sweep behavior.
 */
function sweepBranches(repo: string, owned: Set<string>, res: RunResult, expectedBaseSha: string | null = null): void {
  const registeredBranches = new Set(
    [...registeredWorktrees(repo).values()].filter((b): b is string => b !== null),
  )
  let listed: string
  try {
    listed = git(repo, ['branch', '--list', 'swarm/*'])
  } catch (e) {
    console.error(`failed (branch --list swarm/*): ${errorMessage(e)}`)
    res.failed++
    return
  }
  for (const line of listed.split('\n')) {
    const branch = line.replace(/^[*+]\s*/, '').trim()
    if (branch === '') continue
    if (registeredBranches.has(branch)) {
      console.log(`branch held by a registered worktree — kept: ${branch}`)
      continue
    }
    if (owned.has(branch)) {
      removeBranch(repo, branch, res, { expectedBaseSha })
    } else {
      console.log(`unowned swarm/* branch — never deleted (no terminal run attributes it): ${branch}`)
    }
  }
}

// ---------- the per-run pass ----------

interface ClassTotals {
  live: number
  unreconciled: number
  reconciled: number
  finished: number
}

function gcRunDir(runDir: string, opts: Options, totals: ClassTotals): RunResult {
  const runId = basename(runDir)
  const res: RunResult = { removed: 0, refused: 0, failed: 0 }
  const report = readReport(runDir)
  const hasReport = isFile(join(runDir, 'report.json'))
  const hasRecovery = isFile(join(runDir, 'recovery.json'))
  const ev = readDispatchEvidence(runDir)
  const recovery = readRecovery(runDir)
  const wtDir = join(runDir, 'wt')

  // The target repo: report.json's repo field, falling back to the dispatch
  // header's, then to the worktrees' own .git pointers (the clean/recover
  // crash-mid-run pattern).
  const sniffCandidates = [
    ...(existsSync(wtDir) ? readdirSync(wtDir).map((n) => join(wtDir, n)) : []),
    ...((ev?.dispatches ?? []).map((d) => d.worktreePath).filter((p): p is string => p !== null)),
    ...((recovery?.workspaces ?? []).map((w) => w.path)),
  ]
  let repo: string | null = typeof report?.repo === 'string' && existsSync(report.repo) ? report.repo : null
  if (repo === null && ev?.headerRepo != null && existsSync(ev.headerRepo)) repo = ev.headerRepo
  if (repo === null) {
    repo = sniffCandidates.map((p) => sniffRepo(p)).find((r): r is string => r !== null && existsSync(r)) ?? null
  }

  // Class 1 — the lock check IS the liveness probe: a refusal means the run
  // may be live, and the never-guess policy (T-004, spec §15.2) removes
  // nothing. --force-lock is the explicit human override, exactly clean's.
  let lockPath: string | null = null
  if (repo !== null) {
    try {
      lockPath = acquireCheckoutLock(opts.runRoot, repo, { cmd: 'gc', runId }, opts.forceLock)
    } catch (e) {
      if (e instanceof CheckoutLockRefused) {
        console.log(`class: live (checkout lock held) — nothing removed`)
        console.log(e.message)
        totals.live++
        return res
      }
      throw e
    }
  }

  // The run's recorded base (report baseSha): the tip every lease branch
  // sits at unless a worker committed — removeBranch's T-044 guard reads it
  // (null for crashed-reconciled runs, which carry no report.json).
  const expectedBaseSha = typeof report?.baseSha === 'string' && report.baseSha !== '' ? report.baseSha : null

  try {
    if (!hasReport && !hasRecovery) {
      totals.unreconciled++
      console.log(`class: crashed-unreconciled (no report.json, no recovery.json) — run \`npm run recover\` first; nothing removed`)
      return res
    }

    if (hasRecovery && !hasReport) {
      totals.reconciled++
      console.log(`class: crashed-reconciled (recovery.json present, no report.json) — worktrees + branches are disposable`)
      if (repo === null) {
        console.error(`failed: cannot determine the target repository for ${runDir} (no dispatch header repo, no readable worktree .git)`)
        res.failed++
        return res
      }
      const { targets, held } = collectTargets(runDir, ev, recovery)
      for (const h of held) console.log(`held (wt/int-* integration-replay worktree — human disposition, spec §16.1): ${h}`)
      disposeTargets(repo, targets, false, res, expectedBaseSha)
      try { rmdirSync(wtDir) } catch { /* still has contents — fine */ }
      if (res.refused > 0) {
        console.error(`gc never discards changes (no --force) — to dispose the refused worktree(s): npm run clean -- --run ${runId} --force`)
      }
      sweepBranches(repo, ownedBranches(runDir, report, ev, recovery), res, expectedBaseSha)
      return res
    }

    totals.finished++
    console.log(`class: finished (report.json present) — no worktree disposal; branch sweep only`)
    if (repo === null) {
      console.log(`no target repo determinable — branch sweep skipped`)
      return res
    }
    sweepBranches(repo, ownedBranches(runDir, report, ev, recovery), res, expectedBaseSha)
    return res
  } finally {
    if (lockPath) releaseCheckoutLock(lockPath)
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  if (!existsSync(opts.runRoot)) {
    console.error(`run root does not exist: ${opts.runRoot}`)
    process.exit(1)
  }

  const runs = readdirSync(opts.runRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{14}$/.test(d.name))
    .map((d) => d.name)
    .sort()
  if (runs.length === 0) {
    console.log(`no run directories under ${opts.runRoot}`)
    process.exit(0)
  }

  const totals: ClassTotals = { live: 0, unreconciled: 0, reconciled: 0, finished: 0 }
  let removed = 0
  let refused = 0
  let failed = 0
  let blocked = false
  for (const id of runs) {
    console.log(`\n=== run ${id} ===`)
    const res = gcRunDir(join(opts.runRoot, id), opts, totals)
    console.log(`gc: ${res.removed} removed, ${res.refused} refused, ${res.failed} failed`)
    removed += res.removed
    refused += res.refused
    failed += res.failed
    if (res.refused > 0 || res.failed > 0) blocked = true
  }
  console.log(`\ngc: ${runs.length} run dir(s) — ${totals.live} live (skipped), ${totals.unreconciled} crashed-unreconciled, ${totals.reconciled} crashed-reconciled, ${totals.finished} finished; ${removed} removed, ${refused} refused, ${failed} failed`)
  process.exit(blocked ? 1 : 0)
}

try {
  main()
} catch (e: unknown) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
