// Baseline gate sanity self-check (Gate 1.29, fast tier, T-043) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-baseline-gate.mjs
// Drives the REAL CLI (src/cli.ts) against throwaway fixture repos with
// `machine` workers (the check-gate-retry G5 pattern) — zero model tokens.
// Pins: a red base (a gate failing on the untouched base commit) REFUSES the
// run before any dispatch — exit 1, the loud per-gate block (name, command,
// exitCode, output tail, the override hint), a baseline-check.json artifact
// naming gate name/command/exitCode, and zero planner/worker dispatch
// evidence in the run dir; --allow-red-base proceeds over the same red base
// with the recorded red block riding the run dir (outcome red, overridden
// true) while candidates still dispatch; a green base is inert (run proceeds,
// report.json unchanged in shape — no baseline key); --jobs mode checks the
// DEDUPLICATED UNION of per-job gate sets (disjoint gates, one shared
// name+command pair runs once) and the run-level --gate set via jobs that
// default to it; a no-gates run records the vacuous green check (no lease);
// and the reserved baseline lease (wt/_baseline → swarm/wt--baseline, an
// underscore charset no job id can match — SPEC_ID_PATTERN is
// [a-z0-9][a-z0-9-]*) leaves NO residual worktree or swarm/* branch on any
// path (pass, refusal, override). Every face gets a FRESH throwaway repo so
// branch namespaces cannot collide. All git calls are list-form (AGENTS #4);
// the sandbox is removed at the end (AGENTS #10).
import { swarmRoot } from './swarm-root.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
const sandbox = swarmRoot + '/verify-baseline-gate'
const IDENTITY = ['-c', 'user.name=check-baseline-gate', '-c', 'user.email=baseline-gate@local']
const NODE = process.execPath

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })

// One throwaway fixture repo per face: fresh branch namespace, so faces
// cannot collide on swarm/* branch names (the check-gate-retry pattern).
// `files` decide the base's color: a broken test.js makes the base red.
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

const GREEN_FILES = {
  'build.js': "console.log('build ok')\n",
  'test.js': "console.log('tests ok')\n",
}
const RED_FILES = {
  'build.js': "console.log('build ok')\n",
  'test.js': "console.log('this test is BROKEN at the base commit')\nprocess.exit(1)\n",
}
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

const worktreeCount = (git) => git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length
const swarmBranches = (git) => git('branch', '--list', 'swarm/*').split('\n').map((l) => l.replace(/^[*+]\s*/, '').trim()).filter(Boolean)

const main = async () => {
  // ---------- R0: --help documents the override ----------
  {
    const help = runCli(['--help'], null)
    t('R0: --help documents --allow-red-base (the named human override)', help.code === 0 && help.out.includes('--allow-red-base'))
  }

  // ---------- R1: red base refuses before any dispatch ----------
  {
    const { repo, git, baseSha } = makeRepo('r1-refusal', RED_FILES)
    const specPath = join(sandbox, 'r1-refusal', 'spec.json')
    writeFileSync(specPath, JSON.stringify({
      phases: [{ id: 'main', dependencies: [], completion: 'all' }],
      jobs: [{
        id: 'j1', phase: 'main', dependencies: [], brief: 'write a feature file',
        worker: 'machine', command: WORKER_CMD,
        gates: [{ name: 'build', command: 'node build.js' }, { name: 'test', command: 'node test.js' }],
      }],
    }, null, 2))
    const runRoot = join(sandbox, 'r1-refusal', 'runs')
    const r = runCli(['--repo', repo, '--jobs', specPath, '--no-review', '--run-root', runRoot,
      '--db', join(sandbox, 'r1-refusal', 'store.db')], 'refusal over a red base')
    t('R1: a red base refuses with exit 1', r.code === 1)
    t('R1: the refusal prints the loud per-gate block — header, gate name, exit code, command, output tail, and the override hint',
      r.out.includes('BASELINE GATE FAILURE')
      && r.out.includes('gate test: FAIL (exit 1)')
      && r.out.includes('command: node test.js')
      && r.out.includes('this test is BROKEN at the base commit')
      && r.out.includes('Re-run with --allow-red-base'))
    t('R1: the refusal says WHY — candidates would fail for reasons unrelated to their work, before any dispatch',
      r.out.includes('unrelated to its work') && r.out.includes('before any dispatch'))
    const runDir = theOnlyRunDir(runRoot)
    t('R1: exactly one run dir exists (the refusal artifact dir)', runDir !== null)
    if (runDir === null) return
    const artifact = join(runDir, 'baseline-check.json')
    t('R1: baseline-check.json is written in the run dir', existsSync(artifact))
    const rec = JSON.parse(readFileSync(artifact, 'utf8'))
    t('R1: the record names the base, the reserved lease, and the outcome red/not-overridden',
      rec.baseSha === baseSha && eq(rec.lease, { id: 'wt/_baseline', branch: 'swarm/wt--baseline' })
      && rec.outcome === 'red' && rec.overridden === false)
    t('R1: the record carries every gate with name, command, and exitCode (the AC pin)',
      Array.isArray(rec.gates) && rec.gates.length === 2
      && rec.gates[0].name === 'build' && rec.gates[0].command === 'node build.js' && rec.gates[0].exitCode === 0 && rec.gates[0].passed === true
      && rec.gates[1].name === 'test' && rec.gates[1].command === 'node test.js' && rec.gates[1].exitCode === 1 && rec.gates[1].passed === false)
    t('R1: ZERO dispatch evidence in the run dir — no dispatch.jsonl, no report.json, no candidate evidence dirs',
      !existsSync(join(runDir, 'dispatch.jsonl')) && !existsSync(join(runDir, 'report.json'))
      && !existsSync(join(runDir, 'j1')))
    t('R1: no planner/worker tokens were spendable — the run never reached runSkeleton (the refusal precedes it)',
      r.out.includes('baseline:') && !r.out.includes('[j1]'))
    t('R1: the baseline worktree is disposed and its swarm/* branch removed (only main, no branches)',
      worktreeCount(git) === 1 && swarmBranches(git).length === 0)
    t('R1: no leftover wt/_baseline directory in the run dir', !existsSync(join(runDir, 'wt', '_baseline')))
  }

  // ---------- R2: --jobs mode checks the deduplicated union; a shared
  // name+command pair runs once; the refusal names only the red gate ----------
  {
    const { repo, git } = makeRepo('r2-union', {
      'a-ok.js': "console.log('a ok')\n",
      'b-red.js': "console.log('b is red at the base')\nprocess.exit(1)\n",
    })
    const specPath = join(sandbox, 'r2-union', 'spec.json')
    const SHARED = { name: 'shared', command: 'node -e "process.exit(0)"' }
    writeFileSync(specPath, JSON.stringify({
      phases: [{ id: 'main', dependencies: [], completion: 'all' }],
      jobs: [
        { id: 'ja', phase: 'main', dependencies: [], brief: 'job a', worker: 'machine', command: WORKER_CMD,
          gates: [{ name: 'a-ok', command: 'node a-ok.js' }, SHARED] },
        { id: 'jb', phase: 'main', dependencies: [], brief: 'job b', worker: 'machine', command: WORKER_CMD,
          gates: [SHARED, { name: 'b-red', command: 'node b-red.js' }] },
      ],
    }, null, 2))
    const runRoot = join(sandbox, 'r2-union', 'runs')
    const r = runCli(['--repo', repo, '--jobs', specPath, '--no-review', '--run-root', runRoot,
      '--db', join(sandbox, 'r2-union', 'store.db')], 'union refusal (one red disjoint gate)')
    t('R2: the union refusal exits 1', r.code === 1)
    const runDir = theOnlyRunDir(runRoot)
    t('R2: one run dir', runDir !== null)
    if (runDir === null) return
    const rec = JSON.parse(readFileSync(join(runDir, 'baseline-check.json'), 'utf8'))
    t('R2: 4 raw gate entries across two disjoint jobs dedup to 3 distinct (the shared name+command runs once), first-seen order [a-ok, shared, b-red]',
      rec.gates.length === 3 && eq(rec.gates.map((g) => g.name), ['a-ok', 'shared', 'b-red']))
    t('R2: the refusal names ONLY the red gate of the union',
      r.out.includes('gate b-red: FAIL') && !r.out.includes('gate a-ok: FAIL') && !r.out.includes('gate shared: FAIL'))
    t('R2: disposal held on the union refusal path too (only main, no swarm/* branches)',
      worktreeCount(git) === 1 && swarmBranches(git).length === 0)
  }

  // ---------- R3: --allow-red-base proceeds, red evidence riding the run dir ----------
  {
    const { repo, git } = makeRepo('r3-override', RED_FILES)
    const specPath = join(sandbox, 'r3-override', 'spec.json')
    writeFileSync(specPath, JSON.stringify({
      phases: [{ id: 'main', dependencies: [], completion: 'all' }],
      jobs: [{
        id: 'j1', phase: 'main', dependencies: [], brief: 'write a feature file',
        worker: 'machine', command: WORKER_CMD,
        gates: [{ name: 'build', command: 'node build.js' }, { name: 'test', command: 'node test.js' }],
      }],
    }, null, 2))
    const runRoot = join(sandbox, 'r3-override', 'runs')
    const r = runCli(['--repo', repo, '--jobs', specPath, '--no-review', '--allow-red-base', '--clean',
      '--run-root', runRoot, '--db', join(sandbox, 'r3-override', 'store.db')], 'override dispatch over a red base')
    t('R3: the overridden run completes mechanically (exit 0)', r.code === 0)
    t('R3: the override face prints the red block with the OVERRIDDEN header and names itself',
      r.out.includes('BASELINE RED (OVERRIDDEN)') && r.out.includes('--allow-red-base') && r.out.includes('gate test: FAIL (exit 1)'))
    const runDir = theOnlyRunDir(runRoot)
    t('R3: one run dir', runDir !== null)
    if (runDir === null) return
    const rec = JSON.parse(readFileSync(join(runDir, 'baseline-check.json'), 'utf8'))
    t('R3: the recorded block rides the run dir — outcome red, overridden true, every gate with its command',
      rec.outcome === 'red' && rec.overridden === true
      && rec.gates.length === 2 && rec.gates.every((g) => typeof g.command === 'string')
      && rec.gates.some((g) => g.name === 'test' && g.passed === false))
    t('R3: candidates WERE dispatched — dispatch.jsonl carries the run header and the dispatch line',
      existsSync(join(runDir, 'dispatch.jsonl'))
      && readFileSync(join(runDir, 'dispatch.jsonl'), 'utf8').includes('"type":"dispatch"'))
    const report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'))
    t('R3: report.json exists with the candidate — gates decided its verdict over the red base (test FAIL → eliminated), never silently passed',
      report.candidates.length === 1 && report.candidates[0].passedAllGates === false
      && report.candidates[0].gates.some((g) => g.name === 'test' && g.passed === false))
    t('R3: the baseline branch was removed on the override path too (candidate branches are --clean\'s business; swarm/wt--baseline is the baseline\'s own)',
      !swarmBranches(git).includes('swarm/wt--baseline') && worktreeCount(git) === 1)
  }

  // ---------- R4: a green base is inert — the run proceeds unchanged ----------
  {
    const { repo, git, baseSha } = makeRepo('r4-green', GREEN_FILES)
    const specPath = join(sandbox, 'r4-green', 'spec.json')
    writeFileSync(specPath, JSON.stringify({
      phases: [{ id: 'main', dependencies: [], completion: 'all' }],
      jobs: [{
        id: 'j1', phase: 'main', dependencies: [], brief: 'write a feature file',
        worker: 'machine', command: WORKER_CMD,
        gates: [{ name: 'build', command: 'node build.js' }, { name: 'test', command: 'node test.js' }],
      }],
    }, null, 2))
    const runRoot = join(sandbox, 'r4-green', 'runs')
    const r = runCli(['--repo', repo, '--jobs', specPath, '--no-review', '--clean',
      '--run-root', runRoot, '--db', join(sandbox, 'r4-green', 'store.db')], 'green base proceeds')
    t('R4: a green-base run proceeds and completes (exit 0)', r.code === 0)
    t('R4: the baseline leg is visible on stdout and green', r.out.includes('[baseline] gate build: PASS') && r.out.includes('[baseline] gate test: PASS') && r.out.includes('baseline: green'))
    const runDir = theOnlyRunDir(runRoot)
    t('R4: one run dir', runDir !== null)
    if (runDir === null) return
    const rec = JSON.parse(readFileSync(join(runDir, 'baseline-check.json'), 'utf8'))
    t('R4: the green record — every gate passed, outcome green, not overridden, the reserved lease named',
      rec.outcome === 'green' && rec.overridden === false && rec.baseSha === baseSha
      && eq(rec.lease, { id: 'wt/_baseline', branch: 'swarm/wt--baseline' })
      && rec.gates.length === 2 && rec.gates.every((g) => g.passed === true))
    const report = JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8'))
    t('R4: report.json keeps today\'s top-level shape — no baseline key, the candidate passed its gates (additive baseline-check.json aside)',
      eq(Object.keys(report).sort(), ['baseSha', 'candidates', 'finishedAt', 'goal', 'model', 'repo', 'runId', 'schedule', 'startedAt'])
      && report.candidates.length === 1 && report.candidates[0].passedAllGates === true)
    // --clean disposes candidate worktrees but leaves their swarm/* branches
    // (pre-existing behavior, gc's business) — the baseline's OWN residue is
    // what this face pins: the reserved branch is gone and no worktree (the
    // baseline's or a candidate's) remains registered.
    t('R4: no residual baseline worktree or swarm/wt--baseline branch on the pass path (only main registered)',
      worktreeCount(git) === 1 && !swarmBranches(git).includes('swarm/wt--baseline'))
  }

  // ---------- R5: the run-level --gate set (jobs defaulting to it) ----------
  {
    const { repo, git } = makeRepo('r5-runlevel', RED_FILES)
    const specPath = join(sandbox, 'r5-runlevel', 'spec.json')
    writeFileSync(specPath, JSON.stringify({
      phases: [{ id: 'main', dependencies: [], completion: 'all' }],
      // No per-job gates: both default to the run-level --gate set.
      jobs: [
        { id: 'j1', phase: 'main', dependencies: [], brief: 'write a feature file', worker: 'machine', command: WORKER_CMD },
      ],
    }, null, 2))
    const runRoot = join(sandbox, 'r5-runlevel', 'runs')
    const r = runCli(['--repo', repo, '--jobs', specPath, '--no-review',
      '--gate', 'build=node build.js', '--gate', 'test=node test.js',
      '--run-root', runRoot, '--db', join(sandbox, 'r5-runlevel', 'store.db')], 'run-level gates refusal')
    t('R5: the run-level --gate set is what the baseline checks — the red run-level gate refuses (exit 1)',
      r.code === 1 && r.out.includes('gate test: FAIL (exit 1)'))
    const runDir = theOnlyRunDir(runRoot)
    t('R5: one run dir', runDir !== null)
    if (runDir === null) return
    const rec = JSON.parse(readFileSync(join(runDir, 'baseline-check.json'), 'utf8'))
    t('R5: jobs defaulting to the run-level set dedup to exactly the run-level set (one job → 2 distinct gates)',
      rec.gates.length === 2 && eq(rec.gates.map((g) => g.name), ['build', 'test']))
    t('R5: disposal held (only main, no swarm/* branches)', worktreeCount(git) === 1 && swarmBranches(git).length === 0)
  }

  // ---------- R6: a no-gates run records the vacuous check ----------
  {
    const { repo, git } = makeRepo('r6-vacuous', { 'README.md': 'vacuous baseline sandbox\n' })
    const specPath = join(sandbox, 'r6-vacuous', 'spec.json')
    writeFileSync(specPath, JSON.stringify({
      phases: [{ id: 'main', dependencies: [], completion: 'all' }],
      jobs: [{ id: 'j1', phase: 'main', dependencies: [], brief: 'write a feature file', worker: 'machine', command: WORKER_CMD }],
    }, null, 2))
    const runRoot = join(sandbox, 'r6-vacuous', 'runs')
    const r = runCli(['--repo', repo, '--jobs', specPath, '--no-review', '--clean',
      '--run-root', runRoot, '--db', join(sandbox, 'r6-vacuous', 'store.db')], 'vacuous baseline')
    t('R6: a no-gates run proceeds (exit 0) — nothing to verify about the base',
      r.code === 0 && r.out.includes('baseline: no gates on this run'))
    const runDir = theOnlyRunDir(runRoot)
    t('R6: one run dir', runDir !== null)
    if (runDir === null) return
    const rec = JSON.parse(readFileSync(join(runDir, 'baseline-check.json'), 'utf8'))
    t('R6: the vacuous record — no lease taken, empty gates, outcome green honestly recorded',
      rec.lease === null && eq(rec.gates, []) && rec.outcome === 'green' && rec.overridden === false)
    t('R6: no worktree was ever leased for the vacuous check and no swarm/wt--baseline branch exists (--clean leaves the candidate branch; the baseline never created one)',
      worktreeCount(git) === 1 && !swarmBranches(git).includes('swarm/wt--baseline'))
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
      console.error(`\ncheck-baseline-gate: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-baseline-gate: ALL GREEN')
  })
