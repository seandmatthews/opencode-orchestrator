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
function makeCleanRun(runId, { withReport, ids = ['c01', 'c02'], dirtyIds = [], repo = cleanRepo }) {
  const runDir = join(cleanRuns, runId)
  mkdirSync(join(runDir, 'wt'), { recursive: true })
  const rgit = (...args) => run('git', ['-C', repo, ...args])
  const candidates = []
  for (const id of ids) {
    const wt = join(runDir, 'wt', id)
    rgit('worktree', 'add', wt, '-b', `swarm/wt-${id}`, 'HEAD')
    if (dirtyIds.includes(id)) writeFileSync(join(wt, 'file.txt'), 'uncommitted change\n')
    candidates.push({ id, workspacePath: withReport ? wt : null })
  }
  if (withReport) writeFileSync(join(runDir, 'report.json'), JSON.stringify({ repo, candidates }, null, 2))
  return runDir
}

const runClean = (args) => {
  let code = 0
  let out = ''
  try {
    run(process.execPath, [tsxCli, join(root, 'src', 'clean.ts'), ...args])
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  return { code, out }
}
const expectClean = (expectedCode, label, args) => {
  const { code, out } = runClean(args)
  if (code !== expectedCode) console.error(`--- clean output (${label}) ---\n${out}`)
  return code
}
const lockFilesIn = (dir) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.lock'))
  } catch {
    return []
  }
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
ok(lockFilesIn(cleanRuns).length === 0, 'no residual lock files after the clean scenarios (every clean released its lock)')

// ---------- Gate 1.5: cross-run checkout lock (T-004) ----------
section('Gate 1.5 — checkout lock (fast tier)')
const locksDir = join(cleanRuns, 'locks')
const expectLockCli = (expectedCode, label, args) => {
  let code = 0
  let out = ''
  try {
    run(process.execPath, [tsxCli, join(root, 'src', 'lock.ts'), ...args])
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  if (code !== expectedCode) console.error(`--- lock cli output (${label}) ---\n${out}`)
  return { code, out }
}
const expectSkeleton = (expectedCode, label, args) => {
  let code = 0
  let out = ''
  try {
    run(process.execPath, [tsxCli, join(root, 'src', 'cli.ts'), ...args], { timeout: 120_000 })
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  if (code !== expectedCode) console.error(`--- skeleton output (${label}, exit ${code}) ---\n${out}`)
  return { code, out }
}

// AC#1 — a held lock makes clean refuse and remove nothing.
makeCleanRun('20991010120200', { withReport: true, ids: ['cL1', 'cL2'] })
expectLockCli(0, 'acquire', ['acquire', cleanRepo, '--run-root', cleanRuns])
ok(lockFilesIn(locksDir).length === 1, 'lock file lives under <run-root>\\locks\\')
ok(!readdirSync(cleanRepo).some((f) => f.endsWith('.lock')), 'no lock file ever inside the target repo')
const blockedClean = runClean(['--run', '20991010120200', '--run-root', cleanRuns])
ok(blockedClean.code === 1, `clean under a held lock refuses with exit 1 (got ${blockedClean.code})`)
ok(blockedClean.out.includes('checkout lock held') && /pid \d+/.test(blockedClean.out) && /held for /.test(blockedClean.out), 'refusal names the holder pid and age')
ok(blockedClean.out.includes('.lock'), 'refusal names the lock file path')
ok(worktreeCount() === 3, 'locked clean removed nothing (main + 2 worktrees remain)')
ok(swarmBranches() === 'swarm/wt-cL1,swarm/wt-cL2', 'locked clean removed no branches')
ok(existsSync(join(cleanRuns, '20991010120200', 'report.json')), 'evidence intact under a held lock')
expectLockCli(0, 'release', ['release', cleanRepo, '--run-root', cleanRuns])
ok(lockFilesIn(locksDir).length === 0, 'lock CLI release leaves no lock file behind')

// AC#2 — a held lock makes the run refuse BEFORE any worktree or artifacts dir.
const runCheckRoot = join(cleanRoot, 'runs-runcheck')
mkdirSync(runCheckRoot, { recursive: true })
expectLockCli(0, 'acquire (run side)', ['acquire', cleanRepo, '--run-root', runCheckRoot])
const refusedRun = expectSkeleton(1, 'locked run', ['--repo', cleanRepo.replace(/\//g, '\\'), '--goal', 'lock refusal check', '--run-root', runCheckRoot.replace(/\//g, '\\')])
ok(refusedRun.code === 1, `run under a held lock refuses with exit 1 (got ${refusedRun.code})`)
ok(refusedRun.out.includes('checkout lock held'), 'run refusal names the checkout lock')
ok(readdirSync(runCheckRoot).filter((d) => /^\d{14}$/.test(d)).length === 0, 'no artifacts dir created under a held lock')
ok(worktreeCount() === 3, 'no worktree created under a held lock')
expectLockCli(0, 'release (run side)', ['release', cleanRepo, '--run-root', runCheckRoot])

// AC#4 — release-on-error: a failure after acquisition leaves no lock file.
const badBase = expectSkeleton(1, 'bad base', ['--repo', cleanRepo.replace(/\//g, '\\'), '--goal', 'release-on-error check', '--base', 'no-such-ref', '--run-root', runCheckRoot.replace(/\//g, '\\')])
ok(badBase.code === 1, `bad --base run exits non-zero (got ${badBase.code})`)
ok(lockFilesIn(join(runCheckRoot, 'locks')).length === 0, 'failed run released its lock')

// AC#5 — --all locks per repo: one locked repo refuses, another repo still cleans.
const cleanRepo2 = join(cleanRoot, 'repo2')
mkdirSync(cleanRepo2, { recursive: true })
const r2git = (...args) => run('git', ['-C', cleanRepo2, ...args])
r2git('init', '-b', 'main')
writeFileSync(join(cleanRepo2, 'file.txt'), 'baseline\n')
r2git(...identity, 'add', '-A')
r2git(...identity, 'commit', '-m', 'baseline')
makeCleanRun('20991010120201', { withReport: true, ids: ['cM1'] })
makeCleanRun('20991010120202', { withReport: true, ids: ['cM2'], repo: cleanRepo2 })
makeCleanRun('20991010120203', { withReport: true, ids: ['cM3'] })
const r2Branches = () => r2git('branch', '--list', 'swarm/*').split('\n').map((l) => l.replace(/^[*+]\s*/, '').trim()).filter(Boolean).join(',')
expectLockCli(0, 'acquire (--all)', ['acquire', cleanRepo, '--run-root', cleanRuns])
code = expectClean(1, '--all with one locked repo', ['--all', '--run-root', cleanRuns])
ok(code === 1, `clean --all with one locked repo exits 1 (got ${code})`)
ok(cgit('branch', '--list', 'swarm/wt-cM1').trim() !== '', 'locked repo: run dir refused, branch intact')
ok(cgit('worktree', 'list', '--porcelain').includes('wt-cM1'), 'locked repo: worktree untouched')
ok(r2Branches() === '', 'unlocked repo: run still cleaned under --all (swarm/wt-cM2 gone)')
ok(cgit('worktree', 'list', '--porcelain').includes('wt-cM3'), 'newest run still kept by --all (its worktree remains)')
ok(lockFilesIn(locksDir).length === 1, 'exactly the held lock remains (disposed runs released theirs)')
expectLockCli(0, 'release (--all)', ['release', cleanRepo, '--run-root', cleanRuns])

// AC#6 — stale-lock policy: refuse with pid+age+path, never auto-reap, --force-lock takes it.
makeCleanRun('20991010120204', { withReport: true, ids: ['cS1'] })
expectLockCli(0, 'acquire (stale)', ['acquire', cleanRepo, '--run-root', cleanRuns])
const staleLockPath = join(locksDir, lockFilesIn(locksDir)[0])
writeFileSync(staleLockPath, JSON.stringify({ pid: 4194303, startedAt: new Date(Date.now() - 7200_000).toISOString(), cmd: 'crashed-run' }, null, 2))
const stale = runClean(['--run', '20991010120204', '--run-root', cleanRuns])
ok(stale.code === 1, `stale lock refuses clean with exit 1 (got ${stale.code})`)
ok(stale.out.includes('4194303') && /held for \d+m/.test(stale.out), 'refusal names the stale holder pid and its age')
ok(stale.out.includes('.lock'), 'refusal names the lock file path')
ok(lockFilesIn(locksDir).length === 1, 'nothing auto-reaped the stale lock')
const forced = runClean(['--run', '20991010120204', '--run-root', cleanRuns, '--force-lock'])
ok(forced.code === 0, `--force-lock takes the stale lock and clean proceeds (got ${forced.code})`)
ok(lockFilesIn(locksDir).length === 0, 'lock released after the --force-lock clean')

// tidy: dispose everything the checks above left behind.
code = expectClean(0, 'lock-check sweep --all', ['--all', '--run-root', cleanRuns])
ok(code === 0, `--all sweep exits 0 (got ${code})`)
code = expectClean(0, 'lock-check sweep last', ['--run', '20991010120203', '--run-root', cleanRuns])
ok(code === 0 && worktreeCount() === 1 && swarmBranches() === '', 'clean-repo sandbox fully disposed after lock checks')
ok(r2Branches() === '' && r2git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length === 1, 'repo2 sandbox fully disposed after lock checks')
ok(lockFilesIn(cleanRuns).length === 0 && lockFilesIn(join(runCheckRoot, 'locks')).length === 0, 'no lock files anywhere after the lock checks')

// ---------- Gate 1.5: integration replay (T-005) ----------
section('Gate 1.5 — integration replay (fast tier)')
const intRoot = 'C:/swarm/verify-integrate'
const intRepo = join(intRoot, 'repo')
const intRuns = join(intRoot, 'runs')
rmSync(intRoot, { recursive: true, force: true })
mkdirSync(intRuns, { recursive: true })
const igit = (...args) => run('git', ['-C', intRepo, ...args])
const expectIntegrate = (expectedCode, label, args) => {
  let code = 0
  let out = ''
  try {
    run(process.execPath, [tsxCli, join(root, 'src', 'integrate.ts'), ...args], { timeout: 120_000 })
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  if (code !== expectedCode) console.error(`--- integrate output (${label}, exit ${code}) ---\n${out}`)
  return { code, out }
}

try {
  mkdirSync(intRepo, { recursive: true })
  igit('init', '-b', 'main')
  writeFileSync(join(intRepo, 'file.txt'), 'alpha\nbeta\ngamma\n')
  writeFileSync(join(intRepo, 'other.txt'), 'unrelated\n')
  igit(...identity, 'add', '-A')
  igit(...identity, 'commit', '-m', 'baseline')
} catch (e) {
  fail(`integrate sandbox setup failed: ${e.status ?? e.message}`)
  finish()
}
const INT_BASE = igit('rev-parse', 'HEAD').trim()
const REPORT_GATES = [
  { name: 'check-a', passed: true, exitCode: 0, durationMs: 10, outputTail: 'ok' },
  { name: 'check-b', passed: true, exitCode: 0, durationMs: 10, outputTail: 'ok' },
]
const CLI_GATES = ['--gate', 'check-a=node -e "process.exit(0)"', '--gate', 'check-b=node -e "process.exit(0)"']

// Capture a diff exactly like src/workspace/worktree.ts: add -A --intent-to-add, diff HEAD.
function captureDiff(modifier) {
  const maker = join(intRoot, 'wt-maker')
  igit('worktree', 'add', maker, '--detach', 'HEAD')
  try {
    modifier(maker)
    run('git', ['-C', maker, 'add', '-A', '--intent-to-add', '.'])
    return run('git', ['-C', maker, 'diff', 'HEAD'])
  } finally {
    igit('worktree', 'remove', '--force', maker)
  }
}

function makeIntRun(runId, { diff, id = 'c01', gates = REPORT_GATES, passedAllGates = true, diffPath = null, diffBytes = null, writeDiff = true }) {
  const runDir = join(intRuns, runId)
  mkdirSync(join(runDir, id), { recursive: true })
  const dp = diffPath ?? join(runDir, id, 'diff.patch')
  if (writeDiff) writeFileSync(dp, diff)
  writeFileSync(join(runDir, 'report.json'), JSON.stringify({
    runId,
    repo: intRepo,
    baseSha: INT_BASE,
    goal: 'integrate fixture goal',
    model: 'zai-coding-plan/glm-5.3-flash',
    startedAt: '2026-10-11T00:00:00.000Z',
    finishedAt: '2026-10-11T00:01:00.000Z',
    candidates: [{
      id, workerId: 'opencode', model: 'zai-coding-plan/glm-5.3-flash', brief: 'b',
      workspacePath: null, workerOk: true, workerTimedOut: false, workerDurationMs: 1000,
      diffPath: dp, diffBytes: diffBytes ?? Buffer.byteLength(diff),
      gates, passedAllGates,
    }],
  }, null, 2))
  return runDir
}

// AC#1 — clean replay onto drifted HEAD: exit 0, every gate PASS at post-drift HEAD,
// change present in the replayed worktree, canonical checkout untouched.
const diffA = captureDiff((maker) => {
  writeFileSync(join(maker, 'file.txt'), 'alpha\nbeta\ngamma\ndelta\n')
  writeFileSync(join(maker, 'extra.txt'), 'new file\n')
})
makeIntRun('20991011030000', { diff: diffA })
writeFileSync(join(intRepo, 'other.txt'), 'unrelated\nadvanced\n')
igit(...identity, 'add', '-A')
igit(...identity, 'commit', '-m', 'unrelated drift')
const driftHead = igit('rev-parse', 'HEAD').trim()
ok(driftHead !== INT_BASE, 'sandbox: target main advanced past the run base')
const intA = expectIntegrate(0, 'clean replay', ['--run', '20991011030000', '--candidate', 'c01', ...CLI_GATES, '--run-root', intRuns])
ok(intA.code === 0, `integrate onto drifted HEAD exits 0 (got ${intA.code})`)
const artifactA = JSON.parse(readFileSync(join(intRuns, '20991011030000', 'integrate', 'c01.json'), 'utf8'))
ok(artifactA.applied === true && artifactA.treeChanged === true && artifactA.passed === true, 'artifact records applied + treeChanged + passed')
ok(artifactA.gates.length === 2 && artifactA.gates.every((g) => g.passed), 'artifact records every gate PASS')
ok(artifactA.targetHead === driftHead, `artifact targetHead is the post-drift HEAD (${driftHead.slice(0, 12)})`)
ok(artifactA.runBaseSha === INT_BASE, 'artifact runBaseSha is the run base')
ok(artifactA.worktreePath.replaceAll('\\', '/').endsWith('20991011030000/wt/int-c01'), 'artifact names the integration worktree')
ok(readFileSync(join(intRuns, '20991011030000', 'wt', 'int-c01', 'file.txt'), 'utf8').includes('delta')
  && existsSync(join(intRuns, '20991011030000', 'wt', 'int-c01', 'extra.txt')), 'replayed worktree contains the change')

// AC#5 — prepares-only: no new commits, no new branches, unchanged refs, detached worktree.
ok(igit('status', '--porcelain').trim() === '', 'canonical checkout untouched (status empty)')
ok(igit('rev-parse', 'HEAD').trim() === driftHead, 'canonical HEAD unchanged')
ok(igit('branch', '--list').split('\n').map((l) => l.replace(/^[*+]\s*/, '').trim()).filter(Boolean).join(',') === 'main', 'no new branches on the target')
ok(igit('worktree', 'list', '--porcelain').includes('detached'), 'integration worktree shows as detached')

// AC#2 — conflict refusal: same-lines drift, atomic (no partial state).
const diffB = captureDiff((maker) => writeFileSync(join(maker, 'file.txt'), 'alpha\nBETA\ngamma\n'))
makeIntRun('20991011030001', { diff: diffB, id: 'c02' })
writeFileSync(join(intRepo, 'file.txt'), 'alpha\nchanged-by-drift\ngamma\n')
igit(...identity, 'add', '-A')
igit(...identity, 'commit', '-m', 'same-lines drift')
const intB = expectIntegrate(1, 'conflict', ['--run', '20991011030001', '--candidate', 'c02', ...CLI_GATES, '--run-root', intRuns])
ok(intB.code === 1, `conflicting replay refuses with exit 1 (got ${intB.code})`)
ok(/apply/i.test(intB.out), 'refusal names the apply failure')
ok(run('git', ['-C', join(intRuns, '20991011030001', 'wt', 'int-c02'), 'status', '--porcelain']).trim() === '', 'conflict leaves the integration worktree untouched (atomic)')
ok(!existsSync(join(intRuns, '20991011030001', 'integrate', 'c02.json')), 'a refusal produces no artifact')

// AC#3 — evidence and policy refusals; a missing or empty diff is NEVER a pass.
const intUnknown = expectIntegrate(1, 'unknown candidate', ['--run', '20991011030000', '--candidate', 'c99', ...CLI_GATES, '--run-root', intRuns])
ok(intUnknown.code === 1 && /no such candidate/.test(intUnknown.out), 'unknown candidate id refuses')
const diffC = captureDiff((maker) => writeFileSync(join(maker, 'file.txt'), 'alpha\nbeta\ngamma\ndelta-2\n'))
makeIntRun('20991011030002', { diff: diffC, id: 'c03', passedAllGates: false })
const intEliminated = expectIntegrate(1, 'non-survivor', ['--run', '20991011030002', '--candidate', 'c03', ...CLI_GATES, '--run-root', intRuns])
ok(intEliminated.code === 1 && /survivor/i.test(intEliminated.out), 'non-survivor candidate refuses')
ok(!existsSync(join(intRuns, '20991011030002', 'integrate')), 'non-survivor produced no artifact')
makeIntRun('20991011030003', { diff: diffC, id: 'c04', diffPath: join(intRuns, '20991011030003', 'c04', 'absent.patch'), writeDiff: false })
const intMissing = expectIntegrate(1, 'missing diff', ['--run', '20991011030003', '--candidate', 'c04', ...CLI_GATES, '--run-root', intRuns])
ok(intMissing.code === 1 && /missing on disk/.test(intMissing.out), 'missing diff file refuses')
makeIntRun('20991011030004', { diff: '', id: 'c05', diffBytes: 0 })
const intEmpty = expectIntegrate(1, 'empty diff', ['--run', '20991011030004', '--candidate', 'c05', ...CLI_GATES, '--run-root', intRuns])
ok(intEmpty.code === 1 && /zero-byte|NO-OP/i.test(intEmpty.out), 'zero-byte diff refuses — never a pass')
// no-op apply: hand-crafted hunk whose - and + lines are identical, so the patch
// applies cleanly and the tree is unchanged. Main's file.txt first re-gains the
// hunk context the drift in AC#2 replaced.
writeFileSync(join(intRepo, 'file.txt'), 'alpha\nbeta\ngamma\n')
igit(...identity, 'add', '-A')
igit(...identity, 'commit', '-m', 'restore hunk context')
const NOOP_PATCH = 'diff --git a/file.txt b/file.txt\nindex 0000000..0000000 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+beta\n gamma\n'
makeIntRun('20991011030005', { diff: NOOP_PATCH, id: 'c06' })
const intNoop = expectIntegrate(1, 'no-op apply', ['--run', '20991011030005', '--candidate', 'c06', ...CLI_GATES, '--run-root', intRuns])
ok(intNoop.code === 1 && /changed nothing|NO-OP/i.test(intNoop.out), 'no-op apply refuses')
if (existsSync(join(intRuns, '20991011030005', 'integrate', 'c06.json'))) {
  const noopArtifact = JSON.parse(readFileSync(join(intRuns, '20991011030005', 'integrate', 'c06.json'), 'utf8'))
  ok(noopArtifact.applied === true && noopArtifact.treeChanged === false && noopArtifact.passed === false, 'no-op artifact records applied but never passes')
} else {
  ok(false, 'no-op artifact records applied but never passes (c06.json missing)')
}

// AC#4 — gate-name contract: extra, missing, renamed names refuse before any worktree exists.
makeIntRun('20991011030006', { diff: diffC, id: 'c07' })
const intExtra = expectIntegrate(1, 'extra gate', ['--run', '20991011030006', '--candidate', 'c07', ...CLI_GATES, '--gate', 'check-c=node -e "process.exit(0)"', '--run-root', intRuns])
ok(intExtra.code === 1 && /not in the run's recorded gate set/.test(intExtra.out), 'extra gate name refuses')
const intMissingName = expectIntegrate(1, 'missing gate', ['--run', '20991011030006', '--candidate', 'c07', '--gate', 'check-a=node -e "process.exit(0)"', '--run-root', intRuns])
ok(intMissingName.code === 1 && /missing: check-b/.test(intMissingName.out), 'missing gate name refuses')
const intRenamed = expectIntegrate(1, 'renamed gate', ['--run', '20991011030006', '--candidate', 'c07', '--gate', 'check-x=node -e "process.exit(0)"', '--gate', 'check-b=node -e "process.exit(0)"', '--run-root', intRuns])
ok(intRenamed.code === 1 && /missing: check-a/.test(intRenamed.out) && /check-x/.test(intRenamed.out), 'renamed gate name refuses')
ok(!existsSync(join(intRuns, '20991011030006', 'wt')), 'gate-contract refusals happen before any worktree exists')

// AC#6 — disposal, both faces: plain clean refuses the dirty integration worktree,
// --force disposes it via wt/-discovery, evidence survives.
const refusedClean = runClean(['--run', '20991011030000', '--run-root', intRuns])
ok(refusedClean.code === 1, `plain clean refuses the dirty integration worktree (got ${refusedClean.code})`)
ok(/refused/.test(refusedClean.out) && existsSync(join(intRuns, '20991011030000', 'wt', 'int-c01')), 'refused clean left the integration worktree in place')
const forcedClean = runClean(['--run', '20991011030000', '--run-root', intRuns, '--force'])
ok(forcedClean.code === 0, `clean --force disposes the integration worktree (got ${forcedClean.code})`)
ok(!existsSync(join(intRuns, '20991011030000', 'wt', 'int-c01')), 'integration worktree removed by clean --force')
ok(existsSync(join(intRuns, '20991011030000', 'integrate', 'c01.json'))
  && existsSync(join(intRuns, '20991011030000', 'c01', 'diff.patch'))
  && existsSync(join(intRuns, '20991011030000', 'report.json')), 'evidence (verdict, diff.patch, report.json) survives cleanup')

// tidy: dispose the remaining replay worktrees.
code = expectClean(0, 'integrate sweep --all', ['--all', '--run-root', intRuns])
ok(code === 0, `--all sweep over the integrate sandbox exits 0 (got ${code})`)
code = expectClean(0, 'integrate sweep last', ['--run', '20991011030006', '--run-root', intRuns])
ok(code === 0, `last integrate run disposes (got ${code})`)
ok(igit('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length === 1, 'only main remains in the integrate sandbox')
ok(lockFilesIn(intRuns).length === 0, 'no residual lock files after the integrate checks (released on every path)')

// ---------- Gate 1.6: store ingest (T-003) ----------
section('Gate 1.6 — store ingest (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-store.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'store ingest self-check exit 0')
} catch (e) {
  fail(`store ingest self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.7: dag dump CLI (T-006) ----------
section('Gate 1.7 — dag dump (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-dag.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'dag dump self-check exit 0')
} catch (e) {
  fail(`dag dump self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.8: attempts + bounded retry (T-007) ----------
section('Gate 1.8 — attempts + bounded retry (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-retry.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'retry self-check exit 0')
} catch (e) {
  fail(`retry self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.9: approval gates (T-008) ----------
section('Gate 1.9 — approval gates (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-approvals.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'approvals self-check exit 0')
} catch (e) {
  fail(`approvals self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.10: deterministic scheduler (T-009) ----------
section('Gate 1.10 — deterministic scheduler (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-scheduler.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'scheduler self-check exit 0')
} catch (e) {
  fail(`scheduler self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.11: startup reconciliation (T-010) ----------
section('Gate 1.11 — startup reconciliation (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-recovery.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'recovery self-check exit 0')
} catch (e) {
  fail(`recovery self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.12: process-tree termination hardening (T-011) ----------
section('Gate 1.12 — process-tree termination hardening (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-kill-tree.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'kill-tree self-check exit 0')
} catch (e) {
  fail(`kill-tree self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.13: context system core (T-012) ----------
section('Gate 1.13 — context system core (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-context.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'context self-check exit 0')
} catch (e) {
  fail(`context self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.14: shard distillation core + packet source lineage (T-013, T-014) ----------
section('Gate 1.14 — shard distillation core + packet source lineage (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-distillation.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'distillation + lineage self-check exit 0')
} catch (e) {
  fail(`distillation + lineage self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.15: probe layer first slice (T-015) ----------
section('Gate 1.15 — probe layer first slice (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-probe.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'probe self-check exit 0')
} catch (e) {
  fail(`probe self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.16: artifact store persistence + tamper evidence (T-016) ----------
section('Gate 1.16 — artifact store persistence + tamper evidence (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-artifacts.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'artifact store self-check exit 0')
} catch (e) {
  fail(`artifact store self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.17: MachineWorker adapter (T-017) ----------
section('Gate 1.17 — MachineWorker adapter (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-machine-worker.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'machine-worker self-check exit 0')
} catch (e) {
  fail(`machine-worker self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.18: worktree lease GC (T-020) ----------
section('Gate 1.18 — worktree lease GC (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-gc.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'gc self-check exit 0')
} catch (e) {
  fail(`gc self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.19: §15.4 explicit long-path budget (T-021) ----------
section('Gate 1.19 — §15.4 explicit long-path budget (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-long-paths.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'long-path budget self-check exit 0')
} catch (e) {
  fail(`long-path budget self-check failed: ${e.status ?? e.message}`)
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

// Run dirs are 14-digit timestamps; `locks/` (T-004) also lives under the run
// root and is not a run dir.
const runDirs = readdirSync(verifyRoot).filter((d) => /^\d{14}$/.test(d))
if (runDirs.length !== 1) {
  fail(`expected exactly one run dir under ${verifyRoot}, got: ${readdirSync(verifyRoot).join(', ')}`)
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
