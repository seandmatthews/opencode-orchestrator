import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

/**
 * The planner repo digest (T-059, the adversarial review 2026-10-23's R14 —
 * "a file-tree/manifest digest in the planner prompt is the minimal version").
 * The planner is repo-blind: plannerPrompt (src/runner.ts) carries goal +
 * count, and the planner's cwd is a scratch dir under the run artifacts dir —
 * no repo path, no file tree — so briefs cannot reference real modules or
 * conventions; every hedged-path annotation the T-050 premise guard fires on,
 * and the 2026-10-23 premise-lie class itself, trace to the specifier not
 * being able to see the code it is specifying against. This module composes a
 * DETERMINISTIC digest of the TARGET repo at the run's baseSha — the tracked
 * file tree (`git ls-tree -r --name-only <baseSha>`, forward-slash paths by
 * git's own emission) plus one manifest identity line per recognized manifest
 * file at the root (package.json: name/version — presence and identity, never
 * full contents) — which the runner rides through plannerPrompt's existing
 * contextBlock seam (the round-2 composed block's parameter).
 *
 * THE DIGEST IS BYTES, NEVER ACCESS (the ticket's carve): it names no repo
 * path (the planner's artifact-only scratch cwd and 'worktree-read'-class
 * postures are unchanged — pinned by Gate 1.20 S1's "the planner prompt names
 * no repo path"), grants no capability, and is parsed by nothing. The full
 * §7 ContextPlan/Packet wiring to the planner stays a successor (T-012's
 * context system has no producer feeding the planner — the context_plan_json
 * null precedent); this is R14's minimal producer.
 *
 * DETERMINISM CONTRACT: for a fixed repo + baseSha the digest composes
 * byte-identically on every invocation — ls-tree over a SHA is sorted by
 * path, the manifest read is `git show <baseSha>:<path>` (the COMMIT's bytes,
 * never the working tree's), and the composition is pure string assembly over
 * those two inputs with fixed framing (no wall clock, no locale, no map
 * iteration order). Pinned by Gate 1.45.
 *
 * CAP HONESTY (the context system's budgets-spent-are-budgets-stated rule):
 * two documented constants bound the digest — MAX_DIGEST_PATHS (tracked paths
 * listed) and MAX_DIGEST_CHARS (total composed chars, JS string length). When
 * a cap truncates, the digest SAYS SO and names the cut: the tree section's
 * header states listed-of-total, and one TRUNCATED line names the binding cap
 * (its constant) and the not-shown count. The char cap re-cuts below the path
 * cap's cut until the composed text fits (paths drop from the END, git order
 * preserved — deterministic).
 *
 * Never-break-a-run posture (the premise-guard pattern): composition throws
 * only when the repo/baseSha cannot be probed; the runner catches, logs
 * loudly, and plans without repo context — today's exact prompts, no evidence
 * file, no report field.
 */

/** At most this many tracked paths list in the digest (git ls-tree order).
 *  Exported for the pinning gate (Gate 1.45) — the MAX_RETRY_FINDINGS
 *  documented-constant pattern; no CLI knob (values chosen at
 *  implementation, the ticket's words). */
export const MAX_DIGEST_PATHS = 500

/** The digest's total char bound (JS string length of the composed text).
 *  Comfortably token-cheap for a planner prompt (≈ the adapters'
 *  RESPONSE_TAIL_CHARS budget); the char cap re-cuts the path listing when
 *  the path cap alone would overflow it. Same export pattern. */
export const MAX_DIGEST_CHARS = 12_000

/** The manifest files recognized at the repo root, in this fixed order (one
 *  identity line each). The ticket names package.json (name/version —
 *  presence and identity, not full contents); the list is the growth point
 *  for future manifests, each with its own identity rule in
 *  manifestIdentityLine below. */
export const RECOGNIZED_MANIFESTS: readonly string[] = ['package.json']

/** One digest composition. `cap` names which constant produced the final cut
 *  (null when nothing truncated); the sha256 is over the exact `text` bytes
 *  (utf-8) — one composition, two consumers (the prompt's contextBlock and
 *  the report's recorded hash cannot drift). */
export interface PlannerDigest {
  text: string
  sha256: string
  /** Every tracked path at baseSha (pre-cap). */
  totalPaths: number
  /** Paths actually listed (≤ totalPaths, ≤ MAX_DIGEST_PATHS). */
  listedPaths: number
  truncated: boolean
  cap: 'path' | 'char' | null
}

/** `git ls-tree -r --name-only <baseSha>` — the tracked file tree at the
 *  recorded base commit, list-form (AGENTS.md #4), forward-slash by git's own
 *  output encoding. Throws when the repo is unreadable or the baseSha does
 *  not resolve (the caller's loud-degradation signal — never a silent empty
 *  tree, which would be an everything-is-absent lie). */
function trackedPathsAtBase(repo: string, baseSha: string): string[] {
  const r = spawnSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', baseSha], { encoding: 'utf8', windowsHide: true })
  if (r.error) throw new Error(`planner digest: git ls-tree failed: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`planner digest: base commit ${baseSha} does not resolve in the target repo (git ls-tree exit ${r.status})`)
  return r.stdout.split('\n').filter((p) => p !== '')
}

/** One recognized manifest's identity line from the COMMIT's bytes
 *  (`git show <baseSha>:<path>` — never the working tree's; the digest is
 *  pinned to the base). Returns null when the manifest is absent at the root
 *  (a non-zero git show). Unparseable/field-missing manifests get an honest
 *  presence-only line — deterministic either way. */
function manifestIdentityLine(repo: string, baseSha: string, manifest: string): string | null {
  const r = spawnSync('git', ['-C', repo, 'show', `${baseSha}:${manifest}`], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) return null
  const identity = [`MANIFEST ${manifest}: present at root`]
  try {
    const parsed: unknown = JSON.parse(r.stdout)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const name = (parsed as Record<string, unknown>).name
      const version = (parsed as Record<string, unknown>).version
      if (typeof name === 'string' && typeof version === 'string') {
        return `MANIFEST ${manifest}: name ${JSON.stringify(name)}, version ${JSON.stringify(version)}`
      }
      const parts: string[] = []
      if (typeof name === 'string') parts.push(`name ${JSON.stringify(name)}`)
      if (typeof version === 'string') parts.push(`version ${JSON.stringify(version)}`)
      if (parts.length > 0) return `${identity[0]}, ${parts.join(', ')}`
      return `${identity[0]} (name/version not recorded)`
    }
    return `${identity[0]} (unparseable)`
  } catch {
    return `${identity[0]} (unparseable)`
  }
}

/** Compose the digest text over an already-cut path listing. Pure; called
 *  repeatedly by the char-cap loop below. */
function composeText(baseSha: string, manifestLines: readonly string[], listed: readonly string[], total: number, cap: 'path' | 'char' | null): string {
  const lines = [
    '=== TARGET REPO DIGEST (composed deterministically by the engine from git at the base commit — context about the repository, NOT access to it) ===',
    `BASE COMMIT: ${baseSha}`,
    ...manifestLines,
  ]
  if (cap === null) {
    lines.push(`TRACKED FILES AT BASE (${total} ${total === 1 ? 'path' : 'paths'}, forward-slash, git ls-tree order):`)
  } else {
    lines.push(`TRACKED FILES AT BASE (listing ${listed.length} of ${total} paths, forward-slash, git ls-tree order):`)
  }
  lines.push(...listed)
  if (cap === 'path') {
    lines.push(`TRUNCATED: ${total - listed.length} of ${total} tracked paths not shown — cut by the path cap (${MAX_DIGEST_PATHS}).`)
  } else if (cap === 'char') {
    lines.push(`TRUNCATED: ${total - listed.length} of ${total} tracked paths not shown — cut by the char cap (${MAX_DIGEST_CHARS}).`)
  }
  lines.push('=== END TARGET REPO DIGEST ===')
  return lines.join('\n')
}

/** Compose the deterministic planner repo digest (T-059). Throws on an
 *  unresolvable repo/baseSha (the caller's catch degrades loudly to today's
 *  digest-less prompts); otherwise returns the capped, honesty-stamped text
 *  plus its sha256. */
export function composePlannerDigest(input: { repo: string; baseSha: string }): PlannerDigest {
  const paths = trackedPathsAtBase(input.repo, input.baseSha)
  const manifestLines = RECOGNIZED_MANIFESTS
    .map((m) => manifestIdentityLine(input.repo, input.baseSha, m))
    .filter((line): line is string => line !== null)
  const total = paths.length
  let listed = paths.slice(0, MAX_DIGEST_PATHS)
  let cap: 'path' | 'char' | null = total > listed.length ? 'path' : null
  let text = composeText(input.baseSha, manifestLines, listed, total, cap)
  // The char cap re-cuts below the path cap's cut until the composed text
  // fits (paths drop from the END — deterministic). The binding cap flips to
  // 'char' the moment it cuts EVEN ONE path the path cap had kept; a text
  // still over the cap at zero paths left is left as-is (the fixed framing
  // is far below the constant — unreachable for any real baseSha).
  while (text.length > MAX_DIGEST_CHARS && listed.length > 0) {
    listed = listed.slice(0, listed.length - 1)
    cap = 'char'
    text = composeText(input.baseSha, manifestLines, listed, total, cap)
  }
  return {
    text,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    totalPaths: total,
    listedPaths: listed.length,
    truncated: cap !== null,
    cap,
  }
}
