import type { ChildProcess } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { killFailureLines, killSuccessLine, killTreeVerified } from '../kill-tree.js'

export interface RunChildTimeoutOptions {
  /** Hard wall-clock limit; at expiry the child's tree is killed AND the kill
   *  is verified (T-011, spec §15.3). */
  timeoutMs: number
  /** Absolute path of the file the child's stdout/stderr and the kill outcome
   *  are appended to. */
  logPath: string
}

export interface RunChildTimeoutResult {
  timedOut: boolean
  exitCode: number | null
  /** The loud `CLEANUP FAIL:` lines from the timeout kill; empty when the
   *  kill verified clean. Evidence only — never a verdict. */
  cleanupFailures: string[]
}

/**
 * The post-kill settle window (T-046): after the timeout fires at `timeoutMs`,
 * this is the LAST wait — if the child's close has not arrived by its expiry,
 * the run abandons the wait (loud `CLEANUP FAIL: ... abandoning the wait`
 * line) instead of hanging forever on a kill that could not finish the job
 * (an ACL-protected root, a descendant outside the `/T` tree, any survivor
 * holding an inherited stdio pipe). A documented constant, never a CLI knob
 * (the MAX_RETRY_FINDINGS precedent, src/runner.ts). 15s, not the ticket's
 * illustrative 60s: the verified kill itself completes synchronously before
 * the window is armed, close delivery after a verified kill is sub-second
 * (Gate 1.12 S4 observes ms), so 15s is a >10x margin — and the value keeps
 * the pinning gate's two abandonment faces at seconds each.
 */
export const KILL_SETTLE_WINDOW_MS = 15_000

/**
 * The harness-agnostic core of a timed worker run (T-011): drains the child's
 * stdout/stderr into the log, waits for exit, and at `timeoutMs` fires a
 * verified process-tree kill — alive check, pre-kill CIM snapshot, list-form
 * `taskkill /pid X /T /F`, post-kill verification (src/kill-tree.ts). The
 * outcome is appended to the log, never asserted: `tree killed, verified: N
 * processes reaped` on success, loud `CLEANUP FAIL: ...` lines otherwise.
 *
 * Since T-046 the post-expiry wait is bounded: expiry arms
 * `KILL_SETTLE_WINDOW_MS`, and a child that still has not settled (kill
 * survivors, or a pipe-holding escaper keeping close from ever firing)
 * resolves as an ABANDONED wait — `timedOut: true`, `exitCode: null`, the
 * abandonment line joining `cleanupFailures`, stdio destroyed so no handle
 * leaks keep the parent alive. Evidence, never a verdict: the run proceeds.
 *
 * Knows nothing about any harness — Gate 1.12's S4 drives it with a plain
 * node-spawned tree, token-free, no opencode binary. The adapter keeps only
 * the harness specifics (bin path, args, PWD/OLDPWD pinning).
 */
export function runChildWithTimeout(child: ChildProcess, opts: RunChildTimeoutOptions): Promise<RunChildTimeoutResult> {
  let timedOut = false
  const cleanupFailures: string[] = []

  const drained = Promise.all([
    drain(child.stdout, opts.logPath),
    drain(child.stderr, opts.logPath),
  ])
  const exitCode = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code))
    child.on('error', () => resolve(null))
  })
  const settled = Promise.all([drained, exitCode]).then(
    ([, code]) => ({ kind: 'settled' as const, code }),
  )
  // The T-046 abandonment resolver: stays pending until the settle window
  // below overruns; a healthy close settles the race first and clears the
  // settle timer, so this never fires on the normal path.
  let settleAbandon: () => void
  const settleDeadline = new Promise<{ kind: 'abandoned' }>((resolve) => {
    settleAbandon = () => resolve({ kind: 'abandoned' })
  })
  let settleTimer: NodeJS.Timeout | undefined
  // Set the moment the race below resolves: a settle callback already queued
  // in the same tick must not append evidence after the result returned (the
  // cleanupFailures array is shared by reference) — the probe core's
  // `if (settled) return` guard, same rule.
  let finished = false

  const timer = setTimeout(() => {
    timedOut = true
    // The settle window is armed at expiry in EVERY branch (kill-fired or
    // not): a child that already exited can still wedge the wait through a
    // pipe-holding descendant, and that shape gets no kill at all.
    settleTimer = setTimeout(() => {
      if (finished) return
      const line = `CLEANUP FAIL: child did not settle ${KILL_SETTLE_WINDOW_MS / 1000}s after verified tree kill — abandoning the wait (evidence follows in the log)`
      appendLine(opts.logPath, `${line}\n`)
      cleanupFailures.push(line)
      destroyStream(child.stdout)
      destroyStream(child.stderr)
      settleAbandon()
    }, KILL_SETTLE_WINDOW_MS)
    // The ChildProcess knows its own exit before the exit event delivers it:
    // never taskkill a child that exited naturally at the boundary.
    if (child.exitCode !== null || child.signalCode !== null) return
    if (child.pid === undefined) {
      const line = 'CLEANUP FAIL: no root pid was recorded for the timed-out child'
      appendLine(opts.logPath, `${line}\n`)
      cleanupFailures.push(line)
      return
    }
    const r = killTreeVerified(child.pid)
    if (r.rootWasLive && r.verified) {
      appendLine(opts.logPath, `${killSuccessLine(r)}\n`)
    }
    for (const line of killFailureLines(child.pid, r)) {
      appendLine(opts.logPath, `${line}\n`)
      cleanupFailures.push(line)
    }
  }, opts.timeoutMs)

  return Promise.race([settled, settleDeadline]).then((outcome) => {
    finished = true
    clearTimeout(timer)
    if (settleTimer !== undefined) clearTimeout(settleTimer)
    if (outcome.kind === 'abandoned') {
      // The close never delivered an exit code — null, never a guess. The
      // abandonment line above is the evidence; the run proceeds.
      appendLine(opts.logPath, `\n$ exit code: null (timed out)\n`)
      return { timedOut: true, exitCode: null, cleanupFailures }
    }
    // The pre-T-011 `(timed out, tree killed)` claim is gone: the tree kill
    // is now its own verified line above, not an assertion glued to the exit
    // code.
    appendLine(opts.logPath, `\n$ exit code: ${outcome.code}${timedOut ? ' (timed out)' : ''}\n`)
    return { timedOut, exitCode: outcome.code, cleanupFailures }
  })
}

/** T-046: stream teardown on abandonment — a destroyed read end releases the
 * parent's pipe handles, so nothing an escaper keeps open outlives the wait. */
function destroyStream(stream: Readable | null): void {
  try {
    stream?.destroy()
  } catch {
    // Already gone — nothing left to release.
  }
}

/** stdout/stderr land in the log exactly as the adapter's collector did —
 *  raw chunk appends; logging must never break a run. */
function drain(stream: Readable | null, logPath: string): Promise<void> {
  if (!stream) return Promise.resolve()
  return new Promise((resolve) => {
    stream.on('data', (chunk: Buffer) => {
      try {
        appendFileSync(logPath, chunk)
      } catch {
        // Logging must never break a run.
      }
    })
    stream.on('end', () => resolve())
    stream.on('error', () => resolve())
  })
}

function appendLine(logPath: string, text: string): void {
  try {
    appendFileSync(logPath, text)
  } catch {
    // Logging must never break a run.
  }
}
