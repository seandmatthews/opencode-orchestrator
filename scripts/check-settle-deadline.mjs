// Post-kill settle deadline self-check (Gate 1.31, fast tier, T-046) — run
// under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-settle-deadline.mjs
// Token-free, deterministic, no git, no opencode binary, no model IDs. Pins
// the T-046 contract: after the verified tree kill fires at expiry, a bounded
// secondary window (the exported KILL_SETTLE_WINDOW_MS constant, never a CLI
// knob) is the LAST wait — if the child's close never arrives inside it, both
// timed-run cores resolve anyway (timedOut true, exitCode null, a loud
// `CLEANUP FAIL: ... abandoning the wait` line in cleanupFailures, stdio
// streams destroyed) instead of wedging the attempt, the run, and the
// never-reaped checkout lock.
//
// The exact wedge shape, constructed and documented here (the ticket's own
// recipe): a stub ROOT process spawns a DETACHED long-sleep child that
// INHERITS the root's stdout/stderr pipes, writes both pids where the check
// can read them, then exits on its own —
//
//   check ──pipe──► stub root ──inherit──► detached escaper (long sleep)
//                        │ exits ~immediately
//   → the root's 'exit' fires, but the pipe's write end lives in the escaper,
//   so the check-side stdout stream never sees 'end' and the core's
//   drained/close promise NEVER settles;
//   → at expiry the kill early-returns (the root already exited — its pid is
//   not ours to taskkill), and the escaper is outside any /T walk (no live
//   root to walk from): it has escaped the tree kill's reach while holding
//   the inherited pipe.
//
// Pre-change that is a forever-hang; the check's outer guard
// (timeoutMs + window + slack) converts it into a RED. Post-change both
// cores abandon the wait at the window and settle inside the same bound.
//
//   A1-A9  the worker core (runChildWithTimeout, the Gate 1.12 S4 seam):
//          settles inside the bound, timedOut true, exitCode null, the
//          abandonment line in cleanupFailures AND the log, the escaper
//          demonstrably still alive (the wedge was real), the wait actually
//          lasted the window, and the core destroyed both stdio streams (no
//          parent-side pipe handle survives).
//   B0-B6  the probe core (executeProbeCommand — exported for this pin the
//          snapshotTree precedent): same red/green pair against the same
//          stub shape.
//   C1-C3  the exported constant (positive integer, >= 1s), the probe core
//          importing it from the same single source, and no CLI knob
//          (src/cli.ts never mentions settle).
//
// The script's own exit is the last assertion: after the sweep kills the
// escapers, an unref'd watchdog converts "process still alive" (a leaked
// pipe handle) into a red instead of a hang.
import { swarmRoot } from './swarm-root.mjs'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as rwt from '../src/worker/run-with-timeout.ts'
import * as probe from '../src/probe.ts'
import { killTreeVerified } from '../src/kill-tree.ts'

const failures = []
let assertions = 0
const t = (name, cond) => {
  assertions++
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = swarmRoot + '/verify-settle'
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

// The settle window as the ENGINE knows it — the exported constant once it
// exists (post-change), the documented default while measuring the red bar
// against pristine main (pre-change: undefined, and C1 goes red saying so).
const WINDOW = Number.isInteger(rwt.KILL_SETTLE_WINDOW_MS) ? rwt.KILL_SETTLE_WINDOW_MS : 15_000
// The stub's timeout budget and the outer guard: expiry + full window + slack.
const T = 1000
const GUARD_MS = T + WINDOW + 10_000

// Every escaper this script plants — swept best-effort at the end so nothing
// we spawned outlives the check (AGENTS.md #10, mechanized; the escaper is
// deliberately outside every kill's reach, so only we can reap it).
const planted = []

// The wedge stub (see the header for the exact shape and why it wedges).
const stub = join(sandbox, 'escaper-stub.js')
writeFileSync(stub, `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const dir = process.argv[2]
const escaper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,                                  // survives the root's exit
  stdio: ['ignore', 'inherit', 'inherit'],         // holds the root's (inherited) pipes
})
escaper.unref()
writeFileSync(join(dir, 'pid-root.json'), String(process.pid))
writeFileSync(join(dir, 'pid-escaper.json'), String(escaper.pid))
process.exit(0)
`)

async function waitForPids(dir, deadlineMs = 15000) {
  const files = [join(dir, 'pid-root.json'), join(dir, 'pid-escaper.json')]
  const deadline = Date.now() + deadlineMs
  for (const f of files) {
    while (!existsSync(f)) {
      if (Date.now() > deadline) throw new Error(`stub never wrote ${f}`)
      await sleep(25)
    }
  }
  const pids = files.map((f) => Number(readFileSync(f, 'utf8')))
  planted.push(pids[1])
  return { root: pids[0], escaper: pids[1] }
}

/** Race the never-settling candidate against the outer guard; resolves
 *  { settled: false } on guard fire (the RED face), { settled: true, value }
 *  when the core settled inside the bound (the GREEN face). */
async function withGuard(p) {
  let guardFired = false
  const guard = new Promise((resolve) => setTimeout(() => { guardFired = true; resolve(null) }, GUARD_MS))
  const wrapped = p.then((value) => ({ settled: true, value }))
  const out = await Promise.race([wrapped, guard])
  return out ?? { settled: false, guardFired }
}

const ABANDON_RE = /^CLEANUP FAIL: child did not settle \d+s after verified tree kill — abandoning the wait \(evidence follows in the log\)$/

// ---------- A — the worker core: runChildWithTimeout on the wedge stub ----------
{
  const dir = join(sandbox, 'a-worker-core')
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'worker.log')
  const child = spawn(process.execPath, [stub, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  const { escaper } = await waitForPids(dir)
  const started = Date.now()
  const out = await withGuard(rwt.runChildWithTimeout(child, { timeoutMs: T, logPath }))
  const elapsed = Date.now() - started
  t(`A1: the call settles inside timeoutMs + window + slack (${elapsed}ms; pre-change this is the forever-hang RED)`, out.settled === true)
  const escaperStillAlive = isAlive(escaper)
  if (out.settled === true) {
    const r = out.value
    t('A2: timedOut true', r.timedOut === true)
    t('A3: exitCode null (the close never delivered one — never a guess)', r.exitCode === null)
    t('A4: cleanupFailures carries the abandonment line',
      Array.isArray(r.cleanupFailures) && r.cleanupFailures.length === 1 && ABANDON_RE.test(r.cleanupFailures[0]))
    t('A5: the escaper OUTLIVED the abandonment (it really escaped the kill\'s reach while holding the pipe)', escaperStillAlive)
    const log = readFileSync(logPath, 'utf8')
    t('A6: the log carries the abandonment line', log.split('\n').some((l) => ABANDON_RE.test(l)))
    t('A7: the log\'s exit line records the abandoned shape', /\$ exit code: null \(timed out\)/.test(log))
    t(`A8: the wait actually lasted the window (elapsed ${elapsed}ms >= ${T + WINDOW - 500}ms)`, elapsed >= T + WINDOW - 500)
    t('A9: the parent holds no pipe handle — the core destroyed both stdio streams',
      child.stdout.destroyed === true && child.stderr.destroyed === true)
  } else {
    t('A2: timedOut true (unreachable — the core never settled)', false)
    t('A3: exitCode null (unreachable — the core never settled)', false)
    t('A4: cleanupFailures carries the abandonment line (unreachable)', false)
    t('A5: the escaper OUTLIVED the guard window (the wedge shape held)', escaperStillAlive)
    t('A6: the log carries the abandonment line (unreachable)', false)
    t('A7: the log\'s exit line records the abandoned shape (unreachable)', false)
    t('A8: the wait actually lasted the window (unreachable)', false)
    t('A9: the core destroyed both stdio streams (unreachable)', false)
  }
}

// ---------- B — the probe core: executeProbeCommand on the same stub ----------
{
  const dir = join(sandbox, 'b-probe-core')
  mkdirSync(dir, { recursive: true })
  const exported = typeof probe.executeProbeCommand === 'function'
  t('B0: executeProbeCommand is exported for pinning (the snapshotTree precedent)', exported)
  if (exported) {
    const started = Date.now()
    const call = probe.executeProbeCommand({ exe: process.execPath, args: [stub, dir] }, dir, T)
    const { escaper } = await waitForPids(dir) // in flight under the call's own budget
    const out = await withGuard(call)
    const elapsed = Date.now() - started
    t(`B1: the call settles inside timeoutMs + window + slack (${elapsed}ms; pre-change this is the forever-hang RED)`, out.settled === true)
    const escaperStillAlive = isAlive(escaper)
    if (out.settled === true) {
      const r = out.value
      t('B2: timedOut true', r.timedOut === true)
      t('B3: exitCode null', r.exitCode === null)
      t('B4: cleanupFailures carries the abandonment line',
        Array.isArray(r.cleanupFailures) && r.cleanupFailures.some((l) => ABANDON_RE.test(l)))
      t('B5: the escaper OUTLIVED the abandonment (it really escaped the kill\'s reach)', escaperStillAlive)
      t(`B6: the wait actually lasted the window (durationMs ${r.durationMs}ms >= ${T + WINDOW - 500}ms)`, r.durationMs >= T + WINDOW - 500)
    } else {
      t('B2: timedOut true (unreachable — the core never settled)', false)
      t('B3: exitCode null (unreachable)', false)
      t('B4: cleanupFailures carries the abandonment line (unreachable)', false)
      t('B5: the escaper OUTLIVED the guard window (the wedge shape held)', escaperStillAlive)
      t('B6: the wait actually lasted the window (unreachable)', false)
    }
  }
}

// ---------- C — the exported constant, one source, no knob ----------
{
  t('C1: KILL_SETTLE_WINDOW_MS is exported and a positive integer >= 1s (the MAX_RETRY_FINDINGS pattern)',
    Number.isInteger(rwt.KILL_SETTLE_WINDOW_MS) && rwt.KILL_SETTLE_WINDOW_MS >= 1000)
  const probeSrc = readFileSync(join(root, 'src', 'probe.ts'), 'utf8')
  t('C2: the probe core imports the same constant from the worker core (single source)',
    probeSrc.includes("import { KILL_SETTLE_WINDOW_MS } from './worker/run-with-timeout.js'"))
  const cliSrc = readFileSync(join(root, 'src', 'cli.ts'), 'utf8')
  t('C3: never a CLI knob — src/cli.ts mentions no settle anything', !/settle/i.test(cliSrc))
}

// ---------- sweep: the escapers are outside every kill's reach by design —
// only this script can reap them (AGENTS.md #10) ----------
for (const pid of planted) {
  if (isAlive(pid)) {
    try {
      killTreeVerified(pid)
    } catch {
      // best-effort; a surviving escaper is loud in the watchdog below
    }
  }
}
rmSync(sandbox, { recursive: true, force: true })

console.log(`\n=== check-settle-deadline (Gate 1.31): ${failures.length === 0 ? `ALL GREEN (${assertions} assertions)` : `${failures.length} failure(s) of ${assertions}`} ===`)

// The check's own exit is A9's systemic twin: with the streams destroyed and
// the escapers reaped, this process must drain naturally. The unref'd
// watchdog converts a leaked-handle hang into a red instead.
process.exitCode = failures.length === 0 ? 0 : 1
if (process.platform !== 'win32') {
  // T-065: the systemic drain criterion (does THIS process exit?) is
  // confounded on POSIX by the harness itself — a pending stdout write to a
  // slow reader keeps the fd-1/2 Sockets ref'd for as long as the reader
  // stalls, and tsx's own service child lives through the run. Neither
  // belongs to the worker core. The T-046 criterion is therefore measured
  // DIRECTLY: after a bounded settle, the only live handles are the
  // process's own stdio (fd <= 2). A worker-core pipe (fd > 2) is the red.
  // On Windows the in-process watchdog below stands (the drain there is not
  // confounded — the tier has pinned it this way since T-046).
  setTimeout(() => {
    const strays = process._getActiveHandles()
      .filter((h) => typeof h?.fd === 'number' && h.fd > 2)
    if (strays.length > 0) {
      console.error(`FAIL: worker-core handles survived the settle window — ${strays.map((h) => `${h?.constructor?.name ?? typeof h} fd=${h.fd}`).join(', ')} (the T-046 green criterion)`)
      process.exitCode = 1
    }
  }, 3_000).unref()
} else {
  const watchdog = setTimeout(() => {
    console.error('FAIL: check process still alive 10s after assertions — an open handle leaked (the T-046 green criterion)')
    process.exit(1)
  }, 10_000)
  watchdog.unref()
}
