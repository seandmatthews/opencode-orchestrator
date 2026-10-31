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
//
// T-052: programmatic release (`releaseCheckoutLock`) verifies OWNERSHIP
// first — it never deletes a lock that names another pid (a --force-lock
// taker's) or one it cannot identify; the CLI `release` verb is the explicit
// human override and drops any holder.
import { defaultRunRoot } from './run-root.js'
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

/** What a programmatic `releaseCheckoutLock` attempt did (T-052). */
export type LockRelease =
  | 'released' // the file named this process — unlinked
  | 'already-missing' // nothing at the path: the pre-T-052 ENOENT-is-ok, unchanged
  | 'held-by-other' // the file names a different pid (a force-taker's) — skipped loudly
  | 'unreadable' // the file exists but cannot be identified — skipped loudly

/**
 * Drop the lock, only when this process provably holds it (T-052). Before
 * unlinking, the file is read and its recorded `pid` compared to
 * `process.pid`: a mismatch means a `--force-lock` taker replaced our lock
 * and our stale `finally` release must NOT delete the new holder's — that
 * sequence (A holds, B force-takes, A finishes) broke mutual exclusion in
 * exactly the scenario `--force-lock` exists for. A file that cannot be read
 * or parsed is never deleted either (never delete what you cannot
 * identify); both skips are loud on stderr. A missing file stays today's
 * ENOENT-is-ok. The read-then-unlink window is the same order of race the
 * exclusive-create acquire already accepts. The explicit human override is
 * `forceReleaseCheckoutLock` (the CLI `release` verb) — never this function.
 */
export function releaseCheckoutLock(lockPath: string): LockRelease {
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'already-missing'
    throw e
  }
  let holderPid: number | null = null
  try {
    const parsed = JSON.parse(raw) as Partial<LockContents>
    if (typeof parsed.pid === 'number') holderPid = parsed.pid
  } catch {
    // unreadable JSON — held as unidentifiable below
  }
  if (holderPid === null) {
    console.error(`lock at ${lockPath} is unreadable — not releasing (never delete what you cannot identify); the override is: tsx src/lock.ts release <repo>`)
    return 'unreadable'
  }
  if (holderPid !== process.pid) {
    console.error(`lock at ${lockPath} is held by pid ${holderPid} — force-taken; not releasing`)
    return 'held-by-other'
  }
  try {
    unlinkSync(lockPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  return 'released'
}

/**
 * Drop whatever occupies the lock path, holder or not (T-052). This is the
 * CLI `release` verb's primitive — the explicit human override,
 * `--force-lock`'s counterpart for release — never called by the engine's
 * programmatic paths, whose releases go through the ownership-verified
 * `releaseCheckoutLock`.
 */
export function forceReleaseCheckoutLock(lockPath: string): void {
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
(pid, age, and lock file path are printed). release drops ANY holder — it
is the explicit human override, --force-lock's counterpart for release
(the engine's own releases verify ownership and never delete a lock they
cannot prove their own, T-052). release exits 0 when no lock file
remains. Locks live under <run-root>\\locks\\, never inside the repo.`
}

function cliMain(argv: string[]): void {
  const [verb, repo] = argv
  if (verb !== 'acquire' && verb !== 'release') throw new Error(`expected 'acquire' or 'release'\n\n${usage()}`)
  if (!repo) throw new Error(`a repo path is required\n\n${usage()}`)

  let runRoot = defaultRunRoot()
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
    forceReleaseCheckoutLock(p)
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
