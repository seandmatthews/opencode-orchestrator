// No-gates warning honesty self-check (Gate 1.50, fast tier, T-064) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-no-gates-warning.mjs
// Drives the REAL CLI (src/cli.ts) against throwaway fixture repos with
// `machine` workers (the check-baseline-gate G5/R6 pattern) — zero model
// tokens. Pins T-064 (register R8): the pre-T-064 no-gates console line read
// `warning: no --gate given; every candidate passes vacuously` while the
// ladder does the OPPOSITE — `base.passedAllGates = base.gates.length > 0 &&
// …` (src/runner.ts) — so a run with no gates FAILS every candidate on the
// zero-gate leg, and an operator who read the warning and proceeded lost
// every candidate to a rule they were told did not exist. Three leg groups:
//
// W1 — the warning tells the truth (the green face of the recorded red/green
//      pair): in a no-gates run exactly one no-gates warning fires, it names
//      ELIMINATION ("eliminates every candidate", the zero-gate leg), it
//      names the remedy (--gate to give candidates a survival bar; --jobs
//      probes for an evidence-only run), and the vacuous-passing claim is
//      gone — "passes vacuously" appears nowhere in the output.
// W2 — no behavior change (the ticket's second AC): the SAME no-gates run
//      still proceeds and completes (exit 0 — probe-only / evidence-gathering
//      runs are legitimate), report.json keeps the completed-run top-level
//      shape, and every candidate is eliminated BY THE ZERO-GATE LEG
//      specifically — gates [] (no gates ran), workerOk true and diffBytes
//      > 0 (the machine worker wrote a real diff, so the other two ladder
//      legs are green; only the missing-gate leg fails), passedAllGates
//      false. These are the exact properties the pre-change tree exhibits
//      (this check's W2 legs ran green against the pristine lane = main
//      before the change — VERIFICATION.md's Gate 1.50 red/green record).
// W3 — the warning's trigger is the run's EFFECTIVE gate set (the same
//      deduplicated union the baseline check uses): a --jobs run whose jobs
//      carry their own gates HAS a survival bar, so no no-gates warning
//      fires there (the pre-change line fired in that face too, with the
//      same lie), and its candidate genuinely passes (per-job gate PASS,
//      diffBytes > 0, passedAllGates true) — the silence is truthful, not
//      suppression.
//
// All subprocess calls are list-form (AGENTS #4); the sandbox under C:\swarm
// is created and removed by this check (AGENTS #10).
import { swarmRoot } from './swarm-root.mjs'
import { spawnSync, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const cliTs = join(root, 'src', 'cli.ts')
const sandbox = swarmRoot + '/verify-no-gates-warning'
const IDENTITY = ['-c', 'user.name=check-no-gates-warning', '-c', 'user.email=no-gates-warning@local']
const NODE = process.execPath

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })

// One throwaway fixture repo per face: fresh branch namespace, so faces
// cannot collide on swarm/* branch names (the check-baseline-gate pattern).
function makeRepo(name, files) {
  const repo = join(sandbox, name, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => run('git', ['-C', repo, ...args])
  git('init', '-b', 'main')
  for (const [fname, content] of Object.entries(files)) writeFileSync(join(repo, fname), content)
  git(...IDENTITY, 'add', '-A')
  git(...IDENTITY, 'commit', '-m', 'baseline')
  return { repo, git, baseSha: git('rev-parse', 'HEAD').trim() }
}

// The machine worker writes a real file → a non-zero diff, so a no-gates
// candidate's elimination can only be the zero-gate ladder leg (W2's pin).
const WORKER_CMD = [NODE, '-e', "require('fs').writeFileSync('feature.txt', 'feature v1\\n')"]

const runCli = (args, label, { timeout = 120_000 } = {}) => {
  const r = spawnSync(process.execPath, [tsxCli, cliTs, ...args], { encoding: 'utf8', windowsHide: true, timeout })
  const code = r.status === null ? -1 : r.status
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}`
  if (label !== null && !/^expected/i.test(label)) console.error(`--- cli (${label}, exit ${code}) ---\n${out}`)
  return { code, out }
}

const theOnlyRunDir = (runRoot) => {
  const dirs = existsSync(runRoot) ? readdirSync(runRoot).filter((d) => /^\d{14}$/.test(d)) : []
  return dirs.length === 1 ? join(runRoot, dirs[0]) : null
}

// The completed-run top-level report shape (the check-baseline-gate R4 pin) —
// the no-behavior-change invariant: this change must not add, remove, or
// reorder a report key.
const REPORT_KEYS = ['baseSha', 'candidates', 'finishedAt', 'goal', 'model', 'repo', 'runId', 'schedule', 'startedAt']

const writeSpec = (path, jobs) => writeFileSync(path, JSON.stringify({
  phases: [{ id: 'main', dependencies: [], completion: 'all' }],
  jobs,
}, null, 2))

const main = async () => {
  // ---------- W1 + W2: the no-gates run — the warning tells the truth, the behavior does not change ----------
  {
    const { repo, baseSha } = makeRepo('w1-no-gates', { 'README.md': 'no-gates warning sandbox\n' })
    const specPath = join(sandbox, 'w1-no-gates', 'spec.json')
    writeSpec(specPath, [{ id: 'j1', phase: 'main', dependencies: [], brief: 'write a feature file', worker: 'machine', command: WORKER_CMD }])
    const runRoot = join(sandbox, 'w1-no-gates', 'runs')
    const r = runCli(['--repo', repo, '--jobs', specPath, '--no-review', '--clean',
      '--run-root', runRoot, '--db', join(sandbox, 'w1-no-gates', 'store.db')], 'no-gates run')

    // W2: the run still proceeds and completes — probe-only / evidence-gathering
    // runs without gates are legitimate; refusing them is a named non-goal.
    t('W2: the no-gates run still proceeds and completes (exit 0) — nothing about the run is refused or altered', r.code === 0)

    // W1: exactly one no-gates warning fires (the marker prefix is shared by
    // the pre- and post-change lines, so the count pins both trees).
    const warnLines = r.out.split('\n').filter((l) => l.includes('no --gate given'))
    t('W1: exactly one no-gates warning line fires', warnLines.length === 1)
    const warn = warnLines[0] ?? ''
    t('W1: the vacuous-passing claim is gone — "passes vacuously" appears nowhere in the output',
      !warn.includes('passes vacuously') && !r.out.includes('passes vacuously'))
    t('W1: the warning names elimination — "eliminates every candidate"', warn.includes('eliminates every candidate'))
    t('W1: the warning names the zero-gate ladder leg as the mechanism', warn.includes('zero-gate'))
    t('W1: the warning names the remedy — pass --gate', warn.includes('--gate'))
    t('W1: the warning cites --jobs for evidence-only runs', warn.includes('--jobs'))

    // W2: report shape + verdicts, semantically identical to main's.
    const runDir = theOnlyRunDir(runRoot)
    t('W2: exactly one run dir exists', runDir !== null)
    if (runDir === null) return
    t('W2: report.json exists', existsSync(join(runDir, 'report.json')))
    const report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'))
    t('W2: report.json keeps the completed-run top-level shape (no key added, removed, or reordered by the warning change)',
      eq(Object.keys(report).sort(), [...REPORT_KEYS].sort()) && report.baseSha === baseSha && report.runId === basename(runDir))
    t('W2: the run carried exactly one candidate', report.candidates.length === 1)
    const c = report.candidates[0] ?? {}
    t('W2: every candidate is eliminated — passedAllGates false (the zero-gate ladder leg, untouched)',
      c.passedAllGates === false)
    t('W2: the elimination is the zero-gate leg specifically — gates [] (no gate ran), workerOk true, diffBytes > 0 (the worker wrote a real diff; both other ladder legs green)',
      eq(c.gates, []) && c.workerOk === true && typeof c.diffBytes === 'number' && c.diffBytes > 0)
  }

  // ---------- W3: a --jobs run whose jobs carry their own gates is not warned ----------
  {
    // build.js exits 0 on the UNTOUCHED base (green baseline, the T-043 check
    // passes) and still exits 0 after the worker's unrelated feature.txt —
    // the candidate has a real survival bar and clears it.
    const { repo } = makeRepo('w3-job-gates', { 'README.md': 'job-gates sandbox\n', 'build.js': "console.log('build ok')\n" })
    const specPath = join(sandbox, 'w3-job-gates', 'spec.json')
    writeSpec(specPath, [{
      id: 'j1', phase: 'main', dependencies: [], brief: 'write a feature file', worker: 'machine', command: WORKER_CMD,
      gates: [{ name: 'build', command: 'node build.js' }],
    }])
    const runRoot = join(sandbox, 'w3-job-gates', 'runs')
    const r = runCli(['--repo', repo, '--jobs', specPath, '--no-review', '--clean',
      '--run-root', runRoot, '--db', join(sandbox, 'w3-job-gates', 'store.db')], 'jobs-with-gates run (no run-level --gate)')

    t('W3: the jobs-with-gates run completes (exit 0)', r.code === 0)
    t('W3: NO no-gates warning fires — the run HAS a survival bar (per-job gates), so the elimination warning would be the same lie in the other direction',
      !r.out.includes('no --gate given') && !r.out.includes('zero-gate'))
    const runDir = theOnlyRunDir(runRoot)
    t('W3: exactly one run dir exists', runDir !== null)
    if (runDir === null) return
    const report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'))
    const c = report.candidates[0] ?? {}
    t('W3: the candidate genuinely PASSES its per-job gate (passedAllGates true, gate PASS, diffBytes > 0) — the silence is truthful, not suppression',
      c.passedAllGates === true && Array.isArray(c.gates) && c.gates.length === 1
      && c.gates[0].name === 'build' && c.gates[0].passed === true && typeof c.diffBytes === 'number' && c.diffBytes > 0)
  }

  rmSync(sandbox, { recursive: true, force: true })
}

main()
  .catch((e) => {
    failures.push(`check crashed: ${e instanceof Error ? e.message : String(e)}`)
    console.error(e)
  })
  .finally(() => {
    if (failures.length > 0) {
      console.error(`\ncheck-no-gates-warning: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-no-gates-warning: ALL GREEN')
  })
