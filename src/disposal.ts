// Shared disposal internals (T-020): the per-worktree disposal loop and the
// evidence readers both `src/clean.ts` (T-002) and `src/gc.ts` (T-020) drive.
// Extracted verbatim from src/clean.ts so both commands share one disposal
// semantics — evidence-parity refusal (T-048), prune fallback,
// branch-removal-after-removal — instead of a second diverging copy.
// Deliberately NOT src/workspace/worktree.ts: that file is the
// WorkspaceProvider seam (the lease/diff/dispose interface, decisions.md
// 2026-10-18); this module is disposal policy over recorded evidence, a
// different concern with different consumers.
//
// Evidence files are never deleted here — only git worktrees and their
// `swarm/*` branches (the T-002 rule). Every git subprocess is list-form,
// never through a shell (AGENTS.md #4).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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

/** The stored final-attempt `diff.patch` for a lease-shaped worktree path —
 *  the runner's own evidence geometry (src/runner.ts): attempt 1 leases
 *  `wt/<id>` and captures to `<runDir>/<id>/diff.patch`; attempt n ≥ 2
 *  leases `wt/<id>-a<n>` and captures to `<runDir>/<id>/attempt-<n>/
 *  diff.patch` (the worktree sits at `<runDir>/wt/<name>`, so the mapping
 *  is exact by construction for every runner-produced lease, report or no
 *  report). Null for paths off the `wt/` convention (no evidence geometry
 *  to read — e.g. a relocated worktree). Ambiguity note, documented rather
 *  than resolved: a job id literally ending in `-a<digits>` would mis-map
 *  to an attempt subdir — the mis-map reads a nonexistent file and refuses
 *  (the conservative direction); it can never manufacture a false pass. */
export function evidenceDiffPath(worktreePath: string): string | null {
  const parent = dirname(worktreePath)
  if (basename(parent) !== 'wt') return null
  const name = basename(worktreePath)
  const retry = name.match(/^(.*)-a(\d+)$/)
  if (retry !== null && Number(retry[2]) >= 2) {
    return join(dirname(parent), retry[1]!, `attempt-${retry[2]}`, 'diff.patch')
  }
  return join(dirname(parent), name, 'diff.patch')
}

/** The stored final-attempt diff bytes for a worktree, or null when the
 *  evidence is missing/unreadable (no run dir, crashed before capture, a
 *  deleted or corrupt file). Null is the refuse-side input of the parity
 *  check — never a silent pass. */
function readStoredDiff(worktreePath: string): string | null {
  const p = evidenceDiffPath(worktreePath)
  if (p === null) return null
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
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

/** Per-worktree disposal loop — the T-002 semantics with two guards: the
 *  T-044 branch guard (`expectedBaseSha`, the report's baseSha when a run
 *  has one, makes every removeBranch below refuse a branch whose tip sits
 *  beyond the base — a committing worker's evidence, not garbage) and the
 *  T-048 evidence-parity refusal below. */
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
      // T-048: the evidence-parity predicate — a worktree is removable
      // without --force iff its current state matches what the captured
      // evidence holds, or holds nothing at all. It replaces the porcelain
      // read, which fired on 100% of normal operation: WorktreeProvider.diff
      // runs `git add -A --intent-to-add .` on every attempt, so porcelain
      // ALWAYS reads dirty for exactly the worktrees worth cleaning (the
      // 2026-10-23 scratch repro: ` M build.js` / `A notes-new-file.md`) —
      // a refusal that fires precisely when evidence EXISTS. Mechanically:
      // re-run the capture form in the worktree (the same two list-form git
      // calls worktree.ts makes), byte-compare against the run's stored
      // final-attempt diff.patch (the geometry evidenceDiffPath mirrors):
      //   equal (or both empty)      ⇒ captured    ⇒ removable;
      //   empty re-capture           ⇒ the tree holds no non-ignored
      //                                changes relative to its own HEAD —
      //                                nothing un-captured exists (a
      //                                committing worker's work lives on
      //                                its branch, which the T-044 guard
      //                                refuses);
      //   stored missing/unreadable  ⇒ refuse — changes no evidence holds;
      //   different bytes            ⇒ refuse — post-capture changes.
      // The re-capture diff target is the worktree's HEAD: byte-identical
      // to the T-044 base-diff on every tree the comparison governs (each
      // lease checks out at baseSha, so HEAD === baseSha until a commit
      // moves it — Gate 1.30 C4's inertness pin), while a base-relative
      // diff on a non-lease worktree (an int-* replay detached at a
      // drifted HEAD) would measure the drift, not the tree. Line endings:
      // the comparison is byte-stable on CRLF-shaped trees (Known issue
      // #5's class) because both passes run the identical capture form
      // under the identical git config — pinned empirically by Gate 1.34
      // P5; no tolerant comparison is needed, and none is applied.
      let refusal: string | null = null
      try {
        git(t.path, ['add', '-A', '--intent-to-add', '.'])
        const recapture = git(t.path, ['diff', 'HEAD', '--binary'])
        if (recapture !== '') {
          const stored = readStoredDiff(t.path)
          if (stored === null) {
            refusal =
              `refused (worktree holds un-captured changes — stored diff.patch missing or unreadable;` +
              ` re-run with --force to discard): ${t.path}`
          } else if (stored !== recapture) {
            refusal =
              `refused (worktree differs from its captured evidence — post-capture changes;` +
              ` re-run with --force to discard): ${t.path}`
          }
        }
      } catch (e) {
        console.error(`failed (evidence-parity check on ${t.path}): ${errorMessage(e)}`)
        res.failed++
        continue
      }
      if (refusal !== null && !force) {
        console.error(refusal)
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
