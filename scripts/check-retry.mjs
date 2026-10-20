// Attempt-records + bounded-retry self-check (Gate 1.8, fast tier, T-007) —
// run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-retry.mjs
// Drives `runSkeleton` directly with a FAKE WorkerAdapter (the seam at
// src/types.ts) against throwaway fixture repos — zero model tokens, zero
// pipeline-through-CLI. Pins: fail-once-then-succeed retries into a fresh
// baseSha-clean worktree with attempt-scoped evidence; the bound eliminates;
// default mode is exactly one attempt with today's paths/lease/branch;
// verdicts (no-op, gates-failed) are never re-rolled; thrown errors retry;
// and the CLI refuses --max-attempts < 1 at parse time (exit 1 before the
// checkout lock or any artifacts dir exists). All git calls are list-form
// (AGENTS.md #4). T-029 extends S1: promptVersion is positively pinned as the
// 64-hex sha256 of the exact prompt text the fake adapter received
// (independently recomputed from the adapter's recording — never
// builderPrompt), distinct per retry attempt while inputContextHash stays
// identical.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
const norm = (p) => p.replaceAll('\\', '/').toLowerCase()
const read = (p) => readFileSync(p, 'utf8')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const cliTs = join(root, 'src', 'cli.ts')
const sandbox = 'C:/swarm/verify-retry'
const IDENTITY = ['-c', 'user.name=check-retry', '-c', 'user.email=retry@local']

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })

// A fake WorkerAdapter (src/types.ts seam): executes a scripted list of
// steps, one per call, replaying the last step once the script runs out.
// Steps: { ok, exitCode?, write?: {file, content} } or { error: Error }.
// Every call appends to the adapter's logPath first — like the real adapter,
// which logs before anything can go wrong — so a thrown attempt still leaves
// its worker.log behind. T-029: every call also records the EXACT req.prompt
// it received (the real adapters log it elided/verbatim as provenance), so
// the check can recompute promptVersion independently of the engine.
function fakeWorker(steps) {
  const calls = []
  const prompts = []
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
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]
      if (step.error) throw step.error
      if (step.write) writeFileSync(join(req.cwd, step.write.file), step.write.content)
      return {
        ok: step.ok,
        exitCode: step.exitCode ?? (step.ok ? 0 : 1),
        timedOut: false,
        durationMs: 5,
        logPath: req.logPath,
        responseTail: `fake response ${calls.length}`,
      }
    },
  }
}

// A fake Gate (src/types.ts seam): deterministic verdict, no subprocess.
const passGate = {
  name: 'always-pass',
  run: async () => ({ name: 'always-pass', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok' }),
}
const failGate = {
  name: 'always-fail',
  run: async () => ({ name: 'always-fail', passed: false, exitCode: 1, durationMs: 1, outputTail: 'deliberate failure' }),
}

// One throwaway fixture repo per scenario: fresh branch namespace, so
// scenarios cannot collide on swarm/* branch names. List-form git only.
async function drive(name, { worker, gates, maxAttempts }) {
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
    candidateIds: ['c01'],
    concurrency: 1,
    timeoutMs: 10_000,
    maxAttempts,
    gates,
    worker,
    workspaces: new WorktreeProvider(repo, artifactsDir),
    artifactsDir,
    cleanWorkspaces: false,
  })
  return { report, repo, artifactsDir, baseSha, git }
}

const main = async () => {
  // ---------- S1: fail-once-then-succeed x maxAttempts 2 ----------
  {
    const worker = fakeWorker([
      { ok: false, exitCode: 3, write: { file: 'attempt1.txt', content: 'from attempt one\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'from attempt two\n' } },
    ])
    const { report, artifactsDir, baseSha, git } = await drive('retry-succeed', { worker, gates: [passGate], maxAttempts: 2 })
    const c = report.candidates[0]
    const runDir = artifactsDir
    const a1 = c.attempts[0]
    const a2 = c.attempts[1]
    t('S1: exactly two attempts recorded', c.attempts.length === 2)
    t('S1: attempt ids/numbers/jobId follow <candidateId>-a<n>',
      a1?.id === 'c01-a1' && a2?.id === 'c01-a2' && a1?.jobId === 'c01' && a2?.jobId === 'c01'
      && a1?.number === 1 && a2?.number === 2)
    t('S1: attempt 1 failed with a FailureRecord (worker-failed, exit 3, not timed out)',
      a1?.state === 'failed' && a1?.failure?.reason === 'worker-failed' && a1?.failure?.exitCode === 3
      && a1?.failure?.timedOut === false && typeof a1?.failure?.message === 'string' && a1.failure.message.length > 0)
    t('S1: attempt 2 succeeded with no failure record', a2?.state === 'succeeded' && a2?.failure === undefined)
    t('S1: attempt 2 ran in a fresh worktree — its diff contains only its own change, nothing adopted from attempt 1',
      read(join(runDir, 'c01', 'attempt-2', 'diff.patch')).includes('marker.txt')
      && !read(join(runDir, 'c01', 'attempt-2', 'diff.patch')).includes('attempt1.txt'))
    const wt1 = join(runDir, 'wt', 'c01')
    const wt2 = join(runDir, 'wt', 'c01-a2')
    t('S1: attempt lease dirs follow wt/<id> and wt/<id>-a<n>', existsSync(wt1) && existsSync(wt2))
    t('S1: both attempt worktrees are pinned at the run baseSha',
      run('git', ['-C', wt1, 'rev-parse', 'HEAD']).trim() === baseSha
      && run('git', ['-C', wt2, 'rev-parse', 'HEAD']).trim() === baseSha)
    const branches = git('branch', '--list', 'swarm/*').split('\n').map((l) => l.replace(/^[*+]\s*/, '').trim()).filter(Boolean)
    t('S1: one branch per attempt, no collisions (swarm/wt-c01 + swarm/wt-c01-a2)',
      eq(branches.sort(), ['swarm/wt-c01', 'swarm/wt-c01-a2']))
    t('S1: each lease branch is leased by exactly one worktree',
      git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('branch ') && l.includes('swarm/')).length === 2)
    t("S1: attempt 1's worker.log survives attempt 2 at today's path (not overwritten)",
      read(join(runDir, 'c01', 'worker.log')).includes('fake worker call 1')
      && !read(join(runDir, 'c01', 'worker.log')).includes('fake worker call 2'))
    t("S1: attempt 1's diff.patch survives at <id>/diff.patch and captured attempt 1's work",
      read(join(runDir, 'c01', 'diff.patch')).includes('attempt1.txt'))
    t("S1: attempt 2's evidence lives under <id>/attempt-2/",
      read(join(runDir, 'c01', 'attempt-2', 'worker.log')).includes('fake worker call 2')
      && existsSync(join(runDir, 'c01', 'attempt-2', 'diff.patch')))
    t("S1: each attempt's outputArtifacts names its own paths and the files exist",
      eq(a1?.outputArtifacts, [join(runDir, 'c01', 'worker.log'), join(runDir, 'c01', 'diff.patch')])
      && eq(a2?.outputArtifacts, [join(runDir, 'c01', 'attempt-2', 'worker.log'), join(runDir, 'c01', 'attempt-2', 'diff.patch')])
      && a1.outputArtifacts.every((p) => existsSync(p)) && a2.outputArtifacts.every((p) => existsSync(p)))
    t('S1: same brief+model hashes identically across attempts (64-hex inputContextHash)',
      a1?.inputContextHash === a2?.inputContextHash && /^[0-9a-f]{64}$/.test(a1?.inputContextHash ?? ''))
    // T-029 flip: the old "promptVersion is null on every attempt" pin is
    // replaced by positive producer pins. The expected values are recomputed
    // HERE from the exact text the fake adapter received (worker.prompts) —
    // builderPrompt is never called to build them — so the hash is proven
    // against what was actually SENT, not what the engine composed.
    const sha256Hex = (s) => createHash('sha256').update(s).digest('hex')
    t('S1: promptVersion is the 64-hex sha256 of the exact prompt text the adapter received, per attempt (recomputed from the recording, never builderPrompt)',
      /^[0-9a-f]{64}$/.test(a1?.promptVersion ?? '') && /^[0-9a-f]{64}$/.test(a2?.promptVersion ?? '')
      && a1?.promptVersion === sha256Hex(worker.prompts[0])
      && a2?.promptVersion === sha256Hex(worker.prompts[1]))
    t('S1: retry attempts carry DISTINCT promptVersion values (the exact text embeds each lease path) while inputContextHash stays identical',
      a1?.promptVersion !== a2?.promptVersion && a1?.inputContextHash === a2?.inputContextHash)
    t('S1: attempt stamps are ISO strings, endedAt not before startedAt',
      !Number.isNaN(Date.parse(a1?.startedAt)) && !Number.isNaN(Date.parse(a1?.endedAt))
      && !Number.isNaN(Date.parse(a2?.startedAt)) && !Number.isNaN(Date.parse(a2?.endedAt))
      && Date.parse(a2.endedAt) >= Date.parse(a2.startedAt))
    t("S1: final candidate verdict identical in shape to today's (worker ok, gates pass, diff non-empty, no error)",
      c.workerOk === true && c.passedAllGates === true && c.diffBytes > 0
      && c.gates.length === 1 && c.gates[0]?.passed === true && c.error === undefined)
    t("S1: candidate workspacePath is the final attempt's worktree",
      norm(c.workspacePath ?? '') === norm(wt2))
    t('S1: worker executed exactly twice', worker.calls.length === 2)
    t('S1: on-disk report.json carries the attempts arrays (the store ingests the artifact)',
      eq(JSON.parse(read(join(runDir, 'report.json'))).candidates[0]?.attempts?.length, 2))
  }

  // ---------- S2: always-failing x maxAttempts 2 — the bound eliminates ----------
  {
    const worker = fakeWorker([{ ok: false, exitCode: 7 }])
    const { report } = await drive('bound-hit', { worker, gates: [passGate], maxAttempts: 2 })
    const c = report.candidates[0]
    t('S2: the bound is respected — exactly maxAttempts attempts', c.attempts.length === 2 && worker.calls.length === 2)
    t('S2: every attempt failed with reason worker-failed (exit 7)',
      c.attempts.every((a) => a.state === 'failed' && a.failure?.reason === 'worker-failed' && a.failure?.exitCode === 7))
    t("S2: final candidate eliminated exactly as today's ladder produces (worker failed, no gates pass)",
      c.workerOk === false && c.passedAllGates === false && c.error === undefined)
  }

  // ---------- S3: default (maxAttempts 1, the CLI default) — today's behavior ----------
  {
    const worker = fakeWorker([{ ok: true, write: { file: 'marker.txt', content: 'done\n' } }])
    const { report, artifactsDir, git } = await drive('default-succeed', { worker, gates: [passGate], maxAttempts: 1 })
    const c = report.candidates[0]
    t('S3: default records exactly one attempt', c.attempts.length === 1 && worker.calls.length === 1)
    t('S3: the attempt succeeded and the candidate passes as today',
      c.attempts[0]?.state === 'succeeded' && c.attempts[0]?.failure === undefined
      && c.workerOk === true && c.passedAllGates === true)
    t("S3: today's evidence paths (<id>/worker.log, <id>/diff.patch), no attempt-scoped dir",
      existsSync(join(artifactsDir, 'c01', 'worker.log')) && existsSync(join(artifactsDir, 'c01', 'diff.patch'))
      && !existsSync(join(artifactsDir, 'c01', 'attempt-2'))
      && eq(c.attempts[0]?.outputArtifacts, [join(artifactsDir, 'c01', 'worker.log'), join(artifactsDir, 'c01', 'diff.patch')]))
    const branches = git('branch', '--list', 'swarm/*').split('\n').map((l) => l.replace(/^[*+]\s*/, '').trim()).filter(Boolean)
    t("S3: today's lease id and branch (wt/c01, swarm/wt-c01) and nothing else",
      eq(branches, ['swarm/wt-c01']) && existsSync(join(artifactsDir, 'wt', 'c01')))
  }
  {
    const worker = fakeWorker([{ ok: false, exitCode: 1 }, { ok: true, write: { file: 'marker.txt', content: 'never\n' } }])
    const { report, artifactsDir } = await drive('default-fail', { worker, gates: [passGate], maxAttempts: 1 })
    const c = report.candidates[0]
    t('S4: default gives no retry — exactly one attempt even though attempt 2 would succeed',
      c.attempts.length === 1 && worker.calls.length === 1 && !existsSync(join(artifactsDir, 'c01', 'attempt-2')))
    t("S4: the candidate is eliminated exactly as today's ladder produces",
      c.attempts[0]?.state === 'failed' && c.attempts[0]?.failure?.reason === 'worker-failed'
      && c.workerOk === false && c.passedAllGates === false && c.error === undefined)
  }

  // ---------- S5: no-op-then-pass is NOT retried (zero-byte verdict) ----------
  {
    const worker = fakeWorker([{ ok: true }, { ok: true, write: { file: 'marker.txt', content: 'would-pass\n' } }])
    const { report } = await drive('no-op-verdict', { worker, gates: [passGate], maxAttempts: 2 })
    const c = report.candidates[0]
    t('S5: a succeeded worker with a zero-byte diff is never re-rolled — exactly one attempt',
      c.attempts.length === 1 && worker.calls.length === 1)
    t("S5: eliminated exactly as today's ladder produces (no-op)",
      c.attempts[0]?.state === 'succeeded' && c.attempts[0]?.failure === undefined
      && c.workerOk === true && c.diffBytes === 0 && c.passedAllGates === false)
  }

  // ---------- S6: gates-fail-then-pass is NOT retried (machine verdict) ----------
  {
    const worker = fakeWorker([
      { ok: true, write: { file: 'marker.txt', content: 'fails-gates\n' } },
      { ok: true, write: { file: 'marker.txt', content: 'would-pass-gates\n' } },
    ])
    const { report } = await drive('gates-fail-verdict', { worker, gates: [failGate], maxAttempts: 2 })
    const c = report.candidates[0]
    t('S6: a succeeded worker whose gates fail is never re-rolled — exactly one attempt',
      c.attempts.length === 1 && worker.calls.length === 1)
    t("S6: eliminated exactly as today's ladder produces (gates-failed), gate result recorded once",
      c.workerOk === true && c.passedAllGates === false
      && c.gates.length === 1 && c.gates[0]?.passed === false
      && c.attempts[0]?.state === 'succeeded')
  }

  // ---------- S7: thrown errors are retryable mechanical failures ----------
  {
    const worker = fakeWorker([
      { error: new Error('transient harness crash') },
      { ok: true, write: { file: 'marker.txt', content: 'recovered\n' } },
    ])
    const { report, artifactsDir } = await drive('throw-retry', { worker, gates: [passGate], maxAttempts: 2 })
    const c = report.candidates[0]
    const a1 = c.attempts[0]
    t('S7: a thrown attempt is retried — exactly two attempts, attempt 2 succeeded',
      c.attempts.length === 2 && a1?.state === 'failed' && c.attempts[1]?.state === 'succeeded')
    t('S7: attempt 1 failure record carries reason error, the message, exitCode null, timedOut false',
      a1?.failure?.reason === 'error' && a1?.failure?.message === 'transient harness crash'
      && a1?.failure?.exitCode === null && a1?.failure?.timedOut === false)
    t("S7: attempt 1's worker.log exists (the adapter logged before throwing) and is named by outputArtifacts",
      eq(a1?.outputArtifacts, [join(artifactsDir, 'c01', 'worker.log')])
      && existsSync(join(artifactsDir, 'c01', 'worker.log'))
      && read(join(artifactsDir, 'c01', 'worker.log')).includes('fake worker call 1'))
    t('S7: the retried candidate passes', c.workerOk === true && c.passedAllGates === true && c.error === undefined)
  }

  // ---------- S8: CLI — usage line and parse-time refusals ----------
  {
    const repo = join(sandbox, 'retry-succeed', 'repo')
    const runCli = (args) => {
      try {
        return { code: 0, out: run(process.execPath, [tsxCli, cliTs, ...args]) }
      } catch (e) {
        return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? e.message}` }
      }
    }
    const help = runCli(['--help'])
    t('S8: --help exits 0 and documents --max-attempts <n> with default 1',
      help.code === 0 && help.out.includes('--max-attempts <n>') && /default: 1; values < 1\s+refused/.test(help.out))
    const cliRunRoot = join(sandbox, 'cli-run-root')
    mkdirSync(cliRunRoot, { recursive: true })
    const refused = runCli(['--repo', repo, '--goal', 'parse refusal check', '--max-attempts', '0', '--run-root', cliRunRoot])
    t('S8: --max-attempts 0 refuses with exit 1, naming the flag', refused.code === 1 && refused.out.includes('--max-attempts'))
    t('S8: the refusal happened before any artifacts dir or lock exists (run root untouched, no locks/)',
      readdirSync(cliRunRoot).length === 0 && !existsSync(join(cliRunRoot, 'locks')))
    const refusedNonInt = runCli(['--repo', repo, '--goal', 'parse refusal check', '--max-attempts', 'nope', '--run-root', cliRunRoot])
    t('S8: a non-integer --max-attempts refuses too', refusedNonInt.code === 1 && refusedNonInt.out.includes('--max-attempts'))
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
      console.error(`\ncheck-retry: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-retry: ALL GREEN')
  })
