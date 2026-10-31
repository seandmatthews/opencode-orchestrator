// Deterministic-scheduler self-check (Gate 1.10, fast tier, T-009) — run
// under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-scheduler.mjs
// Drives the exported pure ready-queue function directly on synthetic DAGs
// (chain, diamond, independent, mixed) and the runner end-to-end with a FAKE
// WorkerAdapter (the seam at src/types.ts — the T-007 Gate 1.8 pattern)
// against throwaway fixture repos (one per scenario, so swarm/* branch
// namespaces cannot collide; list-form git calls only — AGENTS.md #4). Zero
// model tokens, zero pipeline-through-CLI for the happy paths. Pins:
// dependency-safe ready lists with ascending-id tie-break, end-to-end
// determinism of the recorded dispatch sequences, the concurrency cap,
// cross-phase dependency ordering, the T-007 retry rule verbatim in --jobs
// mode (wt/<jobId>-a<n> leases, verdicts never re-rolled, no collisions),
// phase completion `all` with failure blocking dependent phases while
// independent phases still run, default mode staying exactly today's
// behavior (no schedule block), and the --jobs spec refusals exiting 1 with
// nothing written, before the checkout lock, repo validation, or any
// artifacts dir exists. T-031 extends it with the phase-level early stop:
// `EarlyStopPolicy.minSurvivors` parses strictly and is preserved on
// PhaseSpec (the approvalGate/earlyStop refusal flip recorded below), the
// pure `earlyStopMet` decision, and the end-to-end stop semantics with the
// fake adapter — dispatch-only suppression (never killed, full verdict
// ladder for in-flight survivors), not-dispatched recording, dependent
// phases starved while independents complete, `concluded-early` phase
// status precedence, and the additive `earlyStops` report block.
import { swarmRoot } from './swarm-root.mjs'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { earlyStopMet, parseJobsSpec, readyJobs } from '../src/scheduler.ts'
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
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const cliTs = join(root, 'src', 'cli.ts')
const sandbox = swarmRoot + '/verify-scheduler'
const IDENTITY = ['-c', 'user.name=check-scheduler', '-c', 'user.email=scheduler@local']

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A fake WorkerAdapter (src/types.ts seam) whose behavior is keyed by the
// brief inside the composed prompt (builderPrompt embeds `GOAL: <brief>` on
// its own line), so concurrent dispatch stays scriptable despite
// wall-clock interleaving. Steps per brief: { ok, exitCode?, write?, error? },
// consumed one per call, replaying the last once out. A brief with no script
// defaults to a succeeding step that writes a marker file (non-zero diff).
// Counts in-flight executions so the gate can pin the concurrency cap.
function fakeWorker(briefSteps, { waitMs = 0 } = {}) {
  const calls = []
  const counts = new Map()
  let inFlight = 0
  let maxInFlight = 0
  return {
    id: 'fake',
    calls,
    get maxInFlight() {
      return maxInFlight
    },
    briefsSeen: () => [...new Set(calls.map((c) => c.brief))],
    async execute(req) {
      const brief = /^GOAL: (.*)$/m.exec(req.prompt)?.[1] ?? '(no brief)'
      const n = counts.get(brief) ?? 0
      counts.set(brief, n + 1)
      calls.push({ cwd: req.cwd, brief, call: n + 1 })
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        try {
          appendFileSync(req.logPath, `fake worker call ${calls.length}\n`)
        } catch {
          // Logging must never break a run.
        }
        if (waitMs > 0) await sleep(waitMs)
        const scripted = briefSteps.get(brief) ?? []
        const step = scripted.length > 0
          ? scripted[Math.min(n, scripted.length - 1)]
          : { ok: true, write: { file: 'marker.txt', content: 'fake change\n' } }
        if (step.error) throw step.error
        if (step.write) writeFileSync(join(req.cwd, step.write.file), step.write.content)
        return {
          ok: step.ok,
          exitCode: step.exitCode ?? (step.ok ? 0 : 1),
          timedOut: false,
          durationMs: 5,
          logPath: req.logPath,
          responseTail: `fake response for ${brief}`,
        }
      } finally {
        inFlight--
      }
    },
  }
}

// A fake Gate (src/types.ts seam): deterministic verdict, no subprocess.
const passGate = { name: 'always-pass', run: async () => ({ name: 'always-pass', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok' }) }
const failGate = { name: 'always-fail', run: async () => ({ name: 'always-fail', passed: false, exitCode: 1, durationMs: 1, outputTail: 'deliberate failure' }) }

const okWorker = (waitMs = 0) => fakeWorker(new Map(), { waitMs })

// Resolve a raw spec object exactly the way src/cli.ts does: parseJobsSpec,
// then bind one worker/gate set behind the ResolvedJob seam.
function buildScheduled(raw, { worker, gates }) {
  const spec = parseJobsSpec(raw)
  return {
    phases: spec.phases,
    jobs: spec.jobs.map((j) => ({
      id: j.id,
      phaseId: j.phase,
      dependencies: j.dependencies,
      brief: j.brief,
      model: j.model ?? 'fake/model',
      worker,
      timeoutMs: j.timeoutMs ?? 10_000,
      gates: j.gates ?? gates ?? [],
    })),
  }
}

// One throwaway fixture repo per scenario: fresh branch namespace, so
// scenarios cannot collide on swarm/* branch names. List-form git only.
async function drive(name, { scheduled, candidateIds = ['c01'], worker, gates = [passGate], maxAttempts = 1, concurrency }) {
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
    maxAttempts,
    gates,
    worker,
    workspaces: new WorktreeProvider(repo, artifactsDir),
    artifactsDir,
    cleanWorkspaces: false,
    scheduled,
  })
  return { report, repo, artifactsDir, baseSha, git }
}

const branchesOf = (git) => git('branch', '--list', 'swarm/*').split('\n').map((l) => l.replace(/^[*+]\s*/, '').trim()).filter(Boolean)
const dispatchSeq = (report) => Object.fromEntries(report.schedule.jobs.map((j) => [j.id, j.dispatchIndex]))

async function main() {
  // ---------- G1: the ready-queue function on synthetic DAGs (pure, direct) ----------
  {
    const chain = [
      { id: 'a', phaseId: 'p', dependencies: [] },
      { id: 'b', phaseId: 'p', dependencies: ['a'] },
      { id: 'c', phaseId: 'p', dependencies: ['b'] },
    ]
    const diamond = [
      { id: 'a', phaseId: 'p', dependencies: [] },
      { id: 'b', phaseId: 'p', dependencies: ['a'] },
      { id: 'c', phaseId: 'p', dependencies: ['a'] },
      { id: 'd', phaseId: 'p', dependencies: ['b', 'c'] },
    ]
    const independent = [
      { id: 'a', phaseId: 'p', dependencies: [] },
      { id: 'b', phaseId: 'p', dependencies: [] },
      { id: 'c', phaseId: 'p', dependencies: [] },
    ]
    const mixed = [
      ...chain,
      ...diamond.map((j) => ({ ...j, id: `${j.id}-2`, dependencies: j.dependencies.map((d) => `${d}-2`) })),
      ...independent.map((j) => ({ ...j, id: `${j.id}-3` })),
    ]

    const T = (ids, state = 'succeeded') => new Map(ids.map((id) => [id, state]))
    const R = (ids) => new Set(ids)

    t('G1: chain — only the root is ready at first, then one at a time',
      eq(readyJobs(chain, new Map(), new Set(), 3), ['a'])
      && eq(readyJobs(chain, T(['a']), new Set(), 3), ['b'])
      && eq(readyJobs(chain, T(['a']), R(['b']), 3), [])
      && eq(readyJobs(chain, T(['a', 'b']), new Set(), 3), ['c'])
      && eq(readyJobs(chain, T(['a', 'b', 'c']), new Set(), 3), []))
    t('G1: diamond — both branches ready after the root, ascending tie-break, join waits for both',
      eq(readyJobs(diamond, new Map(), new Set(), 4), ['a'])
      && eq(readyJobs(diamond, T(['a']), new Set(), 4), ['b', 'c'])
      && eq(readyJobs(diamond, T(['a', 'b']), new Set(), 4), ['c'])
      && eq(readyJobs(diamond, T(['a', 'b', 'c']), new Set(), 4), ['d'])
      && eq(readyJobs(diamond, T(['a', 'b']), R(['b']), 4), ['c']))
    t('G1: independent — full ascending ready list under a wide cap, truncated to the cap when narrow',
      eq(readyJobs(independent, new Map(), new Set(), 5), ['a', 'b', 'c'])
      && eq(readyJobs(independent, new Map(), new Set(), 2), ['a', 'b'])
      && eq(readyJobs(independent, new Map(), new Set(['a', 'b']), 2), []))
    t('G1: mixed spec — every returned job is dependency-safe, ascending, and bounded by the cap',
      eq(readyJobs(mixed, new Map(), new Set(), 99), ['a', 'a-2', 'a-3', 'b-3', 'c-3'])
      && eq(readyJobs(mixed, T(['a', 'a-2']), new Set(), 99), ['a-3', 'b', 'b-2', 'b-3', 'c-2', 'c-3'])
      && readyJobs(mixed, new Map(), new Set(), 3).length === 3)
    t('G1: a terminal-failed dependency blocks its dependents for good while independents stay ready',
      eq(readyJobs(diamond, new Map([['a', 'failed']]), new Set(), 4), [])
      && eq(readyJobs([{ id: 'z', phaseId: 'p', dependencies: [] }, { id: 'b', phaseId: 'p', dependencies: ['a'] }], new Map([['a', 'failed']]), new Set(), 4), ['z']))
    t('G1: pure — same inputs give the same output and no input is mutated',
      eq(readyJobs(diamond, T(['a']), new Set(), 4), readyJobs(diamond, T(['a']), new Set(), 4))
      && diamond.every((j) => Array.isArray(j.dependencies)))
  }

  // ---------- G2: parseJobsSpec — expansion, defaults, strictness (in process) ----------
  {
    const spec = parseJobsSpec({
      phases: [
        { id: 'foundation' },
        { id: 'app', dependencies: ['foundation'], completion: 'all' },
      ],
      jobs: [
        { id: 'job-a', phase: 'foundation', brief: 'brief A' },
        { id: 'job-b', phase: 'foundation', brief: 'brief B', model: 'vendor/m', worker: 'opencode', timeoutMs: 1234 },
        { id: 'job-c', phase: 'app', brief: 'brief C', dependencies: ['job-a'], gates: [{ name: 'g', command: 'node build.js' }] },
      ],
    })
    t('G2: defaults — completion is "all", empty dependencies default to []',
      spec.phases[0]?.completion === 'all' && eq(spec.phases[0]?.dependencies, []) && eq(spec.jobs[0]?.dependencies, []))
    t('G2: phase dependencies expand to job edges — every app job depends on every foundation job',
      eq(spec.jobs[2]?.dependencies, ['job-a', 'job-b']) && eq(spec.jobs[0]?.dependencies, []))
    t('G2: optional per-job fields are preserved verbatim',
      spec.jobs[1]?.model === 'vendor/m' && spec.jobs[1]?.worker === 'opencode' && spec.jobs[1]?.timeoutMs === 1234
      && eq(spec.jobs[2]?.gates, [{ name: 'g', command: 'node build.js' }]))
    const throwsWith = (raw, needle) => {
      try {
        parseJobsSpec(raw)
        return false
      } catch (e) {
        return e instanceof Error && e.message.includes(needle)
      }
    }
    t('G2: unknown fields are refused, naming the field (job policy field)',
      throwsWith({ phases: [{ id: 'p' }], jobs: [{ id: 'j', phase: 'p', brief: 'b', retryPolicy: { maxAttempts: 2 } }] }, "unknown field 'retryPolicy'"))
    t('G2: approvalGate is still refused as an unknown field (no producer — its own M8 successor has not landed)',
      throwsWith({ phases: [{ id: 'p', approvalGate: {} }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, "unknown field 'approvalGate'"))
    t('G2: earlyStop parses (T-031) and is preserved verbatim on PhaseSpec',
      (() => {
        const s = parseJobsSpec({ phases: [{ id: 'p', earlyStop: { minSurvivors: 2 } }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] })
        return eq(s.phases[0]?.earlyStop, { minSurvivors: 2 })
      })())
    t('G2: earlyStop strict shapes — non-object, missing/non-integer/<1 minSurvivors, unknown sub-field, each naming the offense',
      throwsWith({ phases: [{ id: 'p', earlyStop: 'after-2' }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, "earlyStop must be an object")
      && throwsWith({ phases: [{ id: 'p', earlyStop: {} }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, 'minSurvivors must be a positive integer')
      && throwsWith({ phases: [{ id: 'p', earlyStop: { minSurvivors: 1.5 } }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, 'minSurvivors must be a positive integer')
      && throwsWith({ phases: [{ id: 'p', earlyStop: { minSurvivors: 0 } }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, 'minSurvivors must be a positive integer')
      && throwsWith({ phases: [{ id: 'p', earlyStop: { minSurvivors: 2, stopWhen: 'bored' } }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, "unknown field 'stopWhen'"))
    t('G2: non-all completion is refused',
      throwsWith({ phases: [{ id: 'p', completion: 'quorum' }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, 'must be "all"'))
    t('G2: the empty job set, duplicate ids, and bad charset are refused',
      throwsWith({ phases: [{ id: 'p' }], jobs: [] }, 'empty job set')
      && throwsWith({ phases: [{ id: 'p' }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }, { id: 'j', phase: 'p', brief: 'b2' }] }, "duplicate job id 'j'")
      && throwsWith({ phases: [{ id: 'p' }], jobs: [{ id: 'Job-1', phase: 'p', brief: 'b' }] }, 'does not match [a-z0-9][a-z0-9-]*'))
    t('G2: unknown job dependency, unknown phase, and job-less phase are refused',
      throwsWith({ phases: [{ id: 'p' }], jobs: [{ id: 'j', phase: 'p', brief: 'b', dependencies: ['ghost'] }] }, "'ghost', which is not in the job set")
      && throwsWith({ phases: [{ id: 'p' }], jobs: [{ id: 'j', phase: 'nope', brief: 'b' }] }, "phase 'nope', which is not in the phase set")
      && throwsWith({ phases: [{ id: 'p' }, { id: 'q' }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, "phase 'q' has no jobs"))
    t('G2: a cycle is refused and names the cycle (T-006 cycleRefusal)',
      throwsWith({
        phases: [{ id: 'p' }],
        jobs: [
          { id: 'a', phase: 'p', brief: 'b', dependencies: ['c'] },
          { id: 'b', phase: 'p', brief: 'b', dependencies: ['a'] },
          { id: 'c', phase: 'p', brief: 'b', dependencies: ['b'] },
        ],
      }, 'dependency cycle: a -> c -> b -> a'))
    t('G2: a phase-level cycle surfaces through the expanded edges, naming the jobs',
      throwsWith({
        phases: [{ id: 'p1', dependencies: ['p2'] }, { id: 'p2', dependencies: ['p1'] }],
        jobs: [
          { id: 'ja', phase: 'p1', brief: 'b' },
          { id: 'jb', phase: 'p2', brief: 'b' },
        ],
      }, 'dependency cycle'))
  }

  // ---------- S1: determinism end-to-end — identical recorded dispatch sequences ----------
  const DET_SPEC = {
    phases: [
      { id: 'foundation', completion: 'all' },
      { id: 'app', dependencies: ['foundation'], completion: 'all' },
    ],
    jobs: [
      { id: 'job-a', phase: 'foundation', brief: 'brief A' },
      { id: 'job-b', phase: 'foundation', dependencies: ['job-a'], brief: 'brief B' },
      { id: 'job-c', phase: 'foundation', brief: 'brief C' },
      { id: 'job-d', phase: 'app', brief: 'brief D' },
      { id: 'job-e', phase: 'app', dependencies: ['job-d'], brief: 'brief E' },
    ],
  }
  const CHAIN_SPEC = {
    phases: [{ id: 'solo', completion: 'all' }],
    jobs: [
      { id: 'ch-1', phase: 'solo', brief: 'brief 1' },
      { id: 'ch-2', phase: 'solo', brief: 'brief 2', dependencies: ['ch-1'] },
      { id: 'ch-3', phase: 'solo', brief: 'brief 3', dependencies: ['ch-2'] },
      { id: 'ch-4', phase: 'solo', brief: 'brief 4', dependencies: ['ch-3'] },
    ],
  }
  {
    const w1 = okWorker()
    const r1 = await drive('det-cap1-run1', { scheduled: buildScheduled(DET_SPEC, { worker: w1, gates: [passGate] }), worker: w1, concurrency: 1 })
    const r2 = await drive('det-cap1-run2', { scheduled: buildScheduled(DET_SPEC, { worker: okWorker(), gates: [passGate] }), worker: okWorker(), concurrency: 1 })
    t('S1: two runs over the same --jobs spec (cap 1) produce identical schedule blocks',
      eq(r1.report.schedule, r2.report.schedule))
    t('S1: dispatch order under cap 1 is the deterministic ready order (ascending tie-break)',
      eq(dispatchSeq(r1.report), { 'job-a': 0, 'job-b': 1, 'job-c': 2, 'job-d': 3, 'job-e': 4 }))
    const c1 = await drive('det-chain-run1', { scheduled: buildScheduled(CHAIN_SPEC, { worker: okWorker(), gates: [passGate] }), worker: okWorker(), concurrency: 4 })
    const c2 = await drive('det-chain-run2', { scheduled: buildScheduled(CHAIN_SPEC, { worker: okWorker(), gates: [passGate] }), worker: okWorker(), concurrency: 4 })
    t('S1: two runs over the same chain spec (cap 4) produce identical dispatch sequences',
      eq(c1.report.schedule, c2.report.schedule) && eq(dispatchSeq(c1.report), { 'ch-1': 0, 'ch-2': 1, 'ch-3': 2, 'ch-4': 3 }))
    t('S1: every job passed and every phase completed',
      c1.report.candidates.every((c) => c.passedAllGates)
      && c1.report.schedule.phases.every((p) => p.status === 'completed'))
  }

  // ---------- S2: the concurrency cap is never exceeded ----------
  {
    const spec = {
      phases: [{ id: 'wide', completion: 'all' }],
      jobs: [1, 2, 3, 4, 5].map((i) => ({ id: `wide-${i}`, phase: 'wide', brief: `wide brief ${i}` })),
    }
    const worker = okWorker(30)
    const { report } = await drive('cap', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, concurrency: 2 })
    t('S2: observed maximum in-flight executions never exceeds the cap (2)',
      worker.maxInFlight <= 2)
    t('S2: parallelism actually happened (2 in flight) and every job executed exactly once',
      worker.maxInFlight === 2 && worker.calls.length === 5 && worker.briefsSeen().length === 5)
    t('S2: dispatchIndices are unique and complete (0..4)',
      eq(Object.values(dispatchSeq(report)).sort((a, b) => a - b), [0, 1, 2, 3, 4]))
  }

  // ---------- S3: dependent jobs dispatch only after their dependencies succeed, across phases ----------
  {
    const spec = {
      phases: [
        { id: 'foundation', completion: 'all' },
        { id: 'app', dependencies: ['foundation'], completion: 'all' },
      ],
      jobs: [
        { id: 'job-a', phase: 'foundation', brief: 'brief A' },
        { id: 'job-b', phase: 'foundation', brief: 'brief B' },
        { id: 'job-c', phase: 'app', brief: 'brief C' },
        { id: 'job-d', phase: 'app', brief: 'brief D' },
      ],
    }
    const worker = okWorker(5)
    const { report } = await drive('cross-phase', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, concurrency: 2 })
    const pos = new Map(worker.calls.map((c, i) => [c.brief, i]))
    const idx = dispatchSeq(report)
    t('S3: app-phase jobs dispatched only after both foundation jobs succeeded (worker call order)',
      pos.get('brief C') > pos.get('brief A') && pos.get('brief C') > pos.get('brief B')
      && pos.get('brief D') > pos.get('brief A') && pos.get('brief D') > pos.get('brief B'))
    t('S3: recorded dispatchIndex agrees with the observed order and expanded edges are recorded',
      idx['job-c'] > idx['job-a'] && idx['job-c'] > idx['job-b']
      && report.schedule.jobs.find((j) => j.id === 'job-c')?.dependencies.join(',') === 'job-a,job-b')
    t('S3: both phases completed',
      eq(report.schedule.phases.map((p) => [p.id, p.status]), [['foundation', 'completed'], ['app', 'completed']]))
  }

  // ---------- S4: T-007 retry rule verbatim, through the scheduler (--jobs mode) ----------
  {
    const spec = { phases: [{ id: 'p', completion: 'all' }], jobs: [{ id: 'r1', phase: 'p', brief: 'retry brief' }] }
    const worker = fakeWorker(new Map([['retry brief', [
      { ok: false, exitCode: 3 },
      { ok: true, write: { file: 'marker.txt', content: 'attempt two\n' } },
    ]]]))
    const { report, artifactsDir, baseSha, git } = await drive('retry-jobs', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, maxAttempts: 2 })
    const c = report.candidates[0]
    t('S4: fail-once-then-succeed — exactly two attempts, the second succeeded, the job passes',
      c?.attempts.length === 2 && c.attempts[0]?.state === 'failed' && c.attempts[1]?.state === 'succeeded'
      && c.workerOk === true && c.passedAllGates === true)
    t('S4: retry leases follow wt/<jobId> and wt/<jobId>-a<n> at the run baseSha',
      existsSync(join(artifactsDir, 'wt', 'r1')) && existsSync(join(artifactsDir, 'wt', 'r1-a2'))
      && run('git', ['-C', join(artifactsDir, 'wt', 'r1'), 'rev-parse', 'HEAD']).trim() === baseSha
      && run('git', ['-C', join(artifactsDir, 'wt', 'r1-a2'), 'rev-parse', 'HEAD']).trim() === baseSha)
    t('S4: no branch/worktree collisions — exactly one branch per attempt',
      eq(branchesOf(git).sort(), ['swarm/wt-r1', 'swarm/wt-r1-a2'])
      && git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('branch ') && l.includes('swarm/')).length === 2)
    t('S4: the retried job was dispatched exactly once (dispatchIndex 0)',
      eq(dispatchSeq(report), { r1: 0 }))
    t('S4: phase completed after the retry succeeded',
      report.schedule.phases[0]?.status === 'completed')
  }
  {
    const spec = { phases: [{ id: 'p', completion: 'all' }], jobs: [{ id: 'rf', phase: 'p', brief: 'always-fail brief' }] }
    const worker = fakeWorker(new Map([['always-fail brief', [{ ok: false, exitCode: 7 }]]]))
    const { report } = await drive('bound-jobs', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, maxAttempts: 2 })
    const c = report.candidates[0]
    t('S4: the bound eliminates — exactly maxAttempts attempts, terminal failure recorded',
      c?.attempts.length === 2 && worker.calls.length === 2
      && report.schedule.jobs[0]?.dispatchIndex === 0
      && report.schedule.phases[0]?.status === 'failed')
  }
  {
    const spec = { phases: [{ id: 'p', completion: 'all' }], jobs: [{ id: 'rn', phase: 'p', brief: 'no-op brief' }] }
    const worker = fakeWorker(new Map([['no-op brief', [{ ok: true }, { ok: true, write: { file: 'marker.txt', content: 'never\n' } }]]]))
    const { report } = await drive('noop-jobs', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, maxAttempts: 2 })
    const c = report.candidates[0]
    t('S4: a succeeded-but-no-op leg is a verdict, never re-rolled — one attempt, job failed',
      c?.attempts.length === 1 && worker.calls.length === 1 && c.diffBytes === 0 && c.passedAllGates === false
      && report.schedule.phases[0]?.status === 'failed')
  }
  {
    const spec = { phases: [{ id: 'p', completion: 'all' }], jobs: [{ id: 'rg', phase: 'p', brief: 'gates-fail brief' }] }
    const worker = fakeWorker(new Map([['gates-fail brief', [
      { ok: true, write: { file: 'marker.txt', content: 'fails gates\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'never\n' } },
    ]]]))
    const { report } = await drive('gatesfail-jobs', { scheduled: buildScheduled(spec, { worker, gates: [failGate] }), worker, maxAttempts: 2 })
    const c = report.candidates[0]
    t('S4: a gates-failed leg is a machine verdict, never re-rolled — one attempt, job failed',
      c?.attempts.length === 1 && worker.calls.length === 1 && c.gates.length === 1 && c.gates[0]?.passed === false
      && c.passedAllGates === false && report.schedule.phases[0]?.status === 'failed')
  }
  {
    const spec = { phases: [{ id: 'p', completion: 'all' }], jobs: [{ id: 'rt', phase: 'p', brief: 'throw brief' }] }
    const worker = fakeWorker(new Map([['throw brief', [
      { error: new Error('transient harness crash') },
      { ok: true, write: { file: 'marker.txt', content: 'recovered\n' } },
    ]]]))
    const { report } = await drive('throw-jobs', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, maxAttempts: 2 })
    const c = report.candidates[0]
    t('S4: a thrown leg is a mechanical failure and IS retried — two attempts, job passes',
      c?.attempts.length === 2 && c.attempts[0]?.failure?.reason === 'error' && c.attempts[1]?.state === 'succeeded'
      && c.passedAllGates === true)
  }

  // ---------- S5: phase completion `all` — failure blocks dependents, independents run ----------
  {
    const spec = {
      phases: [
        { id: 'ok-and-doomed', completion: 'all' },
        { id: 'dependent', dependencies: ['ok-and-doomed'], completion: 'all' },
        { id: 'independent', completion: 'all' },
      ],
      jobs: [
        { id: 'a1', phase: 'ok-and-doomed', brief: 'brief A1' },
        { id: 'a2', phase: 'ok-and-doomed', brief: 'brief A2' },
        { id: 'b1', phase: 'dependent', brief: 'brief B1' },
        { id: 'c1', phase: 'independent', brief: 'brief C1' },
      ],
    }
    const worker = fakeWorker(new Map([
      ['brief A2', [{ ok: false, exitCode: 1 }]],
    ]))
    const { report, git } = await drive('phase-fail', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, concurrency: 4 })
    const byId = new Map(report.schedule.jobs.map((j) => [j.id, j]))
    t('S5: the failed job fails its phase; the dependent phase is blocked; the independent phase completed',
      eq(report.schedule.phases.map((p) => [p.id, p.status]),
        [['ok-and-doomed', 'failed'], ['dependent', 'blocked'], ['independent', 'completed']]))
    t('S5: the dependent phase job was never dispatched — recorded as not-dispatched, never fabricated as terminal',
      byId.get('b1')?.dispatchIndex === null && !worker.briefsSeen().includes('brief B1'))
    t('S5: independent phases still ran to completion',
      byId.get('c1')?.dispatchIndex !== null && report.candidates.some((c) => c.id === 'c1' && c.passedAllGates))
    t('S5: the never-dispatched job has no candidate report (nothing fabricated)',
      !report.candidates.some((c) => c.id === 'b1'))
    t('S5: no branch or worktree was ever created for the never-dispatched job',
      eq(branchesOf(git).sort(), ['swarm/wt-a1', 'swarm/wt-a2', 'swarm/wt-c1']))
  }

  // ---------- S5b: phase-level early stop (T-031, spec §20) ----------
  // ES — the pure stop decision (direct calls), then the end-to-end stop
  // semantics with the fake adapter: dispatch-only suppression (in-flight
  // jobs run to completion — the fake adapter counts executions ==
  // dispatches), not-dispatched recording (no candidate, no lease/branch/
  // worktree), dependents starved while independents complete, the
  // `concluded-early` status precedence, and the additive `earlyStops`
  // report block agreeing with the schedule block.
  {
    const policy = { minSurvivors: 2 }
    const phaseJobs = [
      { id: 'a', phaseId: 'p', dependencies: [] },
      { id: 'b', phaseId: 'p', dependencies: [] },
      { id: 'c', phaseId: 'p', dependencies: [] },
    ]
    const T = (entries) => new Map(entries)
    t('ES: earlyStopMet is pure — identical terminal maps give identical decisions',
      earlyStopMet(policy, phaseJobs, T([['a', 'succeeded'], ['b', 'succeeded']])) === true
      && earlyStopMet(policy, phaseJobs, T([['a', 'succeeded'], ['b', 'succeeded']])) === true)
    t('ES: the threshold is exact — terminal failures never count as survivors, no input is mutated',
      earlyStopMet(policy, phaseJobs, T([['a', 'succeeded'], ['b', 'failed']])) === false
      && earlyStopMet(policy, phaseJobs, T([])) === false
      && earlyStopMet({ minSurvivors: 1 }, phaseJobs, T([['a', 'succeeded'], ['b', 'failed']])) === true
      && earlyStopMet({ minSurvivors: 1 }, phaseJobs, T([['a', 'failed']])) === false
      && phaseJobs.every((j) => Array.isArray(j.dependencies)))
  }
  {
    // ES1 — met condition end-to-end: one phase, 3 jobs, minSurvivors 1,
    // cap 1 (staggered). After the 1st success the remaining ready jobs are
    // never dispatched; the one dispatched job ran to completion exactly
    // once with its full verdict ladder; the phase is concluded-early.
    const spec = {
      phases: [{ id: 'es', completion: 'all', earlyStop: { minSurvivors: 1 } }],
      jobs: [
        { id: 'es-1', phase: 'es', brief: 'es brief 1' },
        { id: 'es-2', phase: 'es', brief: 'es brief 2' },
        { id: 'es-3', phase: 'es', brief: 'es brief 3' },
      ],
    }
    const worker = okWorker(5)
    const { report, artifactsDir, git } = await drive('early-stop-met', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, concurrency: 1 })
    const byId = new Map(report.schedule.jobs.map((j) => [j.id, j]))
    t('ES1: after the k-th success the remaining ready jobs are never dispatched — dispatchIndex null, no candidate report, one execution only',
      byId.get('es-1')?.dispatchIndex === 0 && byId.get('es-2')?.dispatchIndex === null && byId.get('es-3')?.dispatchIndex === null
      && !report.candidates.some((c) => c.id === 'es-2') && !report.candidates.some((c) => c.id === 'es-3')
      && worker.calls.length === 1 && worker.briefsSeen().length === 1)
    t('ES1: the dispatched survivor carries its full verdict ladder (gates ran and passed)',
      report.candidates.length === 1 && report.candidates[0]?.id === 'es-1'
      && report.candidates[0]?.passedAllGates === true && report.candidates[0]?.gates.length === 1
      && report.candidates[0]?.gates[0]?.passed === true)
    t('ES1: the suppressed jobs created no lease, branch, or worktree',
      eq(branchesOf(git).sort(), ['swarm/wt-es-1']) && existsSync(join(artifactsDir, 'wt', 'es-1'))
      && !existsSync(join(artifactsDir, 'wt', 'es-2')) && !existsSync(join(artifactsDir, 'wt', 'es-3')))
    t('ES1: the phase status is concluded-early',
      report.schedule.phases.length === 1 && report.schedule.phases[0]?.id === 'es'
      && report.schedule.phases[0]?.status === 'concluded-early')
    t('ES1: the earlyStops block records the fired policy and agrees exactly with the schedule block (neverDispatchedIds == the dispatchIndex:null entries)',
      eq(report.earlyStops, [{ phaseId: 'es', condition: 'minSurvivors', threshold: 1, met: true, survivorIds: ['es-1'], neverDispatchedIds: ['es-2', 'es-3'] }])
      && eq(report.earlyStops[0]?.neverDispatchedIds, report.schedule.jobs.filter((j) => j.dispatchIndex === null).map((j) => j.id)))
    t('ES1: the earlyStops block rides report.json on disk',
      eq(JSON.parse(read(join(artifactsDir, 'report.json'))).earlyStops, report.earlyStops))
  }
  {
    // ES2 — multi-phase: dependents of a concluded-early phase stay
    // never-dispatched (no candidate, no branch) while an independent phase
    // still runs to completion. Cap 1 staggers everything; ready-order
    // ascending puts i1 before s1.
    const spec = {
      phases: [
        { id: 'stopper', completion: 'all', earlyStop: { minSurvivors: 1 } },
        { id: 'dependent', dependencies: ['stopper'], completion: 'all' },
        { id: 'independent', completion: 'all' },
      ],
      jobs: [
        { id: 's1', phase: 'stopper', brief: 'stopper brief 1' },
        { id: 's2', phase: 'stopper', brief: 'stopper brief 2' },
        { id: 'd1', phase: 'dependent', brief: 'dependent brief 1' },
        { id: 'i1', phase: 'independent', brief: 'independent brief 1' },
      ],
    }
    const worker = okWorker(5)
    const { report, git } = await drive('early-stop-multiphase', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, concurrency: 1 })
    const byId = new Map(report.schedule.jobs.map((j) => [j.id, j]))
    t('ES2: statuses — stopper concluded-early, dependent blocked, independent completed',
      eq(report.schedule.phases.map((p) => [p.id, p.status]),
        [['stopper', 'concluded-early'], ['dependent', 'blocked'], ['independent', 'completed']]))
    t('ES2: the dependent job stayed never-dispatched — no candidate report, no branch, never executed',
      byId.get('d1')?.dispatchIndex === null && !report.candidates.some((c) => c.id === 'd1')
      && !worker.briefsSeen().includes('dependent brief 1')
      && eq(branchesOf(git).sort(), ['swarm/wt-i1', 'swarm/wt-s1']))
    t('ES2: the independent phase still ran to completion',
      report.candidates.some((c) => c.id === 'i1' && c.passedAllGates) && byId.get('i1')?.dispatchIndex !== null)
    t('ES2: the earlyStops block carries one record for the declaring phase only',
      eq(report.earlyStops?.map((r) => r.phaseId), ['stopper'])
      && report.earlyStops?.[0]?.met === true && eq(report.earlyStops?.[0]?.neverDispatchedIds, ['s2']))
  }
  {
    // ES3 — in-flight survival: both jobs dispatch in the first iteration
    // (cap 2, BEFORE any success can fire the stop), so both were dispatched
    // before the stop; when the first succeeds the stop fires and the third
    // is suppressed while the second is still in flight — it must complete
    // with its full verdict ladder, never killed.
    const spec = {
      phases: [{ id: 'es', completion: 'all', earlyStop: { minSurvivors: 1 } }],
      jobs: [
        { id: 'f1', phase: 'es', brief: 'flight brief 1' },
        { id: 'f2', phase: 'es', brief: 'flight brief 2' },
        { id: 'f3', phase: 'es', brief: 'flight brief 3' },
      ],
    }
    const worker = okWorker(30)
    const { report } = await drive('early-stop-inflight', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, concurrency: 2 })
    t('ES3: both pre-stop dispatches ran to completion exactly once (executions == dispatches — never killed)',
      worker.calls.length === 2 && report.candidates.length === 2
      && worker.briefsSeen().length === 2)
    t('ES3: each in-flight survivor carries its full verdict ladder (gates ran, candidate report written)',
      report.candidates.every((c) => c.passedAllGates === true && c.gates.length === 1
        && c.gates[0]?.passed === true && c.attempts.length === 1))
    t('ES3: the third job was suppressed and the phase concluded early with both survivors recorded',
      report.schedule.jobs.find((j) => j.id === 'f3')?.dispatchIndex === null
      && report.schedule.phases[0]?.status === 'concluded-early'
      && report.earlyStops?.[0]?.met === true && eq(report.earlyStops?.[0]?.survivorIds, ['f1', 'f2'])
      && eq(report.earlyStops?.[0]?.neverDispatchedIds, ['f3']))
  }
  {
    // ES4a — a declared-but-unfired policy on a phase that RAN: 2 jobs,
    // minSurvivors 2, one fails ⇒ 1 survivor < 2 ⇒ met:false, phase failed
    // (precedence: failed > concluded-early > completed > blocked).
    const spec = {
      phases: [{ id: 'unfired', completion: 'all', earlyStop: { minSurvivors: 2 } }],
      jobs: [
        { id: 'u1', phase: 'unfired', brief: 'unfired brief 1' },
        { id: 'u2', phase: 'unfired', brief: 'unfired brief 2' },
      ],
    }
    const worker = fakeWorker(new Map([['unfired brief 2', [{ ok: false, exitCode: 1 }]]]))
    const { report } = await drive('early-stop-unfired', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, concurrency: 2 })
    t('ES4: a declared-but-unfired policy is recorded met:false (survivorIds = the terminal-succeeded), and failure keeps status precedence',
      eq(report.earlyStops, [{ phaseId: 'unfired', condition: 'minSurvivors', threshold: 2, met: false, survivorIds: ['u1'], neverDispatchedIds: [] }])
      && report.schedule.phases[0]?.status === 'failed')
  }
  {
    // ES4b — a declared policy on a phase starved by an upstream failure:
    // evaluated, never fired, and the phase keeps its blocked status
    // (declared-but-unmet policies change no status).
    const spec = {
      phases: [
        { id: 'doomed', completion: 'all' },
        { id: 'hopeful', dependencies: ['doomed'], completion: 'all', earlyStop: { minSurvivors: 1 } },
      ],
      jobs: [
        { id: 'x1', phase: 'doomed', brief: 'doomed brief 1' },
        { id: 'h1', phase: 'hopeful', brief: 'hopeful brief 1' },
      ],
    }
    const worker = fakeWorker(new Map([['doomed brief 1', [{ ok: false, exitCode: 1 }]]]))
    const { report } = await drive('early-stop-starved', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, concurrency: 2 })
    t('ES4: a policy on a starved phase records met:false with the starved job neverDispatched, and the phase stays blocked (no status change)',
      eq(report.earlyStops, [{ phaseId: 'hopeful', condition: 'minSurvivors', threshold: 1, met: false, survivorIds: [], neverDispatchedIds: ['h1'] }])
      && report.schedule.phases[1]?.status === 'blocked')
  }
  {
    // ES5 — a met policy with ZERO never-dispatched jobs (cap ≥ N): the
    // whole phase ran, so the status stays completed (concluded-early needs
    // ≥ 1 never-dispatched job) while the block still records met:true.
    const spec = {
      phases: [{ id: 'allrun', completion: 'all', earlyStop: { minSurvivors: 1 } }],
      jobs: [
        { id: 'w1', phase: 'allrun', brief: 'allrun brief 1' },
        { id: 'w2', phase: 'allrun', brief: 'allrun brief 2' },
      ],
    }
    const { report } = await drive('early-stop-all-dispatched', { scheduled: buildScheduled(spec, { worker: okWorker(), gates: [passGate] }), worker: okWorker(), concurrency: 2 })
    t('ES5: a met policy with zero never-dispatched jobs leaves the phase completed (precedence), block records met:true',
      report.schedule.phases[0]?.status === 'completed'
      && eq(report.earlyStops, [{ phaseId: 'allrun', condition: 'minSurvivors', threshold: 1, met: true, survivorIds: ['w1', 'w2'], neverDispatchedIds: [] }]))
  }
  {
    // ES6 — a policy-less --jobs spec carries NO earlyStops block.
    const spec = { phases: [{ id: 'plain', completion: 'all' }], jobs: [{ id: 'p1', phase: 'plain', brief: 'plain brief' }] }
    const { report, artifactsDir } = await drive('early-stop-absent', { scheduled: buildScheduled(spec, { worker: okWorker(), gates: [passGate] }), worker: okWorker() })
    t('ES6: a policy-less --jobs report carries NO earlyStops block (in memory or on disk)',
      !('earlyStops' in report) && JSON.parse(read(join(artifactsDir, 'report.json'))).earlyStops === undefined)
  }
  {
    // ES7 — review round 1 (red-before/green-after, AGENTS.md #8): a
    // suppressed job must never consume another phase's dispatch capacity.
    // Here the suppressed job sorts BEFORE the independent job (a2 < z1):
    // under cap 1 a filter applied AFTER the ready call's cap slice would
    // hand the whole slice to the suppressed job every iteration, strand z1
    // for the rest of the run (a free dispatch slot wasted), and record
    // 'zz' as 'blocked' — starved-by-upstream-failure, active misinformation.
    // The stop may only skip the declared phase's own undispatched work.
    const spec = {
      phases: [
        { id: 'aa', completion: 'all', earlyStop: { minSurvivors: 1 } },
        { id: 'zz', completion: 'all' },
      ],
      jobs: [
        { id: 'a1', phase: 'aa', brief: 'strand brief a1' },
        { id: 'a2', phase: 'aa', brief: 'strand brief a2' },
        { id: 'z1', phase: 'zz', brief: 'strand brief z1' },
      ],
    }
    const worker = okWorker(5)
    const { report } = await drive('early-stop-no-strand', { scheduled: buildScheduled(spec, { worker, gates: [passGate] }), worker, concurrency: 1 })
    const byId = new Map(report.schedule.jobs.map((j) => [j.id, j]))
    t('ES7: the independent job still dispatches under the same cap although the suppressed job sorts ahead of it',
      byId.get('z1')?.dispatchIndex !== null && report.candidates.some((c) => c.id === 'z1' && c.passedAllGates)
      && worker.briefsSeen().includes('strand brief z1'))
    t('ES7: the independent phase records completed and the stopped phase concluded-early (never a false blocked)',
      eq(report.schedule.phases.map((p) => [p.id, p.status]), [['aa', 'concluded-early'], ['zz', 'completed']]))
    t('ES7: the stop still suppressed exactly the stopped phase remaining undispatched job',
      byId.get('a1')?.dispatchIndex === 0 && byId.get('a2')?.dispatchIndex === null
      && eq(report.earlyStops, [{ phaseId: 'aa', condition: 'minSurvivors', threshold: 1, met: true, survivorIds: ['a1'], neverDispatchedIds: ['a2'] }]))
  }

  // ---------- S6: default mode is today's behavior (no --jobs) ----------
  {
    const worker = okWorker()
    const lines = []
    const origLog = console.log
    console.log = (...args) => {
      lines.push(args.join(' '))
    }
    let result
    try {
      result = await drive('default-mode', { candidateIds: ['c01', 'c02'], worker })
    } finally {
      console.log = origLog
    }
    const { report, artifactsDir, git } = result
    t('S6: candidate ids in order, one dispatch per candidate (distinct worktrees)',
      eq(report.candidates.map((c) => c.id), ['c01', 'c02'])
      && worker.calls.length === 2 && new Set(worker.calls.map((c) => c.cwd)).size === 2)
    t('S6: no schedule block in the report (in memory or on disk)',
      !('schedule' in report) && JSON.parse(read(join(artifactsDir, 'report.json'))).schedule === undefined)
    t('S6: no earlyStops block either — default mode has no stop input (in memory or on disk)',
      !('earlyStops' in report) && JSON.parse(read(join(artifactsDir, 'report.json'))).earlyStops === undefined)
    t("S6: today's lease ids, branches, and evidence paths",
      existsSync(join(artifactsDir, 'wt', 'c01')) && existsSync(join(artifactsDir, 'wt', 'c02'))
      && eq(branchesOf(git).sort(), ['swarm/wt-c01', 'swarm/wt-c02'])
      && existsSync(join(artifactsDir, 'c01', 'worker.log')) && existsSync(join(artifactsDir, 'c01', 'diff.patch')))
    t("S6: the runner's stdout lines are today's (attempt/gate verdict lines)",
      lines.some((l) => l.includes('[c01] attempt 1: worker start'))
      && lines.some((l) => l.includes('[c01] gate always-pass: PASS'))
      && lines.some((l) => l.includes('[c02] attempt 1: worker start')))
  }

  // ---------- S7: --jobs spec refusals (subprocess, nothing written) ----------
  {
    const cliRunRoot = join(sandbox, 'cli-run-root')
    const nonGit = join(sandbox, 'plain-dir')
    mkdirSync(cliRunRoot, { recursive: true })
    mkdirSync(nonGit, { recursive: true })
    const badSpecs = [
      ['missing file', 'nope.json', null, '--jobs file not found'],
      ['unparseable', 'bad.json', '{"phases": [', 'not valid JSON'],
      ['empty job set', 'empty.json', { phases: [{ id: 'p' }], jobs: [] }, 'empty job set'],
      ['duplicate job id', 'dup.json', { phases: [{ id: 'p' }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }, { id: 'j', phase: 'p', brief: 'b2' }] }, "duplicate job id 'j'"],
      ['bad id charset', 'charset.json', { phases: [{ id: 'p' }], jobs: [{ id: 'Job-1', phase: 'p', brief: 'b' }] }, 'does not match [a-z0-9][a-z0-9-]*'],
      ['job unknown field', 'jobfield.json', { phases: [{ id: 'p' }], jobs: [{ id: 'j', phase: 'p', brief: 'b', workspace: {} }] }, "unknown field 'workspace'"],
      ['job policy field', 'policy.json', { phases: [{ id: 'p' }], jobs: [{ id: 'j', phase: 'p', brief: 'b', contextPlan: {} }] }, "unknown field 'contextPlan'"],
      ['phase approvalGate', 'approval.json', { phases: [{ id: 'p', approvalGate: {} }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, "unknown field 'approvalGate'"],
      ['phase earlyStop non-object', 'es-shape.json', { phases: [{ id: 'p', earlyStop: 'after-2' }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, 'earlyStop must be an object'],
      ['phase earlyStop missing minSurvivors', 'es-missing.json', { phases: [{ id: 'p', earlyStop: {} }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, 'minSurvivors must be a positive integer'],
      ['phase earlyStop non-integer minSurvivors', 'es-frac.json', { phases: [{ id: 'p', earlyStop: { minSurvivors: 1.5 } }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, 'minSurvivors must be a positive integer'],
      ['phase earlyStop zero minSurvivors', 'es-zero.json', { phases: [{ id: 'p', earlyStop: { minSurvivors: 0 } }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, 'minSurvivors must be a positive integer'],
      ['phase earlyStop unknown sub-field', 'es-unknown.json', { phases: [{ id: 'p', earlyStop: { minSurvivors: 2, stopWhen: 'bored' } }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, "unknown field 'stopWhen'"],
      ['top-level unknown', 'top.json', { phases: [{ id: 'p' }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }], concurrencyPolicy: {} }, "unknown field 'concurrencyPolicy'"],
      ['non-all completion', 'quorum.json', { phases: [{ id: 'p', completion: 'quorum' }], jobs: [{ id: 'j', phase: 'p', brief: 'b' }] }, 'must be "all"'],
      ['unknown dependency', 'ghost.json', { phases: [{ id: 'p' }], jobs: [{ id: 'j', phase: 'p', brief: 'b', dependencies: ['ghost'] }] }, "'ghost', which is not in the job set"],
      ['unknown phase', 'nophase.json', { phases: [{ id: 'p' }], jobs: [{ id: 'j', phase: 'nope', brief: 'b' }] }, "phase 'nope', which is not in the phase set"],
      ['job cycle', 'cycle.json', {
        phases: [{ id: 'p' }],
        jobs: [
          { id: 'a', phase: 'p', brief: 'b', dependencies: ['c'] },
          { id: 'b', phase: 'p', brief: 'b', dependencies: ['a'] },
          { id: 'c', phase: 'p', brief: 'b', dependencies: ['b'] },
        ],
      }, 'dependency cycle'],
      ['phase cycle', 'pcycle.json', {
        phases: [{ id: 'p1', dependencies: ['p2'] }, { id: 'p2', dependencies: ['p1'] }],
        jobs: [{ id: 'ja', phase: 'p1', brief: 'b' }, { id: 'jb', phase: 'p2', brief: 'b' }],
      }, 'dependency cycle'],
    ]
    for (const [label, file, content, needle] of badSpecs) {
      const path = join(sandbox, `spec-${file}`)
      if (content !== null) writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
      let code = 0
      let out = ''
      try {
        run(process.execPath, [tsxCli, cliTs, '--repo', nonGit, '--jobs', path, '--goal', 'refusal check', '--run-root', cliRunRoot])
      } catch (e) {
        code = e.status ?? -1
        out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
      }
      t(`S7: ${label} refuses with exit 1 naming the offense`, code === 1 && out.includes(needle))
      t(`S7: ${label} — refused before repo validation (the jobs refusal wins)`, !out.includes('not a git repository'))
    }
    t('S7: every refusal wrote nothing — the run root stays empty (no artifacts dir, no locks/)',
      readdirSync(cliRunRoot).length === 0)
    const help = run(process.execPath, [tsxCli, cliTs, '--help'])
    t('S7: --help documents --jobs <path>', help.includes('--jobs <path>'))
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
      console.error(`\ncheck-scheduler: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-scheduler: ALL GREEN')
  })
