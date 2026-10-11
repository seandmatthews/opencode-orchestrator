// Verification tiers — see VERIFICATION.md.
//   node scripts/verify.mjs fast   Gate 0 + Gate 1 (seconds)
//   node scripts/verify.mjs full   fast + Gate 2 (real e2e run, ~3-5 min, model tokens)
// All subprocesses are list-form and shell-free: npm.cmd shims and string-joined
// commands are exactly how Windows quoting bugs happen (AGENTS.md #4).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = 'C:/swarm/demo-target'
const verifyRoot = 'C:/swarm/verify'
const tier = process.argv[2] ?? 'fast'

if (tier !== 'fast' && tier !== 'full') {
  console.error(`usage: node scripts/verify.mjs [fast|full] (got: ${tier})`)
  process.exit(2)
}

let failures = 0
const fail = (msg) => { failures++; console.error(`FAIL: ${msg}`) }
const ok = (cond, msg) => { if (cond) console.log(`ok: ${msg}`); else fail(msg) }
const section = (name) => console.log(`\n=== ${name} ===`)

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
}

function git(repo, ...args) {
  return run('git', ['-C', repo, ...args])
}

section(`Gate 0 — static (${tier} tier)`)
try {
  run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], { cwd: root, stdio: 'inherit' })
  ok(true, 'typecheck exit 0')
} catch (e) {
  fail(`typecheck failed: ${e.status ?? e.message}`)
  finish()
}

section('Gate 1 — fixture baseline')
try {
  run(process.execPath, [join(root, 'scripts', 'demo-target.mjs'), fixture.replace(/\//g, '\\')], { cwd: root, stdio: 'inherit' })
  ok(true, 'fixture regenerated and baseline gates printed build ok + tests ok')
} catch (e) {
  fail(`fixture generation failed: ${e.status ?? e.message}`)
  finish()
}
ok(git(fixture, 'status', '--porcelain').trim() === '', 'fixture working tree clean after generation')

section('Gate 0.5 — structured-output parser contract')
try {
  run(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'scripts', 'check-parse.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'parser self-check exit 0')
} catch (e) {
  fail(`parser self-check failed: ${e.status ?? e.message}`)
  finish()
}

if (tier === 'fast') finish()

// ---------- Gate 2: real end-to-end run ----------
section('Gate 2 — harness end-to-end')
rmSync(verifyRoot, { recursive: true, force: true })
const skeletonArgs = [
  join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  join(root, 'src', 'cli.ts'),
  '--repo', fixture.replace(/\//g, '\\'),
  '--goal', 'Make the demo-target calculator more capable for flight-sim style math.',
  '--gate', 'build=node build.js',
  '--gate', 'test=node test.js',
  '--candidates', '2',
  '--run-root', verifyRoot.replace(/\//g, '\\'),
]
console.log('$ tsx src/cli.ts', skeletonArgs.slice(3).join(' '))
try {
  run(process.execPath, skeletonArgs, { cwd: root, stdio: 'inherit', timeout: 8 * 60_000 })
} catch (e) {
  fail(`skeleton run failed: ${e.status ?? e.signal ?? e.message}`)
  finish()
}

const runDirs = readdirSync(verifyRoot)
if (runDirs.length !== 1) {
  fail(`expected exactly one run dir under ${verifyRoot}, got: ${runDirs.join(', ')}`)
  finish()
}
const runDir = join(verifyRoot, runDirs[0])
const report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'))

ok(report.planner?.ok === true && report.planner?.fallbackUsed === false, `planner produced briefs (attempts=${report.planner?.attempts})`)
ok(report.planner?.briefs?.length === report.candidates.length, 'one brief per candidate')
for (const c of report.candidates) {
  ok(c.workerOk === true && !c.workerTimedOut, `${c.id}: worker exited 0 in ${(c.workerDurationMs / 1000).toFixed(0)}s`)
  ok(c.diffBytes > 0, `${c.id}: diff non-empty (${c.diffBytes} bytes)`)
  ok(c.gates.length >= 2 && c.gates.every((g) => g.passed), `${c.id}: all gates pass (${c.gates.map((g) => g.name).join('+')})`)
  ok(!c.error, `${c.id}: no candidate error`)

  const reviewPath = join(runDir, c.id, 'review.json')
  if (c.passedAllGates) {
    ok(c.review?.ok === true, `${c.id}: review parsed (attempts=${c.review?.attempts})`)
    ok(existsSync(reviewPath), `${c.id}: review artifact on disk`)
    const severitiesOk = (c.review?.observations ?? []).every((o) => typeof o.finding === 'string' && ['info', 'concern', 'blocker-advisory'].includes(o.severity))
    ok(severitiesOk && (c.review?.observations.length ?? 0) > 0, `${c.id}: observations well-formed (${c.review?.observations.length})`)
  } else {
    ok(!existsSync(reviewPath) && c.review === undefined, `${c.id}: not reviewed (gates decide; review is advisory)`)
  }
}

// ---------- hygiene: canonical repo untouched, no contamination, disposal ----------
section('Hygiene — post-run')
ok(git(fixture, 'status', '--porcelain').trim() === '', 'fixture working tree clean (canonical repo untouched)')
for (const stray of ['calc.js', 'test.js']) {
  ok(!existsSync(join(root, stray)), `no stray ${stray} in orchestrator root (contamination check)`)
}

let disposalFailures = 0
for (const c of report.candidates) {
  const wt = c.workspacePath
  if (wt && existsSync(wt)) {
    try {
      git(fixture, 'worktree', 'remove', '--force', wt)
      console.log(`ok: removed worktree ${wt}`)
    } catch (e) {
      disposalFailures++
      fail(`could not remove worktree ${wt}: ${e.status ?? e.message}`)
    }
  }
  const branch = `swarm/wt-${c.id}`
  try {
    git(fixture, 'branch', '-D', branch)
    console.log(`ok: deleted branch ${branch}`)
  } catch (e) {
    disposalFailures++
    fail(`could not delete branch ${branch}: ${e.status ?? e.message}`)
  }
}
if (disposalFailures === 0) {
  ok(git(fixture, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length === 1, 'only main remains in worktree list')
  ok(git(fixture, 'branch', '--list', 'swarm/*').trim() === '', 'no swarm/* branches left')
}

finish()

function finish() {
  console.log(`\n=== verify (${tier}) complete: ${failures === 0 ? 'ALL GREEN' : `${failures} failure(s)`} ===`)
  process.exit(failures === 0 ? 0 : 1)
}
