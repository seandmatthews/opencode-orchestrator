// Long-path budget self-check (Gate 1.19, fast tier, T-021, spec §15.4:1088-1098)
// — run under tsx (or plain node; no TS imports):
//   node node_modules/tsx/dist/cli.mjs scripts/check-long-paths.mjs
// Zero model tokens, zero opencode involvement, and nothing imported from
// src/: src/cli.ts exports nothing, and the values that decide path shape —
// the runId derivation (src/cli.ts:304), the run-root default (src/cli.ts:107),
// the lease-id shape (src/runner.ts:407) and the lease-path join
// (src/workspace/worktree.ts:68) — are unexported inline code. The gate pins
// them behaviorally: it builds a deep fixture repo in a throwaway sandbox
// under C:\swarm\verify-longpath (created and removed here — AGENTS.md #10),
// drives the REAL engine end-to-end with a token-free --jobs machine run (the
// Gate 1.17 S5 shape; NO --clean — disposal is its own assertion), then
// asserts every budget and depth fact from the run's actual records:
//   R1  exactly one 14-digit run dir under the sandbox run root (flips if the
//       runId derivation changes);
//   R2  report.json workspacePath == <runDir>\wt\<jobId> exactly, and the
//       dispatch.jsonl dispatch record carries the same worktreePath with
//       leaseId wt/<jobId> and branch swarm/wt-<jobId> (flips if the lease-id
//       shape or the lease-path join changes);
//   R3  the composed worktree prefix — <runId> + \wt\ + lease id read off the
//       records, composed against the locked run-root default C:\swarm
//       (decisions.md 2026-10-10) — measures ≤ 40 chars;
//   R4  before disposal, the deepest composed file path (recorded
//       workspacePath + the fixture-relative deep path) exists on disk and
//       lands in the documented 240–258 band (inside MAX_PATH 260; no
//       core.longpaths, no \\?\ prefixing — default-Windows behavior);
//   R5  the run succeeded at that depth: workerOk, diffBytes > 0, the
//       deep-file gate passed, and diff.patch contains the deep path and
//       reads back byte-identical after disposal;
//   R6  tsx src/clean.ts --run <runId> --run-root <sandbox> --force removes
//       the worktree + swarm/* branch with the evidence files hash-identical.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const read = (p) => readFileSync(p, 'utf8')
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const NODE = process.execPath
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const IDENTITY = ['-c', 'user.name=check-longpath', '-c', 'user.email=longpath@local']
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })

// The throwaway sandbox, created and removed by this check (AGENTS.md #10).
const SANDBOX = 'C:\\swarm\\verify-longpath'
const RUNS = join(SANDBOX, 'runs') // the --run-root handed to the engine

// ---------- the deterministic depth plan ----------
// The fixture must be sized BEFORE the run, so the composed depth is planned
// from the engine's observable contract (14-digit run ids; leases at
// <runDir>\wt\<jobId>). Nothing is ASSERTED from this plan — every assertion
// below reads the run's real records; the plan only sizes the tree.
const jobId = 'deep'
const RUN_ID_LEN = 14
const BAND = [240, 258] // the documented composed-depth band, inside MAX_PATH 260
const predictedWorkspaceLen = RUNS.length + 1 + RUN_ID_LEN + 1 + 'wt'.length + 1 + jobId.length
const targetComposed = Math.floor((BAND[0] + BAND[1]) / 2) // mid-band
const DEEP_FILE = 'deep-leaf-marker-file-for-gate-019.txt'
const deepRelLen = targetComposed - predictedWorkspaceLen - 1

/** A deterministic repo-relative path of an EXACT character length: bounded
 *  4-char directory names (the last absorbs the remainder, ≤ 9 chars), then
 *  the deep file. Forward slashes — git's separator, and node's on Windows. */
function deepRelPath(totalLen, fileName) {
  const dirBudget = totalLen - fileName.length - 1 // the separator before the file name
  const k = Math.round(dirBudget / 5)
  const lastLen = dirBudget - 5 * k + 5
  if (dirBudget < 9 || lastLen < 4) {
    throw new Error(`deep path plan broken: total ${totalLen}, dirBudget ${dirBudget}, lastLen ${lastLen}`)
  }
  const dirs = []
  for (let i = 0; i < k; i++) {
    const base = `d${String(i).padStart(3, '0')}` // 4 chars — bounded names
    dirs.push(i === k - 1 ? base + 'x'.repeat(lastLen - 4) : base)
  }
  return `${dirs.join('/')}/${fileName}`
}
const DEEP_REL = deepRelPath(deepRelLen, DEEP_FILE)

function main() {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(RUNS, { recursive: true })

  // ---------- the deep fixture repo (demo-target style) ----------
  const repo = join(SANDBOX, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => run('git', ['-C', repo, ...args])
  const write = (name, content) => {
    mkdirSync(dirname(join(repo, name)), { recursive: true })
    writeFileSync(join(repo, name), content)
  }
  write('package.json', JSON.stringify({ name: 'longpath-target', private: true }, null, 2))
  write('calc.js', 'function add(a, b) {\n  return a + b\n}\n\nmodule.exports = { add }\n')
  write('build.js', [
    "const { add } = require('./calc.js')",
    'if (add(2, 3) !== 5) {',
    "  console.error('build check failed')",
    '  process.exit(1)',
    '}',
    "console.log('build ok')",
  ].join('\n') + '\n')
  write('test.js', [
    "const assert = require('node:assert')",
    "const { add } = require('./calc.js')",
    '',
    'assert.equal(add(1, 2), 3)',
    'assert.equal(add(-1, 1), 0)',
    "console.log('tests ok')",
  ].join('\n') + '\n')
  write('.gitignore', 'node_modules/\n')
  // The fixture helper the machine command and the gate both run; the deep
  // path is a generated constant so no command/gate string carries ~200 chars
  // of tree through a shell (the AGENTS.md #4 hazard class).
  write('tools/longpath.mjs', [
    '// Generated by scripts/check-long-paths.mjs — the deep-file append/validate pair.',
    '// Runs inside the leased worktree (cwd = the worktree root).',
    "import { appendFileSync, readFileSync } from 'node:fs'",
    `const DEEP = ${JSON.stringify(DEEP_REL)}`,
    `const MARKER = 'long-path gate line'`,
    "const mode = process.argv[2]",
    "if (mode === 'append') {",
    "  appendFileSync(DEEP, MARKER + '\\n')",
    "  console.log('appended one line to ' + DEEP)",
    "} else if (mode === 'check') {",
    "  if (!readFileSync(DEEP, 'utf8').includes(MARKER)) {",
    "    console.error('deep file does not carry the appended line: ' + DEEP)",
    '    process.exit(1)',
    '  }',
    "  console.log('deep file ok at repo-relative depth ' + DEEP.length)",
    '} else {',
    "  console.error('usage: node tools/longpath.mjs append|check')",
    '  process.exit(1)',
    '}',
  ].join('\n') + '\n')
  // The deep file itself, at the planned depth, committed at baseline. T-043:
  // the baseline content already carries the gate's marker line so the
  // deep-file gate is green on the untouched base (pre-T-043 it only became
  // green after the worker's append); the append still changes the file, so
  // the diff stays non-empty.
  write(DEEP_REL, 'deep baseline\nlong-path gate line\n')

  git('init', '-b', 'main')
  git(...IDENTITY, 'add', '-A')
  git(...IDENTITY, 'commit', '-m', 'baseline: deep tree with build and test checks')
  // Fail fast if the baseline does not actually pass (the demo-target rule).
  let baselineOk = true
  try {
    run(NODE, ['build.js'], { cwd: repo })
    run(NODE, ['test.js'], { cwd: repo })
  } catch {
    baselineOk = false
  }
  t(`1.19: the deep fixture repo holds a baseline-passing build+test and a ${DEEP_REL.length}-char deep path (planned composed depth ${predictedWorkspaceLen + 1 + DEEP_REL.length})`, baselineOk)

  // ---------- the real token-free engine run (the Gate 1.17 S5 shape) ----------
  const specPath = join(SANDBOX, 'jobs.json')
  writeFileSync(specPath, JSON.stringify({
    phases: [{ id: 'work' }],
    jobs: [{
      id: jobId,
      phase: 'work',
      dependencies: [],
      brief: 'Append one line to the deep file.',
      worker: 'machine',
      command: [NODE, 'tools/longpath.mjs', 'append'],
      gates: [{ name: 'deep-file', command: 'node tools/longpath.mjs check' }],
    }],
  }, null, 2))

  let code = 0
  let out = ''
  try {
    out = run(process.execPath, [
      tsxCli,
      join(root, 'src', 'cli.ts'),
      '--repo', repo,
      '--jobs', specPath,
      '--no-review',
      '--run-root', RUNS,
      '--db', join(SANDBOX, 'refinery.db'),
      // NO --clean: disposal is its own assertion (R6).
    ], { timeout: 120_000 })
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  if (code !== 0) console.error(`--- long-path e2e run output (exit ${code}) ---\n${out}`)
  t('1.19: the real CLI --jobs machine run exits 0 at the composed depth', code === 0)

  // ---------- R1: the runId derivation, from the records ----------
  const runIds = readdirSync(RUNS).filter((d) => /^\d{14}$/.test(d))
  t('1.19: exactly one 14-digit run dir appeared under the sandbox run root', runIds.length === 1)
  if (runIds.length !== 1) throw new Error('1.19: no run dir to assert on')
  const runId = runIds[0]
  const runDir = join(RUNS, runId)

  const report = JSON.parse(read(join(runDir, 'report.json')))
  t('1.19: the report records exactly the one deep job, against this repo',
    report.candidates.length === 1 && report.candidates[0]?.id === jobId && report.repo === repo)

  // ---------- R5 (verdict half): the run succeeded at depth ----------
  const cand = report.candidates[0]
  t('1.19: the job succeeded at the composed depth — workerOk, diffBytes > 0, the deep-file gate passed, no error',
    cand.workerOk === true && cand.workerTimedOut === false && cand.diffBytes > 0
    && cand.passedAllGates === true && cand.gates?.[0]?.name === 'deep-file' && cand.gates?.[0]?.passed === true
    && cand.error === undefined)

  // ---------- R2: the lease shape, from the records ----------
  const expectedWt = join(runDir, 'wt', jobId)
  t('1.19: workspacePath is exactly <runDir>\\wt\\<jobId> — the shallow two-level layout',
    cand.workspacePath === expectedWt)
  const dispatchLines = read(join(runDir, 'dispatch.jsonl')).trim().split('\n').map((l) => JSON.parse(l))
  const header = dispatchLines.find((l) => l.type === 'run')
  const dispatch = dispatchLines.find((l) => l.type === 'dispatch')
  const completion = dispatchLines.find((l) => l.type === 'completion')
  t('1.19: dispatch.jsonl agrees — header runId; dispatch leaseId wt/<jobId>, branch swarm/wt-<jobId>, same worktreePath; completion ok with the captured diffBytes (never a failed-capture null)',
    header?.runId === runId
    && dispatch?.jobId === jobId && dispatch?.attempt === 1
    && dispatch?.leaseId === `wt/${jobId}` && dispatch?.branch === `swarm/wt-${jobId}`
    && dispatch?.worktreePath === expectedWt
    && completion?.ok === true && completion?.diffBytes !== null && completion?.diffBytes === cand.diffBytes)

  // ---------- R3: the composed worktree budget ----------
  // The engine's own composition, read off the recorded path (everything the
  // engine appended to the run root this check chose: '\wt\<jobId>'), composed
  // against the LOCKED run-root default C:\swarm (decisions.md 2026-10-10) —
  // the production prefix the MAX_PATH budget cares about (the engine's
  // worst case today is ≈34 chars). The sandbox run root is necessarily
  // longer than C:\swarm, so asserting the literal recorded path would
  // measure the check's own sandbox choice, not the engine's budget.
  const engineTail = expectedWt.slice(runDir.length)
  const productionPrefix = `C:\\swarm\\${runId}${engineTail}`
  t(`1.19: the composed worktree prefix (C:\\swarm + <runId> + \\wt\\ + lease id, runId and lease id from the records) measures ≤ 40 chars (measured ${productionPrefix.length})`,
    productionPrefix.length <= 40)

  // ---------- R4: the deepest composed file path ----------
  const deepAbs = join(expectedWt, ...DEEP_REL.split('/'))
  t('1.19: the deepest composed file path exists on disk before disposal and carries the appended line',
    existsSync(deepAbs) && readFileSync(deepAbs, 'utf8').includes('long-path gate line'))
  t(`1.19: the deepest composed path lands in the documented ${BAND[0]}–${BAND[1]} band (inside MAX_PATH 260) — measured ${deepAbs.length}`,
    deepAbs.length >= BAND[0] && deepAbs.length <= BAND[1])

  // ---------- R5 (evidence half): the diff carries the deep path ----------
  const diffPath = join(runDir, jobId, 'diff.patch')
  const diff = read(diffPath)
  t('1.19: diff.patch contains the deep path and its byte length matches the recorded diffBytes',
    diff.includes(DEEP_REL) && Buffer.byteLength(diff) === cand.diffBytes)

  // Evidence hashes BEFORE disposal, for the byte-identical survival pin.
  const before = {
    report: sha256(join(runDir, 'report.json')),
    dispatch: sha256(join(runDir, 'dispatch.jsonl')),
    log: sha256(join(runDir, jobId, 'worker.log')),
    diff: sha256(diffPath),
  }

  // ---------- R6: disposal at composed depth through the house path ----------
  // --force is correct here: the run captured the evidence before disposal
  // (the Gate 2 posture, VERIFICATION.md).
  let cleanCode = 0
  let cleanOut = ''
  try {
    cleanOut = run(process.execPath, [tsxCli, join(root, 'src', 'clean.ts'), '--run', runId, '--run-root', RUNS, '--force'], { timeout: 120_000 })
  } catch (e) {
    cleanCode = e.status ?? -1
    cleanOut = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  if (cleanCode !== 0) console.error(`--- clean output (exit ${cleanCode}) ---\n${cleanOut}`)
  t('1.19: clean --run <runId> --run-root <sandbox> --force exits 0', cleanCode === 0)
  t('1.19: the deep worktree is gone — directory removed, only main in worktree list, no swarm/* branches left',
    !existsSync(expectedWt) && !existsSync(join(runDir, 'wt'))
    && run('git', ['-C', repo, 'worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length === 1
    && run('git', ['-C', repo, 'branch', '--list', 'swarm/*']).trim() === '')
  const evidence = [join(runDir, 'report.json'), join(runDir, 'dispatch.jsonl'), join(runDir, jobId, 'worker.log'), diffPath]
  t('1.19: the evidence files survived disposal — present and hash-identical to before',
    evidence.every((p) => existsSync(p))
    && sha256(evidence[0]) === before.report
    && sha256(evidence[1]) === before.dispatch
    && sha256(evidence[2]) === before.log
    && sha256(evidence[3]) === before.diff)

  console.log(`measured: workspacePath ${cand.workspacePath.length} chars; composed deep file ${deepAbs.length} chars; production prefix ${productionPrefix.length} chars; deep repo-relative path ${DEEP_REL.length} chars`)
}

try {
  main()
  rmSync(SANDBOX, { recursive: true, force: true })
} catch (e) {
  failures.push(`gate crashed: ${e instanceof Error ? e.message : String(e)}`)
  console.error(e)
  rmSync(SANDBOX, { recursive: true, force: true })
} finally {
  if (failures.length > 0) {
    console.error(`\ncheck-long-paths: ${failures.length} failure(s)`)
    process.exit(1)
  }
  console.log('\ncheck-long-paths: ALL GREEN')
}
