// Cross-process checkout lock (T-004): `npm run skeleton` and `npm run clean`
// must never concurrently mutate one target repo's worktrees.
//
// Acquire = `fs.openSync(path, 'wx')` exclusive create, Node stdlib only.
// An occupied lock refuses immediately — no waiting, no retry loop, and the
// stale-lock policy is never-guess: nothing auto-reaps a lock (a hard-killed
// run leaves one blocking until a human overrides with --force-lock), per
// spec §15.2's "no live process is silently reattached based on stale PID
// metadata". Lock files live under <run-root>\locks\<sha256(norm(repo))>.lock
// — never inside the target repo (AGENTS.md #3), and `locks/` is structurally
// safe from `clean --all`, which sweeps only /^\d{14}$/ directories.
// Contents are diagnosability only: { pid, startedAt, cmd, runId? }.
//
// Doubles as a CLI so scripts and humans can hold or clear a lock without
// duplicating the path derivation:
//   tsx src/lock.ts acquire <repo> [--run-root <path>] [--run-id <id>] [--force-lock]
//   tsx src/lock.ts release <repo> [--run-root <path>]
// acquire exits 0 when taken, 1 when held elsewhere; release always exits 0
// when no lock file remains.
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface LockContents {
  pid: number
  startedAt: string
  cmd: string
  runId?: string
}

/** Windows path identity, same normalization as src/clean.ts: forward slashes, case-insensitive. */
const norm = (p: string): string => p.replaceAll('\\', '/').toLowerCase()

export function lockPathFor(runRoot: string, repoPath: string): string {
  const hash = createHash('sha256').update(norm(repoPath)).digest('hex').slice(0, 16)
  return join(runRoot, 'locks', `${hash}.lock`)
}

/** Thrown when the lock is held elsewhere; message carries pid, age, and file path. */
export class CheckoutLockRefused extends Error {
  readonly lockPath: string
  readonly holder: LockContents | null

  constructor(lockPath: string, holder: LockContents | null) {
    super(refusalMessage(lockPath, holder))
    this.name = 'CheckoutLockRefused'
    this.lockPath = lockPath
    this.holder = holder
  }
}

function readHolder(lockPath: string): LockContents | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockContents>
    return typeof parsed.pid === 'number' ? parsed as LockContents : null
  } catch {
    return null
  }
}

function heldFor(startedAt: string): string {
  const t = Date.parse(startedAt)
  if (!Number.isFinite(t)) return 'an unknown duration'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`
}

function refusalMessage(lockPath: string, holder: LockContents | null): string {
  const who = holder ? `pid ${holder.pid} (${holder.cmd}${holder.runId ? `, run ${holder.runId}` : ''})` : 'an unreadable holder'
  const since = holder ? `held for ${heldFor(holder.startedAt)}` : 'of unknown age'
  return `checkout lock held by ${who}, ${since} — ${lockPath}. ` +
    'A hard-killed run leaves this lock in place; nothing reaps it automatically. ' +
    'If no live process holds it, re-run with --force-lock to take it.'
}

/**
 * Take the lock or throw CheckoutLockRefused. With `force`, an existing lock
 * file is removed first — the explicit human override for a suspected-stale
 * holder. Returns the lock path the holder must pass to releaseCheckoutLock.
 */
export function acquireCheckoutLock(
  runRoot: string,
  repoPath: string,
  holder: { cmd: string; runId?: string },
  force = false,
): string {
  const lockPath = lockPathFor(runRoot, repoPath)
  mkdirSync(join(runRoot, 'locks'), { recursive: true })
  if (force) {
    try {
      unlinkSync(lockPath)
    } catch {
      // nothing to take over
    }
  }
  const contents: LockContents = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cmd: holder.cmd,
    ...(holder.runId !== undefined ? { runId: holder.runId } : {}),
  }
  let fd: number
  try {
    fd = openSync(lockPath, 'wx')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CheckoutLockRefused(lockPath, readHolder(lockPath))
    }
    throw e
  }
  try {
    writeSync(fd, JSON.stringify(contents, null, 2))
  } finally {
    closeSync(fd)
  }
  return lockPath
}

/** Drop the lock. A missing file is already released; anything else is a real error. */
export function releaseCheckoutLock(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

function usage(): string {
  return `Cross-process checkout lock over a target repo (T-004).

Usage:
  tsx src/lock.ts acquire <repo> [--run-root <path>] [--run-id <id>] [--force-lock]
  tsx src/lock.ts release <repo> [--run-root <path>]

acquire exits 0 when the lock was taken, 1 when it is held elsewhere
(pid, age, and lock file path are printed). release exits 0 when no lock
file remains. Locks live under <run-root>\\locks\\, never inside the repo.`
}

function cliMain(argv: string[]): void {
  const [verb, repo] = argv
  if (verb !== 'acquire' && verb !== 'release') throw new Error(`expected 'acquire' or 'release'\n\n${usage()}`)
  if (!repo) throw new Error(`a repo path is required\n\n${usage()}`)

  let runRoot = 'C:\\swarm'
  let runId: string | undefined
  let force = false
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${arg}`)
      return v
    }
    switch (arg) {
      case '--run-root': runRoot = value(); break
      case '--run-id': runId = value(); break
      case '--force-lock': force = true; break
      case '--help': case '-h': console.log(usage()); process.exit(0)
      default: throw new Error(`unknown option: ${arg}\n\n${usage()}`)
    }
  }

  if (verb === 'release') {
    const p = lockPathFor(runRoot, repo)
    releaseCheckoutLock(p)
    console.log(`released: ${p}`)
    return
  }

  const p = acquireCheckoutLock(runRoot, repo, { cmd: 'lock-cli', runId }, force)
  console.log(`acquired: ${p}`)
}

// CLI entry only when run directly (tsx src/lock.ts ...); imports never trigger it.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    cliMain(process.argv.slice(2))
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
}
