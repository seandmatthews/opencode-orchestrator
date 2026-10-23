// Shared disposal internals (T-020): the per-worktree disposal loop and the
// evidence readers both `src/clean.ts` (T-002) and `src/gc.ts` (T-020) drive.
// Extracted verbatim from src/clean.ts so both commands share one disposal
// semantics — dirty-refusal, prune fallback, branch-removal-after-removal —
// instead of a second diverging copy. Deliberately NOT
// src/workspace/worktree.ts: that file is the WorkspaceProvider seam (the
// lease/diff/dispose interface, decisions.md 2026-10-18); this module is
// disposal policy over recorded evidence, a different concern with different
// consumers.
//
// Evidence files are never deleted here — only git worktrees and their
// `swarm/*` branches (the T-002 rule). Every git subprocess is list-form,
// never through a shell (AGENTS.md #4).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normPath, registeredWorktrees } from './workspace/worktree.js'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export interface RunReportLike {
  repo?: string
  /** The run's pinned base (report baseSha): the tip every worker lease
   *  branch sits at unless a worker committed (T-044's guard reads it). */
  baseSha?: string
  candidates?: { id: string; workspacePath: string | null }[]
}

export function readReport(runDir: string): RunReportLike | null {
  try {
    return JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')) as RunReportLike
  } catch {
    return null
  }
}

/** Per-item disposal tallies; a refused or failed item makes the command exit 1. */
export interface RunResult {
  removed: number
  refused: number
  failed: number
}

/** The T-044 branch guard: a `swarm/*` branch whose tip sits beyond the
 *  run's baseSha carries worker commits — evidence, refused without force.
 *  `expectedBaseSha` null/absent (no report, no recorded base) leaves the
 *  pre-T-044 behavior untouched; `force` is the same explicit human
 *  override the dirty-refusal honors (clean's --force; gc never passes it). */
export interface BranchGuard {
  expectedBaseSha?: string | null
  force?: boolean
}

export function removeBranch(repo: string, branch: string, res: RunResult, guard: BranchGuard = {}): void {
  try {
    if (git(repo, ['branch', '--list', branch]).trim() === '') {
      console.log(`branch already gone: ${branch}`)
      return
    }
    if (typeof guard.expectedBaseSha === 'string' && guard.expectedBaseSha !== '') {
      const tip = git(repo, ['rev-parse', branch]).trim()
      if (tip !== guard.expectedBaseSha && !guard.force) {
        console.error(
          `refused (branch ${branch} carries commits beyond baseSha — evidence; re-run with --force to discard)` +
          ` tip=${tip.slice(0, 12)} base=${guard.expectedBaseSha.slice(0, 12)}`,
        )
        res.refused++
        return
      }
    }
    git(repo, ['branch', '-D', branch])
    console.log(`removed branch: ${branch}`)
    res.removed++
  } catch (e) {
    console.error(`failed (branch -D ${branch}): ${errorMessage(e)}`)
    res.failed++
  }
}

/** Per-worktree disposal loop — the T-002 semantics, unchanged except the
 *  T-044 branch guard: `expectedBaseSha` (the report's baseSha, when a run
 *  has one) makes every removeBranch below refuse a branch whose tip sits
 *  beyond the base — a committing worker's evidence, not garbage. */
export function disposeTargets(
  repo: string,
  targets: { path: string; fallbackBranch: string | null }[],
  force: boolean,
  res: RunResult,
  expectedBaseSha: string | null = null,
): void {
  const registered = registeredWorktrees(repo)
  for (const t of targets) {
    const observed = registered.get(normPath(t.path))
    const branch = observed ?? t.fallbackBranch

    if (observed === undefined) {
      if (!existsSync(t.path)) {
        console.log(`already gone: ${t.path}`)
        if (branch) removeBranch(repo, branch, res, { expectedBaseSha, force })
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
      if (registeredWorktrees(repo).has(normPath(t.path))) {
        console.error(`failed (git worktree remove): ${errorMessage(e)}`)
        res.failed++
        continue
      }
      console.log(`removed worktree (pruned stale registration): ${t.path}`)
      res.removed++
    }
    if (branch) removeBranch(repo, branch, res, { expectedBaseSha, force })
  }
}
