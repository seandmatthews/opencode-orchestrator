// Diagnostic: does a Node-spawned opencode resolve its project from the
// inherited PWD env var instead of its real cwd?
// Usage: node scripts/diag-pwd.mjs <worktreePath> ["PWD override or empty"]
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = process.argv[2]
const pwdOverride = process.argv[3] // literal "none" to delete PWD
const bin = join(dirname(dirname(fileURLToPath(import.meta.url))), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')

const env = { ...process.env }
if (pwdOverride === 'none') delete env.PWD
else if (pwdOverride) env.PWD = pwdOverride

const r = spawnSync(bin, [
  'run', '-m', 'zai-coding-plan/glm-5.3-flash',
  'Reply with ONLY the absolute path of the project directory you detected.',
], { cwd: target, env, encoding: 'utf8' })

console.log('cwd arg:        ', target)
console.log('PWD in child env:', env.PWD ?? '(deleted)')
if (r.error) console.log('spawn error:', r.error.message)
if (r.stderr) console.log('stderr tail:', r.stderr.trim().split('\n').slice(-3).join(' | '))
console.log('opencode says:  ', r.stdout ? r.stdout.trim().split('\n').filter(Boolean).pop() : '(no stdout)')
