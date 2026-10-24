import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { GateCommandOverlap, GateResult } from '../types.js'

/**
 * Gate/diff overlap evidence (T-045, the 2026-10-23 adversarial review's
 * F4). Gates are shell commands evaluated in the candidate worktree
 * (src/gate/command.ts) — for the canonical demo that is `node build.js` /
 * `node test.js`, files the worker can edit. A worker that weakens the test
 * script plus adds a trivial change elsewhere produces a non-zero diff that
 * passes every gate; the tampering is visible in the captured diff, but
 * nothing machine-flags it, and `integrate` then re-runs the SAME recorded
 * gate command on a replay tree that CONTAINS the tampering. This module
 * converts the cheapest version of that from invisible to recorded: the
 * diff's changed paths intersected with the path-shaped tokens of each
 * gate's RECORDED command (`GateResult.command`, T-027).
 *
 * Evidence only, never a verdict (the `cleanupFailures` pattern): nothing
 * in the elimination ladder reads the result; the runner produces it beside
 * the ladder, the CLI prints it, `integrate` surfaces it at replay.
 *
 * A HEURISTIC, honestly named one (VERIFICATION.md Gate 1.32): transitive
 * loads are invisible (`node build.js` can `require` anything), and
 * redirect targets written as separate tokens can over-flag. The
 * non-goals — transitive-load analysis, pristine-copy gate execution —
 * are design decisions carved by the ticket, not this slice.
 */

/** Split a recorded gate command into candidate tokens: whitespace and the
 *  shell command separators (`&`, `;`, `|`, and the parens of subshells),
 *  then strip one wrapping quote pair. Redirect operators are deliberately
 *  NOT separators — a glued `>out.txt` token fails the resolution test
 *  below and drops out. */
export function commandTokens(command: string): string[] {
  return command
    .split(/[\s;&|()]+/)
    .map((tok) => tok.replace(/^(['"])(.*)\1$/, '$2'))
    .filter((tok) => tok !== '')
}

/** Windows-forward path identity for matching (the src/clean.ts normPath
 *  posture): backslashes to forward slashes, case-insensitive, trailing
 *  slashes stripped (`src/` and `src` are the same prefix). */
function normForMatch(p: string): string {
  return p.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '')
}

/**
 * The changed paths one gate's recorded command touches (T-045). A token is
 * PATH-SHAPED when it names an existing file or directory in the worktree
 * (resolved against `cwd`; an absolute token inside the worktree folds to
 * its repo-relative form) or exactly matches a changed path — the second
 * clause keeps a file the diff DELETED visible (it no longer resolves on
 * disk). A path-shaped token overlaps a changed path when they are equal or
 * the token is its directory prefix (`npx eslint src/` flags every change
 * under `src/`). `npm test`/`make`-style commands carry no path tokens and
 * yield no overlap by construction.
 */
export function overlapTouched(command: string, changedPaths: string[], cwd: string): string[] {
  const touched: string[] = []
  const changedNorm = new Set(changedPaths.map(normForMatch))
  for (const token of commandTokens(command)) {
    // An absolute token inside the worktree folds to repo-relative form so
    // it can match changed paths; an absolute path elsewhere can resolve
    // but never matches (only the worktree's own files can overlap).
    let rel = token
    if (isAbsolute(token)) {
      const r = relative(cwd, resolve(cwd, token))
      if (r !== '' && !r.startsWith('..') && !isAbsolute(r)) rel = r.replaceAll('\\', '/')
    }
    const tn = normForMatch(rel)
    if (!existsSync(resolve(cwd, token)) && !changedNorm.has(tn)) continue
    for (const changed of changedPaths) {
      const cn = normForMatch(changed)
      if (cn === tn || cn.startsWith(`${tn}/`)) {
        if (!touched.some((p) => normForMatch(p) === cn)) touched.push(changed)
      }
    }
  }
  return touched
}

/**
 * Overlap entries for one candidate's final gate set (T-045): one entry per
 * gate whose recorded command overlaps at least one changed path, in gate
 * order. Gates without a recorded command (pre-T-027 reports, non-shell
 * gates) carry no tokens and never overlap. Empty when nothing overlaps —
 * the caller records nothing (the producer-only optional-field pattern).
 */
export function computeGateCommandOverlap(
  gates: GateResult[],
  changedPaths: string[],
  cwd: string,
): GateCommandOverlap[] {
  const entries: GateCommandOverlap[] = []
  for (const g of gates) {
    if (g.command === undefined) continue
    const touched = overlapTouched(g.command, changedPaths, cwd)
    if (touched.length > 0) entries.push({ gate: g.name, touched })
  }
  return entries
}
