// Verification tiers — see VERIFICATION.md.
//   node scripts/verify.mjs fast   Gate 0 + Gate 1 (seconds)
//   node scripts/verify.mjs full   fast + Gate 2 (real e2e run, ~3-5 min, model tokens)
// All subprocesses are list-form and shell-free: npm.cmd shims and string-joined
// commands are exactly how Windows quoting bugs happen (AGENTS.md #4).
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// AC#2 — a changed worktree with no stored diff.patch evidence is refused
// without --force (clean sibling still disposed, per-item result, non-zero
// exit), disposed with --force. No report.json, so this also exercises
// wt/-discovery. (Since T-048 the refusal is the evidence-parity predicate's
// missing-evidence leg — before T-048 a plain porcelain read, which by
// construction also refused every CAPTURED worktree.)
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
// Every integrate face that runs WITHOUT its own store gets --db pointed at
// this deliberately-absent sandbox path: it exercises exactly the no-DB-file
// fallback branch (src/integrate.ts) while guaranteeing no fast-tier
// invocation ever reads or writes a real store. Before the T-028 review
// round 1 these faces passed no --db, so on a machine with an existing
// C:\swarm\refinery.db the default path was consulted — and every
// success-path replay recorded its fixture verdict INTO the live store
// (observed: 5 artifacts rows + 20 INTEGRATE_REPLAYED events for 2099-* run
// ids, pointing at verify-integrate paths the sandbox deletes). The default
// store path is only consulted outside the sandbox.
const absentDb = join(intRoot, 'store', 'absent.db')
const igit = (...args) => run('git', ['-C', intRepo, ...args])
const expectIntegrate = (expectedCode, label, args) => {
  // spawnSync (still list-form, AGENTS.md #4) so stdout AND stderr are
  // captured on success paths too — the T-028 faces pin log lines the
  // command prints on exit-0 runs (the verified-handle line, the loud
  // PERSISTENCE FAILED line, the --help usage text).
  // The absentDb injection (above) makes the sandbox isolation structural:
  // no face can omit --db and fall through to the engine default.
  const fullArgs = args.includes('--db') || args.includes('--help') ? args : [...args, '--db', absentDb]
  const r = spawnSync(process.execPath, [tsxCli, join(root, 'src', 'integrate.ts'), ...fullArgs], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  const code = r.status === null ? -1 : r.status
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}`
  if (code !== expectedCode) console.error(`--- integrate output (${label}, exit ${code}) ---\n${out}`)
  return { code, out }
}

// Deterministic binary bytes (NUL + non-UTF8 octets, so git records the file
// as binary) for the T-026 scenario: the sandbox baseline commits asset.bin,
// and a candidate edit to it produces a binary-hunk diff whose pre-image
// matches the run base.
const binaryAsset = (seed) => Buffer.concat([
  Buffer.from([0x00, 0xff, 0xfe, seed]),
  Buffer.from(Array.from({ length: 60 }, (_, i) => (i * seed + 7) & 0xff)),
])
const ASSET_BASE = binaryAsset(37)
const ASSET_CANDIDATE = binaryAsset(53)
const ASSET_DRIFTED = binaryAsset(97)
const ASSET_MAIN_DRIFT = binaryAsset(101)
try {
  mkdirSync(intRepo, { recursive: true })
  igit('init', '-b', 'main')
  writeFileSync(join(intRepo, 'file.txt'), 'alpha\nbeta\ngamma\n')
  writeFileSync(join(intRepo, 'other.txt'), 'unrelated\n')
  writeFileSync(join(intRepo, 'asset.bin'), ASSET_BASE)
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

// Capture a diff exactly like src/workspace/worktree.ts (T-044: diff the
// recorded base, not HEAD — for this detached-at-HEAD maker HEAD === base,
// so the bytes are identical to the pre-T-044 HEAD form): add -A
// --intent-to-add, diff <base> --binary.
function captureDiff(modifier) {
  const maker = join(intRoot, 'wt-maker')
  const base = igit('rev-parse', 'HEAD').trim()
  igit('worktree', 'add', maker, '--detach', base)
  try {
    modifier(maker)
    run('git', ['-C', maker, 'add', '-A', '--intent-to-add', '.'])
    return run('git', ['-C', maker, 'diff', base, '--binary'])
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

// T-027 — recorded gate commands: the compare-when-recorded replay contract.
// Three faces against a report whose recorded gate results carry `command`
// (what CommandGate now stamps), plus the old-shape fallback. The run ids
// sort BEFORE the 2099101103xxxx block below, so the existing tidy sweeps
// still dispose this block's replay worktrees unchanged — and this block
// runs before any other integrate invocation on this run root, so the
// mismatch face can pin "no lock taken" as `locks/` never appearing.
const diffT27 = captureDiff((maker) => {
  writeFileSync(join(maker, 'file.txt'), 'alpha\nbeta\ngamma\ndelta-t27\n')
  writeFileSync(join(maker, 'extra-t27.txt'), 'new file\n')
})
const T27_CMD = 'node -e "process.exit(0)"'
const REPORT_GATES_CMDED = REPORT_GATES.map((g) => ({ ...g, command: T27_CMD }))

// Face 1 — a re-supplied command that differs from a recorded command refuses
// from the pre-lock policy-refusal block: exit 1, no integration worktree,
// the sandbox repo's worktree list untouched, and no checkout lock ever taken.
makeIntRun('20991010030000', { diff: diffT27, id: 't01', gates: REPORT_GATES_CMDED })
const intMismatch = expectIntegrate(1, 'command mismatch', ['--run', '20991010030000', '--candidate', 't01',
  '--gate', 'check-a=node -e "process.exit(7)"', '--gate', `check-b=${T27_CMD}`, '--run-root', intRuns])
ok(intMismatch.code === 1, `a re-supplied command differing from a recorded command refuses (got ${intMismatch.code})`)
ok(/command/.test(intMismatch.out) && /check-a/.test(intMismatch.out), 'the refusal names the command mismatch and the offending gate')
ok(!existsSync(join(intRuns, '20991010030000', 'wt')), 'command-mismatch refusal happens before any worktree exists')
ok(igit('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length === 1, 'command-mismatch refusal leaves the sandbox repo worktree list untouched')
ok(!existsSync(join(intRuns, 'locks')), 'command-mismatch refusal took no checkout lock (no locks/ dir ever created)')

// Face 2 — exact match (names AND commands equal) replays, and the verdict
// records what ran: its gate entries carry the re-supplied commands verbatim.
makeIntRun('20991010030001', { diff: diffT27, id: 't02', gates: REPORT_GATES_CMDED })
const intExact = expectIntegrate(0, 'exact-match replay', ['--run', '20991010030001', '--candidate', 't02', ...CLI_GATES, '--run-root', intRuns])
ok(intExact.code === 0, `exact names-and-commands match replays with exit 0 (got ${intExact.code})`)
if (existsSync(join(intRuns, '20991010030001', 'integrate', 't02.json'))) {
  const t27Verdict = JSON.parse(readFileSync(join(intRuns, '20991010030001', 'integrate', 't02.json'), 'utf8'))
  ok(t27Verdict.passed === true && t27Verdict.gates.length === 2, 'exact-match verdict passes with both gates recorded')
  ok(t27Verdict.gates.every((g) => g.command === T27_CMD), 'the replay verdict records the re-supplied commands verbatim (IntegrateVerdict.gates[].command)')
} else {
  ok(false, 'the replay verdict records the re-supplied commands verbatim (t02.json missing)')
}

// Face 3 — old-shape reports replay name-only, exactly today's contract: a
// recorded gate WITHOUT command replays on the name set alone, including a
// DIFFERENT command under a matching name (the existing command-less
// REPORT_GATES fixtures above run unchanged as the back-compat pins).
makeIntRun('20991010030002', { diff: diffT27, id: 't03' })
const intOldShape = expectIntegrate(0, 'old-shape name-only', ['--run', '20991010030002', '--candidate', 't03',
  '--gate', `check-a=node -e "process.stdout.write('differs-from-recorded')"`, '--gate', `check-b=${T27_CMD}`, '--run-root', intRuns])
ok(intOldShape.code === 0, `old-shape report: a different command under a matching name does NOT refuse (got ${intOldShape.code})`)
ok(existsSync(join(intRuns, '20991010030002', 'integrate', 't03.json')) && JSON.parse(readFileSync(join(intRuns, '20991010030002', 'integrate', 't03.json'), 'utf8')).passed === true, 'old-shape name-only replay passes end to end')

// The two passing replays kept their dirty worktrees for inspection — dispose
// them through the house path so the existing tidy sweeps below stay green
// (they run without --force and rightly refuse dirty worktrees).
code = expectClean(0, 't27 exact-match disposal', ['--run', '20991010030001', '--run-root', intRuns, '--force'])
ok(code === 0, `clean --force disposes the exact-match replay worktree (got ${code})`)
code = expectClean(0, 't27 old-shape disposal', ['--run', '20991010030002', '--run-root', intRuns, '--force'])
ok(code === 0, `clean --force disposes the old-shape replay worktree (got ${code})`)

// T-028 — store-backed integrate: verify-when-recorded diff evidence
// (--db, default C:\swarm\refinery.db) plus best-effort verdict recording.
// The faces ingest their fixture runs into temp DBs through the real store
// (src/store/index.ts under tsx, via a generated helper — the check's
// sandbox is removed wholesale at the top of this section). Run ids sort
// BEFORE the 2099101103xxxx block below, so the existing tidy sweeps still
// dispose this block's replay worktrees; every passing replay disposes its
// own dirty worktree explicitly (the T-027 pattern) so the --all sweep
// below stays exit 0. Every refusal face pins: no integration worktree, the
// sandbox repo's worktree list untouched, and no residual lock files (the
// end-of-section pattern) — the refusals all come from the pre-lock
// policy-refusal block.
const ingestHelper = join(intRoot, 'ingest-helper.mjs')
writeFileSync(ingestHelper, [
  `import { readFileSync } from 'node:fs'`,
  `import { ingest } from '${pathToFileURL(join(root, 'src', 'store', 'index.ts')).href}'`,
  `const [reportPath, dbPath] = process.argv.slice(2)`,
  `ingest(JSON.parse(readFileSync(reportPath, 'utf8')), dbPath)`,
  '',
].join('\n'))
const runIngest = (label, reportPath, dbPath) => {
  let code = 0
  let out = ''
  try {
    run(process.execPath, [tsxCli, ingestHelper, reportPath, dbPath])
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  if (code !== 0) console.error(`--- ingest helper output (${label}) ---\n${out}`)
  return code
}
const t28Store = join(intRoot, 'store')
mkdirSync(t28Store, { recursive: true })
const diffT28 = captureDiff((maker) => writeFileSync(join(maker, 'file.txt'), 'alpha\nbeta\ngamma\ndelta-t28\n'))

// Flag + help: --db parses (every face below passes it) and is documented
// in the usage text with its default.
const intHelp = expectIntegrate(0, 'help', ['--help'])
ok(intHelp.code === 0, `integrate --help exits 0 (got ${intHelp.code})`)
ok(intHelp.out.includes('--db <path>') && /refinery\.db/.test(intHelp.out), 'usage documents --db with its default C:\\swarm\\refinery.db')

// Face 1 — intact-store replay proceeds: the run ingested, diff untouched →
// exit 0 with a log line naming the verified handle.
makeIntRun('20991010030010', { diff: diffT28, id: 's01' })
const t28VerifiedDb = join(t28Store, 't028-verified.db')
ok(runIngest('verified', join(intRuns, '20991010030010', 'report.json'), t28VerifiedDb) === 0, 'store-backed: intact-face run ingested into a temp DB')
const intVerified = expectIntegrate(0, 'verified replay', ['--run', '20991010030010', '--candidate', 's01', ...CLI_GATES, '--run-root', intRuns, '--db', t28VerifiedDb])
ok(intVerified.code === 0, `intact-store replay proceeds with exit 0 (got ${intVerified.code})`)
ok(/diff verified against the artifact store \(j:s01\/diff\.patch-[0-9a-f]{16}, unmutated since ingest\)/.test(intVerified.out), 'the intact replay logs the verified diff handle (unmutated since ingest)')
code = expectClean(0, 't28 verified disposal', ['--run', '20991010030010', '--run-root', intRuns, '--force'])
ok(code === 0, `clean --force disposes the store-backed replay worktree (got ${code})`)

// Face 2 — mutated diff refuses pre-lock: flip one byte of the diff after
// ingest → exit 1 from the policy-refusal block, no integration worktree,
// the sandbox repo untouched, no lock ever taken, no verdict artifact.
makeIntRun('20991010030011', { diff: diffT28, id: 's02' })
const t28MutatedDb = join(t28Store, 't028-mutated.db')
ok(runIngest('mutated', join(intRuns, '20991010030011', 'report.json'), t28MutatedDb) === 0, 'store-backed: mutated-face run ingested')
const mutatedDiffPath = join(intRuns, '20991010030011', 's02', 'diff.patch')
writeFileSync(mutatedDiffPath, readFileSync(mutatedDiffPath, 'utf8').replace('delta-t28', 'delta-TAMPER'))
const intMutated = expectIntegrate(1, 'mutated diff', ['--run', '20991010030011', '--candidate', 's02', ...CLI_GATES, '--run-root', intRuns, '--db', t28MutatedDb])
ok(intMutated.code === 1, `a diff mutated since ingest refuses (got ${intMutated.code})`)
ok(/mutated/.test(intMutated.out) && /since ingest/i.test(intMutated.out), 'the refusal says the since-ingest scope out loud')
ok(!existsSync(join(intRuns, '20991010030011', 'wt')), 'mutated-diff refusal creates no integration worktree')
ok(igit('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length === 1, 'mutated-diff refusal leaves the sandbox repo worktree list untouched')
ok(lockFilesIn(intRuns).length === 0, 'mutated-diff refusal takes no checkout lock')
ok(!existsSync(join(intRuns, '20991010030011', 'integrate')), 'mutated-diff refusal produces no verdict artifact')

// Face 3 — diff deleted after ingest refuses (store status missing), again
// with no worktree and no lock. The store check precedes the on-disk
// existence check, so the refusal names the recorded evidence, not the path.
makeIntRun('20991010030012', { diff: diffT28, id: 's03' })
const t28MissingDb = join(t28Store, 't028-missing.db')
ok(runIngest('missing', join(intRuns, '20991010030012', 'report.json'), t28MissingDb) === 0, 'store-backed: deleted-diff-face run ingested')
rmSync(join(intRuns, '20991010030012', 's03', 'diff.patch'))
const intDeleted = expectIntegrate(1, 'deleted diff', ['--run', '20991010030012', '--candidate', 's03', ...CLI_GATES, '--run-root', intRuns, '--db', t28MissingDb])
ok(intDeleted.code === 1, `a diff deleted since ingest refuses (got ${intDeleted.code})`)
ok(/status: missing/.test(intDeleted.out) && /existed at ingest/.test(intDeleted.out), 'the refusal names the store status missing (the file existed at ingest)')
ok(!existsSync(join(intRuns, '20991010030012', 'wt')), 'deleted-diff refusal creates no integration worktree')
ok(lockFilesIn(intRuns).length === 0, 'deleted-diff refusal takes no checkout lock')

// Face 4 — a DB that exists but cannot be opened refuses with a clear
// message rather than silently replaying unverified (the ticket's stated
// choice; silent fallback would hide expected integrity evidence).
makeIntRun('20991010030013', { diff: diffT28, id: 's04' })
const t28JunkDb = join(t28Store, 't028-junk.db')
writeFileSync(t28JunkDb, 'this is not a sqlite database\n')
const intJunk = expectIntegrate(1, 'unopenable store', ['--run', '20991010030013', '--candidate', 's04', ...CLI_GATES, '--run-root', intRuns, '--db', t28JunkDb])
ok(intJunk.code === 1, `a present-but-unreadable store refuses (got ${intJunk.code})`)
ok(/cannot be opened/.test(intJunk.out) && /refuses rather than proceeding unverified/.test(intJunk.out), 'the unopenable-store refusal names the problem and the choice')
ok(!existsSync(join(intRuns, '20991010030013', 'wt')), 'unopenable-store refusal creates no integration worktree')
ok(lockFilesIn(intRuns).length === 0, 'unopenable-store refusal takes no checkout lock')

// Face 5 — fallback, byte-for-byte today's behavior when nothing is
// recorded: a temp DB holding a NULL-hash row (the diff was absent at
// ingest, so the store recorded nothing to check) never blocks the replay
// and never claims verification — the file appeared on disk afterwards.
makeIntRun('20991010030014', { diff: diffT28, id: 's05', writeDiff: false })
const t28NullHashDb = join(t28Store, 't028-nullhash.db')
ok(runIngest('null-hash', join(intRuns, '20991010030014', 'report.json'), t28NullHashDb) === 0, 'store-backed: null-hash-face run ingested with the diff absent (row records NULL)')
writeFileSync(join(intRuns, '20991010030014', 's05', 'diff.patch'), diffT28)
const intNullHash = expectIntegrate(0, 'null-hash fallback', ['--run', '20991010030014', '--candidate', 's05', ...CLI_GATES, '--run-root', intRuns, '--db', t28NullHashDb])
ok(intNullHash.code === 0, `a null-hash (unverified) row falls back to today's replay, exit 0 (got ${intNullHash.code})`)
ok(!/diff verified against the artifact store/.test(intNullHash.out), 'the null-hash fallback does not claim store verification')
code = expectClean(0, 't28 fallback disposal', ['--run', '20991010030014', '--run-root', intRuns, '--force'])
ok(code === 0, `clean --force disposes the fallback replay worktree (got ${code})`)

// Face 6 — a failed store write does not change the verdict: --db at an
// unwritable store (the DB ingested, then made read-only) → verification
// falls back (no recorded row), the replay proceeds, the PERSISTENCE FAILED
// line logs loudly, the exit stays gate-determined, and the on-disk
// verdict artifact is intact.
makeIntRun('20991010030015', { diff: diffT28, id: 's06' })
const t28ReadonlyDb = join(t28Store, 't028-readonly.db')
ok(runIngest('readonly', join(intRuns, '20991010030015', 'report.json'), t28ReadonlyDb) === 0, 'store-backed: failed-write-face run ingested')
chmodSync(t28ReadonlyDb, 0o444)
const intReadonly = expectIntegrate(0, 'unwritable store', ['--run', '20991010030015', '--candidate', 's06', ...CLI_GATES, '--run-root', intRuns, '--db', t28ReadonlyDb])
ok(intReadonly.code === 0, `a failed store write leaves the exit gate-determined, exit 0 (got ${intReadonly.code})`)
ok(/PERSISTENCE FAILED/.test(intReadonly.out), 'the failed store write is logged loudly (PERSISTENCE FAILED)')
ok(existsSync(join(intRuns, '20991010030015', 'integrate', 's06.json'))
  && JSON.parse(readFileSync(join(intRuns, '20991010030015', 'integrate', 's06.json'), 'utf8')).passed === true, 'the on-disk verdict artifact is intact despite the failed store write')
chmodSync(t28ReadonlyDb, 0o666)
code = expectClean(0, 't28 failed-write disposal', ['--run', '20991010030015', '--run-root', intRuns, '--force'])
ok(code === 0, `clean --force disposes the failed-write replay worktree (got ${code})`)

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

// T-026 — binary-safe capture and replay. The sandbox baseline carries
// asset.bin; a candidate edit to it is captured through the flipped
// captureDiff mirror (`git diff HEAD --binary`), so the diff.patch carries
// `GIT binary patch` sections with the full 40-hex index lines git apply
// requires — never the lossy "Binary files … differ" stub the pre-fix
// capture emitted. Three faces (the ticket's behavior contract):
//   post-fix diff, clean target    → exit 0, byte-identical replay
//   pre-fix lossy stub             → historical-evidence refusal
//   post-fix diff, drifted binary  → ordinary apply-check refusal
// Every refusal leaves the integration worktree untouched (atomic
// git apply --check; the historical-stub check fires before any apply).
const binaryPatchFor = (assetBytes) => captureDiff((maker) => writeFileSync(join(maker, 'asset.bin'), assetBytes))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

// Face 1 — green byte-identical replay.
const diffBin = binaryPatchFor(ASSET_CANDIDATE)
ok(diffBin.includes('GIT binary patch') && !/^Binary files .* differ$/m.test(diffBin), 'binary-safe capture: diff.patch carries GIT binary patch, never the lossy stub')
makeIntRun('20991011030007', { diff: diffBin, id: 'c08' })
const intBin = expectIntegrate(0, 'binary replay', ['--run', '20991011030007', '--candidate', 'c08', ...CLI_GATES, '--run-root', intRuns])
ok(intBin.code === 0, `binary-touching replay exits 0 (got ${intBin.code})`)
const binWorktreeAsset = join(intRuns, '20991011030007', 'wt', 'int-c08', 'asset.bin')
ok(existsSync(binWorktreeAsset) && sha256(readFileSync(binWorktreeAsset)) === sha256(ASSET_CANDIDATE), 'replayed binary is byte-identical to the candidate version (sha256)')
if (existsSync(join(intRuns, '20991011030007', 'integrate', 'c08.json'))) {
  const binArtifact = JSON.parse(readFileSync(join(intRuns, '20991011030007', 'integrate', 'c08.json'), 'utf8'))
  ok(binArtifact.applied === true && binArtifact.treeChanged === true && binArtifact.passed === true, 'binary artifact records applied + treeChanged + passed')
  ok(binArtifact.gates.length === 2 && binArtifact.gates.every((g) => g.passed), 'binary artifact records every gate PASS')
} else {
  ok(false, 'binary artifact records applied + treeChanged + passed (c08.json missing)')
}
// disposal: the kept replay worktree is dirty by construction — plain clean
// refuses it, --force disposes it, and the binary evidence survives.
const refusedBinClean = runClean(['--run', '20991011030007', '--run-root', intRuns])
ok(refusedBinClean.code === 1, `plain clean refuses the dirty binary replay worktree (got ${refusedBinClean.code})`)
const forcedBinClean = runClean(['--run', '20991011030007', '--run-root', intRuns, '--force'])
ok(forcedBinClean.code === 0, `clean --force disposes the binary replay worktree (got ${forcedBinClean.code})`)
ok(!existsSync(join(intRuns, '20991011030007', 'wt', 'int-c08')), 'binary replay worktree removed by clean --force')
ok(existsSync(join(intRuns, '20991011030007', 'integrate', 'c08.json')) && existsSync(join(intRuns, '20991011030007', 'c08', 'diff.patch')), 'binary evidence (verdict, diff.patch) survives cleanup')

// Face 2 — pre-fix historical stub, hand-written to exactly the pre-fix
// capture's output shape (abbreviated index + the lossy stub line, the real
// pre-fix emission for this candidate change): refuses non-zero with the
// historical-evidence message, integration worktree untouched.
const STUB_PATCH = [
  'diff --git a/asset.bin b/asset.bin',
  'index afa8867..381bafd 100644',
  'Binary files a/asset.bin and b/asset.bin differ',
  '',
].join('\n')
makeIntRun('20991011030008', { diff: STUB_PATCH, id: 'c09' })
const intStub = expectIntegrate(1, 'historical stub', ['--run', '20991011030008', '--candidate', 'c09', ...CLI_GATES, '--run-root', intRuns])
ok(intStub.code === 1 && /predates binary-safe capture/.test(intStub.out), `pre-fix binary stub refuses as historical evidence (got ${intStub.code})`)
ok(run('git', ['-C', join(intRuns, '20991011030008', 'wt', 'int-c09'), 'status', '--porcelain']).trim() === '', 'historical stub leaves the integration worktree untouched')
ok(!existsSync(join(intRuns, '20991011030008', 'integrate')), 'historical stub produces no artifact')

// Face 3 — drifted binary: a post-fix patch whose pre-image no longer
// matches at current HEAD (same-file drift committed after the run base)
// falls through to the ordinary apply-check refusal.
const diffBinDrift = binaryPatchFor(ASSET_DRIFTED)
ok(diffBinDrift.includes('GIT binary patch'), 'drifted-binary fixture is a post-fix binary patch')
makeIntRun('20991011030009', { diff: diffBinDrift, id: 'c10' })
writeFileSync(join(intRepo, 'asset.bin'), ASSET_MAIN_DRIFT)
igit(...identity, 'add', '-A')
igit(...identity, 'commit', '-m', 'binary drift')
const intBinDrift = expectIntegrate(1, 'drifted binary', ['--run', '20991011030009', '--candidate', 'c10', ...CLI_GATES, '--run-root', intRuns])
ok(intBinDrift.code === 1 && /no longer applies/.test(intBinDrift.out), `drifted binary refuses through the ordinary apply-check path (got ${intBinDrift.code})`)
ok(run('git', ['-C', join(intRuns, '20991011030009', 'wt', 'int-c10'), 'status', '--porcelain']).trim() === '', 'drifted binary leaves the integration worktree untouched (atomic)')
ok(!existsSync(join(intRuns, '20991011030009', 'integrate')), 'drifted binary produces no artifact')

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
code = expectClean(0, 'integrate sweep last', ['--run', '20991011030009', '--run-root', intRuns])
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

// ---------- Gate 1.20: role capability restriction (T-023) ----------
section('Gate 1.20 — role capability restriction (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-capabilities.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'capabilities self-check exit 0')
} catch (e) {
  fail(`capabilities self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.21: per-role harness selection (T-025) ----------
section('Gate 1.21 — per-role harness selection (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-per-role-harness.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'per-role harness self-check exit 0')
} catch (e) {
  fail(`per-role harness self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.22: bounded R&D loop (T-030) ----------
section('Gate 1.22 — bounded R&D loop (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-rounds.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'rounds self-check exit 0')
} catch (e) {
  fail(`rounds self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.23: run dashboard (T-034) ----------
section('Gate 1.23 — run dashboard (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-dashboard.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'dashboard self-check exit 0')
} catch (e) {
  fail(`dashboard self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.24: bounded gate-failure retry (T-038) ----------
section('Gate 1.24 — bounded gate-failure retry (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-gate-retry.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'gate-retry self-check exit 0')
} catch (e) {
  fail(`gate-retry self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.25: verifier role (T-039) ----------
section('Gate 1.25 — verifier role (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-verifier.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'verifier self-check exit 0')
} catch (e) {
  fail(`verifier self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.26: the ratchet — finding→gate promotion proof (T-041) ----------
section('Gate 1.26 — the ratchet: finding→gate promotion proof (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-ratchet.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'ratchet promotion self-check exit 0')
} catch (e) {
  fail(`ratchet promotion self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.27: verifier findings into the retry brief (T-040) ----------
section('Gate 1.27 — verifier findings into the retry brief (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-gate-retry-findings.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'gate-retry-findings self-check exit 0')
} catch (e) {
  fail(`gate-retry-findings self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.28: prompt transport off argv (T-042) ----------
section('Gate 1.28 — prompt transport off argv (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-prompt-transport.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'prompt-transport self-check exit 0')
} catch (e) {
  fail(`prompt-transport self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.29: baseline gate sanity (T-043) ----------
section('Gate 1.29 — baseline gate sanity (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-baseline-gate.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'baseline-gate self-check exit 0')
} catch (e) {
  fail(`baseline-gate self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.30: evidence-destruction guard (T-044) ----------
section('Gate 1.30 — evidence-destruction guard (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-diff-basesha.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'diff-basesha self-check exit 0')
} catch (e) {
  fail(`diff-basesha self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.31: post-kill settle deadline (T-046) ----------
section('Gate 1.31 — post-kill settle deadline (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-settle-deadline.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'settle-deadline self-check exit 0')
} catch (e) {
  fail(`settle-deadline self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.32: gate/diff overlap evidence (T-045) ----------
section('Gate 1.32 — gate/diff overlap evidence (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-gate-overlap.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'gate-overlap self-check exit 0')
} catch (e) {
  fail(`gate-overlap self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.33: ignored-path parity evidence (T-047) ----------
section('Gate 1.33 — ignored-path parity evidence (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-ignored-paths.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'ignored-paths self-check exit 0')
} catch (e) {
  fail(`ignored-paths self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.34: clean's evidence-parity predicate (T-048) ----------
section('Gate 1.34 — clean evidence-parity predicate (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-clean-evidence.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'clean-evidence self-check exit 0')
} catch (e) {
  fail(`clean-evidence self-check failed: ${e.status ?? e.message}`)
  finish()
}

// ---------- Gate 1.35: round-2 brief-premise guard (T-050) ----------
section('Gate 1.35 — brief-premise guard (fast tier)')
try {
  run(process.execPath, [tsxCli, join(root, 'scripts', 'check-brief-premise.mjs')], { cwd: root, stdio: 'inherit' })
  ok(true, 'brief-premise self-check exit 0')
} catch (e) {
  fail(`brief-premise self-check failed: ${e.status ?? e.message}`)
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
  // T-030: Gate 2 is a real 2-round run (the ticket's mandate — this
  // change-set touches src/runner.ts and report shape, and the loop's
  // round-2 planner input must demonstrably carry round-1 survivor evidence
  // on a real run). The single-pass default stays pinned token-free by
  // Gates 1.10/1.21/1.22.
  '--rounds', '2',
  // T-038: Gate 2 is a real --gate-retry run (the ticket's mandate — the
  // change-set touches the runner's verdict-adjacent code and adds an
  // optional report block). The flag is INERT on any candidate whose gates
  // pass first try (it fires only on a worker-succeeded, non-zero-diff,
  // gate-FAILED candidate, exactly once), so it changes nothing about a
  // passing run; on a gate-failed candidate it grants one feedback-informed
  // attempt and the unchanged ladder still decides survival. Whether a real
  // run produces a genuine gate-failure -> retry -> survival is the staged
  // empirical question, recorded honestly either way.
  '--gate-retry',
  // T-040: Gate 2 is a real --goal --gate-retry --verifier-model run
  // end-to-end (the ticket's Gate 2 shape, sequenced as its own change-set —
  // T-038/T-039 landed separately). The verifier rides every candidate's
  // final attempt (T-039 semantics) and every gate-failed retry-eligible leg
  // before composition (T-040 semantics, bounded at two verifications per
  // candidate); findings remain advisory — the assertions below stay
  // gate-decided, and the verifier block is asserted structurally (present,
  // honest ok flag, well-formed observations), never on content.
  '--verifier-model', 'zai-coding-plan/glm-5.3-flash',
  '--run-root', verifyRoot.replace(/\//g, '\\'),
]
console.log('$ tsx src/cli.ts', skeletonArgs.slice(3).join(' '))
// The outer ceiling bounds CI; it must never preempt the runner's OWN verdict
// machinery (T-023 review round 1, VERIFICATION.md Known issue #12): the
// runner's per-worker budget is --timeout-min (default 15, src/cli.ts) per
// attempt, resolved by the T-011 verified tree kill into a FAILED candidate
// verdict, and the planner/gates/reviewer/verifier legs carry the same
// per-call budget. Since T-030 the run is a real 2-round loop, and since
// T-040 the tier also carries --verifier-model (four real verifier
// dispatches per healthy run, observed 278-429s each with a bounded repair;
// reviews 76-150s — see the two wrapper kills recorded under Known issue
// #12): the healthy slow-day skeleton path measured ~30+ min, so 35 min sat
// within noise of a HEALTHY run and one stalled leg (up to 15 min before its
// own budget reaps it into a runner verdict) would SIGTERM an informative
// run. 50 gives the healthy path room plus one such stall while still
// reaping a genuinely stuck run; the driving wrapper must sit ABOVE this
// plus the fast tier (the tracked workflow carries 60 min — the pairing is
// documented in VERIFICATION.md's Gate 2 section).
try {
  run(process.execPath, skeletonArgs, { cwd: root, stdio: 'inherit', timeout: 50 * 60_000 })
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

// T-030 loop assertions on the real 2-round run. The `rounds` block must be
// present (the run passed --rounds 2), round 1 must have produced survivors
// (otherwise no real loop ran), round 2 must have executed with the composed
// packet's fingerprint and an on-disk rendered block carrying every round-1
// survivor's evidence, and round-2 candidates must exist per survivor. The
// round-2 planner INPUT carrying that evidence is pinned token-free by Gate
// 1.22(b) (the machine planner logs req.prompt verbatim); here the real run
// pins the artifacts plus the planner input growth visible in the adapter's
// argv log lines (`<prompt: N chars>` — the block grows round 2's input).
ok(Array.isArray(report.rounds) && report.rounds.length === 2
  && report.rounds[0]?.round === 1 && report.rounds[0]?.executed === true
  && report.rounds[1]?.round === 2 && report.rounds[1]?.executed === true, 'the rounds block records two executed rounds')
const round1Survivors = report.rounds?.[0]?.survivorIds ?? []
ok(round1Survivors.length > 0, `round 1 produced survivors (${round1Survivors.join(', ')}) — a real 2-round run`)
ok(typeof report.rounds?.[1]?.packetFingerprint === 'string' && /^[0-9a-f]{64}$/.test(report.rounds[1].packetFingerprint),
  'the composed round-2 packet fingerprint is recorded (64-hex)')
const blockPath = report.rounds?.[1]?.renderedBlockPath
ok(typeof blockPath === 'string' && existsSync(blockPath), 'the round-2 rendered context block exists under the run artifacts dir')
if (existsSync(blockPath)) {
  const block = readFileSync(blockPath, 'utf8')
  ok(round1Survivors.every((id) => block.includes(id)), 'the rendered block carries every round-1 survivor id')
}
const round2Ids = round1Survivors.map((id) => `${id}-r2`)
ok(round2Ids.length > 0 && round2Ids.every((id) => report.candidates.some((c) => c.id === id)),
  `round 2 dispatched one candidate per round-1 survivor (${round2Ids.join(', ')})`)
ok(report.planner?.briefs?.length === round2Ids.length, 'one round-2 brief per round-2 candidate (the report\'s planner block is the final wave\'s)')
{
  const promptChars = (logPath) => {
    try {
      const m = readFileSync(logPath, 'utf8').match(/<prompt: (\d+) chars>/)
      return m === null ? null : Number(m[1])
    } catch {
      return null
    }
  }
  const round1Chars = promptChars(join(runDir, 'planner.log'))
  const round2Chars = promptChars(join(runDir, 'planner-r2.log'))
  ok(round1Chars !== null && round2Chars !== null && round2Chars > round1Chars,
    `the round-2 planner input grew by the composed block (round 1: ${round1Chars} chars, round 2: ${round2Chars} chars)`)
}
for (const c of report.candidates) {
  ok(c.workerOk === true && !c.workerTimedOut, `${c.id}: worker exited 0 in ${(c.workerDurationMs / 1000).toFixed(0)}s`)
  ok(c.diffBytes > 0, `${c.id}: diff non-empty (${c.diffBytes} bytes)`)
  ok(c.gates.length >= 2 && c.gates.every((g) => g.passed), `${c.id}: all gates pass (${c.gates.map((g) => g.name).join('+')})`)
  ok(!c.error, `${c.id}: no candidate error`)

  // T-040: the verifier rode this run (--verifier-model above). Structural
  // assertions only — findings advise, the gate assertions above decided:
  // the block is present with the model recorded verbatim, its ok flag is
  // honest (well-formed severity vocabulary when true, an explicit false
  // when the parse degraded), and its raw output exists on disk. On a real
  // run a gate-failed candidate also carries the pre-retry verification
  // (bounded at two verifications per candidate) — whether that happens is
  // read off the run's gateRetry blocks, never asserted here.
  ok(c.verifier !== undefined && c.verifier.model === 'zai-coding-plan/glm-5.3-flash',
    `${c.id}: verifier block present (model recorded verbatim)`)
  if (c.verifier?.ok === true) {
    const verifierSeveritiesOk = (c.verifier.observations ?? []).every((o) => typeof o.finding === 'string' && ['info', 'concern', 'blocker-advisory'].includes(o.severity))
    ok(verifierSeveritiesOk, `${c.id}: verifier observations well-formed (${c.verifier.observations.length})`)
  } else {
    ok(c.verifier?.ok === false, `${c.id}: verifier degradation recorded honestly (ok: false)`)
  }
  ok(typeof c.verifier?.rawOutputPath === 'string' && existsSync(c.verifier.rawOutputPath), `${c.id}: verifier raw output persisted`)

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
