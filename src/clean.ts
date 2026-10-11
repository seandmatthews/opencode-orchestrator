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
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { branchForLeaseId } from './workspace/worktree.js'

const usage = `Dispose a run's git worktrees and swarm/* branches; keep all evidence.

Usage:
  npm run clean -- --run <runId> [options]
  npm run clean -- --all [options]

Options:
  --run <runId>        Clean one run directory under the run root
  --all                Clean every run directory under the run root that is
                       not the newest (run directories are 14-digit timestamps)
  --force              Remove worktrees even when they hold uncommitted changes
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
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { runRoot: 'C:\\swarm', run: null, all: false, force: false }
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
      case '--run-root': opts.runRoot = value(); break
      case '--help': case '-h': console.log(usage); process.exit(0)
      default: throw new Error(`unknown option: ${arg}\n\n${usage}`)
    }
  }
  if (!opts.run && !opts.all) throw new Error(`one of --run <runId> or --all is required\n\n${usage}`)
  if (opts.run && opts.all) throw new Error(`--run and --all are mutually exclusive\n\n${usage}`)
  return opts
}

/** Windows path identity for map keys: forward slashes, case-insensitive. */
const norm = (p: string): string => p.replaceAll('\\', '/').toLowerCase()

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

interface RunReportLike {
  repo?: string
  candidates?: { id: string; workspacePath: string | null }[]
}

function readReport(runDir: string): RunReportLike | null {
  try {
    return JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')) as RunReportLike
  } catch {
    return null
  }
}

/** path → branch name (null for detached), from `git worktree list --porcelain`. */
function registeredWorktrees(repo: string): Map<string, string | null> {
  const map = new Map<string, string | null>()
  let path: string | null = null
  for (const line of git(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch ') && path !== null) {
      map.set(norm(path), line.slice('branch '.length).replace(/^refs\/heads\//, ''))
    } else if (line === '' && path !== null) {
      if (!map.has(norm(path))) map.set(norm(path), null)
      path = null
    }
  }
  if (path !== null && !map.has(norm(path))) map.set(norm(path), null)
  return map
}

/**
 * Repo root read out of a worktree's `.git` pointer, used when a run has no
 * report.json (crash mid-run). Format: `gitdir: <repo>/.git/worktrees/<name>`.
 */
function sniffRepo(worktreePath: string): string | null {
  try {
    const pointer = readFileSync(join(worktreePath, '.git'), 'utf8').trim()
    const gitdir = pointer.match(/^gitdir:\s*(.*)$/)?.[1]
    return gitdir?.match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+/)?.[1] ?? null
  } catch {
    return null
  }
}

interface RunResult {
  removed: number
  refused: number
  failed: number
}

function removeBranch(repo: string, branch: string, res: RunResult): void {
  try {
    if (git(repo, ['branch', '--list', branch]).trim() === '') {
      console.log(`branch already gone: ${branch}`)
      return
    }
    git(repo, ['branch', '-D', branch])
    console.log(`removed branch: ${branch}`)
    res.removed++
  } catch (e) {
    console.error(`failed (branch -D ${branch}): ${errorMessage(e)}`)
    res.failed++
  }
}

function cleanRunDir(runDir: string, force: boolean): RunResult {
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

  const registered = registeredWorktrees(repo)
  for (const t of targets) {
    const observed = registered.get(norm(t.path))
    const branch = observed ?? t.fallbackBranch

    if (observed === undefined) {
      if (!existsSync(t.path)) {
        console.log(`already gone: ${t.path}`)
        if (branch) removeBranch(repo, branch, res)
        continue
      }
      console.error(`refused (exists but is not a registered git worktree — inspect manually): ${t.path}`)
      res.refused++
      continue
    }

    if (existsSync(t.path)) {
      let dirty: boolean
      try {
        dirty = git(t.path, ['status', '--porcelain']).trim() !== ''
      } catch (e) {
        console.error(`failed (status check on ${t.path}): ${errorMessage(e)}`)
        res.failed++
        continue
      }
      if (dirty && !force) {
        console.error(`refused (uncommitted changes; re-run with --force to discard): ${t.path}`)
        res.refused++
        continue
      }
    }

    try {
      git(repo, ['worktree', 'remove', '--force', t.path])
      console.log(`removed worktree: ${t.path}`)
      res.removed++
    } catch (e) {
      // Registered but with a missing/partial directory: a metadata prune
      // clears the registration when git cannot remove the tree itself.
      try { git(repo, ['worktree', 'prune']) } catch { /* report the original error */ }
      if (registeredWorktrees(repo).has(norm(t.path))) {
        console.error(`failed (git worktree remove): ${errorMessage(e)}`)
        res.failed++
        continue
      }
      console.log(`removed worktree (pruned stale registration): ${t.path}`)
      res.removed++
    }
    if (branch) removeBranch(repo, branch, res)
  }

  try { rmdirSync(wtDir) } catch { /* still has contents — fine */ }
  return res
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
    const res = cleanRunDir(runDir, opts.force)
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
    const res = cleanRunDir(join(opts.runRoot, id), opts.force)
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
