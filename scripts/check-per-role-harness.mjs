// Per-role harness selection self-check (Gate 1.21, fast tier, T-025) — run
// under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-per-role-harness.mjs
// Three legs, zero model tokens (the fast tier never runs the pipeline and
// Gate 2 spends model tokens — the recorded T-007/T-009 argument):
//
// S1 — fake-adapter dispatch capture (the Gate 1.8/1.10 fake-adapter
//      pattern: `runSkeleton` driven with FAKE WorkerAdapters + fake Gates
//      against throwaway fixture repos, one per scenario). Flags absent ⇒
//      the single fake serves every planner, reviewer, and worker dispatch.
//      plannerWorker/reviewerWorker present ⇒ each role's dispatches
//      (initial + the bounded repair attempts) hit that role's fake and
//      ONLY that fake, while worker dispatches keep hitting the run-level
//      fake. Also extends the Gate 1.20 S1 per-site request pins to
//      per-role adapters: planner dispatches still carry 'artifact-only'
//      at the scratch cwd, reviewer dispatches 'worktree-read' at the
//      candidate workspace, worker dispatches 'worktree-write' at the
//      worktree; report.json keys stay exact (no new fields).
// S2 — real-CLI refusals, exit 1, zero side effects (no artifacts dir, no
//      locks/ — the Gate 1.17 S6 harness shape, each through the real CLI
//      with a non-git --repo so the refusal provably precedes repo
//      validation): unknown --planner-worker/--reviewer-worker id (the
//      registry message verbatim); a role resolving to machine without its
//      command flag; a command flag on a role resolving to opencode;
//      malformed command JSON (not JSON, non-array, empty array, non-string
//      entry, empty-string entry); and the unchanged run-level --worker
//      machine refusal re-pinned VERBATIM (the proof the contract was not
//      flipped).
// S3 — token-free machine-reviewer end-to-end: a real-CLI --jobs run with a
//      machine worker job (marker-file gate) plus --reviewer-worker machine
//      --reviewer-command echoing a valid observations object (and the
//      planner flags accepted alongside): the candidate PASSes its gate,
//      review fires post-gates through the reviewer's own machine adapter,
//      review.json carries the parsed observations, reviewer.log carries
//      the machine argv header, no planner phase runs (the planner flags
//      are accepted-but-ignored in --jobs mode), and the worker leg's
//      evidence is untouched. The first token-free run with a non-empty
//      advisory review (before T-025 a token-free run needed --no-review,
//      T-017).
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

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-per-role'
const NODE = process.execPath
const REVIEWER_MODEL = 'zai-coding-plan/glm-5.3'

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// A fake Gate (src/types.ts seam): deterministic verdict, no subprocess.
const passGate = {
  name: 'always-pass',
  run: async () => ({ name: 'always-pass', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok' }),
}

// A scripted FAKE WorkerAdapter (src/types.ts seam): records every request
// it is handed (cwdExisted captured AT DISPATCH TIME, the Gate 1.20 S1
// pattern) and serves its scripted responseTails in call order (the last
// one repeats).
function scriptedFake(responseTails, { writesMarker = false } = {}) {
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
      if (writesMarker) writeFileSync(join(req.cwd, 'marker.txt'), 'work\n')
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
// repair prompt (which embeds the original), so two concurrent candidates
// each independently take the repair path. The caller decides what the
// garbage/valid tails are for its role.
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

const uniq = (arr) => [...new Set(arr)]

// A role-detecting single fake (the check-capabilities capturingWorker
// shape) for the flags-absent scenario: one adapter must serve all roles,
// so it answers by the prompt's phase — valid briefs, valid observations,
// or the worker's marker write.
function allInOneFake() {
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
      let responseTail = 'done'
      if (req.prompt.includes('You are the planning tier')) {
        responseTail = JSON.stringify(['brief one', 'brief two'])
      } else if (req.prompt.includes('You are the review tier')) {
        responseTail = JSON.stringify({ observations: [{ finding: 'an observation', severity: 'info', evidence: 'the diff' }] })
      } else {
        writeFileSync(join(req.cwd, 'marker.txt'), 'work\n')
      }
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail, pid: null }
    },
  }
}

async function drive(name, { worker, plannerWorker, reviewerWorker, reviewerModel = 'fake/reviewer-model' }) {
  const scenarioDir = join(sandbox, name)
  const repo = join(scenarioDir, 'repo')
  const artifactsDir = join(scenarioDir, 'run')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '-b', 'main')
  writeFileSync(join(repo, 'base.txt'), 'baseline\n')
  git('-c', 'user.name=check-per-role', '-c', 'user.email=per-role@local', 'add', '-A')
  git('-c', 'user.name=check-per-role', '-c', 'user.email=per-role@local', 'commit', '-m', 'baseline')
  const baseSha = git('rev-parse', 'HEAD').trim()
  const report = await runSkeleton({
    runId: name,
    repo,
    baseSha,
    goal: 'write the marker file',
    model: 'fake/worker-model',
    plannerModel: 'fake/planner-model',
    reviewerModel,
    candidateIds: ['c01', 'c02'],
    concurrency: 2,
    timeoutMs: 10_000,
    maxAttempts: 1,
    gates: [passGate],
    worker,
    ...(plannerWorker !== undefined ? { plannerWorker } : {}),
    ...(reviewerWorker !== undefined ? { reviewerWorker } : {}),
    workspaces: new WorktreeProvider(repo, artifactsDir),
    artifactsDir,
    cleanWorkspaces: false,
  })
  return { report, repo, artifactsDir }
}

const byPrompt = (reqs, needle) => reqs.filter((r) => r.prompt.includes(needle))

async function main() {
  // ---------- S1a — flags absent: the single fake serves every role ----------
  {
    const fake = allInOneFake()
    const { report, repo, artifactsDir } = await drive('flags-absent', { worker: fake })
    const plannerReqs = byPrompt(fake.reqs, 'You are the planning tier')
    const workerReqs = byPrompt(fake.reqs, 'You are implementing')
    const reviewerReqs = byPrompt(fake.reqs, 'You are the review tier')

    t('S1a: with no per-role fields the single fake saw planner, reviewer, AND worker dispatches (all three classes non-empty)',
      plannerReqs.length === 1 && reviewerReqs.length === 2 && workerReqs.length === 2)
    t('S1a: the single fake served EVERY dispatch — the three classes account for all of its traffic, nothing went elsewhere',
      fake.reqs.length === plannerReqs.length + reviewerReqs.length + workerReqs.length)
    t('S1a: candidates pass exactly as before (worker ok, gates pass, diff non-empty, reviewed)',
      report.candidates.length === 2
      && report.candidates.every((c) => c.workerOk === true && c.passedAllGates === true
        && c.diffBytes > 0 && c.review?.ok === true))
    t('S1a: planner report unchanged in shape and meaning (ok, no fallback, one brief per candidate)',
      report.planner?.ok === true && report.planner?.fallbackUsed === false
      && report.planner?.briefs?.length === 2)

    // Report shape unchanged (no new report.json fields anywhere).
    const onDisk = JSON.parse(read(join(artifactsDir, 'report.json')))
    t('S1a: report.json top-level keys unchanged',
      eq(sortedKeys(onDisk), ['baseSha', 'candidates', 'finishedAt', 'goal', 'model', 'planner', 'repo', 'runId', 'startedAt']))
    t('S1a: candidate report keys unchanged (review present; no new fields)',
      onDisk.candidates.length === 2
      && onDisk.candidates.every((c) => eq(sortedKeys(c),
        ['attempts', 'brief', 'diffBytes', 'diffPath', 'gates', 'id', 'model', 'passedAllGates', 'review', 'workerDurationMs', 'workerId', 'workerOk', 'workerTimedOut', 'workspacePath'])))
  }

  // ---------- S1b — per-role adapters: each role's dispatches (repairs
  // ---------- included) hit that role's fake and only that fake ----------
  {
    const workerFake = scriptedFake(['done'], { writesMarker: true })
    // Garbage first response forces the bounded repair attempt on each
    // advisory role — both dispatches of a role must hit that role's fake.
    const plannerFake = repairAwareFake('not a json array at all', JSON.stringify(['brief one', 'brief two']))
    const reviewerFake = repairAwareFake(
      'definitely not json',
      JSON.stringify({ observations: [{ finding: 'an observation', severity: 'info', evidence: 'the diff' }] }),
    )
    const { report, repo, artifactsDir } = await drive('per-role', {
      worker: workerFake,
      plannerWorker: plannerFake,
      reviewerWorker: reviewerFake,
    })

    const plannerReqs = byPrompt(plannerFake.reqs, 'You are the planning tier')
    const reviewerReqs = byPrompt(reviewerFake.reqs, 'You are the review tier')

    t('S1b: planner initial + bounded repair BOTH hit the planner fake (2 dispatches, planning prompts only)',
      plannerFake.reqs.length === 2 && plannerReqs.length === 2
      && byPrompt(plannerFake.reqs, 'Your previous response').length === 1)
    t('S1b: reviewer initial + bounded repair BOTH hit the reviewer fake, for BOTH candidates (4 dispatches: 2 initial + 2 repair, review prompts only)',
      reviewerFake.reqs.length === 4 && reviewerReqs.length === 4
      && byPrompt(reviewerFake.reqs, 'Your previous response').length === 2)
    t('S1b: worker dispatches keep hitting the run-level fake (2 dispatches, builder prompts only, no repair)',
      workerFake.reqs.length === 2 && byPrompt(workerFake.reqs, 'You are implementing').length === 2
      && byPrompt(workerFake.reqs, 'Your previous response').length === 0)
    t('S1b: no cross-contamination — each fake received only its own role\'s prompts',
      byPrompt(plannerFake.reqs, 'You are the review tier').length === 0 && byPrompt(plannerFake.reqs, 'You are implementing').length === 0
      && byPrompt(reviewerFake.reqs, 'You are the planning tier').length === 0 && byPrompt(reviewerFake.reqs, 'You are implementing').length === 0
      && byPrompt(workerFake.reqs, 'You are the planning tier').length === 0 && byPrompt(workerFake.reqs, 'You are the review tier').length === 0)

    // The T-023 per-site request pins survive per-role adapters (the Gate
    // 1.20 S1 pins, extended to the per-role world).
    const normRepo = norm(repo)
    const normArtifacts = norm(artifactsDir)
    t('S1b (Gate 1.20 extension): planner dispatches through the planner fake still carry artifact-only at the scratch cwd under the artifacts dir',
      plannerFake.reqs.every((r) => r.executionPolicy === 'artifact-only')
      && plannerFake.reqs.every((r) => r.cwdExisted === true)
      && plannerFake.reqs.every((r) => norm(r.cwd).startsWith(`${normArtifacts}/planner-scratch`))
      && plannerFake.reqs.every((r) => norm(r.cwd) !== normRepo && !norm(r.cwd).startsWith(`${normRepo}/`)))
    t('S1b (Gate 1.20 extension): reviewer dispatches through the reviewer fake still carry worktree-read at the candidate workspaces',
      reviewerFake.reqs.every((r) => r.executionPolicy === 'worktree-read')
      && eq(uniq(reviewerFake.reqs.map((r) => norm(r.cwd))).sort(), report.candidates.map((c) => norm(c.workspacePath ?? '')).sort()))
    t('S1b (Gate 1.20 extension): worker dispatches through the run-level fake still carry worktree-write at the worktrees',
      workerFake.reqs.every((r) => r.executionPolicy === 'worktree-write')
      && eq(uniq(workerFake.reqs.map((r) => norm(r.cwd))).sort(), report.candidates.map((c) => norm(c.workspacePath ?? '')).sort()))

    t('S1b: candidates pass exactly as before — planner repaired to valid briefs (attempts 2), review repaired (attempts 2), review ok',
      report.candidates.length === 2
      && report.candidates.every((c) => c.workerOk === true && c.passedAllGates === true
        && c.diffBytes > 0 && c.review?.ok === true && c.review?.attempts === 2)
      && report.planner?.ok === true && report.planner?.fallbackUsed === false && report.planner?.attempts === 2)
    const onDisk = JSON.parse(read(join(artifactsDir, 'report.json')))
    t('S1b: report.json top-level + candidate keys unchanged (no new fields)',
      eq(sortedKeys(onDisk), ['baseSha', 'candidates', 'finishedAt', 'goal', 'model', 'planner', 'repo', 'runId', 'startedAt'])
      && onDisk.candidates.every((c) => eq(sortedKeys(c),
        ['attempts', 'brief', 'diffBytes', 'diffPath', 'gates', 'id', 'model', 'passedAllGates', 'review', 'workerDurationMs', 'workerId', 'workerOk', 'workerTimedOut', 'workspacePath'])))
  }

  // ---------- S2 — real-CLI refusals, exit 1, zero side effects ----------
  {
    const runs = join(sandbox, 's2', 'runs')
    const notARepo = join(sandbox, 's2', 'not-a-repo')
    mkdirSync(notARepo, { recursive: true })
    const expectRefusal = (label, args, needle) => {
      let code = 0
      let out = ''
      try {
        out = execFileSync(process.execPath, [
          join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          join(root, 'src', 'cli.ts'),
          ...args,
        ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      } catch (e) {
        code = e.status ?? -1
        out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
      }
      const sideEffects = existsSync(runs)
        ? readdirSync(runs).filter((d) => /^\d{14}$/.test(d) || d === 'locks')
        : []
      t(`S2: ${label} — exit 1, names the offense, zero side effects (no artifacts dir, no lock)`,
        code === 1 && out.includes(needle) && sideEffects.length === 0)
      if (code !== 1) console.error(`--- refusal output (${label}, exit ${code}) ---\n${out}`)
    }
    const cmdJson = JSON.stringify([NODE, '-e', 'process.exit(0)'])

    expectRefusal('unknown --planner-worker id',
      ['--repo', notARepo, '--goal', 'g', '--planner-worker', 'bogus', '--run-root', runs],
      "unknown worker adapter 'bogus' (available: opencode, machine)")
    expectRefusal('unknown --reviewer-worker id',
      ['--repo', notARepo, '--goal', 'g', '--reviewer-worker', 'bogus', '--run-root', runs],
      "unknown worker adapter 'bogus' (available: opencode, machine)")
    expectRefusal('a planner resolving to machine without its command flag',
      ['--repo', notARepo, '--goal', 'g', '--planner-worker', 'machine', '--run-root', runs],
      '--planner-worker machine requires a machine command')
    expectRefusal('a reviewer resolving to machine without its command flag',
      ['--repo', notARepo, '--goal', 'g', '--reviewer-worker', 'machine', '--run-root', runs],
      '--reviewer-worker machine requires a machine command')
    expectRefusal('a --planner-command on a planner resolving to opencode (the default)',
      ['--repo', notARepo, '--goal', 'g', '--planner-command', cmdJson, '--run-root', runs],
      "sets a machine command but the planner resolves to the 'opencode' worker")
    expectRefusal('a --reviewer-command on a reviewer resolving to opencode (the default)',
      ['--repo', notARepo, '--goal', 'g', '--reviewer-command', cmdJson, '--run-root', runs],
      "sets a machine command but the reviewer resolves to the 'opencode' worker")
    expectRefusal('a --planner-command with the role explicitly resolved to opencode',
      ['--repo', notARepo, '--goal', 'g', '--planner-worker', 'opencode', '--planner-command', cmdJson, '--run-root', runs],
      "sets a machine command but the planner resolves to the 'opencode' worker")
    expectRefusal('malformed command JSON (not JSON at all)',
      ['--repo', notARepo, '--goal', 'g', '--reviewer-worker', 'machine', '--reviewer-command', 'not json', '--run-root', runs],
      '--reviewer-command is not valid JSON')
    expectRefusal('malformed command JSON (a JSON string, not an array)',
      ['--repo', notARepo, '--goal', 'g', '--reviewer-worker', 'machine', '--reviewer-command', JSON.stringify('node -e "0"'), '--run-root', runs],
      '--reviewer-command must be a JSON argv list')
    expectRefusal('malformed command JSON (an empty array)',
      ['--repo', notARepo, '--goal', 'g', '--reviewer-worker', 'machine', '--reviewer-command', '[]', '--run-root', runs],
      '--reviewer-command must be a JSON argv list')
    expectRefusal('malformed command JSON (a non-string argv entry)',
      ['--repo', notARepo, '--goal', 'g', '--reviewer-worker', 'machine', '--reviewer-command', JSON.stringify([NODE, 3]), '--run-root', runs],
      '--reviewer-command must be a JSON argv list')
    expectRefusal('malformed command JSON (an empty-string argv entry)',
      ['--repo', notARepo, '--goal', 'g', '--reviewer-worker', 'machine', '--reviewer-command', JSON.stringify([NODE, '']), '--run-root', runs],
      '--reviewer-command must be a JSON argv list')
    // The standing run-level refusal re-pinned VERBATIM (Gate 1.17 S6's
    // contract stands unflipped — no flip discipline owed).
    expectRefusal('the unchanged run-level --worker machine refusal, message verbatim',
      ['--repo', notARepo, '--goal', 'g', '--worker', 'machine', '--run-root', runs],
      '--worker machine is not valid at run level — the planner and reviewer phases run through the run-level worker and have no machine command; select machine per job in a --jobs spec (worker: "machine" + command)')
  }

  // ---------- S3 — token-free machine-reviewer end-to-end (real CLI) ----------
  {
    const dir = join(sandbox, 's3')
    const repo = join(dir, 'repo')
    mkdirSync(repo, { recursive: true })
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
    git('init', '-b', 'main')
    writeFileSync(join(repo, 'README.md'), 'per-role e2e sandbox\n')
    // T-043: base-state marker so the marker gate is green on the untouched
    // base (pre-T-043 the file only existed after the worker ran); the worker
    // writes different content, so the diff stays non-empty.
    writeFileSync(join(repo, 'marker-a.txt'), 'per-role base state\n')
    git('-c', 'user.name=check-per-role', '-c', 'user.email=per-role@local', 'add', '-A')
    git('-c', 'user.name=check-per-role', '-c', 'user.email=per-role@local', 'commit', '-m', 'baseline')

    const runs = join(dir, 'runs')
    const specPath = join(dir, 'spec.json')
    const workerCmd = [NODE, '-e', "require('fs').writeFileSync('marker-a.txt', 'machine-a\\n')"]
    // The machine reviewer's command echoes a valid observations object on
    // stdout — parseReviewable advisory evidence produced with zero tokens.
    const reviewerCmd = [NODE, '-e', 'console.log(JSON.stringify({observations:[{finding:"machine review saw the marker diff",severity:"info",evidence:"the captured diff and the disposable worktree"}]}))']
    // The machine planner's command is required by the pairing rule and
    // never executed: the planner phase is skipped in --jobs mode.
    const plannerCmd = [NODE, '-e', 'process.exit(0)']
    writeFileSync(specPath, JSON.stringify({
      phases: [{ id: 'work' }],
      jobs: [
        { id: 'codemod', phase: 'work', dependencies: [], brief: 'write marker A', worker: 'machine', command: workerCmd, gates: [{ name: 'marker-a', command: 'node -e "require(\'fs\').accessSync(\'marker-a.txt\')"' }] },
      ],
    }, null, 2))

    let code = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [
        join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(root, 'src', 'cli.ts'),
        '--repo', repo,
        '--jobs', specPath,
        '--planner-worker', 'machine', '--planner-command', JSON.stringify(plannerCmd),
        '--reviewer-worker', 'machine', '--reviewer-command', JSON.stringify(reviewerCmd),
        '--run-root', runs,
        '--db', join(dir, 'refinery.db'),
        '--clean',
      ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
    } catch (e) {
      code = e.status ?? -1
      out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
    }
    if (code !== 0) console.error(`--- per-role e2e run output (exit ${code}) ---\n${out}`)
    t('S3: the real-CLI --jobs run with machine advisory roles exits 0', code === 0)
    t('S3: the run header names both non-default roles (the ticket\'s `planner=machine reviewer=machine` shape)', out.includes('(worker: opencode, planner=machine reviewer=machine)'))
    const runDirs = existsSync(runs) ? readdirSync(runs).filter((d) => /^\d{14}$/.test(d)) : []
    t('S3: exactly one run dir was created', runDirs.length === 1)
    if (runDirs.length !== 1) throw new Error('S3: no run dir to assert on')
    const runDir = join(runs, runDirs[0])
    const report = JSON.parse(read(join(runDir, 'report.json')))
    const candidate = report.candidates[0]

    t('S3: the machine worker job PASSes its real gate — workerId machine, workerOk, diffBytes > 0, passedAllGates',
      candidate?.workerId === 'machine' && candidate?.workerOk === true
      && candidate?.diffBytes > 0 && candidate?.passedAllGates === true
      && candidate?.gates?.[0]?.name === 'marker-a' && candidate?.gates?.[0]?.passed === true)

    // Review fired post-gates through the reviewer's own machine adapter.
    const reviewPath = join(runDir, 'codemod', 'review.json')
    t('S3: review fired (post-gates) and review.json carries the parsed observations from the machine adapter\'s output',
      existsSync(reviewPath)
      && eq(JSON.parse(read(reviewPath)), {
        ok: true,
        attempts: 1,
        model: REVIEWER_MODEL,
        observations: [{ finding: 'machine review saw the marker diff', severity: 'info', evidence: 'the captured diff and the disposable worktree' }],
        rawOutputPath: join(runDir, 'codemod', 'review-raw.txt'),
      }))
    const reviewerLog = read(join(runDir, 'codemod', 'reviewer.log'))
    t('S3: reviewer.log carries the machine adapter\'s argv header (the machine adapter served the reviewer role), never an opencode argv',
      reviewerLog.includes(`$ machine ${JSON.stringify(reviewerCmd)}`)
      && reviewerLog.includes(`model: ${REVIEWER_MODEL} (ignored`)
      && !reviewerLog.includes('$ opencode'))
    t('S3: the configured reviewer model string is recorded verbatim in review.json though no model ran (machine.ts honesty)',
      JSON.parse(read(reviewPath)).model === REVIEWER_MODEL)

    // The planner flags were accepted but the planner phase never ran.
    t('S3: the planner flags were accepted-but-ignored in --jobs mode — no planner.log, no planner block in the report',
      !existsSync(join(runDir, 'planner.log')) && report.planner === undefined)

    // The worker leg is untouched: exactly its own argv and its own diff.
    t('S3: the worker leg is untouched — the candidate worker.log carries exactly its own machine argv, never a role command',
      read(join(runDir, 'codemod', 'worker.log')).includes(JSON.stringify(workerCmd))
      && !read(join(runDir, 'codemod', 'worker.log')).includes(JSON.stringify(reviewerCmd))
      && !read(join(runDir, 'codemod', 'worker.log')).includes(JSON.stringify(plannerCmd)))
    t('S3: the candidate diff captured its own marker-file change',
      read(join(runDir, 'codemod', 'diff.patch')).includes('marker-a.txt'))
    // T-045: this drive is a TRUE overlap positive — the gate command
    // (`node -e "require('fs').accessSync('marker-a.txt')"` names
    // marker-a.txt, and the worker's machine command changed it — so the
    // candidate legitimately carries the gate/diff overlap block. The key
    // set gains exactly that ticketed producer (still no adapter-id
    // fields, the assertion's T-025 intent), and the block's content is
    // pinned as the true positive it is.
    t('S3: the overlap block is the true positive (gate marker-a executes the changed marker-a.txt), never a verdict input',
      eq(candidate?.gateCommandOverlap, [{ gate: 'marker-a', touched: ['marker-a.txt'] }])
      && candidate?.passedAllGates === true)
    t('S3: report shape unchanged — candidate keys exact with review present (no adapter-id fields added; gateCommandOverlap is T-045\'s ticketed producer, present as the true positive above)',
      eq(sortedKeys(candidate),
        ['attempts', 'brief', 'diffBytes', 'diffPath', 'gateCommandOverlap', 'gates', 'id', 'model', 'passedAllGates', 'review', 'workerDurationMs', 'workerId', 'workerOk', 'workerTimedOut', 'workspacePath']))
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
      console.error(`\ncheck-per-role-harness: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-per-role-harness: ALL GREEN')
  })
