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

module.exports = { add }
`)
write('build.js', `const { add } = require('./calc.js')
if (add(2, 3) !== 5) {
  console.error('build check failed')
  process.exit(1)
}
console.log('build ok')
`)
write('test.js', `const assert = require('node:assert')
const { add } = require('./calc.js')

assert.equal(add(1, 2), 3)
assert.equal(add(-1, 1), 0)
assert.equal(add(0, 0), 0)
console.log('tests ok')
`)
write('.gitignore', 'node_modules/\n')

const git = (...args) =>
  execFileSync('git', args, { cwd: target, stdio: 'inherit' })
const identity = ['-c', 'user.name=demo', '-c', 'user.email=demo@local']

git('init', '-b', 'main')
git(...identity, 'add', '-A')
git(...identity, 'commit', '-m', 'baseline: add() with build and test checks')

// Fail fast if the baseline does not actually pass its own gates.
execFileSync('node', ['build.js'], { cwd: target, stdio: 'inherit' })
execFileSync('node', ['test.js'], { cwd: target, stdio: 'inherit' })

console.log(`demo target ready: ${target}`)
console.log('suggested goal:')
console.log('  "Add a function fib(n) to calc.js (iterative, fib(0)=0, fib(1)=1) and export it. Extend test.js with assertions fib(0)===0, fib(1)===1 and fib(10)===55. Keep existing behavior unchanged."')
