// Startup-reconciliation self-check (Gate 1.11, fast tier, T-010) — run
// under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-recovery.mjs
// Pins the standalone `recover` command (src/recover.ts) and the in-run
// evidence it consumes (<runDir>/dispatch.jsonl, written by src/runner.ts;
// pids recorded through the WorkerExecutionRequest.onSpawn seam). The
// kill-mid-run scenarios drive a real subprocess "orchestrator" (tsx +
// runSkeleton with a FAKE WorkerAdapter whose real child is a spawned node
// sleeper — the Gate 1.8/1.10 fixture-code-behind-the-seam pattern), hold
// the T-004 checkout lock the way src/cli.ts does, and are killed by pid
// only (taskkill /F, no /T), leaving a real orphaned worker, a stale lock,
// and zero DB rows — exactly the spec §15.2 shape. All process assertions
// run against the real process table (never a mock), zero model tokens.
// Pins: dispatch.jsonl structure for every run, the lock refusal (nothing
// written, orphan alive), the --force-lock path (orphan verified live +
// identity, then actually dead; lock released on every path), durable
// abandonment marks (exactly one attempts row + one ATTEMPT_ABANDONED event
// per un-completed attempt, completed attempts never fabricated,
// integrity_check ok), verify-before-kill (dead / never-recorded /
// identity-mismatch pids are cleanup failures, never blind-killed; the lock
// file's dead pid never consulted), report-only workspace inspection
// (worktrees, branches, and evidence intact), retry dispositions (no-op /
// bound-exhausted terminal, no durable verdict retryable), recovery never
// reruns (dispatch.jsonl byte-identical, no new worktrees, recovery.json the
// only new artifact), and every refusal exiting non-zero writing nothing.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { runSkeleton } from '../src/runner.ts'
import { WorktreeProvider } from '../src/workspace/worktree.ts'
import { lockPathFor } from '../src/lock.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const read = (p) => readFileSync(p, 'utf8')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const recoverTs = join(root, 'src', 'recover.ts')
const sandbox = 'C:/swarm/verify-recovery'
const IDENTITY = ['-c', 'user.name=check-recovery', '-c', 'user.email=recovery@local']

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Every real orphan the scenarios create, for teardown (AGENTS.md #10): if a
// scenario fails before recover kills its orphan, the gate's finally still does.
const orphans = []
const killOrphans = () => {
  for (const pid of orphans.splice(0)) {
    if (!isAlive(pid)) continue
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      console.log(`teardown: killed leftover orphan pid ${pid}`)
    } catch {
      // already gone
    }
  }
}

// Real-process aliveness: ESRCH = gone, anything else (ok / EPERM) = alive.
const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code !== 'ESRCH'
  }
}

async function until(desc, fn, timeoutMs = 45_000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const v = fn()
      if (v) return v
    } catch {
      // keep polling — the file/process may not be there yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${desc}`)
    await sleep(100)
  }
}

const parseLines = (raw) => raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

// One throwaway git repo per scenario (list-form git only — AGENTS.md #4).
function makeRepo(name) {
  const repo = join(sandbox, name, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => run('git', ['-C', repo, ...args])
  git('init', '-b', 'main')
  writeFileSync(join(repo, 'base.txt'), 'baseline\n')
  git(...IDENTITY, 'add', '-A')
  git(...IDENTITY, 'commit', '-m', 'baseline')
  return { repo, baseSha: git('rev-parse', 'HEAD').trim(), git }
}

// The fake WorkerAdapter fixture for the in-process completed run (R1): each
// execute spawns a REAL child, records its pid through onSpawn BEFORE any
// hang, and returns WorkerResult.pid — the seam T-010 added.
function shortWorker() {
  const pids = []
  const byCwd = new Map()
  let onSpawnCalls = 0
  return {
    id: 'fake-recovery-short',
    pids,
    byCwd,
    get onSpawnCalls() {
      return onSpawnCalls
    },
    async execute(req) {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
      const pid = child.pid
      req.onSpawn?.(pid)
      onSpawnCalls++
      pids.push(pid)
      byCwd.set(req.cwd, { pid, result: null })
      await new Promise((resolve) => child.on('exit', resolve))
      writeFileSync(join(req.cwd, 'marker.txt'), 'fake change\n')
      const result = { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: 'done', pid }
      byCwd.get(req.cwd).result = result
      return result
    },
  }
}

const passGate = { name: 'always-pass', run: async () => ({ name: 'always-pass', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok' }) }

// The generated driver for the kill-mid-run scenarios (R2/R3): stands in for
// src/cli.ts's main() — takes the checkout lock, then runSkeleton with a
// fake adapter whose c02 child hangs forever (onSpawn recorded first). The
// gate kills the lock's holder pid (the real orchestrator process — tsx
// spawns a child for the target, and the lock records it) by pid only.
function writeDriver() {
  const mod = (p) => pathToFileURL(join(root, p)).href
  const src = `
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runSkeleton } from '${mod(join('src', 'runner.ts'))}'
import { WorktreeProvider } from '${mod(join('src', 'workspace', 'worktree.ts'))}'
import { acquireCheckoutLock } from '${mod(join('src', 'lock.ts'))}'

const [repo, runRoot, runId, maxAttempts, baseSha] = process.argv.slice(2)
const artifactsDir = join(runRoot, runId)
acquireCheckoutLock(runRoot, repo, { cmd: 'run', runId })
// The hang below is an never-resolving promise — it holds no event-loop
// handle, so without a live timer the orchestrator would exit on its own the
// moment c01 finishes (and the scenario would lose its live victim).
const keepalive = setInterval(() => {}, 600000)
const worker = {
  id: 'fake-recovery',
  async execute(req) {
    const hang = /[\\\\/]c02$/.test(req.cwd)
    // The hung worker is spawned DETACHED: node binds non-detached children
    // to the parent's lifetime on Windows (job object), so a worker that must
    // outlive its hard-killed orchestrator — the spec §15.2 orphan — has to
    // break away. stdio is ignored and the handle unref'd.
    const child = spawn(process.execPath, ['-e', hang ? 'setTimeout(() => {}, 600000)' : ''], { stdio: 'ignore', windowsHide: true, detached: hang })
    if (hang) child.unref()
    req.onSpawn?.(child.pid)
    try { appendFileSync(req.logPath, 'fake worker pid ' + child.pid + (hang ? ' (hang)\\n' : '\\n')) } catch {}
    if (hang) return new Promise(() => {})
    await new Promise((resolve) => child.on('exit', resolve))
    writeFileSync(join(req.cwd, 'marker.txt'), 'fake change\\n')
    return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: 'done', pid: child.pid }
  },
}
await runSkeleton({
  runId, repo, baseSha, goal: 'crash recovery probe', model: 'fake/model',
  plannerModel: null, reviewerModel: null, candidateIds: ['c01', 'c02'], concurrency: 2,
  timeoutMs: 600000, maxAttempts: Number(maxAttempts), gates: [], worker,
  workspaces: new WorktreeProvider(repo, artifactsDir), artifactsDir, cleanWorkspaces: false,
})
`
  const p = join(sandbox, 'driver.mjs')
  writeFileSync(p, src)
  return p
}

// Spawn the driver, wait until c01 completed and c02's pid is on disk (the
// pid line exists while the driver still lives — recorded before any hang),
// then kill the orchestrator by pid only: stale lock + orphaned worker.
async function crashMidRun(name, maxAttempts) {
  const { repo, baseSha, git } = makeRepo(name)
  const runRoot = join(sandbox, name, 'runs')
  const runId = '20991010130000'
  const runDir = join(runRoot, runId)
  const driver = writeDriver()
  const child = spawn(process.execPath, [tsxCli, driver, repo, runRoot, runId, String(maxAttempts), baseSha], { stdio: 'ignore', windowsHide: true })
  const lines = await until('dispatch.jsonl to record c01 completion + c02 pid', () => {
    const ls = parseLines(read(join(runDir, 'dispatch.jsonl')))
    const c01done = ls.some((l) => l.type === 'completion' && l.jobId === 'c01')
    const c02pid = ls.find((l) => l.type === 'pid' && l.jobId === 'c02')
    return c01done && c02pid ? ls : null
  })
  await sleep(300) // settle: let c01's evidence finish landing
  const holderPid = JSON.parse(read(lockPathFor(runRoot, repo))).pid
  const orphanPid = lines.find((l) => l.type === 'pid' && l.jobId === 'c02').pid
  if (!isAlive(holderPid)) throw new Error(`the orchestrator (lock holder pid ${holderPid}) died before the kill — the hang did not hold`)
  orphans.push(orphanPid)
  execFileSync('taskkill', ['/pid', String(holderPid), '/F'], { stdio: 'ignore', windowsHide: true })
  await until('driver to exit after the orchestrator pid was killed', () => (isAlive(holderPid) ? null : true))
  await until('lock file to remain (stale)', () => (existsSync(lockPathFor(runRoot, repo)) ? true : null))
  return {
    repo, git, runRoot, runId, runDir, lines, holderPid, orphanPid,
    dispatchBefore: read(join(runDir, 'dispatch.jsonl')),
    runDirBefore: readdirSync(runDir).sort(),
    wtBefore: readdirSync(join(runDir, 'wt')).sort(),
  }
}

const runRecover = (label, args) => {
  let code = 0
  let out = ''
  try {
    run(process.execPath, [tsxCli, recoverTs, ...args], { timeout: 120_000 })
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  if (code === 0 && label !== null) console.log(`$ recover ${args.join(' ')} -> 0`)
  else if (label !== null) console.error(`--- recover output (${label}, exit ${code}) ---\n${out}`)
  return { code, out }
}

const dbRows = (dbPath, sql, ...params) => {
  const db = new DatabaseSync(dbPath)
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

// A synthetic crashed run: hand-written dispatch.jsonl evidence + a real
// sandbox repo for the lock/discovery paths. `lines` is a function of runDir
// (the run dir is created here) or a prebuilt array.
function makeSyntheticRun(name, { maxAttempts, lines, withLockPid = null }) {
  const { repo, baseSha } = makeRepo(name)
  const runRoot = join(sandbox, name, 'runs')
  const runId = '20991010140000'
  const runDir = join(runRoot, runId)
  mkdirSync(join(runDir, 'wt'), { recursive: true })
  const header = { type: 'run', runId, repo, baseSha, goal: 'synthetic', model: 'fake/model', maxAttempts, startedAt: '2026-10-16T00:00:00.000Z' }
  const evLines = typeof lines === 'function' ? lines(runDir) : lines
  writeFileSync(join(runDir, 'dispatch.jsonl'), [header, ...evLines].map((l) => JSON.stringify(l)).join('\n') + '\n')
  if (withLockPid !== null) {
    mkdirSync(dirname(lockPathFor(runRoot, repo)), { recursive: true })
    writeFileSync(lockPathFor(runRoot, repo), JSON.stringify({ pid: withLockPid, startedAt: '2026-10-16T00:00:00.000Z', cmd: 'crashed-run', runId }, null, 2))
  }
  return { repo, runRoot, runId, runDir }
}

async function main() {
  // ---------- R1: every run writes dispatch.jsonl; default behavior unchanged ----------
  const R1_RUN_ROOT = join(sandbox, 'completed-run', 'runs')
  const R1_RUN_ID = '20991010120000'
  {
    const { repo, baseSha } = makeRepo('completed-run')
    const artifactsDir = join(R1_RUN_ROOT, R1_RUN_ID)
    const worker = shortWorker()
    const lines = []
    const origLog = console.log
    console.log = (...args) => lines.push(args.join(' '))
    let report
    try {
      report = await runSkeleton({
        runId: R1_RUN_ID,
        repo,
        baseSha,
        goal: 'write the marker file',
        model: 'fake/model',
        plannerModel: null,
        reviewerModel: null,
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
    } finally {
      console.log = origLog
    }
    const ev = parseLines(read(join(artifactsDir, 'dispatch.jsonl')))
    const header = ev[0]
    t('R1: dispatch.jsonl opens with the run header carrying repo, baseSha, goal, model, maxAttempts, startedAt',
      header?.type === 'run' && header.runId === '20991010120000' && header.repo === repo && header.baseSha === baseSha
      && header.goal === 'write the marker file' && header.model === 'fake/model' && header.maxAttempts === 1
      && typeof header.startedAt === 'string')
    const shapesOk = ['c01', 'c02'].every((id) => {
      const d = ev.find((l) => l.type === 'dispatch' && l.jobId === id)
      const p = ev.find((l) => l.type === 'pid' && l.jobId === id)
      const c = ev.find((l) => l.type === 'completion' && l.jobId === id)
      const attempt = report.candidates.find((x) => x.id === id)
      return d?.leaseId === `wt/${id}` && d?.branch === `swarm/wt-${id}` && typeof d?.worktreePath === 'string'
        && typeof d?.startedAt === 'string'
        && typeof p?.pid === 'number' && worker.pids.includes(p.pid) && typeof p?.at === 'string'
        && c?.ok === true && c?.timedOut === false && c?.exitCode === 0
        && c?.diffBytes === attempt?.diffBytes && attempt.diffBytes > 0
        && typeof c?.endedAt === 'string'
        && ev.indexOf(p) > ev.indexOf(d) && ev.indexOf(c) > ev.indexOf(p)
    })
    t('R1: one dispatch + pid + completion line per attempt, pid recorded before completion, completion carries the captured diffBytes', shapesOk)
    t('R1: the fake adapter recorded its real children through onSpawn, once per attempt, before execute resolved',
      worker.onSpawnCalls === 2 && worker.pids.every((pid) => typeof pid === 'number')
      && ev.filter((l) => l.type === 'pid').every((l) => worker.pids.includes(l.pid)))
    t('R1: WorkerResult.pid is the seam the completion evidence rides on — each pid line names that attempt\u2019s own worker-result pid',
      ['c01', 'c02'].every((id) => {
        const d = ev.find((l) => l.type === 'dispatch' && l.jobId === id)
        const p = ev.find((l) => l.type === 'pid' && l.jobId === id)
        return p.pid === worker.byCwd.get(d.worktreePath)?.result?.pid
      }))
    t('R1: default run behavior unchanged — report.json on disk with the T-007 shape and both candidates non-no-op passes',
      existsSync(join(artifactsDir, 'report.json'))
      && JSON.parse(read(join(artifactsDir, 'report.json'))).candidates.length === 2
      && report.candidates.every((c) => c.workerOk && c.diffBytes > 0 && c.passedAllGates && c.attempts.length === 1))
    t("R1: the runner's stdout lines are today's (attempt start + diff capture + gate verdict)",
      lines.some((l) => l.includes('[c01] attempt 1: worker start'))
      && lines.some((l) => l.includes('[c01] attempt 1: diff captured:'))
      && lines.some((l) => l.includes('[c01] gate always-pass: PASS')))
  }

  // ---------- R1b: a FAILED diff capture is encoded as null, never as 0 ----------
  {
    const { repo, baseSha } = makeRepo('capture-failure')
    const artifactsDir = join(sandbox, 'capture-failure', 'run')
    const inner = new WorktreeProvider(repo, artifactsDir)
    const workspaces = {
      lease: (id, ref) => inner.lease(id, ref),
      diff: () => {
        throw new Error('diff capture failed (fixture)')
      },
      dispose: (lease) => inner.dispose(lease),
    }
    const worker = shortWorker()
    const report = await runSkeleton({
      runId: '20991010120001',
      repo,
      baseSha,
      goal: 'write the marker file',
      model: 'fake/model',
      plannerModel: null,
      reviewerModel: null,
      candidateIds: ['c01'],
      concurrency: 1,
      timeoutMs: 10_000,
      maxAttempts: 1,
      gates: [passGate],
      worker,
      workspaces,
      artifactsDir,
      cleanWorkspaces: false,
    })
    const ev = parseLines(read(join(artifactsDir, 'dispatch.jsonl')))
    const completion = ev.find((l) => l.type === 'completion' && l.jobId === 'c01')
    t('R1b: a failed diff capture is recorded as diffBytes null — never as the machine-answered 0',
      completion?.ok === true && completion?.diffBytes === null)
    t('R1b: the run itself is unchanged — no captured diff is never a pass (today\u2019s ladder)',
      report.candidates[0]?.diffBytes === 0 && report.candidates[0]?.passedAllGates === false)
  }

  // ---------- R2: the kill-mid-run scenario (maxAttempts 1) ----------
  const R2 = await crashMidRun('kill-run-att1', 1)
  {
    const { repo, git, runRoot, runId, runDir, lines, holderPid, orphanPid } = R2
    const db = join(sandbox, 'kill-run-att1', 'recovery.db')
    t('R2: the crash left the §15.2 shape — stale lock naming the dead holder, real orphan alive, no report.json',
      existsSync(lockPathFor(runRoot, repo)) && isAlive(orphanPid) && !existsSync(join(runDir, 'report.json'))
      && Number.isInteger(holderPid))
    const pidLine = lines.find((l) => l.type === 'pid' && l.jobId === 'c02')
    t('R2: dispatch.jsonl recorded the orphan pid through onSpawn while the orchestrator was alive (before any hang)',
      pidLine.pid === orphanPid && isAlive(orphanPid))

    // AC — refused without --force-lock: non-zero, names the holder, nothing written.
    const refused = runRecover('lock refusal', ['--run', runId, '--run-root', runRoot, '--db', db])
    t('R2: recover without --force-lock refuses with exit 1', refused.code === 1)
    t('R2: the refusal names the checkout lock, the holder pid, and the lock file',
      refused.out.includes('checkout lock held') && refused.out.includes(String(holderPid)) && refused.out.includes('.lock'))
    t('R2: the refusal wrote nothing — no recovery.json, no DB, the orphan still alive',
      !existsSync(join(runDir, 'recovery.json')) && !existsSync(db) && isAlive(orphanPid)
      && read(join(runDir, 'dispatch.jsonl')) === R2.dispatchBefore)

    // AC — with --force-lock: proceeds, orphan verified then dead, lock released.
    const rec = runRecover(null, ['--run', runId, '--run-root', runRoot, '--db', db, '--force-lock'])
    t('R2: recover --force-lock exits 0 (every step executed)', rec.code === 0)
    await until('orphan to disappear from the process table', () => (isAlive(orphanPid) ? null : true))
    t('R2: the orphaned worker whose pid was recorded in dispatch.jsonl is actually dead (real process check)',
      !isAlive(orphanPid))
    t('R2: the lock was released on every path — no residual .lock files',
      readdirSync(join(runRoot, 'locks')).filter((f) => f.endsWith('.lock')).length === 0)

    // AC — abandonment marks are durable; completed attempts not fabricated.
    const attempts = dbRows(db, 'SELECT * FROM attempts')
    t('R2: exactly one attempts row — the un-completed c02 attempt, state abandoned',
      attempts.length === 1 && attempts[0].run_id === runId && attempts[0].job_id === 'c02'
      && attempts[0].attempt_number === 1 && attempts[0].state === 'abandoned')
    const failure = JSON.parse(attempts[0].failure_json)
    const identity = JSON.parse(attempts[0].process_identity_json)
    t('R2: the abandoned row carries a failure record with reason abandoned and the dispatch-record process identity',
      failure.reason === 'abandoned' && failure.exitCode === null
      && identity.pid === orphanPid && identity.leaseId === 'wt/c02' && identity.branch === 'swarm/wt-c02'
      && attempts[0].started_at === (lines.find((l) => l.type === 'dispatch' && l.jobId === 'c02')?.startedAt ?? null))
    t('R2: the completed attempt of the killed run is NOT fabricated into the store',
      !attempts.some((a) => a.job_id === 'c01'))
    const events = dbRows(db, 'SELECT * FROM events')
    t('R2: exactly one ATTEMPT_ABANDONED event for the abandoned attempt, and no other events',
      events.length === 1 && events[0].type === 'ATTEMPT_ABANDONED'
      && JSON.parse(events[0].payload).jobId === 'c02')
    t('R2: runs/candidates stay empty — recovery fabricates no run rows',
      dbRows(db, 'SELECT * FROM runs').length === 0 && dbRows(db, 'SELECT * FROM candidates').length === 0)
    t('R2: PRAGMA integrity_check returns ok',
      dbRows(db, 'PRAGMA integrity_check')[0].integrity_check === 'ok')

    // AC — recovery.json: report-only inspection + dispositions + never reruns.
    const recovery = JSON.parse(read(join(runDir, 'recovery.json')))
    t('R2: recovery.json records the kill (verified pid) and no cleanup failures',
      recovery.runId === runId && typeof recovery.recoveredAt === 'string'
      && recovery.kills.length === 1 && recovery.kills[0].pid === orphanPid
      && recovery.kills[0].jobId === 'c02' && recovery.cleanupFailures.length === 0
      && recovery.abandonedAttempts.length === 1
      && recovery.abandonedAttempts[0].processIdentity.pid === orphanPid)
    const ws = Object.fromEntries(recovery.workspaces.map((w) => [w.branch, w]))
    t('R2: workspace inspection lists every wt/ worktree with branch and dirty state',
      recovery.workspaces.length === 2 && ws['swarm/wt-c01']?.exists === true && ws['swarm/wt-c01']?.dirty === true
      && ws['swarm/wt-c02']?.exists === true && ws['swarm/wt-c02']?.dirty === false)
    t('R2: maxAttempts 1 — both jobs terminal / bound-exhausted',
      JSON.stringify(recovery.jobs) === JSON.stringify([
        { jobId: 'c01', attemptsUsed: 1, maxAttempts: 1, disposition: 'terminal', reason: 'bound-exhausted' },
        { jobId: 'c02', attemptsUsed: 1, maxAttempts: 1, disposition: 'terminal', reason: 'bound-exhausted' },
      ]))
    t('R2: recovery removed nothing — worktrees, branches, and evidence intact',
      existsSync(join(runDir, 'wt', 'c01')) && existsSync(join(runDir, 'wt', 'c02'))
      && git('branch', '--list', 'swarm/wt-c01').trim() !== '' && git('branch', '--list', 'swarm/wt-c02').trim() !== ''
      && git('worktree', 'list', '--porcelain').includes('wt/c01') && git('worktree', 'list', '--porcelain').includes('wt/c02')
      && existsSync(join(runDir, 'c01', 'worker.log')) && existsSync(join(runDir, 'c01', 'diff.patch')))
    t('R2: recovery never reran — dispatch.jsonl gained no lines',
      read(join(runDir, 'dispatch.jsonl')) === R2.dispatchBefore)
    t('R2: recovery never reran — no new worktree under wt/ and no new swarm branch',
      JSON.stringify(readdirSync(join(runDir, 'wt')).sort()) === JSON.stringify(R2.wtBefore)
      && git('branch', '--list', 'swarm/*').split('\n').filter((l) => l.trim()).length === 2)
    t('R2: recovery never reran — recovery.json is the only new artifact in the run dir',
      JSON.stringify(readdirSync(runDir).sort()) === JSON.stringify([...R2.runDirBefore, 'recovery.json'].sort()))

    // AC — a second recover refuses, naming the reconciliation.
    const again = runRecover('already reconciled', ['--run', runId, '--run-root', runRoot, '--db', db])
    t('R2: a second recover refuses with exit 1 naming recovery.json (no duplicate abandonment events)',
      again.code === 1 && again.out.includes('already reconciled') && again.out.includes('recovery.json'))
    const eventsAfter = dbRows(db, 'SELECT * FROM events')
    t('R2: the refused second pass appended no events', eventsAfter.length === 1)
  }

  // ---------- R3: the same scenario with maxAttempts 2 — retryable dispositions ----------
  {
    const R3 = await crashMidRun('kill-run-att2', 2)
    const { runRoot, runId, runDir, orphanPid } = R3
    const db = join(sandbox, 'kill-run-att2', 'recovery.db')
    const rec = runRecover(null, ['--run', runId, '--run-root', runRoot, '--db', db, '--force-lock'])
    t('R3: recover --force-lock exits 0', rec.code === 0)
    const recovery = JSON.parse(read(join(runDir, 'recovery.json')))
    t('R3: maxAttempts 2 — the completed-with-diff job and the never-completed job are both retryable (no durable verdict to re-roll)',
      recovery.jobs.length === 2
      && recovery.jobs.every((j) => j.disposition === 'retryable' && j.reason === null && j.maxAttempts === 2 && j.attemptsUsed === 1))
    t('R3: the recorded orphan was killed, nothing else failed',
      recovery.kills.length === 1 && recovery.kills[0].pid === orphanPid && recovery.cleanupFailures.length === 0)
    await until('R3 orphan to disappear', () => (isAlive(orphanPid) ? null : true))
  }

  // ---------- R4: verify-before-kill never blindly kills ----------
  {
    // A dead pid (spawned, exited, absence verified) and a live process that
    // predates the backdated evidence (this gate itself) — plus the lock
    // file's dead pid, which recovery must never consult.
    const throwaway = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
    const deadPid = throwaway.pid
    await new Promise((resolve) => throwaway.on('exit', resolve))
    await until('dead pid to leave the process table', () => (!isAlive(deadPid) ? true : null))
    const lockPid = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
    await new Promise((resolve) => lockPid.on('exit', resolve))
    await until('lock pid to leave the process table', () => (!isAlive(lockPid.pid) ? true : null))

    const { runRoot, runId, runDir } = makeSyntheticRun('verify-before-kill', {
      maxAttempts: 2,
      withLockPid: lockPid.pid,
      lines: (runDir) => [
        { type: 'dispatch', jobId: 'j1', attempt: 1, leaseId: 'wt/j1', branch: 'swarm/wt-j1', worktreePath: join(runDir, 'wt', 'j1'), startedAt: new Date().toISOString() },
        { type: 'pid', jobId: 'j1', attempt: 1, pid: deadPid, at: new Date().toISOString() },
        { type: 'dispatch', jobId: 'j2', attempt: 1, leaseId: 'wt/j2', branch: 'swarm/wt-j2', worktreePath: join(runDir, 'wt', 'j2'), startedAt: new Date().toISOString() },
        // Backdated evidence + a live pid: this gate's own process, created
        // long after the evidence window — a reused pid by construction.
        { type: 'dispatch', jobId: 'j3', attempt: 1, leaseId: 'wt/j3', branch: 'swarm/wt-j3', worktreePath: join(runDir, 'wt', 'j3'), startedAt: '2026-01-01T00:00:00.000Z' },
        { type: 'pid', jobId: 'j3', attempt: 1, pid: process.pid, at: '2026-01-01T00:00:01.000Z' },
      ],
    })
    const db = join(sandbox, 'verify-before-kill', 'recovery.db')
    const rec = runRecover('verify-before-kill', ['--run', runId, '--run-root', runRoot, '--db', db, '--force-lock'])
    t('R4: recover exits non-zero when any cleanup failed', rec.code === 1)
    const recovery = JSON.parse(read(join(runDir, 'recovery.json')))
    const byJob = Object.fromEntries(recovery.cleanupFailures.map((f) => [f.jobId, f]))
    t('R4: a dead recorded pid is a cleanup failure with no kill attempt',
      byJob.j1?.reason === 'pid-not-alive' && byJob.j1?.pid === deadPid && recovery.kills.length === 0)
    t('R4: a dispatch with no recorded pid is a cleanup failure, never blind-killed',
      byJob.j2?.reason === 'no-pid-recorded' && byJob.j2?.pid === null)
    t('R4: a live pid outside the evidence window fails identity verification and stays alive (never blind-killed)',
      byJob.j3?.reason === 'identity-mismatch' && byJob.j3?.pid === process.pid && isAlive(process.pid))
    const mentionedPids = [
      ...recovery.kills.map((k) => k.pid),
      ...recovery.cleanupFailures.map((f) => f.pid),
      ...recovery.abandonedAttempts.map((a) => a.processIdentity.pid),
    ]
    t('R4: the lock file\u2019s dead orchestrator pid was never consulted',
      !mentionedPids.includes(lockPid.pid))
    t('R4: the failures are recorded in recovery.json and the marks still landed (3 abandoned rows + 3 events)',
      recovery.cleanupFailures.length === 3 && recovery.kills.length === 0
      && dbRows(db, 'SELECT * FROM attempts WHERE state = \'abandoned\'').length === 3
      && dbRows(db, 'SELECT * FROM events WHERE type = \'ATTEMPT_ABANDONED\'').length === 3)
    t('R4: --force-lock still released the lock on the failing path',
      readdirSync(join(runRoot, 'locks')).filter((f) => f.endsWith('.lock')).length === 0)
  }

  // ---------- R5: retry dispositions from dispatch records only ----------
  {
    const mk = (name, maxAttempts, extra) => makeSyntheticRun(name, { maxAttempts, lines: (runDir) => extra.map((l) => (
      l.type === 'dispatch' && !l.worktreePath ? { ...l, worktreePath: join(runDir, 'wt', l.jobId + (l.attempt > 1 ? `-a${l.attempt}` : '')) } : l
    )) })
    const noOp = mk('disp-noop', 3, [
      { type: 'dispatch', jobId: 'j1', attempt: 1, leaseId: 'wt/j1', branch: 'swarm/wt-j1', startedAt: '2026-10-16T00:00:00.000Z' },
      { type: 'completion', jobId: 'j1', attempt: 1, ok: true, timedOut: false, exitCode: 0, diffBytes: 0, endedAt: '2026-10-16T00:00:01.000Z' },
    ])
    const dbNoOp = join(sandbox, 'disp-noop', 'recovery.db')
    const r1 = runRecover(null, ['--run', noOp.runId, '--run-root', noOp.runRoot, '--db', dbNoOp])
    const rec1 = JSON.parse(read(join(noOp.runDir, 'recovery.json')))
    t('R5: completion ok + diffBytes 0 -> terminal / no-op (a machine verdict is never re-rolled), exit 0, no DB created',
      r1.code === 0 && JSON.stringify(rec1.jobs) === JSON.stringify([
        { jobId: 'j1', attemptsUsed: 1, maxAttempts: 3, disposition: 'terminal', reason: 'no-op' },
      ]) && !existsSync(dbNoOp))

    const okDiff = mk('disp-okdiff', 5, [
      { type: 'dispatch', jobId: 'j1', attempt: 1, leaseId: 'wt/j1', branch: 'swarm/wt-j1', startedAt: '2026-10-16T00:00:00.000Z' },
      { type: 'completion', jobId: 'j1', attempt: 1, ok: true, timedOut: false, exitCode: 0, diffBytes: 123, endedAt: '2026-10-16T00:00:01.000Z' },
    ])
    runRecover(null, ['--run', okDiff.runId, '--run-root', okDiff.runRoot, '--db', join(sandbox, 'disp-okdiff', 'recovery.db')])
    const rec2 = JSON.parse(read(join(okDiff.runDir, 'recovery.json')))
    t('R5: completed with a diff but no durably recorded verdict -> retryable while the bound allows',
      JSON.stringify(rec2.jobs) === JSON.stringify([
        { jobId: 'j1', attemptsUsed: 1, maxAttempts: 5, disposition: 'retryable', reason: null },
      ]))

    const notOk = mk('disp-notok', 3, [
      { type: 'dispatch', jobId: 'j1', attempt: 1, leaseId: 'wt/j1', branch: 'swarm/wt-j1', startedAt: '2026-10-16T00:00:00.000Z' },
      { type: 'completion', jobId: 'j1', attempt: 1, ok: false, timedOut: false, exitCode: 3, diffBytes: 0, endedAt: '2026-10-16T00:00:01.000Z' },
    ])
    runRecover(null, ['--run', notOk.runId, '--run-root', notOk.runRoot, '--db', join(sandbox, 'disp-notok', 'recovery.db')])
    const rec3 = JSON.parse(read(join(notOk.runDir, 'recovery.json')))
    t('R5: a !ok completion under an unspent bound -> retryable',
      rec3.jobs[0]?.disposition === 'retryable' && rec3.jobs[0]?.reason === null)

    const bound = mk('disp-bound', 2, [
      { type: 'dispatch', jobId: 'j1', attempt: 1, leaseId: 'wt/j1', branch: 'swarm/wt-j1', startedAt: '2026-10-16T00:00:00.000Z' },
      { type: 'completion', jobId: 'j1', attempt: 1, ok: false, timedOut: true, exitCode: null, diffBytes: 0, endedAt: '2026-10-16T00:00:01.000Z' },
      { type: 'dispatch', jobId: 'j1', attempt: 2, leaseId: 'wt/j1-a2', branch: 'swarm/wt-j1-a2', startedAt: '2026-10-16T00:00:02.000Z' },
      { type: 'completion', jobId: 'j1', attempt: 2, ok: false, timedOut: false, exitCode: 7, diffBytes: 0, endedAt: '2026-10-16T00:00:03.000Z' },
    ])
    runRecover(null, ['--run', bound.runId, '--run-root', bound.runRoot, '--db', join(sandbox, 'disp-bound', 'recovery.db')])
    const rec4 = JSON.parse(read(join(bound.runDir, 'recovery.json')))
    t('R5: attempts used >= maxAttempts -> terminal / bound-exhausted',
      JSON.stringify(rec4.jobs) === JSON.stringify([
        { jobId: 'j1', attemptsUsed: 2, maxAttempts: 2, disposition: 'terminal', reason: 'bound-exhausted' },
      ]))

    const nullDiff = mk('disp-nulldiff', 4, [
      { type: 'dispatch', jobId: 'j1', attempt: 1, leaseId: 'wt/j1', branch: 'swarm/wt-j1', startedAt: '2026-10-16T00:00:00.000Z' },
      { type: 'completion', jobId: 'j1', attempt: 1, ok: true, timedOut: false, exitCode: 0, diffBytes: null, endedAt: '2026-10-16T00:00:01.000Z' },
    ])
    runRecover(null, ['--run', nullDiff.runId, '--run-root', nullDiff.runRoot, '--db', join(sandbox, 'disp-nulldiff', 'recovery.db')])
    const rec5 = JSON.parse(read(join(nullDiff.runDir, 'recovery.json')))
    t('R5: ok + diffBytes null (failed capture) is NOT a no-op verdict — retryable, absent evidence is not an answer',
      JSON.stringify(rec5.jobs) === JSON.stringify([
        { jobId: 'j1', attemptsUsed: 1, maxAttempts: 4, disposition: 'retryable', reason: null },
      ]))
  }

  // ---------- R6: refusals exit non-zero and write nothing ----------
  {
    const missing = runRecover('missing --run', [])
    t('R6: missing --run refuses with exit 1 naming the requirement',
      missing.code === 1 && missing.out.includes('--run <runId> is required'))
    const unknown = runRecover('unknown run', ['--run', '19990101000000', '--run-root', sandbox])
    t('R6: an unknown --run refuses with exit 1 naming the run directory',
      unknown.code === 1 && unknown.out.includes('no such run directory'))
    const finishedDir = join(R1_RUN_ROOT, R1_RUN_ID)
    const finished = runRecover('finished run', ['--run', R1_RUN_ID, '--run-root', R1_RUN_ROOT, '--db', join(sandbox, 'completed-run', 'nope.db')])
    t('R6: a finished run (report.json present) refuses with exit 1 pointing at ingest',
      finished.code === 1 && finished.out.includes('report.json') && finished.out.includes('nothing to reconcile'))
    t('R6: the finished-run refusal wrote nothing',
      !existsSync(join(finishedDir, 'recovery.json')) && !existsSync(join(sandbox, 'completed-run', 'nope.db')))
  }

  // ---------- R7: pre-T-010 crash — inspection-only ----------
  {
    const { repo, git } = makeRepo('pre-t010')
    const runRoot = join(sandbox, 'pre-t010', 'runs')
    const runId = '20991010150000'
    const runDir = join(runRoot, runId)
    mkdirSync(join(runDir, 'wt'), { recursive: true })
    const wt = join(runDir, 'wt', 'c01')
    git('worktree', 'add', wt, '-b', 'swarm/wt-c01', 'HEAD')
    writeFileSync(join(wt, 'file.txt'), 'uncommitted\n')
    const db = join(sandbox, 'pre-t010', 'recovery.db')
    const rec = runRecover(null, ['--run', runId, '--run-root', runRoot, '--db', db])
    const recovery = JSON.parse(read(join(runDir, 'recovery.json')))
    t('R7: a run with no dispatch.jsonl reconciles inspection-only, exit 0',
      rec.code === 0 && recovery.abandonedAttempts.length === 0 && recovery.kills.length === 0
      && recovery.jobs.length === 0 && recovery.note?.includes('no in-run evidence recorded'))
    t('R7: the worktree is still listed with branch and dirty state, and nothing was removed',
      recovery.workspaces.length === 1 && recovery.workspaces[0].branch === 'swarm/wt-c01'
      && recovery.workspaces[0].dirty === true && existsSync(wt)
      && git('branch', '--list', 'swarm/wt-c01').trim() !== '')
    t('R7: nothing to mark — no DB was created',
      !existsSync(db))
  }

  // ---------- R8: a recovery.json write failure still releases the lock ----------
  {
    const { runRoot, runId, runDir } = makeSyntheticRun('write-failure', {
      maxAttempts: 3,
      lines: (runDir) => [
        { type: 'dispatch', jobId: 'j1', attempt: 1, leaseId: 'wt/j1', branch: 'swarm/wt-j1', worktreePath: join(runDir, 'wt', 'j1'), startedAt: '2026-10-16T00:00:00.000Z' },
        { type: 'completion', jobId: 'j1', attempt: 1, ok: true, timedOut: false, exitCode: 0, diffBytes: 0, endedAt: '2026-10-16T00:00:01.000Z' },
      ],
    })
    // A directory squatting on the artifact path makes writeFileSync fail
    // (EISDIR) after the lock is held and every other step has run.
    mkdirSync(join(runDir, 'recovery.json'))
    const db = join(sandbox, 'write-failure', 'recovery.db')
    const rec = runRecover('write failure', ['--run', runId, '--run-root', runRoot, '--db', db, '--force-lock'])
    t('R8: a recovery.json write failure exits non-zero, naming the failed path',
      rec.code === 1 && rec.out.includes('failed (write') && rec.out.includes('recovery.json'))
    t('R8: the checkout lock is released even when the report write failed — no residual .lock',
      readdirSync(join(runRoot, 'locks')).filter((f) => f.endsWith('.lock')).length === 0)
    t('R8: nothing to mark (no-op completion) and nothing fabricated — no DB, blocker path still a directory',
      !existsSync(db) && statSync(join(runDir, 'recovery.json')).isDirectory())
  }

  rmSync(sandbox, { recursive: true, force: true })
}

main()
  .catch((e) => {
    failures.push(`gate crashed: ${e instanceof Error ? e.message : String(e)}`)
    console.error(e)
  })
  .finally(() => {
    killOrphans()
    if (failures.length > 0) {
      console.error(`\ncheck-recovery: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-recovery: ALL GREEN')
  })
