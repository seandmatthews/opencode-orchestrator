// Yield instrumentation self-check (Gate 1.36, fast tier, T-049) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-yield.mjs
// Pins the 2026-10-23 adversarial review's A2 instrument: a machine-derived,
// additive, producer-only `RunReport.yield` block (the rounds/earlyStops
// pattern) so per-run yield stops being anecdote — counts derived purely from
// data the report already holds (the ladder vocabulary, the store's
// elimination reasons, src/store/index.ts eliminationReason), plus one
// evidence-only derailment marker: a no-op attempt (workerOk && diffBytes
// === 0, AGENTS.md #7's machine-known class) whose worker.log carries the
// harness's recorded external_directory auto-reject line gets a note citing
// the marker literal. Deterministic string match on recorded bytes — a
// HEURISTIC, labeled one: the marker names the Known issue #6 containment
// class, never a verdict (no ladder line reads the block; decisions.md
// 2026-10-10 gates decide survival). Store columns, dashboard tiles, and
// cross-run aggregation are carved (later slices; the report is this slice's
// durable copy). Zero model tokens: synthetic reports drive the pure
// derivation (src/yield.ts) and two real runSkeleton drives (fake
// WorkerAdapter + real CommandGate + real WorktreeProvider, the
// check-gate-overlap pattern) pin the producer end to end. On main
// (pre-T-049) src/yield.ts does not exist and no report carries the block —
// exactly the red bar this check was recorded against at the lane. All git
// calls list-form (AGENTS.md #4); sandbox removed at the end (AGENTS.md #10).
import { swarmRoot } from './swarm-root.mjs'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const sandbox = swarmRoot + '/verify-yield'
const IDENTITY = ['-c', 'user.name=check-yield', '-c', 'user.email=yield@local']

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// The derivation module is the unit under test. On main it does not exist;
// the dynamic import's caught failure is the red bar's first face (a static
// import would crash the whole check before any assertion could print).
let deriveRunYield = null
let DERAILMENT_MARKER = null
try {
  ;({ deriveRunYield, DERAILMENT_MARKER } = await import('../src/yield.ts'))
} catch {
  // pre-T-049 main: src/yield.ts absent — every leg below fails loudly.
}

// The recorded auto-reject line, byte-for-byte as it appears in real
// worker.logs (ANSI warning prefix included; run 20261024021432's c02-r2
// instance, recorded verbatim in VERIFICATION.md's Known issue #6 2026-10-24
// entry; the same harness frame byte-checked on disk in run 20261010235146's
// c02/c03 worker.logs). The path inside the parens is per-run; the matched
// marker is the stable frame prefix (see Y1).
const MARKER_LINE =
  '\x1b[93m\x1b[1m! \x1b[0mpermission requested: external_directory (C:\\swarm\\verify\\20261024021432\\wt\\c02\\r2\\*); auto-rejecting'

// ---- synthetic-report builders (the verify.mjs makeIntRun shape discipline:
// every field the real report carries, no more) ----
const gate = (name, passed) => ({
  name, passed, exitCode: passed ? 0 : 1, durationMs: 5,
  outputTail: `${name}: ${passed ? 'ok' : 'FAIL'}`, command: `node ${name}.js`,
})
const att = (id, n, { failure, artifacts = [], gateResults } = {}) => ({
  id,
  jobId: id.replace(/-a\d+$/, ''),
  number: n,
  state: failure ? 'failed' : 'succeeded',
  startedAt: '2026-10-24T00:00:00.000Z',
  endedAt: '2026-10-24T00:00:05.000Z',
  inputContextHash: '0'.repeat(64),
  promptVersion: '1'.repeat(64),
  outputArtifacts: artifacts,
  ...(failure ? { failure } : {}),
  ...(gateResults ? { gateResults } : {}),
})
const cand = (id, o) => ({
  id, workerId: 'opencode', model: 'fake/model', brief: 'b', workspacePath: null,
  workerOk: o.workerOk, workerTimedOut: false, workerDurationMs: 5000,
  diffPath: o.diffPath ?? null, diffBytes: o.diffBytes,
  gates: o.gates ?? [], passedAllGates: o.passedAllGates,
  attempts: o.attempts,
})
const report = (candidates, extra = {}) => ({
  runId: '20991224010000', repo: 'C:/swarm/synth', baseSha: '0'.repeat(40),
  goal: 'synthetic fixture goal', model: 'fake/model',
  startedAt: '2026-10-24T00:00:00.000Z', finishedAt: '2026-10-24T00:01:00.000Z',
  candidates,
  ...extra,
})

// Evidence files the synthetic attempts point at (real bytes on disk — the
// marker scan reads the attempt's own worker.log, exactly as the runner
// does; the paths carry the runner's exact basename convention, one evidence
// dir per candidate with worker.log inside it).
const logsDir = join(sandbox, 'logs')
mkdirSync(join(logsDir, 'c04'), { recursive: true })
mkdirSync(join(logsDir, 'c02-r2'), { recursive: true })
mkdirSync(join(logsDir, 'clean'), { recursive: true })
const markerLog = join(logsDir, 'c04', 'worker.log')
writeFileSync(markerLog, `worker exploring\n${MARKER_LINE}\nworker gave up without editing\n`)
const markerLogR2 = join(logsDir, 'c02-r2', 'worker.log')
writeFileSync(markerLogR2, `worker reading lease\n${MARKER_LINE}\n`)
const cleanLog = join(logsDir, 'clean', 'worker.log')
writeFileSync(cleanLog, 'worker call 1\nno permission events\n')
const zeroDiffPatch = join(logsDir, 'zero.diff.patch')
writeFileSync(zeroDiffPatch, '')

// The green arithmetic fixture (the ticket's exact five-candidate shape):
// one survivor, one gate-failed candidate, one worker-failed candidate, one
// no-op (workerOk, zero diff), one retried-then-survived candidate.
const ARITH = report([
  cand('c01', { workerOk: true, diffBytes: 900, gates: [gate('build', true), gate('test', true)], passedAllGates: true,
    attempts: [att('c01-a1', 1)] }),
  cand('c02', { workerOk: true, diffBytes: 500, gates: [gate('build', true), gate('test', false)], passedAllGates: false,
    attempts: [att('c02-a1', 1)] }),
  cand('c03', { workerOk: false, diffBytes: 0, gates: [gate('build', true), gate('test', true)], passedAllGates: false,
    attempts: [att('c03-a1', 1, { failure: { reason: 'worker-failed', message: 'worker exited with code 1', timedOut: false, exitCode: 1 } })] }),
  cand('c04', { workerOk: true, diffBytes: 0, diffPath: zeroDiffPatch, gates: [gate('build', true), gate('test', true)], passedAllGates: false,
    attempts: [att('c04-a1', 1, { artifacts: [markerLog, zeroDiffPatch] })] }),
  cand('c05', { workerOk: true, diffBytes: 700, gates: [gate('build', true), gate('test', true)], passedAllGates: true,
    attempts: [
      att('c05-a1', 1, { failure: { reason: 'gates-failed', message: 'machine gates rejected the change (test); one feedback-informed retry follows', timedOut: false, exitCode: 1 }, gateResults: [gate('build', true), gate('test', false)] }),
      att('c05-a2', 2),
    ] }),
])
// c05's gateRetry is optional evidence; attach it the way the runner would
// (the cand builder picks only the ladder fields).
ARITH.candidates[4].gateRetry = { fromAttempt: 1, toAttempt: 2, gates: ['test'], fingerprint: '2'.repeat(64), findings: { count: 0, included: 0, ok: false } }

// A fake WorkerAdapter (the check-gate-overlap pattern): one scripted step
// per call, replaying the last once the script runs out. The no-op drive's
// step writes NOTHING (workerOk, zero diff — the derailment shape); the
// clean drive's step edits one file.
function fakeWorker(steps) {
  const calls = []
  return {
    id: 'fake',
    calls,
    async execute(req) {
      calls.push(req.cwd)
      try {
        writeFileSync(req.logPath, `fake worker call ${calls.length}\n`)
      } catch {
        // Logging must never break a run.
      }
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]
      for (const w of step.writes ?? []) writeFileSync(join(req.cwd, w.file), w.content)
      const ok = step.ok ?? true
      return {
        ok, exitCode: ok ? 0 : 1, timedOut: false, durationMs: 5,
        logPath: req.logPath, responseTail: `fake response ${calls.length}`,
      }
    },
  }
}

// One throwaway fixture repo per drive (the check-gate-overlap drive shape):
// the REAL WorktreeProvider, real CommandGates, the real runner; only the
// worker is fake.
async function drive(name, { worker, gates }) {
  const scenarioDir = join(sandbox, name)
  const repo = join(scenarioDir, 'repo')
  const artifactsDir = join(scenarioDir, 'run')
  mkdirSync(repo, { recursive: true })
  const { execFileSync } = await import('node:child_process')
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '-b', 'main')
  writeFileSync(join(repo, 'test.js'), 'if (1 + 1 !== 2) { process.exit(1) }\nconsole.log("tests ok")\n')
  git(...IDENTITY, 'add', '-A')
  git(...IDENTITY, 'commit', '-m', 'baseline')
  const baseSha = git('rev-parse', 'HEAD').trim()
  const reportOut = await runSkeleton({
    runId: name, repo, baseSha, goal: 'make the change', model: 'fake/model',
    plannerModel: null, reviewerModel: null, candidateIds: ['c01'],
    concurrency: 1, timeoutMs: 10_000, maxAttempts: 1,
    gates, worker, workspaces: new WorktreeProvider(repo, artifactsDir),
    artifactsDir, cleanWorkspaces: false,
  })
  return { report: reportOut, artifactsDir }
}

// The pre-T-049 RunReport key set (default mode, no planner) — the
// clean-negative shape pin.
const PRE_T049_REPORT_KEYS = ['baseSha', 'candidates', 'finishedAt', 'goal', 'model', 'planner', 'repo', 'runId', 'startedAt']

const main = async () => {
  try {
    // ---------- Y1: the module and the recorded marker literal ----------
    t('Y1: the derivation module exists (src/yield.ts)', deriveRunYield !== null)
    t('Y1: DERAILMENT_MARKER is the recorded literal frame "permission requested: external_directory" (a byte-exact substring of every recorded auto-reject line)',
      DERAILMENT_MARKER === 'permission requested: external_directory')
    if (deriveRunYield !== null) {
      t('Y1: the marker literal is byte-exact inside the recorded run line (ANSI prefix, path, auto-reject suffix)',
        MARKER_LINE.includes(DERAILMENT_MARKER) && MARKER_LINE.includes('; auto-rejecting'))
    }

    // ---------- Y2: arithmetic pinned — the five-candidate fixture ----------
    const block2 = deriveRunYield !== null ? deriveRunYield(ARITH) : null
    t('Y2: the yield block is derived for a report with a no-op', block2 !== null)
    if (block2 !== null) {
      t('Y2: candidates = 5 (every dispatched candidate, report order)', block2.candidates === 5)
      t('Y2: attemptsDispatched = 6 (the retried candidate contributed two)', block2.attemptsDispatched === 6)
      t('Y2: workerOkAttempts = 5 (both legs of the retried candidate count; the worker-failed candidate does not)',
        block2.workerOkAttempts === 5)
      t('Y2: nonZeroDiffAttempts = 4 (each final diffBytes>0 attempt plus the pre-retry gates-failed leg, non-zero by the T-038 firing condition)',
        block2.nonZeroDiffAttempts === 4)
      t('Y2: gateFailedFinalAttempts = 1 (c02 only — c05\'s gates-failed leg is NON-final and its final attempt survived)',
        block2.gateFailedFinalAttempts === 1)
      t('Y2: noOpEliminations = 1 (workerOk && zero diff, the store\'s \'no-op\' class)', block2.noOpEliminations === 1)
      t('Y2: survivors = 2 (the first-try survivor and the retried-then-survived candidate)', block2.survivors === 2)
      t('Y2: noOpAttemptIds = ["c04-a1"] (the no-op candidate\'s FINAL attempt id)', eq(block2.noOpAttemptIds, ['c04-a1']))
      t('Y2: the whole block equals the exact expected object in one JSON comparison (field order included)',
        eq(block2, {
          candidates: 5, attemptsDispatched: 6, workerOkAttempts: 5, nonZeroDiffAttempts: 4,
          gateFailedFinalAttempts: 1, noOpEliminations: 1, survivors: 2,
          noOpAttemptIds: ['c04-a1'],
          derailmentMarkers: [{ attemptId: 'c04-a1', marker: 'permission requested: external_directory' }],
        }))
      t('Y2: no perRound key (the report carried no rounds block)', !('perRound' in block2))
    }

    // ---------- Y3: round-aware — per-round sub-totals ----------
    // The 20261024021432 shape: round 1 two survivors; round 2 one survivor
    // and one no-op (the mis-transcribed-lease worker).
    const R2 = report([
      cand('c01', { workerOk: true, diffBytes: 800, gates: [gate('test', true)], passedAllGates: true, attempts: [att('c01-a1', 1)] }),
      cand('c02', { workerOk: true, diffBytes: 600, gates: [gate('test', true)], passedAllGates: true, attempts: [att('c02-a1', 1)] }),
      cand('c01-r2', { workerOk: true, diffBytes: 900, gates: [gate('test', true)], passedAllGates: true, attempts: [att('c01-r2-a1', 1)] }),
      cand('c02-r2', { workerOk: true, diffBytes: 0, diffPath: zeroDiffPatch, gates: [gate('test', true)], passedAllGates: false,
        attempts: [att('c02-r2-a1', 1, { artifacts: [markerLogR2, zeroDiffPatch] })] }),
    ], { rounds: [
      { round: 1, executed: true, survivorIds: ['c01', 'c02'] },
      { round: 2, executed: true, survivorIds: ['c01-r2'], packetFingerprint: '3'.repeat(64), renderedBlockPath: join(sandbox, 'round-2-context-block.txt') },
    ] })
    const block3 = deriveRunYield !== null ? deriveRunYield(R2) : null
    t('Y3: the block is derived for the rounds:2 shape', block3 !== null)
    if (block3 !== null) {
      t('Y3: totals over the whole run (4 candidates, 4 attempts, 3 non-zero-diff, 1 no-op, 3 survivors)',
        block3.candidates === 4 && block3.attemptsDispatched === 4 && block3.workerOkAttempts === 4
        && block3.nonZeroDiffAttempts === 3 && block3.gateFailedFinalAttempts === 0
        && block3.noOpEliminations === 1 && block3.survivors === 3)
      t('Y3: perRound sub-totals exactly — round 1 over c01/c02, round 2 over the -r2 ids (the runner\'s id convention)',
        eq(block3.perRound, [
          { round: 1, candidates: 2, attemptsDispatched: 2, workerOkAttempts: 2, nonZeroDiffAttempts: 2, gateFailedFinalAttempts: 0, noOpEliminations: 0, survivors: 2 },
          { round: 2, candidates: 2, attemptsDispatched: 2, workerOkAttempts: 2, nonZeroDiffAttempts: 1, gateFailedFinalAttempts: 0, noOpEliminations: 1, survivors: 1 },
        ]))
      t('Y3: the round-2 no-op attempt\'s marker note rides (attempt id + literal)',
        eq(block3.derailmentMarkers, [{ attemptId: 'c02-r2-a1', marker: 'permission requested: external_directory' }]))
      // The executed:false face: round 2 recorded not-executed (no -r2
      // candidates) still gets its entry — zeros, recorded never fabricated.
      const R2X = report([
        cand('c01', { workerOk: true, diffBytes: 800, gates: [gate('test', true)], passedAllGates: true, attempts: [att('c01-a1', 1)] }),
        cand('c02', { workerOk: true, diffBytes: 0, diffPath: zeroDiffPatch, gates: [gate('test', true)], passedAllGates: false,
          attempts: [att('c02-a1', 1, { artifacts: [markerLog, zeroDiffPatch] })] }),
      ], { rounds: [
        { round: 1, executed: true, survivorIds: ['c01'] },
        { round: 2, executed: false, survivorIds: [] },
      ] })
      const block3x = deriveRunYield(R2X)
      t('Y3: a not-executed round 2 records its sub-totals as zeros (present, never fabricated)',
        eq(block3x?.perRound, [
          { round: 1, candidates: 2, attemptsDispatched: 2, workerOkAttempts: 2, nonZeroDiffAttempts: 1, gateFailedFinalAttempts: 0, noOpEliminations: 1, survivors: 1 },
          { round: 2, candidates: 0, attemptsDispatched: 0, workerOkAttempts: 0, nonZeroDiffAttempts: 0, gateFailedFinalAttempts: 0, noOpEliminations: 0, survivors: 0 },
        ]))
    }

    // ---------- Y4: marker note presence/absence ----------
    // (a) no-op with a clean worker.log — absence of the marker → no note.
    const CLEAN_NOOP = report([
      cand('c04', { workerOk: true, diffBytes: 0, diffPath: zeroDiffPatch, gates: [gate('test', true)], passedAllGates: false,
        attempts: [att('c04-a1', 1, { artifacts: [cleanLog, zeroDiffPatch] })] }),
    ])
    const block4a = deriveRunYield !== null ? deriveRunYield(CLEAN_NOOP) : null
    t('Y4a: a no-op attempt with a clean worker.log is still recorded in noOpAttemptIds', eq(block4a?.noOpAttemptIds, ['c04-a1']))
    t('Y4a: absence of the marker → NO derailmentMarkers key (producer-only, never an empty array)',
      block4a !== undefined && block4a !== null && !('derailmentMarkers' in block4a))
    // (b) the marker in a NON-no-op's log — absence of the zero diff → no
    // note, and with no other no-op in the report, no block at all.
    const MARKED_SURVIVOR = report([
      cand('c01', { workerOk: true, diffBytes: 800, gates: [gate('test', true)], passedAllGates: true,
        attempts: [att('c01-a1', 1, { artifacts: [markerLog] })] }),
    ])
    const block4b = deriveRunYield !== null ? deriveRunYield(MARKED_SURVIVOR) : null
    t('Y4b: the marker in a non-no-op\'s log produces no note (and no block: nothing to record)',
      block4b === null)
    // (c) a no-op attempt whose worker.log is MISSING (the artifact path is
    // recorded but the file is gone): id recorded, no note, never a throw.
    const GONE = report([
      cand('c04', { workerOk: true, diffBytes: 0, gates: [gate('test', true)], passedAllGates: false,
        attempts: [att('c04-a1', 1, { artifacts: [join(logsDir, 'gone', 'worker.log')] })] }),
    ])
    let block4c = 'threw'
    try {
      block4c = deriveRunYield !== null ? deriveRunYield(GONE) : null
    } catch {
      block4c = 'threw'
    }
    t('Y4c: a missing worker.log never throws — id recorded, no marker note',
      block4c !== 'threw' && eq(block4c?.noOpAttemptIds, ['c04-a1']) && !('derailmentMarkers' in (block4c ?? {})))
    // (d) an attempt with NO worker.log artifact at all: same posture.
    const NOLOG = report([
      cand('c04', { workerOk: true, diffBytes: 0, gates: [gate('test', true)], passedAllGates: false,
        attempts: [att('c04-a1', 1, { artifacts: [zeroDiffPatch] })] }),
    ])
    let block4d = 'threw'
    try {
      block4d = deriveRunYield !== null ? deriveRunYield(NOLOG) : null
    } catch {
      block4d = 'threw'
    }
    t('Y4d: an attempt with no worker.log artifact degrades the same way (id recorded, no note, no throw)',
      block4d !== 'threw' && eq(block4d?.noOpAttemptIds, ['c04-a1']))

    // ---------- Y5: clean-negative — no block, byte-identical shape ----------
    const CLEAN = report([
      cand('c01', { workerOk: true, diffBytes: 800, gates: [gate('test', true)], passedAllGates: true, attempts: [att('c01-a1', 1)] }),
      cand('c02', { workerOk: true, diffBytes: 600, gates: [gate('test', true)], passedAllGates: true, attempts: [att('c02-a1', 1)] }),
    ])
    const block5 = deriveRunYield !== null ? deriveRunYield(CLEAN) : 'n/a'
    const applied5 = structuredClone(CLEAN)
    if (block5 !== null && block5 !== 'n/a') applied5.yield = block5
    t('Y5: a clean run (every candidate survived) derives NO block (null)', block5 === null)
    t('Y5: the clean report\'s serialized shape is byte-identical to today\'s (no "yield": key anywhere)',
      JSON.stringify(applied5) === JSON.stringify(CLEAN) && !JSON.stringify(applied5).includes('"yield":'))

    // ---------- Y6: verdict inertness ----------
    const before6 = JSON.stringify(ARITH.candidates)
    const withBlock6 = structuredClone(ARITH)
    if (deriveRunYield !== null && block2 !== null) withBlock6.yield = block2
    t('Y6: candidates are byte-identical with and without the block', JSON.stringify(withBlock6.candidates) === before6)
    t('Y6: every elimination-determining field is unchanged (workerOk, diffBytes, gate verdicts, error, passedAllGates)',
      withBlock6.candidates.every((c, i) => {
        const o = ARITH.candidates[i]
        return c.workerOk === o.workerOk && c.diffBytes === o.diffBytes && c.error === o.error
          && c.passedAllGates === o.passedAllGates && eq(c.gates, o.gates)
      }))
    t('Y6: the verdicts are exactly the ladder\'s (survivor, gates-failed, worker-failed, no-op, retried-survivor)',
      withBlock6.candidates.map((c) => c.passedAllGates).join(',') === 'true,false,false,false,true')

    // ---------- Y7: the real producer end to end (real runner drives) ----------
    // Y7a — the no-op run: a worker that edits nothing (workerOk, zero diff)
    // with a green-at-base gate: the ladder eliminates it as a NO-OP, and the
    // report carries the yield block; report.json on disk carries it too.
    {
      const { report: rep, artifactsDir } = await drive('no-op-run', {
        worker: fakeWorker([{ writes: [] }]),
        gates: [new CommandGate('test', 'node test.js')],
      })
      const c = rep.candidates[0]
      t('Y7a: the no-op drive is the machine-known shape (workerOk, diffBytes 0, gates green on the untouched tree, passedAllGates false)',
        c.workerOk === true && c.diffBytes === 0 && c.gates.every((g) => g.passed) && c.passedAllGates === false)
      t('Y7a: the real run\'s report carries the yield block with the exact expected block',
        eq(rep.yield, {
          candidates: 1, attemptsDispatched: 1, workerOkAttempts: 1, nonZeroDiffAttempts: 0,
          gateFailedFinalAttempts: 0, noOpEliminations: 1, survivors: 0,
          noOpAttemptIds: ['c01-a1'],
        }))
      const onDisk = JSON.parse(read(join(artifactsDir, 'report.json')))
      t('Y7a: report.json ON DISK carries the same block (the durable copy)',
        onDisk.yield !== undefined && eq(onDisk.yield, rep.yield))
    }
    // Y7b — the clean run: a survivor-only run produces NO block and the exact
    // pre-T-049 RunReport key set (byte-identical shape, producer-only).
    {
      const { report: rep, artifactsDir } = await drive('clean-run', {
        worker: fakeWorker([{ writes: [{ file: 'feature.js', content: '// the change\nmodule.exports = {}\n' }] }]),
        gates: [new CommandGate('test', 'node test.js')],
      })
      t('Y7b: the clean drive survived (workerOk, non-zero diff, gates pass)', rep.candidates[0].passedAllGates === true)
      t('Y7b: the clean real run carries NO yield block (key absent, no bytes on disk)',
        !('yield' in rep) && !read(join(artifactsDir, 'report.json')).includes('"yield"'))
      t('Y7b: the report\'s key set is exactly the pre-T-049 set', eq(Object.keys(rep).sort(), PRE_T049_REPORT_KEYS))
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

main()
  .catch((e) => {
    failures.push(`check crashed: ${e instanceof Error ? e.message : String(e)}`)
    console.error(e)
  })
  .finally(() => {
    if (failures.length > 0) {
      console.error(`\ncheck-yield: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-yield: ALL GREEN')
  })
