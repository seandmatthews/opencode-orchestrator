// Verify-root retention helper (T-055) — the module scripts/verify.mjs's
// full tier drives to reset the live verify root WITHOUT destroying prior
// Gate 2 evidence, and that scripts/check-verify-retention.mjs (Gate 1.41)
// pins token-free with fixture run dirs.
//
// Pre-T-055 the reset was `rmSync(verifyRoot, { recursive: true, force:
// true })`: every full-tier invocation permanently destroyed every prior
// Gate 2 run dir under C:/swarm/verify. The recorded incident: run
// 20261024021432 — cited by name in VERIFICATION.md Known issue #6's
// 2026-10-24 observation — was wiped from disk before T-049 could read its
// worker.logs (T-049's Landed records the recovery from VERIFICATION.md's
// own text). The rule now:
//
//   1. ARCHIVE, don't wipe — every existing `^\d{14}$` run DIRECTORY under
//      the live root moves to <archiveRoot>/<runId>/ (a plain same-drive
//      rename; bytes never rewritten).
//   2. BOUND the growth — the archive keeps only the most recent
//      ARCHIVE_KEEP_RUNS archived runs; older ones are deleted. Evidence
//      with a grace period instead of none.
//   3. TOUCH ONLY RUN DIRS — anything non-timestamped is never moved or
//      deleted (locks/ — T-004's checkout-lock home under the run root —
//      survives where the old wipe destroyed it), and a timestamped entry
//      that is a FILE is a stray, not a run dir: it stays put too.
//
// Plain ESM on node:fs: scripts/verify.mjs runs under plain node, not tsx.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** A run dir is a 14-digit timestamp directory (YYYYMMDDHHMMSS — the only
 *  shape the engine's --run-root layout produces; lexical order is
 *  chronological order). */
const RUN_DIR_RE = /^\d{14}$/

/** Documented retention bound: the number of most-recent archived Gate 2
 *  run dirs the archive root keeps. Exported so the tier's docs and the
 *  Gate 1.41 check pin the same number the reset uses. */
export const ARCHIVE_KEEP_RUNS = 10

export function isRunDirName(name) {
  return RUN_DIR_RE.test(name)
}

/** Sorted `^\d{14}$` DIRECTORIES under root (oldest first). A timestamped
 *  FILE is a stray, never a run dir — the same rule the move below applies.
 *  A nonexistent root lists as empty. */
export function listRunDirs(root) {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((d) => RUN_DIR_RE.test(d) && statSync(join(root, d)).isDirectory())
    .sort()
}

/** Delete all but the most recent `keep` archived run dirs under
 *  archiveRoot. Non-timestamped entries in the archive root are never
 *  touched. Returns the sorted names deleted (oldest first); empty when
 *  the archive is within its bound or does not exist. */
export function pruneArchive(archiveRoot, keep = ARCHIVE_KEEP_RUNS) {
  if (!existsSync(archiveRoot)) return []
  const dirs = listRunDirs(archiveRoot)
  if (dirs.length <= keep) return []
  const doomed = dirs.slice(0, dirs.length - keep)
  for (const name of doomed) rmSync(join(archiveRoot, name), { recursive: true, force: true })
  return doomed
}

/** The T-055 reset: move every existing run dir under verifyRoot into
 *  archiveRoot (plain same-drive rename), then prune the archive to its
 *  bound. Nothing non-timestamped under either root is moved or deleted.
 *  A same-named archived dir can only predate the live copy (a previously
 *  failed/partial move); the live copy — the one this reset is preserving —
 *  replaces it. Fails LOUD (throws) rather than proceeding silently when a
 *  move fails: continuing would destroy exactly the evidence this helper
 *  exists to retain. Returns honest counts: { moved, deleted } (sorted
 *  names). */
export function archiveExistingRuns(verifyRoot, archiveRoot, keep = ARCHIVE_KEEP_RUNS) {
  const moved = []
  if (existsSync(verifyRoot)) {
    mkdirSync(archiveRoot, { recursive: true })
    for (const name of listRunDirs(verifyRoot)) {
      const dest = join(archiveRoot, name)
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
      renameSync(join(verifyRoot, name), dest)
      moved.push(name)
    }
  }
  const deleted = pruneArchive(archiveRoot, keep)
  return { moved, deleted }
}
