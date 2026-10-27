// Verifier findings into the retry brief self-check (Gate 1.27, fast tier,
// T-040) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-gate-retry-findings.mjs
// Drives `runSkeleton` directly with FAKE WorkerAdapters (worker + verifier,
// the src/types.ts seam — the check-gate-retry/check-verifier pattern) against
// throwaway fixture repos — zero model tokens. Pins T-040: the PRE-RETRY
// verifier call site fires exactly when the T-038 leg is retry-eligible
// (worker succeeded, non-zero captured diff, ≥1 machine gate failed, the one
// retry unspent) and BEFORE composition; the composed brief carries BOTH
// sections — every failing gate's name/command/outputTail AND the included
// blocker-advisory/concern findings with their evidence — under the documented
// caps (MAX_RETRY_FINDINGS top-N, MAX_RETRY_FINDING_CHARS per string; the
// gate output stays the primary payload); `gateRetry.findings`
// {count, included, ok} records the provenance; a parse failure (or a crashed
// verifier, or a run with no verifier configured) composes a GATES-ONLY brief
// and the retry still fires; zero findings (or info-only findings) compose a
// gates-only brief byte-identical to T-038's composition; and the T-038
// verdict immunity holds in its ADVERSARIAL form — a candidate whose pre-retry
// verification returned blocker-advisory findings survives iff the re-run
// gates pass and is eliminated iff they fail. Findings shape what the retry
// TRIES; the re-run gates decide what SURVIVES (decisions.md 2026-10-10 —
// gates decide survival; models advise). All git calls are list-form
// (AGENTS.md #4); the sandbox is removed at the end (AGENTS.md #10).
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as runner from '../src/runner.ts'
import { workerDispatchPrompt } from '../src/runner.ts'
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
// T-060: the orientation block the engine prepends to every worker dispatch —
// recomposed here so the expected prompt bytes stay exact (the builderPrompt
// precedent; deterministic recomposition, Gate 1.46 O1).
const orientationFor = (repo, baseSha, leasePath) =>
  composeWorkerOrientation({ leasePath, baseSha, digest: composePlannerDigest({ repo, baseSha }) }).text

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-gate-retry-findings'
const IDENTITY = ['-c', 'user.name=check-gate-retry-findings', '-c', 'user.email=findings@local']

// The documented caps (src/runner.ts, VERIFICATION.md Gate 1.27). Asserted
// against the engine's own exports below so the documentation and the code
// cannot drift — a namespace import (not named) so the pre-change RED BAR is
// behavioral assertions, not a module-link crash.
const MAX_RETRY_FINDINGS = 5
const MAX_RETRY_FINDING_CHARS = 2_000

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// A fake WorkerAdapter for the WORKER role (src/types.ts seam): a scripted
// list of steps, replaying the last step once out. Pushes 'worker' onto the
// shared order recorder. Every call appends to the adapter's logPath first.
function fakeWorker(steps, order) {
  const calls = []
  const prompts = []
  let idx = 0
  return {
    id: 'fake',
    calls,
    prompts,
    async execute(req) {
      order?.push('worker')
      calls.push(req.cwd)
      prompts.push(req.prompt)
      try {
        appendFileSync(req.logPath, `fake worker call ${calls.length}\n`)
      } catch {
        // Logging must never break a run.
      }
      const step = steps[Math.min(idx++, steps.length - 1)]
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

// A fake WorkerAdapter for the VERIFIER role: serves its scripted response
// tails in call order (the last repeats), records every request (cwdExisted
// captured AT DISPATCH TIME — the check-verifier pattern), pushes 'verifier'
// onto the shared order recorder, and can be told to THROW on a given call
// number (a crashed verifier must never block the mechanical retry).
function fakeVerifier(tails, order, { throwOnCall = null } = {}) {
  const reqs = []
  let idx = 0
  return {
    id: 'fake-verifier',
    reqs,
    async execute(req) {
      order?.push('verifier')
      reqs.push({ ...req, cwdExisted: existsSync(req.cwd) })
      idx++
      try {
        appendFileSync(req.logPath, `fake verifier call ${idx}\n`)
      } catch {
        // Logging must never break a run.
      }
      if (throwOnCall !== null && idx === throwOnCall) throw new Error('verifier adapter crashed (fixture)')
      return {
        ok: true,
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
        logPath: req.logPath,
        responseTail: tails[Math.min(idx, tails.length) - 1],
        pid: null,
      }
    },
  }
}

// Content-discriminating fake gates (the check-gate-retry pattern): the SAME
// gate objects are handed to the job and re-run on every attempt; each pushes
// its name onto the shared order recorder. A marker gate passes iff the
// workspace marker carries `fixedContent`.
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

// One throwaway fixture repo per scenario: fresh branch namespace, so
// scenarios cannot collide on swarm/* branch names. List-form git only.
async function drive(name, { worker, gates, verifierModel, verifierWorker, gateRetry, maxAttempts = 1, plannerModel = null }) {
  const scenarioDir = join(sandbox, name)
  const repo = join(scenarioDir, 'repo')
  const artifactsDir = join(scenarioDir, 'run')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '-b', 'main')
  writeFileSync(join(repo, 'base.txt'), 'baseline\n')
  git(...IDENTITY, 'add', '-A')
  git(...IDENTITY, 'commit', '-m', 'baseline')
  const baseSha = git('rev-parse', 'HEAD').trim()
  const report = await runner.runSkeleton({
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
    ...(verifierModel !== undefined ? { verifierModel } : {}),
    ...(verifierWorker !== undefined ? { verifierWorker } : {}),
    workspaces: new WorktreeProvider(repo, artifactsDir),
    artifactsDir,
    cleanWorkspaces: false,
  })
  return { report, repo, artifactsDir, baseSha, git }
}

const parseDispatch = (artifactsDir) => read(join(artifactsDir, 'dispatch.jsonl'))
  .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

// The F1 findings payload: one blocker-advisory, one concern, one info — the
// info finding must NEVER ride the brief (only blocker-advisory and concern
// are eligible, the ticket's composition contract).
const FINDING_B = 'T040-B: inverted bounds are silently accepted by the marker helper'
const EVIDENCE_B = 'T040-EV-B: ran node probe-b.js; exit 0 printed the wrong bounds'
const FINDING_C = 'T040-C: no guard against an empty marker file'
const EVIDENCE_C = 'T040-EV-C: ran node probe-c.js on an empty file; silent success'
const FINDING_I = 'T040-I: purely informational style note that must not ride'
const EVIDENCE_I = 'T040-EV-I: looked at the shape of the diff'
const T1 = JSON.stringify({
  observations: [
    { finding: FINDING_B, severity: 'blocker-advisory', evidence: EVIDENCE_B },
    { finding: FINDING_C, severity: 'concern', evidence: EVIDENCE_C },
    { finding: FINDING_I, severity: 'info', evidence: EVIDENCE_I },
  ],
})
// The FINAL attempt's verifier (T-039's own call site, unchanged) answers
// differently, so the two legs' raw-output files are distinguishable bytes.
const T2 = JSON.stringify({ observations: [{ finding: 'final-attempt verification tail', severity: 'info', evidence: 'final diff' }] })

const main = async () => {
  // The documented caps are the engine's own exported constants — the check
  // pins the documented VALUES so code and documentation cannot drift.
  t('F0: the engine exports the documented caps (MAX_RETRY_FINDINGS 5, MAX_RETRY_FINDING_CHARS 2000)',
    runner.MAX_RETRY_FINDINGS === MAX_RETRY_FINDINGS && runner.MAX_RETRY_FINDING_CHARS === MAX_RETRY_FINDING_CHARS)

  // ---------- F1: the pre-retry call site fires exactly when the T-038 leg
  // ---------- is retry-eligible, BEFORE composition; both sections ride.
  {
    const order = []
    const worker = fakeWorker([
      { ok: true, write: { file: 'marker.txt', content: 'broken v1\n' }, responseTail: 'I changed marker.txt to broken v1' },
      { ok: true, write: { file: 'marker.txt', content: 'fixed v2\n' }, responseTail: 'I fixed marker.txt to fixed v2' },
    ], order)
    const verifier = fakeVerifier([T1, T2], order)
    const gates = [markerGate('build', 'fixed', order), markerGate('lint', 'fixed', order), staticGate('always-pass', true, 'always-pass: ok', order)]
    const { report, repo, artifactsDir, baseSha } = await drive('findings-ride', { worker, gates, gateRetry: true, verifierModel: 'fake/verifier-model', verifierWorker: verifier })
    const c = report.candidates[0]
    const a1 = c.attempts[0]
    const a2 = c.attempts[1]

    t('F1: exactly two attempts, worker executed twice, attempt 1 failed gates-failed with attempt gateResults',
      c.attempts.length === 2 && worker.calls.length === 2
      && a1?.state === 'failed' && a1?.failure?.reason === 'gates-failed' && Array.isArray(a1?.gateResults)
      && a1.gateResults.length === 3 && a1.gateResults[0]?.passed === false)
    t('F1: dispatch order — the pre-retry verifier sits AFTER the failing leg\'s gate loop and BEFORE attempt 2\'s worker dispatch (fires exactly when retry-eligible, before composition)',
      eq(order, ['worker', 'build', 'lint', 'always-pass', 'verifier', 'worker', 'build', 'lint', 'always-pass', 'verifier']))
    t('F1: exactly two verifier dispatches — the pre-retry one at the FAILING attempt\'s lease (wt/c01), the final one at the retry lease (wt/c01-a2), both worktree-read, both cwd an existing worktree',
      verifier.reqs.length === 2
      && norm(verifier.reqs[0]?.cwd ?? '') === norm(join(artifactsDir, 'wt', 'c01')) && verifier.reqs[0]?.cwdExisted === true
      && norm(verifier.reqs[1]?.cwd ?? '') === norm(join(artifactsDir, 'wt', 'c01-a2')) && verifier.reqs[1]?.cwdExisted === true
      && verifier.reqs.every((r) => r.executionPolicy === 'worktree-read'))
    t('F1: the pre-retry verifier prompt carries the failure context — the gates that already ran (names, verdicts, recorded commands), the captured diff, and the brief',
      verifier.reqs[0]?.prompt.includes('MACHINE GATES THAT ALREADY RAN')
      && verifier.reqs[0]?.prompt.includes('build: FAIL — command: node check-build.js')
      && verifier.reqs[0]?.prompt.includes('lint: FAIL — command: node check-lint.js')
      && verifier.reqs[0]?.prompt.includes('broken v1')
      && verifier.reqs[0]?.prompt.includes('write the marker file'))

    const briefPath = join(artifactsDir, 'c01', 'attempt-2', 'retry-brief.txt')
    t('F1: the composed brief file exists in the retry attempt\'s evidence dir', existsSync(briefPath))
    const briefText = read(briefPath)
    t('F1: the composed brief carries the GATES section — every failing gate\'s name, command, and outputTail (and no passing-gate output)',
      briefText.includes('FAILED MACHINE GATES')
      && briefText.includes('GATE: build') && briefText.includes('node check-build.js') && briefText.includes('build: marker says broken v1')
      && briefText.includes('GATE: lint') && briefText.includes('node check-lint.js') && briefText.includes('lint: marker says broken v1')
      && !briefText.includes('always-pass: ok'))
    t('F1: the composed brief carries the FINDINGS section — each included blocker-advisory/concern finding WITH its evidence, after the gates section',
      briefText.includes('VERIFIER FINDINGS')
      && briefText.indexOf('VERIFIER FINDINGS') > briefText.indexOf('FAILED MACHINE GATES')
      && briefText.includes(FINDING_B) && briefText.includes(EVIDENCE_B)
      && briefText.includes(FINDING_C) && briefText.includes(EVIDENCE_C))
    t('F1: the info-severity finding did NOT ride the brief (only blocker-advisory and concern are eligible)',
      !briefText.includes(FINDING_I) && !briefText.includes(EVIDENCE_I))
    t('F1: the composed brief still carries the T-038 payload — original brief, captured diff, worker summary',
      briefText.includes('write the marker file') && briefText.includes('broken v1') && briefText.includes('I changed marker.txt to broken v1'))
    t('F1: gateRetry is exactly {fromAttempt, toAttempt, gates, fingerprint, findings{count, included, ok}} — the T-038 shape plus the T-040 provenance',
      c.gateRetry !== undefined
      && c.gateRetry.fromAttempt === 1 && c.gateRetry.toAttempt === 2
      && eq(c.gateRetry.gates, ['build', 'lint'])
      && /^[0-9a-f]{64}$/.test(c.gateRetry.fingerprint)
      && eq(c.gateRetry.findings, { count: 2, included: 2, ok: true }))
    t('F1: the fingerprint covers the FULL composed text including the findings section (sha256 of the brief file bytes)',
      sha256Hex(briefText) === c.gateRetry?.fingerprint)
    t('F1: the findings reached attempt 2\'s actual prompt (its promptVersion hashes the brief text containing them — one composition, two consumers)',
      a2?.promptVersion === sha256Hex(workerDispatchPrompt(briefText, join(artifactsDir, 'wt', 'c01-a2'), orientationFor(repo, baseSha, join(artifactsDir, 'wt', 'c01-a2'))))
      && worker.prompts[1]?.includes(FINDING_B) && worker.prompts[1]?.includes(EVIDENCE_C))
    t('F1: the two legs\' verifier evidence files are DISTINCT and intact — the pre-retry leg at verifier-pre-retry{.log,-raw.txt} in the failing attempt\'s evidence dir, the final leg at verifier{.log,-raw.txt}',
      read(join(artifactsDir, 'c01', 'verifier-pre-retry-raw.txt')) === T1
      && existsSync(join(artifactsDir, 'c01', 'verifier-pre-retry.log'))
      && read(join(artifactsDir, 'c01', 'verifier-raw.txt')) === T2
      && existsSync(join(artifactsDir, 'c01', 'verifier.log')))
    t('F1: VERDICT IMMUNITY (survive face) — blocker-advisory findings rode the brief yet the candidate survives iff the re-run gates pass',
      c.passedAllGates === true && c.error === undefined && c.workerOk === true
      && c.gates.length === 3 && c.gates.every((g) => g.passed === true))
    t('F1: dispatch.jsonl keeps its line shapes (header gateRetry: true, 2 dispatches, 2 completions — no new line shapes)',
      parseDispatch(artifactsDir)[0]?.gateRetry === true
      && parseDispatch(artifactsDir).filter((l) => l.type === 'dispatch').length === 2
      && parseDispatch(artifactsDir).filter((l) => l.type === 'completion').length === 2)
  }

  // ---------- F2: a verifier parse failure composes a GATES-ONLY brief and
  // ---------- the retry still fires (the recorded degradation).
  {
    const order = []
    const worker = fakeWorker([
      { ok: true, write: { file: 'marker.txt', content: 'broken v1\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'fixed v2\n' } },
    ], order)
    const verifier = fakeVerifier(['this is not json at all', 'nor is this'], order)
    const gates = [markerGate('build', 'fixed', order)]
    const { report, artifactsDir } = await drive('parse-degrades', { worker, gates, gateRetry: true, verifierModel: 'fake/verifier-model', verifierWorker: verifier })
    const c = report.candidates[0]
    const briefText = read(join(artifactsDir, 'c01', 'attempt-2', 'retry-brief.txt'))
    t('F2: the verifier ran its bounded repair on the pre-retry leg AND the final leg ran its own verification (4 dispatches: pre-retry initial + repair, final initial + repair; each leg\'s runVerifier repairs independently)',
      verifier.reqs.length === 4 && verifier.reqs.filter((r) => r.prompt.includes('Your previous response')).length === 2)
    t('F2: the composed brief is GATES-ONLY — no findings section, no verifier garbage in the worker\'s input',
      !briefText.includes('VERIFIER FINDINGS') && !briefText.includes('this is not json') && !briefText.includes('nor is this')
      && briefText.includes('FAILED MACHINE GATES') && briefText.includes('GATE: build'))
    t('F2: the degradation is recorded — findings {count: 0, included: 0, ok: false} — and the retry STILL fired',
      eq(c.gateRetry?.findings, { count: 0, included: 0, ok: false })
      && c.gateRetry?.fromAttempt === 1 && c.gateRetry?.toAttempt === 2 && c.attempts.length === 2)
    t('F2: the pre-retry leg\'s raw output is persisted verbatim even on degradation',
      read(join(artifactsDir, 'c01', 'verifier-pre-retry-raw.txt')) === 'nor is this')
    t('F2: the fingerprint still covers the exact gates-only text; the candidate survives on the re-run gates (parse failure changed nothing about the verdict)',
      sha256Hex(briefText) === c.gateRetry?.fingerprint && c.passedAllGates === true && c.error === undefined)
  }

  // ---------- F2b: a CRASHED verifier never blocks the mechanical retry.
  {
    const order = []
    const worker = fakeWorker([
      { ok: true, write: { file: 'marker.txt', content: 'broken v1\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'fixed v2\n' } },
    ], order)
    const verifier = fakeVerifier([T1, T2], order, { throwOnCall: 1 })
    const gates = [markerGate('build', 'fixed', order)]
    const { report, artifactsDir } = await drive('verifier-crashes', { worker, gates, gateRetry: true, verifierModel: 'fake/verifier-model', verifierWorker: verifier })
    const c = report.candidates[0]
    const briefText = read(join(artifactsDir, 'c01', 'attempt-2', 'retry-brief.txt'))
    t('F2b: a verifier adapter crash on the pre-retry leg composes a gates-only brief and the retry still fires (the leg stays gates-failed — never an error leg)',
      !briefText.includes('VERIFIER FINDINGS') && briefText.includes('FAILED MACHINE GATES')
      && eq(c.gateRetry?.findings, { count: 0, included: 0, ok: false })
      && c.attempts.length === 2 && c.attempts[0]?.failure?.reason === 'gates-failed'
      && c.attempts[1]?.state === 'succeeded' && c.passedAllGates === true && c.error === undefined)
  }

  // ---------- F3: the zero-findings faces — gates-only brief, retry
  // ---------- unchanged from T-038's behavior.
  {
    const order = []
    const worker = fakeWorker([
      { ok: true, write: { file: 'marker.txt', content: 'broken v1\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'fixed v2\n' } },
    ], order)
    const verifier = fakeVerifier([JSON.stringify({ observations: [] }), T2], order)
    const gates = [markerGate('build', 'fixed', order), markerGate('lint', 'fixed', order)]
    const { report, artifactsDir } = await drive('zero-findings', { worker, gates, gateRetry: true, verifierModel: 'fake/verifier-model', verifierWorker: verifier })
    const c = report.candidates[0]
    const briefText = read(join(artifactsDir, 'c01', 'attempt-2', 'retry-brief.txt'))
    t('F3a: a verifier returning NO observations composes a gates-only brief (no findings section), retry unchanged from T-038',
      !briefText.includes('VERIFIER FINDINGS')
      && briefText.includes('FAILED MACHINE GATES') && briefText.includes('GATE: build') && briefText.includes('GATE: lint')
      && eq(c.gateRetry?.findings, { count: 0, included: 0, ok: true })
      && c.attempts.length === 2 && c.passedAllGates === true)
    t('F3a: the fingerprint covers the exact gates-only text', sha256Hex(briefText) === c.gateRetry?.fingerprint)
  }
  {
    const order = []
    const worker = fakeWorker([
      { ok: true, write: { file: 'marker.txt', content: 'broken v1\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'fixed v2\n' } },
    ], order)
    const verifier = fakeVerifier([JSON.stringify({ observations: [{ finding: FINDING_I, severity: 'info', evidence: EVIDENCE_I }] }), T2], order)
    const gates = [markerGate('build', 'fixed', order)]
    const { report, artifactsDir } = await drive('info-only', { worker, gates, gateRetry: true, verifierModel: 'fake/verifier-model', verifierWorker: verifier })
    const c = report.candidates[0]
    const briefText = read(join(artifactsDir, 'c01', 'attempt-2', 'retry-brief.txt'))
    t('F3b: an INFO-only verification is zero ELIGIBLE findings — gates-only brief, count 0, retry unchanged',
      !briefText.includes('VERIFIER FINDINGS') && !briefText.includes(FINDING_I)
      && briefText.includes('FAILED MACHINE GATES')
      && eq(c.gateRetry?.findings, { count: 0, included: 0, ok: true })
      && c.attempts.length === 2 && c.passedAllGates === true)
  }

  // ---------- F4: verdict immunity, the adversarial form — findings present
  // ---------- on the ELIMINATION face.
  {
    const order = []
    const worker = fakeWorker([
      { ok: true, write: { file: 'marker.txt', content: 'broken v1\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'still broken v2\n' } },
    ], order)
    const verifier = fakeVerifier([T1, T1], order)
    const gates = [markerGate('build', 'fixed', order)]
    const { report, artifactsDir } = await drive('findings-eliminated', { worker, gates, gateRetry: true, verifierModel: 'fake/verifier-model', verifierWorker: verifier })
    const c = report.candidates[0]
    const briefText = read(join(artifactsDir, 'c01', 'attempt-2', 'retry-brief.txt'))
    t('F4: the blocker-advisory findings rode the retry brief on the elimination face too',
      briefText.includes('VERIFIER FINDINGS') && briefText.includes(FINDING_B))
    t('F4: VERDICT IMMUNITY (eliminate face) — the candidate is eliminated iff the re-run gates fail, with no error and no new elimination vocabulary',
      c.attempts.length === 2 && c.passedAllGates === false && c.error === undefined && c.workerOk === true
      && c.gates.length === 1 && c.gates[0]?.passed === false
      && eq(c.gateRetry?.findings, { count: 2, included: 2, ok: true }))
    t('F4: passedAllGates computes from passed/diffBytes alone — findings are never a verdict input',
      c.passedAllGates === (c.gates.length > 0 && c.gates.every((g) => g.passed) && c.diffBytes > 0))
  }

  // ---------- F5: caps hold under flood — a dozen long findings produce a
  // ---------- brief within the documented bounds, gates section intact.
  {
    const order = []
    const N = 12
    const flood = {
      observations: Array.from({ length: N }, (_, i) => ({
        finding: `flood finding ${i} ${'x'.repeat(2400)}`,
        severity: 'blocker-advisory',
        evidence: `flood evidence ${i} ${'y'.repeat(2400)}`,
      })),
    }
    const worker = fakeWorker([
      { ok: true, write: { file: 'marker.txt', content: 'broken v1\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'fixed v2\n' } },
    ], order)
    const verifier = fakeVerifier([JSON.stringify(flood), T2], order)
    const gates = [markerGate('build', 'fixed', order), markerGate('lint', 'fixed', order)]
    const { report, artifactsDir } = await drive('flood', { worker, gates, gateRetry: true, verifierModel: 'fake/verifier-model', verifierWorker: verifier })
    const c = report.candidates[0]
    const briefText = read(join(artifactsDir, 'c01', 'attempt-2', 'retry-brief.txt'))
    t('F5: provenance under flood — count 12, included capped at MAX_RETRY_FINDINGS (5)',
      eq(c.gateRetry?.findings, { count: N, included: MAX_RETRY_FINDINGS, ok: true }))
    const lines = briefText.split('\n')
    const findingLines = lines.filter((l) => l.startsWith('FINDING ('))
    const evidenceLines = lines.filter((l) => l.startsWith('EVIDENCE: '))
    t('F5: exactly MAX_RETRY_FINDINGS findings embedded, and they are the FIRST N in order (top-N, not a sample)',
      findingLines.length === MAX_RETRY_FINDINGS
      && [0, 1, 2, 3, 4].every((i) => briefText.includes(`flood finding ${i} `))
      && [5, 6, 7, 8, 9, 10, 11].every((i) => !briefText.includes(`flood finding ${i} `)))
    t('F5: every embedded finding and evidence string is char-capped at MAX_RETRY_FINDING_CHARS',
      findingLines.every((l) => l.length <= 'FINDING (blocker-advisory): '.length + MAX_RETRY_FINDING_CHARS)
      && evidenceLines.length === MAX_RETRY_FINDINGS
      && evidenceLines.every((l) => l.length <= 'EVIDENCE: '.length + MAX_RETRY_FINDING_CHARS))
    t('F5: the brief stays within the documented bound (gates output keeps room — the flood cannot drown it)',
      briefText.length < 2 * N * (MAX_RETRY_FINDING_CHARS + 60) + 4000)
    t('F5: the GATES section is intact under the flood — every failing gate\'s name, command, and outputTail present',
      briefText.includes('FAILED MACHINE GATES')
      && briefText.includes('GATE: build') && briefText.includes('node check-build.js') && briefText.includes('build: marker says broken v1')
      && briefText.includes('GATE: lint') && briefText.includes('node check-lint.js') && briefText.includes('lint: marker says broken v1'))
    t('F5: the T-038 payload survives the flood too (original brief, diff, fingerprint exact)',
      briefText.includes('write the marker file') && briefText.includes('broken v1')
      && sha256Hex(briefText) === c.gateRetry?.fingerprint
      && c.passedAllGates === true)
  }

  // ---------- F0: a run with NO verifier configured — the T-038 behavior
  // ---------- byte-for-byte, with honest zero provenance.
  {
    const order = []
    const worker = fakeWorker([
      { ok: true, write: { file: 'marker.txt', content: 'broken v1\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'fixed v2\n' } },
    ], order)
    const gates = [markerGate('build', 'fixed', order)]
    const { report, artifactsDir } = await drive('no-verifier', { worker, gates, gateRetry: true })
    const c = report.candidates[0]
    const briefText = read(join(artifactsDir, 'c01', 'attempt-2', 'retry-brief.txt'))
    t('F0: verifier absence never blocks the mechanical retry — gates-only brief, retry fired, zero provenance recorded honestly',
      !briefText.includes('VERIFIER FINDINGS') && briefText.includes('FAILED MACHINE GATES')
      && eq(c.gateRetry?.findings, { count: 0, included: 0, ok: false })
      && c.attempts.length === 2 && c.passedAllGates === true
      && !existsSync(join(artifactsDir, 'c01', 'verifier-pre-retry-raw.txt'))
      && !existsSync(join(artifactsDir, 'c01', 'verifier.log')))
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
      console.error(`\ncheck-gate-retry-findings: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-gate-retry-findings: ALL GREEN')
  })
