import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceLease, WorkspaceProvider } from '../types.js'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
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
    const branch = id.replaceAll(/[\\/]/g, '-').replaceAll('_', '-')
    mkdirSync(this.rootDir, { recursive: true })
    const baseSha = git(this.repo, ['rev-parse', baseRef]).trim()
    git(this.repo, ['worktree', 'add', path, '-b', `swarm/${branch}`, baseSha])
    return { id, path, branch: `swarm/${branch}`, baseSha }
  }

  diff(lease: WorkspaceLease): string {
    // --intent-to-add makes untracked new files appear in `git diff`;
    // diffing against HEAD also captures anything the worker staged.
    git(lease.path, ['add', '-A', '--intent-to-add', '.'])
    return git(lease.path, ['diff', 'HEAD'])
  }

  dispose(lease: WorkspaceLease): void {
    git(this.repo, ['worktree', 'remove', '--force', lease.path])
  }
}
