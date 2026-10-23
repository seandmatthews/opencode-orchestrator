// Verifier role self-check (Gate 1.25, fast tier, T-039) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-verifier.mjs
// All legs zero model tokens (the fast tier never runs the pipeline and Gate 2
// spends model tokens — the recorded T-007/T-009 argument):
//
// S1 — flags absent ⇒ the producer-only pattern: driving `runSkeleton` with
//      no verifierModel (the Gate 1.8/1.10/1.21 fake-adapter pattern) sends
//      no verification-tier dispatch, the report carries no `verifier` block,
//      and report.json keys are byte-shape-identical (no new fields anywhere);
//      no verifier evidence files exist.
// S2 — verifier present and populated (fake verifier adapter):
//      S2a: dispatch isolation (verification prompts reach ONLY the
//           verifier's own adapter), posture pins (every dispatch carries
//           'worktree-read' — the step-one probe's chosen posture,
//           scripts/diag-execute.mjs — at cwd = the candidate worktree
//           lease, never the canonical checkout), prompt pins (brief + the
//           captured diff + every gate's name/verdict/COMMAND + the novelty
//           directive + the JSON contract), the block's exact shape
//           ({model, ok, attempts, observations, rawOutputPath}, the
//           ReviewReport field pattern under a DISTINCT block), and the raw
//           output persisted at verifier-raw.txt with verifier.log beside it.
//      S2b: dispatch ORDER on one shared recorder (candidate + its fake gate):
//           planner → worker → gate → verifier → reviewer — the verifier sits
//           after the gate loop and before review.
// S3 — placement faces, both outcomes, + diff immunity, in one mixed drive
//      (c01's gate passes, c02's fails; the fake verifier writes a junk file
//      into the workspace it is handed, simulating execution side effects):
//      the verifier runs on the gate-FAILED candidate too; its junk file
//      appears in NO diff evidence (diffBytes equal the on-disk diff.patch,
//      which mentions no junk); review still fires on the survivor only.
// S4 — verdict immunity, adversarial form, on the same drive: both
//      candidates carry blocker-advisory findings, yet passedAllGates still
//      computes from `passed`/`diffBytes` alone — the passing candidate
//      passes, the failing candidate fails, and per candidate
//      passedAllGates === (gates.length > 0 && gates.every(passed) &&
//      diffBytes > 0).
// S5 — repair + degradation (the reviewer-repair leg pattern): invalid JSON
//      triggers EXACTLY one repair attempt (both dispatches sharing the
//      restricted request); a twice-invalid output records `ok: false` with
//      empty observations, persists the raw output, and changes nothing
//      downstream (the candidate's verdict is still the gates'; review still
//      ran and parsed on the survivor).
// S6 — CLI wiring, token-free: `--help` documents the three new flags;
//      real-CLI refusals (unknown --verifier-worker id; machine without its
//      command; a command on an opencode-resolved verifier) exit 1 with zero
//      side effects (the Gate 1.21 S2 shape); and a real-CLI --jobs run with
//      a machine worker + --verifier-model/--verifier-worker machine/
//      --verifier-command (echoing a valid observations object) end-to-ends
//      the role with zero tokens — block parsed from the machine adapter's
//      stdout, verifier-raw.txt + verifier.log on disk carrying the machine
//      argv, passedAllGates still gate-decided, --no-review respected.
//
// All git calls and subprocesses are list-form (AGENTS.md #4); the sandbox
// under C:\swarm is created and removed by this check (AGENTS.md #10).
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSkeleton } from '../src/runner.ts'
import { WorktreeProvider } from '../src/workspace/worktree.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const read = (p) => readFileSync(p, 'utf8')
const sortedKeys = (o) => Object.keys(o).sort()
const norm = (p) => p.replaceAll('\\', '/').toLowerCase()
const uniq = (arr) => [...new Set(arr)]

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-verifier'
const NODE = process.execPath
const VERIFIER_MODEL = 'fake/verifier-model'

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// A fake Gate (src/types.ts seam) that records its own invocation into a
// shared order array and carries a recorded `command` (the T-027
// GateResult.command shape), so the verifier prompt's gate lines can be
// pinned names/verdicts/commands. `failFor(cwd)` decides the verdict.
function fakeGate(name, order, failFor, command = 'node build.js') {
  return {
    name,
    run: async (cwd) => {
      const passed = !failFor || !failFor(cwd)
      order?.push('gate')
      return { name, passed, exitCode: passed ? 0 : 1, durationMs: 1, outputTail: passed ? 'ok' : 'build failed', command }
    },
  }
}

// A scripted FAKE WorkerAdapter (src/types.ts seam) that records every
// request handed to it (cwdExisted captured AT DISPATCH TIME, the Gate 1.20
// S1 pattern), optionally writes a marker file (worker posture) or a junk
// file (verifier execution side effects), and serves its scripted
// responseTails in call order (the last repeats).
function scriptedFake(responseTails, { writesMarker = false, writesJunk = false, order = null, tag = 'role' } = {}) {
  const reqs = []
  let calls = 0
  return {
    id: 'fake',
    reqs,
    async execute(req) {
      reqs.push({ ...req, cwdExisted: existsSync(req.cwd) })
      calls++
      order?.push(tag)
      try {
        appendFileSync(req.logPath, `fake call ${calls}\n`)
      } catch {
        // Logging must never break a run.
      }
      if (writesMarker) writeFileSync(join(req.cwd, 'marker.txt'), 'work\n')
      if (writesJunk) writeFileSync(join(req.cwd, 'verifier-junk.txt'), 'execution side effect\n')
      return {
        ok: true,
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
        logPath: req.logPath,
        responseTail: responseTails[Math.min(calls, responseTails.length) - 1],
        pid: null,
      }
    },
  }
}

// A repair-aware FAKE WorkerAdapter: serves `garbage` to the role's first
// pass and `valid` to the bounded repair attempt — keyed on the runner's
// repair prompt (which embeds the original), the Gate 1.21 pattern.
function repairAwareFake(garbage, valid, { writesMarker = false } = {}) {
  const reqs = []
  let calls = 0
  return {
    id: 'fake',
    reqs,
    async execute(req) {
      reqs.push({ ...req, cwdExisted: existsSync(req.cwd) })
      calls++
      try {
        appendFileSync(req.logPath, `fake call ${calls}\n`)
      } catch {
        // Logging must never break a run.
      }
      const isRepair = req.prompt.includes('Your previous response')
      if (!isRepair && writesMarker) writeFileSync(join(req.cwd, 'marker.txt'), 'work\n')
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: isRepair ? valid : garbage, pid: null }
    },
  }
}

const VALID_OBSERVATIONS = [
  { finding: 'edge case: division by zero unhandled', severity: 'blocker-advisory', evidence: 'node -e "calc.divide(1,0)" printed Infinity instead of throwing' },
  { finding: 'no timing guard around the build step', severity: 'info', evidence: 'time node build.js → 0.4s, uncapped' },
]
const validVerifierTail = JSON.stringify({ observations: VALID_OBSERVATIONS })

const byPrompt = (reqs, needle) => reqs.filter((r) => r.prompt.includes(needle))

async function drive(name, { worker, plannerWorker, reviewerWorker, verifierWorker, reviewerModel = 'fake/reviewer-model', verifierModel, gates, candidateIds = ['c01', 'c02'], concurrency = 2 }) {
  const scenarioDir = join(sandbox, name)
  const repo = join(scenarioDir, 'repo')
  const artifactsDir = join(scenarioDir, 'run')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '-b', 'main')
  writeFileSync(join(repo, 'base.txt'), 'baseline\n')
  git('-c', 'user.name=check-verifier', '-c', 'user.email=verifier@local', 'add', '-A')
  git('-c', 'user.name=check-verifier', '-c', 'user.email=verifier@local', 'commit', '-m', 'baseline')
  const baseSha = git('rev-parse', 'HEAD').trim()
  const report = await runSkeleton({
    runId: name,
    repo,
    baseSha,
    goal: 'write the marker file',
    model: 'fake/worker-model',
    plannerModel: 'fake/planner-model',
    reviewerModel,
    candidateIds,
    concurrency,
    timeoutMs: 10_000,
    maxAttempts: 1,
    gates: gates ?? [fakeGate('always-pass', null, null)],
    worker,
    ...(plannerWorker !== undefined ? { plannerWorker } : {}),
    ...(reviewerWorker !== undefined ? { reviewerWorker } : {}),
    ...(verifierModel !== undefined ? { verifierModel } : {}),
    ...(verifierWorker !== undefined ? { verifierWorker } : {}),
    workspaces: new WorktreeProvider(repo, artifactsDir),
    artifactsDir,
    cleanWorkspaces: false,
  })
  return { report, repo, artifactsDir }
}

async function main() {
  // ---------- S1 — flags absent: the producer-only pattern ----------
  {
    // Per-role fakes (no verifierModel passed at all — the true flags-absent
    // shape): planner gets briefs, reviewer gets observations, worker writes
    // the marker. Nothing verification-flavored exists to answer anything.
    const workerFake = scriptedFake(['done'], { writesMarker: true })
    const plannerFake = scriptedFake([JSON.stringify(['brief one', 'brief two'])])
    const reviewerFake = scriptedFake([JSON.stringify({ observations: [{ finding: 'an observation', severity: 'info', evidence: 'the diff' }] })])
    const { report, artifactsDir } = await drive('flags-absent', {
      worker: workerFake,
      plannerWorker: plannerFake,
      reviewerWorker: reviewerFake,
    })

    t('S1: no verification-tier dispatch was sent to ANY fake (flag absent ⇒ the role never dispatches)',
      byPrompt(workerFake.reqs, 'You are the verification tier').length === 0
      && byPrompt(plannerFake.reqs, 'You are the verification tier').length === 0
      && byPrompt(reviewerFake.reqs, 'You are the verification tier').length === 0)
    t('S1: no candidate carries a verifier block, in memory or on disk (the probes/rounds producer-only pattern)',
      report.candidates.every((c) => c.verifier === undefined))
    const onDisk = JSON.parse(read(join(artifactsDir, 'report.json')))
    t('S1: report.json top-level keys unchanged (no new fields)',
      eq(sortedKeys(onDisk), ['baseSha', 'candidates', 'finishedAt', 'goal', 'model', 'planner', 'repo', 'runId', 'startedAt']))
    t('S1: candidate report keys unchanged (review present; no verifier key)',
      onDisk.candidates.length === 2
      && onDisk.candidates.every((c) => eq(sortedKeys(c),
        ['attempts', 'brief', 'diffBytes', 'diffPath', 'gates', 'id', 'model', 'passedAllGates', 'review', 'workerDurationMs', 'workerId', 'workerOk', 'workerTimedOut', 'workspacePath'])))
    const evidenceFiles = readdirSync(join(artifactsDir, 'c01'))
    t('S1: no verifier evidence files exist in the candidate dir (no verifier-raw.txt, no verifier.log)',
      !evidenceFiles.some((f) => f.startsWith('verifier')))
    t('S1: candidates still pass exactly as before (worker ok, gates pass, diff non-empty, reviewed)',
      report.candidates.every((c) => c.workerOk === true && c.passedAllGates === true && c.diffBytes > 0 && c.review?.ok === true))
  }

  // ---------- S2a — verifier present and populated: isolation, posture,
  // ---------- prompt, block shape, raw persistence ----------
  {
    const workerFake = scriptedFake(['done'], { writesMarker: true })
    const plannerFake = scriptedFake([JSON.stringify(['brief one', 'brief two'])])
    const reviewerFake = scriptedFake([JSON.stringify({ observations: [{ finding: 'an observation', severity: 'info', evidence: 'the diff' }] })])
    const verifierFake = scriptedFake([validVerifierTail])
    const { report, repo, artifactsDir } = await drive('verifier-populated', {
      worker: workerFake,
      plannerWorker: plannerFake,
      reviewerWorker: reviewerFake,
      verifierWorker: verifierFake,
      verifierModel: VERIFIER_MODEL,
    })
    const verifierReqs = byPrompt(verifierFake.reqs, 'You are the verification tier')
    const normRepo = norm(repo)

    t('S2a: exactly one verifier dispatch per candidate, through the verifier fake only',
      verifierFake.reqs.length === 2 && verifierReqs.length === 2)
    t('S2a: no cross-contamination — the other roles\' fakes saw no verification prompts, the verifier fake saw no other role\'s prompts',
      byPrompt(workerFake.reqs, 'You are the verification tier').length === 0
      && byPrompt(plannerFake.reqs, 'You are the verification tier').length === 0
      && byPrompt(reviewerFake.reqs, 'You are the verification tier').length === 0
      && byPrompt(verifierFake.reqs, 'You are the planning tier').length === 0
      && byPrompt(verifierFake.reqs, 'You are the review tier').length === 0
      && byPrompt(verifierFake.reqs, 'You are implementing').length === 0)

    t('S2a: every verifier dispatch carries the chosen posture worktree-read, passed explicitly (the step-one probe\'s answer: execute-capable, scripts/diag-execute.mjs)',
      verifierReqs.every((r) => r.executionPolicy === 'worktree-read'))
    t('S2a: every verifier cwd is its candidate worktree lease (the report workspacePath), which existed at dispatch time',
      verifierReqs.every((r) => r.cwdExisted === true)
      && eq(uniq(verifierReqs.map((r) => norm(r.cwd))).sort(), report.candidates.map((c) => norm(c.workspacePath ?? '')).sort()))
    t('S2a: the verifier is never dispatched with the canonical checkout as cwd (nor anything inside it)',
      verifierReqs.every((r) => norm(r.cwd) !== normRepo && !norm(r.cwd).startsWith(`${normRepo}/`)))

    t('S2a: the verifier prompt carries the brief (each candidate its own, matched by workspace cwd)',
      verifierReqs.every((r) => {
        const cand = report.candidates.find((c) => norm(c.workspacePath ?? '') === norm(r.cwd))
        return cand !== undefined && r.prompt.includes(cand.brief)
      })
      && report.candidates.map((c) => c.brief).sort().join('|') === 'brief one|brief two')
    t('S2a: the verifier prompt carries the captured diff (the marker change)',
      verifierReqs.every((r) => r.prompt.includes('marker.txt')))
    t('S2a: the verifier prompt carries the gates that already ran — names, verdicts, AND recorded commands',
      verifierReqs.every((r) => r.prompt.includes('MACHINE GATES THAT ALREADY RAN')
        && r.prompt.includes('always-pass: PASS — command: node build.js')))
    t('S2a: the verifier prompt carries the novelty directive (do not merely re-run the suite; run NEW checks; cite every command)',
      verifierReqs.every((r) => r.prompt.includes('Do not merely re-run the gates that already ran')
        && r.prompt.includes('NEW checks')
        && r.prompt.includes('Cite EVERY command you ran')))
    t('S2a: the verifier prompt carries the JSON observations contract',
      verifierReqs.every((r) => r.prompt.includes('{"observations": [{"finding"')))

    t('S2a: the report carries a populated verifier block per candidate — {model, ok, attempts, observations, rawOutputPath}',
      report.candidates.every((c) => c.verifier !== undefined
        && c.verifier.model === VERIFIER_MODEL
        && c.verifier.ok === true
        && c.verifier.attempts === 1
        && eq(c.verifier.observations, VALID_OBSERVATIONS)
        && c.verifier.rawOutputPath === join(artifactsDir, c.id, 'verifier-raw.txt')))
    t('S2a: the raw output is persisted at verifier-raw.txt with its exact content, verifier.log beside it',
      report.candidates.every((c) => read(c.verifier.rawOutputPath) === validVerifierTail
        && existsSync(join(artifactsDir, c.id, 'verifier.log'))
        && read(join(artifactsDir, c.id, 'verifier.log')).includes('fake call')))
    t('S2a: the on-disk candidate keys gain exactly `verifier` (sorted)',
      JSON.parse(read(join(artifactsDir, 'report.json'))).candidates.every((c) => eq(sortedKeys(c),
        ['attempts', 'brief', 'diffBytes', 'diffPath', 'gates', 'id', 'model', 'passedAllGates', 'review', 'verifier', 'workerDurationMs', 'workerId', 'workerOk', 'workerTimedOut', 'workspacePath'])))
    t('S2a: the verifier block keys are the ReviewReport field pattern (sorted)',
      JSON.parse(read(join(artifactsDir, 'report.json'))).candidates.every((c) => eq(sortedKeys(c.verifier), ['attempts', 'model', 'observations', 'ok', 'rawOutputPath'])))
    t('S2a: review is unchanged — survivor-only, same shape, parsed (the verifier is not a reviewer replacement)',
      report.candidates.every((c) => c.review?.ok === true && c.passedAllGates === true))
  }

  // ---------- S2b — dispatch order: planner → worker → gate → verifier →
  // ---------- reviewer (one candidate, one shared recorder) ----------
  {
    const order = []
    const allInOne = {
      id: 'fake',
      reqs: [],
      async execute(req) {
        this.reqs.push({ ...req, cwdExisted: existsSync(req.cwd) })
        try {
          appendFileSync(req.logPath, 'fake call\n')
        } catch {
          // Logging must never break a run.
        }
        let responseTail = 'done'
        if (req.prompt.includes('You are the planning tier')) {
          order.push('planner')
          responseTail = JSON.stringify(['brief one'])
        } else if (req.prompt.includes('You are the verification tier')) {
          order.push('verifier')
          responseTail = validVerifierTail
        } else if (req.prompt.includes('You are the review tier')) {
          order.push('reviewer')
          responseTail = JSON.stringify({ observations: [{ finding: 'an observation', severity: 'info', evidence: 'the diff' }] })
        } else {
          order.push('worker')
          writeFileSync(join(req.cwd, 'marker.txt'), 'work\n')
        }
        return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail, pid: null }
      },
    }
    const { report } = await drive('verifier-order', {
      worker: allInOne,
      reviewerModel: 'fake/reviewer-model',
      verifierModel: VERIFIER_MODEL,
      verifierWorker: allInOne,
      gates: [fakeGate('always-pass', order, null)],
      candidateIds: ['c01'],
      concurrency: 1,
    })
    t('S2b: dispatch order is planner → worker → gate → verifier → reviewer (the verifier sits after the gate loop, before review)',
      eq(order, ['planner', 'worker', 'gate', 'verifier', 'reviewer']))
    t('S2b: the single-candidate drive still passed with a populated verifier block and review',
      report.candidates.length === 1 && report.candidates[0]?.passedAllGates === true
      && report.candidates[0]?.verifier?.ok === true && report.candidates[0]?.review?.ok === true)
  }

  // ---------- S3 + S4 — mixed outcomes: placement, diff immunity, verdict
  // ---------- immunity (adversarial form: blocker-advisory on both) ----------
  {
    const workerFake = scriptedFake(['done'], { writesMarker: true })
    const plannerFake = scriptedFake([JSON.stringify(['brief one', 'brief two'])])
    const reviewerFake = scriptedFake([JSON.stringify({ observations: [{ finding: 'an observation', severity: 'info', evidence: 'the diff' }] })])
    // The fake verifier writes a junk file into the workspace it is handed —
    // simulated execution side effects that must not appear in any diff
    // evidence — and returns blocker-advisory findings for BOTH candidates.
    const verifierFake = scriptedFake([validVerifierTail], { writesJunk: true })
    const { report, artifactsDir } = await drive('verifier-mixed-outcomes', {
      worker: workerFake,
      plannerWorker: plannerFake,
      reviewerWorker: reviewerFake,
      verifierWorker: verifierFake,
      verifierModel: VERIFIER_MODEL,
      // c01's worktree passes, c02's fails — decided by lease-id suffix.
      gates: [fakeGate('always-pass', null, (cwd) => norm(cwd).endsWith('/c02'))],
    })
    const c01 = report.candidates.find((c) => c.id === 'c01')
    const c02 = report.candidates.find((c) => c.id === 'c02')

    t('S3: the verifier ran on the gate-FAILED candidate too (both outcome faces driven)',
      verifierFake.reqs.length === 2
      && c01?.verifier !== undefined && c02?.verifier !== undefined)
    t('S3: the verifier block sits on the failing candidate despite its elimination (evidence about failures is evidence)',
      c02?.verifier?.ok === true && c02?.verifier.observations.some((o) => o.severity === 'blocker-advisory'))
    t('S3: diff immunity — the verifier\'s junk file appears in NO diff evidence; diffBytes equal the on-disk diff.patch captured before the verifier ran',
      report.candidates.every((c) => {
        const onDisk = read(join(artifactsDir, c.id, 'diff.patch'))
        return !onDisk.includes('verifier-junk')
          && Buffer.byteLength(onDisk) === c.diffBytes
          && onDisk.includes('marker.txt')
      }))
    t('S3: review still fires on the survivor only — c01 reviewed, c02 not (reviewer ordering unchanged)',
      c01?.review?.ok === true && c02?.review === undefined
      && byPrompt(reviewerFake.reqs, 'You are the review tier').length === 1)

    t('S4: adversarial form — BOTH candidates carry blocker-advisory verifier findings',
      report.candidates.every((c) => c.verifier?.observations.some((o) => o.severity === 'blocker-advisory')))
    t('S4: a gate-passing candidate with blocker-advisory findings still passes',
      c01?.passedAllGates === true)
    t('S4: a gate-failing candidate with blocker-advisory findings still fails (elimination unchanged)',
      c02?.passedAllGates === false && c02?.error === undefined && c02?.workerOk === true)
    t('S4: passedAllGates computes from passed/diffBytes alone, per candidate (no verifier input anywhere in the ladder)',
      report.candidates.every((c) => c.passedAllGates === (c.gates.length > 0 && c.gates.every((g) => g.passed) && c.diffBytes > 0)))
  }

  // ---------- S5 — repair + degradation ----------
  {
    // S5a — invalid JSON triggers EXACTLY one repair attempt, which parses.
    const workerFake = scriptedFake(['done'], { writesMarker: true })
    const plannerFake = scriptedFake([JSON.stringify(['brief one', 'brief two'])])
    const reviewerFake = scriptedFake([JSON.stringify({ observations: [{ finding: 'an observation', severity: 'info', evidence: 'the diff' }] })])
    const verifierFake = repairAwareFake('this is not json at all', validVerifierTail, { writesJunk: true })
    const { report } = await drive('verifier-repair', {
      worker: workerFake,
      plannerWorker: plannerFake,
      reviewerWorker: reviewerFake,
      verifierWorker: verifierFake,
      verifierModel: VERIFIER_MODEL,
      reviewerModel: 'fake/reviewer-model',
    })
    t('S5a: invalid output triggers exactly one repair attempt (2 dispatches per candidate, the second embedding the first response)',
      verifierFake.reqs.length === 4
      && byPrompt(verifierFake.reqs, 'Your previous response').length === 2)
    t('S5a: both the initial and the repair dispatch share the restricted request (worktree-read, same worktree cwd)',
      verifierFake.reqs.every((r) => r.executionPolicy === 'worktree-read')
      && verifierFake.reqs.filter((r) => norm(r.cwd) === norm(verifierFake.reqs[0]?.cwd ?? '')).length === 2)
    t('S5a: the repair parsed — ok true, attempts 2, observations intact',
      report.candidates.every((c) => c.verifier?.ok === true && c.verifier.attempts === 2
        && eq(c.verifier.observations, VALID_OBSERVATIONS)))
    t('S5a: the worker never saw a repair prompt (the repair is the verifier\'s own bounded attempt — no worker-class dispatch embeds a previous response)',
      workerFake.reqs.filter((r) => r.prompt.includes('You are implementing') && r.prompt.includes('Your previous response')).length === 0)

    // S5b — twice-invalid degrades gracefully: ok false, empty observations,
    // nothing downstream changes.
    const workerFake2 = scriptedFake(['done'], { writesMarker: true })
    const plannerFake2 = scriptedFake([JSON.stringify(['brief one', 'brief two'])])
    const reviewerFake2 = scriptedFake([JSON.stringify({ observations: [{ finding: 'an observation', severity: 'info', evidence: 'the diff' }] })])
    const verifierFake2 = repairAwareFake('still not json', 'nor is this')
    const r2 = await drive('verifier-degrade', {
      worker: workerFake2,
      plannerWorker: plannerFake2,
      reviewerWorker: reviewerFake2,
      verifierWorker: verifierFake2,
      verifierModel: VERIFIER_MODEL,
      reviewerModel: 'fake/reviewer-model',
    })
    const c = r2.report.candidates[0]
    t('S5b: a twice-invalid output records ok false, attempts 2, observations empty',
      r2.report.candidates.every((x) => x.verifier?.ok === false && x.verifier.attempts === 2 && x.verifier.observations.length === 0))
    t('S5b: the raw output is persisted even on degradation (the second invalid response, verbatim)',
      c?.verifier !== undefined && read(c.verifier.rawOutputPath) === 'nor is this')
    t('S5b: degradation changes nothing downstream — the verdict is still the gates\', and review still ran and parsed on the survivor',
      r2.report.candidates.every((x) => x.passedAllGates === true && x.workerOk === true && x.diffBytes > 0)
      && r2.report.candidates.every((x) => x.review?.ok === true))
  }

  // ---------- S6 — CLI wiring (real CLI, token-free) ----------
  {
    const dir = join(sandbox, 's6')
    const runs = join(dir, 'runs')
    const notARepo = join(dir, 'not-a-repo')
    mkdirSync(notARepo, { recursive: true })
    const cli = (args, { timeout = 60_000 } = {}) => {
      let code = 0
      let out = ''
      try {
        out = execFileSync(process.execPath, [
          join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          join(root, 'src', 'cli.ts'),
          ...args,
        ], { encoding: 'utf8', windowsHide: true, timeout })
      } catch (e) {
        code = e.status ?? -1
        out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
      }
      return { code, out }
    }

    const help = cli(['--help'])
    t('S6: --help documents --verifier-model, --verifier-worker, --verifier-command',
      help.code === 0
      && help.out.includes('--verifier-model <id>')
      && help.out.includes('--verifier-worker <id>')
      && help.out.includes('--verifier-command <json>'))

    const expectRefusal = (label, args, needle) => {
      const { code, out } = cli(args)
      const sideEffects = existsSync(runs)
        ? readdirSync(runs).filter((d) => /^\d{14}$/.test(d) || d === 'locks')
        : []
      t(`S6: ${label} — exit 1, names the offense, zero side effects`,
        code === 1 && out.includes(needle) && sideEffects.length === 0)
      if (code !== 1) console.error(`--- refusal output (${label}, exit ${code}) ---\n${out}`)
    }
    const cmdJson = JSON.stringify([NODE, '-e', 'process.exit(0)'])
    expectRefusal('unknown --verifier-worker id',
      ['--repo', notARepo, '--goal', 'g', '--verifier-worker', 'bogus', '--run-root', runs],
      "unknown worker adapter 'bogus' (available: opencode, machine)")
    expectRefusal('a verifier resolving to machine without its command flag',
      ['--repo', notARepo, '--goal', 'g', '--verifier-worker', 'machine', '--run-root', runs],
      '--verifier-worker machine requires a machine command')
    expectRefusal('a --verifier-command on a verifier resolving to opencode (the default)',
      ['--repo', notARepo, '--goal', 'g', '--verifier-command', cmdJson, '--run-root', runs],
      "sets a machine command but the verifier resolves to the 'opencode' worker")

    // Token-free end-to-end: a real-CLI --jobs run whose worker AND verifier
    // are machine adapters (the Gate 1.21 S3 shape). The machine verifier's
    // command echoes a valid observations object on stdout; --no-review
    // keeps the opencode reviewer out; the planner phase is skipped in
    // --jobs mode. The verifier rides --jobs mode like the reviewer does.
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
    git('init', '-b', 'main')
    writeFileSync(join(repo, 'README.md'), 'verifier e2e sandbox\n')
    // T-043: base-state marker so the marker gate is green on the untouched
    // base (pre-T-043 the file only existed after the worker ran); the worker
    // writes different content, so the diff stays non-empty.
    writeFileSync(join(repo, 'marker-a.txt'), 'verifier base state\n')
    git('-c', 'user.name=check-verifier', '-c', 'user.email=verifier@local', 'add', '-A')
    git('-c', 'user.name=check-verifier', '-c', 'user.email=verifier@local', 'commit', '-m', 'baseline')

    const workerCmd = [NODE, '-e', "require('fs').writeFileSync('marker-a.txt', 'machine-a\\n')"]
    const verifierCmd = [NODE, '-e', 'console.log(JSON.stringify({observations:[{finding:"machine verifier poked the marker and saw no replay harness",severity:"concern",evidence:"ran the marker gate command by hand; exit 0; artifact present"}]}))']
    const specPath = join(dir, 'spec.json')
    writeFileSync(specPath, JSON.stringify({
      phases: [{ id: 'work' }],
      jobs: [
        { id: 'codemod', phase: 'work', dependencies: [], brief: 'write marker A', worker: 'machine', command: workerCmd, gates: [{ name: 'marker-a', command: 'node -e "require(\'fs\').accessSync(\'marker-a.txt\')"' }] },
      ],
    }, null, 2))

    const e2e = cli([
      '--repo', repo,
      '--jobs', specPath,
      '--verifier-model', VERIFIER_MODEL,
      '--verifier-worker', 'machine',
      '--verifier-command', JSON.stringify(verifierCmd),
      '--no-review',
      '--run-root', runs,
      '--db', join(dir, 'refinery.db'),
      '--clean',
    ], { timeout: 120_000 })
    if (e2e.code !== 0) console.error(`--- verifier e2e run output (exit ${e2e.code}) ---\n${e2e.out}`)
    t('S6: the real-CLI --jobs run with a machine verifier exits 0', e2e.code === 0)
    t('S6: the run header names the enabled verifier (verifier: <model>) and its non-default adapter (verifier=machine)',
      e2e.out.includes(`verifier: ${VERIFIER_MODEL}`) && e2e.out.includes('verifier=machine'))
    const runDirs = existsSync(runs) ? readdirSync(runs).filter((d) => /^\d{14}$/.test(d)) : []
    t('S6: exactly one run dir was created', runDirs.length === 1)
    if (runDirs.length !== 1) throw new Error('S6: no run dir to assert on')
    const runDir = join(runs, runDirs[0])
    const report = JSON.parse(read(join(runDir, 'report.json')))
    const candidate = report.candidates[0]

    t('S6: the candidate PASSes its gate — the verifier block never touched the verdict (passedAllGates gate-decided)',
      candidate?.passedAllGates === true && candidate?.workerOk === true
      && candidate?.gates?.[0]?.name === 'marker-a' && candidate?.gates?.[0]?.passed === true)
    t('S6: the verifier block is populated from the machine adapter\'s stdout — model recorded verbatim, observation parsed with its cited evidence',
      candidate?.verifier?.model === VERIFIER_MODEL
      && candidate?.verifier?.ok === true
      && candidate?.verifier?.attempts === 1
      && candidate?.verifier?.observations.length === 1
      && candidate?.verifier?.observations[0]?.severity === 'concern'
      && candidate?.verifier?.observations[0]?.evidence.includes('exit 0'))
    t('S6: verifier-raw.txt is persisted in the candidate evidence dir with the machine adapter\'s stdout',
      existsSync(join(runDir, 'codemod', 'verifier-raw.txt'))
      && read(join(runDir, 'codemod', 'verifier-raw.txt')).includes('machine verifier poked the marker'))
    t('S6: verifier.log carries the machine adapter\'s argv header (the machine adapter served the verifier role), never an opencode argv',
      read(join(runDir, 'codemod', 'verifier.log')).includes(`$ machine ${JSON.stringify(verifierCmd)}`)
      && !read(join(runDir, 'codemod', 'verifier.log')).includes('$ opencode'))
    t('S6: --no-review respected — no review block, no review evidence (the verifier is not a reviewer replacement)',
      candidate?.review === undefined && !existsSync(join(runDir, 'codemod', 'review.json')))
    t('S6: the machine verifier ran in the candidate worktree — the diff captured the worker\'s marker change, never the verifier\'s effects',
      read(join(runDir, 'codemod', 'diff.patch')).includes('marker-a.txt'))
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
      console.error(`\ncheck-verifier: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-verifier: ALL GREEN')
  })
