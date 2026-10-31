// Role capability restriction self-check (Gate 1.20, fast tier, T-023) —
// run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-capabilities.mjs
// Two legs, zero model tokens, no git worktrees of its own beyond the
// throwaway fixture repos' leases:
//
// S1 — request capture (the Gate 1.8/1.10 fake-adapter pattern, the
//      check-retry shape): drives `runSkeleton` directly with a FAKE
//      WorkerAdapter + fake Gates against throwaway fixture repos and pins
//      what the runner actually SENT: planner requests carry
//      'artifact-only' with a cwd that exists, is under the run artifacts
//      dir, is neither the target repo nor inside it (and whose prompt
//      names no repo path); reviewer requests carry 'worktree-read' with
//      cwd = the candidate workspace path; worker requests carry
//      'worktree-write' with cwd = the worktree; the planner scratch dir is
//      created before the phase and gone after it; the on-disk report.json
//      key shape is unchanged (no new fields anywhere). Also pins that the
//      bounded planner repair attempt shares the same restricted request.
// S2 — stub-bin argv pin (constructor-injected binPath, the Gate 1.12 S2
//      pin face): `OpenCodeWorker` pointed at a stub executable that
//      records its real argv and env.PWD/OLDPWD. 'artifact-only' and
//      'worktree-read' → argv contains `--agent plan`; 'worktree-write'
//      and absent → it never appears; PWD/OLDPWD equal req.cwd in all four
//      cases; the spawn log line reflects the actual argv. Since T-042 the
//      prompt never appears in argv (the stdin transport — Gate 1.28 pins
//      the transport itself; this pin keeps tracking the argv shape the
//      policy translation produces). The stub is the
//      node executable itself with the recorder injected via
//      NODE_OPTIONS=--require (the adapter's spawn is list-form, so the
//      recorder sees exactly the argv the adapter built).
//
// All git calls are list-form (AGENTS.md #4); the sandbox under C:\swarm is
// created and removed by this check (AGENTS.md #10).
import { swarmRoot } from './swarm-root.mjs'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSkeleton } from '../src/runner.ts'
import { WorktreeProvider } from '../src/workspace/worktree.ts'
import { OpenCodeWorker } from '../src/worker/opencode.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const norm = (p) => p.replaceAll('\\', '/').toLowerCase()
const read = (p) => readFileSync(p, 'utf8')
const sortedKeys = (o) => Object.keys(o).sort()

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = swarmRoot + '/verify-capabilities'

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// A fake Gate (src/types.ts seam): deterministic verdict, no subprocess.
const passGate = {
  name: 'always-pass',
  run: async () => ({ name: 'always-pass', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok' }),
}

// A capturing FAKE WorkerAdapter (src/types.ts seam): records every request
// it is handed, then plays the role the prompt names — planner (valid brief
// array, or garbage for the repair scenario), reviewer (valid observations
// object), worker (writes the marker file so the diff is non-empty).
function capturingWorker({ plannerFirstResponse } = {}) {
  const reqs = []
  let plannerCalls = 0
  const base = (req, responseTail) => ({
    ok: true,
    exitCode: 0,
    timedOut: false,
    durationMs: 5,
    logPath: req.logPath,
    responseTail,
    pid: null,
  })
  return {
    id: 'fake',
    reqs,
    async execute(req) {
      // cwdExisted is captured AT DISPATCH TIME: the planner's scratch dir
      // is removed best-effort after the phase, so post-hoc checks cannot
      // observe its existence — the dispatched request's cwd existed when
      // the adapter was handed it.
      reqs.push({ ...req, cwdExisted: existsSync(req.cwd) })
      try {
        appendFileSync(req.logPath, `fake worker call ${reqs.length}\n`)
      } catch {
        // Logging must never break a run.
      }
      if (req.prompt.includes('You are the planning tier')) {
        plannerCalls++
        if (plannerFirstResponse && plannerCalls === 1) return base(req, plannerFirstResponse)
        return base(req, JSON.stringify(['brief one', 'brief two']))
      }
      if (req.prompt.includes('You are the review tier')) {
        return base(req, JSON.stringify({ observations: [{ finding: 'an observation', severity: 'info', evidence: 'the diff' }] }))
      }
      writeFileSync(join(req.cwd, 'marker.txt'), 'work\n')
      return base(req, 'done')
    },
  }
}

async function drive(name, { worker, reviewerModel }) {
  const scenarioDir = join(sandbox, name)
  const repo = join(scenarioDir, 'repo')
  const artifactsDir = join(scenarioDir, 'run')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '-b', 'main')
  writeFileSync(join(repo, 'base.txt'), 'baseline\n')
  git('-c', 'user.name=check-capabilities', '-c', 'user.email=capabilities@local', 'add', '-A')
  git('-c', 'user.name=check-capabilities', '-c', 'user.email=capabilities@local', 'commit', '-m', 'baseline')
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
    workspaces: new WorktreeProvider(repo, artifactsDir),
    artifactsDir,
    cleanWorkspaces: false,
  })
  return { report, repo, artifactsDir }
}

// ---------- S1 — request capture: what the runner actually sent ----------
const main = async () => {
  {
    const worker = capturingWorker()
    const { report, repo, artifactsDir } = await drive('capabilities-capture', { worker, reviewerModel: 'fake/reviewer-model' })
    const reqs = worker.reqs
    const plannerReqs = reqs.filter((r) => r.prompt.includes('You are the planning tier'))
    const workerReqs = reqs.filter((r) => r.prompt.includes('You are implementing'))
    const reviewerReqs = reqs.filter((r) => r.prompt.includes('You are the review tier'))
    const scratch = join(artifactsDir, 'planner-scratch')
    const normRepo = norm(repo)
    const normArtifacts = norm(artifactsDir)

    t('S1: exactly one planner dispatch (valid briefs, no repair needed)',
      plannerReqs.length === 1)
    t('S1: planner request carries executionPolicy artifact-only, passed explicitly',
      plannerReqs.every((r) => r.executionPolicy === 'artifact-only'))
    t('S1: planner cwd existed at dispatch time and is under the run artifacts dir (<artifactsDir>/planner-scratch)',
      plannerReqs.every((r) => r.cwdExisted === true)
      && plannerReqs.every((r) => norm(r.cwd).startsWith(`${normArtifacts}/planner-scratch`)))
    t('S1: planner cwd is neither the target repo nor inside it',
      plannerReqs.every((r) => norm(r.cwd) !== normRepo && !norm(r.cwd).startsWith(`${normRepo}/`)))
    t('S1: the planner prompt names no repo path (artifact-only removes an unused capability)',
      plannerReqs.every((r) => !r.prompt.includes(repo) && !r.prompt.includes(normRepo)))
    t('S1: the planner scratch dir is removed best-effort after the phase',
      !existsSync(scratch))

    t('S1: exactly two worker dispatches (one per candidate), executionPolicy worktree-write',
      workerReqs.length === 2 && workerReqs.every((r) => r.executionPolicy === 'worktree-write'))
    t('S1: each worker cwd is its candidate worktree (the report workspacePath)',
      workerReqs.length === report.candidates.length
      && eqSet(workerReqs.map((r) => norm(r.cwd)), report.candidates.map((c) => norm(c.workspacePath ?? ''))))
    t('S1: worker worktree cwds exist on disk', workerReqs.every((r) => existsSync(r.cwd)))

    t('S1: exactly two reviewer dispatches (both candidates passed all gates), executionPolicy worktree-read',
      reviewerReqs.length === 2 && reviewerReqs.every((r) => r.executionPolicy === 'worktree-read'))
    t('S1: each reviewer cwd is its candidate workspace path (the disposable worktree)',
      eqSet(reviewerReqs.map((r) => norm(r.cwd)), report.candidates.map((c) => norm(c.workspacePath ?? ''))))

    t('S1: candidates pass exactly as before (worker ok, gates pass, diff non-empty, reviewed)',
      report.candidates.length === 2
      && report.candidates.every((c) => c.workerOk === true && c.passedAllGates === true
        && c.diffBytes > 0 && c.review?.ok === true))
    t('S1: planner report unchanged in shape and meaning (ok, no fallback, one brief per candidate)',
      report.planner?.ok === true && report.planner?.fallbackUsed === false
      && report.planner?.briefs?.length === 2)

    // Report shape unchanged (no new report.json fields anywhere).
    const onDisk = JSON.parse(read(join(artifactsDir, 'report.json')))
    t('S1: report.json top-level keys unchanged',
      eq(sortedKeys(onDisk), ['baseSha', 'candidates', 'finishedAt', 'goal', 'model', 'planner', 'repo', 'runId', 'startedAt']))
    t('S1: planner report keys unchanged',
      eq(sortedKeys(onDisk.planner), ['attempts', 'briefs', 'durationMs', 'fallbackUsed', 'model', 'ok', 'rawOutputPath']))
    t('S1: candidate report keys unchanged (review present; no new fields)',
      onDisk.candidates.length === 2
      && onDisk.candidates.every((c) => eq(sortedKeys(c),
        ['attempts', 'brief', 'diffBytes', 'diffPath', 'gates', 'id', 'model', 'passedAllGates', 'review', 'workerDurationMs', 'workerId', 'workerOk', 'workerTimedOut', 'workspacePath'])))
    t('S1: review report keys unchanged',
      onDisk.candidates.every((c) => eq(sortedKeys(c.review), ['attempts', 'model', 'observations', 'ok', 'rawOutputPath'])))
    t('S1: attempt and gate-result keys unchanged',
      onDisk.candidates.every((c) => eq(sortedKeys(c.attempts[0]),
        ['endedAt', 'id', 'inputContextHash', 'jobId', 'number', 'outputArtifacts', 'promptVersion', 'startedAt', 'state'])
        && c.gates.every((g) => eq(sortedKeys(g), ['durationMs', 'exitCode', 'name', 'outputTail', 'passed']))))
  }

  // S1b — the bounded planner repair attempt shares the restricted request.
  {
    const worker = capturingWorker({ plannerFirstResponse: 'not a json array at all' })
    const { repo, artifactsDir } = await drive('planner-repair', { worker, reviewerModel: null })
    const plannerReqs = worker.reqs.filter((r) => r.prompt.includes('You are the planning tier'))
    const normRepo = norm(repo)
    const normArtifacts = norm(artifactsDir)
    t('S1b: the repair scenario runs initial + bounded repair planner dispatches',
      plannerReqs.length === 2)
    t('S1b: BOTH planner dispatches carry artifact-only (they share baseReq)',
      plannerReqs.every((r) => r.executionPolicy === 'artifact-only'))
    t('S1b: both planner dispatches share the same scratch cwd under the artifacts dir',
      plannerReqs[0]?.cwd === plannerReqs[1]?.cwd
      && norm(plannerReqs[0]?.cwd ?? '').startsWith(`${normArtifacts}/planner-scratch`))
    t('S1b: the repair prompt adds no repo path either',
      plannerReqs[1] && !plannerReqs[1].prompt.includes(repo) && !plannerReqs[1].prompt.includes(normRepo))
    t('S1b: the scratch dir is gone after the phase, and the planner still parsed (no fallback)',
      !existsSync(join(artifactsDir, 'planner-scratch')))
    // (drive() returns the report only in the first scenario's destructure —
    // re-read it from disk for the fallback pin.)
    const report = JSON.parse(read(join(artifactsDir, 'report.json')))
    t('S1b: planner repair succeeded — briefs parsed, fallbackUsed false, attempts 2',
      report.planner?.ok === true && report.planner?.fallbackUsed === false && report.planner?.attempts === 2)
    t('S1b: the worker dispatches in this scenario still carry worktree-write',
      worker.reqs.filter((r) => r.prompt.includes('You are implementing'))
        .every((r) => r.executionPolicy === 'worktree-write'))
    t('S1b: reviewerModel null means no reviewer dispatch happened',
      !worker.reqs.some((r) => r.prompt.includes('You are the review tier')))
  }

  // ---------- S2 — stub-bin argv pin ----------
  {
    const stubRecord = join(sandbox, 'stub-record.cjs')
    // Written as CJS and loaded via NODE_OPTIONS --require: it runs inside
    // the spawned stub process BEFORE node fails to resolve the adapter's
    // argv[1] ('run'), recording the real argv and the pinned env vars.
    writeFileSync(stubRecord, [
      "'use strict'",
      'const fs = require("node:fs")',
      'const out = process.env.CAP_STUB_OUT',
      'if (out) {',
      '  fs.writeFileSync(out, JSON.stringify({',
      '    argv: process.argv,',
      '    pwd: process.env.PWD === undefined ? null : process.env.PWD,',
      '    oldpwd: process.env.OLDPWD === undefined ? null : process.env.OLDPWD,',
      '  }), "utf8")',
      '}',
      '',
    ].join('\n'))

    const cases = [
      { name: 'artifact-only', policy: 'artifact-only', restricted: true },
      { name: 'worktree-read', policy: 'worktree-read', restricted: true },
      { name: 'worktree-write', policy: 'worktree-write', restricted: false },
      { name: 'absent', policy: undefined, restricted: false },
    ]
    const prevNodeOptions = process.env.NODE_OPTIONS
    const prevStubOut = process.env.CAP_STUB_OUT
    try {
      for (const c of cases) {
        const dir = join(sandbox, `s2-${c.name}`)
        mkdirSync(dir, { recursive: true })
        const logPath = join(sandbox, `s2-${c.name}.log`)
        const recordPath = join(sandbox, `s2-${c.name}.json`)
        const cwd = join(sandbox, 's2-cwd', c.name)
        mkdirSync(cwd, { recursive: true })
        process.env.NODE_OPTIONS = `--require ${stubRecord.replaceAll('\\', '/')}`
        process.env.CAP_STUB_OUT = recordPath
        try {
          await new OpenCodeWorker(process.execPath).execute({
            prompt: 'the composed prompt',
            model: 'fake/stub-model',
            cwd,
            logPath,
            timeoutMs: 10_000,
            ...(c.policy !== undefined ? { executionPolicy: c.policy } : {}),
          })
        } finally {
          if (prevNodeOptions === undefined) delete process.env.NODE_OPTIONS
          else process.env.NODE_OPTIONS = prevNodeOptions
          if (prevStubOut === undefined) delete process.env.CAP_STUB_OUT
          else process.env.CAP_STUB_OUT = prevStubOut
        }
        const recorded = JSON.parse(read(recordPath))
        const argv = recorded.argv
        const agentIdx = argv.indexOf('--agent')
        // node resolves its entry-module argument to an absolute path before
        // a --require preload runs, so the adapter's bare 'run' arrives as
        // <cwd>/run — pin its basename, everything after it verbatim.
        // T-042: the prompt NEVER appears in argv (the stdin transport) —
        // the pre-T-042 'prompt last' pin is replaced by the stronger
        // 'prompt absent' pin; the model is the terminal argv element.
        t(`S2 [${c.name}]: the stub saw the adapter's argv — 'run' first, '-m <model>' last, prompt never in argv (T-042 stdin transport)`,
          basename(argv[1] ?? '').toLowerCase() === 'run' && argv.includes('-m') && argv.includes('fake/stub-model')
          && argv[argv.length - 1] === 'fake/stub-model'
          && !JSON.stringify(argv).includes('the composed prompt'))
        if (c.restricted) {
          t(`S2 [${c.name}]: argv contains --agent plan`,
            agentIdx !== -1 && argv[agentIdx + 1] === 'plan')
        } else {
          t(`S2 [${c.name}]: --agent never appears`,
            agentIdx === -1 && !JSON.stringify(argv).includes('plan'))
        }
        t(`S2 [${c.name}]: env.PWD and env.OLDPWD are pinned to req.cwd`,
          recorded.pwd === cwd && recorded.oldpwd === cwd)
        const logLine = read(logPath)
        if (c.restricted) {
          t(`S2 [${c.name}]: the spawn log line reflects the actual argv (run --agent plan -m …)`,
            logLine.includes('$ opencode run --agent plan -m fake/stub-model <prompt: 19 chars>'))
        } else {
          t(`S2 [${c.name}]: the spawn log line reflects the actual argv (run -m …, no --agent)`,
            logLine.includes('$ opencode run -m fake/stub-model <prompt: 19 chars>')
            && !logLine.includes('--agent'))
        }
      }
    } finally {
      rmSync(stubRecord, { force: true })
    }
  }

  rmSync(sandbox, { recursive: true, force: true })
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function eqSet(a, b) {
  return eq([...a].sort(), [...b].sort())
}

main()
  .catch((e) => {
    failures.push(`gate crashed: ${e instanceof Error ? e.message : String(e)}`)
    console.error(e)
  })
  .finally(() => {
    if (failures.length > 0) {
      console.error(`\ncheck-capabilities: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-capabilities: ALL GREEN')
  })
