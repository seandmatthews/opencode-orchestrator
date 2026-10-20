import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceLease, WorkspaceProvider } from '../types.js'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

/** Windows path identity for map keys: forward slashes, case-insensitive
 *  (the src/clean.ts normalization — shared by every worktree lookup). */
export const normPath = (p: string): string => p.replaceAll('\\', '/').toLowerCase()

/** Lease ids become branch names: `wt/c01` → `swarm/wt-c01`. */
export function branchForLeaseId(id: string): string {
  return `swarm/${id.replaceAll(/[\\/]/g, '-').replaceAll('_', '-')}`
}

/**
 * Repo root read out of a worktree's `.git` pointer, used when a run has no
 * report.json (crash mid-run). Format: `gitdir: <repo>/.git/worktrees/<name>`.
 * Shared by clean (T-002) and recover (T-010).
 */
export function sniffRepo(worktreePath: string): string | null {
  try {
    const pointer = readFileSync(join(worktreePath, '.git'), 'utf8').trim()
    const gitdir = pointer.match(/^gitdir:\s*(.*)$/)?.[1]
    return gitdir?.match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+/)?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * path → branch name (null for detached), from `git worktree list
 * --porcelain`. Read-only inspection shared by clean (T-002) and recover
 * (T-010); list-form git only (AGENTS.md #4).
 */
export function registeredWorktrees(repo: string): Map<string, string | null> {
  const map = new Map<string, string | null>()
  let path: string | null = null
  for (const line of git(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch ') && path !== null) {
      map.set(normPath(path), line.slice('branch '.length).replace(/^refs\/heads\//, ''))
    } else if (line === '' && path !== null) {
      if (!map.has(normPath(path))) map.set(normPath(path), null)
      path = null
    }
  }
  if (path !== null && !map.has(normPath(path))) map.set(normPath(path), null)
  return map
}

/**
 * Git worktrees as disposable candidate workspaces. Every candidate in a
 * run is pinned to the same base SHA, so diffs are directly comparable and
 * the canonical checkout is never handed to a model.
 */
export class WorktreeProvider implements WorkspaceProvider {
  constructor(
    private readonly repo: string,
    private readonly rootDir: string,
  ) {}

  lease(id: string, baseRef: string): WorkspaceLease {
    const path = join(this.rootDir, id)
    mkdirSync(this.rootDir, { recursive: true })
    const baseSha = git(this.repo, ['rev-parse', baseRef]).trim()
    const branch = branchForLeaseId(id)
    git(this.repo, ['worktree', 'add', path, '-b', branch, baseSha])
    return { id, path, branch, baseSha }
  }

  diff(lease: WorkspaceLease): string {
    // --intent-to-add makes untracked new files appear in `git diff`;
    // diffing against HEAD also captures anything the worker staged.
    // --binary (T-026) records binary hunks as `GIT binary patch` literal
    // sections carrying the full 40-hex index lines git apply requires,
    // instead of the lossy "Binary files … differ" stub that can never
    // replay. Output stays printable ASCII + newlines — still a string.
    git(lease.path, ['add', '-A', '--intent-to-add', '.'])
    return git(lease.path, ['diff', 'HEAD', '--binary'])
  }

  dispose(lease: WorkspaceLease): void {
    git(this.repo, ['worktree', 'remove', '--force', lease.path])
  }
}
