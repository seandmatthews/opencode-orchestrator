// Probe-layer self-check (Gate 1.15, fast tier, T-015; extended in place by
// T-018 — the benchmark probe — T-019 — the screenshot probe — T-024 —
// the web/server probe — T-032 — the adversarial probe — and T-062, which
// rewired the adversarial faces onto the expectation-aware outcome classes:
// rejected-as-expected / unexpected-exit-0 beside the unchanged
// crashed-exit / crashed-timeout / spawn-refused, per-case engine-authored
// expectations on the corpus) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-probe.mjs
// Three legs, zero model tokens (the tickets' Verification sections):
//   1. contract fixtures — the EvidenceBundle validator's accept/refuse faces
//      and parseJobsSpec's probes wiring, including the benchmark `repeats`,
//      screenshot `capture`, web `url`, and adversarial `seed` validation
//      (the Gate 0.5 hand-built-input pattern: no pipeline, no subprocess),
//   2. direct token-free CommandProbe/TestProbe/BenchmarkProbe/
//      ScreenshotProbe/WebProbe/AdversarialProbe executions against a fresh
//      demo-target fixture (scripts/demo-target.mjs, Gate 1) and temp
//      TAP/screenshot/web/adversarial fixtures in the verify sandbox — real
//      list-form spawns, real process-table assertions on the timeout tree
//      kill (the Gate 1.12 style), and for the benchmark probe the
//      quantitative measurement invariants (exactly N run-* durations,
//      nearest-rank min/median/p95 recomputed in this check and compared
//      exactly, the 'report'-kind results artifact); the screenshot probe's
//      capture target is the checked-in tiny valid PNG under
//      scripts/fixtures/ (each leg's capture command copies it into the
//      workspace — list-form — so no capture technology is a dependency of
//      any pin); the web probe's legs run against zero-dependency node:http
//      fixture servers generated in the sandbox per leg (write-and-run, the
//      demo-target pattern — no server exists in any checked-in fixture),
//      each bound to a free port this check picks (ports are machine-global
//      — the documented limitation); the adversarial probe's legs run
//      against a generated known-weak-spot fuzzee fixture (the T-024
//      write-and-run pattern) whose crash subset this check derives
//      INDEPENDENTLY from the recomputed case list, pinning determinism,
//      replayability, and the crash/no-crash/spawn-refusal/timeout faces,
//   3. a token-free end-to-end --jobs drive of runSkeleton with a FAKE
//      WorkerAdapter and fake gates (the Gate 1.8/1.10 pattern,
//      scripts/check-scheduler.mjs) against throwaway fixture repos,
//      asserting the emitted bundle files, validator-clean contents, correct
//      success values, the probes[] <-> bundlePath correspondence, and that
//      survival is untouched by probe outcomes (a passing-gates/failing-probe
//      job still passes; a failing-gates/passing-probe job still fails).
import { killTree } from './kill-tree.mjs'
import { swarmRoot } from './swarm-root.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as netCreateServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ADVERSARIAL_PROBE_CASE_COUNT,
  ADVERSARIAL_PROBE_MAX_CASE_CHARS,
  MIN_PNG_BYTES,
  PNG_MAGIC,
  WEB_PROBE_MAX_BODY_BYTES,
  WEB_PROBE_SNIPPET_BYTES,
  adversarialCaseExpectations,
  createProbe,
  evidenceBundlePath,
  generateAdversarialCases,
  parseTapSummary,
  validateEvidenceBundle,
} from '../src/probe.ts'
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
const sandbox = swarmRoot + '/verify-probe'
const fixture = swarmRoot + '/demo-target'
// T-019: the checked-in tiny valid PNG (magic-valid at authoring time, above
// the probe's size floor) — every screenshot pin's capture target, so no
// capture technology is a dependency of any pin.
const shotFixture = join(root, 'scripts', 'fixtures', 'tiny-1x1.png')
const shotFixtureBytes = readFileSync(shotFixture)
// T-019's token-free capture command: mkdir -p the destination dir, copy the
// checked-in fixture PNG to the scenario-named path, print one line (so the
// probe's .log artifact carries the command's output). List-form argv — the
// source travels as an argument, never a shell string.
const copyCapture = (id, dst) => ({
  id,
  type: 'screenshot',
  capture: dst,
  command: {
    exe: process.execPath,
    args: [
      '-e',
      "require('node:fs').mkdirSync(require('node:path').dirname(process.argv[2]), { recursive: true }); require('node:fs').copyFileSync(process.argv[1], process.argv[2]); console.log('captured ' + process.argv[2])",
      shotFixture,
      dst,
    ],
  },
})
const IDENTITY = ['-c', 'user.name=check-probe', '-c', 'user.email=probe@local']

// T-032's known-weak-spot fuzzee source — the SAME source drives the P3
// direct-execution fixture and the P5 e2e fixture repos: it exits non-zero
// exactly on inputs failing Number.isFinite(Number(arg)) (the weak-spot
// class of the real demo target's add(): mixed-type concat and numeric
// overflow, scripts/demo-target.mjs:15-35). The case arrives as the LAST
// argv entry; the probe appends it after the script filename, so node's own
// option parsing never sees it (an inline `-e` source would — a case like
// the corpus's '-0' is parsed as a node option there, recorded honestly as
// a crash, but useless as a predictable fixture target).
const ADV_FUZZEE_SOURCE = [
  "const arg = process.argv[2] ?? ''",
  "console.log('fuzzee got ' + JSON.stringify(arg))",
  'if (!Number.isFinite(Number(arg))) {',
  "  console.log('weak spot: non-finite Number(input)')",
  '  process.exit(1)',
  '}',
  "console.log('survived')",
].join('\n') + '\n'

// T-062: the expectation-aware derivation over the fuzzee's known weak spot
// — shared by the P3 direct faces and the P5 e2e face. advFuzzeeOutcomes
// recomputes the per-case outcome classes (weak-spot exit × the recomputed
// authored expectation); advIdxWhere selects the case indices carrying one
// of the given classes; advFuzzeeFirstError renders the expected FIRST
// breaking-case error (the fuzzee's crash exit code is always 1). Every
// value is derived from the exported pure functions + the known weak spot,
// never trusted from the bundle.
const advCrashesOn = (c) => !Number.isFinite(Number(c))
const advFuzzeeOutcomeOf = (c, expectation) => (advCrashesOn(c)
  ? (expectation === 'reject' ? 'rejected-as-expected' : 'crashed-exit')
  : (expectation === 'reject' ? 'unexpected-exit-0' : 'survived'))
const advFuzzeeOutcomes = (cases) => {
  const expectations = adversarialCaseExpectations(cases)
  return cases.map((c, i) => advFuzzeeOutcomeOf(c, expectations[i]))
}
const advIdxWhere = (outcomes, classes) => outcomes
  .map((o, i) => (classes.includes(o) ? i + 1 : 0))
  .filter((i) => i > 0)
const advFuzzeeFirstError = (outcomes) => {
  for (let i = 0; i < outcomes.length; i++) {
    if (outcomes[i] === 'unexpected-exit-0') {
      return `case ${i + 1}/${outcomes.length} exited 0 where rejection was expected (input invalid by construction)`
    }
    if (outcomes[i] === 'crashed-exit') {
      return `case ${i + 1}/${outcomes.length} exited with code 1`
    }
  }
  return undefined
}

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
// T-065: the tree-death pin, per platform. Windows — the probe's verified
// tree kill reaps parent and child (assert the pre-sweep state). POSIX — the
// root-only kill (KI#9) reaps the gate shell and leaves the spawned tree to
// this check's mechanized sweep; the pin is that nothing survives the leg.
const assertProbeTreeDead = async (label, pids, parentDead, childDead) => {
  if (process.platform === 'win32') {
    t(label, pids.length === 2 && parentDead && childDead)
    return
  }
  t(`${label} [POSIX: the gate kill is root-only (KI#9); the sweep reaped the tree]`,
    pids.length === 2 && (await untilDead(pids[0], 2000)) && (await untilDead(pids[1], 2000)))
}
/** Best-effort sweep of a planted tree (AGENTS.md #10 mechanized for this
 *  check's own spawns) — only reached when a kill assertion already failed. */
function sweep(pid) {
  try {
    killTree(pid)
  } catch {
    // Already dead — fine.
  }
}

// A free loopback port for a web-probe fixture server (T-024): `url` is
// operator-chosen and ports are machine-global (the documented limitation),
// so each leg's server must bind a port nothing else holds. The classic
// bind-then-close race is acceptable in this throwaway sandbox.
const freePort = () => new Promise((resolve, reject) => {
  const srv = netCreateServer()
  srv.once('error', reject)
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address()
    srv.close(() => resolve(port))
  })
})

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
  // T-032: the known-weak-spot fuzzee, present in every fixture repo so a
  // job's adversarial probe has its target inside the candidate worktree.
  writeFileSync(join(repo, 'adv-fuzzee.js'), ADV_FUZZEE_SOURCE)
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
    // T-027: command, if present, is a non-empty string — refuse '' and
    // non-string; absent accepted (the well-formed fixture above is
    // command-less and stays green untouched; probe-bundle GateResult
    // entries are argv-form evidence of a different shape and stay
    // legitimately command-less).
    t('P1 (T-027): a GateResult command that is a non-empty string validates and is preserved verbatim',
      validateEvidenceBundle({
        ...wellFormed,
        gateResults: [{ ...wellFormed.gateResults[0], command: 'node build.js' }],
      }).gateResults[0]?.command === 'node build.js')
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
      refusesWith((r) => { r.artifacts[0].kind = 'blob' }, 'kind must be "log", "report", or "screenshot"')
      && refusesWith((r) => { r.measurements[0].value = 'two' }, 'value must be a finite number')
      && refusesWith((r) => { r.gateResults[0].passed = 1 }, 'passed must be a boolean'))
    // T-027: command, if present, is a non-empty string — refuse '' and
    // non-string; absent accepted (the command-less fixtures stay green
    // untouched; probe-bundle GateResult entries are argv-form evidence of
    // a different shape and stay legitimately command-less).
    t('P1 (T-027): an empty-string GateResult command is refused',
      refusesWith((r) => { r.gateResults[0].command = '' }, 'command, if present, must be a non-empty string'))
    t('P1 (T-027): a non-string GateResult command is refused',
      refusesWith((r) => { r.gateResults[0].command = 42 }, 'command, if present, must be a non-empty string'))
    // T-019 flip (recorded in the ticket as one of this change-set's two
    // intentional invalidations of existing assertions): the kind-refusal
    // message previously pinned `kind must be "log" or "report"` — the
    // message gains "screenshot" (the ScreenshotProbe's durable image copy
    // is that kind's first producer) and the flip gains positive coverage: a
    // well-formed bundle carrying a kind-'screenshot' artifact VALIDATES.
    // Net strictness increases in both dimensions (the T-013 flip
    // precedent); no other existing assertion is weakened.
    t('P1: a kind-"screenshot" artifact validates (the T-019 flip: screenshot moved from refused kind to pinned kind)',
      validateEvidenceBundle({
        ...wellFormed,
        artifacts: [{ name: 'shot-check.png', path: 'C:/swarm/run/probes/c01/shot-check.png', kind: 'screenshot', sizeBytes: 67 }],
      }).success === true)
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
    // T-019 flip (recorded in the ticket as one of this change-set's two
    // intentional invalidations of existing assertions): Gate 1.15's P2 leg
    // used `type: 'screenshot'` as its genuinely-unknown example
    // (`type must be "command", "test", or "benchmark"` — the message
    // T-018's landing left behind). The screenshot probe now EXISTS, and —
    // T-018 having landed first — this second landing adjusts BOTH the
    // message and the unknown-type example (the ticket's coordination note):
    // the example becomes a type still unknown at this landing ('godot'),
    // and the flip gains positive coverage (a screenshot probe with `capture`
    // parses and is preserved verbatim). Net strictness increases (the
    // T-013 flip precedent); no other existing assertion is weakened.
    t('P2: a screenshot probe with capture validates and is preserved verbatim (the T-019 flip: screenshot moved from unknown-type example to pinned type)',
      eq(parseJobsSpec({
        phases: [{ id: 'p' }],
        jobs: [{ id: 'j1', phase: 'p', brief: 'b', probes: [
          { id: 'shot-check', type: 'screenshot', command: { exe: 'node', args: ['cap.js'] }, capture: 'shots/out.png' },
        ] }],
      }).jobs[0]?.probes, [
        { id: 'shot-check', type: 'screenshot', command: { exe: 'node', args: ['cap.js'] }, capture: 'shots/out.png' },
      ]))
    // T-024 flip (recorded in the ticket as this change-set's only
    // intentional invalidation of an existing assertion): Gate 1.15's P2 leg
    // actively pinned the unknown-type refusal message (`type must be
    // "command", "test", "benchmark", or "screenshot"` — the message T-019's
    // landing left behind, with 'godot' as the unknown-type example since
    // T-019). The web probe now EXISTS, so the pin becomes positive coverage
    // (a web probe with `url` parses and is preserved verbatim) plus refusal
    // of a genuinely-unknown type with the updated message; 'godot' stays
    // genuinely unknown and remains the example — only the message string
    // changed. Net strictness increases (the T-013 flip precedent); no other
    // existing assertion is weakened.
    t('P2: a web probe with url validates and is preserved verbatim (the T-024 flip: web moved from unknown-type territory to pinned type)',
      eq(parseJobsSpec({
        phases: [{ id: 'p' }],
        jobs: [{ id: 'j1', phase: 'p', brief: 'b', probes: [
          { id: 'web-check', type: 'web', command: { exe: 'node', args: ['serve.js'] }, url: 'http://127.0.0.1:8080/' },
        ] }],
      }).jobs[0]?.probes, [
        { id: 'web-check', type: 'web', command: { exe: 'node', args: ['serve.js'] }, url: 'http://127.0.0.1:8080/' },
      ]))
    // T-032 flip (recorded in the ticket as this change-set's only
    // intentional invalidation of an existing assertion): Gate 1.15's P2 leg
    // actively pinned the unknown-type refusal message (`type must be
    // "command", "test", "benchmark", "screenshot", or "web"` — the message
    // T-024's landing left behind, with 'godot' as the unknown-type example
    // since T-019). The adversarial probe now EXISTS, so that one assertion
    // was flipped explicitly in T-032's change-set: the expected message
    // gained "adversarial" and 'godot' stays genuinely unknown and remains
    // the example (only the message string changed — exactly T-024's flip
    // shape). Net strictness increases (the T-013 flip precedent); no other
    // existing assertion is weakened.
    t('P2: a genuinely-unknown probe type is refused with the updated message (the example stays a type still unknown at this landing — the T-018/T-019/T-024/T-032 coordination chain)',
      throwsWith(base([{ id: 'x', type: 'godot', command: { exe: 'node', args: [] } }]), 'type must be "command", "test", "benchmark", "screenshot", "web", or "adversarial"'))
    // T-032: the adversarial probe's positive parse face — seed preserved
    // verbatim (the same-extension shape as the T-018/T-019/T-024 flips).
    t('P2: an adversarial probe with seed validates and is preserved verbatim (the T-032 flip: adversarial moved from unknown-type territory to pinned type)',
      eq(parseJobsSpec({
        phases: [{ id: 'p' }],
        jobs: [{ id: 'j1', phase: 'p', brief: 'b', probes: [
          { id: 'adv-check', type: 'adversarial', command: { exe: 'node', args: ['fuzzee.js'] }, seed: 42 },
        ] }],
      }).jobs[0]?.probes, [
        { id: 'adv-check', type: 'adversarial', command: { exe: 'node', args: ['fuzzee.js'] }, seed: 42 },
      ]))
    t('P2: seed validation on an adversarial probe — missing, 0, -1, 1.5, non-string "seven" all refused naming the offense',
      throwsWith(base([{ id: 'x', type: 'adversarial', command: { exe: 'node', args: [] } }]), 'seed must be a positive integer >= 1')
      && throwsWith(base([{ id: 'x', type: 'adversarial', command: { exe: 'node', args: [] }, seed: 0 }]), 'seed must be a positive integer >= 1')
      && throwsWith(base([{ id: 'x', type: 'adversarial', command: { exe: 'node', args: [] }, seed: -1 }]), 'seed must be a positive integer >= 1')
      && throwsWith(base([{ id: 'x', type: 'adversarial', command: { exe: 'node', args: [] }, seed: 1.5 }]), 'seed must be a positive integer >= 1')
      && throwsWith(base([{ id: 'x', type: 'adversarial', command: { exe: 'node', args: [] }, seed: 'seven' }]), 'seed must be a positive integer >= 1'))
    t('P2: seed on a command/test/benchmark/screenshot/web probe is refused — the field exists only where it means something',
      throwsWith(base([{ id: 'x', type: 'command', command: { exe: 'node', args: [] }, seed: 7 }]), 'seed is only valid on an adversarial probe')
      && throwsWith(base([{ id: 'x', type: 'test', command: { exe: 'node', args: [] }, seed: 7 }]), 'seed is only valid on an adversarial probe')
      && throwsWith(base([{ id: 'x', type: 'benchmark', command: { exe: 'node', args: [] }, seed: 7, repeats: 2 }]), 'seed is only valid on an adversarial probe')
      && throwsWith(base([{ id: 'x', type: 'screenshot', command: { exe: 'node', args: [] }, seed: 7, capture: 'a.png' }]), 'seed is only valid on an adversarial probe')
      && throwsWith(base([{ id: 'x', type: 'web', command: { exe: 'node', args: [] }, seed: 7, url: 'http://host/' }]), 'seed is only valid on an adversarial probe'))
    t('P2: url validation on a web probe — missing, empty, non-string, non-http(s) scheme, and URL junk all refused naming the offense',
      throwsWith(base([{ id: 'x', type: 'web', command: { exe: 'node', args: [] } }]), 'url must be a non-empty http(s) URL')
      && throwsWith(base([{ id: 'x', type: 'web', command: { exe: 'node', args: [] }, url: '' }]), 'url must be a non-empty http(s) URL')
      && throwsWith(base([{ id: 'x', type: 'web', command: { exe: 'node', args: [] }, url: 8080 }]), 'url must be a non-empty http(s) URL')
      && throwsWith(base([{ id: 'x', type: 'web', command: { exe: 'node', args: [] }, url: 'ftp://host/' }]), 'url must be an http:// or https:// URL')
      && throwsWith(base([{ id: 'x', type: 'web', command: { exe: 'node', args: [] }, url: 'not-a-url' }]), 'url must be an http:// or https:// URL'))
    t('P2: url on a command/test/benchmark/screenshot probe is refused — the field exists only where it means something',
      throwsWith(base([{ id: 'x', type: 'command', command: { exe: 'node', args: [] }, url: 'http://host/' }]), 'url is only valid on a web probe')
      && throwsWith(base([{ id: 'x', type: 'test', command: { exe: 'node', args: [] }, url: 'http://host/' }]), 'url is only valid on a web probe')
      && throwsWith(base([{ id: 'x', type: 'benchmark', command: { exe: 'node', args: [] }, url: 'http://host/', repeats: 2 }]), 'url is only valid on a web probe')
      && throwsWith(base([{ id: 'x', type: 'screenshot', command: { exe: 'node', args: [] }, url: 'http://host/', capture: 'a.png' }]), 'url is only valid on a web probe'))
    t('P2: capture validation on a screenshot probe — missing, empty, non-string, absolute, and ..-segment all refused naming the offense',
      throwsWith(base([{ id: 'x', type: 'screenshot', command: { exe: 'node', args: [] } }]), 'capture must be a non-empty workspace-relative path')
      && throwsWith(base([{ id: 'x', type: 'screenshot', command: { exe: 'node', args: [] }, capture: '' }]), 'capture must be a non-empty workspace-relative path')
      && throwsWith(base([{ id: 'x', type: 'screenshot', command: { exe: 'node', args: [] }, capture: 67 }]), 'capture must be a non-empty workspace-relative path')
      && throwsWith(base([{ id: 'x', type: 'screenshot', command: { exe: 'node', args: [] }, capture: 'C:/swarm/escape.png' }]), 'capture must be workspace-relative; absolute paths are refused')
      && throwsWith(base([{ id: 'x', type: 'screenshot', command: { exe: 'node', args: [] }, capture: 'C:\\swarm\\escape.png' }]), 'capture must be workspace-relative; absolute paths are refused')
      && throwsWith(base([{ id: 'x', type: 'screenshot', command: { exe: 'node', args: [] }, capture: '\\\\server\\share\\escape.png' }]), 'capture must be workspace-relative; absolute paths are refused')
      && throwsWith(base([{ id: 'x', type: 'screenshot', command: { exe: 'node', args: [] }, capture: '../escape.png' }]), "capture must not contain a '..' segment")
      && throwsWith(base([{ id: 'x', type: 'screenshot', command: { exe: 'node', args: [] }, capture: 'shots/../../escape.png' }]), "capture must not contain a '..' segment"))
    t('P2: capture on a command/test/benchmark probe is refused — the field exists only where it means something',
      throwsWith(base([{ id: 'x', type: 'command', command: { exe: 'node', args: [] }, capture: 'a.png' }]), 'capture is only valid on a screenshot probe')
      && throwsWith(base([{ id: 'x', type: 'test', command: { exe: 'node', args: [] }, capture: 'a.png' }]), 'capture is only valid on a screenshot probe')
      && throwsWith(base([{ id: 'x', type: 'benchmark', command: { exe: 'node', args: [] }, capture: 'a.png', repeats: 2 }]), 'capture is only valid on a screenshot probe'))
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

    // T-019: the screenshot probe — direct token-free executions whose
    // capture commands only copy the checked-in fixture PNG into the
    // workspace (list-form spawn via executeProbeCommand; no capture
    // technology is a dependency of any pin).
    const shotFx = join(sandbox, 'shot-fx')
    mkdirSync(shotFx, { recursive: true })
    const shotArtifacts = join(shotFx, 'artifacts')
    const shotEnv = directEnv(shotArtifacts)
    const shotWs = directLease(shotFx)
    t('P3: the checked-in fixture PNG is magic-valid and above the probe size floor (the pin basis)',
      shotFixtureBytes.length > MIN_PNG_BYTES && shotFixtureBytes.subarray(0, 8).equals(PNG_MAGIC))
    const shotHappy = await runDirect(copyCapture('shot-happy', 'shots/happy.png'), shotWs, shotEnv)
    const shotImg = shotHappy.artifacts.find((a) => a.kind === 'screenshot')
    t('P3: ScreenshotProbe happy path — success true, one GateResult entry (exit 0, passed), both measurements present (capture duration ms + image bytes = source size)',
      shotHappy.success === true
      && shotHappy.gateResults.length === 1
      && shotHappy.gateResults[0]?.exitCode === 0
      && shotHappy.gateResults[0]?.passed === true
      && shotHappy.measurements.length === 2
      && shotHappy.measurements.some((m) => m.name === 'capture duration' && m.unit === 'ms' && m.value >= 0)
      && shotHappy.measurements.some((m) => m.name === 'image bytes' && m.unit === 'bytes' && m.value === shotFixtureBytes.length))
    t('P3: the image is a kind-"screenshot" artifact copied to <artifactsDir>/probes/<candidateId>/<probeId>.png, sizeBytes equal to the source, PNG magic re-verified ON THE COPY',
      shotImg !== undefined
      && shotImg.name === 'shot-happy.png'
      && shotImg.path === join(shotArtifacts, 'probes', 'direct', 'shot-happy.png')
      && shotImg.sizeBytes === shotFixtureBytes.length
      && existsSync(shotImg.path)
      && readFileSync(shotImg.path).subarray(0, 8).equals(PNG_MAGIC))
    t('P3: the happy screenshot bundle passes the validator and its .log artifact is real on disk',
      validateEvidenceBundle(JSON.parse(JSON.stringify(shotHappy))).success === true
      && shotHappy.artifacts[0]?.kind === 'log' && shotHappy.artifacts[0]?.sizeBytes > 0
      && existsSync(shotHappy.artifacts[0]?.path))

    const shotExit = await runDirect({ id: 'shot-exit', type: 'screenshot', capture: 'exit.png', command: { exe: process.execPath, args: ['-e', "console.log('cap-boom'); process.exit(3)"] } }, shotWs, shotEnv)
    t('P3: screenshot failure face, non-zero exit — success false, error names the exit, capture duration still recorded, NO image bytes and NO screenshot artifact',
      shotExit.success === false
      && shotExit.error === 'capture command exited with code 3'
      && shotExit.gateResults[0]?.exitCode === 3
      && shotExit.measurements.some((m) => m.name === 'capture duration')
      && !shotExit.measurements.some((m) => m.name === 'image bytes')
      && shotExit.artifacts.every((a) => a.kind === 'log'))

    const shotZero = await runDirect({ id: 'shot-zero', type: 'screenshot', capture: 'zero.png', command: { exe: process.execPath, args: ['-e', "require('node:fs').writeFileSync(process.argv[1], '')", 'zero.png'] } }, shotWs, shotEnv)
    t('P3: screenshot failure face, zero-byte capture — success false, error names the size floor, image bytes 0 recorded (evidence about failures is evidence), never a pass',
      shotZero.success === false
      && shotZero.gateResults[0]?.exitCode === 0
      && typeof shotZero.error === 'string' && shotZero.error.includes('below the PNG size floor') && shotZero.error.includes('0 bytes')
      && shotZero.measurements.some((m) => m.name === 'image bytes' && m.value === 0)
      && shotZero.artifacts.every((a) => a.kind === 'log'))

    const shotMissing = await runDirect({ id: 'shot-missing', type: 'screenshot', capture: 'nothing.png', command: { exe: process.execPath, args: ['-e', 'process.exit(0)'] } }, shotWs, shotEnv)
    t('P3: screenshot failure face, exit 0 having written nothing — success false, error names the missing capture file, no image bytes recorded',
      shotMissing.success === false
      && shotMissing.gateResults[0]?.exitCode === 0
      && typeof shotMissing.error === 'string' && shotMissing.error.includes('capture file missing')
      && shotMissing.measurements.some((m) => m.name === 'capture duration')
      && !shotMissing.measurements.some((m) => m.name === 'image bytes'))

    const shotMagic = await runDirect({ id: 'shot-magic', type: 'screenshot', capture: 'junk.png', command: { exe: process.execPath, args: ['-e', "require('node:fs').writeFileSync(process.argv[1], Buffer.alloc(64))", 'junk.png'] } }, shotWs, shotEnv)
    t('P3: screenshot failure face, magic-less capture — success false, error names the bad magic (a 64-byte file clears the floor), image bytes recorded, never a pass',
      shotMagic.success === false
      && shotMagic.gateResults[0]?.exitCode === 0
      && typeof shotMagic.error === 'string' && shotMagic.error.includes('not a PNG')
      && shotMagic.measurements.some((m) => m.name === 'image bytes' && m.value === 64)
      && shotMagic.artifacts.every((a) => a.kind === 'log'))

    const shotRefused = await runDirect({ id: 'shot-refused', type: 'screenshot', capture: 'refused.png', command: { exe: 'definitely-not-a-real-exe-4f8a2b', args: [] } }, shotWs, shotEnv)
    t('P3: screenshot spawn-refusal face — success false with the spawn error recorded, NO capture duration (the command never ran), no artifact beyond the .log, never a pass',
      shotRefused.success === false
      && typeof shotRefused.error === 'string' && shotRefused.error.startsWith('capture command could not be spawned: ')
      && shotRefused.gateResults[0]?.passed === false && shotRefused.gateResults[0]?.exitCode === null
      && !shotRefused.measurements.some((m) => m.name === 'capture duration')
      && !shotRefused.measurements.some((m) => m.name === 'image bytes')
      && shotRefused.artifacts.length === 1 && shotRefused.artifacts[0]?.kind === 'log')

    let shotContractThrow = ''
    try {
      await runDirect({ id: 'shot-nocapture', type: 'screenshot', command: { exe: process.execPath, args: [] } }, shotWs, shotEnv)
    } catch (e) {
      shotContractThrow = e instanceof Error ? e.message : String(e)
    }
    t('P3: a directly constructed screenshot scenario without capture is refused by the class itself (never silently run)',
      shotContractThrow.includes('capture must be a non-empty workspace-relative path'))

    // Timeout face — the P4 sleeper pattern with its process-table
    // assertions and sweep fallback: the tree kill is what reaps a launched
    // server at timeout.
    writeFileSync(join(shotFx, 'shot-sleeper.js'), [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })",
      "console.log('PARENT_PID=' + process.pid)",
      "console.log('CHILD_PID=' + child.pid)",
      'setInterval(() => {}, 1000)',
    ].join('\n') + '\n')
    const shotTimeoutMs = 1200
    const shotTimedOut = await runDirect({ id: 'shot-slow', type: 'screenshot', capture: 'slow.png', command: { exe: process.execPath, args: ['shot-sleeper.js'] }, timeoutMs: shotTimeoutMs }, shotWs, shotEnv)
    const shotLog = shotTimedOut.artifacts.find((a) => a.kind === 'log')
    const shotPids = (shotLog !== undefined && existsSync(shotLog.path))
      ? [...read(shotLog.path).matchAll(/(?:PARENT|CHILD)_PID=(\d+)/g)].map((m) => Number(m[1]))
      : []
    const shotParentDead = shotPids[0] !== undefined && await untilDead(shotPids[0])
    const shotChildDead = shotPids[1] !== undefined && await untilDead(shotPids[1])
    if (shotPids[0] !== undefined && !shotParentDead) sweep(shotPids[0])
    if (shotPids[1] !== undefined && !shotChildDead) sweep(shotPids[1])
    t('P3: screenshot timeout — success false, error names the timeout, exitCode null, durationMs >= timeoutMs, the capture duration still recorded',
      shotTimedOut.success === false
      && typeof shotTimedOut.error === 'string' && shotTimedOut.error.includes(`timed out after ${shotTimeoutMs}ms`)
      && shotTimedOut.gateResults.length === 1
      && shotTimedOut.gateResults[0]?.exitCode === null
      && shotTimedOut.gateResults[0]?.durationMs >= shotTimeoutMs
      && shotTimedOut.measurements.some((m) => m.name === 'capture duration' && m.value >= shotTimeoutMs))
    await assertProbeTreeDead('P3: screenshot timeout — the whole spawned tree is verified dead on the real process table',
      shotPids, shotParentDead, shotChildDead)
    t("P3: screenshot timeout — kill evidence is on the GateResult: a verified kill leaves cleanupFailures absent, an unproven one records loud CLEANUP FAIL lines",
      shotTimedOut.gateResults[0]?.cleanupFailures === undefined
      || (Array.isArray(shotTimedOut.gateResults[0]?.cleanupFailures) && shotTimedOut.gateResults[0]?.cleanupFailures.every((l) => l.startsWith('CLEANUP FAIL'))))

    // T-024: the web probe — direct token-free executions against
    // zero-dependency node:http fixture servers generated in the sandbox per
    // leg (the write-and-run demo-target pattern; no server exists in any
    // checked-in fixture). Each leg's launch command IS its server instance,
    // bound to a free port this check picks (ports are machine-global — the
    // documented limitation), and the probe's verified tree kill is what
    // reaps it; every leg ends with the P4 sweep fallback over the pids its
    // server printed.
    const webFx = join(sandbox, 'web-fx')
    mkdirSync(webFx, { recursive: true })
    const webArtifacts = join(webFx, 'artifacts')
    const webEnv = directEnv(webArtifacts)
    const webWs = directLease(webFx)
    const serverPidsOf = (bundle) => {
      const log = bundle.artifacts.find((a) => a.kind === 'log')
      return (log !== undefined && existsSync(log.path))
        ? [...read(log.path).matchAll(/SERVER_PID=(\d+)/g)].map((m) => Number(m[1]))
        : []
    }
    const assertTreeDead = async (label, pids) => {
      let allDead = pids.length > 0
      for (const pid of pids) {
        const dead = await untilDead(pid)
        if (!dead) sweep(pid)
        allDead = allDead && dead
      }
      // T-065: off-Windows the probe's kill is root-only (KI#9) — a launched
      // server's descendant is left to the sweep above; the pin is that
      // nothing survives the leg (re-checked with a bounded wait: SIGKILL
      // needs a moment to leave the process table).
      if (process.platform !== 'win32') {
        allDead = true
        for (const pid of pids) allDead = (await untilDead(pid, 2000)) && allDead
      }
      t(process.platform === 'win32' ? label
        : `${label} [POSIX: the probe kill is root-only (KI#9), this check's sweep reaped the rest]`, allDead)
    }
    const responseOf = (bundle) => {
      const ref = bundle.artifacts.find((a) => a.kind === 'report')
      return {
        ref,
        body: ref !== undefined && existsSync(ref.path) ? JSON.parse(read(ref.path)) : null,
      }
    }
    // The happy/bounds fixture server: announces SERVER_PID, serves a body
    // per path ('/' small, '/big' 5000 chars, '/huge' 1.5 MiB).
    writeFileSync(join(webFx, 'web-ok-server.js'), [
      "const http = require('node:http')",
      "const bodies = { '/': 'web-probe-hello', '/big': 'A'.repeat(5000), '/huge': 'B'.repeat(1572864) }",
      "http.createServer((req, res) => {",
      "  const body = bodies[req.url] ?? 'web-probe-hello'",
      "  res.writeHead(200, { 'content-type': 'text/plain' })",
      "  res.end(body)",
      "}).listen(Number(process.argv[2]), '127.0.0.1', () => console.log('SERVER_PID=' + process.pid))",
    ].join('\n') + '\n')

    const happyPort = await freePort()
    const webHappy = await runDirect({ id: 'web-check', type: 'web', command: { exe: process.execPath, args: ['web-ok-server.js', String(happyPort)] }, url: `http://127.0.0.1:${happyPort}/`, timeoutMs: 8000 }, webWs, webEnv)
    const { ref: webHappyResp, body: webHappyBody } = responseOf(webHappy)
    t('P3: WebProbe happy path — success true, http status 200, ready duration (ms) + body bytes recorded, body snippet equals the known body, one GateResult entry (passed; exitCode null — the server was tree-killed at teardown, never exited on its own)',
      webHappy.success === true
      && webHappy.measurements.some((m) => m.name === 'http status' && m.value === 200)
      && webHappy.measurements.some((m) => m.name === 'ready duration' && m.unit === 'ms' && m.value >= 0)
      && webHappy.measurements.some((m) => m.name === 'body bytes' && m.unit === 'bytes' && m.value === 'web-probe-hello'.length)
      && webHappy.gateResults.length === 1
      && webHappy.gateResults[0]?.passed === true
      && webHappy.gateResults[0]?.exitCode === null)
    t('P3: the web response artifact <probeId>.response.json (kind report) — on disk under <artifactsDir>/probes/<candidateId>/, parses, carries {url, status, contentType, bodySnippet, bodyBytes}',
      webHappyResp !== undefined && webHappyResp.kind === 'report' && webHappyResp.name === 'web-check.response.json'
      && webHappyResp.path === join(webArtifacts, 'probes', 'direct', 'web-check.response.json')
      && webHappyResp.sizeBytes > 0
      && webHappyBody !== null
      && webHappyBody.url === `http://127.0.0.1:${happyPort}/`
      && webHappyBody.status === 200
      && webHappyBody.contentType === 'text/plain'
      && webHappyBody.bodySnippet === 'web-probe-hello'
      && webHappyBody.bodyBytes === 'web-probe-hello'.length)
    t('P3: the happy web bundle passes the validator and its .log carries the launch banner, the poll section, and the capture outcome',
      validateEvidenceBundle(JSON.parse(JSON.stringify(webHappy))).success === true
      && webHappy.artifacts[0]?.kind === 'log' && webHappy.artifacts[0]?.sizeBytes > 0
      && read(webHappy.artifacts[0]?.path).includes('=== web probe launch ===')
      && read(webHappy.artifacts[0]?.path).includes('=== readiness poll:')
      && read(webHappy.artifacts[0]?.path).includes('=== captured ==='))
    await assertTreeDead('P3: web teardown pinned on the success path — the server tree verified dead on the real process table after run() returns', serverPidsOf(webHappy))

    // The bounds, pinned exactly (both still success true — the bounds bound
    // the evidence, never judge it).
    const bigPort = await freePort()
    const webBig = await runDirect({ id: 'web-big', type: 'web', command: { exe: process.execPath, args: ['web-ok-server.js', String(bigPort)] }, url: `http://127.0.0.1:${bigPort}/big`, timeoutMs: 8000 }, webWs, webEnv)
    const { body: webBigBody } = responseOf(webBig)
    t(`P3: the body snippet is bounded at WEB_PROBE_SNIPPET_BYTES (${WEB_PROBE_SNIPPET_BYTES}) — a 5000-char body records exactly that many characters`,
      webBig.success === true
      && webBigBody !== null && webBigBody.bodySnippet.length === WEB_PROBE_SNIPPET_BYTES
      && webBigBody.bodyBytes === 5000
      && webBig.measurements.some((m) => m.name === 'body bytes' && m.value === 5000))
    await assertTreeDead('P3: web-big teardown — its server instance verified dead on the real process table', serverPidsOf(webBig))
    const hugePort = await freePort()
    const webHuge = await runDirect({ id: 'web-huge', type: 'web', command: { exe: process.execPath, args: ['web-ok-server.js', String(hugePort)] }, url: `http://127.0.0.1:${hugePort}/huge`, timeoutMs: 8000 }, webWs, webEnv)
    const { body: webHugeBody } = responseOf(webHuge)
    t(`P3: the body read is capped at WEB_PROBE_MAX_BODY_BYTES (${WEB_PROBE_MAX_BODY_BYTES}) — a 1.5 MiB body records exactly that many bytes read, the snippet bounded too`,
      webHuge.success === true
      && webHugeBody !== null && webHugeBody.bodyBytes === WEB_PROBE_MAX_BODY_BYTES
      && webHugeBody.bodySnippet.length === WEB_PROBE_SNIPPET_BYTES
      && webHuge.measurements.some((m) => m.name === 'body bytes' && m.value === WEB_PROBE_MAX_BODY_BYTES))
    await assertTreeDead('P3: web-huge teardown — its server instance verified dead on the real process table', serverPidsOf(webHuge))

    // Failure faces, each success:false never a pass.
    writeFileSync(join(webFx, 'web-500-server.js'), [
      "const http = require('node:http')",
      "http.createServer((req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('server-error') }).listen(Number(process.argv[2]), '127.0.0.1', () => console.log('SERVER_PID=' + process.pid))",
    ].join('\n') + '\n')
    const statusPort = await freePort()
    const webStatus = await runDirect({ id: 'web-status', type: 'web', command: { exe: process.execPath, args: ['web-500-server.js', String(statusPort)] }, url: `http://127.0.0.1:${statusPort}/`, timeoutMs: 8000 }, webWs, webEnv)
    const { body: webStatusBody } = responseOf(webStatus)
    t('P3: web wrong-status face — a 500 server: success false, error names the non-2xx status, the http status measurement STILL records 500 (readiness was reached — ready duration too), the response artifact records it',
      webStatus.success === false
      && typeof webStatus.error === 'string' && webStatus.error.includes('500')
      && webStatus.measurements.some((m) => m.name === 'http status' && m.value === 500)
      && webStatus.measurements.some((m) => m.name === 'ready duration' && m.unit === 'ms')
      && webStatus.gateResults[0]?.passed === false
      && webStatusBody !== null && webStatusBody.status === 500)
    await assertTreeDead('P3: web-status teardown — its server instance verified dead on the real process table', serverPidsOf(webStatus))

    writeFileSync(join(webFx, 'web-empty-server.js'), [
      "const http = require('node:http')",
      "http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('') }).listen(Number(process.argv[2]), '127.0.0.1', () => console.log('SERVER_PID=' + process.pid))",
    ].join('\n') + '\n')
    const emptyPort = await freePort()
    const webEmpty = await runDirect({ id: 'web-empty', type: 'web', command: { exe: process.execPath, args: ['web-empty-server.js', String(emptyPort)] }, url: `http://127.0.0.1:${emptyPort}/`, timeoutMs: 8000 }, webWs, webEnv)
    const { body: webEmptyBody } = responseOf(webEmpty)
    t('P3: web empty-body face — a 200 server with a zero-byte body: success false, error names the empty body, body bytes 0 recorded (evidence about failures is evidence), the response artifact carries bodyBytes 0 and an empty snippet',
      webEmpty.success === false
      && typeof webEmpty.error === 'string' && webEmpty.error.includes('empty')
      && webEmpty.measurements.some((m) => m.name === 'http status' && m.value === 200)
      && webEmpty.measurements.some((m) => m.name === 'body bytes' && m.value === 0)
      && webEmpty.gateResults[0]?.passed === false
      && webEmptyBody !== null && webEmptyBody.bodyBytes === 0 && webEmptyBody.bodySnippet === '')
    await assertTreeDead('P3: web-empty teardown — its server instance verified dead on the real process table', serverPidsOf(webEmpty))

    const earlyPort = await freePort()
    const webEarly = await runDirect({ id: 'web-early', type: 'web', command: { exe: process.execPath, args: ['-e', 'process.exit(3)'] }, url: `http://127.0.0.1:${earlyPort}/`, timeoutMs: 8000 }, webWs, webEnv)
    t('P3: web target-exits-early face — the launch exits 3 without serving: success false naming the exit, zero measurements, no response artifact, exitCode 3 on the GateResult, nothing-to-kill recorded honestly with NO cleanupFailures fabricated',
      webEarly.success === false
      && typeof webEarly.error === 'string' && webEarly.error.includes('exited before readiness') && webEarly.error.includes('3')
      && webEarly.measurements.length === 0
      && webEarly.artifacts.every((a) => a.kind === 'log')
      && webEarly.gateResults[0]?.exitCode === 3
      && webEarly.gateResults[0]?.cleanupFailures === undefined
      && read(webEarly.artifacts[0]?.path).includes('nothing to kill'))

    // Never-ready: a sleeper launch that binds nothing — deadline expiry; the
    // spawned tree (parent + child, the P4 sleeper shape) is what the tree
    // kill must reap.
    writeFileSync(join(webFx, 'web-sleeper.js'), [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })",
      "console.log('PARENT_PID=' + process.pid)",
      "console.log('CHILD_PID=' + child.pid)",
      'setInterval(() => {}, 1000)',
    ].join('\n') + '\n')
    const neverPort = await freePort()
    const webTimeoutMs = 1200
    const webNever = await runDirect({ id: 'web-never', type: 'web', command: { exe: process.execPath, args: ['web-sleeper.js'] }, url: `http://127.0.0.1:${neverPort}/`, timeoutMs: webTimeoutMs }, webWs, webEnv)
    const neverLog = webNever.artifacts.find((a) => a.kind === 'log')
    const neverPids = (neverLog !== undefined && existsSync(neverLog.path))
      ? [...read(neverLog.path).matchAll(/(?:PARENT|CHILD)_PID=(\d+)/g)].map((m) => Number(m[1]))
      : []
    t('P3: web never-ready face — a sleeper that binds nothing: deadline expiry, success false, error names the readiness timeout with the last poll error (ECONNREFUSED), exitCode null, durationMs >= timeoutMs, zero measurements (no response captured — never a pass)',
      webNever.success === false
      && typeof webNever.error === 'string' && webNever.error.includes('readiness deadline expired') && webNever.error.includes(String(webTimeoutMs)) && webNever.error.includes('ECONNREFUSED')
      && webNever.gateResults.length === 1
      && webNever.gateResults[0]?.exitCode === null
      && webNever.gateResults[0]?.durationMs >= webTimeoutMs
      && webNever.measurements.length === 0
      && webNever.artifacts.every((a) => a.kind === 'log'))
    t('P3: web never-ready — the readiness poll really polled (multiple failed attempts logged inside the ONE timeout budget)',
      neverLog !== undefined && existsSync(neverLog.path)
      && (read(neverLog.path).match(/poll attempt \d+ failed/g) ?? []).length >= 2)
    {
      let parentDead = false
      let childDead = false
      if (neverPids[0] !== undefined) { parentDead = await untilDead(neverPids[0]); if (!parentDead) sweep(neverPids[0]) }
      if (neverPids[1] !== undefined) { childDead = await untilDead(neverPids[1]); if (!childDead) sweep(neverPids[1]) }
      // T-065: on POSIX the gate kill is root-only (KI#9) — the spawned tree
      // is left to the sweeps above; the pin is that nothing survives the leg.
      t(process.platform === 'win32'
        ? 'P3: web never-ready — the spawned tree is verified dead on the real process table (parent + child); the tree kill is what reaps a launched server'
        : 'P3: web never-ready — nothing of the launched server survives the leg (root-only kill, KI#9; the sweep reaped the tree)',
        neverPids.length === 2 && (await untilDead(neverPids[0], 2000)) && (await untilDead(neverPids[1], 2000)))
      t("P3: web never-ready — kill evidence is on the GateResult entry: a verified kill leaves cleanupFailures absent, an unproven one records loud CLEANUP FAIL lines",
        webNever.gateResults[0]?.cleanupFailures === undefined
        || (Array.isArray(webNever.gateResults[0]?.cleanupFailures) && webNever.gateResults[0]?.cleanupFailures.every((l) => l.startsWith('CLEANUP FAIL'))))
    }

    // T-032: the adversarial probe — direct token-free executions against a
    // generated known-weak-spot fuzzee fixture (the T-024 write-and-run
    // pattern: zero-dep scripts generated per leg in the verify sandbox, no
    // checked-in fixture). The weak spot is independently known: the fuzzee
    // exits non-zero exactly on inputs failing Number.isFinite(Number(arg))
    // — the same weak-spot class as the real demo target's add(): mixed-type
    // concat and numeric overflow (scripts/demo-target.mjs:15-35). This
    // check recomputes the case list from the scenario's seed via the
    // exported generateAdversarialCases and derives the expected crash
    // subset from the strings themselves, so every face pins the probe
    // against an independently-computed expectation. Since T-062 the
    // derivation is EXPECTATION-AWARE: the recomputed per-case expectations
    // (adversarialCaseExpectations) overlay the weak-spot subset — the
    // malformed inputs the fuzzee exits 1 on are rejected-as-expected
    // (correct validation, passed rows), its exit 0 on the reject-expected
    // empty string is unexpected-exit-0 (the no-op acceptance, a failed
    // row), and only the exit-0-expected crashes stay crashed-exit.
    const advFx = join(sandbox, 'adv-fx')
    mkdirSync(advFx, { recursive: true })
    const advArtifacts = join(advFx, 'artifacts')
    const advEnv = directEnv(advArtifacts)
    const advWs = directLease(advFx)

    // Determinism of the generator itself, token-free (the exported pure
    // function recomputed here, never trusted from the bundle).
    const advSeedCases = generateAdversarialCases(42)
    t(`P3 (T-032): generateAdversarialCases determinism — two invocations with the same seed produce byte-identical lists of exactly ADVERSARIAL_PROBE_CASE_COUNT (${ADVERSARIAL_PROBE_CASE_COUNT})`,
      eq(advSeedCases, generateAdversarialCases(42)) && advSeedCases.length === ADVERSARIAL_PROBE_CASE_COUNT)
    t(`P3 (T-032): the length bound — over several seeds, every generated case's length is <= ADVERSARIAL_PROBE_MAX_CASE_CHARS (${ADVERSARIAL_PROBE_MAX_CASE_CHARS})`,
      [7, 42, 43, 2026, 999331].every((s) => generateAdversarialCases(s).every((c) => c.length <= ADVERSARIAL_PROBE_MAX_CASE_CHARS)))

    // The known-weak-spot fuzzee fixture (generated per run of this check;
    // the same source the P5 e2e fixture repos carry).
    writeFileSync(join(advFx, 'adv-fuzzee.js'), ADV_FUZZEE_SOURCE)
    const advScenario = (id, seed) => ({ id, type: 'adversarial', command: { exe: process.execPath, args: ['adv-fuzzee.js'] }, seed })

    // Crash face — the weak-spot fixture: the T-062 outcome classes over the
    // independently-known weak-spot subset. The fuzzee VALIDATES the
    // malformed corpus inputs (rejected-as-expected, passed rows), accepts
    // the reject-expected empty string (unexpected-exit-0, the FIRST
    // breaking case), and crashes the exit-0-expected non-finite cases.
    const advCrash = await runDirect(advScenario('adv-crash', 42), advWs, advEnv)
    const advExpectedOutcomes = advFuzzeeOutcomes(advSeedCases)
    const advSeedExpectations = adversarialCaseExpectations(advSeedCases)
    const advExpectedFailedIdx = advIdxWhere(advExpectedOutcomes, ['crashed-exit', 'unexpected-exit-0'])
    const advExpectedPassedIdx = advIdxWhere(advExpectedOutcomes, ['survived', 'rejected-as-expected'])
    const advExpectedCrashedIdx = advIdxWhere(advExpectedOutcomes, ['crashed-exit'])
    const advExpectedRejectedIdx = advIdxWhere(advExpectedOutcomes, ['rejected-as-expected'])
    const advExpectedUnexpectedIdx = advIdxWhere(advExpectedOutcomes, ['unexpected-exit-0'])
    const advCrashResultsRef = advCrash.artifacts.find((a) => a.kind === 'report')
    const advCrashResults = advCrashResultsRef !== undefined && existsSync(advCrashResultsRef.path)
      ? JSON.parse(read(advCrashResultsRef.path))
      : null
    t('P3 (T-032/T-062): crash face — the weak-spot fuzzee under expectations: success false (the empty-string acceptance breaks first), error names the FIRST breaking case with the T-062 vocabulary',
      advCrash.success === false
      && advExpectedFailedIdx.length > 0 && advExpectedFailedIdx.length < ADVERSARIAL_PROBE_CASE_COUNT
      && advExpectedRejectedIdx.length > 0
      && advCrash.error === advFuzzeeFirstError(advExpectedOutcomes))
    t('P3 (T-032/T-062): crash face — exactly the crashed-exit + unexpected-exit-0 cases recorded as failed <id>#case-<i> rows (in case order), every survived AND rejected-as-expected row passed',
      advCrash.gateResults.length === ADVERSARIAL_PROBE_CASE_COUNT
      && eq(advCrash.gateResults.filter((g) => !g.passed).map((g) => g.name), advExpectedFailedIdx.map((i) => `adv-crash#case-${i}`))
      && eq(advCrash.gateResults.filter((g) => g.passed).map((g) => g.name), advExpectedPassedIdx.map((i) => `adv-crash#case-${i}`)))
    t('P3 (T-032/T-062): crash face — cases-crashed keeps its T-032 meaning (crashed-exit only, the malformed-input exits NOT merged into it), cases-rejected and cases-unexpected-exit-0 counted honestly beside it, cases-run the full count, durations unit ms',
      advCrash.measurements.some((m) => m.name === 'cases-crashed' && m.unit === 'cases' && m.value === advExpectedCrashedIdx.length)
      && advCrash.measurements.some((m) => m.name === 'cases-rejected' && m.unit === 'cases' && m.value === advExpectedRejectedIdx.length)
      && advCrash.measurements.some((m) => m.name === 'cases-unexpected-exit-0' && m.unit === 'cases' && m.value === advExpectedUnexpectedIdx.length)
      && advCrash.measurements.some((m) => m.name === 'cases-run' && m.unit === 'cases' && m.value === ADVERSARIAL_PROBE_CASE_COUNT)
      && advCrash.measurements.filter((m) => /^case-\d+ duration$/.test(m.name)).length === ADVERSARIAL_PROBE_CASE_COUNT
      && advCrash.measurements.every((m) => m.unit === (/^cases-/.test(m.name) ? 'cases' : 'ms')))
    t('P3 (T-032/T-062): crash face — the report-kind results artifact parses; its recorded inputs match the recomputed list case-for-case (every input bounded); expectations match the recomputed list; outcomes match the independently-derived expectation-aware mapping; the count fields agree',
      advCrashResultsRef !== undefined && advCrashResultsRef.kind === 'report' && advCrashResultsRef.sizeBytes > 0
      && advCrashResultsRef.name === 'adv-crash.results.json'
      && advCrashResultsRef.path === join(advArtifacts, 'probes', 'direct', 'adv-crash.results.json')
      && advCrashResults !== null
      && advCrashResults.probeId === 'adv-crash' && advCrashResults.scenarioId === 'adv-crash' && advCrashResults.seed === 42
      && advCrashResults.casesRun === ADVERSARIAL_PROBE_CASE_COUNT && advCrashResults.casesCrashed === advExpectedCrashedIdx.length
      && advCrashResults.casesRejected === advExpectedRejectedIdx.length && advCrashResults.casesUnexpectedExit0 === advExpectedUnexpectedIdx.length
      && advCrashResults.cases.length === ADVERSARIAL_PROBE_CASE_COUNT
      && advCrashResults.cases.every((r, i) => r.index === i + 1 && r.input === advSeedCases[i])
      && advCrashResults.cases.every((r) => r.input.length <= ADVERSARIAL_PROBE_MAX_CASE_CHARS)
      && advCrashResults.cases.every((r, i) => r.expectation === advSeedExpectations[i])
      && advCrashResults.cases.every((r, i) => r.outcome === advExpectedOutcomes[i])
      && advCrashResults.cases.every((r) => typeof r.durationMs === 'number'))
    t('P3 (T-032): the crash bundle passes the validator and its combined .log carries the === case <i> === separators',
      validateEvidenceBundle(JSON.parse(JSON.stringify(advCrash))).success === false
      && advCrash.artifacts[0]?.kind === 'log' && advCrash.artifacts[0]?.sizeBytes > 0
      && read(advCrash.artifacts[0]?.path).includes('=== case 1 ===')
      && read(advCrash.artifacts[0]?.path).includes(`=== case ${ADVERSARIAL_PROBE_CASE_COUNT} ===`))

    // Replayability — two same-seed runs against the same fixture agree
    // case-for-case on outcome (a replayable crash list). Names are
    // normalized to their case index: each run's rows are self-named with
    // that run's own probe id, so the comparison is case-index + outcome.
    const advReplay = await runDirect(advScenario('adv-replay', 42), advWs, advEnv)
    const outcomeShape = (bundle) => bundle.gateResults.map((g) => [g.name.split('#case-')[1], g.passed])
    t('P3 (T-032): replayability — two same-seed probe runs against the same fixture agree case-for-case on outcome',
      advReplay.success === false
      && eq(outcomeShape(advReplay), outcomeShape(advCrash))
      && advReplay.error === advCrash.error)

    // No-op face — the T-062 flip of the old "no-crash face": a target that
    // exits 0 on EVERY input without ever reading argv was probe-success
    // before T-062 (register R16's undetectable no-op handler, the exact
    // inversion the ticket fixes). Since T-062 the engine-authored corpus
    // expects rejection of the invalid-by-construction inputs, so this
    // target records exactly the reject-expected cases as unexpected-exit-0
    // (failed rows, probe success false) while every exit-0-expected case
    // still survives — validation is detectable, no-op is not rewardable.
    writeFileSync(join(advFx, 'adv-robust.js'), [
      "console.log('robust got ' + JSON.stringify(process.argv[2] ?? ''))",
      "console.log('survived')",
    ].join('\n') + '\n')
    const advRobust = await runDirect({ id: 'adv-robust', type: 'adversarial', command: { exe: process.execPath, args: ['adv-robust.js'] }, seed: 7 }, advWs, advEnv)
    const advRobustCases = generateAdversarialCases(7)
    const advRobustExpectations = adversarialCaseExpectations(advRobustCases)
    const advRobustNoopOutcomes = advRobustCases.map((_, i) => (advRobustExpectations[i] === 'reject' ? 'unexpected-exit-0' : 'survived'))
    const advRobustUnexpectedIdx = advIdxWhere(advRobustNoopOutcomes, ['unexpected-exit-0'])
    t('P3 (T-062): no-op face — a target that never reads argv: success FALSE (the T-032-era success true was R16\'s inversion), exactly the reject-expected cases recorded unexpected-exit-0 with failed rows and error naming case 1, every exit-0-expected case survived and passed',
      advRobust.success === false
      && advRobust.error === `case 1/${ADVERSARIAL_PROBE_CASE_COUNT} exited 0 where rejection was expected (input invalid by construction)`
      && advRobust.gateResults.length === ADVERSARIAL_PROBE_CASE_COUNT
      && eq(advRobust.gateResults.filter((g) => !g.passed).map((g) => g.name), advRobustUnexpectedIdx.map((i) => `adv-robust#case-${i}`))
      && advRobust.gateResults.filter((g) => !g.passed).every((g) => g.exitCode === 0)
      && advRobust.measurements.some((m) => m.name === 'cases-run' && m.value === ADVERSARIAL_PROBE_CASE_COUNT)
      && advRobust.measurements.some((m) => m.name === 'cases-crashed' && m.value === 0)
      && advRobust.measurements.some((m) => m.name === 'cases-rejected' && m.value === 0)
      && advRobust.measurements.some((m) => m.name === 'cases-unexpected-exit-0' && m.value === advRobustUnexpectedIdx.length)
      && advRobust.measurements.filter((m) => /^case-\d+ duration$/.test(m.name)).length === ADVERSARIAL_PROBE_CASE_COUNT
      && validateEvidenceBundle(JSON.parse(JSON.stringify(advRobust))).success === false)

    // Spawn-refusal / zero-completed face — a non-existent exe: success
    // false with ZERO case durations, never a pass (AGENTS.md #7).
    const advRefused = await runDirect({ id: 'adv-refused', type: 'adversarial', command: { exe: 'definitely-not-a-real-exe-4f8a2b', args: [] }, seed: 42 }, advWs, advEnv)
    t(`P3 (T-032/T-062): spawn-refusal / zero-completed face — a non-existent exe: success false, zero case-<i> durations, cases-run 0, cases-crashed/rejected/unexpected-exit-0 all 0 (a refusal is never survival on any expectation), every row spawn-refused, error names case 1, never a pass`,
      advRefused.success === false
      && advRefused.measurements.filter((m) => /^case-\d+ duration$/.test(m.name)).length === 0
      && advRefused.measurements.some((m) => m.name === 'cases-run' && m.value === 0)
      && advRefused.measurements.some((m) => m.name === 'cases-crashed' && m.value === 0)
      && advRefused.measurements.some((m) => m.name === 'cases-rejected' && m.value === 0)
      && advRefused.measurements.some((m) => m.name === 'cases-unexpected-exit-0' && m.value === 0)
      && advRefused.gateResults.length === ADVERSARIAL_PROBE_CASE_COUNT
      && advRefused.gateResults.every((g, i) => g.name === `adv-refused#case-${i + 1}` && !g.passed && g.exitCode === null)
      && typeof advRefused.error === 'string'
      && advRefused.error.startsWith(`case 1/${ADVERSARIAL_PROBE_CASE_COUNT} could not be spawned: `)
      && advRefused.error.length > `case 1/${ADVERSARIAL_PROBE_CASE_COUNT} could not be spawned: `.length)

    // A directly constructed adversarial scenario without seed is refused by
    // the class itself (the parseJobsSpec contract held at the class too —
    // the screenshot/web precedent; never a silent unseeded fuzz).
    let advContractThrow = ''
    try {
      await runDirect({ id: 'adv-noseed', type: 'adversarial', command: { exe: process.execPath, args: [] } }, advWs, advEnv)
    } catch (e) {
      advContractThrow = e instanceof Error ? e.message : String(e)
    }
    t('P3 (T-032): a directly constructed adversarial scenario without seed is refused by the class itself (never silently run)',
      advContractThrow.includes('seed must be a positive integer >= 1'))

    // Timeout face — the P4 sleeper pattern with its process-table
    // assertions: the generated target sleeps past timeoutMs on exactly the
    // first case (the corpus leads with the empty string — the trigger is
    // embedded exactly) and exits 0 on every other case, so one short
    // budget covers the face. The spawned tree (parent + child) is what the
    // tree kill must reap; kill evidence rides that case's entry.
    writeFileSync(join(advFx, 'adv-timeout-target.js'), [
      "const { spawn } = require('node:child_process')",
      `const trigger = ${JSON.stringify(advSeedCases[0])}`,
      "const arg = process.argv[2] ?? ''",
      'if (arg === trigger) {',
      "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })",
      "  console.log('PARENT_PID=' + process.pid)",
      "  console.log('CHILD_PID=' + child.pid)",
      '  setInterval(() => {}, 1000)',
      '} else {',
      "  console.log('survived')",
      '}',
    ].join('\n') + '\n')
    const advTimeoutMs = 1200
    const advTimedOut = await runDirect({ id: 'adv-slow', type: 'adversarial', command: { exe: process.execPath, args: ['adv-timeout-target.js'] }, seed: 42, timeoutMs: advTimeoutMs }, advWs, advEnv)
    const advSlowLog = advTimedOut.artifacts.find((a) => a.kind === 'log')
    const advPids = (advSlowLog !== undefined && existsSync(advSlowLog.path))
      ? [...read(advSlowLog.path).matchAll(/(?:PARENT|CHILD)_PID=(\d+)/g)].map((m) => Number(m[1]))
      : []
    const advParentDead = advPids[0] !== undefined && await untilDead(advPids[0])
    const advChildDead = advPids[1] !== undefined && await untilDead(advPids[1])
    if (advPids[0] !== undefined && !advParentDead) sweep(advPids[0])
    if (advPids[1] !== undefined && !advChildDead) sweep(advPids[1])
    t('P3 (T-032): timeout face — a case that sleeps past timeoutMs: success false, error names the timing-out case, that case\'s GateResult exitCode null with durationMs >= timeoutMs and its duration still recorded',
      advTimedOut.success === false
      && advTimedOut.error === `case 1/${ADVERSARIAL_PROBE_CASE_COUNT} timed out after ${advTimeoutMs}ms`
      && advTimedOut.gateResults.length === ADVERSARIAL_PROBE_CASE_COUNT
      && advTimedOut.gateResults[0]?.name === 'adv-slow#case-1'
      && advTimedOut.gateResults[0]?.exitCode === null
      && advTimedOut.gateResults[0]?.durationMs >= advTimeoutMs
      && advTimedOut.measurements.some((m) => m.name === 'case-1 duration' && m.value >= advTimeoutMs)
      && advTimedOut.measurements.some((m) => m.name === 'cases-crashed' && m.value === 1)
      && advTimedOut.measurements.some((m) => m.name === 'cases-run' && m.value === ADVERSARIAL_PROBE_CASE_COUNT))
    await assertProbeTreeDead('P3 (T-032): timeout face — the whole spawned tree is verified dead on the real process table',
      advPids, advParentDead, advChildDead)
    t("P3 (T-032): timeout face — kill evidence is on that case's GateResult entry: a verified kill leaves cleanupFailures absent, an unproven one records loud CLEANUP FAIL lines",
      advTimedOut.gateResults[0]?.cleanupFailures === undefined
      || (Array.isArray(advTimedOut.gateResults[0]?.cleanupFailures) && advTimedOut.gateResults[0]?.cleanupFailures.every((l) => l.startsWith('CLEANUP FAIL'))))
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
    await assertProbeTreeDead('P4: timeout — the whole spawned tree is verified dead on the real process table',
      pids, parentDead, childDead)
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
    await assertProbeTreeDead('P4: benchmark timeout — the whole spawned tree is verified dead on the real process table',
      benchPids, benchParentDead, benchChildDead)
    t('P4: benchmark timeout — kill evidence is on that repeat\'s GateResult entry: a verified kill leaves cleanupFailures absent, an unproven one records loud CLEANUP FAIL lines',
      benchTimedOut.gateResults[0]?.cleanupFailures === undefined
      || (Array.isArray(benchTimedOut.gateResults[0]?.cleanupFailures) && benchTimedOut.gateResults[0]?.cleanupFailures.every((l) => l.startsWith('CLEANUP FAIL'))))
  }

  // ---------- P5: evidence emission in a real pipeline (--jobs drives) ----------
  {
    // Scenario A: passing gates; one job with a PASSING and a FAILING probe,
    // a PASSING benchmark probe (T-018), a PASSING screenshot probe
    // (T-019), a PASSING web probe (T-024), and a FAILING adversarial probe
    // (T-032 — a passing-gates/failing-adversarial job still passes); its
    // sibling job carries a FAILING benchmark, a FAILING screenshot, and a
    // FAILING web probe — survival must stay untouched by probe outcomes.
    const a = makeRepo('e2e')
    // T-024 e2e servers: inline `node -e` sources traveling as argv
    // (token-free), each bound to a free port this check picks.
    const e2ePortA = await freePort()
    const e2ePortB = await freePort()
    const e2eWebServer = (port, status, body) =>
      `require('node:http').createServer((q,s)=>{s.writeHead(${status},{'content-type':'text/plain'});s.end('${body}')}).listen(${port},'127.0.0.1',()=>console.log('SERVER_PID='+process.pid))`
    // T-032 e2e fuzzee: the fixture repo's own adv-fuzzee.js (makeRepo writes
    // ADV_FUZZEE_SOURCE into every fixture repo) — script-file mode, so the
    // appended case is the script's argv[2] and node's option parsing never
    // sees leading-'-' cases. Same weak-spot class as the P3 fixture, so the
    // crash subset is independently derivable from the recomputed seed-7
    // list.
    const specA = {
      phases: [{ id: 'p' }],
      jobs: [
        {
          id: 'job-a', phase: 'p', brief: 'do A',
          probes: [
            { id: 'build-check', type: 'command', command: { exe: 'node', args: ['build.js'] } },
            { id: 'tap-fail-check', type: 'test', command: { exe: 'node', args: ['tap-fail.js'] } },
            { id: 'bench-check', type: 'benchmark', command: { exe: 'node', args: ['build.js'] }, repeats: 2 },
            copyCapture('shot-check', 'shot-e2e.png'),
            { id: 'web-check', type: 'web', command: { exe: process.execPath, args: ['-e', e2eWebServer(e2ePortA, 200, 'e2e-web-ok')] }, url: `http://127.0.0.1:${e2ePortA}/`, timeoutMs: 8000 },
            { id: 'adv-check', type: 'adversarial', command: { exe: 'node', args: ['adv-fuzzee.js'] }, seed: 7 },
          ],
        },
        {
          id: 'job-b', phase: 'p', brief: 'do B',
          probes: [
            { id: 'tap-pass-check', type: 'test', command: { exe: 'node', args: ['tap-pass.js'] } },
            { id: 'bench-fail-check', type: 'benchmark', command: { exe: 'node', args: ['-e', "console.log('slow-boom'); process.exit(9)"] }, repeats: 1 },
            { id: 'shot-fail-check', type: 'screenshot', capture: 'never.png', command: { exe: process.execPath, args: ['-e', 'process.exit(7)'] } },
            { id: 'web-fail-check', type: 'web', command: { exe: process.execPath, args: ['-e', e2eWebServer(e2ePortB, 500, 'e2e-web-bad')] }, url: `http://127.0.0.1:${e2ePortB}/`, timeoutMs: 8000 },
          ],
        },
      ],
    }
    const workerA = fakeWorker()
    const rA = await drive('e2e-run', { repo: a.repo, baseSha: a.baseSha, scheduled: buildScheduled(specA, { worker: workerA, gates: [passGate] }), worker: workerA })
    const cA = rA.report.candidates.find((c) => c.id === 'job-a')
    const cB = rA.report.candidates.find((c) => c.id === 'job-b')
    t('P5: a passing-gates/failing-probe job still PASSES — probe results never enter a verdict',
      cA?.passedAllGates === true && cA?.gates.every((g) => g.passed) === true && cA?.probes?.length === 6)
    t('P5: the report carries per-probe summaries {probeId, scenarioId, success, durationMs, bundlePath} in spec order (benchmark + screenshot + web + adversarial included, T-018/T-019/T-024/T-032)',
      eq(cA?.probes?.map((p) => [p.probeId, p.scenarioId, p.success]),
        [['build-check', 'build-check', true], ['tap-fail-check', 'tap-fail-check', false], ['bench-check', 'bench-check', true], ['shot-check', 'shot-check', true], ['web-check', 'web-check', true], ['adv-check', 'adv-check', false]])
      && typeof cA?.probes?.[0]?.durationMs === 'number'
      && typeof cA?.probes?.[1]?.durationMs === 'number'
      && typeof cA?.probes?.[2]?.durationMs === 'number'
      && typeof cA?.probes?.[3]?.durationMs === 'number'
      && typeof cA?.probes?.[4]?.durationMs === 'number'
      && typeof cA?.probes?.[5]?.durationMs === 'number')
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
      JSON.parse(read(join(rA.artifactsDir, 'report.json'))).candidates.find((c) => c.id === 'job-a')?.probes?.length === 6)
    t('P5: a passing job\'s probes[] record each outcome while survival stays untouched',
      cB?.passedAllGates === true && cB?.probes?.length === 4 && cB?.probes?.[0]?.success === true)

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

    // T-019: the screenshot probe in a real pipeline — bundle
    // correspondence, the durable copy under the artifacts dir (NEVER
    // inside the worktree — the copy happens inside run(), before dispose),
    // and survival untouched by the screenshot outcome.
    const shotBundleA = JSON.parse(read(join(rA.artifactsDir, 'probes', 'job-a', 'shot-check.json')))
    const shotImgA = shotBundleA.artifacts?.find((a2) => a2.kind === 'screenshot')
    const worktreeA = cA?.workspacePath
    t('P5: the screenshot bundle is validator-clean with one GateResult entry, and its success agrees with the summary',
      validateEvidenceBundle(shotBundleA).success === true
      && shotBundleA.success === true
      && cA?.probes?.some((p) => p.probeId === 'shot-check' && p.success === true)
      && shotBundleA.gateResults.length === 1
      && shotBundleA.gateResults[0]?.exitCode === 0)
    t('P5: the image artifact is a kind-"screenshot" copy at <artifactsDir>/probes/<candidateId>/<probeId>.png — under the artifacts dir, NEVER inside the worktree — and exists on disk at report time with the source size and the PNG magic re-verified',
      shotImgA !== undefined
      && shotImgA.name === 'shot-check.png'
      && shotImgA.path === join(rA.artifactsDir, 'probes', 'job-a', 'shot-check.png')
      && typeof worktreeA === 'string' && worktreeA.length > 0 && !shotImgA.path.startsWith(worktreeA)
      && existsSync(shotImgA.path)
      && shotImgA.sizeBytes === shotFixtureBytes.length
      && readFileSync(shotImgA.path).subarray(0, 8).equals(PNG_MAGIC))
    const shotFailBundleB = JSON.parse(read(join(rA.artifactsDir, 'probes', 'job-b', 'shot-fail-check.json')))
    t('P5: a passing-gates/FAILING-screenshot job still PASSES — the screenshot outcome never enters a verdict',
      cB?.passedAllGates === true
      && cB?.probes?.[2]?.success === false
      && validateEvidenceBundle(shotFailBundleB).success === false
      && shotFailBundleB.error === 'capture command exited with code 7')

    // T-024: the web probe in a real pipeline — bundle correspondence, the
    // response artifact under the artifacts dir (NEVER inside the worktree —
    // the durable-copy rule; the workspace is disposed after the attempt
    // loop), and survival untouched by the web outcome.
    const webBundleA = JSON.parse(read(join(rA.artifactsDir, 'probes', 'job-a', 'web-check.json')))
    const webRespA = webBundleA.artifacts?.find((a2) => a2.kind === 'report')
    t('P5: the web bundle is validator-clean with one GateResult entry, its success agrees with the summary, and its response artifact is on disk under the artifacts dir — NEVER inside the worktree — parsing to the captured values',
      validateEvidenceBundle(webBundleA).success === true
      && webBundleA.success === true
      && cA?.probes?.some((p) => p.probeId === 'web-check' && p.success === true)
      && webBundleA.measurements.some((m) => m.name === 'http status' && m.value === 200)
      && webRespA !== undefined
      && webRespA.name === 'web-check.response.json'
      && webRespA.path === join(rA.artifactsDir, 'probes', 'job-a', 'web-check.response.json')
      && typeof worktreeA === 'string' && worktreeA.length > 0 && !webRespA.path.startsWith(worktreeA)
      && existsSync(webRespA.path)
      && JSON.parse(read(webRespA.path)).bodySnippet === 'e2e-web-ok')
    const webFailBundleB = JSON.parse(read(join(rA.artifactsDir, 'probes', 'job-b', 'web-fail-check.json')))
    t('P5: a passing-gates/FAILING-web job still PASSES — the web outcome never enters a verdict',
      cB?.passedAllGates === true
      && cB?.probes?.[3]?.success === false
      && validateEvidenceBundle(webFailBundleB).success === false
      && typeof webFailBundleB.error === 'string' && webFailBundleB.error.includes('500'))

    // T-032: the adversarial probe in a real pipeline — bundle
    // correspondence, the on-disk 'report' per-case results artifact (every
    // recorded input bounded and matching the recomputed seed-7 list), and
    // survival untouched by the adversarial outcome. Since T-062 the
    // expected outcomes/counts are derived through the recomputed
    // expectations (the P3 expectation-aware derivation): the fuzzee
    // validates the malformed corpus inputs (rejected-as-expected), accepts
    // the reject-expected empty string (unexpected-exit-0 — the FIRST
    // breaking case at seed 7), and crashes the exit-0-expected subset.
    const advBundleA = JSON.parse(read(join(rA.artifactsDir, 'probes', 'job-a', 'adv-check.json')))
    const advReportA = advBundleA.artifacts?.find((a2) => a2.kind === 'report')
    const advE2eCases = generateAdversarialCases(7)
    const advE2eOutcomes = advFuzzeeOutcomes(advE2eCases)
    const advE2eExpectations = adversarialCaseExpectations(advE2eCases)
    const advE2eCrashed = advIdxWhere(advE2eOutcomes, ['crashed-exit']).length
    const advE2eRejected = advIdxWhere(advE2eOutcomes, ['rejected-as-expected']).length
    const advE2eUnexpected = advIdxWhere(advE2eOutcomes, ['unexpected-exit-0']).length
    t('P5: the adversarial bundle is validator-clean (success false), its summary agrees — carrying casesRejected, one GateResult row per case self-named <id>#case-<i>, error names the FIRST breaking case, and the counts match the independently recomputed expectation-aware seed-7 derivation',
      validateEvidenceBundle(advBundleA).success === false
      && cA?.probes?.[5]?.success === false && cA?.probes?.[5]?.probeId === 'adv-check'
      && cA?.probes?.[5]?.casesRejected === advE2eRejected
      && advBundleA.error === advFuzzeeFirstError(advE2eOutcomes)
      && advBundleA.measurements.some((m) => m.name === 'cases-run' && m.value === ADVERSARIAL_PROBE_CASE_COUNT)
      && advBundleA.measurements.some((m) => m.name === 'cases-crashed' && m.value === advE2eCrashed)
      && advBundleA.measurements.some((m) => m.name === 'cases-rejected' && m.value === advE2eRejected)
      && advBundleA.measurements.some((m) => m.name === 'cases-unexpected-exit-0' && m.value === advE2eUnexpected)
      && advBundleA.gateResults.length === ADVERSARIAL_PROBE_CASE_COUNT
      && advBundleA.gateResults.every((g, i) => g.name === `adv-check#case-${i + 1}`))
    t('P5: the adversarial report-kind results artifact is real on disk (under the artifacts dir), parses, records the seed, and every recorded input is bounded by ADVERSARIAL_PROBE_MAX_CASE_CHARS and matches the recomputed list case-for-case, expectations and outcomes matching the expectation-aware derivation',
      advReportA !== undefined && advReportA.kind === 'report' && advReportA.name === 'adv-check.results.json'
      && advReportA.path === join(rA.artifactsDir, 'probes', 'job-a', 'adv-check.results.json')
      && typeof cA?.workspacePath === 'string' && cA.workspacePath.length > 0 && !advReportA.path.startsWith(cA.workspacePath)
      && advReportA.sizeBytes > 0 && existsSync(advReportA.path)
      && (() => {
        const table = JSON.parse(read(advReportA.path))
        return table.probeId === 'adv-check' && table.scenarioId === 'adv-check' && table.seed === 7
          && table.casesRun === ADVERSARIAL_PROBE_CASE_COUNT && table.casesCrashed === advE2eCrashed
          && table.casesRejected === advE2eRejected && table.casesUnexpectedExit0 === advE2eUnexpected
          && table.cases.length === ADVERSARIAL_PROBE_CASE_COUNT
          && table.cases.every((r, i) => r.index === i + 1 && r.input === advE2eCases[i])
          && table.cases.every((r) => r.input.length <= ADVERSARIAL_PROBE_MAX_CASE_CHARS)
          && table.cases.every((r, i) => r.expectation === advE2eExpectations[i] && r.outcome === advE2eOutcomes[i])
      })())
    t('P5: a passing-gates/FAILING-adversarial job still PASSES — the adversarial outcome never enters a verdict',
      cA?.passedAllGates === true
      && cA?.gates.every((g) => g.passed) === true
      && advBundleA.success === false)

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
