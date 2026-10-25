// Log-write loss self-check (Gate 1.39, fast tier, T-053) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-log-write-loss.mjs
// Token-free, deterministic, no git, no opencode binary, no model IDs. Pins
// the T-053 contract (register R12): every log write in the worker-run path
// used to swallow its failures silently — a full disk, a locked file, an
// unwritable path (deterministic on Windows: appendFileSync onto a directory
// throws EISDIR, verified on this host) — yielding a silently-empty worker.log
// that a human later reads as "the worker produced nothing". Now the FIRST
// failure per path within one attempt pushes exactly one loud line through
// the existing cleanupFailures channel:
//   LOG WRITE FAILED after <N> bytes at <path>: <err> — log evidence
//   incomplete from this point
// (N = bytes that had actually landed on the path at failure; subsequent
// failures for the same path add nothing — no spam from a chatty child on a
// broken path). The swallow stays: logging never breaks a run, and no
// verdict bit reads the line (gates decide survival, decisions.md
// 2026-10-10).
//
//   A1  the worker core (runChildWithTimeout, the Gate 1.12 S4 seam) driven
//       with logPath = a directory: completes, exit 0, cleanupFailures
//       carries EXACTLY ONE line in the exact format naming the path, the
//       landed byte count at failure (0), and the error (EISDIR). On main
//       this is the recorded red bar: the run completes with zero recorded
//       trace of the loss.
//   A2  no-spam: a child writing MANY chunks after the first failure still
//       adds exactly ONE line (first-failure-per-path).
//   A3  healthy path byte-identical: with a writable log the log bytes are
//       exactly the child's stdout + the exit line, and cleanupFailures is
//       the empty array (the pre-T-053 shape — existing Gate 1.12/1.17
//       checks also ride green unchanged in the same tier).
//   B1  the byte count is honest: chunk 1 LANDS through the core's drain (N
//       bytes on disk), the log is then made unwritable (the Windows
//       read-only attribute — chmod 0o444 — blocks appendFileSync with
//       EPERM, verified on this host; deleting the file is NOT a fixture,
//       appendFileSync recreates a missing file and never throws ENOENT),
//       chunk 2 fails EPERM — exactly one line, N = the landed bytes, error
//       EPERM (also pins the dedup across drain's failing write and the
//       exit-line write, both after the first).
//   C1  MachineWorker driven the Gate 1.17 way (stub command, real adapter)
//       with logPath = a directory: ok stays true (verdict bits computed
//       exactly as today — from exit/time alone), and cleanupFailures
//       carries EXACTLY ONE line for the path — the pre-run argv-line write
//       is the first failure; the core's later writes for the same path add
//       nothing (one recorder across adapter + core, one attempt).
//   C2  OpenCodeWorker with the node exe as its binPath (token-free stub —
//       `node run -m <model>` exits 1, no harness): completes, ok false /
//       exitCode 1 EXACTLY as today, and the same exactly-one line through
//       the same channel.
//   C3  MachineWorker healthy: no cleanupFailures KEY at all on WorkerResult
//       and the log bytes are exactly the pre-run header + child stdout +
//       exit line (byte-identical healthy path, producer-only field).
//   D   verdict inertness, source pins (the Gate 1.12 S2 / 1.17 S4
//       precedent): the ladder line computes passedAllGates from
//       gates.every(passed) + diffBytes alone and never reads
//       cleanupFailures; the runner's aggregation site pushes
//       result.cleanupFailures into the evidence array only; and both
//       adapters route their pre-run write failures into the shared
//       recorder (the wiring that makes C1/C2's exactly-one line possible).
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChildWithTimeout } from '../src/worker/run-with-timeout.ts'
import { MachineWorker } from '../src/worker/machine.ts'
import { OpenCodeWorker } from '../src/worker/opencode.ts'

const failures = []
let assertions = 0
const t = (name, cond) => {
  assertions++
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-logloss'
const NODE = process.execPath
const MODEL = 'zai-coding-plan/glm-5.3-flash'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// The exact one-line format (the ticket's mandated wording):
//   LOG WRITE FAILED after <N> bytes at <path>: <err> — log evidence incomplete from this point
const LINE_RE = /^LOG WRITE FAILED after (\d+) bytes at (.*?): (Error: .+) — log evidence incomplete from this point$/

/** Assert the loss surface of one drive: exactly one line, exact format,
 *  naming the exact path, with the expected landed byte count. Returns the
 *  captured error string on success (for the caller's error-code pin). */
function expectOneLine(lines, logPath, expectedBytes, label) {
  if (!Array.isArray(lines) || lines.length !== 1) {
    t(`${label}: cleanupFailures carries exactly ONE line (got ${JSON.stringify(lines)})`, false)
    return null
  }
  const m = lines[0].match(LINE_RE)
  if (m === null) {
    t(`${label}: the line matches the exact T-053 format (got: ${JSON.stringify(lines[0])})`, false)
    return null
  }
  t(`${label}: exactly one line (first-failure-per-path)`, true)
  t(`${label}: the line names the exact path`, m[2] === logPath)
  t(`${label}: the byte count at failure is the landed-bytes count (${expectedBytes})`, Number(m[1]) === expectedBytes)
  return m[3]
}

async function main() {
  // ---------- A — the worker core, driven directly (the red-bar seam) ----------
  {
    const dir = join(sandbox, 'a-core')
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'worker.log')
    writeFileSync(logPath, '')

    // A1 — EISDIR: logPath is a DIRECTORY (the deterministic Windows
    // broken-log shape). On main: completes, exit 0, ZERO recorded trace.
    const eisdirPath = join(dir, 'eisdir-target')
    mkdirSync(eisdirPath, { recursive: true })
    const child = spawn(NODE, ['-e', 'process.stdout.write("A1-OUT\\n")'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const r = await runChildWithTimeout(child, { timeoutMs: 30_000, logPath: eisdirPath })
    t('A1: the run completes and never breaks (exit 0, no throw)', r.exitCode === 0 && r.timedOut === false)
    const err1 = expectOneLine(r.cleanupFailures, eisdirPath, 0, 'A1')
    t('A1: the recorded error is the appendFileSync failure (EISDIR on a directory path)', err1 !== null && err1.startsWith('Error: EISDIR: illegal operation on a directory'))

    // A2 — no-spam: many chunks after the first failure → still ONE line.
    const eisdirPath2 = join(dir, 'eisdir-target-many')
    mkdirSync(eisdirPath2, { recursive: true })
    const chatty = [
      'const b = Buffer.alloc(25, 0x61)',
      'let i = 0',
      'const tick = () => { process.stdout.write(b); if (++i < 40) setTimeout(tick, 15); else process.exit(0) }',
      'tick()',
    ].join('; ')
    const child2 = spawn(NODE, ['-e', chatty], { stdio: ['ignore', 'pipe', 'pipe'] })
    const r2 = await runChildWithTimeout(child2, { timeoutMs: 30_000, logPath: eisdirPath2 })
    t('A2: the chatty child completes (exit 0)', r2.exitCode === 0)
    const err2 = expectOneLine(r2.cleanupFailures, eisdirPath2, 0, 'A2')
    t('A2: the recorded error is EISDIR (every chunk write failed)', err2 !== null && err2.startsWith('Error: EISDIR: illegal operation on a directory'))

    // A3 — healthy path byte-identical: the log is exactly the child's
    // stdout + the exit line, and cleanupFailures is the empty array (the
    // pre-T-053 shape — nothing appears that did not appear before).
    const out = 'A3-FIRST-CHUNK\nA3-SECOND-CHUNK\n'
    const child3 = spawn(NODE, ['-e', 'process.stdout.write("A3-FIRST-CHUNK\\n"); setTimeout(() => process.stdout.write("A3-SECOND-CHUNK\\n"), 30)'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const r3 = await runChildWithTimeout(child3, { timeoutMs: 30_000, logPath })
    t('A3: the healthy run completes (exit 0)', r3.exitCode === 0)
    t('A3: cleanupFailures is the empty array (the pre-T-053 healthy shape)', Array.isArray(r3.cleanupFailures) && r3.cleanupFailures.length === 0)
    const healthyLog = readFileSync(logPath, 'utf8')
    t('A3: the log bytes are exactly the child stdout + the exit line (byte-identical healthy path)', healthyLog === `${out}\n$ exit code: 0\n`)
  }

  // ---------- B — the byte count at failure is the LANDED bytes ----------
  {
    const dir = join(sandbox, 'b-bytecount')
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'worker.log')
    const markerPath = join(dir, 'go.marker')
    const FIRST = 'B-FIRST-' + 'x'.repeat(20) // 28 bytes that LAND
    const SECOND = 'B-SECOND' // fails: the log is read-only by then
    const stub = join(dir, 'two-chunk-stub.js')
    writeFileSync(stub, [
      "const fs = require('node:fs')",
      'const [markerPath, first, second] = process.argv.slice(2)',
      'process.stdout.write(first)',
      'const deadline = Date.now() + 15000',
      'while (!fs.existsSync(markerPath)) { if (Date.now() > deadline) process.exit(7) }',
      'process.stdout.write(second)',
      'process.exit(0)',
      '',
    ].join('\n'))

    // Both chunks travel the REAL path (stdout → the core's drain is the
    // writer). Pre-create the log so the first append lands; the check polls
    // for chunk 1's bytes, then makes the log unwritable, then releases the
    // stub (polling handshake — deterministic, no sleep races).
    writeFileSync(logPath, '')
    const child = spawn(NODE, [stub, markerPath, FIRST, SECOND], { stdio: ['ignore', 'pipe', 'pipe'] })
    const call = runChildWithTimeout(child, { timeoutMs: 30_000, logPath })
    const deadline = Date.now() + 10_000
    let firstLanded = false
    while (Date.now() < deadline) {
      try {
        if (readFileSync(logPath, 'utf8') === FIRST) { firstLanded = true; break }
      } catch { /* not yet */ }
      await sleep(25)
    }
    t('B1: chunk 1 landed in the log (the handshake completed)', firstLanded)
    chmodSync(logPath, 0o444) // the mid-run loss: the path goes unwritable
    writeFileSync(markerPath, '') // release the stub → chunk 2 fails EPERM
    const r = await call
    chmodSync(logPath, 0o666) // restore so the sandbox sweep can remove it
    t('B1: the run completes despite the mid-run loss (exit 0)', r.exitCode === 0)
    const err = expectOneLine(r.cleanupFailures, logPath, Buffer.byteLength(FIRST), 'B1')
    t('B1: the recorded error is the appendFileSync failure (EPERM on the read-only log)', err !== null && err.startsWith('Error: EPERM: operation not permitted, open'))
  }

  // ---------- C — both adapters (stub drives, the Gate 1.17 precedent) ----------
  const driveMachine = async (logPath) => {
    const worker = new MachineWorker([NODE, '-e', 'console.log("machine-c-out")'])
    return worker.execute({
      prompt: 'machine brief (provenance only)',
      model: MODEL,
      cwd: sandbox,
      logPath,
      timeoutMs: 10_000,
    })
  }
  {
    const dir = join(sandbox, 'c-adapters')
    mkdirSync(dir, { recursive: true })

    // C1 — MachineWorker, logPath = a directory: the pre-run argv-line write
    // is the FIRST failure for the path; the core's drain/exit-line failures
    // for the same path add nothing; ok stays true.
    const eisdirPath = join(dir, 'machine-log-target')
    mkdirSync(eisdirPath, { recursive: true })
    const r1 = await driveMachine(eisdirPath)
    t('C1: MachineWorker completes and ok stays true (verdict bits from exit/time alone, exactly as today)', r1.ok === true && r1.exitCode === 0 && r1.timedOut === false)
    const err1 = expectOneLine(r1.cleanupFailures, eisdirPath, 0, 'C1')
    t('C1: the recorded error is EISDIR', err1 !== null && err1.startsWith('Error: EISDIR: illegal operation on a directory'))

    // C2 — OpenCodeWorker, logPath = a directory, node-as-harness stub
    // (`node run -m <model>` exits 1, no opencode binary, no tokens): the
    // same channel, the same exactly-one line, ok false / exit 1 EXACTLY as
    // today (the loss changes no verdict bit in either direction).
    const eisdirPath2 = join(dir, 'opencode-log-target')
    mkdirSync(eisdirPath2, { recursive: true })
    const worker = new OpenCodeWorker(NODE)
    const r2 = await worker.execute({
      prompt: 'stub prompt (no harness — the log-write seam is what is pinned)',
      model: MODEL,
      cwd: dir,
      logPath: eisdirPath2,
      timeoutMs: 10_000,
    })
    t('C2: OpenCodeWorker completes and the verdict bits are exactly today\'s (ok false, exit 1, not timed out)', r2.ok === false && r2.exitCode === 1 && r2.timedOut === false)
    const err2 = expectOneLine(r2.cleanupFailures, eisdirPath2, 0, 'C2')
    t('C2: the recorded error is EISDIR', err2 !== null && err2.startsWith('Error: EISDIR: illegal operation on a directory'))

    // C3 — MachineWorker healthy: NO cleanupFailures key on WorkerResult and
    // the log bytes are exactly header + stdout + exit line (byte-identical).
    const logPath = join(dir, 'machine-healthy.log')
    const r3 = await driveMachine(logPath)
    t('C3: healthy MachineWorker: ok true, exit 0', r3.ok === true && r3.exitCode === 0)
    t('C3: no cleanupFailures KEY appears on the healthy result (producer-only field)', !Object.prototype.hasOwnProperty.call(r3, 'cleanupFailures'))
    const command = [NODE, '-e', 'console.log("machine-c-out")']
    const header = [
      `$ machine ${JSON.stringify(command)}  (argv, list-form; never re-tokenized)`,
      `  model: ${MODEL} (ignored — a machine worker runs no model; the report records the configured string verbatim)`,
      '  brief (provenance only — never interpreted or executed by this worker):',
      'machine brief (provenance only)',
      '',
    ].join('\n')
    const log3 = readFileSync(logPath, 'utf8')
    t('C3: the healthy log is byte-identical (pre-run header + child stdout + exit line)',
      log3 === `${header}machine-c-out\n\n$ exit code: 0\n`)
  }

  // ---------- D — verdict inertness (source pins, the 1.12 S2 precedent) ----------
  {
    const runnerSrc = readFileSync(join(root, 'src', 'runner.ts'), 'utf8')
    t('D1: the ladder computes passedAllGates from gates.every(passed) + diffBytes alone (nothing reads the loss line)',
      /base\.passedAllGates = base\.gates\.length > 0 && base\.gates\.every\(\(g\) => g\.passed\) && base\.diffBytes > 0/.test(runnerSrc))
    t('D2: the runner\'s aggregation site pushes result.cleanupFailures into the evidence array only (evidence, never a verdict input)',
      /cleanupFailures\.push\(\.\.\.\(result\.cleanupFailures \?\? \[\]\)\)/.test(runnerSrc))
    const machineSrc = readFileSync(join(root, 'src', 'worker', 'machine.ts'), 'utf8')
    const opencodeSrc = readFileSync(join(root, 'src', 'worker', 'opencode.ts'), 'utf8')
    t('D3: BOTH adapters route their pre-run appendLog failures into the shared first-failure-per-path recorder',
      /noteWriteFailure\(/.test(machineSrc) && /noteWriteFailure\(/.test(opencodeSrc))
  }

  rmSync(sandbox, { recursive: true, force: true })
  console.log(`\n=== check-log-write-loss (Gate 1.39): ${failures.length === 0 ? `ALL GREEN (${assertions} assertions)` : `${failures.length} failure(s) of ${assertions}`} ===`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

main().then(
  () => { /* exitCode already set */ },
  (e) => {
    console.error(`FAIL: check threw: ${e?.stack ?? e}`)
    process.exit(1)
  },
)
