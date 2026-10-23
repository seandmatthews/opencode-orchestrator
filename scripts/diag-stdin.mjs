// Diagnostic (T-042 step 0, the scripts/diag-pwd.mjs / diag-execute.mjs
// precedent): does `opencode run` read the prompt from STDIN when stdin is
// piped and NO message positional is given? The adapter's prompt currently
// rides argv, where Windows caps the whole command line at 32,767 UTF-16
// chars and Node's spawn throws ENAMETOOLONG synchronously above it (the
// recorded red bar in docs/tickets/T-042-prompt-transport-stdin.md). The
// preferred fix streams the prompt over stdin; this probe spends ONE real
// token-cheap call establishing whether the vendored harness (1.19.3) reads
// it there. Spawns the harness exactly the way the adapter would (list-form
// argv, PWD/OLDPWD pinned to the contracted cwd, ground rule 5; stdin piped
// and fed the prompt, then ended) and asks for a marker reply.
//   STDIN-PROBE-OK-4177 in stdout  -> STDIN-SUPPORTED (transport = stdin)
//   anything else                  -> STDIN-NOT-SUPPORTED; the ticket's
//                                     documented fallback applies (-f/--file
//                                     attachment, `opencode run --help`).
// Usage: node scripts/diag-stdin.mjs <worktreePath>
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = process.argv[2]
const bin = join(dirname(dirname(fileURLToPath(import.meta.url))), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')

const prompt = 'Reply with ONLY the exact string STDIN-PROBE-OK-4177 and nothing else.'

// spawnSync with `input` feeds the child's stdin exactly the way the stdin
// transport would: pipe, write the bytes, end the stream.
const r = spawnSync(bin, [
  'run', '-m', 'zai-coding-plan/glm-5.3-flash',
], {
  cwd: target,
  env: { ...process.env, PWD: target, OLDPWD: target },
  encoding: 'utf8',
  timeout: 180_000,
  windowsHide: true,
  input: prompt,
})

console.log('cwd arg:        ', target)
console.log('argv:           ', JSON.stringify(['run', '-m', 'zai-coding-plan/glm-5.3-flash']))
console.log('stdin fed:      ', `${prompt.length} chars, then end`)
if (r.error) console.log('spawn error:    ', r.error.message)
if (r.stderr) console.log('stderr tail:    ', r.stderr.trim().split('\n').slice(-3).join(' | '))
console.log('exit:           ', r.status === null ? `(signal ${r.signal ?? 'none'})` : r.status)
console.log('--- agent reply (stdout) ---')
console.log(r.stdout ? r.stdout.trim() : '(no stdout)')
console.log('--- probe verdict ---')
console.log(r.stdout?.includes('STDIN-PROBE-OK-4177')
  ? 'STDIN-SUPPORTED: opencode run with no message positional read the piped stdin as the prompt'
  : 'STDIN-NOT-SUPPORTED (or inconclusive — read the reply above); the -f/--file fallback applies')
