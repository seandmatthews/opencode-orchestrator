// Creates a throwaway target repo with a fast baseline: `node build.js`
// and `node test.js` both pass before any agent touches it.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const target = process.argv[2] ?? 'C:\\swarm\\demo-target'

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

const write = (name, content) => writeFileSync(join(target, name), content)

write('package.json', JSON.stringify({ name: 'demo-target', private: true }, null, 2))
write('calc.js', `function add(a, b) {
  return a + b
}

// T-041 ratchet promotion (run 20261021225243 c01, verifier concern:
// "Inverted bounds are silently accepted: clamp(5,10,0) returns 0 ... no
// lo<=hi guard"). A human turned that finding into this guard + the test.js
// assertions below — the permanent, mechanical check. Never auto-promoted,
// never in the run that produced the finding (AGENTS.md #11).
function clamp(v, lo, hi) {
  if (lo > hi) {
    throw new RangeError('clamp: inverted bounds (lo ' + lo + ' > hi ' + hi + ')')
  }
  return Math.min(Math.max(v, lo), hi)
}

module.exports = { add, clamp }
`)
write('build.js', `const { add } = require('./calc.js')
if (add(2, 3) !== 5) {
  console.error('build check failed')
  process.exit(1)
}
console.log('build ok')
`)
write('test.js', `const assert = require('node:assert')
const { add, clamp } = require('./calc.js')

assert.equal(add(1, 2), 3)
assert.equal(add(-1, 1), 0)
assert.equal(add(0, 0), 0)
assert.equal(clamp(5, 0, 10), 5)
assert.equal(clamp(-1, 0, 10), 0)
assert.equal(clamp(11, 0, 10), 10)
// T-041 ratchet promotion (run 20261021225243 c01, verifier concern):
// inverted bounds used to pass silently; the promoted check refuses them.
assert.throws(() => clamp(5, 10, 0), RangeError)
assert.throws(() => clamp(0, -5, -10), RangeError)
console.log('tests ok')
`)
write('.gitignore', 'node_modules/\n')

const git = (...args) =>
  execFileSync('git', args, { cwd: target, stdio: 'inherit' })
const identity = ['-c', 'user.name=demo', '-c', 'user.email=demo@local']

git('init', '-b', 'main')
git(...identity, 'add', '-A')
git(...identity, 'commit', '-m', 'baseline: add() + guarded clamp() (T-041 ratchet) with build and test checks')

// Fail fast if the baseline does not actually pass its own gates.
execFileSync('node', ['build.js'], { cwd: target, stdio: 'inherit' })
execFileSync('node', ['test.js'], { cwd: target, stdio: 'inherit' })

console.log(`demo target ready: ${target}`)
console.log('suggested goal:')
console.log('  "Add a function fib(n) to calc.js (iterative, fib(0)=0, fib(1)=1) and export it. Extend test.js with assertions fib(0)===0, fib(1)===1 and fib(10)===55. Keep existing behavior unchanged."')
