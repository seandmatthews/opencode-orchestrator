// Run artifact cleanup (T-002): dispose a run's worktrees and swarm/* branches.
//
//   npm run clean -- --run <runId> [--force] [--run-root <path>]
//   npm run clean -- --all [--force] [--run-root <path>]
//
// Evidence (report.json, diff.patch, logs) is never deleted — only git
// worktrees and their branches. A worktree holding uncommitted changes is
// refused unless --force: those changes may be the only un-captured copy.
// Every git subprocess is list-form, never through a shell (AGENTS.md #4) —
// hand-rolled shell loops on exactly this path bit us twice
// (VERIFICATION.md Known issues #4).
// Since T-004 each run's disposal happens under the per-target-repo checkout
// lock (src/lock.ts): a refused lock removes nothing and names the holder.
import { existsSync, readdirSync, rmdirSync } from 'node:fs'
import { basename, join } from 'node:path'
// readReport/RunResult/removeBranch/disposeTargets are the shared disposal
// internals (T-020), extracted verbatim from this file so src/gc.ts drives
// the exact same per-worktree semantics; the loop lives in src/disposal.ts.
import { disposeTargets, readReport, type RunResult } from './disposal.js'
import { acquireCheckoutLock, CheckoutLockRefused, releaseCheckoutLock } from './lock.js'
import { branchForLeaseId, normPath, sniffRepo } from './workspace/worktree.js'

const usage = `Dispose a run's git worktrees and swarm/* branches; keep all evidence.

Usage:
  npm run clean -- --run <runId> [options]
  npm run clean -- --all [options]

Options:
  --run <runId>        Clean one run directory under the run root
  --all                Clean every run directory under the run root that is
                       not the newest (run directories are 14-digit timestamps)
  --force              Remove worktrees even when they hold uncommitted changes
  --force-lock         Take the checkout lock even if another (suspected-stale)
                       holder still owns it
  --run-root <path>    Where runs live (default: C:\\swarm)
  --help               Show this help

Worktrees are taken from the run's report.json, plus anything else discovered
under its wt/ directory; the target repo comes from report.json (repo field),
falling back to the worktrees' own .git pointers. Artifacts are never deleted.
Exit 0 when nothing was refused or failed; 1 otherwise.`

interface Options {
  runRoot: string
  run: string | null
  all: boolean
  force: boolean
  forceLock: boolean
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { runRoot: 'C:\\swarm', run: null, all: false, force: false, forceLock: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${arg}`)
      return v
    }
    switch (arg) {
      case '--run': opts.run = value(); break
      case '--all': opts.all = true; break
      case '--force': opts.force = true; break
      case '--force-lock': opts.forceLock = true; break
      case '--run-root': opts.runRoot = value(); break
      case '--help': case '-h': console.log(usage); process.exit(0)
      default: throw new Error(`unknown option: ${arg}\n\n${usage}`)
    }
  }
  if (!opts.run && !opts.all) throw new Error(`one of --run <runId> or --all is required\n\n${usage}`)
  if (opts.run && opts.all) throw new Error(`--run and --all are mutually exclusive\n\n${usage}`)
  return opts
}

/** Windows path identity: `normPath` (shared with src/workspace/worktree.ts). */
const norm = normPath

function cleanRunDir(runDir: string, force: boolean, forceLock: boolean, runRoot: string): RunResult {
  const res: RunResult = { removed: 0, refused: 0, failed: 0 }
  const report = readReport(runDir)
  const wtDir = join(runDir, 'wt')

  const targets: { path: string; fallbackBranch: string | null }[] = []
  const seen = new Set<string>()
  for (const c of report?.candidates ?? []) {
    if (!c.workspacePath) continue
    seen.add(norm(c.workspacePath))
    targets.push({ path: c.workspacePath, fallbackBranch: c.id ? branchForLeaseId(`wt/${c.id}`) : null })
  }
  if (existsSync(wtDir)) {
    for (const name of readdirSync(wtDir)) {
      const path = join(wtDir, name)
      if (!seen.has(norm(path))) targets.push({ path, fallbackBranch: branchForLeaseId(`wt/${name}`) })
    }
  }
  if (targets.length === 0) {
    console.log('nothing to clean (no live worktree records in report.json or wt/)')
    return res
  }

  let repo = report?.repo ?? null
  if (!repo) repo = sniffRepo(targets[0]!.path)
  if (!repo || !existsSync(repo)) {
    console.error(`failed: cannot determine the target repository for ${runDir} (no report.json repo field, no readable worktree .git)`)
    res.failed++
    return res
  }

  // Disposal mutates the target repo's worktrees, so it happens under the
  // cross-run checkout lock. A refusal removes nothing (evidence-never-deleted
  // survives by construction) and names the holder.
  let lockPath: string | null = null
  try {
    try {
      lockPath = acquireCheckoutLock(runRoot, repo, { cmd: 'clean', runId: basename(runDir) }, forceLock)
    } catch (e) {
      if (e instanceof CheckoutLockRefused) {
        console.error(`refused (checkout lock held) — nothing was removed for ${runDir}`)
        console.error(e.message)
        res.refused++
        return res
      }
      throw e
    }

    disposeTargets(repo, targets, force, res, report?.baseSha ?? null)

    try { rmdirSync(wtDir) } catch { /* still has contents — fine */ }
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

  if (opts.run) {
    const runDir = join(opts.runRoot, opts.run)
    if (!existsSync(runDir)) {
      console.error(`no such run directory: ${runDir}`)
      process.exit(1)
    }
    console.log(`=== run ${opts.run} ===`)
    const res = cleanRunDir(runDir, opts.force, opts.forceLock, opts.runRoot)
    console.log(`\nclean: ${res.removed} removed, ${res.refused} refused, ${res.failed} failed`)
    process.exit(res.refused > 0 || res.failed > 0 ? 1 : 0)
  }

  // --all: every run directory (14-digit timestamp names) except the newest.
  const runs = readdirSync(opts.runRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{14}$/.test(d.name))
    .map((d) => d.name)
    .sort()
  if (runs.length === 0) {
    console.log(`no run directories under ${opts.runRoot}`)
    process.exit(0)
  }
  const newest = runs[runs.length - 1]!
  console.log(`keeping newest run: ${newest}`)
  let blocked = false
  for (const id of runs.slice(0, -1)) {
    console.log(`\n=== run ${id} ===`)
    const res = cleanRunDir(join(opts.runRoot, id), opts.force, opts.forceLock, opts.runRoot)
    console.log(`clean: ${res.removed} removed, ${res.refused} refused, ${res.failed} failed`)
    if (res.refused > 0 || res.failed > 0) blocked = true
  }
  process.exit(blocked ? 1 : 0)
}

try {
  main()
} catch (e: unknown) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
