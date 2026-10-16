// Process-tree termination hardening self-check (Gate 1.12, fast tier, T-011)
// — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-kill-tree.mjs
// Token-free, deterministic, no git, no opencode binary, no model IDs: plants
// real node process trees and asserts on the REAL process table
// (process.kill(pid, 0)), never a mock. Pins spec §15.3's MVP contract —
// Windows tree termination, verify descendants disappear, remaining
// descendants are cleanup failures:
//   S1  CommandGate with a tiny timeout against a grandchild-spawning node
//       command: FAIL shape unchanged (passed false, exitCode null,
//       durationMs >= timeoutMs), no cleanup failures, every script-tracked
//       pid dead. Red bar (recorded in the ticket): exec's built-in `timeout`
//       left grandparent AND grandchild alive.
//   S2  normally-completing gates (passing AND failing): today's GateResult
//       shape, NO cleanupFailures key on any non-timeout path; the exec
//       options stay windowsHide/cwd/encoding/maxBuffer and the built-in
//       `timeout` option is gone (source-level pin).
//   S3  killTreeVerified on an already-gone pid: reported result
//       {rootWasLive: false, verified: false, survivors: []} — no throw, no
//       silence (the removed-catch regression pin).
//   S4  runChildWithTimeout on a node tree with a tiny timeout: timedOut
//       true, the whole tree dead, `tree killed, verified: N processes
//       reaped` in the log, no CLEANUP FAIL — the harness-agnostic timeout
//       core, driven with no opencode involvement.
//   S5  snapshot-depth sanity: the pre-kill enumeration of a planted 3-level
//       tree contains mid and leaf, and the verified kill returns
//       {rootWasLive: true, verified: true, survivors: []} with all three
//       pids dead.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killTreeVerified, snapshotTree } from '../src/kill-tree.ts'
import { CommandGate } from '../src/gate/command.ts'
import { runChildWithTimeout } from '../src/worker/run-with-timeout.ts'

const failures = []
let assertions = 0
const t = (name, cond) => {
  assertions++
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-killtree'
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Every pid this script ever learns about — swept best-effort at the end, so
// nothing we planted outlives the check (AGENTS.md #10, mechanized).
const planted = new Set()

// The planted tree node: depth N spawns depth N-1, every node records its pid
// in the sandbox dir, every node stays alive until killed. The root prints one
// marker line so S4 can pin that runChildWithTimeout drains child stdout into
// the log.
const treeNode = join(sandbox, 'tree-node.js')
writeFileSync(treeNode, `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const depth = Number(process.argv[2])
const dir = process.argv[3]
if (depth > 1) spawn(process.execPath, [__filename, String(depth - 1), dir], { stdio: 'ignore' })
writeFileSync(join(dir, 'pid-' + depth + '.json'), String(process.pid))
if (depth === 3) console.log('tree is up')
setInterval(() => {}, 1000)
`)

async function waitForPids(dir, depths, deadlineMs = 15000) {
  const out = {}
  const deadline = Date.now() + deadlineMs
  for (const d of depths) {
    const f = join(dir, `pid-${d}.json`)
    while (!existsSync(f)) {
      if (Date.now() > deadline) throw new Error(`tree node depth ${d} never came up (${f})`)
      await sleep(50)
    }
    out[d] = Number(readFileSync(f, 'utf8'))
    planted.add(out[d])
  }
  return out
}

async function waitUntilDead(pids, deadlineMs = 5000) {
  const deadline = Date.now() + deadlineMs
  while (pids.some(isAlive)) {
    if (Date.now() > deadline) return
    await sleep(25)
  }
}

// ---------- S1 — timed-out CommandGate kills its whole tree ----------
{
  const dir = join(sandbox, 's1')
  mkdirSync(dir, { recursive: true })
  const gate = new CommandGate(
    's1-timeout',
    `node ${treeNode.replaceAll('\\', '/')} 2 ${dir.replaceAll('\\', '/')}`,
    1500,
  )
  const pending = gate.run(dir)
  // The tree must be up well before the 1500ms deadline.
  const pids = await waitForPids(dir, [1, 2])
  const r = await pending
  t('S1: timed-out gate fails', r.passed === false)
  t('S1: timeout exitCode is null', r.exitCode === null)
  t(`S1: durationMs (${r.durationMs}ms) >= timeoutMs (1500ms)`, r.durationMs >= 1500)
  t('S1: outputTail collected', typeof r.outputTail === 'string')
  t('S1: no cleanup failures on a verified kill', r.cleanupFailures === undefined)
  await waitUntilDead([pids[1], pids[2]])
  t('S1: tracked gate-child pid dead', !isAlive(pids[2]))
  t('S1: tracked grandchild pid dead', !isAlive(pids[1]))
}

// ---------- S2 — normally-completing gates are unchanged ----------
{
  const pass = await new CommandGate('s2-pass', 'node -e "process.exit(0)"', 60_000).run(sandbox)
  t('S2: passing gate passes with exit code 0', pass.passed === true && pass.exitCode === 0)
  t(
    'S2: GateResult shape unchanged (name/exitCode/durationMs/outputTail)',
    pass.name === 's2-pass'
      && typeof pass.durationMs === 'number'
      && typeof pass.outputTail === 'string'
      && Array.isArray(pass.gates) === false,
  )
  t('S2: no cleanupFailures key on the happy path', !Object.prototype.hasOwnProperty.call(pass, 'cleanupFailures'))
  const fail = await new CommandGate('s2-fail', 'node -e "process.exit(3)"', 60_000).run(sandbox)
  t('S2: naturally-failing gate fails with its real exit code', fail.passed === false && fail.exitCode === 3)
  t('S2: no cleanupFailures key on the failing path', !Object.prototype.hasOwnProperty.call(fail, 'cleanupFailures'))
  const src = readFileSync(join(root, 'src', 'gate', 'command.ts'), 'utf8')
  t(
    'S2: exec keeps windowsHide/cwd/encoding/maxBuffer',
    src.includes('{ cwd, windowsHide: true, encoding: \'utf8\', maxBuffer: 16 * 1024 * 1024 }'),
  )
  t('S2: exec built-in timeout option removed', !/timeout:\s*this\.timeoutMs/.test(src))
}

// ---------- S3 — an already-gone pid is a reported result, never silence ----------
{
  const pid = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', 'process.exit(0)'])
    c.on('exit', () => resolve(c.pid))
  })
  planted.add(pid)
  const deadline = Date.now() + 5000
  while (isAlive(pid) && Date.now() < deadline) await sleep(25)
  t('S3: planted pid is gone before the kill attempt', !isAlive(pid))
  let r = null
  let threw = null
  try {
    r = killTreeVerified(pid)
  } catch (e) {
    threw = e
  }
  t('S3: killTreeVerified does not throw on an already-gone pid', threw === null && r !== null)
  t(
    'S3: reported result, not silence',
    r !== null && r.rootWasLive === false && r.verified === false && Array.isArray(r.survivors) && r.survivors.length === 0,
  )
}

// ---------- S4 — runChildWithTimeout: verified, testable, harness-free ----------
{
  const dir = join(sandbox, 's4')
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'worker.log')
  const child = spawn(process.execPath, [treeNode, '3', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  const pids = await waitForPids(dir, [1, 2, 3])
  const r = await runChildWithTimeout(child, { timeoutMs: 800, logPath })
  t('S4: timedOut true', r.timedOut === true)
  t('S4: no cleanup failures on a verified kill', Array.isArray(r.cleanupFailures) && r.cleanupFailures.length === 0)
  await waitUntilDead([pids[1], pids[2], pids[3]])
  t('S4: whole tree dead (root, mid, leaf)', !isAlive(pids[3]) && !isAlive(pids[2]) && !isAlive(pids[1]))
  const log = readFileSync(logPath, 'utf8')
  t('S4: log carries the verified kill line', /tree killed, verified: \d+ processes reaped/.test(log))
  t('S4: log carries no CLEANUP FAIL', !log.includes('CLEANUP FAIL'))
  t('S4: log drained the child stdout', log.includes('tree is up'))
  t('S4: log carries the timed-out exit line', /\$ exit code: (null|\d+) \(timed out\)/.test(log))
  t('S4: no opencode anywhere in this run', !log.includes('opencode'))
}

// ---------- S5 — snapshot depth + the planted 3-level verified kill ----------
{
  const dir = join(sandbox, 's5')
  mkdirSync(dir, { recursive: true })
  const parent = spawn(process.execPath, [treeNode, '3', dir], { stdio: 'ignore' })
  planted.add(parent.pid)
  const pids = await waitForPids(dir, [1, 2, 3])
  const snap = snapshotTree(pids[3])
  t('S5: pre-kill snapshot contains the root', snap.includes(pids[3]))
  t('S5: pre-kill snapshot contains the planted mid', snap.includes(pids[2]))
  t('S5: pre-kill snapshot contains the planted grandchild', snap.includes(pids[1]))
  const r = killTreeVerified(pids[3])
  t(
    'S5: live 3-level tree kill verifies clean',
    r.rootWasLive === true && r.verified === true && Array.isArray(r.survivors) && r.survivors.length === 0,
  )
  await waitUntilDead([pids[1], pids[2], pids[3]])
  t('S5: all three pids dead', !isAlive(pids[3]) && !isAlive(pids[2]) && !isAlive(pids[1]))
}

// ---------- sweep: nothing planted outlives this check ----------
for (const pid of planted) {
  if (isAlive(pid)) {
    try {
      killTreeVerified(pid)
    } catch {
      // best-effort; the assertions above already proved the kills work
    }
  }
}
rmSync(sandbox, { recursive: true, force: true })

console.log(`\n=== check-kill-tree (Gate 1.12): ${failures.length === 0 ? `ALL GREEN (${assertions} assertions)` : `${failures.length} failure(s) of ${assertions}`} ===`)
process.exit(failures.length === 0 ? 0 : 1)
