// Ignored-path parity evidence self-check (Gate 1.33, fast tier, T-047) —
// run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-ignored-paths.mjs
// Pins the 2026-10-23 adversarial review's F2 (the ticket's recorded
// scratch-repo repro): WorktreeProvider.diff respects .gitignore — a file
// written under node_modules/, dist/, or any ignored path appears in
// NEITHER the captured diff.patch NOR git status's ordinary output — while
// the gates execute in the live worktree where those files DO exist. Two
// consequences the engine recorded nothing about: a worker can make gates
// pass via changes in ignored paths (the promoted diff contains none of
// it), and any gate that installs dependencies creates a large ignored
// tree per worktree, so RUN gates and REPLAY gates (a fresh worktree
// holding only HEAD + diff.patch) execute in systematically different
// environments. The change is the mechanical first slice — make the
// asymmetry VISIBLE, never verdict-affecting (the cleanupFailures pattern):
// on the final attempt, AFTER the gate loop (so gate-installed trees are
// included — they are the parity-relevant set), `git status --porcelain
// --ignored` is written to the attempt's evidence dir as ignored-paths.txt
// and summarized on the report as the additive, producer-only
// `CandidateReport.ignoredPaths {count, entries}` block (entries capped at
// the exported MAX_IGNORED_PATHS, the MAX_RETRY_FINDINGS pattern); when
// replaying a candidate whose report carries a non-empty summary,
// `integrate` prints and records in the verdict JSON a parity note — the
// exit code stays gate-determined. Explicitly carved (the ticket's
// non-goal): dependency provisioning for worktrees (spec §13's manifest),
// pristine gate environments, tamper DETECTION for ignored paths. Zero
// model tokens (fake WorkerAdapter + real CommandGates + the real integrate
// CLI). All git calls list-form (AGENTS.md #4); sandbox removed at the end
// (AGENTS.md #10).
import { swarmRoot } from './swarm-root.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as runner from '../src/runner.ts'
import { runSkeleton } from '../src/runner.ts'
import { CommandGate } from '../src/gate/command.ts'
import { WorktreeProvider } from '../src/workspace/worktree.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const read = (p) => readFileSync(p, 'utf8')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const integrateTs = join(root, 'src', 'integrate.ts')
const sandbox = swarmRoot + '/verify-ignored-paths'
const IDENTITY = ['-c', 'user.name=check-ignored-paths', '-c', 'user.email=ignored-paths@local']

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })

// The pre-T-047 candidate-report key set — the clean-negative pin: a run
// with no ignored files must produce a report whose shape is byte-identical
// to today's (the optional-field producer-only pattern; the same list the
// T-045 check pins, since neither optional block has a producer here).
const PRE_T047_KEYS = ['attempts', 'brief', 'diffBytes', 'diffPath', 'gates', 'id', 'model',
  'passedAllGates', 'workerDurationMs', 'workerId', 'workerOk', 'workerTimedOut', 'workspacePath']

// The documented cap (src/runner.ts, VERIFICATION.md Gate 1.33). Asserted
// against the engine's own export below so the documentation and the code
// cannot drift — a namespace import (not named) so the pre-change RED BAR
// is behavioral assertions, not a module-link crash (the check-gate-retry-
// findings pattern).
const MAX_IGNORED_PATHS = 50

// A fake WorkerAdapter (src/types.ts seam, the check-gate-overlap pattern):
// one scripted step per worker call, replaying the last once the script runs
// out. Steps write files (tracked edits, new files, ignored-path writes —
// nested parents created) and/or remove them. Every call appends to its
// logPath first — like the real adapter.
function fakeWorker(steps) {
  const calls = []
  return {
    id: 'fake',
    calls,
    async execute(req) {
      calls.push(req.cwd)
      try {
        appendFileSync(req.logPath, `fake worker call ${calls.length}\n`)
      } catch {
        // Logging must never break a run.
      }
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]
      for (const w of step.writes ?? []) {
        mkdirSync(dirname(join(req.cwd, w.file)), { recursive: true })
        writeFileSync(join(req.cwd, w.file), w.content)
      }
      for (const f of step.removes ?? []) rmSync(join(req.cwd, f), { force: true })
      const ok = step.ok ?? true
      return {
        ok,
        exitCode: step.exitCode ?? (ok ? 0 : 1),
        timedOut: false,
        durationMs: 5,
        logPath: req.logPath,
        responseTail: step.responseTail ?? `fake response ${calls.length}`,
      }
    },
  }
}

// One throwaway fixture repo per scenario (fresh branch namespace): the
// REAL WorktreeProvider and the real runner; only the worker is fake.
// console.log is captured around the drive so the ignored-paths line can be
// asserted without a subprocess (the check-gate-overlap pattern).
async function drive(name, { worker, gates, files }) {
  const scenarioDir = join(sandbox, name)
  const repo = join(scenarioDir, 'repo')
  const artifactsDir = join(scenarioDir, 'run')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => run('git', ['-C', repo, ...args])
  git('init', '-b', 'main')
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), content)
  }
  git(...IDENTITY, 'add', '-A')
  git(...IDENTITY, 'commit', '-m', 'baseline')
  const baseSha = git('rev-parse', 'HEAD').trim()
  const lines = []
  const origLog = console.log
  console.log = (...args) => { lines.push(args.join(' ')) }
  let report
  try {
    report = await runSkeleton({
      runId: name,
      repo,
      baseSha,
      goal: 'make the change',
      model: 'fake/model',
      plannerModel: null,
      reviewerModel: null,
      candidateIds: ['c01'],
      concurrency: 1,
      timeoutMs: 10_000,
      maxAttempts: 1,
      gates,
      worker,
      workspaces: new WorktreeProvider(repo, artifactsDir),
      artifactsDir,
      cleanWorkspaces: false,
    })
  } finally {
    console.log = origLog
  }
  return { report, repo, artifactsDir, baseSha, lines }
}

const ignoredLine = (id, count, listed) =>
  `[${id}] ignored paths: ${count} (${listed}) — written to ignored-paths.txt; gate parity with a replay is not established`

// The base files of the scenarios: a REAL green test script and a REAL
// build script, both executed by real CommandGates inside the lease
// (green-at-base first, the T-043 posture).
const GREEN_TEST = 'if (1 + 1 !== 2) { process.exit(1) }\nconsole.log("tests ok")\n'
const PLAIN_BUILD = 'console.log("build ok")\n'
const GITIGNORE = 'node_modules/\ndist/\n'

const main = async () => {
  try {
    // ---------- F0: the documented cap is exported ----------
    t('F0: MAX_IGNORED_PATHS is exported and equals 50 (the MAX_RETRY_FINDINGS pattern)',
      runner.MAX_IGNORED_PATHS === MAX_IGNORED_PATHS)

    // ---------- I1: the ignored-write core — the red-bar face ----------
    // The 2026-10-23 repro: a worker writes a tracked change PLUS files
    // under ignored paths (node_modules/, dist/). Today the report carries
    // no trace of the ignored writes — the diff cannot see them (the
    // blindness premise) while the gates execute with them present.
    // Post-change: the snapshot file exists, the summary names both entries
    // with their count, and the verdict is untouched.
    {
      const worker = fakeWorker([{ writes: [
        { file: 'feature.js', content: '// a tracked change\nmodule.exports = {}\n' },
        { file: 'node_modules/dep/index.js', content: 'module.exports = "installed by the worker"\n' },
        { file: 'dist/bundle.js', content: '// built output\n' },
      ] }])
      const gates = [new CommandGate('build', 'node build.js')]
      const { report, repo, artifactsDir, baseSha, lines } = await drive('ignored-core', {
        worker, gates, files: { '.gitignore': GITIGNORE, 'feature.js': 'module.exports = 1\n', 'build.js': PLAIN_BUILD },
      })
      const c = report.candidates[0]
      t('I1: the worker succeeded, diff non-empty, one attempt (gates decided on a real tree)',
        c.workerOk === true && c.diffBytes > 0 && c.attempts.length === 1)
      t('I1: blindness premise pinned — the captured diff contains NONE of the ignored writes (no node_modules/, no dist/)',
        !read(join(artifactsDir, 'c01', 'diff.patch')).includes('node_modules')
        && !read(join(artifactsDir, 'c01', 'diff.patch')).includes('dist/'))
      t('I1: the ignored files exist in the lease — the gates executed with them present',
        existsSync(join(c.workspacePath, 'node_modules/dep/index.js'))
        && existsSync(join(c.workspacePath, 'dist/bundle.js')))
      const snap1 = join(artifactsDir, 'c01', 'ignored-paths.txt')
      t('I1: ignored-paths.txt exists in the attempt evidence dir and holds the full porcelain snapshot (!! dist/, !! node_modules/)',
        existsSync(snap1) && read(snap1).includes('!! dist/') && read(snap1).includes('!! node_modules/'))
      t('I1: the report summary names both ignored entries with their count — ignoredPaths === {count:2, entries:["dist/","node_modules/"]} (porcelain order)',
        eq(c.ignoredPaths, { count: 2, entries: ['dist/', 'node_modules/'] }))
      t('I1: the block is present as a key on the candidate report', 'ignoredPaths' in c === true)
      t('I1: the attempt records the snapshot among its output artifacts (the diff.patch precedent)',
        c.attempts[0].outputArtifacts.some((p) => p.replaceAll('\\', '/').endsWith('c01/ignored-paths.txt')))
      t('I1: the ignored-paths line prints at the evidence step',
        lines.includes(ignoredLine('c01', 2, 'dist/, node_modules/')))
      t('I1: verdict inertness (pass direction): ignored paths present, passedAllGates still true — gates decided, the block did not',
        c.passedAllGates === true && c.gates.every((g) => g.passed))
      // The seam contract, pinned directly on the drive's lease (still on
      // disk: cleanWorkspaces=false): raw `git status --porcelain --ignored`
      // output — the !!-prefixed ignored set plus the tracked change.
      let seamStatus = null
      try {
        seamStatus = new WorktreeProvider(repo, artifactsDir).ignoredStatus({
          id: 'wt/c01', path: c.workspacePath, branch: 'swarm/wt-c01', baseSha,
        })
      } catch {
        seamStatus = null
      }
      t('I1: WorkspaceProvider.ignoredStatus returns the raw porcelain snapshot (ignored !! entries + the tracked modification)',
        seamStatus !== null && seamStatus.includes('!! node_modules/') && seamStatus.includes('!! dist/')
        && seamStatus.includes('feature.js'))
    }

    // ---------- I2: gate-installed trees included (the placement pin) ----------
    // The snapshot must run AFTER the gate loop: the ignored tree here
    // exists ONLY because a gate created it (the npm-install shape) — the
    // worker wrote no ignored file at all. A snapshot taken before the
    // gates would record nothing.
    {
      const INSTALL_FIXTURE = 'const fs = require("fs")\n' +
        'fs.mkdirSync("node_modules/x", { recursive: true })\n' +
        'fs.writeFileSync("node_modules/x/index.js", "module.exports = 1\\n")\n' +
        'console.log("installed")\n'
      const worker = fakeWorker([{ writes: [
        { file: 'feature.js', content: '// a tracked change\nmodule.exports = {}\n' },
      ] }])
      const gates = [new CommandGate('install', 'node install-fixture.js'), new CommandGate('build', 'node build.js')]
      const { report, artifactsDir } = await drive('gate-installed', {
        worker, gates,
        files: { '.gitignore': GITIGNORE, 'feature.js': 'module.exports = 1\n', 'build.js': PLAIN_BUILD, 'install-fixture.js': INSTALL_FIXTURE },
      })
      const c = report.candidates[0]
      t('I2: the gate-installed ignored tree exists in the lease (node_modules/x/index.js)',
        existsSync(join(c.workspacePath, 'node_modules/x/index.js')))
      t('I2: the snapshot records the gate-installed tree — ignoredPaths === {count:1, entries:["node_modules/"]}',
        eq(c.ignoredPaths, { count: 1, entries: ['node_modules/'] }))
      const snap2 = join(artifactsDir, 'c01', 'ignored-paths.txt')
      t('I2: the snapshot file holds the !! node_modules/ line',
        existsSync(snap2) && read(snap2).includes('!! node_modules/'))
      t('I2: both gates passed and the verdict followed them alone (passedAllGates true)',
        c.passedAllGates === true && c.gates.length === 2 && c.gates.every((g) => g.passed))
    }

    // ---------- I3: the cap pin ----------
    // More ignored entries than the constant: count records the true total,
    // entries exactly the first MAX_IGNORED_PATHS in porcelain order (top-N,
    // not a sample), and the evidence file keeps ALL of them — the cap
    // bounds the report summary, never the evidence.
    {
      const writes = [{ file: 'feature.js', content: '// a tracked change\nmodule.exports = {}\n' }]
      for (let i = 1; i <= 60; i++) {
        writes.push({ file: `ign${String(i).padStart(2, '0')}/pkg.js`, content: '// ignored\n' })
      }
      const worker = fakeWorker([{ writes }])
      const gates = [new CommandGate('build', 'node build.js')]
      const { report, artifactsDir, lines } = await drive('cap', {
        worker, gates, files: { '.gitignore': 'ign*/\n', 'feature.js': 'module.exports = 1\n', 'build.js': PLAIN_BUILD },
      })
      const c = report.candidates[0]
      const first50 = Array.from({ length: 60 }, (_, i) => `ign${String(i + 1).padStart(2, '0')}/`).slice(0, MAX_IGNORED_PATHS)
      t('I3: count records the FULL pre-cap total (60 ignored entries)',
        c.ignoredPaths?.count === 60)
      t('I3: entries are exactly the first 50 in porcelain order (top-N, not a sample)',
        eq(c.ignoredPaths?.entries, first50))
      const snap3 = join(artifactsDir, 'c01', 'ignored-paths.txt')
      t('I3: the evidence file keeps ALL 60 !! lines — the cap bounds the summary, never the evidence',
        existsSync(snap3) && read(snap3).split('\n').filter((l) => l.startsWith('!! ')).length === 60)
      t('I3: the ignored-paths line names the remainder (+10 more)',
        lines.includes(ignoredLine('c01', 60, `${first50.join(', ')}, +10 more`)))
      t('I3: the capped candidate still passes exactly by its gates (passedAllGates true)',
        c.passedAllGates === true)
    }

    // ---------- I4: clean-negative — no block, byte-identical shape ----------
    // A .gitignore exists but nothing ignored is on disk: NO block, NO
    // snapshot file, NO console line, and the exact pre-T-047 candidate
    // report key set.
    {
      const worker = fakeWorker([{ writes: [
        { file: 'feature.js', content: '// only a tracked change\nmodule.exports = {}\n' },
      ] }])
      const gates = [new CommandGate('build', 'node build.js')]
      const { report, artifactsDir, lines } = await drive('clean-negative', {
        worker, gates, files: { '.gitignore': GITIGNORE, 'feature.js': 'module.exports = 1\n', 'build.js': PLAIN_BUILD },
      })
      const c = report.candidates[0]
      t('I4: a run with no ignored files produces NO ignoredPaths block (undefined, key absent)',
        c.ignoredPaths === undefined && !('ignoredPaths' in c))
      t('I4: the candidate report\'s key set is exactly the pre-T-047 set (byte-identical shape, the producer-only pattern)',
        eq(Object.keys(c).sort(), PRE_T047_KEYS))
      t('I4: the serialized report carries no ignoredPaths bytes anywhere', !JSON.stringify(report).includes('ignoredPaths'))
      t('I4: no ignored-paths.txt on disk', !existsSync(join(artifactsDir, 'c01', 'ignored-paths.txt')))
      t('I4: no ignored-paths console line prints', !lines.some((l) => l.includes('ignored paths:')))
      t('I4: the clean candidate still passes exactly by its gates (passedAllGates true)', c.passedAllGates === true)
    }

    // ---------- I5: verdict inertness — the fail direction ----------
    // Ignored paths present AND a failing gate: the verdict follows the
    // gates alone (FAIL), the block still records the ignored set —
    // evidence rides the verdict either way, and ignored-path presence
    // eliminated nothing, promoted nothing.
    {
      const worker = fakeWorker([{ writes: [
        { file: 'feature.js', content: '// a tracked change\nmodule.exports = {}\n' },
        { file: 'test.js', content: 'process.exit(1)\n' },
        { file: 'node_modules/dep/index.js', content: 'module.exports = "installed by the worker"\n' },
      ] }])
      const gates = [new CommandGate('test', 'node test.js'), new CommandGate('build', 'node build.js')]
      const { report, artifactsDir } = await drive('inertness-fail', {
        worker, gates, files: { '.gitignore': GITIGNORE, 'feature.js': 'module.exports = 1\n', 'test.js': GREEN_TEST, 'build.js': PLAIN_BUILD },
      })
      const c = report.candidates[0]
      t('I5: gates decided — test FAIL, build PASS', c.gates[0]?.passed === false && c.gates[1]?.passed === true)
      t('I5: verdict inertness (fail direction): passedAllGates is false exactly by its gates — the block eliminated nothing and promoted nothing',
        c.passedAllGates === false)
      t('I5: the block still records the ignored set on the failing candidate (evidence rides the verdict either way)',
        eq(c.ignoredPaths, { count: 1, entries: ['node_modules/'] })
        && existsSync(join(artifactsDir, 'c01', 'ignored-paths.txt')))
    }

    // ---------- I6: integrate parity note — print + record, exit gate-determined ----------
    // Synthetic reports over a scratch repo (the check-gate-overlap O6
    // pattern): a survivor whose report carries a non-empty ignored-path
    // summary replays with the parity note printed and the block recorded
    // in <id>.json; the exit code follows the replayed gates alone (a
    // passing gate exits 0, a failing one exits 1 — the note neither vetoes
    // nor forces); a clean survivor's replay prints no note and records no
    // block key; a capped summary names the remainder.
    {
      const intRoot = join(sandbox, 'integrate')
      const intRepo = join(intRoot, 'repo')
      const intRuns = join(intRoot, 'runs')
      mkdirSync(intRuns, { recursive: true })
      const absentDb = join(intRoot, 'store', 'absent.db')
      const igit = (...args) => run('git', ['-C', intRepo, ...args])
      mkdirSync(intRepo, { recursive: true })
      igit('init', '-b', 'main')
      writeFileSync(join(intRepo, 'file.txt'), 'alpha\n')
      writeFileSync(join(intRepo, '.gitignore'), GITIGNORE)
      igit(...IDENTITY, 'add', '-A')
      igit(...IDENTITY, 'commit', '-m', 'baseline')
      const INT_BASE = igit('rev-parse', 'HEAD').trim()
      // A real captured diff touching a tracked file (the maker-worktree
      // mirror of src/workspace/worktree.ts: add -A --intent-to-add, diff
      // <base> --binary).
      const maker = join(intRoot, 'wt-maker')
      igit('worktree', 'add', maker, '--detach', INT_BASE)
      let DIFF
      try {
        writeFileSync(join(maker, 'file.txt'), 'beta\n')
        run('git', ['-C', maker, 'add', '-A', '--intent-to-add', '.'])
        DIFF = run('git', ['-C', maker, 'diff', INT_BASE, '--binary'])
      } finally {
        igit('worktree', 'remove', '--force', maker)
      }
      const PASS_CMD = 'node -e "process.exit(0)"'
      const FAIL_CMD = 'node -e "process.exit(1)"'
      const SUMMARY = { count: 2, entries: ['dist/', 'node_modules/'] }
      const makeIntRun = (runId, { command, ignoredPaths }) => {
        const runDir = join(intRuns, runId)
        mkdirSync(join(runDir, 'c01'), { recursive: true })
        const dp = join(runDir, 'c01', 'diff.patch')
        writeFileSync(dp, DIFF)
        const candidate = {
          id: 'c01', workerId: 'machine', model: 'fake/model', brief: 'b',
          workspacePath: null, workerOk: true, workerTimedOut: false, workerDurationMs: 1000,
          diffPath: dp, diffBytes: Buffer.byteLength(DIFF),
          gates: [{ name: 'test', passed: true, exitCode: 0, durationMs: 10, outputTail: 'ok', command }],
          passedAllGates: true,
        }
        if (ignoredPaths) candidate.ignoredPaths = ignoredPaths
        writeFileSync(join(runDir, 'report.json'), JSON.stringify({
          runId, repo: intRepo, baseSha: INT_BASE, goal: 'parity fixture goal', model: 'fake/model',
          startedAt: '2026-10-23T00:00:00.000Z', finishedAt: '2026-10-23T00:01:00.000Z',
          candidates: [candidate],
        }, null, 2))
        return runDir
      }
      const expectIntegrate = (expectedCode, label, args) => {
        const rr = spawnSync(process.execPath, [tsxCli, integrateTs, ...args, '--db', absentDb], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
        const c2 = rr.status === null ? -1 : rr.status
        const o = `${rr.stdout ?? ''}${rr.stderr ?? ''}${rr.error?.message ?? ''}`
        if (c2 !== expectedCode) console.error(`--- integrate (${label}, exit ${c2}) ---\n${o}`)
        return { code: c2, out: o }
      }
      const verdictOf = (runId) => existsSync(join(intRuns, runId, 'integrate', 'c01.json'))
        ? JSON.parse(read(join(intRuns, runId, 'integrate', 'c01.json'))) : null

      // Face A — summary-carrying survivor, passing replay gate: exit 0,
      // note printed, block recorded in the verdict JSON.
      makeIntRun('20991226010000', { command: PASS_CMD, ignoredPaths: SUMMARY })
      const intA = expectIntegrate(0, 'parity pass', ['--run', '20991226010000', '--candidate', 'c01',
        '--gate', `test=${PASS_CMD}`, '--run-root', intRuns])
      t('I6a: the replay of a summary-carrying survivor exits 0 (the note is not a verdict — the gate decided)',
        intA.code === 0)
      t('I6a: the replay prints the parity note (ignored trees named, gate parity not established)',
        intA.out.includes('the run environment held ignored trees the replay tree lacks')
        && intA.out.includes('dist/, node_modules/') && intA.out.includes('gate parity is not established'))
      const verdictA = verdictOf('20991226010000')
      t('I6a: the verdict JSON records the summary verbatim (passed: true)',
        verdictA !== null && verdictA.passed === true && eq(verdictA.ignoredPaths, SUMMARY))

      // Face B — the same survivor shape with a gate command that FAILS at
      // replay: exit 1 (gate-determined), the note still prints, the block
      // still records.
      makeIntRun('20991226010001', { command: FAIL_CMD, ignoredPaths: SUMMARY })
      const intB = expectIntegrate(1, 'parity fail', ['--run', '20991226010001', '--candidate', 'c01',
        '--gate', `test=${FAIL_CMD}`, '--run-root', intRuns])
      t('I6b: the exit code stays gate-determined (a failing replay gate exits 1 — the note forced nothing)',
        intB.code === 1)
      t('I6b: the note still prints on the failing replay',
        intB.out.includes('ignored trees the replay tree lacks') && intB.out.includes('gate parity is not established'))
      const verdictB = verdictOf('20991226010001')
      t('I6b: the failing replay\'s verdict records passed:false AND the summary (evidence rides the verdict either way)',
        verdictB !== null && verdictB.passed === false && eq(verdictB.ignoredPaths, SUMMARY))

      // Face C — a clean survivor (no block): no note, no block key in the
      // verdict JSON (the producer-only pattern at the replay surface).
      makeIntRun('20991226010002', { command: PASS_CMD, ignoredPaths: null })
      const intC = expectIntegrate(0, 'clean replay', ['--run', '20991226010002', '--candidate', 'c01',
        '--gate', `test=${PASS_CMD}`, '--run-root', intRuns])
      t('I6c: a clean survivor\'s replay exits 0 with NO parity note printed',
        intC.code === 0 && !intC.out.includes('ignored trees the replay tree lacks'))
      const verdictC = verdictOf('20991226010002')
      t('I6c: the clean verdict JSON carries no ignoredPaths key', verdictC !== null && !('ignoredPaths' in verdictC))

      // Face D — a capped summary: the note lists the 50 recorded entries
      // and names the remainder (+10 more), exit 0.
      const cappedEntries = Array.from({ length: MAX_IGNORED_PATHS }, (_, i) => `ign${String(i + 1).padStart(2, '0')}/`)
      const CAPPED = { count: 60, entries: cappedEntries }
      makeIntRun('20991226010003', { command: PASS_CMD, ignoredPaths: CAPPED })
      const intD = expectIntegrate(0, 'capped parity note', ['--run', '20991226010003', '--candidate', 'c01',
        '--gate', `test=${PASS_CMD}`, '--run-root', intRuns])
      t('I6d: the capped summary\'s note names the remainder (+10 more) and the replay still exits 0',
        intD.code === 0 && intD.out.includes('(+10 more)'))
      const verdictD = verdictOf('20991226010003')
      t('I6d: the verdict records the capped summary verbatim', verdictD !== null && eq(verdictD.ignoredPaths, CAPPED))
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

main()
  .catch((e) => {
    failures.push(`gate crashed: ${e instanceof Error ? e.message : String(e)}`)
    console.error(e)
  })
  .finally(() => {
    if (failures.length > 0) {
      console.error(`\ncheck-ignored-paths: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-ignored-paths: ALL GREEN')
  })
