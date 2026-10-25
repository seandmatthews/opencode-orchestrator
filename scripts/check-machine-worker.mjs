// MachineWorker adapter self-check (Gate 1.17, fast tier, T-017) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-machine-worker.mjs
// Zero model tokens, zero opencode involvement. Six scenarios + contract
// fixtures (the ticket's acceptance criteria):
//   S1  direct adapter: a real file-mutating node command runs in the
//       contracted cwd (ok true, exit 0, change visible to `git diff` in a
//       scratch repo); the T-010 spawn contract (onSpawn exactly once,
//       WorkerResult.pid equal); directory resolution — a child printing
//       process.cwd() yields exactly req.cwd with NO env pinning (a bogus
//       inherited PWD must not move the child — the Known issue #1 contrast).
//   S2  a failing command returns ok false / exitCode 3 / timedOut false,
//       no throw.
//   S3  a non-existent executable returns ok false / exitCode null (the
//       spawn-error path) without throwing; onSpawn never fires.
//   S4  a timed-out command fires the verified tree kill via
//       runChildWithTimeout (log line + real process-table assertions) and
//       cleanupFailures pass through onto WorkerResult (source-level pin of
//       the wiring, the Gate 1.12 S2 precedent, plus the runtime shape).
//   S5  a token-free REAL-CLI --jobs end-to-end run (the Gate 1.5 sandbox
//       pattern): two machine jobs with different commands (each gated on
//       its own marker file) plus a no-op machine command — both real jobs
//       PASS with diffBytes > 0 and the correct job-command pairing (each
//       worker.log carries exactly its own argv), and the no-op job is
//       eliminated as NO-OP, never a pass (AGENTS.md #7).
//   S6  refusals, all exit 1 with zero side effects (no artifacts dir, no
//       locks/): --worker machine at run level (parse time); command on a
//       non-machine job; a machine job without command; a malformed
//       command; and the unknown-worker message now reading
//       `available: opencode, machine`.
//   P   contract fixtures: parseJobsSpec's command field (verbatim,
//       byte-identical output without it, malformed shapes refused) and the
//       pure commandPairingRefusal helper (both directions, default-worker
//       resolution, refusal names the job).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MachineWorker } from '../src/worker/machine.ts'
import { parseJobsSpec, commandPairingRefusal } from '../src/scheduler.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const read = (p) => readFileSync(p, 'utf8')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-machine'
const NODE = process.execPath
const IDENTITY = ['-c', 'user.name=check-machine', '-c', 'user.email=machine@local']

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
/** Best-effort sweep of a planted tree (AGENTS.md #10 mechanized for this
 *  check's own spawns) — only reached when a kill assertion already failed. */
function sweep(pid) {
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    // Already dead — fine.
  }
}

/** Drive MachineWorker directly the way the runner does (src/runner.ts:
 *  prompt/model/cwd/logPath/timeoutMs/onSpawn), collecting onSpawn pids. */
async function driveAdapter(command, { cwd, timeoutMs = 10_000, prompt = 'machine brief (provenance only)' }) {
  const pids = []
  const worker = new MachineWorker(command)
  const logPath = join(sandbox, 'direct', `worker-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`)
  mkdirSync(dirname(logPath), { recursive: true })
  const result = await worker.execute({
    prompt,
    model: 'zai-coding-plan/glm-5.3-flash',
    cwd,
    logPath,
    timeoutMs,
    onSpawn: (pid) => pids.push(pid),
  })
  return { result, pids, logPath }
}

function makeRepo(name, files) {
  const repo = join(sandbox, name, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => run('git', ['-C', repo, ...args])
  git('init', '-b', 'main')
  for (const [name2, content] of Object.entries(files)) writeFileSync(join(repo, name2), content)
  git(...IDENTITY, 'add', '-A')
  git(...IDENTITY, 'commit', '-m', 'baseline')
  return repo
}

async function main() {
  // ---------- S1: direct adapter — real file-mutating command, spawn
  // ---------- contract, directory resolution with NO env pinning ----------
  {
    const repo = makeRepo('s1', { 'tracked.txt': 'baseline\n' })
    const command = [NODE, '-e', 'console.log("CWD=" + process.cwd()); require("fs").appendFileSync("tracked.txt", "machine change\\n")']
    // The Known issue #1 contrast, behaviorally: a plainly spawned child
    // resolves its working directory from its spawn cwd, never from the
    // inherited env.PWD — so poison the inherited env and the child must
    // still report req.cwd.
    const savedPwd = process.env.PWD
    const savedOldpwd = process.env.OLDPWD
    process.env.PWD = 'C:/definitely-not-the-worktree-t017'
    process.env.OLDPWD = 'C:/definitely-not-the-worktree-t017'
    let r
    try {
      r = await driveAdapter(command, { cwd: repo })
    } finally {
      if (savedPwd === undefined) delete process.env.PWD
      else process.env.PWD = savedPwd
      if (savedOldpwd === undefined) delete process.env.OLDPWD
      else process.env.OLDPWD = savedOldpwd
    }
    t('S1: a real file-mutating command — ok true, exit 0, not timed out',
      r.result.ok === true && r.result.exitCode === 0 && r.result.timedOut === false)
    t('S1: T-010 spawn contract — onSpawn called exactly once and WorkerResult.pid is that pid',
      r.pids.length === 1 && r.result.pid !== null && r.pids[0] === r.result.pid)
    t('S1: directory resolution — the child\'s real process.cwd() is exactly req.cwd, with a bogus inherited PWD',
      r.result.responseTail.includes(`CWD=${resolve(repo)}`))
    const diff = run('git', ['-C', repo, 'diff'])
    t('S1: the change is visible to git diff in the scratch repo',
      diff.includes('machine change') && diff.length > 0)
    t('S1: the log carries the argv header and the brief as a provenance header',
      read(r.logPath).includes(JSON.stringify(command)) && read(r.logPath).includes('machine brief (provenance only)'))
  }

  // ---------- S2: a failing command ----------
  {
    const r = await driveAdapter([NODE, '-e', 'process.exit(3)'], { cwd: sandbox })
    t('S2: a failing command — ok false, exitCode 3, timedOut false, no throw',
      r.result.ok === false && r.result.exitCode === 3 && r.result.timedOut === false)
    t('S2: the spawn contract still holds on a failing command',
      r.pids.length === 1 && r.result.pid === r.pids[0])
  }

  // ---------- S3: a non-existent executable ----------
  {
    const r = await driveAdapter(['definitely-not-a-real-exe-t017'], { cwd: sandbox })
    t('S3: a non-existent executable — ok false, exitCode null (spawn-error path), no throw',
      r.result.ok === false && r.result.exitCode === null && r.result.timedOut === false)
    t('S3: no pid ever existed — onSpawn never called, WorkerResult.pid null',
      r.pids.length === 0 && r.result.pid === null)
  }

  // ---------- S4: timeout — verified tree kill + cleanupFailures
  // ---------- passthrough (the Gate 1.12 S4 mechanics, real adapter) ----------
  {
    const workdir = join(sandbox, 's4')
    mkdirSync(workdir, { recursive: true })
    writeFileSync(join(workdir, 'sleeper.js'), [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })",
      "console.log('PARENT_PID=' + process.pid)",
      "console.log('CHILD_PID=' + child.pid)",
      'setInterval(() => {}, 1000)',
    ].join('\n') + '\n')
    const timeoutMs = 1500
    const r = await driveAdapter([NODE, join(workdir, 'sleeper.js')], { cwd: workdir, timeoutMs })
    const log = read(r.logPath)
    const pids = [...log.matchAll(/(?:PARENT|CHILD)_PID=(\d+)/g)].map((m) => Number(m[1]))
    const parentDead = pids[0] !== undefined && await untilDead(pids[0])
    const childDead = pids[1] !== undefined && await untilDead(pids[1])
    if (pids[0] !== undefined && !parentDead) sweep(pids[0])
    if (pids[1] !== undefined && !childDead) sweep(pids[1])
    t('S4: a timed-out command — ok false, timedOut true, durationMs >= timeoutMs (the kill exit code is whatever the killed child reports — only ok/timedOut are the contract)',
      r.result.ok === false && r.result.timedOut === true && r.result.durationMs >= timeoutMs)
    t('S4: the verified tree kill fired — the log carries "tree killed, verified:" and the drained child stdout',
      log.includes('tree killed, verified:') && log.includes('PARENT_PID='))
    t('S4: the whole planted tree is dead on the real process table',
      pids.length === 2 && parentDead && childDead)
    t('S4: cleanupFailures pass through onto WorkerResult — a verified kill leaves the key absent, an unproven one records loud CLEANUP FAIL lines',
      r.result.cleanupFailures === undefined
      || (Array.isArray(r.result.cleanupFailures) && r.result.cleanupFailures.every((l) => l.startsWith('CLEANUP FAIL'))))
    // Source-level pin of the passthrough wiring (the Gate 1.12 S2 source-pin
    // precedent): the timed run goes through runChildWithTimeout and its
    // cleanupFailures spread onto the result, exactly like the OpenCodeWorker.
    // The pinned call shape was EXTENDED (not weakened) in the T-053
    // change-set: the adapter now also passes its attempt-scoped
    // logWriteLoss recorder into the core (the Gate 1.36 key-set-extension
    // precedent) — routing and spread stay asserted verbatim.
    const src = read(join(root, 'src', 'worker', 'machine.ts'))
    t('S4: source pin — the adapter routes through runChildWithTimeout and spreads its cleanupFailures',
      src.includes('runChildWithTimeout(child, { timeoutMs: req.timeoutMs, logPath: req.logPath, logWriteLoss })')
      && src.includes('run.cleanupFailures.length > 0 ? { cleanupFailures: run.cleanupFailures }'))
  }

  // ---------- P: contract fixtures (parseJobsSpec + pairing helper) ----------
  {
    const machineJob = { id: 'codemod', phase: 'p', brief: 'b', worker: 'machine', command: [NODE, 'scripts/codemod.mjs'] }
    const spec = parseJobsSpec({ phases: [{ id: 'p' }], jobs: [machineJob, { id: 'plain', phase: 'p', brief: 'b2' }] })
    t('P: parseJobsSpec accepts a machine job\'s command verbatim (and a command-less job beside it)',
      eq(spec.jobs[0]?.command, [NODE, 'scripts/codemod.mjs']) && spec.jobs[1]?.command === undefined)
    t('P: a spec without command parses to output byte-identical to today (JSON.stringify)',
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
    const withCommand = (command) => ({ phases: [{ id: 'p' }], jobs: [{ id: 'j1', phase: 'p', brief: 'b', command }] })
    t('P: malformed command shapes are refused, naming the job (string, empty array, non-string entry, empty-string entry)',
      throwsWith(withCommand('node -e "process.exit(0)"'), "job 'j1' command must be a non-empty array of non-empty strings")
      && throwsWith(withCommand([]), 'command must be a non-empty array')
      && throwsWith(withCommand([NODE, 3]), 'command must be a non-empty array')
      && throwsWith(withCommand([NODE, '']), 'command must be a non-empty array'))
    t('P: commandPairingRefusal is pure — well-paired sets pass, both mispairings refuse naming the job',
      commandPairingRefusal([machineJob], 'opencode') === null
      && commandPairingRefusal([{ id: 'plain', phase: 'p', brief: 'b' }], 'opencode') === null
      && commandPairingRefusal([{ ...machineJob, worker: undefined, command: [NODE] }], 'opencode')?.includes("job 'codemod' sets command but its worker resolves to 'opencode'")
      && commandPairingRefusal([{ id: 'm', phase: 'p', brief: 'b', worker: 'machine' }], 'opencode')?.includes("job 'm' resolves to the machine worker but sets no command"))
    t('P: commandPairingRefusal resolves the worker through the run-level default argument',
      commandPairingRefusal([{ id: 'j1', phase: 'p', brief: 'b', command: [NODE] }], 'machine') === null
      && commandPairingRefusal([{ id: 'j1', phase: 'p', brief: 'b' }], 'machine')?.includes('sets no command'))
  }

  // ---------- S5: token-free REAL-CLI --jobs end-to-end (the Gate 1.5
  // ---------- sandbox pattern) ----------
  {
    // T-043: the base carries base-state marker files so the marker gates are
    // GREEN on the untouched base (the pre-T-043 fixture was red at base —
    // the files only appeared after the workers ran). Base content differs
    // from what the workers write, so every diff stays non-empty.
    const repo = makeRepo('s5', { 'README.md': 'machine e2e sandbox\n', 'marker-a.txt': 'base state a\n', 'marker-b.txt': 'base state b\n' })
    const runs = join(sandbox, 's5', 'runs')
    const specPath = join(sandbox, 's5', 'spec.json')
    const cmdA = [NODE, '-e', "require('fs').writeFileSync('marker-a.txt', 'machine-a\\n')"]
    const cmdB = [NODE, '-e', "require('fs').writeFileSync('marker-b.txt', 'machine-b\\n')"]
    const cmdNoop = [NODE, '-e', 'process.exit(0)']
    writeFileSync(specPath, JSON.stringify({
      phases: [{ id: 'work' }],
      jobs: [
        { id: 'codemod-a', phase: 'work', dependencies: [], brief: 'write marker A', worker: 'machine', command: cmdA, gates: [{ name: 'marker-a', command: 'node -e "require(\'fs\').accessSync(\'marker-a.txt\')"' }] },
        { id: 'codemod-b', phase: 'work', dependencies: [], brief: 'write marker B', worker: 'machine', command: cmdB, gates: [{ name: 'marker-b', command: 'node -e "require(\'fs\').accessSync(\'marker-b.txt\')"' }] },
        { id: 'noop', phase: 'work', dependencies: [], brief: 'change nothing', worker: 'machine', command: cmdNoop, gates: [{ name: 'vacuous', command: 'node -e "process.exit(0)"' }] },
      ],
    }, null, 2))
    let code = 0
    let out = ''
    try {
      out = run(process.execPath, [
        join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(root, 'src', 'cli.ts'),
        '--repo', repo,
        '--jobs', specPath,
        '--no-review',
        '--run-root', runs,
        '--db', join(sandbox, 's5', 'refinery.db'),
        '--clean',
      ], { timeout: 120_000 })
    } catch (e) {
      code = e.status ?? -1
      out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
    }
    if (code !== 0) console.error(`--- machine e2e run output (exit ${code}) ---\n${out}`)
    t('S5: the real CLI --jobs machine run exits 0', code === 0)
    const runDirs = existsSync(runs) ? readdirSync(runs).filter((d) => /^\d{14}$/.test(d)) : []
    t('S5: exactly one run dir was created', runDirs.length === 1)
    if (runDirs.length !== 1) throw new Error('S5: no run dir to assert on')
    const runDir = join(runs, runDirs[0])
    const report = JSON.parse(read(join(runDir, 'report.json')))
    const byId = new Map(report.candidates.map((c) => [c.id, c]))
    t('S5: both real machine jobs PASS — workerId machine, workerOk, diffBytes > 0, their own gate passing',
      byId.get('codemod-a')?.workerId === 'machine' && byId.get('codemod-a')?.workerOk === true
      && byId.get('codemod-a')?.diffBytes > 0 && byId.get('codemod-a')?.passedAllGates === true
      && byId.get('codemod-a')?.gates?.[0]?.name === 'marker-a' && byId.get('codemod-a')?.gates?.[0]?.passed === true
      && byId.get('codemod-b')?.workerId === 'machine' && byId.get('codemod-b')?.workerOk === true
      && byId.get('codemod-b')?.diffBytes > 0 && byId.get('codemod-b')?.passedAllGates === true
      && byId.get('codemod-b')?.gates?.[0]?.name === 'marker-b' && byId.get('codemod-b')?.gates?.[0]?.passed === true)
    // T-027: the CommandGate stamp end-to-end — the on-disk report's gate
    // entries carry the job spec's commands exactly (the only uniform place
    // a command can meet its verdict is inside the producer's GateResult).
    t('S5 (T-027): the report\'s gate entries carry the job spec\'s command end-to-end (CommandGate stamps GateResult.command)',
      byId.get('codemod-a')?.gates?.[0]?.command === 'node -e "require(\'fs\').accessSync(\'marker-a.txt\')"'
      && byId.get('codemod-b')?.gates?.[0]?.command === 'node -e "require(\'fs\').accessSync(\'marker-b.txt\')"')
    t('S5: the no-op machine command is eliminated as NO-OP, never a pass (AGENTS.md #7) — worker ok, zero-byte diff, gates irrelevant',
      byId.get('noop')?.workerOk === true && byId.get('noop')?.diffBytes === 0
      && byId.get('noop')?.passedAllGates === false && byId.get('noop')?.error === undefined
      && out.includes('NO-OP (no diff)'))
    t('S5: correct job-command pairing — each worker.log carries exactly its own argv (distinct commands, distinct instances)',
      read(join(runDir, 'codemod-a', 'worker.log')).includes(JSON.stringify(cmdA))
      && !read(join(runDir, 'codemod-a', 'worker.log')).includes(JSON.stringify(cmdB))
      && read(join(runDir, 'codemod-b', 'worker.log')).includes(JSON.stringify(cmdB))
      && !read(join(runDir, 'codemod-b', 'worker.log')).includes(JSON.stringify(cmdA))
      && read(join(runDir, 'noop', 'worker.log')).includes(JSON.stringify(cmdNoop)))
    t('S5: each diff.patch captured its own job\'s marker-file change',
      read(join(runDir, 'codemod-a', 'diff.patch')).includes('marker-a.txt')
      && read(join(runDir, 'codemod-b', 'diff.patch')).includes('marker-b.txt'))
    t('S5: the machine brief is provenance only — the log header carries it, unexecuted as such (the argv ran, not the brief)',
      read(join(runDir, 'codemod-a', 'worker.log')).includes('brief (provenance only')
      && read(join(runDir, 'codemod-a', 'worker.log')).includes('write marker A'))

    // T-020: the reproduced --clean leak, red-before/green-after (AGENTS.md
    // #8). The in-run dispose is ONLY `git worktree remove --force`
    // (src/workspace/worktree.ts), so this real --clean machine run has just
    // leaked its swarm/wt-* branches into the target repo — pinned present
    // FIRST (the recorded red bar), then `gc` on this run root removes
    // exactly them.
    const listBranches = () => run('git', ['-C', repo, 'branch', '--list', 'swarm/*'])
      .split('\n').map((l) => l.replace(/^[*+]\s*/, '').trim()).filter(Boolean).sort()
    t('S5 (T-020 red bar): the --clean machine run LEAKED its swarm/* branches — they are present after the run',
      eq(listBranches(), ['swarm/wt-codemod-a', 'swarm/wt-codemod-b', 'swarm/wt-noop']))
    let gcCode = 0
    let gcOut = ''
    try {
      gcOut = run(process.execPath, [
        join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(root, 'src', 'gc.ts'),
        '--run-root', runs,
      ], { timeout: 120_000 })
    } catch (e) {
      gcCode = e.status ?? -1
      gcOut = `${e.stdout ?? ''}${e.stderr ?? e.message}`
    }
    if (gcCode !== 0) console.error(`--- gc output (exit ${gcCode}) ---\n${gcOut}`)
    t('S5 (T-020): gc on this run root exits 0 and classifies the run finished (report.json present → branch sweep only)',
      gcCode === 0 && gcOut.includes('class: finished'))
    t('S5 (T-020 green): gc removed exactly the leaked branches — no swarm/* branches left, only main in worktree list',
      listBranches().length === 0
      && run('git', ['-C', repo, 'worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length === 1)
    t('S5 (T-020): the run\'s evidence survived gc — report.json intact on disk',
      existsSync(join(runDir, 'report.json')) && JSON.parse(read(join(runDir, 'report.json'))).runId === report.runId)
  }

  // ---------- S6: refusals, all exit 1 with zero side effects ----------
  {
    const runs = join(sandbox, 's6', 'runs')
    const notARepo = join(sandbox, 's6', 'not-a-repo')
    mkdirSync(notARepo, { recursive: true })
    const expectRefusal = (label, args, needle) => {
      let code = 0
      let out = ''
      try {
        out = run(process.execPath, [
          join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
          join(root, 'src', 'cli.ts'),
          ...args,
        ], { timeout: 60_000 })
      } catch (e) {
        code = e.status ?? -1
        out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
      }
      const sideEffects = existsSync(runs)
        ? readdirSync(runs).filter((d) => /^\d{14}$/.test(d) || d === 'locks')
        : []
      t(`S6: ${label} — exit 1, names the offense, zero side effects (no artifacts dir, no lock)`,
        code === 1 && out.includes(needle) && sideEffects.length === 0)
      if (code !== 1) console.error(`--- refusal output (${label}, exit ${code}) ---\n${out}`)
    }
    const specFile = (name, jobs) => {
      const p = join(sandbox, 's6', name)
      writeFileSync(p, JSON.stringify({ phases: [{ id: 'p' }], jobs }, null, 2))
      return p
    }
    expectRefusal('--worker machine at run level (parse time)',
      ['--repo', notARepo, '--goal', 'g', '--worker', 'machine', '--run-root', runs],
      '--worker machine is not valid at run level')
    expectRefusal('command on a non-machine job (resolves to the opencode default)',
      ['--repo', notARepo, '--jobs', specFile('nonmachine.json', [{ id: 'j1', phase: 'p', brief: 'b', command: [NODE, '-e', 'process.exit(0)'] }]), '--run-root', runs],
      "job 'j1' sets command but its worker resolves to 'opencode'")
    expectRefusal('a machine job without command',
      ['--repo', notARepo, '--jobs', specFile('nocommand.json', [{ id: 'j1', phase: 'p', brief: 'b', worker: 'machine' }]), '--run-root', runs],
      "job 'j1' resolves to the machine worker but sets no command")
    expectRefusal('a malformed command (a shell string instead of an argv list)',
      ['--repo', notARepo, '--jobs', specFile('badcommand.json', [{ id: 'j1', phase: 'p', brief: 'b', worker: 'machine', command: 'node -e "process.exit(0)"' }]), '--run-root', runs],
      "job 'j1' command must be a non-empty array of non-empty strings")
    expectRefusal('a malformed command (an empty-string argv entry)',
      ['--repo', notARepo, '--jobs', specFile('badcommand2.json', [{ id: 'j1', phase: 'p', brief: 'b', worker: 'machine', command: [NODE, ''] }]), '--run-root', runs],
      "job 'j1' command must be a non-empty array of non-empty strings")
    expectRefusal('an unknown worker id reads `available: opencode, machine`',
      ['--repo', notARepo, '--jobs', specFile('bogus.json', [{ id: 'j1', phase: 'p', brief: 'b', worker: 'bogus' }]), '--run-root', runs],
      "unknown worker adapter 'bogus' (available: opencode, machine)")
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
      console.error(`\ncheck-machine-worker: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-machine-worker: ALL GREEN')
  })
