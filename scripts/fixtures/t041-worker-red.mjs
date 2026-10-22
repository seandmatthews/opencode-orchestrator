// T-041 red-bar machine worker: applies the T-039-era finding's OWN change —
// the vendored copy of run 20261021225243 candidate c01's diff.patch, which
// adds the UNGUARDED clamp the verifier flagged ("Inverted bounds are
// silently accepted: clamp(5,10,0) returns 0 ... no lo<=hi guard") — inside
// the leased worktree. Per the MachineWorker contract (src/worker/machine.ts)
// the spawn cwd IS the worktree. List-form git apply (AGENTS.md #4).
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const patch = fileURLToPath(new URL('./t041-finding-diff.patch', import.meta.url))
execFileSync('git', ['apply', patch], { cwd: process.cwd(), stdio: 'inherit', windowsHide: true })
console.log('t041-worker-red: the finding diff applied (unguarded clamp restored)')
