// Probe-layer self-check (Gate 1.15, fast tier, T-015; extended in place by
// T-018 — the benchmark probe) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-probe.mjs
// Three legs, zero model tokens (the tickets' Verification sections):
//   1. contract fixtures — the EvidenceBundle validator's accept/refuse faces
//      and parseJobsSpec's probes wiring, including the benchmark `repeats`
//      validation (the Gate 0.5 hand-built-input pattern: no pipeline, no
//      subprocess),
//   2. direct token-free CommandProbe/TestProbe/BenchmarkProbe executions
//      against a fresh demo-target fixture (scripts/demo-target.mjs, Gate 1)
//      and temp TAP fixtures in the verify sandbox — real list-form spawns,
//      real process-table assertions on the timeout tree kill (the Gate 1.12
//      style), and for the benchmark probe the quantitative measurement
//      invariants (exactly N run-* durations, nearest-rank min/median/p95
//      recomputed in this check and compared exactly, the 'report'-kind
//      results artifact),
//   3. a token-free end-to-end --jobs drive of runSkeleton with a FAKE
//      WorkerAdapter and fake gates (the Gate 1.8/1.10 pattern,
//      scripts/check-scheduler.mjs) against throwaway fixture repos,
//      asserting the emitted bundle files, validator-clean contents, correct
//      success values, the probes[] <-> bundlePath correspondence, and that
//      survival is untouched by probe outcomes (a passing-gates/failing-probe
//      job still passes; a failing-gates/passing-probe job still fails).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProbe, evidenceBundlePath, parseTapSummary, validateEvidenceBundle } from '../src/probe.ts'
import { parseJobsSpec } from '../src/scheduler.ts'
import { runSkeleton } from '../src/runner.ts'
import { WorktreeProvider } from '../src/workspace/worktree.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const read = (p) => readFileSync(p, 'utf8')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-probe'
const fixture = 'C:/swarm/demo-target'
const IDENTITY = ['-c', 'user.name=check-probe', '-c', 'user.email=probe@local']

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
async function untilDead(pid, timeoutMs = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (!isAlive(pid)) return true
    await sleep(100)
  }
  return !isAlive(pid)
}
/** Best-effort sweep of a planted tree (AGENTS.md #10 mechanized for this
 *  check's own spawns) — only reached when a kill assertion already failed. */
function sweep(pid) {
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    // Already dead — fine.
  }
}

// A direct-execution workspace: the Probe seam binds the repo's
// WorkspaceLease shape (src/types.ts); a direct call needs no git.
const directLease = (path) => ({ id: 'wt/direct', path, branch: 'main', baseSha: '(direct)' })
const directEnv = (artifactsDir) => ({ artifactsDir, candidateId: 'direct' })

// Run a scenario directly, exactly the way the runner does: one ScenarioSpec
// object, handed to both the factory and run() (src/runner.ts passes
// `scenario: probe.scenario` — the harness must not diverge from that).
async function runDirect(scenario, ws, env) {
  const probe = createProbe(scenario)
  return probe.run({ workspace: ws, scenario: probe.scenario, environment: env })
}

// A fake WorkerAdapter (src/types.ts seam) — the Gate 1.8/1.10 pattern:
// writes a marker file (non-zero diff) and succeeds, no model involvement.
function fakeWorker() {
  const calls = []
  return {
    id: 'fake',
    calls,
    async execute(req) {
      calls.push({ cwd: req.cwd })
      try {
        writeFileSync(join(req.cwd, 'marker.txt'), `fake change ${calls.length}\n`)
      } catch {
        // Never break a run on side evidence.
      }
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: 'fake response' }
    },
  }
}

// A fake Gate (src/types.ts seam): deterministic verdict, no subprocess.
const passGate = { name: 'always-pass', run: async () => ({ name: 'always-pass', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok' }) }
const failGate = { name: 'always-fail', run: async () => ({ name: 'always-fail', passed: false, exitCode: 1, durationMs: 1, outputTail: 'deliberate failure' }) }

// One throwaway fixture repo per scenario (fresh branch namespace, list-form
// git only), carrying the probe targets a job's probes run against.
function makeRepo(name) {
  const repo = join(sandbox, name, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => run('git', ['-C', repo, ...args])
  git('init', '-b', 'main')
  writeFileSync(join(repo, 'build.js'), "console.log('build ok')\n")
  // Exit 0 with a failing TAP record — the probe failure is purely in the
  // parsed report, independent of the exit code.
  writeFileSync(join(repo, 'tap-pass.js'), [
    "console.log('TAP version 13')",
    "console.log('ok 1 - first')",
    "console.log('ok 2 - second')",
    "console.log('# tests 2')",
    "console.log('# pass 2')",
    "console.log('# fail 0')",
  ].join('\n') + '\n')
  writeFileSync(join(repo, 'tap-fail.js'), [
    "console.log('TAP version 13')",
    "console.log('ok 1 - first')",
    "console.log('not ok 2 - second')",
    "console.log('# tests 2')",
    "console.log('# pass 1')",
    "console.log('# fail 1')",
  ].join('\n') + '\n')
  git(...IDENTITY, 'add', '-A')
  git(...IDENTITY, 'commit', '-m', 'baseline')
  return { repo, baseSha: git('rev-parse', 'HEAD').trim() }
}

// Resolve a raw spec exactly the way src/cli.ts does (parseJobsSpec, then
// bind one worker/gate set behind the ResolvedJob seam, probes included).
function buildScheduled(raw, { worker, gates }) {
  const spec = parseJobsSpec(raw)
  return {
    phases: spec.phases,
    jobs: spec.jobs.map((j) => ({
      id: j.id,
      phaseId: j.phase,
      dependencies: j.dependencies,
      brief: j.brief,
      model: 'fake/model',
      worker,
      timeoutMs: j.timeoutMs ?? 10_000,
      gates: j.gates ?? gates ?? [],
      ...(j.probes !== undefined ? { probes: j.probes.map(createProbe) } : {}),
    })),
  }
}

async function drive(name, { repo, baseSha, scheduled, candidateIds = ['c01'], worker, gates = [passGate], concurrency }) {
  const artifactsDir = join(sandbox, name, 'run')
  const report = await runSkeleton({
    runId: name,
    repo,
    baseSha,
    goal: 'write the marker file',
    model: 'fake/model',
    plannerModel: null,
    reviewerModel: null,
    candidateIds,
    concurrency: concurrency ?? (scheduled ? scheduled.jobs.length : candidateIds.length),
    timeoutMs: 10_000,
    maxAttempts: 1,
    gates,
    worker,
    workspaces: new WorktreeProvider(repo, artifactsDir),
    artifactsDir,
    cleanWorkspaces: false,
    scheduled,
  })
  return { report, artifactsDir }
}

// The probes[] <-> bundlePath correspondence pin: every summary names a file
// that exists, parses, passes the validator, and agrees with the summary.
function assertBundleCorrespondence(label, report, artifactsDir) {
  let allOk = true
  for (const c of report.candidates) {
    for (const s of c.probes ?? []) {
      const diskPath = evidenceBundlePath(artifactsDir, c.id, s.probeId)
      let bundle = null
      try {
        bundle = validateEvidenceBundle(JSON.parse(read(s.bundlePath)))
      } catch {
        allOk = false
      }
      const agree = bundle !== null
        && s.bundlePath === diskPath
        && bundle.probeId === s.probeId
        && bundle.scenarioId === s.scenarioId
        && bundle.success === s.success
      if (!agree) allOk = false
    }
  }
  t(label, allOk)
}

async function main() {
  // ---------- P1: the EvidenceBundle validator (contract fixtures) ----------
  {
    const wellFormed = {
      probeId: 'build-check',
      scenarioId: 'build-check',
      success: true,
      artifacts: [{ name: 'build-check.log', path: 'C:/swarm/run/probes/c01/build-check.log', kind: 'log', sizeBytes: 12 }],
      measurements: [{ name: 'tests', value: 2 }, { name: 'pass', value: 2, unit: 'count' }],
      gateResults: [{ name: 'build-check', passed: true, exitCode: 0, durationMs: 9, outputTail: 'build ok' }],
    }
    t('P1: a well-formed EvidenceBundle is accepted',
      validateEvidenceBundle(JSON.parse(JSON.stringify(wellFormed))).success === true)
    t('P1: cleanupFailures ride a GateResult entry when present',
      validateEvidenceBundle({
        ...wellFormed,
        gateResults: [{ ...wellFormed.gateResults[0], cleanupFailures: ['CLEANUP FAIL: pid 1 survived taskkill /T /F'] }],
      }).gateResults[0]?.cleanupFailures?.length === 1)
    const refusesWith = (mutate, needle) => {
      const raw = JSON.parse(JSON.stringify(wellFormed))
      mutate(raw)
      try {
        validateEvidenceBundle(raw)
        return false
      } catch (e) {
        return e instanceof Error && e.message.includes('evidence bundle refused') && e.message.includes(needle)
      }
    }
    t('P1: missing probeId is refused',
      refusesWith((r) => { delete r.probeId }, 'probeId'))
    t('P1: missing scenarioId is refused',
      refusesWith((r) => { delete r.scenarioId }, 'scenarioId'))
    t('P1: non-boolean success is refused',
      refusesWith((r) => { r.success = 'yes' }, 'success must be a boolean'))
    t('P1: non-array artifacts is refused',
      refusesWith((r) => { r.artifacts = {} }, 'artifacts must be an array'))
    t('P1: non-array measurements is refused',
      refusesWith((r) => { r.measurements = 'nope' }, 'measurements must be an array'))
    t('P1: non-array gateResults is refused',
      refusesWith((r) => { delete r.gateResults }, 'gateResults must be an array'))
    t('P1: malformed entries are refused (artifact kind, measurement value, gateResult passed)',
      refusesWith((r) => { r.artifacts[0].kind = 'blob' }, 'kind must be "log" or "report"')
      && refusesWith((r) => { r.measurements[0].value = 'two' }, 'value must be a finite number')
      && refusesWith((r) => { r.gateResults[0].passed = 1 }, 'passed must be a boolean'))
    t('P1: a non-object bundle is refused',
      (() => {
        try {
          validateEvidenceBundle([wellFormed])
          return false
        } catch (e) {
          return e.message.includes('must be a JSON object')
        }
      })())
  }

  // ---------- P2: parseJobsSpec probes wiring (contract fixtures) ----------
  {
    const spec = parseJobsSpec({
      phases: [{ id: 'p' }],
      jobs: [
        { id: 'j1', phase: 'p', brief: 'b', probes: [
          { id: 'build-check', type: 'command', command: { exe: 'node', args: ['build.js'] } },
          { id: 'tap-check', type: 'test', command: { exe: 'node', args: ['test.js'] }, timeoutMs: 1234 },
        ] },
        { id: 'j2', phase: 'p', brief: 'b2' },
      ],
    })
    t('P2: a well-formed probes array validates and is preserved verbatim',
      eq(spec.jobs[0]?.probes, [
        { id: 'build-check', type: 'command', command: { exe: 'node', args: ['build.js'] } },
        { id: 'tap-check', type: 'test', command: { exe: 'node', args: ['test.js'] }, timeoutMs: 1234 },
      ]))
    t('P2: a spec without probes parses to output identical to today (byte-identical JSON)',
      JSON.stringify(parseJobsSpec({ phases: [{ id: 'p' }], jobs: [{ id: 'j1', phase: 'p', brief: 'b', gates: [{ name: 'g', command: 'node build.js' }] }] }))
      === '{"phases":[{"id":"p","dependencies":[],"completion":"all"}],"jobs":[{"id":"j1","phase":"p","dependencies":[],"brief":"b","gates":[{"name":"g","command":"node build.js"}]}]}')
    const throwsWith = (raw, needle) => {
      try {
        parseJobsSpec(raw)
        return false
      } catch (e) {
        return e instanceof Error && e.message.includes(needle)
      }
    }
    const base = (probes) => ({ phases: [{ id: 'p' }], jobs: [{ id: 'j1', phase: 'p', brief: 'b', probes }] })
    // T-018 flip (recorded in the ticket as the change-set's one intentional
    // invalidation of an existing assertion): Gate 1.15's P2 leg actively
    // pinned `type: 'benchmark'` as refused ("type must be \"command\" or
    // \"test\""). The benchmark probe now EXISTS, so the pin becomes positive
    // coverage (a benchmark probe with repeats parses and is preserved
    // verbatim) plus refusal of a genuinely-unknown type with the updated
    // message — one refusal becomes positive-coverage-plus-refusal, net
    // strictness increases (the T-013 flip precedent). No other existing
    // assertion is weakened.
    t('P2: a benchmark probe with repeats validates and is preserved verbatim (the T-018 flip: benchmark moved from refused type to pinned type)',
      eq(parseJobsSpec({
        phases: [{ id: 'p' }],
        jobs: [{ id: 'j1', phase: 'p', brief: 'b', probes: [
          { id: 'bench-check', type: 'benchmark', command: { exe: 'node', args: ['bench.js'] }, repeats: 5 },
        ] }],
      }).jobs[0]?.probes, [
        { id: 'bench-check', type: 'benchmark', command: { exe: 'node', args: ['bench.js'] }, repeats: 5 },
      ]))
    t('P2: a genuinely-unknown probe type is refused with the updated message',
      throwsWith(base([{ id: 'x', type: 'screenshot', command: { exe: 'node', args: [] } }]), 'type must be "command", "test", or "benchmark"'))
    t('P2: repeats validation on a benchmark probe — missing, 0, negative, non-integer, non-number all refused naming the offense',
      throwsWith(base([{ id: 'x', type: 'benchmark', command: { exe: 'node', args: [] } }]), 'repeats must be a positive integer >= 1')
      && throwsWith(base([{ id: 'x', type: 'benchmark', command: { exe: 'node', args: [] }, repeats: 0 }]), 'repeats must be a positive integer >= 1')
      && throwsWith(base([{ id: 'x', type: 'benchmark', command: { exe: 'node', args: [] }, repeats: -1 }]), 'repeats must be a positive integer >= 1')
      && throwsWith(base([{ id: 'x', type: 'benchmark', command: { exe: 'node', args: [] }, repeats: 1.5 }]), 'repeats must be a positive integer >= 1')
      && throwsWith(base([{ id: 'x', type: 'benchmark', command: { exe: 'node', args: [] }, repeats: 'three' }]), 'repeats must be a positive integer >= 1'))
    t('P2: repeats on a command/test probe is refused — the field exists only where it means something',
      throwsWith(base([{ id: 'x', type: 'command', command: { exe: 'node', args: [] }, repeats: 3 }]), 'repeats is only valid on a benchmark probe')
      && throwsWith(base([{ id: 'x', type: 'test', command: { exe: 'node', args: [] }, repeats: 3 }]), 'repeats is only valid on a benchmark probe'))
    t('P2: malformed probe entries are refused (non-object, probes non-array, missing exe, non-string args, bad timeoutMs)',
      throwsWith(base(['nope']), 'must be an object')
      && throwsWith(base('nope'), 'probes must be an array')
      && throwsWith(base([{ id: 'x', type: 'command', command: { args: [] } }]), 'exe must be a non-empty string')
      && throwsWith(base([{ id: 'x', type: 'command', command: { exe: 'node', args: [1] } }]), 'args must be an array of strings')
      && throwsWith(base([{ id: 'x', type: 'command', command: { exe: 'node', args: [] }, timeoutMs: 0 }]), 'timeoutMs must be a positive integer'))
    t('P2: duplicate probe ids per job and bad probe id charset are refused',
      throwsWith(base([
        { id: 'x', type: 'command', command: { exe: 'node', args: [] } },
        { id: 'x', type: 'command', command: { exe: 'node', args: [] } },
      ]), "duplicate probe id 'x'")
      && throwsWith(base([{ id: '../escape', type: 'command', command: { exe: 'node', args: [] } }]), 'does not match [a-z0-9][a-z0-9-]*'))
    t('P2: unknown fields inside a probe are refused, naming the field (the T-009 posture)',
      throwsWith(base([{ id: 'x', type: 'command', command: { exe: 'node', args: [] }, scenarioFile: 's.json' }]), "unknown field 'scenarioFile'")
      && throwsWith(base([{ id: 'x', type: 'command', command: { exe: 'node', args: [], cwd: '.' } }]), "unknown field 'cwd'"))
  }

  // ---------- P3: CommandProbe real executions against a fresh demo fixture ----------
  {
    // A fresh demo-target fixture (scripts/demo-target.mjs, Gate 1's own
    // generator) — the ticket's pinned probe target: a working node repo
    // with build.js/test.js.
    run(process.execPath, [join(root, 'scripts', 'demo-target.mjs'), fixture.replace(/\//g, '\\')])
    const artifactsDir = join(sandbox, 'direct', 'artifacts')
    const env = directEnv(artifactsDir)
    const ws = directLease(fixture)

    const happyBundle = await runDirect({ id: 'build-check', type: 'command', command: { exe: 'node', args: ['build.js'] } }, ws, env)
    const logRef = happyBundle.artifacts[0]
    t('P3: CommandProbe happy path — success true, exitCode 0, exactly one GateResult entry, no measurements this slice',
      happyBundle.success === true && happyBundle.gateResults.length === 1 && happyBundle.gateResults[0]?.exitCode === 0
      && happyBundle.gateResults[0]?.passed === true && happyBundle.measurements.length === 0)
    t('P3: the full output is a .log artifact at <artifactsDir>/probes/<candidateId>/<probeId>.log, referenced with sizeBytes > 0',
      logRef !== undefined && logRef.kind === 'log' && logRef.sizeBytes > 0
      && logRef.path === join(artifactsDir, 'probes', 'direct', 'build-check.log')
      && existsSync(logRef.path))
    t('P3: the bundle passes the validator',
      validateEvidenceBundle(JSON.parse(JSON.stringify(happyBundle))).success === true)
    t('P3: the .log file carries the probe output ("build ok") and the GateResult tail captured it',
      logRef !== undefined && read(logRef.path).includes('build ok')
      && happyBundle.gateResults[0]?.outputTail.includes('build ok'))

    const failingScenario = { id: 'fail-check', type: 'command', command: { exe: 'node', args: ['-e', "console.log('boom'); process.exit(3)"] } }
    const failing = await runDirect(failingScenario, ws, env)
    t('P3: a failing command — success false, non-zero exitCode, captured tail, no error field (a clean command failure)',
      failing.success === false && failing.gateResults[0]?.exitCode === 3
      && failing.gateResults[0]?.outputTail.includes('boom') && failing.error === undefined)

    const refusedScenario = { id: 'spawn-refused', type: 'command', command: { exe: 'definitely-not-a-real-exe-4f8a2b', args: [] } }
    const refused = await runDirect(refusedScenario, ws, env)
    t('P3: a non-existent exe — success false with the spawn error recorded in the bundle, never success true',
      refused.success === false && typeof refused.error === 'string' && refused.error.length > 0
      && refused.gateResults[0]?.passed === false && refused.gateResults[0]?.exitCode === null
      && refused.gateResults[0]?.outputTail.length > 0)

    // T-018: the benchmark probe — quantitative measurements with
    // nearest-rank summaries, pinned against the same fresh fixture.
    const bench = await runDirect({ id: 'bench-check', type: 'benchmark', command: { exe: 'node', args: ['build.js'] }, repeats: 5 }, ws, env)
    const runDurations = bench.measurements.filter((m) => /^run-\d+ duration$/.test(m.name))
    const summaryOf = Object.fromEntries(bench.measurements
      .filter((m) => m.name === 'min' || m.name === 'median' || m.name === 'p95')
      .map((m) => [m.name, m.value]))
    const recorded = runDurations.map((m) => m.value)
    const sorted = [...recorded].sort((a, b) => a - b)
    const nearest = (q) => sorted[Math.ceil(q * sorted.length) - 1]
    t('P3: BenchmarkProbe happy path — success true, exactly 5 run-* duration measurements + min/median/p95, every measurement unit ms',
      bench.success === true
      && runDurations.length === 5 && bench.measurements.length === 8
      && runDurations.every((m, i) => m.name === `run-${i + 1} duration`)
      && bench.measurements.every((m) => m.unit === 'ms')
      && 'min' in summaryOf && 'median' in summaryOf && 'p95' in summaryOf)
    t('P3: benchmark durations — min <= median <= p95; one GateResult entry per repeat, in run order, self-named <probeId>#run-<i>, each equal to its run duration',
      summaryOf.min <= summaryOf.median && summaryOf.median <= summaryOf.p95
      && bench.gateResults.length === 5
      && bench.gateResults.every((g, i) => g.name === `bench-check#run-${i + 1}`)
      && bench.gateResults.every((g, i) => g.durationMs === runDurations[i]?.value)
      && bench.gateResults.every((g) => g.passed === true && g.exitCode === 0))
    t('P3: benchmark summaries exactly equal the nearest-rank recomputation over the recorded durations (sorted[ceil(q*n)-1], no interpolation)',
      summaryOf.min === sorted[0]
      && summaryOf.median === nearest(0.5)
      && summaryOf.p95 === nearest(0.95))
    const resultsRef = bench.artifacts.find((a) => a.kind === 'report')
    const results = resultsRef !== undefined && existsSync(resultsRef.path)
      ? JSON.parse(read(resultsRef.path))
      : null
    t('P3: the report-kind results artifact — bench-check.results.json beside the bundle, sizeBytes > 0, parses, carries the 5 durations + nearest-rank summaries',
      resultsRef !== undefined && resultsRef.kind === 'report' && resultsRef.sizeBytes > 0
      && resultsRef.name === 'bench-check.results.json'
      && resultsRef.path === join(artifactsDir, 'probes', 'direct', 'bench-check.results.json')
      && eq(results, {
        probeId: 'bench-check', scenarioId: 'bench-check', repeats: 5,
        durationsMs: recorded, minMs: summaryOf.min, medianMs: summaryOf.median, p95Ms: summaryOf.p95,
      }))
    t('P3: the benchmark bundle passes the validator and its combined .log carries the === run <i> === separators',
      validateEvidenceBundle(JSON.parse(JSON.stringify(bench))).success === true
      && bench.artifacts[0]?.kind === 'log' && bench.artifacts[0]?.sizeBytes > 0
      && read(bench.artifacts[0]?.path).includes('=== run 1 ===')
      && read(bench.artifacts[0]?.path).includes('=== run 5 ==='))

    const benchFail = await runDirect({ id: 'bench-fail', type: 'benchmark', command: { exe: 'node', args: ['-e', "console.log('boom'); process.exit(3)"] }, repeats: 3 }, ws, env)
    const failDurations = benchFail.measurements.filter((m) => /^run-\d+ duration$/.test(m.name))
    t('P3: benchmark failure face — non-zero exit (repeats 3): success false, error names the FIRST failing run with counts, all 3 durations still recorded',
      benchFail.success === false
      && benchFail.error === 'run 1/3 exited with code 3'
      && failDurations.length === 3
      && benchFail.gateResults.length === 3
      && benchFail.gateResults.every((g) => g.passed === false && g.exitCode === 3)
      && benchFail.gateResults.every((g) => g.outputTail.includes('boom')))

    const benchRefused = await runDirect({ id: 'bench-refused', type: 'benchmark', command: { exe: 'definitely-not-a-real-exe-4f8a2b', args: [] }, repeats: 2 }, ws, env)
    t('P3: benchmark spawn-refusal face — success false with ZERO run-* measurements and zero summaries, never a pass',
      benchRefused.success === false
      && benchRefused.measurements.length === 0
      && benchRefused.gateResults.length === 2
      && benchRefused.gateResults.every((g) => g.passed === false && g.exitCode === null)
      && typeof benchRefused.error === 'string'
      && benchRefused.error.startsWith('run 1/2 could not be spawned: ')
      && benchRefused.error.length > 'run 1/2 could not be spawned: '.length)
  }

  // ---------- P4: TestProbe TAP contract on temp TAP fixtures ----------
  {
    const tapFx = join(sandbox, 'tap-fx')
    mkdirSync(tapFx, { recursive: true })
    const artifactsDir = join(sandbox, 'tap-fx', 'artifacts')
    const writeTap = (name, lines) => writeFileSync(join(tapFx, name), lines.join('\n') + '\n')
    const env = directEnv(artifactsDir)
    const ws = directLease(tapFx)
    const measurementsOf = (bundle) => Object.fromEntries(bundle.measurements.map((m) => [m.name, m.value]))

    // node --test emits TAP with summary lines (zero new deps).
    writeFileSync(join(tapFx, 'node-test-pass.js'), [
      "const { test } = require('node:test')",
      "const assert = require('node:assert')",
      "test('adds', () => { assert.equal(1 + 1, 2) })",
      "test('subs', () => { assert.equal(2 - 1, 1) })",
    ].join('\n') + '\n')
    const passing = await runDirect({ id: 'tap-pass', type: 'test', command: { exe: 'node', args: ['node-test-pass.js'] } }, ws, env)
    const pm = measurementsOf(passing)
    t('P4: all-pass TAP (node --test) — success true, tests/pass/fail measurements with pass == tests, fail 0',
      passing.success === true && passing.measurements.length === 3
      && pm.tests === 2 && pm.pass === 2 && pm.fail === 0 && pm.pass === pm.tests
      && passing.gateResults[0]?.passed === true)

    // Counted ok/not ok fallback (no summary lines present).
    writeTap('counted-pass.tap.js', ['console.log("ok 1 - a")', 'console.log("ok 2 - b")', 'console.log("ok 3 - c")'])
    const counted = await runDirect({ id: 'tap-counted', type: 'test', command: { exe: 'node', args: ['counted-pass.tap.js'] } }, ws, env)
    const cm = measurementsOf(counted)
    t('P4: counted ok/not ok lines when no summary lines are present (tests = ok + not ok)',
      counted.success === true && cm.tests === 3 && cm.pass === 3 && cm.fail === 0)

    // Any `not ok` -> success false, fail >= 1 (exit 0, failure is in the parsed report).
    writeTap('not-ok.tap.js', ['console.log("ok 1 - a")', 'console.log("not ok 2 - b")'])
    const notOk = await runDirect({ id: 'tap-notok', type: 'test', command: { exe: 'node', args: ['not-ok.tap.js'] } }, ws, env)
    const nm = measurementsOf(notOk)
    t('P4: any `not ok` — success false with fail >= 1 even when the command exits 0',
      notOk.success === false && nm.fail === 1 && notOk.gateResults[0]?.exitCode === 0
      && typeof notOk.error === 'string' && notOk.error.includes('fail'))

    // Summary lines win when present (node --test with a failing test).
    writeFileSync(join(tapFx, 'node-test-fail.js'), [
      "const { test } = require('node:test')",
      "const assert = require('node:assert')",
      "test('breaks', () => { assert.equal(1 + 1, 3) })",
    ].join('\n') + '\n')
    const nodeFail = await runDirect({ id: 'tap-nodefail', type: 'test', command: { exe: 'node', args: ['node-test-fail.js'] } }, ws, env)
    const fm = measurementsOf(nodeFail)
    t('P4: a failing node --test — success false, TAP summary numbers (tests 1, pass 0, fail 1)',
      nodeFail.success === false && fm.tests === 1 && fm.pass === 0 && fm.fail === 1)

    // Exit 0 with unparseable output -> success false (parsed-nothing is never a pass).
    writeTap('plain.tap.js', ['console.log("hello, no TAP here")'])
    const unparseable = await runDirect({ id: 'tap-plain', type: 'test', command: { exe: 'node', args: ['plain.tap.js'] } }, ws, env)
    t('P4: exit 0 with unparseable output — success false, empty measurements, error recorded (parsed-nothing is not a pass)',
      unparseable.success === false && unparseable.measurements.length === 0
      && unparseable.gateResults[0]?.exitCode === 0
      && typeof unparseable.error === 'string' && unparseable.error.includes('unparseable'))
    t('P4: parseTapSummary agrees with the probe on the three faces',
      eq(parseTapSummary('TAP version 13\nok 1 - a\nnot ok 2 - b\n'), { tests: 2, pass: 1, fail: 1 })
      && eq(parseTapSummary('# tests 4\n# pass 4\n# fail 0\n'), { tests: 4, pass: 4, fail: 0 })
      && parseTapSummary('nothing at all') === null)

    // Timeout -> verified tree kill: the probe's tree (a node parent that
    // spawns a node child) must be dead, with unproven kill outcomes landing
    // on the GateResult's cleanupFailures (verified kills leave it absent).
    writeFileSync(join(tapFx, 'sleeper.js'), [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })",
      "console.log('PARENT_PID=' + process.pid)",
      "console.log('CHILD_PID=' + child.pid)",
      'setInterval(() => {}, 1000)',
    ].join('\n') + '\n')
    const timeoutMs = 1200
    const timedOut = await runDirect({ id: 'tap-slow', type: 'test', command: { exe: 'node', args: ['sleeper.js'] }, timeoutMs }, ws, env)
    const logPath = timedOut.artifacts[0]?.path
    const pids = (logPath !== undefined && existsSync(logPath))
      ? [...read(logPath).matchAll(/(?:PARENT|CHILD)_PID=(\d+)/g)].map((m) => Number(m[1]))
      : []
    const parentDead = pids[0] !== undefined && await untilDead(pids[0])
    const childDead = pids[1] !== undefined && await untilDead(pids[1])
    if (pids[0] !== undefined && !parentDead) sweep(pids[0])
    if (pids[1] !== undefined && !childDead) sweep(pids[1])
    t('P4: timeout — success false, exitCode null, durationMs >= timeoutMs',
      timedOut.success === false && timedOut.gateResults[0]?.exitCode === null
      && timedOut.gateResults[0]?.durationMs >= timeoutMs)
    t('P4: timeout — the whole spawned tree is verified dead on the real process table',
      pids.length === 2 && parentDead && childDead)
    t('P4: timeout — kill evidence is on the GateResult: a verified kill leaves cleanupFailures absent, an unproven one records loud CLEANUP FAIL lines',
      timedOut.gateResults[0]?.cleanupFailures === undefined
      || (Array.isArray(timedOut.gateResults[0]?.cleanupFailures) && timedOut.gateResults[0]?.cleanupFailures.every((l) => l.startsWith('CLEANUP FAIL'))))

    // T-018: the benchmark timeout face — the same sleeper tree, one repeat
    // (repeats: 1 is valid; the repeat that times out still RAN, so its
    // duration is recorded even though success is false).
    const benchTimeoutMs = 1200
    const benchTimedOut = await runDirect({ id: 'bench-slow', type: 'benchmark', command: { exe: 'node', args: ['sleeper.js'] }, repeats: 1, timeoutMs: benchTimeoutMs }, ws, env)
    const benchLog = benchTimedOut.artifacts.find((a) => a.kind === 'log')
    const benchPids = (benchLog !== undefined && existsSync(benchLog.path))
      ? [...read(benchLog.path).matchAll(/(?:PARENT|CHILD)_PID=(\d+)/g)].map((m) => Number(m[1]))
      : []
    const benchParentDead = benchPids[0] !== undefined && await untilDead(benchPids[0])
    const benchChildDead = benchPids[1] !== undefined && await untilDead(benchPids[1])
    if (benchPids[0] !== undefined && !benchParentDead) sweep(benchPids[0])
    if (benchPids[1] !== undefined && !benchChildDead) sweep(benchPids[1])
    t('P4: benchmark timeout — success false, error names the timing-out run, the repeat exitCode null with durationMs >= timeoutMs and its duration still recorded',
      benchTimedOut.success === false
      && typeof benchTimedOut.error === 'string' && benchTimedOut.error.includes('run 1/1 timed out')
      && benchTimedOut.gateResults.length === 1
      && benchTimedOut.gateResults[0]?.name === 'bench-slow#run-1'
      && benchTimedOut.gateResults[0]?.exitCode === null
      && benchTimedOut.gateResults[0]?.durationMs >= benchTimeoutMs
      && benchTimedOut.measurements.filter((m) => /^run-\d+ duration$/.test(m.name)).length === 1
      && benchTimedOut.measurements.every((m) => m.value >= benchTimeoutMs))
    t('P4: benchmark timeout — the whole spawned tree is verified dead on the real process table',
      benchPids.length === 2 && benchParentDead && benchChildDead)
    t('P4: benchmark timeout — kill evidence is on that repeat\'s GateResult entry: a verified kill leaves cleanupFailures absent, an unproven one records loud CLEANUP FAIL lines',
      benchTimedOut.gateResults[0]?.cleanupFailures === undefined
      || (Array.isArray(benchTimedOut.gateResults[0]?.cleanupFailures) && benchTimedOut.gateResults[0]?.cleanupFailures.every((l) => l.startsWith('CLEANUP FAIL'))))
  }

  // ---------- P5: evidence emission in a real pipeline (--jobs drives) ----------
  {
    // Scenario A: passing gates; one job with a PASSING and a FAILING probe
    // plus a PASSING benchmark probe (T-018); its sibling job carries a
    // FAILING benchmark — survival must stay untouched by benchmark outcomes.
    const a = makeRepo('e2e')
    const specA = {
      phases: [{ id: 'p' }],
      jobs: [
        {
          id: 'job-a', phase: 'p', brief: 'do A',
          probes: [
            { id: 'build-check', type: 'command', command: { exe: 'node', args: ['build.js'] } },
            { id: 'tap-fail-check', type: 'test', command: { exe: 'node', args: ['tap-fail.js'] } },
            { id: 'bench-check', type: 'benchmark', command: { exe: 'node', args: ['build.js'] }, repeats: 2 },
          ],
        },
        {
          id: 'job-b', phase: 'p', brief: 'do B',
          probes: [
            { id: 'tap-pass-check', type: 'test', command: { exe: 'node', args: ['tap-pass.js'] } },
            { id: 'bench-fail-check', type: 'benchmark', command: { exe: 'node', args: ['-e', "console.log('slow-boom'); process.exit(9)"] }, repeats: 1 },
          ],
        },
      ],
    }
    const workerA = fakeWorker()
    const rA = await drive('e2e-run', { repo: a.repo, baseSha: a.baseSha, scheduled: buildScheduled(specA, { worker: workerA, gates: [passGate] }), worker: workerA })
    const cA = rA.report.candidates.find((c) => c.id === 'job-a')
    const cB = rA.report.candidates.find((c) => c.id === 'job-b')
    t('P5: a passing-gates/failing-probe job still PASSES — probe results never enter a verdict',
      cA?.passedAllGates === true && cA?.gates.every((g) => g.passed) === true && cA?.probes?.length === 3)
    t('P5: the report carries per-probe summaries {probeId, scenarioId, success, durationMs, bundlePath} in spec order (benchmark included, T-018)',
      eq(cA?.probes?.map((p) => [p.probeId, p.scenarioId, p.success]),
        [['build-check', 'build-check', true], ['tap-fail-check', 'tap-fail-check', false], ['bench-check', 'bench-check', true]])
      && typeof cA?.probes?.[0]?.durationMs === 'number'
      && typeof cA?.probes?.[1]?.durationMs === 'number'
      && typeof cA?.probes?.[2]?.durationMs === 'number')
    assertBundleCorrespondence('P5: every probes[] entry names an on-disk bundle that parses, passes the validator, and agrees with the summary (probes[] <-> bundlePath)', rA.report, rA.artifactsDir)
    const bundleA1 = JSON.parse(read(join(rA.artifactsDir, 'probes', 'job-a', 'build-check.json')))
    const bundleA2 = JSON.parse(read(join(rA.artifactsDir, 'probes', 'job-a', 'tap-fail-check.json')))
    const bundleB = JSON.parse(read(join(rA.artifactsDir, 'probes', 'job-b', 'tap-pass-check.json')))
    t('P5: bundle files exist at <artifactsDir>/probes/<candidateId>/<probeId>.json with correct success values',
      bundleA1.success === true && bundleA2.success === false && bundleB.success === true)
    t('P5: the command-probe bundle records one GateResult (exit 0) and a non-empty .log artifact',
      bundleA1.gateResults.length === 1 && bundleA1.gateResults[0]?.exitCode === 0
      && bundleA1.artifacts[0]?.sizeBytes > 0 && existsSync(bundleA1.artifacts[0]?.path))
    t('P5: the failing test-probe bundle records the TAP failure (fail 1) with the error named',
      bundleA2.measurements.some((m) => m.name === 'fail' && m.value === 1)
      && typeof bundleA2.error === 'string' && bundleA2.error.length > 0)
    t('P5: the passing test-probe bundle records tests/pass/fail with pass == tests',
      bundleB.measurements.some((m) => m.name === 'pass' && m.value === 2)
      && bundleB.measurements.some((m) => m.name === 'tests' && m.value === 2)
      && bundleB.measurements.some((m) => m.name === 'fail' && m.value === 0))
    t('P5: the on-disk report.json carries the probes[] arrays (the artifact the store and humans read)',
      JSON.parse(read(join(rA.artifactsDir, 'report.json'))).candidates.find((c) => c.id === 'job-a')?.probes?.length === 3)
    t('P5: a passing job with only passing probes records success:true bundles',
      cB?.passedAllGates === true && cB?.probes?.length === 2 && cB?.probes?.[0]?.success === true)

    // T-018: the benchmark probe in a real pipeline — bundle correspondence,
    // validator-clean contents, the report artifact, and survival untouched.
    const benchBundleA = JSON.parse(read(join(rA.artifactsDir, 'probes', 'job-a', 'bench-check.json')))
    const benchReportA = benchBundleA.artifacts?.find((a2) => a2.kind === 'report')
    t('P5: the benchmark bundle is validator-clean, carries its 2 run durations + min/median/p95, and its report-kind artifact is real on disk',
      validateEvidenceBundle(benchBundleA).success === true
      && benchBundleA.measurements.filter((m) => /^run-\d+ duration$/.test(m.name)).length === 2
      && ['min', 'median', 'p95'].every((n) => benchBundleA.measurements.some((m) => m.name === n && m.unit === 'ms'))
      && benchBundleA.gateResults.length === 2
      && benchBundleA.gateResults.every((g, i) => g.name === `bench-check#run-${i + 1}`)
      && benchReportA !== undefined && benchReportA.sizeBytes > 0 && existsSync(benchReportA.path)
      && eq(JSON.parse(read(benchReportA.path)), {
        probeId: 'bench-check', scenarioId: 'bench-check', repeats: 2,
        durationsMs: benchBundleA.measurements.filter((m) => /^run-\d+ duration$/.test(m.name)).map((m) => m.value),
        minMs: benchBundleA.measurements.find((m) => m.name === 'min')?.value,
        medianMs: benchBundleA.measurements.find((m) => m.name === 'median')?.value,
        p95Ms: benchBundleA.measurements.find((m) => m.name === 'p95')?.value,
      }))
    const benchFailBundleB = JSON.parse(read(join(rA.artifactsDir, 'probes', 'job-b', 'bench-fail-check.json')))
    t('P5: a passing-gates/FAILING-benchmark job still PASSES — the benchmark outcome never enters a verdict',
      cB?.passedAllGates === true && cB?.probes?.[1]?.success === false
      && validateEvidenceBundle(benchFailBundleB).success === false
      && benchFailBundleB.error === 'run 1/1 exited with code 9'
      && benchFailBundleB.measurements.filter((m) => /^run-\d+ duration$/.test(m.name)).length === 1)

    // Scenario B: a FAILING gate; its probes must still run and record
    // (evidence about failures is evidence).
    const b = makeRepo('e2e-gatefail')
    const specB = {
      phases: [{ id: 'p' }],
      jobs: [{
        id: 'job-g', phase: 'p', brief: 'do G',
        probes: [{ id: 'build-check', type: 'command', command: { exe: 'node', args: ['build.js'] } }],
      }],
    }
    const workerB = fakeWorker()
    const rB = await drive('e2e-gatefail-run', { repo: b.repo, baseSha: b.baseSha, scheduled: buildScheduled(specB, { worker: workerB, gates: [failGate] }), worker: workerB })
    const cG = rB.report.candidates.find((c) => c.id === 'job-g')
    t('P5: a failing-gates/passing-probe job still FAILS — probes ran regardless of gate outcomes',
      cG?.passedAllGates === false && cG?.gates[0]?.passed === false
      && cG?.probes?.length === 1 && cG?.probes?.[0]?.success === true)
    t('P5: the gate-failed candidate\'s bundle is on disk and validator-clean',
      existsSync(join(rB.artifactsDir, 'probes', 'job-g', 'build-check.json'))
      && validateEvidenceBundle(JSON.parse(read(join(rB.artifactsDir, 'probes', 'job-g', 'build-check.json')))).success === true)
    assertBundleCorrespondence('P5: the gate-failed candidate\'s probes[] <-> bundlePath correspondence holds too', rB.report, rB.artifactsDir)

    // Default mode: no probes anywhere — today's report, unchanged.
    const d = makeRepo('e2e-default')
    const workerD = fakeWorker()
    const rD = await drive('e2e-default-run', { repo: d.repo, baseSha: d.baseSha, candidateIds: ['c01'], worker: workerD })
    t('P5: default mode has no probes — the field is absent on every candidate and no probes/ dir is written',
      rD.report.candidates.every((c) => c.probes === undefined)
      && !existsSync(join(rD.artifactsDir, 'probes')))
  }

  rmSync(sandbox, { recursive: true, force: true })
}

main()
  .catch((e) => {
    failures.push(`gate crashed: ${e instanceof Error ? e.message : String(e)}`)
    console.error(e)
  })
  .finally(() => {
    if (failures.length > 0) {
      console.error(`\ncheck-probe: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-probe: ALL GREEN')
  })
