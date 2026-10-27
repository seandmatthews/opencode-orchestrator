// Bounded gate-failure retry self-check (Gate 1.24, fast tier, T-038) —
// run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-gate-retry.mjs
// Drives `runSkeleton` directly with a FAKE WorkerAdapter (the seam at
// src/types.ts — the check-retry/check-probe pattern) against throwaway
// fixture repos, plus the real CLI with a `machine` worker and the real
// `recover` CLI over synthetic dispatch evidence — zero model tokens. Pins:
// the --gate-retry flag fires EXACTLY ONE feedback-informed attempt for a
// worker-succeeded, non-zero-diff, gate-failed candidate; the composed brief
// provably contains every failing gate's name, command, and outputTail
// (pinned through `gateRetry.fingerprint`, sha256 of the brief file bytes);
// both legs are recorded (attempt 1 `state: 'failed'`, failure reason
// 'gates-failed', attempt-scoped gateResults; the final attempt keeps
// today's semantics byte-for-byte); the immunity faces (zero-byte, no-gates,
// worker-failed under --max-attempts, failed diff capture); the interactions
// (--rounds 2, --jobs mode, --no-planner composition); the run header's
// `gateRetry: true`; and recovery's derived retry bound. The same Gate
// objects re-run unchanged on the retry (a retry never weakens, skips, or
// substitutes a gate — decisions.md 2026-10-21); a flag-less drive carries
// no gateRetry block and no attempt-scoped gate fields. All git calls are
// list-form (AGENTS.md #4); the sandbox is removed at the end (AGENTS.md #10).
// T-040 note: the gateRetry block's shape pin above now includes the
// `findings` provenance ({count, included, ok}); this drive configures no
// verifier, so the block carries the honest zero record {0, 0, false}. The
// findings-bearing composition is pinned by Gate 1.27
// (scripts/check-gate-retry-findings.mjs).
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSkeleton, workerDispatchPrompt } from '../src/runner.ts'
import { composePlannerDigest } from '../src/planner-digest.ts'
import { composeWorkerOrientation } from '../src/worker-orientation.ts'
import { WorktreeProvider } from '../src/workspace/worktree.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const norm = (p) => p.replaceAll('\\', '/').toLowerCase()
const read = (p) => readFileSync(p, 'utf8')
const sha256Hex = (s) => createHash('sha256').update(s).digest('hex')
// T-060: the orientation block the engine prepends to every worker dispatch
// (src/worker-orientation.ts over the run's one digest) — recomposed here the
// same way so the expected prompt bytes stay exact (the builderPrompt
// precedent; deterministic recomposition, Gate 1.45 D1 / 1.46 O1).
const orientationFor = (repo, baseSha, leasePath) =>
  composeWorkerOrientation({ leasePath, baseSha, digest: composePlannerDigest({ repo, baseSha }) }).text

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const cliTs = join(root, 'src', 'cli.ts')
const recoverTs = join(root, 'src', 'recover.ts')
const sandbox = 'C:/swarm/verify-gate-retry'
const IDENTITY = ['-c', 'user.name=check-gate-retry', '-c', 'user.email=gate-retry@local']

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })

// A fake WorkerAdapter (src/types.ts seam): a scripted list of steps, one per
// worker call, replaying the last step once the script runs out. Steps with a
// `planner` field answer planner-phase prompts instead (the shared-fake shape
// of a --rounds drive) and never advance the worker script. Every call
// appends to the adapter's logPath first — like the real adapter.
function fakeWorker(steps) {
  const workerSteps = steps.filter((s) => !s.planner)
  const plannerStep = steps.find((s) => s.planner)
  const calls = []
  const prompts = []
  let workerIdx = 0
  return {
    id: 'fake',
    calls,
    prompts,
    async execute(req) {
      calls.push(req.cwd)
      prompts.push(req.prompt)
      try {
        appendFileSync(req.logPath, `fake worker call ${calls.length}\n`)
      } catch {
        // Logging must never break a run.
      }
      const isPlanner = req.prompt.includes('planning tier')
      const step = isPlanner
        ? (plannerStep ?? { ok: true, responseTail: '[]' })
        : workerSteps[Math.min(workerIdx++, workerSteps.length - 1)]
      if (step.error) throw step.error
      if (step.write) writeFileSync(join(req.cwd, step.write.file), step.write.content)
      return {
        ok: step.ok,
        exitCode: step.exitCode ?? (step.ok ? 0 : 1),
        timedOut: false,
        durationMs: 5,
        logPath: req.logPath,
        responseTail: step.responseTail ?? `fake response ${calls.length}`,
      }
    },
  }
}

// Content-discriminating fake gates: the SAME gate objects are handed to the
// job and re-run on every attempt; each pushes its name onto `log` (when
// given) so the check can pin "the same gates re-run unchanged". A marker
// gate passes iff the workspace marker carries `fixedContent`; a static gate
// always returns its fixed verdict.
function markerGate(name, fixedContent, log) {
  return {
    name,
    run: async (cwd) => {
      log?.push(name)
      let content = ''
      try {
        content = readFileSync(join(cwd, 'marker.txt'), 'utf8')
      } catch {
        content = ''
      }
      const passed = content.includes(fixedContent)
      return {
        name,
        passed,
        exitCode: passed ? 0 : 1,
        durationMs: 1,
        outputTail: passed ? `${name}: marker ok` : `${name}: marker says ${content.trim() || '(nothing)'}`,
        command: `node check-${name}.js`,
      }
    },
  }
}
const staticGate = (name, passed, tail, log) => ({
  name,
  run: async () => {
    log?.push(name)
    return { name, passed, exitCode: passed ? 0 : 1, durationMs: 1, outputTail: tail, command: `node check-${name}.js` }
  },
})
const passGate = staticGate('always-pass', true, 'always-pass: ok')
const failGate = staticGate('always-fail', false, 'always-fail: deliberate failure')

// One throwaway fixture repo per scenario: fresh branch namespace, so
// scenarios cannot collide on swarm/* branch names. List-form git only.
async function drive(name, { worker, gates, maxAttempts = 1, gateRetry, rounds, plannerModel = null, scheduled, diffThrows = false }) {
  const scenarioDir = join(sandbox, name)
  const repo = join(scenarioDir, 'repo')
  const artifactsDir = join(scenarioDir, 'run')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => run('git', ['-C', repo, ...args])
  git('init', '-b', 'main')
  writeFileSync(join(repo, 'base.txt'), 'baseline\n')
  git(...IDENTITY, 'add', '-A')
  git(...IDENTITY, 'commit', '-m', 'baseline')
  const baseSha = git('rev-parse', 'HEAD').trim()
  const inner = new WorktreeProvider(repo, artifactsDir)
  const workspaces = diffThrows
    ? { lease: (id, ref) => inner.lease(id, ref), diff: () => { throw new Error('diff capture failed (fixture)') }, dispose: (lease) => inner.dispose(lease) }
    : inner
  const report = await runSkeleton({
    runId: name,
    repo,
    baseSha,
    goal: 'write the marker file',
    model: 'fake/model',
    plannerModel,
    reviewerModel: null,
    candidateIds: ['c01'],
    concurrency: 1,
    timeoutMs: 10_000,
    maxAttempts,
    gates,
    worker,
    ...(gateRetry !== undefined ? { gateRetry } : {}),
    ...(rounds !== undefined ? { rounds } : {}),
    ...(scheduled !== undefined ? { scheduled } : {}),
    workspaces,
    artifactsDir,
    cleanWorkspaces: false,
  })
  return { report, repo, artifactsDir, baseSha, git }
}

const parseDispatch = (artifactsDir) => read(join(artifactsDir, 'dispatch.jsonl'))
  .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

const main = async () => {
  // ---------- G1: the flag fires exactly one feedback-informed retry ----------
  {
    const executions = []
    const BRIEF = 'write the marker file'
    const worker = fakeWorker([
      { ok: true, write: { file: 'marker.txt', content: 'broken v1\n' }, responseTail: 'I changed marker.txt to broken v1' },
      { ok: true, write: { file: 'marker.txt', content: 'fixed v2\n' }, responseTail: 'I fixed marker.txt to fixed v2' },
    ])
    const gates = [markerGate('build', 'fixed', executions), markerGate('lint', 'fixed', executions), staticGate('always-pass', true, 'always-pass: ok', executions)]
    const { report, repo, artifactsDir, baseSha } = await drive('core-retry', { worker, gates, gateRetry: true })
    const c = report.candidates[0]
    const a1 = c.attempts[0]
    const a2 = c.attempts[1]
    t('G1: exactly two attempts recorded, worker executed twice', c.attempts.length === 2 && worker.calls.length === 2)
    t('G1: attempt 1 failed with reason gates-failed (exit 1, not timed out, message present)',
      a1?.state === 'failed' && a1?.failure?.reason === 'gates-failed' && a1?.failure?.exitCode === 1
      && a1?.failure?.timedOut === false && typeof a1?.failure?.message === 'string' && a1.failure.message.length > 0)
    t('G1: attempt 1 carries the attempt-scoped gate results (3 gates, in order, failing ones false)',
      Array.isArray(a1?.gateResults) && a1.gateResults.length === 3
      && a1.gateResults.map((g) => g.name).join(',') === 'build,lint,always-pass'
      && a1.gateResults[0]?.passed === false && a1.gateResults[1]?.passed === false && a1.gateResults[2]?.passed === true)
    t('G1: the same gate objects re-ran unchanged on the retry (3 gates x 2 attempts, in job order both times)',
      eq(executions, ['build', 'lint', 'always-pass', 'build', 'lint', 'always-pass']))
    t('G1: attempt 2 succeeded with no failure record — the final attempt keeps today\'s semantics',
      a2?.state === 'succeeded' && a2?.failure === undefined)
    t('G1: attempt 2 has NO attempt-scoped gateResults (only the pre-retry leg carries them)',
      a2?.gateResults === undefined)
    t('G1: attempt 2\'s values populate the report as the final attempt (worker ok, gates pass, diff non-empty, no error)',
      c.workerOk === true && c.passedAllGates === true && c.diffBytes > 0 && c.error === undefined
      && c.gates.length === 3 && c.gates.every((g) => g.passed === true)
      && norm(c.workspacePath ?? '') === norm(join(artifactsDir, 'wt', 'c01-a2')))
    t('G1: the gateRetry block is exactly the ticketed shape {fromAttempt, toAttempt, gates, fingerprint, findings{count, included, ok}} (the T-038 shape plus the T-040 provenance — no verifier configured on this drive, so the zero/zero/false degradation record)',
      c.gateRetry !== undefined
      && c.gateRetry.fromAttempt === 1 && c.gateRetry.toAttempt === 2
      && eq(c.gateRetry.gates, ['build', 'lint'])
      && /^[0-9a-f]{64}$/.test(c.gateRetry.fingerprint)
      && eq(c.gateRetry.findings, { count: 0, included: 0, ok: false }))
    t('G1: CandidateReport.brief is the ORIGINAL brief, never replaced', c.brief === BRIEF)
    const briefPath = join(artifactsDir, 'c01', 'attempt-2', 'retry-brief.txt')
    t('G1: the composed brief file exists in the retry attempt\'s evidence dir', existsSync(briefPath))
    const briefText = read(briefPath)
    t('G1: gateRetry.fingerprint is the sha256 of the composed brief file bytes', sha256Hex(briefText) === c.gateRetry?.fingerprint)
    t('G1: the composed brief carries the original brief text', briefText.includes(BRIEF))
    t('G1: the composed brief carries every failing gate\'s name, command, and outputTail',
      briefText.includes('build') && briefText.includes('node check-build.js')
      && briefText.includes('build: marker says broken v1')
      && briefText.includes('lint') && briefText.includes('node check-lint.js')
      && briefText.includes('lint: marker says broken v1'))
    t('G1: the composed brief carries the failing attempt\'s captured diff and the worker summary',
      briefText.includes('broken v1') && briefText.includes('I changed marker.txt to broken v1'))
    t('G1: the composed brief does NOT carry passing-gate output (only failing gates feed back)',
      !briefText.includes('always-pass: ok'))
    const a2Lease = join(artifactsDir, 'wt', 'c01-a2')
    t('G1: attempt 2\'s promptVersion is the sha256 of the exact prompt built from the composed brief (one composition, two consumers; since T-060 behind the orientation block, workerDispatchPrompt)',
      a2?.promptVersion === sha256Hex(workerDispatchPrompt(briefText, a2Lease, orientationFor(repo, baseSha, a2Lease))))
    t('G1: attempt 2\'s inputContextHash differs from attempt 1\'s (the brief differs — the hash is doing its job), both 64-hex',
      a1?.inputContextHash !== a2?.inputContextHash
      && /^[0-9a-f]{64}$/.test(a1?.inputContextHash ?? '') && /^[0-9a-f]{64}$/.test(a2?.inputContextHash ?? ''))
    t('G1: attempt-scoped evidence: attempt 1\'s diff.patch captured the pre-retry leg\'s work',
      read(join(artifactsDir, 'c01', 'diff.patch')).includes('broken v1'))
    // T-060: dispatched-prompt.txt (the full orientation + brief text) is
    // per-attempt evidence beside worker.log; the composed retry brief rides
    // after it on the retry attempt.
    t('G1: each attempt\'s outputArtifacts names its own paths, including the composed brief, and the files exist',
      eq(a1?.outputArtifacts, [join(artifactsDir, 'c01', 'worker.log'), join(artifactsDir, 'c01', 'dispatched-prompt.txt'), join(artifactsDir, 'c01', 'diff.patch')])
      && eq(a2?.outputArtifacts, [join(artifactsDir, 'c01', 'attempt-2', 'worker.log'), join(artifactsDir, 'c01', 'attempt-2', 'dispatched-prompt.txt'), briefPath, join(artifactsDir, 'c01', 'attempt-2', 'diff.patch')])
      && a1.outputArtifacts.every((p) => existsSync(p)) && a2.outputArtifacts.every((p) => existsSync(p)))
    const ev = parseDispatch(artifactsDir)
    const dispatches = ev.filter((l) => l.type === 'dispatch')
    const completions = ev.filter((l) => l.type === 'completion')
    t('G1: the run header carries gateRetry: true when the flag is set; dispatch.jsonl keeps its line shapes (the fake adapter calls no onSpawn — no pid lines)',
      ev[0]?.type === 'run' && ev[0]?.gateRetry === true
      && dispatches.length === 2 && completions.length === 2
      && ev.filter((l) => l.type === 'pid').length === 0)
    t('G1: both legs dispatched fresh leases (wt/c01, wt/c01-a2), both completions ok with captured diffs — no new line shapes',
      dispatches[0]?.leaseId === 'wt/c01' && dispatches[1]?.leaseId === 'wt/c01-a2'
      && dispatches[0]?.branch === 'swarm/wt-c01' && dispatches[1]?.branch === 'swarm/wt-c01-a2'
      && completions.every((l) => l.ok === true && (l.diffBytes ?? 0) > 0))
  }

  // ---------- G2: immunity faces ----------
  {
    const worker = fakeWorker([{ ok: true }, { ok: true, write: { file: 'marker.txt', content: 'would-pass\n' } }])
    const { report } = await drive('immune-zero-byte', { worker, gates: [failGate, passGate], gateRetry: true })
    const c = report.candidates[0]
    t('G2a: a zero-byte diff is never retried even with the flag — exactly one attempt',
      c.attempts.length === 1 && worker.calls.length === 1)
    t('G2a: eliminated exactly as today (no-op), no gateRetry block, no attempt gateResults',
      c.attempts[0]?.state === 'succeeded' && c.attempts[0]?.failure === undefined
      && c.diffBytes === 0 && c.passedAllGates === false
      && c.gateRetry === undefined && c.attempts[0]?.gateResults === undefined)
  }
  {
    const worker = fakeWorker([{ ok: true, write: { file: 'marker.txt', content: 'diff but no gates\n' } }])
    const { report } = await drive('immune-no-gates', { worker, gates: [], gateRetry: true })
    const c = report.candidates[0]
    t('G2b: a no-gates candidate is never retried — exactly one attempt, no block, no attempt gateResults',
      c.attempts.length === 1 && worker.calls.length === 1
      && c.passedAllGates === false && c.gateRetry === undefined && c.attempts[0]?.gateResults === undefined)
  }
  {
    const worker = fakeWorker([{ ok: false, exitCode: 3 }, { ok: false, exitCode: 3 }])
    const { report } = await drive('immune-worker-failed', { worker, gates: [passGate], maxAttempts: 2, gateRetry: true })
    const c = report.candidates[0]
    t('G2c: worker-failed legs retry under --max-attempts exactly as before and never consume the gate-retry',
      c.attempts.length === 2 && worker.calls.length === 2
      && c.attempts.every((a) => a.state === 'failed' && a.failure?.reason === 'worker-failed' && a.failure?.exitCode === 3)
      && c.gateRetry === undefined && c.attempts.every((a) => a.gateResults === undefined))
  }
  {
    const executions = []
    const worker = fakeWorker([
      { ok: false, exitCode: 3 },
      { ok: true, write: { file: 'marker.txt', content: 'broken v1\n' }, responseTail: 'broken attempt' },
      { ok: true, write: { file: 'marker.txt', content: 'fixed v2\n' } },
    ])
    const gates = [markerGate('build', 'fixed', executions)]
    const { report } = await drive('mech-then-gate-retry', { worker, gates, maxAttempts: 2, gateRetry: true })
    const c = report.candidates[0]
    const a = c.attempts
    t('G2d: a candidate that burned attempt 1 mechanically and failed gates on attempt 2 still gets its one gate-retry (3 = maxAttempts + 1)',
      a.length === 3 && worker.calls.length === 3)
    t('G2d: leg reasons in order: worker-failed, gates-failed (with attempt gateResults), succeeded',
      a[0]?.failure?.reason === 'worker-failed'
      && a[1]?.state === 'failed' && a[1]?.failure?.reason === 'gates-failed' && Array.isArray(a[1]?.gateResults)
      && a[2]?.state === 'succeeded')
    t('G2d: the gateRetry block names the a2 -> a3 leg and the candidate survives',
      c.gateRetry?.fromAttempt === 2 && c.gateRetry?.toAttempt === 3 && eq(c.gateRetry?.gates, ['build'])
      && c.passedAllGates === true)
  }
  {
    const worker = fakeWorker([{ ok: true, write: { file: 'marker.txt', content: 'uncapturable\n' } }])
    const { report } = await drive('immune-diff-capture', { worker, gates: [failGate], gateRetry: true, diffThrows: true })
    const c = report.candidates[0]
    t('G2e: a FAILED diff capture is terminal — no captured diff means no feedback payload, exactly today\'s elimination',
      c.attempts.length === 1 && worker.calls.length === 1
      && c.workerOk === true && c.diffBytes === 0 && c.passedAllGates === false
      && c.gateRetry === undefined && c.attempts[0]?.gateResults === undefined)
  }

  // ---------- G3: final-attempt shapes byte-identical; flag-less runs unchanged ----------
  {
    const executions = []
    const worker = fakeWorker([{ ok: true, write: { file: 'marker.txt', content: 'broken forever\n' }, responseTail: 'still broken' }])
    const gates = [markerGate('build', 'fixed', executions)]
    const { report } = await drive('both-legs-fail', { worker, gates, gateRetry: true })
    const c = report.candidates[0]
    t('G3a: gates failing on BOTH legs — exactly two attempts, the retry consumed, no attempt 3',
      c.attempts.length === 2 && worker.calls.length === 2)
    t('G3a: the final attempt keeps today\'s semantics byte-for-byte (succeeded worker, failing gates, eliminated, no new vocabulary)',
      c.attempts[1]?.state === 'succeeded' && c.attempts[1]?.failure === undefined
      && c.workerOk === true && c.gates.length === 1 && c.gates[0]?.passed === false
      && c.passedAllGates === false && c.error === undefined
      && c.gateRetry?.fromAttempt === 1 && c.gateRetry?.toAttempt === 2)
  }
  {
    const executions = []
    const worker = fakeWorker([{ ok: true, write: { file: 'marker.txt', content: 'broken forever\n' } }])
    const gates = [markerGate('build', 'fixed', executions)]
    const { report, artifactsDir } = await drive('flag-less', { worker, gates })
    const c = report.candidates[0]
    t('G3b: a flag-less run gates-failed candidate is eliminated after exactly one attempt — today\'s behavior',
      c.attempts.length === 1 && worker.calls.length === 1
      && c.workerOk === true && c.passedAllGates === false)
    t('G3b: a flag-less report carries NO gateRetry block and NO attempt-scoped gate fields',
      c.gateRetry === undefined && c.attempts[0]?.gateResults === undefined)
    t('G3b: a flag-less run header carries NO gateRetry field (byte-identical header)',
      parseDispatch(artifactsDir)[0]?.gateRetry === undefined)
  }

  // ---------- G4: interactions ----------
  {
    const executions = []
    const worker = fakeWorker([
      { planner: true, ok: true, responseTail: '["make the marker say fixed"]' },
      { ok: true, write: { file: 'marker.txt', content: 'broken v1\n' }, responseTail: 'broken' },
      { ok: true, write: { file: 'marker.txt', content: 'fixed v2\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'fixed in round 2\n' } },
    ])
    const gates = [markerGate('build', 'fixed', executions)]
    const { report, artifactsDir, git } = await drive('rounds-interact', { worker, gates, gateRetry: true, rounds: 2, plannerModel: 'fake/planner' })
    const c01 = report.candidates.find((c) => c.id === 'c01')
    const r2 = report.candidates.find((c) => c.id === 'c01-r2')
    t('G4a: --rounds 2 — the retry lives inside round 1\'s ladder; round 2 ran on the survivor',
      c01 !== undefined && r2 !== undefined && report.rounds?.length === 2
      && report.rounds[0]?.executed === true && eq(report.rounds[0]?.survivorIds, ['c01'])
      && report.rounds[1]?.executed === true && eq(report.rounds[1]?.survivorIds, ['c01-r2']))
    t('G4a: round-1 candidate retried (c01-a1 failed gates-failed, c01-a2 succeeded) and carries the gateRetry block',
      c01.attempts.length === 2 && c01.attempts[0]?.failure?.reason === 'gates-failed'
      && c01.attempts[0]?.gateResults !== undefined && c01.passedAllGates === true
      && c01.gateRetry?.fromAttempt === 1 && c01.gateRetry?.toAttempt === 2)
    t('G4a: round-2 ids and attempt ids never collide (c01-r2 has its own single-attempt ladder)',
      r2.attempts.length === 1 && r2.attempts[0]?.id === 'c01-r2-a1' && r2.passedAllGates === true
      && c01.attempts[0]?.id === 'c01-a1' && c01.attempts[1]?.id === 'c01-a2')
    const branches = git('branch', '--list', 'swarm/*').split('\n').map((l) => l.replace(/^[*+]\s*/, '').trim()).filter(Boolean)
    t('G4a: one branch per leg across rounds, no collisions (c01, c01-a2, c01-r2)',
      eq(branches.sort(), ['swarm/wt-c01', 'swarm/wt-c01-a2', 'swarm/wt-c01-r2']))
    t('G4a: the retry brief file exists in the round-1 retry attempt\'s evidence dir',
      existsSync(join(artifactsDir, 'c01', 'attempt-2', 'retry-brief.txt')))
  }
  {
    const executions = []
    const worker = fakeWorker([
      { ok: true, write: { file: 'marker.txt', content: 'broken v1\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'fixed v2\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'fixed on first try\n' } },
    ])
    const gates = [markerGate('build', 'fixed', executions)]
    const scheduled = {
      phases: [{ id: 'main', dependencies: [], completion: 'all' }],
      jobs: [
        { id: 'retried', phase: 'main', dependencies: [], brief: 'make marker fixed', model: 'fake/model', worker, timeoutMs: 10_000, gates },
        { id: 'straight', phase: 'main', dependencies: [], brief: 'write fixed on first try', model: 'fake/model', worker, timeoutMs: 10_000, gates },
      ],
    }
    const { report } = await drive('jobs-interact', { worker, gates, gateRetry: true, scheduled })
    const retried = report.candidates.find((c) => c.id === 'retried')
    const straight = report.candidates.find((c) => c.id === 'straight')
    t('G4b: --jobs mode retries per-job through the same runJob (the flag applies per job)',
      retried?.attempts.length === 2 && retried?.attempts[0]?.failure?.reason === 'gates-failed'
      && retried?.gateRetry !== undefined && retried?.passedAllGates === true
      && straight?.attempts.length === 1 && straight?.gateRetry === undefined && straight?.passedAllGates === true)
  }

  // ---------- G5: the real CLI — flag parse, --help, a token-free machine run, the store leg ----------
  {
    const runCli = (args, label) => {
      const r = spawnSync(process.execPath, [tsxCli, cliTs, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
      const code = r.status === null ? -1 : r.status
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}`
      if (label !== null && code !== 0) console.error(`--- cli (${label}, exit ${code}) ---\n${out}`)
      return { code, out }
    }
    const help = runCli(['--help'], null)
    t('G5a: --help documents --gate-retry', help.code === 0 && help.out.includes('--gate-retry'))

    // Fixture repo with a committed gate script; the machine command writes a
    // broken marker on attempt 1 and (cwd-discriminating, deterministic) a
    // fixed marker on the retry leg's fresh worktree — the token-free shape
    // of a converting retry through the real CLI.
    const fixtureRepo = join(sandbox, 'cli-fixture', 'repo')
    mkdirSync(fixtureRepo, { recursive: true })
    const fgit = (...args) => run('git', ['-C', fixtureRepo, ...args])
    fgit('init', '-b', 'main')
    writeFileSync(join(fixtureRepo, 'base.txt'), 'baseline\n')
    // T-043: marker.txt committed at base WITH a passing value (one that
    // contains "fixed content") so check.js is green on the untouched base;
    // base content differs from every value the worker writes, so each
    // attempt's captured diff stays non-empty (the retry's diff included).
    writeFileSync(join(fixtureRepo, 'marker.txt'), 'fixed content v0\n')
    writeFileSync(join(fixtureRepo, 'check.js'), [
      'const fs = require("fs")',
      'const c = fs.readFileSync("marker.txt", "utf8")',
      'process.exit(c.includes("fixed content") ? 0 : 1)',
      '',
    ].join('\n'))
    fgit(...IDENTITY, 'add', '-A')
    fgit(...IDENTITY, 'commit', '-m', 'baseline')
    const specPath = join(sandbox, 'cli-fixture', 'spec.json')
    writeFileSync(specPath, JSON.stringify({
      phases: [{ id: 'main', dependencies: [], completion: 'all' }],
      jobs: [{
        id: 'j1',
        phase: 'main',
        dependencies: [],
        brief: 'make marker.txt contain "fixed content"',
        worker: 'machine',
        command: ['node', '-e', 'const fs=require("fs");fs.writeFileSync("marker.txt", process.cwd().includes("-a2") ? "fixed content" : "broken content")'],
        gates: [{ name: 'build', command: 'node check.js' }],
      }],
    }, null, 2))

    const runRoot = join(sandbox, 'cli-fixture', 'runs')
    const dbPath = join(sandbox, 'cli-fixture', 'store.db')
    const flagRun = runCli(['--repo', fixtureRepo, '--jobs', specPath, '--gate-retry', '--no-review',
      '--run-root', runRoot, '--db', dbPath], 'flagged machine run')
    t('G5b: the real CLI accepts --gate-retry and the run completes mechanically (exit 0, no store failure)',
      flagRun.code === 0 && !flagRun.out.includes('unknown option') && !flagRun.out.includes('PERSISTENCE FAILED'))
    const runDirs = existsSync(runRoot) ? readdirSync(runRoot).filter((d) => /^\d{14}$/.test(d)) : []
    if (runDirs.length === 1) {
      const runDir = join(runRoot, runDirs[0])
      const creport = JSON.parse(read(join(runDir, 'report.json')))
      const cj = creport.candidates[0]
      t('G5b: on-disk report: two attempts, attempt 1 gates-failed with attempt gateResults, the gateRetry block, survivor verdict',
        cj.attempts.length === 2 && cj.attempts[0]?.failure?.reason === 'gates-failed'
        && Array.isArray(cj.attempts[0]?.gateResults) && cj.attempts[0]?.gateResults.length === 1
        && cj.gateRetry?.fromAttempt === 1 && cj.gateRetry?.toAttempt === 2 && eq(cj.gateRetry?.gates, ['build'])
        && /^[0-9a-f]{64}$/.test(cj.gateRetry?.fingerprint ?? '')
        && cj.passedAllGates === true)
      const briefPath = join(runDir, 'j1', 'attempt-2', 'retry-brief.txt')
      t('G5b: the composed brief file is on disk and hashes to the recorded fingerprint',
        existsSync(briefPath) && sha256Hex(read(briefPath)) === cj.gateRetry?.fingerprint)
      t('G5b: the real run\'s dispatch.jsonl header carries gateRetry: true (the header-line assertion through the real CLI)',
        parseDispatch(runDir)[0]?.gateRetry === true)
      // The store leg: the run's ingest into a sandbox DB, without loss.
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const attempts = db.prepare('SELECT attempt_number, state, failure_json FROM attempts WHERE run_id = ? ORDER BY attempt_number').all(runDirs[0])
        const gatesRows = db.prepare('SELECT passed FROM gate_results WHERE run_id = ?').all(runDirs[0])
        const cand = db.prepare('SELECT passed_all_gates FROM candidates WHERE run_id = ?').all(runDirs[0])
        const a1f = JSON.parse(attempts[0]?.failure_json ?? '{}')
        t('G5b: the store ingests the retried candidate without loss: two attempt rows (failed/gates-failed + succeeded), one final gate row, survivor',
          attempts.length === 2 && attempts[0]?.state === 'failed' && a1f?.reason === 'gates-failed'
          && attempts[1]?.state === 'succeeded'
          && gatesRows.length === 1 && gatesRows[0]?.passed === 1
          && cand.length === 1 && cand[0]?.passed_all_gates === 1)
      } finally {
        db.close()
      }
    } else {
      t('G5b: exactly one run dir under the flag run root (token-free machine run)', false)
    }

    // Separate fixture repo: the flagged run above left its swarm/* branches
    // in the first fixture (no --clean), and one repo is one branch
    // namespace — a shared repo would collide on swarm/wt-j1.
    const fixtureRepo2 = join(sandbox, 'cli-fixture-flagless', 'repo')
    mkdirSync(fixtureRepo2, { recursive: true })
    const fgit2 = (...args) => run('git', ['-C', fixtureRepo2, ...args])
    fgit2('init', '-b', 'main')
    writeFileSync(join(fixtureRepo2, 'base.txt'), 'baseline\n')
    // T-043: same base-green marker follow as the flagged fixture above.
    writeFileSync(join(fixtureRepo2, 'marker.txt'), 'fixed content v0\n')
    writeFileSync(join(fixtureRepo2, 'check.js'), [
      'const fs = require("fs")',
      'const c = fs.readFileSync("marker.txt", "utf8")',
      'process.exit(c.includes("fixed content") ? 0 : 1)',
      '',
    ].join('\n'))
    fgit2(...IDENTITY, 'add', '-A')
    fgit2(...IDENTITY, 'commit', '-m', 'baseline')
    const specPath2 = join(sandbox, 'cli-fixture-flagless', 'spec.json')
    writeFileSync(specPath2, JSON.stringify({
      phases: [{ id: 'main', dependencies: [], completion: 'all' }],
      jobs: [{
        id: 'j1',
        phase: 'main',
        dependencies: [],
        brief: 'make marker.txt contain "fixed content"',
        worker: 'machine',
        command: ['node', '-e', 'const fs=require("fs");fs.writeFileSync("marker.txt", process.cwd().includes("-a2") ? "fixed content" : "broken content")'],
        gates: [{ name: 'build', command: 'node check.js' }],
      }],
    }, null, 2))

    const runRoot2 = join(sandbox, 'cli-fixture-flagless', 'runs')
    const flagless = runCli(['--repo', fixtureRepo2, '--jobs', specPath2, '--no-review',
      '--run-root', runRoot2, '--db', join(sandbox, 'cli-fixture-flagless', 'store-flagless.db')], 'flagless machine run')
    t('G5c: the flag-less real CLI run is today\'s behavior (exit 0)', flagless.code === 0)
    const runDirs2 = existsSync(runRoot2) ? readdirSync(runRoot2).filter((d) => /^\d{14}$/.test(d)) : []
    if (runDirs2.length === 1) {
      const creport2 = JSON.parse(read(join(runRoot2, runDirs2[0], 'report.json')))
      const cj2 = creport2.candidates[0]
      t('G5c: flag-less run: one attempt, gates-failed elimination, no gateRetry block, no attempt gateResults',
        cj2.attempts.length === 1 && cj2.passedAllGates === false
        && cj2.gateRetry === undefined && cj2.attempts[0]?.gateResults === undefined
        && parseDispatch(join(runRoot2, runDirs2[0]))[0]?.gateRetry === undefined)
    } else {
      t('G5c: exactly one run dir under the flag-less run root', false)
    }
  }

  // ---------- G6: recovery derives the retry bound from the header ----------
  {
    const mkRepo = (name) => {
      const repo = join(sandbox, name, 'repo')
      mkdirSync(repo, { recursive: true })
      const git = (...args) => run('git', ['-C', repo, ...args])
      git('init', '-b', 'main')
      writeFileSync(join(repo, 'base.txt'), 'baseline\n')
      git(...IDENTITY, 'add', '-A')
      git(...IDENTITY, 'commit', '-m', 'baseline')
      return { repo, baseSha: git('rev-parse', 'HEAD').trim() }
    }
    const mkRun = (name, { maxAttempts, gateRetry, lines }) => {
      const { repo, baseSha } = mkRepo(name)
      const runRoot = join(sandbox, name, 'runs')
      const runId = '20991010160000'
      const runDir = join(runRoot, runId)
      mkdirSync(join(runDir, 'wt'), { recursive: true })
      const header = { type: 'run', runId, repo, baseSha, goal: 'synthetic', model: 'fake/model', maxAttempts, startedAt: '2026-10-21T00:00:00.000Z' }
      if (gateRetry) header.gateRetry = true
      const evLines = typeof lines === 'function' ? lines(runDir) : lines
      writeFileSync(join(runDir, 'dispatch.jsonl'), [header, ...evLines].map((l) => JSON.stringify(l)).join('\n') + '\n')
      return { runRoot, runId, runDir }
    }
    const runRecover = (label, args) => {
      const r = spawnSync(process.execPath, [tsxCli, recoverTs, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
      const code = r.status === null ? -1 : r.status
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}`
      if (label !== null && code !== 0) console.error(`--- recover (${label}, exit ${code}) ---\n${out}`)
      return { code, out }
    }
    // Dispatch lines carry the run's own wt/ paths (non-existent worktrees —
    // recovery's inspection lists them, the R5 synthetic pattern).
    const dispatchLine = (runDir, n) => ({ type: 'dispatch', jobId: 'j1', attempt: n, leaseId: `wt/j1${n > 1 ? `-a${n}` : ''}`, branch: `swarm/wt-j1${n > 1 ? `-a${n}` : ''}`, worktreePath: join(runDir, 'wt', `j1${n > 1 ? `-a${n}` : ''}`), startedAt: '2026-10-21T00:00:01.000Z' })
    const completionLine = (n, ok, diffBytes) => ({ type: 'completion', jobId: 'j1', attempt: n, ok, timedOut: false, exitCode: ok ? 0 : 1, diffBytes, endedAt: '2026-10-21T00:00:02.000Z' })
    const face = (name, cfg) => {
      const f = mkRun(name, cfg)
      runRecover(null, ['--run', f.runId, '--run-root', f.runRoot, '--db', join(sandbox, name, 'r.db')])
      return JSON.parse(read(join(f.runDir, 'recovery.json'))).jobs[0]
    }

    const recA = face('rec-unconsumed', { maxAttempts: 1, gateRetry: true, lines: (runDir) => [dispatchLine(runDir, 1), completionLine(1, true, 123)] })
    t('G6a: gate-retry unconsumed -> the bound is maxAttempts + 1: attemptsUsed 1 of a declared 1 is retryable (header gateRetry: true is the input)',
      recA?.disposition === 'retryable' && recA?.reason === null && recA?.maxAttempts === 1)

    const recB = face('rec-consumed', { maxAttempts: 1, gateRetry: true, lines: (runDir) => [dispatchLine(runDir, 1), completionLine(1, true, 123), dispatchLine(runDir, 2)] })
    t('G6b: the gate-retry consumed (an ok completion with a captured diff followed by another dispatch — a shape only the retry leg produces, a mechanical retry never re-rolls an ok completion) -> the bound is maxAttempts again: 2 attempts is terminal bound-exhausted',
      recB?.disposition === 'terminal' && recB?.reason === 'bound-exhausted' && recB?.attemptsUsed === 2)

    const recC = face('rec-absent', { maxAttempts: 1, gateRetry: false, lines: (runDir) => [dispatchLine(runDir, 1), completionLine(1, true, 123)] })
    t('G6c: header without gateRetry -> today\'s bound verbatim: attemptsUsed 1 of 1 is terminal bound-exhausted (unchanged)',
      recC?.disposition === 'terminal' && recC?.reason === 'bound-exhausted')

    const recD = face('rec-consumed-2', { maxAttempts: 2, gateRetry: true, lines: (runDir) => [dispatchLine(runDir, 1), completionLine(1, true, 123), dispatchLine(runDir, 2), completionLine(2, true, 456)] })
    t('G6d: gate-retry consumed at maxAttempts 2 -> attemptsUsed 2 of 2 is terminal (no second retry owed)',
      recD?.disposition === 'terminal' && recD?.reason === 'bound-exhausted')

    const recE = face('rec-noop', { maxAttempts: 1, gateRetry: true, lines: (runDir) => [dispatchLine(runDir, 1), completionLine(1, true, 0)] })
    t('G6e: the no-op verdict keeps precedence under the flag: ok + diffBytes 0 is terminal no-op, never re-rolled',
      recE?.disposition === 'terminal' && recE?.reason === 'no-op')
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
      console.error(`\ncheck-gate-retry: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-gate-retry: ALL GREEN')
  })
