// Gate/diff overlap evidence self-check (Gate 1.32, fast tier, T-045) —
// run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-gate-overlap.mjs
// Pins the 2026-10-23 adversarial review's F4: gates are shell commands
// evaluated in the candidate worktree (src/gate/command.ts), and the files
// they execute are files the worker can edit. A worker that weakens the
// test script plus adds a trivial change elsewhere produces a non-zero
// diff that passes every gate — the tampering is visible in the captured
// diff, but nothing machine-flags it, and `integrate` then re-runs the
// SAME recorded command on a replay tree that CONTAINS the tampering. The
// change is a deterministic, evidence-only overlap signal (the
// cleanupFailures pattern: produced beside the ladder, never read by it):
// after the final attempt's diff capture, the diff's changed paths
// (re-derived `git diff <baseSha> --name-only` in the lease, riding
// T-044's semantics) are intersected with the path-shaped tokens of each
// gate's RECORDED command (GateResult.command, T-027 — split on
// whitespace and shell separators; a token counts when it resolves to a
// file/directory in the worktree or matches a changed path; a token
// overlaps a changed path on equality or directory prefix). Recorded as
// the additive, producer-only `CandidateReport.gateCommandOverlap` block
// (present only when at least one gate overlaps), a loud NOTE line at the
// gate step, the run summary marker, and an integrate surface (print +
// record in the verdict JSON; exit stays gate-determined). A HEURISTIC,
// honestly named one: transitive loads are invisible (`node build.js` can
// require anything); npm/make-style commands with no path tokens yield no
// overlap by construction. Zero model tokens (fake WorkerAdapter + real
// CommandGate + the real CLI's machine worker + the real integrate CLI).
// All git calls list-form (AGENTS.md #4); sandbox removed at the end
// (AGENTS.md #10).
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
const cliTs = join(root, 'src', 'cli.ts')
const integrateTs = join(root, 'src', 'integrate.ts')
const sandbox = 'C:/swarm/verify-gate-overlap'
const IDENTITY = ['-c', 'user.name=check-gate-overlap', '-c', 'user.email=gate-overlap@local']

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })

// The pre-T-045 candidate-report key set — the clean-negative pin: a diff
// touching only non-gate files must produce a report whose shape is
// byte-identical to today's (the optional-field producer-only pattern).
const PRE_T045_KEYS = ['attempts', 'brief', 'diffBytes', 'diffPath', 'gates', 'id', 'model',
  'passedAllGates', 'workerDurationMs', 'workerId', 'workerOk', 'workerTimedOut', 'workspacePath']

// A fake WorkerAdapter (src/types.ts seam, the check-gate-retry pattern):
// one scripted step per worker call, replaying the last once the script
// runs out. Steps write files (tracked edits, new files) and/or remove
// them. Every call appends to its logPath first — like the real adapter.
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
      for (const w of step.writes ?? []) writeFileSync(join(req.cwd, w.file), w.content)
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

// A fake Gate (src/types.ts seam) that never executes anything — it
// returns a scripted PASS carrying a RECORDED command (GateResult.command,
// T-027), exactly what CommandGate stamps. The overlap computation reads
// the recorded string, never the execution.
const scriptedGate = (name, command) => ({
  name,
  run: async () => ({ name, passed: true, exitCode: 0, durationMs: 1, outputTail: `${name}: ok`, command }),
})

// One throwaway fixture repo per scenario (fresh branch namespace): the
// REAL WorktreeProvider and the real runner; only the worker is fake.
// console.log is captured around the drive so the gate-step NOTE lines can
// be asserted without a subprocess.
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

const noteLine = (id, gate, verdict, paths) =>
  `[${id}] gate ${gate}: ${verdict} — NOTE: diff touches files this gate executes: ${paths}`

// The base files of the evaluator-tampering scenarios: a REAL test script
// (green at base) and a REAL build script, both executed by real
// CommandGates inside the lease.
const GREEN_TEST = 'if (1 + 1 !== 2) { process.exit(1) }\nconsole.log("tests ok")\n'
const PLAIN_BUILD = 'console.log("build ok")\n'

const main = async () => {
  try {
    // ---------- O1: the tampering core — the red-bar face ----------
    // A worker that weakens test.js (the file gate `test=node test.js`
    // executes) plus adds a trivial change elsewhere: non-zero diff, every
    // gate passes, and (post-change) the report names gate + touched path,
    // the NOTE line prints, and the verdict is unchanged.
    {
      const worker = fakeWorker([{ writes: [
        { file: 'test.js', content: 'process.exit(0)\n' },
        { file: 'feature.js', content: '// a trivial change elsewhere\nmodule.exports = {}\n' },
      ] }])
      const gates = [new CommandGate('test', 'node test.js'), new CommandGate('build', 'node build.js')]
      const { report, artifactsDir, lines } = await drive('tampering-core', {
        worker, gates, files: { 'test.js': GREEN_TEST, 'build.js': PLAIN_BUILD },
      })
      const c = report.candidates[0]
      t('O1: the worker succeeded and the diff is non-empty (attempts=1)', c.workerOk === true && c.diffBytes > 0 && c.attempts.length === 1)
      t('O1: the recorded command is the input this reads (T-027): gates carry command "node test.js"/"node build.js"',
        c.gates[0]?.command === 'node test.js' && c.gates[1]?.command === 'node build.js')
      t('O1: the weakened evaluator still passes every gate (the tampering shape: non-zero diff, all gates PASS)',
        c.gates.every((g) => g.passed === true) && c.passedAllGates === true)
      t('O1: the tampering IS visible in the captured diff (test.js weakened to process.exit(0))',
        read(join(artifactsDir, 'c01', 'diff.patch')).includes('process.exit(0)'))
      t('O1: the report block names the gate and the touched path — gateCommandOverlap === [{gate:"test",touched:["test.js"]}]',
        eq(c.gateCommandOverlap, [{ gate: 'test', touched: ['test.js'] }]))
      t('O1: the block is present as a key on the candidate report', 'gateCommandOverlap' in c === true)
      t('O1: the loud NOTE line prints at the gate step for the overlapping gate',
        lines.includes(noteLine('c01', 'test', 'PASS', 'test.js')))
      t('O1: NO note line for the non-overlapping gate (build.js untouched by the diff)',
        !lines.some((l) => l.includes('gate build:') && l.includes('NOTE:')))
      t('O1: verdict inertness (pass direction): overlap present, passedAllGates still true — gates decided, the block did not',
        c.passedAllGates === true)
    }

    // ---------- O2: clean-negative — no block, byte-identical shape ----------
    // A diff touching only non-gate files produces NO block and the exact
    // pre-T-045 candidate-report key set (the optional-field producer-only
    // pattern).
    {
      const worker = fakeWorker([{ writes: [
        { file: 'feature.js', content: '// only a non-gate file\nmodule.exports = {}\n' },
      ] }])
      const gates = [new CommandGate('test', 'node test.js'), new CommandGate('build', 'node build.js')]
      const { report, lines } = await drive('clean-negative', {
        worker, gates, files: { 'test.js': GREEN_TEST, 'build.js': PLAIN_BUILD },
      })
      const c = report.candidates[0]
      t('O2: a non-overlapping diff produces NO gateCommandOverlap block (undefined, key absent)',
        c.gateCommandOverlap === undefined && !('gateCommandOverlap' in c))
      t('O2: the candidate report\'s key set is exactly the pre-T-045 set (byte-identical shape, the producer-only pattern)',
        eq(Object.keys(c).sort(), PRE_T045_KEYS))
      t('O2: the serialized report carries no gateCommandOverlap bytes anywhere', !JSON.stringify(report).includes('gateCommandOverlap'))
      t('O2: no NOTE line prints', !lines.some((l) => l.includes('NOTE: diff touches files')))
      t('O2: the clean candidate still passes exactly by its gates (passedAllGates true)', c.passedAllGates === true)
    }

    // ---------- O3: verdict inertness — the fail direction ----------
    // Overlap entries on BOTH a passing and a failing gate: the verdict
    // follows the gates alone (FAIL), the block records both, and the NOTE
    // line prints for each overlapping gate regardless of its verdict.
    {
      const worker = fakeWorker([{ writes: [
        { file: 'test.js', content: 'process.exit(0)\n' },
        { file: 'build.js', content: 'process.exit(1)\n' },
      ] }])
      const gates = [new CommandGate('test', 'node test.js'), new CommandGate('build', 'node build.js')]
      const { report, lines } = await drive('inertness-fail', {
        worker, gates, files: { 'test.js': GREEN_TEST, 'build.js': PLAIN_BUILD },
      })
      const c = report.candidates[0]
      t('O3: the block records BOTH overlapping gates in gate order (test passes, build fails — the NOTE is verdict-independent)',
        eq(c.gateCommandOverlap, [{ gate: 'test', touched: ['test.js'] }, { gate: 'build', touched: ['build.js'] }]))
      t('O3: gates decided: test PASS, build FAIL', c.gates[0]?.passed === true && c.gates[1]?.passed === false)
      t('O3: verdict inertness (fail direction): passedAllGates is false exactly by its gates — the block eliminated nothing and promoted nothing',
        c.passedAllGates === false)
      t('O3: the NOTE line prints for the passing overlapping gate AND the failing one',
        lines.includes(noteLine('c01', 'test', 'PASS', 'test.js')) && lines.includes(noteLine('c01', 'build', 'FAIL', 'build.js')))
    }

    // ---------- O4: multi-token commands, deleted files, the seam ----------
    // `npx eslint src/` flags a change under src/ (directory-prefix token);
    // `npm run build` never flags (no path tokens); `node gone.js` flags a
    // file the diff DELETED (the token matches a changed path without
    // resolving — the second clause of the path-shaped test). Fake gates:
    // only the RECORDED command string matters, nothing executes. Plus the
    // WorkspaceProvider.changedPaths seam contract pinned directly.
    {
      const worker = fakeWorker([{ writes: [
        { file: 'src/a.js', content: 'export const a = 2\n' },
        { file: 'docs/readme.md', content: 'readme v2\n' },
      ], removes: ['gone.js'] }])
      const gates = [
        scriptedGate('lint', 'npx eslint src/'),
        scriptedGate('build', 'npm run build'),
        scriptedGate('gone', 'node gone.js'),
      ]
      const { report, repo, artifactsDir, baseSha } = await drive('multi-token', {
        worker, gates, files: { 'src/a.js': 'export const a = 1\n', 'docs/readme.md': 'readme v1\n', 'gone.js': 'module.exports = 1\n' },
      })
      const c = report.candidates[0]
      t('O4: the directory-prefix token flags (lint="npx eslint src/" with a diff touching src/a.js)',
        eq(c.gateCommandOverlap?.[0], { gate: 'lint', touched: ['src/a.js'] }))
      t('O4: "npm run build" (no path tokens) never flags — no build entry in the block',
        c.gateCommandOverlap !== undefined && !c.gateCommandOverlap.some((o) => o.gate === 'build'))
      t('O4: a deleted file still flags (token "node gone.js" matches the changed path without resolving on disk)',
        eq(c.gateCommandOverlap, [{ gate: 'lint', touched: ['src/a.js'] }, { gate: 'gone', touched: ['gone.js'] }]))
      t('O4: the fake-gate drive still passes exactly by its gates (all scripted PASS, non-zero diff)',
        c.passedAllGates === true && c.gates.every((g) => g.passed))
      // The seam contract, pinned directly on the drive's lease (still on
      // disk: cleanWorkspaces=false): tracked edits + the deleted file,
      // repo-relative forward-slash paths.
      let seamPaths = null
      try {
        seamPaths = new WorktreeProvider(repo, artifactsDir).changedPaths({
          id: 'wt/c01', path: c.workspacePath, branch: 'swarm/wt-c01', baseSha,
        })
      } catch {
        seamPaths = null
      }
      t('O4: WorkspaceProvider.changedPaths re-derives the changed paths against the pinned base (edit + edit + deletion)',
        seamPaths !== null && eq(seamPaths.slice().sort(), ['docs/readme.md', 'gone.js', 'src/a.js']))
    }

    // ---------- O5: the real CLI — console line, summary marker, on-disk report ----------
    // A token-free machine-worker run through the real CLI (--jobs, the
    // check-gate-retry G5 pattern): the machine command weakens test.js,
    // the real gate `test=node test.js` passes on the weakened evaluator
    // (green at base first, T-043), and the run's stdout carries the gate
    // NOTE line and the RUN SUMMARY marker; report.json on disk carries the
    // block.
    {
      const fixtureRepo = join(sandbox, 'cli-fixture', 'repo')
      mkdirSync(fixtureRepo, { recursive: true })
      const fgit = (...args) => run('git', ['-C', fixtureRepo, ...args])
      fgit('init', '-b', 'main')
      writeFileSync(join(fixtureRepo, 'base.txt'), 'baseline\n')
      writeFileSync(join(fixtureRepo, 'test.js'), GREEN_TEST)
      fgit(...IDENTITY, 'add', '-A')
      fgit(...IDENTITY, 'commit', '-m', 'baseline')
      const specPath = join(sandbox, 'cli-fixture', 'spec.json')
      writeFileSync(specPath, JSON.stringify({
        phases: [{ id: 'main', dependencies: [], completion: 'all' }],
        jobs: [{
          id: 'j1',
          phase: 'main',
          dependencies: [],
          brief: 'make test.js always pass',
          worker: 'machine',
          command: ['node', '-e', 'const fs=require("fs");fs.writeFileSync("test.js", "process.exit(0)\\n")'],
          gates: [{ name: 'test', command: 'node test.js' }],
        }],
      }, null, 2))
      const runRoot = join(sandbox, 'cli-fixture', 'runs')
      const r = spawnSync(process.execPath, [tsxCli, cliTs, '--repo', fixtureRepo, '--jobs', specPath,
        '--no-review', '--run-root', runRoot, '--db', join(sandbox, 'cli-fixture', 'absent.db')], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
      const code = r.status === null ? -1 : r.status
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}`
      if (code !== 0) console.error(`--- cli (machine overlap run, exit ${code}) ---\n${out}`)
      t('O5: the real CLI run completes mechanically (exit 0 — the tampering passes every gate, exactly today\'s verdict)', code === 0)
      t('O5: the gate-step NOTE line prints on the real run\'s stdout',
        out.includes('[j1] gate test: PASS — NOTE: diff touches files this gate executes: test.js'))
      t('O5: the RUN SUMMARY line carries the marker (gate-overlap:test(test.js))',
        /^j1\s+worker:ok\s+\d+s\s+diff:[\d.]+KiB\s+test PASS => PASS(\s{2}gate-overlap:test\(test\.js\))?\s*$/m.test(out)
        && /gate-overlap:test\(test\.js\)/.test(out))
      const runDirs = existsSync(runRoot) ? readdirSync(runRoot).filter((d) => /^\d{14}$/.test(d)) : []
      if (runDirs.length === 1) {
        const creport = JSON.parse(read(join(runRoot, runDirs[0], 'report.json')))
        const cj = creport.candidates[0]
        t('O5: the on-disk report carries the block (gate + touched path) and the survivor verdict',
          eq(cj.gateCommandOverlap, [{ gate: 'test', touched: ['test.js'] }]) && cj.passedAllGates === true)
      } else {
        t('O5: exactly one run dir under the machine run root', false)
      }
    }

    // ---------- O6: integrate surfacing — print + record, exit gate-determined ----------
    // Synthetic reports over a scratch repo (the verify.mjs makeIntRun
    // pattern): an overlap-carrying survivor's replay prints the note and
    // records the block in <id>.json; the exit code follows the replayed
    // gates alone (a passing gate exits 0, a failing one exits 1 — the
    // block neither vetoes nor forces); a clean survivor's replay prints
    // no note and records no block key.
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
      writeFileSync(join(intRepo, 'test.js'), GREEN_TEST)
      igit(...IDENTITY, 'add', '-A')
      igit(...IDENTITY, 'commit', '-m', 'baseline')
      const INT_BASE = igit('rev-parse', 'HEAD').trim()
      // A real captured diff touching test.js (the maker-worktree mirror of
      // src/workspace/worktree.ts: add -A --intent-to-add, diff <base> --binary).
      const maker = join(intRoot, 'wt-maker')
      igit('worktree', 'add', maker, '--detach', INT_BASE)
      let DIFF
      try {
        writeFileSync(join(maker, 'test.js'), 'process.exit(0)\n')
        run('git', ['-C', maker, 'add', '-A', '--intent-to-add', '.'])
        DIFF = run('git', ['-C', maker, 'diff', INT_BASE, '--binary'])
      } finally {
        igit('worktree', 'remove', '--force', maker)
      }
      const PASS_CMD = 'node -e "process.exit(0)"'
      const FAIL_CMD = 'node -e "process.exit(1)"'
      const OVERLAP = [{ gate: 'test', touched: ['test.js'] }]
      const makeIntRun = (runId, { command, overlap }) => {
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
        if (overlap) candidate.gateCommandOverlap = overlap
        writeFileSync(join(runDir, 'report.json'), JSON.stringify({
          runId, repo: intRepo, baseSha: INT_BASE, goal: 'overlap fixture goal', model: 'fake/model',
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

      // Face A — overlap-carrying survivor, passing replay gate: exit 0,
      // note printed, block recorded in the verdict JSON.
      makeIntRun('20991225010000', { command: PASS_CMD, overlap: OVERLAP })
      const intA = expectIntegrate(0, 'overlap pass', ['--run', '20991225010000', '--candidate', 'c01',
        '--gate', `test=${PASS_CMD}`, '--run-root', intRuns])
      t('O6a: the replay of an overlap-carrying survivor exits 0 (the block is not a verdict — the gate decided)',
        intA.code === 0)
      t('O6a: the replay prints the note (gate/diff overlap, the gate and the file it executes named)',
        intA.out.includes('gate/diff overlap') && intA.out.includes('gate test executes test.js'))
      const verdictA = existsSync(join(intRuns, '20991225010000', 'integrate', 'c01.json'))
        ? JSON.parse(read(join(intRuns, '20991225010000', 'integrate', 'c01.json'))) : null
      t('O6a: the verdict JSON records the overlap block verbatim (passed: true)',
        verdictA !== null && verdictA.passed === true && eq(verdictA.gateCommandOverlap, OVERLAP))

      // Face B — the same survivor shape with a gate command that FAILS at
      // replay: exit 1 (gate-determined), the note still prints, the block
      // still records.
      makeIntRun('20991225010001', { command: FAIL_CMD, overlap: OVERLAP })
      const intB = expectIntegrate(1, 'overlap fail', ['--run', '20991225010001', '--candidate', 'c01',
        '--gate', `test=${FAIL_CMD}`, '--run-root', intRuns])
      t('O6b: the exit code stays gate-determined (a failing replay gate exits 1 — the block forced nothing)',
        intB.code === 1)
      t('O6b: the note still prints on the failing replay', intB.out.includes('gate/diff overlap') && intB.out.includes('gate test executes test.js'))
      const verdictB = existsSync(join(intRuns, '20991225010001', 'integrate', 'c01.json'))
        ? JSON.parse(read(join(intRuns, '20991225010001', 'integrate', 'c01.json'))) : null
      t('O6b: the failing replay\'s verdict records passed:false AND the block (evidence rides the verdict either way)',
        verdictB !== null && verdictB.passed === false && eq(verdictB.gateCommandOverlap, OVERLAP))

      // Face C — a clean survivor (no block): no note, no block key in the
      // verdict JSON (the producer-only pattern at the replay surface).
      makeIntRun('20991225010002', { command: PASS_CMD, overlap: null })
      const intC = expectIntegrate(0, 'clean replay', ['--run', '20991225010002', '--candidate', 'c01',
        '--gate', `test=${PASS_CMD}`, '--run-root', intRuns])
      t('O6c: a clean survivor\'s replay exits 0 with NO note printed', intC.code === 0 && !intC.out.includes('gate/diff overlap'))
      const verdictC = existsSync(join(intRuns, '20991225010002', 'integrate', 'c01.json'))
        ? JSON.parse(read(join(intRuns, '20991225010002', 'integrate', 'c01.json'))) : null
      t('O6c: the clean verdict JSON carries no gateCommandOverlap key', verdictC !== null && !('gateCommandOverlap' in verdictC))
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
      console.error(`\ncheck-gate-overlap: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-gate-overlap: ALL GREEN')
  })
