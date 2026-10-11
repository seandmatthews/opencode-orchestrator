// Verification tiers — see VERIFICATION.md.
//   node scripts/verify.mjs fast   Gate 0 + Gate 1 (seconds)
//   node scripts/verify.mjs full   fast + Gate 2 (real e2e run, ~3-5 min, model tokens)
// All subprocesses are list-form and shell-free: npm.cmd shims and string-joined
// commands are exactly how Windows quoting bugs happen (AGENTS.md #4).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

// ---------- Gate 1.5: run artifact cleanup (T-002) ----------
section('Gate 1.5 — run artifact cleanup (fast tier)')
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const cleanRoot = 'C:/swarm/verify-clean'
const cleanRepo = join(cleanRoot, 'repo')
const cleanRuns = join(cleanRoot, 'runs')
rmSync(cleanRoot, { recursive: true, force: true })
mkdirSync(cleanRepo, { recursive: true })
const cgit = (...args) => run('git', ['-C', cleanRepo, ...args])
const identity = ['-c', 'user.name=verify', '-c', 'user.email=verify@local']
try {
  cgit('init', '-b', 'main')
  writeFileSync(join(cleanRepo, 'file.txt'), 'baseline\n')
  cgit(...identity, 'add', '-A')
  cgit(...identity, 'commit', '-m', 'baseline')
} catch (e) {
  fail(`cleanup sandbox setup failed: ${e.status ?? e.message}`)
  finish()
}

// A throwaway run dir with real worktrees + swarm/* branches, the way a run
// leaves them. Omitting report.json pins the wt/-discovery fallback path.
function makeCleanRun(runId, { withReport, ids = ['c01', 'c02'], dirtyIds = [] }) {
  const runDir = join(cleanRuns, runId)
  mkdirSync(join(runDir, 'wt'), { recursive: true })
  const candidates = []
  for (const id of ids) {
    const wt = join(runDir, 'wt', id)
    cgit('worktree', 'add', wt, '-b', `swarm/wt-${id}`, 'HEAD')
    if (dirtyIds.includes(id)) writeFileSync(join(wt, 'file.txt'), 'uncommitted change\n')
    candidates.push({ id, workspacePath: withReport ? wt : null })
  }
  if (withReport) writeFileSync(join(runDir, 'report.json'), JSON.stringify({ repo: cleanRepo, candidates }, null, 2))
  return runDir
}

const expectClean = (expectedCode, label, args) => {
  let code = 0
  let out = ''
  try {
    run(process.execPath, [tsxCli, join(root, 'src', 'clean.ts'), ...args])
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  if (code !== expectedCode) console.error(`--- clean output (${label}) ---\n${out}`)
  return code
}
const swarmBranches = () => cgit('branch', '--list', 'swarm/*').split('\n').map((l) => l.replace(/^[*+]\s*/, '').trim()).filter(Boolean).join(',')
const worktreeCount = () => cgit('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length

// AC#1 — report-driven clean: exit 0, worktrees + swarm/* branches gone, evidence kept.
makeCleanRun('20991010120000', { withReport: true })
let code = expectClean(0, 'recorded run', ['--run', '20991010120000', '--run-root', cleanRuns])
ok(code === 0, `clean --run on a recorded run exits 0 (got ${code})`)
ok(worktreeCount() === 1, 'recorded run: only main remains in worktree list')
ok(swarmBranches() === '', 'recorded run: no swarm/* branches left')
ok(!existsSync(join(cleanRuns, '20991010120000', 'wt', 'c01')), 'recorded run: worktree directories removed')
ok(existsSync(join(cleanRuns, '20991010120000', 'report.json')), 'recorded run: evidence (report.json) survives cleanup')

// AC#2 — dirty worktree refused without --force (clean sibling still disposed,
// per-item result, non-zero exit), disposed with --force. No report.json, so
// this also exercises wt/-discovery.
makeCleanRun('20991010120001', { withReport: false, dirtyIds: ['c01'] })
code = expectClean(1, 'dirty refusal', ['--run', '20991010120001', '--run-root', cleanRuns])
ok(code === 1, `clean --run refuses a dirty worktree with exit 1 (got ${code})`)
ok(cgit('branch', '--list', 'swarm/wt-c01').trim() !== '', 'refused run: branch of the dirty worktree survives')
ok(swarmBranches() === 'swarm/wt-c01', 'refused run: clean sibling worktree was still disposed (only the dirty branch remains)')
ok(cgit('worktree', 'list', '--porcelain').includes('wt-c01'), 'refused run: dirty worktree still registered')
code = expectClean(0, 'dirty force', ['--run', '20991010120001', '--run-root', cleanRuns, '--force'])
ok(code === 0, `clean --run --force disposes the dirty worktree (got ${code})`)
ok(worktreeCount() === 1 && swarmBranches() === '', 'after --force: only main remains, no swarm/* branches')

// --all — cleans every run except the newest.
makeCleanRun('20991010120002', { withReport: false, ids: ['c03', 'c04'] })
makeCleanRun('20991010120003', { withReport: false, ids: ['c05', 'c06'] })
code = expectClean(0, 'all', ['--all', '--run-root', cleanRuns])
ok(code === 0, `clean --all exits 0 (got ${code})`)
ok(cgit('branch', '--list', 'swarm/wt-c03').trim() === '', '--all disposed the older run (swarm/wt-c03 gone)')
ok(cgit('branch', '--list', 'swarm/wt-c05').trim() !== '', '--all kept the newest run (swarm/wt-c05 intact)')
code = expectClean(0, 'final sweep', ['--run', '20991010120003', '--run-root', cleanRuns, '--force'])
ok(code === 0 && worktreeCount() === 1 && swarmBranches() === '', 'sandbox fully disposed after the checks')

// ---------- Gate 1.6: store ingest (T-003) ----------
section('Gate 1.6 — store ingest (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-store.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'store ingest self-check exit 0')
} catch (e) {
  fail(`store ingest self-check failed: ${e.status ?? e.message}`)
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

// Post-run disposal goes through the clean command (T-002) instead of
// hand-rolled loops. --force is correct here: the run itself captured the
// evidence (diff.patch) before disposal, so the leftover uncommitted changes
// in the worktrees are disposable by definition.
console.log(`$ tsx src/clean.ts --run ${runDirs[0]} --run-root ${verifyRoot} --force`)
try {
  run(process.execPath, [tsxCli, join(root, 'src', 'clean.ts'), '--run', runDirs[0], '--run-root', verifyRoot.replace(/\//g, '\\'), '--force'], { cwd: root, stdio: 'inherit' })
  ok(true, `clean command disposed run ${runDirs[0]} (exit 0)`)
} catch (e) {
  fail(`clean command failed: ${e.status ?? e.message}`)
}
ok(git(fixture, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length === 1, 'only main remains in worktree list')
ok(git(fixture, 'branch', '--list', 'swarm/*').trim() === '', 'no swarm/* branches left')

finish()

function finish() {
  console.log(`\n=== verify (${tier}) complete: ${failures === 0 ? 'ALL GREEN' : `${failures} failure(s)`} ===`)
  process.exit(failures === 0 ? 0 : 1)
}
