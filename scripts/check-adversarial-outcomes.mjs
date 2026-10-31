// Adversarial expected-outcomes self-check (Gate 1.48, fast tier, T-062 —
// register R16's inversion fix) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-adversarial-outcomes.mjs
// Token-free (zero model calls, the Gate 1.15 pattern), five legs:
//   1. determinism — same seed → byte-identical case list AND byte-identical
//      expectation list (the Gate 1.15 seam, extended); the exact
//      implementation-fixed reject split pinned by index; expectations are a
//      function of the engine-authored corpus alone (identical across
//      seeds, total on non-corpus lists);
//   2. the validating-fixture GREEN pair — the red/green pair's green side:
//      a fixture target that validates argv (exits 1 exactly on the
//      invalid-by-construction corpus inputs) records those cases
//      rejected-as-expected, counts toward survival, and the probe SUCCEEDS
//      when every case met its expectation. The RED side was recorded on
//      main before the change (the same fixture recording crashed-exit /
//      success:false — the red-bar run output is quoted in VERIFICATION.md's
//      Gate 1.48 section and T-062's Landed);
//   3. strictness where exit-0 is the expectation — a generated (soup) case
//      exiting non-zero STILL records crashed-exit and sinks probe success;
//      plus the no-op inversion face (a target that never reads argv:
//      unexpected-exit-0, never survival);
//   4. the T-032 refusal vocabulary stays never-survival — a reject-expected
//      case that times out records crashed-timeout (not rejection), and a
//      spawn refusal stays spawn-refused with zero rejections;
//   5. composer honesty — the round-2 rendered evidence carries
//      rejected-as-expected as validated input handling, never "failed",
//      without laundering a genuinely failed probe (the R16 bad-mouthing
//      seam, src/rounds.ts).
import { killTree } from './kill-tree.mjs'
import { swarmRoot } from './swarm-root.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ADVERSARIAL_PROBE_CASE_COUNT,
  adversarialCaseExpectations,
  createProbe,
  generateAdversarialCases,
} from '../src/probe.ts'
import { composeRoundPacket } from '../src/rounds.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const read = (p) => readFileSync(p, 'utf8')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = swarmRoot + '/verify-adv-outcomes'

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

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
/** Best-effort sweep of a planted process (AGENTS.md #10 mechanized for this
 *  check's own spawns) — only reached when a kill assertion already failed. */
function sweep(pid) {
  try {
    killTree(pid)
  } catch {
    // Already dead — fine.
  }
}

// A direct-execution workspace: the Probe seam binds the repo's
// WorkspaceLease shape (src/types.ts); a direct call needs no git.
const directLease = (path) => ({ id: 'wt/direct', path, branch: 'main', baseSha: '(direct)' })
const directEnv = (artifactsDir) => ({ artifactsDir, candidateId: 'direct' })

// Run a scenario directly, exactly the way the runner does (the Gate 1.15
// runDirect pattern: one ScenarioSpec object, handed to both the factory and
// run()).
async function runDirect(scenario, ws, env) {
  const probe = createProbe(scenario)
  return probe.run({ workspace: ws, scenario: probe.scenario, environment: env })
}

async function main() {
  const fx = join(sandbox, 'fx')
  mkdirSync(fx, { recursive: true })
  const artifacts = join(fx, 'artifacts')
  const env = directEnv(artifacts)
  const ws = directLease(fx)

  // ---------- Leg 1: determinism + the exact authored split ----------
  {
    const a42 = generateAdversarialCases(42)
    const b42 = generateAdversarialCases(42)
    const ea42 = adversarialCaseExpectations(a42)
    const eb42 = adversarialCaseExpectations(b42)
    t('D: same seed → byte-identical case list AND byte-identical expectation list across two runs (the Gate 1.15 seam, extended by T-062)',
      eq(a42, b42) && a42.length === ADVERSARIAL_PROBE_CASE_COUNT
      && eq(ea42, eb42) && ea42.length === ADVERSARIAL_PROBE_CASE_COUNT)
    t('D: expectations are a function of the engine-authored corpus alone — different seeds derive the IDENTICAL expectation list (the corpus prefix seed-independent, the tail uniformly exit-0)',
      [7, 43, 2026, 999331].every((s) => eq(adversarialCaseExpectations(generateAdversarialCases(s)), ea42)))
    // The exact split, fixed at implementation (the ticket's "recorded in
    // the check"): the empty-input edge, the control-character case, and
    // the three malformed-JSON-looking strings expect rejection — corpus
    // indices 0, 1, 9, 10, 11 (1-based cases 1, 2, 10, 11, 12); every other
    // corpus entry and every generated case expects exit-0.
    t('D: the implementation-fixed reject split — exactly corpus entries [0]=empty, [1]=control-chars, [9]="{", [10]="[1,2,", [11]=unterminated-quote expect reject; non-ASCII, numeric edges, soup, and permutations expect exit-0',
      eq(ea42, ['reject', 'reject', 'exit-0', 'exit-0', 'exit-0', 'exit-0', 'exit-0', 'exit-0', 'exit-0', 'reject', 'reject', 'reject',
        'exit-0', 'exit-0', 'exit-0', 'exit-0', 'exit-0', 'exit-0', 'exit-0', 'exit-0'])
      && ea42.filter((e) => e === 'reject').length === 5)
    t('D: totality — a hand-built non-corpus list derives uniformly exit-0 (expectations never inferred from content)',
      eq(adversarialCaseExpectations(['{"a":', '', 'a\tb\nc\x01d', 'made up']), ['exit-0', 'exit-0', 'exit-0', 'exit-0']))
  }

  // ---------- Leg 2: the validating-fixture green pair ----------
  {
    const cases = generateAdversarialCases(42)
    const expectations = adversarialCaseExpectations(cases)
    const rejectInputs = cases.filter((_, i) => expectations[i] === 'reject')
    // The validating fixture (the red-bar script's exact target): a
    // well-behaved CLI that validates argv — exits 1 exactly on the inputs
    // invalid by construction, exits 0 on everything else.
    writeFileSync(join(fx, 'validate.js'), [
      'const arg = process.argv[2] ?? \'\'',
      `const invalid = ${JSON.stringify(rejectInputs)}`,
      'if (invalid.includes(arg)) { console.log(\'rejected invalid input\'); process.exit(1) }',
      'console.log(\'ok: \' + JSON.stringify(arg))',
    ].join('\n') + '\n')
    const bundle = await runDirect({ id: 'adv-validate', type: 'adversarial', command: { exe: process.execPath, args: ['validate.js'] }, seed: 42 }, ws, env)
    const resultsRef = bundle.artifacts.find((a) => a.kind === 'report')
    const table = resultsRef !== undefined && existsSync(resultsRef.path) ? JSON.parse(read(resultsRef.path)) : null
    const rejectIdx = cases.map((c, i) => (expectations[i] === 'reject' ? i + 1 : 0)).filter((i) => i > 0)
    const expectedOutcomes = cases.map((_, i) => (expectations[i] === 'reject' ? 'rejected-as-expected' : 'survived'))
    t('V: the validating fixture SUCCEEDS post-change — success true, error undefined, every case met its expectation (rejections count toward survival)',
      bundle.success === true && bundle.error === undefined)
    t('V: the malformed-corpus cases record rejected-as-expected with PASSED case rows (the pre-change crashed-exit/failed rows were R16\'s red bar)',
      bundle.gateResults.length === ADVERSARIAL_PROBE_CASE_COUNT
      && bundle.gateResults.every((g) => g.passed)
      && table !== null
      && table.cases.every((r, i) => r.outcome === expectedOutcomes[i])
      && table.cases.filter((r) => r.outcome === 'rejected-as-expected').length === rejectIdx.length
      && eq(table.cases.filter((r) => r.outcome === 'rejected-as-expected').map((r) => r.index), rejectIdx))
    t('V: the results table carries the expectation beside the outcome, and the counts are honest — cases-rejected = the reject split size, cases-crashed 0 (no silent merge), cases-unexpected-exit-0 0, cases-run the full count',
      table !== null
      && table.cases.every((r, i) => r.expectation === expectations[i])
      && table.casesRejected === rejectIdx.length && table.casesCrashed === 0 && table.casesUnexpectedExit0 === 0
      && table.casesRun === ADVERSARIAL_PROBE_CASE_COUNT
      && bundle.measurements.some((m) => m.name === 'cases-rejected' && m.unit === 'cases' && m.value === rejectIdx.length)
      && bundle.measurements.some((m) => m.name === 'cases-crashed' && m.value === 0)
      && bundle.measurements.some((m) => m.name === 'cases-unexpected-exit-0' && m.value === 0)
      && bundle.measurements.some((m) => m.name === 'cases-run' && m.value === ADVERSARIAL_PROBE_CASE_COUNT))
  }

  // ---------- Leg 3: strictness where exit-0 is the expectation ----------
  {
    // A seeded-soup case exiting non-zero STILL records crashed and sinks
    // probe success: the fixture validates the reject set (exits 1 there)
    // and additionally exits 3 on one specific GENERATED case whose
    // authored expectation is exit-0 (seed-42 case 13, the first soup
    // string — index 12, beyond the corpus).
    const cases = generateAdversarialCases(42)
    const expectations = adversarialCaseExpectations(cases)
    const rejectInputs = cases.filter((_, i) => expectations[i] === 'reject')
    const soupTrigger = cases[12]
    if (expectations[12] !== 'exit-0') throw new Error('check bug: seed-42 case 13 was expected to be a generated exit-0 case')
    writeFileSync(join(fx, 'soup-crash.js'), [
      'const arg = process.argv[2] ?? \'\'',
      `const invalid = ${JSON.stringify(rejectInputs)}`,
      `const soupTrigger = ${JSON.stringify(soupTrigger)}`,
      'if (invalid.includes(arg)) { console.log(\'rejected invalid input\'); process.exit(1) }',
      'if (arg === soupTrigger) { console.log(\'soup crash\'); process.exit(3) }',
      'console.log(\'ok\')',
    ].join('\n') + '\n')
    const bundle = await runDirect({ id: 'adv-soup', type: 'adversarial', command: { exe: process.execPath, args: ['soup-crash.js'] }, seed: 42 }, ws, env)
    t('S: no loosening where exit-0 is the expectation — a seeded-soup case exiting 3 records crashed-exit with a FAILED row and sinks probe success, error naming it with counts',
      bundle.success === false
      && bundle.error === `case 13/${ADVERSARIAL_PROBE_CASE_COUNT} exited with code 3`
      && bundle.gateResults.length === ADVERSARIAL_PROBE_CASE_COUNT
      && bundle.gateResults.filter((g) => !g.passed).length === 1
      && bundle.gateResults[12]?.name === 'adv-soup#case-13' && bundle.gateResults[12]?.passed === false && bundle.gateResults[12]?.exitCode === 3
      && bundle.measurements.some((m) => m.name === 'cases-crashed' && m.value === 1)
      && bundle.measurements.some((m) => m.name === 'cases-rejected' && m.value === rejectInputs.length))

    // The no-op inversion face — a target that never reads argv and exits 0
    // on everything: the reject-expected cases record unexpected-exit-0
    // (unmet expectations), probe success false. Correct validation is now
    // distinguishable from an undetectable no-op (R16's other half).
    writeFileSync(join(fx, 'noop.js'), [
      "console.log('no-op handler: never reads argv')",
    ].join('\n') + '\n')
    const noop = await runDirect({ id: 'adv-noop', type: 'adversarial', command: { exe: process.execPath, args: ['noop.js'] }, seed: 42 }, ws, env)
    t('S: the no-op handler never reads argv — success FALSE (never survival), exactly the reject-expected cases record unexpected-exit-0 with failed rows, error names case 1 with the T-062 vocabulary',
      noop.success === false
      && noop.error === `case 1/${ADVERSARIAL_PROBE_CASE_COUNT} exited 0 where rejection was expected (input invalid by construction)`
      && noop.gateResults.length === ADVERSARIAL_PROBE_CASE_COUNT
      && noop.gateResults.filter((g) => !g.passed).length === 5
      && noop.gateResults.filter((g) => !g.passed).every((g) => g.exitCode === 0)
      && noop.measurements.some((m) => m.name === 'cases-unexpected-exit-0' && m.value === 5)
      && noop.measurements.some((m) => m.name === 'cases-rejected' && m.value === 0)
      && noop.measurements.some((m) => m.name === 'cases-crashed' && m.value === 0))
  }

  // ---------- Leg 4: timeouts and spawn refusals stay never-survival ----------
  {
    // A reject-expected case that TIMES OUT records crashed-timeout, never
    // rejection and never survival (the T-032 refusal vocabulary unchanged).
    // The fixture VALIDATES every other reject-expected input (exits 1) so
    // the timeout is the probe's only unmet expectation — a clean isolation
    // of the face under test.
    const cases = generateAdversarialCases(42)
    const timeoutTrigger = cases[9] // corpus index 9 — '{"a":', reject-expected
    const rejectInputs = cases.filter((_, i) => adversarialCaseExpectations(cases)[i] === 'reject')
    if (adversarialCaseExpectations(cases)[9] !== 'reject') throw new Error('check bug: corpus index 9 was expected reject-expected')
    writeFileSync(join(fx, 'timeout-target.js'), [
      "const { spawn } = require('node:child_process')",
      `const trigger = ${JSON.stringify(timeoutTrigger)}`,
      `const invalid = ${JSON.stringify(rejectInputs.filter((c) => c !== timeoutTrigger))}`,
      "const arg = process.argv[2] ?? ''",
      'if (arg === trigger) {',
      "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })",
      "  console.log('PARENT_PID=' + process.pid)",
      "  console.log('CHILD_PID=' + child.pid)",
      '  setInterval(() => {}, 1000)',
      '} else if (invalid.includes(arg)) {',
      "  console.log('rejected invalid input'); process.exit(1)",
      '} else {',
      "  console.log('survived')",
      '}',
    ].join('\n') + '\n')
    const timeoutMs = 1200
    const timedOut = await runDirect({ id: 'adv-timeout', type: 'adversarial', command: { exe: process.execPath, args: ['timeout-target.js'] }, seed: 42, timeoutMs }, ws, env)
    const slowLog = timedOut.artifacts.find((a) => a.kind === 'log')
    const pids = slowLog !== undefined && existsSync(slowLog.path)
      ? [...read(slowLog.path).matchAll(/(?:PARENT|CHILD)_PID=(\d+)/g)].map((m) => Number(m[1]))
      : []
    const parentDead = pids[0] !== undefined && await untilDead(pids[0])
    const childDead = pids[1] !== undefined && await untilDead(pids[1])
    if (pids[0] !== undefined && !parentDead) sweep(pids[0])
    if (pids[1] !== undefined && !childDead) sweep(pids[1])
    const resultsRef = timedOut.artifacts.find((a) => a.kind === 'report')
    const table = resultsRef !== undefined && existsSync(resultsRef.path) ? JSON.parse(read(resultsRef.path)) : null
    t('T: a reject-expected case that times out records crashed-timeout (never rejection, never survival) with a FAILED row, error names it, and every other case met its expectation',
      timedOut.success === false
      && timedOut.error === `case 10/${ADVERSARIAL_PROBE_CASE_COUNT} timed out after ${timeoutMs}ms`
      && timedOut.gateResults.length === ADVERSARIAL_PROBE_CASE_COUNT
      && timedOut.gateResults[9]?.name === 'adv-timeout#case-10' && timedOut.gateResults[9]?.passed === false && timedOut.gateResults[9]?.exitCode === null
      && timedOut.gateResults.filter((g) => !g.passed).length === 1
      && table !== null && table.cases[9]?.outcome === 'crashed-timeout' && table.cases[9]?.expectation === 'reject'
      && timedOut.measurements.some((m) => m.name === 'cases-crashed' && m.value === 1)
      && timedOut.measurements.some((m) => m.name === 'cases-rejected' && m.value === 4))
    // T-065: Windows — the verified tree kill reaps parent and child. POSIX —
    // the root-only kill (KI#9) leaves the tree to the sweeps above; the pin
    // is that nothing survives the leg.
    t(process.platform === 'win32'
      ? 'T: the whole timed-out spawned tree is verified dead on the real process table (the Gate 1.15 posture; AGENTS.md #10)'
      : 'T: nothing of the timed-out spawned tree survives the leg (root-only kill, KI#9; the sweep reaped the tree)',
      pids.length === 2 && (await untilDead(pids[0], 2000)) && (await untilDead(pids[1], 2000)))

    // A spawn refusal stays exactly the T-032 face — never survival, and
    // never a rejection either (a target that never spawned validated
    // nothing).
    const refused = await runDirect({ id: 'adv-refused', type: 'adversarial', command: { exe: 'definitely-not-a-real-exe-6t2r', args: [] }, seed: 42 }, ws, env)
    t('T: a spawn refusal stays never-survival — success false, every row spawn-refused with a failed mark, cases-rejected 0, error names case 1',
      refused.success === false
      && refused.gateResults.length === ADVERSARIAL_PROBE_CASE_COUNT
      && refused.gateResults.every((g, i) => g.name === `adv-refused#case-${i + 1}` && !g.passed && g.exitCode === null)
      && refused.measurements.some((m) => m.name === 'cases-rejected' && m.value === 0)
      && typeof refused.error === 'string'
      && refused.error.startsWith(`case 1/${ADVERSARIAL_PROBE_CASE_COUNT} could not be spawned: `))
  }

  // ---------- Leg 5: composer honesty (the round-2 rendered evidence) ----------
  {
    // Hand-built CandidateReport shapes (the Gate 1.22 leg-A pattern), pure
    // composer call, zero tokens. The validating fixture's actual summary
    // face (success true + casesRejected 5) renders validated input
    // handling; a genuinely failed probe with rejections renders 'failed'
    // WITH the annotation (never laundered); a summary without casesRejected
    // renders the exact pre-T-062 line shape (back-compat).
    const survivorOf = (probes) => ({
      id: 'c01', workerId: 'opencode', model: 'fake/worker-model',
      brief: 'validate argv inputs', workspacePath: null, workerOk: true, workerTimedOut: false,
      workerDurationMs: 100, diffPath: null, diffBytes: 100,
      gates: [{ name: 'build', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok' }],
      passedAllGates: true, attempts: [],
      probes,
    })
    const validating = composeRoundPacket({
      candidates: [survivorOf([{ probeId: 'adv', scenarioId: 'adv', success: true, durationMs: 5, bundlePath: 'C:\\swarm\\f\\probes\\c01\\adv.json', casesRejected: 5 }])],
      model: 'fake/planner-model',
      finishedRound: 1,
    })
    const validatingContent = validating.records[0]?.content ?? ''
    const annot = ' (5 input case(s) rejected as expected — validated input handling, not a failure)'
    t('C: the round-2 rendered evidence carries rejected-as-expected as validated input handling — the probe line reads success with the rejection annotation, never "failed"',
      validatingContent.includes(`- adv/adv: success${annot} (bundle: C:\\swarm\\f\\probes\\c01\\adv.json)`)
      && !validatingContent.includes('- adv/adv: failed'))
    const crashedToo = composeRoundPacket({
      candidates: [survivorOf([{ probeId: 'adv', scenarioId: 'adv', success: false, durationMs: 5, bundlePath: 'C:\\swarm\\f\\probes\\c01\\adv.json', casesRejected: 3 }])],
      model: 'fake/planner-model',
      finishedRound: 1,
    })
    const crashedContent = crashedToo.records[0]?.content ?? ''
    t('C: the annotation never launders a failed probe — a probe that ALSO failed other cases still renders failed, with the rejection scope named',
      crashedContent.includes(`- adv/adv: failed (3 input case(s) rejected as expected — validated input handling, not a failure)`)
      && !crashedContent.includes('- adv/adv: success'))
    const legacy = composeRoundPacket({
      candidates: [survivorOf([{ probeId: 'probe-x', scenarioId: 'probe-x', success: true, durationMs: 5, bundlePath: 'C:\\swarm\\f\\probes\\c01\\probe-x.json' }])],
      model: 'fake/planner-model',
      finishedRound: 1,
    })
    t('C: back-compat — a summary without casesRejected renders the exact pre-T-062 line shape (no annotation, no behavior change for non-adversarial probes)',
      (legacy.records[0]?.content ?? '').includes('- probe-x/probe-x: success (bundle: C:\\swarm\\f\\probes\\c01\\probe-x.json)'))
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
      console.error(`\n${failures.length} check(s) failed`)
      process.exit(1)
    }
    console.log('\nall adversarial expected-outcome checks passed')
  })
