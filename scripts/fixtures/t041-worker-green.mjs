// T-041 green-bar machine worker: reintroduces exactly the failure class the
// promoted check pins — a clamp with no lo<=hi guard, the body the T-039-era
// verifier flagged in run 20261021225243 — by stripping the promoted guard
// from calc.js in the leased worktree (cwd IS the worktree, the MachineWorker
// contract). Exits non-zero when the guard is absent, so this worker can
// never silently no-op (AGENTS.md #7). Line-ending aware: the leased
// worktree may carry CRLF (core.autocrlf), the promoted source is written
// LF — match on a normalized copy and restore the file's own EOL style, so
// the captured diff stays exactly the clamp region.
import { readFileSync, writeFileSync } from 'node:fs'

const GUARDED = `function clamp(v, lo, hi) {
  if (lo > hi) {
    throw new RangeError('clamp: inverted bounds (lo ' + lo + ' > hi ' + hi + ')')
  }
  return Math.min(Math.max(v, lo), hi)
}`
const UNGUARDED = 'function clamp(v, lo, hi) {\n  return Math.min(Math.max(v, lo), hi)\n}'

const source = readFileSync('calc.js', 'utf8')
const eol = source.includes('\r\n') ? '\r\n' : '\n'
const normalized = source.replace(/\r\n/g, '\n')
const stripped = normalized.replace(GUARDED, UNGUARDED)
if (stripped === normalized) {
  console.error("t041-worker-green: the promoted clamp guard was not found in calc.js — nothing changed, refusing (a NO-OP is never a pass)")
  process.exit(1)
}
writeFileSync('calc.js', stripped.replace(/\n/g, eol))
console.log("t041-worker-green: clamp guard stripped (the finding's unguarded body restored)")
