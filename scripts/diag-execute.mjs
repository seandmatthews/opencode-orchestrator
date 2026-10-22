// Diagnostic (T-039 step one, the scripts/diag-pwd.mjs precedent): can the
// OpenCode plan agent — the translation src/worker/opencode.ts gives the
// 'worktree-read' posture — EXECUTE commands? Spawns the vendored harness
// exactly the way the adapter does (list-form argv, PWD/OLDPWD pinned to the
// contracted cwd, ground rule 5) against a throwaway repo, asking it to run
// one deterministic command and report its stdout. A reply carrying the
// marker output means the posture is execute-capable and the T-039 verifier
// can ride 'worktree-read' unchanged; anything else means it cannot, and the
// ticket's choose-and-document path (a fourth ExecutionPolicy value) applies.
// The caller inspects the target tree afterwards: a dirty tree after this
// probe would mean the posture wrote, not merely executed.
// Usage: node scripts/diag-execute.mjs <worktreePath>
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = process.argv[2]
const bin = join(dirname(dirname(fileURLToPath(import.meta.url))), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')

const prompt = [
  'Run exactly this command in the current project directory:',
  '  node -e "console.log(\'EXEC-PROBE-OK-7391\', 6 * 7)"',
  'Then reply with ONLY the exact stdout the command printed, nothing else.',
  'If you cannot run commands, reply exactly: CANNOT-RUN-COMMANDS',
].join('\n')

const r = spawnSync(bin, [
  'run', '--agent', 'plan', '-m', 'zai-coding-plan/glm-5.3-flash', prompt,
], {
  cwd: target,
  env: { ...process.env, PWD: target, OLDPWD: target },
  encoding: 'utf8',
  timeout: 180_000,
  windowsHide: true,
})

console.log('cwd arg:        ', target)
if (r.error) console.log('spawn error:', r.error.message)
if (r.stderr) console.log('stderr tail:', r.stderr.trim().split('\n').slice(-3).join(' | '))
console.log('--- agent reply (stdout) ---')
console.log(r.stdout ?? '(no stdout)')
console.log('--- probe verdict ---')
console.log(r.stdout?.includes('EXEC-PROBE-OK-7391 42')
  ? 'EXECUTE-CAPABLE: the plan-agent posture ran the command and reported its output'
  : 'NOT EXECUTE-CAPABLE (or inconclusive — read the reply above)')
