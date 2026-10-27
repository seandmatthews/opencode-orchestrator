import { composeTreeSection, MAX_DIGEST_CHARS, MAX_DIGEST_PATHS } from './planner-digest.js'
import type { PlannerDigest, TreeCut } from './planner-digest.js'

/**
 * The worker orientation block (T-060, VERIFICATION.md Known issue #6 — the
 * four path/repo-confusion derailment classes; the adversarial review
 * 2026-10-23's A2 disposition): an engine-composed block PREPENDED to every
 * worker dispatch, carrying the two facts every derailed worker got wrong —
 * where exactly am I, and what files exist. The recorded classes this
 * attacks from the prompt side:
 *
 * - 2026-10-22: both workers probed the CANONICAL fixture instead of their
 *   lease → the block names the lease path verbatim and states that
 *   everything outside it (the canonical checkout included) is out of scope.
 * - 2026-10-23: the premise-lie class (the round-2 brief asserted a file
 *   only a survivor diff creates) → the block lists the tracked files that
 *   ACTUALLY exist at the base the lease is pinned to (the T-050 guard
 *   annotates the lie; this states the ground truth).
 * - 2026-10-24 (a): the worker mis-transcribed its OWN lease path (the
 *   candidate id's hyphen read as a path separator) → the block says
 *   copy-the-path-never-retype-it, and pins the baseSha.
 * - 2026-10-24 (b): explore-then-give-up → the tree answers "what files
 *   exist" before any tool call is spent on it.
 *
 * THE T-050 ANNOTATION SEAM'S DISCIPLINE (engine mechanics, never model
 * judgment): the block is pure string assembly over the worktree lease +
 * the run's baseSha + T-059's digest producer output — no model composes
 * it, no verdict expression reads it, and the planner-authored brief bytes
 * in report.json ride BYTE-UNCHANGED (only this engine-composed wrapper
 * grows; `CandidateReport.brief` is untouched and the premise guard is
 * inert for briefs whose paths all exist at base). The full dispatched
 * prompt (orientation + brief) is recorded per attempt as
 * `dispatched-prompt.txt` in the attempt's evidence dir, and the exact
 * text's sha256 IS that attempt's `promptVersion` (the T-029 producer
 * records the composition change — one composition, two consumers).
 *
 * THE SAME BYTES, NO SECOND COMPOSITION PATH: the tree section rides
 * T-059's own `composeTreeSection` over the digest's post-cap `treePaths` —
 * this module spawns nothing and walks no repo; when the orientation cap
 * does not bind, the block embeds the digest's exact tree-section bytes.
 *
 * DETERMINISM + CAP HONESTY: composition is pure over its inputs (no wall
 * clock, no locale, no map iteration order) — for a fixed lease + digest it
 * composes byte-identically on every invocation (pinned by Gate 1.46). The
 * block's total size is bounded by MAX_ORIENTATION_CHARS; when the tree
 * overflows it, paths drop from the END (git order preserved) until the
 * block fits, and the in-section TRUNCATED line names the binding cap and
 * the honest not-shown count (the digest's own cap stays the named cut when
 * the orientation cap does not bind below it). A block still over the cap
 * at zero paths left is left as-is (the fixed framing is far below the
 * constant — unreachable for any real digest). Every candidate in a run
 * gets the same block shape: the only per-candidate bytes are the lease
 * path on its own line (no differential treatment the report cannot
 * explain). Pinned by Gate 1.46.
 */

/** The orientation block's total char bound (JS string length of the
 *  composed text) — the ticket's named constant for the capped block size
 *  (the MAX_DIGEST_CHARS pattern; no CLI knob). Below the digest's own
 *  12,000-char budget on purpose: the worker prompt must stay token-cheap
 *  (the ticket's "a few hundred prompt tokens" for a demo-scale repo — the
 *  fixture's block composes at well under 1,000 chars), and when a large
 *  repo's tree exceeds it the block re-cuts deterministically and says so.
 *  Exported for the pinning gate (Gate 1.46). */
export const MAX_ORIENTATION_CHARS = 8_000

/** One orientation-block composition. `treeListed` is the path count the
 *  block's tree section carries; `bindingCap` names whose cut bound the
 *  listing (the digest's own 'path'/'char' cap when the orientation cap did
 *  not cut below it, 'orientation' when it did, null when nothing
 *  truncated) — the honest provenance the TRUNCATED line states. */
export interface WorkerOrientation {
  text: string
  /** Paths the block's tree section lists (≤ digest.treePaths.length). */
  treeListed: number
  bindingCap: 'path' | 'char' | 'orientation' | null
}

/** The block's fixed framing around the workspace line and the tree section.
 *  Pure; called repeatedly by the cap loop. The literals are pinned verbatim
 *  by Gate 1.46 (the hard-coded-literal discipline). */
function composeBlock(leasePath: string, baseSha: string, treeSection: string): string {
  return [
    '=== WORKSPACE ORIENTATION (composed deterministically by the engine — facts about your workspace, copied from the worktree lease and git at the base commit) ===',
    'YOUR EXACT WORKSPACE (the one and only directory you may read or change):',
    `  ${leasePath}`,
    'That exact path, byte-for-byte as printed above, is your workspace. Everything outside it is OUT OF SCOPE for this task — the canonical checkout of the target repository included, and any directory guessed from the task text is wrong unless it is inside the path above. Do not shorten, backslash-flip, or re-type this path from memory; copy it exactly.',
    `BASE COMMIT your workspace is pinned to: ${baseSha}`,
    treeSection,
    '=== END WORKSPACE ORIENTATION ===',
  ].join('\n')
}

/** Compose the worker orientation block (T-060). Pure over its inputs — the
 *  caller (src/runner.ts) composes the run's digest once and hands every
 *  attempt the same object plus its own lease path; a digest the caller
 *  could not compose is the caller's loud degradation (dispatch today's
 *  exact prompt bytes), never this module's concern. */
export function composeWorkerOrientation(input: { leasePath: string; baseSha: string; digest: PlannerDigest }): WorkerOrientation {
  // The digest's own cut descriptor (labels the TRUNCATED line has always
  // named) — the binding cut until/unless the orientation cap cuts deeper.
  let cut: TreeCut | null = input.digest.cap === 'path'
    ? { label: 'path', constant: MAX_DIGEST_PATHS }
    : input.digest.cap === 'char'
      ? { label: 'char', constant: MAX_DIGEST_CHARS }
      : null
  let listed = [...input.digest.treePaths]
  let text = composeBlock(input.leasePath, input.baseSha, composeTreeSection(listed, input.digest.totalPaths, cut))
  // The orientation cap re-cuts below the digest's own cut until the block
  // fits (paths drop from the END — deterministic; the digest's tree order
  // is preserved). The binding cap flips to 'orientation' the moment it
  // cuts EVEN ONE path the digest had kept.
  while (text.length > MAX_ORIENTATION_CHARS && listed.length > 0) {
    listed = listed.slice(0, listed.length - 1)
    cut = { label: 'orientation', constant: MAX_ORIENTATION_CHARS }
    text = composeBlock(input.leasePath, input.baseSha, composeTreeSection(listed, input.digest.totalPaths, cut))
  }
  return {
    text,
    treeListed: listed.length,
    bindingCap: cut === null ? null : (cut.label as WorkerOrientation['bindingCap']),
  }
}
