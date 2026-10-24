import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { commandTokens } from './gate/overlap.js'

/**
 * The brief-premise guard (T-050) — the mechanical, symptom-side half of the
 * Known issue #6 (2026-10-23, run 20261023204747) fix; the composer framing
 * lines (src/rounds.ts, ROUND_PREMISE_LINES) are the cause-side half. That
 * run's round-2 planner, reading composed round-1 survivor evidence, wrote a
 * brief asserting `vec3.js` exists — a file only a survivor's DIFF creates,
 * absent from the base round 2 re-leases at. The worker's read failed, it
 * exited 0 with zero edits, and the NO-OP ladder eliminated a candidate
 * whose brief lied about the workspace (the ladder was right; the brief was
 * wrong). This module scans PLANNER-AUTHORED briefs (rounds 1 AND 2 — the
 * round-1 planner is repo-blind and can hallucinate paths just as easily)
 * for path-shaped tokens naming files ABSENT at the run's recorded baseSha,
 * and appends a fixed engine note for each — the survivor-created reason
 * when the path is in a round-1 survivor's changed paths (the T-045
 * `WorkspaceProvider.changedPaths` seam's output, threaded by the runner),
 * the distinct base-commit-absent note otherwise.
 *
 * Scope carves, deliberate (the ticket): `--jobs` briefs are operator-owned
 * and are NEVER touched; planner-fallback raw-goal briefs and --no-planner
 * briefs are operator text too and get the same carve. The ANNOTATED brief
 * is the DISPATCHED brief — hashed into that attempt's `promptVersion` (one
 * composition, two consumers, the T-029/T-038 precedent) and wrapped into
 * its builder prompt — while the planner's UNANNOTATED brief is preserved
 * verbatim in the per-candidate evidence file `brief-premise.txt`
 * (before/after) and `CandidateReport.brief` keeps the planner's text (the
 * retry-brief precedent: composed text is attempt-scoped evidence, never a
 * replacement). Annotations never touch any verdict expression: they change
 * what a worker is TOLD, which is a brief, not a gate (decisions.md
 * 2026-10-10 — gates decide survival; this is mechanical string assembly
 * from recorded evidence, bounded, evidence-first, verdict-silent).
 *
 * A HEURISTIC, honestly named one (the T-045 posture): a token counts as
 * path-shaped only when its final dot-suffix is in the curated extension
 * list below — so `vec3.js`, `package.json`, `src/main.ts` flag, while
 * `Math.sqrt`, `console.log`, `and/or`, extensionless names (`Dockerfile`),
 * and directory-only paths (`src/utils`) are honest misses. False negatives
 * silence a note; false positives are impossible by construction (every
 * flagged token is probed against the base tree first). The caller wraps
 * annotation in the never-break-a-run posture: any failure logs loudly and
 * dispatches the brief unannotated.
 */

/** The curated file-extension suffixes a token must carry (its final
 *  dot-suffix, lowercased) to count as path-shaped. Deliberately a code/
 *  config/doc/data list: broad enough for real repo files, narrow enough
 *  that prose identifiers (`Math.sqrt`, `console.log`) and versions
 *  (`v1.2`) never flag. Honest misses (files whose suffix is absent from
 *  the list, or no suffix at all) are the documented cost — this guard is
 *  the cheapest suppressor of a known failure class, not a parser. */
export const PATH_TOKEN_EXTENSIONS: readonly string[] = [
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'md', 'markdown', 'txt',
  'html', 'htm', 'css', 'scss', 'less', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'conf', 'xml', 'csv', 'tsv', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat',
  'cmd', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp',
  'hpp', 'cs', 'php', 'swift', 'm', 'mm', 'exe', 'dll', 'bin', 'png', 'jpg',
  'jpeg', 'gif', 'svg', 'webp', 'ico', 'wasm', 'zip', 'gz', 'tar', '7z',
  'pdf', 'patch', 'diff', 'env', 'gitignore', 'editorconfig', 'lock',
]

/** The per-brief bound on premise notes (the MAX_RETRY_FINDINGS pattern):
 *  at most MAX_PREMISE_NOTES tokens annotate, in first-mention order. A
 *  brief drowning in absent paths gets the first few named, never a flood.
 *  Exported for the pinning gate (Gate 1.35). */
export const MAX_PREMISE_NOTES = 5

/** The fixed engine-note messages, appended verbatim after the path they
 *  name. The survivor-created reason teaches the Known issue #6 lesson
 *  (the file rides a round-1 diff, not the base); the absent-at-base note
 *  is the distinct, weaker claim for paths in no recorded evidence. */
export const PREMISE_MSG_SURVIVOR_CREATED = 'does NOT exist in your worktree; it was created by a round-1 candidate\'s diff — create it yourself if the change needs it'
export const PREMISE_MSG_ABSENT_AT_BASE = 'does not exist at the base commit — verify the path'
const PREMISE_NOTE_PREFIX = 'ENGINE PREMISE NOTE'
const PREMISE_SECTION_HEADER = '--- ENGINE PREMISE NOTES (appended by the engine from recorded evidence — a mechanical path check, not the brief author\'s words) ---'
const EVIDENCE_AUTHORED_HEADER = '--- BRIEF AS AUTHORED (planner output, verbatim — this text is what the candidate report records as the brief) ---'
const EVIDENCE_DISPATCHED_HEADER = '--- BRIEF AS DISPATCHED (premise notes appended by the brief-premise guard; the appended bytes are hashed into this attempt\'s promptVersion) ---'

/** One premise note: the repo-relative path and which fixed reason rides it. */
export interface PremiseNote {
  path: string
  kind: 'survivor-created' | 'absent-at-base'
}

/** One brief's annotation. Composed ONCE (the runner calls this before the
 *  briefs become jobs); the `annotated` text is the dispatched brief and the
 *  `evidenceText` is the `brief-premise.txt` payload — two consumers of one
 *  composition, so the dispatched bytes and the evidence bytes cannot
 *  drift. `original` is the planner's brief, verbatim, carried so the
 *  evidence file records true before/after without a second composition. */
export interface BriefPremiseAnnotation {
  original: string
  annotated: string
  notes: PremiseNote[]
  evidenceText: string
}

/** Windows-forward path identity for the survivor-membership test (the
 *  T-045 normForMatch posture): backslashes to forward slashes,
 *  case-insensitive, trailing slashes stripped. */
function normForMatch(p: string): string {
  return p.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '')
}

/** The path-shaped tokens of a brief, in first-mention order, deduplicated.
 *  Extraction rides the T-045 `commandTokens` precedent (whitespace and
 *  shell-separator split, one wrapping quote pair stripped); briefs are
 *  prose, not commands, so each token additionally sheds trailing
 *  punctuation (a sentence-final "vec3.js." must still flag) and one
 *  leading quote before the shape test. Absolute paths, home-relative
 *  paths, and `..`-escapes are skipped: a premise about the REPO tree is
 *  what this guard can check, and only that. */
export function briefPathTokens(brief: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of commandTokens(brief)) {
    const stripped = raw.replace(/^['"]/, '').replace(/[,.;:!?'"]+$/, '')
    if (stripped === '') continue
    if (isAbsolute(stripped) || stripped.startsWith('~') || stripped.split('/').includes('..')) continue
    const path = stripped.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (path === '') continue
    const dot = path.lastIndexOf('.')
    if (dot === -1) continue
    const suffix = path.slice(dot + 1).toLowerCase()
    if (!PATH_TOKEN_EXTENSIONS.includes(suffix)) continue
    if (!seen.has(path.toLowerCase())) {
      seen.add(path.toLowerCase())
      out.push(path)
    }
  }
  return out
}

/** `git cat-file -e <rev>:<path>` against the target repo — the recorded
 *  base, no lease needed (the ticket's probe). status 0 ⇒ the path exists
 *  at the base commit (a tree object counts: the directory premise holds). */
function existsAtBase(repo: string, baseSha: string, path: string): boolean {
  return spawnSync('git', ['-C', repo, 'cat-file', '-e', `${baseSha}:${path}`], { encoding: 'utf8', windowsHide: true }).status === 0
}

/** Annotate one planner-authored brief. Returns null when the brief is
 *  inert — every path-shaped token exists at base — so the caller dispatches
 *  today's exact bytes and writes no evidence file (the producer-only
 *  pattern). Throws only when the base commit itself cannot be probed (the
 *  repo is unreadable or the baseSha does not resolve): that is a
 *  loud-degradation signal for the caller's never-break-a-run catch, never
 *  a silent everything-is-absent flood — with an unresolvable base, every
 *  per-path probe answer would be meaningless. */
export function annotateBriefPremise(input: {
  brief: string
  repo: string
  baseSha: string
  /** Union of the round-1 survivors' changed paths (the T-045
   *  `WorkspaceProvider.changedPaths` seam's output, threaded by the
   *  runner). Empty in round 1 — no survivor evidence exists yet. */
  survivorChangedPaths: string[]
}): BriefPremiseAnnotation | null {
  if (spawnSync('git', ['-C', input.repo, 'cat-file', '-e', input.baseSha], { encoding: 'utf8', windowsHide: true }).status !== 0) {
    throw new Error(`brief-premise guard: base commit ${input.baseSha} does not resolve in ${input.repo} — dispatching unannotated`)
  }
  const survivor = new Set(input.survivorChangedPaths.map(normForMatch))
  const notes: PremiseNote[] = []
  const seenNotes = new Set<string>()
  for (const path of briefPathTokens(input.brief)) {
    if (existsAtBase(input.repo, input.baseSha, path)) continue
    const key = normForMatch(path)
    if (seenNotes.has(key)) continue
    seenNotes.add(key)
    notes.push({ path, kind: survivor.has(key) ? 'survivor-created' : 'absent-at-base' })
    if (notes.length >= MAX_PREMISE_NOTES) break
  }
  if (notes.length === 0) return null
  const noteLines = notes.map((n) =>
    `${PREMISE_NOTE_PREFIX}: "${n.path}" ${n.kind === 'survivor-created' ? PREMISE_MSG_SURVIVOR_CREATED : PREMISE_MSG_ABSENT_AT_BASE}`)
  const annotated = [input.brief, '', PREMISE_SECTION_HEADER, ...noteLines].join('\n')
  const evidenceText = [EVIDENCE_AUTHORED_HEADER, input.brief, '', EVIDENCE_DISPATCHED_HEADER, annotated].join('\n')
  return { original: input.brief, annotated, notes, evidenceText }
}
