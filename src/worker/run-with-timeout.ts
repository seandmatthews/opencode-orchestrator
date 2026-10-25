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
  /**
   * T-053: the attempt-scoped log-write-loss recorder. One recorder spans
   * the adapter's pre-run log writes and this core's drain/appendLine
   * writes, so a broken log path yields exactly ONE loud line in the
   * attempt's cleanupFailures no matter how many writes fail. When omitted
   * the core creates its own (the direct-drive shape, Gate 1.12 S4 / Gate
   * 1.39 A/B legs).
   */
  logWriteLoss?: LogWriteLoss
}

export interface RunChildTimeoutResult {
  timedOut: boolean
  exitCode: number | null
  /** The loud `CLEANUP FAIL:` lines from the timeout kill (empty when the
   *  kill verified clean) plus, since T-053, the first-failure-per-path
   *  `LOG WRITE FAILED` lines when the log itself could not be written.
   *  Evidence only — never a verdict. */
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
 * T-053 (register R12) — log-write loss made loud, first-failure-per-path.
 * "Logging must never break a run" stays the posture (the swallow stays; this
 * records, it does not throw), but the loss is no longer SILENT: a full disk,
 * a locked file (antivirus/indexer holding a handle), or an unwritable path
 * used to yield a silently-empty worker.log that a human later read as "the
 * worker produced nothing" — indistinguishable from the no-op derailment
 * class, and worse than useless as forensics (worker.log is the primary
 * derailment-forensics artifact, VERIFICATION.md Known issue #6).
 *
 * One recorder per attempt (created by the adapter, or by this core when
 * driven directly): the FIRST failed append to a given path pushes exactly
 * one line into `lines` — `LOG WRITE FAILED after <N> bytes at <path>: <err>
 * — log evidence incomplete from this point` (N = the bytes that had actually
 * landed on the path; successes are counted so N is honest when a loss starts
 * mid-run) — and every subsequent failure for the same path adds nothing (no
 * spam from a chatty child on a broken path). The lines ride the existing
 * cleanupFailures channel (`WorkerResult.cleanupFailures` → the runner's
 * aggregation → `CandidateReport.cleanupFailures`, T-011): evidence only,
 * never a verdict — no ladder line, retry decision, or elimination path reads
 * them (decisions.md 2026-10-10: gates decide survival).
 */
export interface LogWriteLoss {
  /** The recorded first-failure-per-path lines, in failure order — empty on
   *  every healthy attempt (the producer-only pattern). */
  readonly lines: readonly string[]
  /** Count a successful append so the byte count at a LATER failure is the
   *  landed-bytes count, not always zero. */
  noteWriteSuccess(logPath: string, bytes: number): void
  /** Record a failed append; pushes the loud line only on the first failure
   *  for this path within the recorder's lifetime (one attempt). */
  noteWriteFailure(logPath: string, err: unknown): void
}

export function createLogWriteLoss(): LogWriteLoss {
  const lines: string[] = []
  const reported = new Set<string>()
  const landed = new Map<string, number>()
  return {
    lines,
    noteWriteSuccess(logPath, bytes) {
      landed.set(logPath, (landed.get(logPath) ?? 0) + bytes)
    },
    noteWriteFailure(logPath, err) {
      if (reported.has(logPath)) return
      reported.add(logPath)
      lines.push(
        `LOG WRITE FAILED after ${landed.get(logPath) ?? 0} bytes at ${logPath}: ${String(err)} — log evidence incomplete from this point`,
      )
    },
  }
}

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
 *
 * Since T-053 log-write failures are loud evidence, never silence: the FIRST
 * failed append to the log path pushes one `LOG WRITE FAILED after <N> bytes
 * at <path>: <err> — log evidence incomplete from this point` line into
 * `cleanupFailures` (see `LogWriteLoss`); later failures for the same path
 * add nothing, and the run still never breaks.
 */
export function runChildWithTimeout(child: ChildProcess, opts: RunChildTimeoutOptions): Promise<RunChildTimeoutResult> {
  let timedOut = false
  // T-053: the attempt-scoped log-write-loss recorder — shared with the
  // adapter when it passed one, owned here otherwise. Write-loss lines merge
  // into the returned cleanupFailures ahead of the kill evidence (they
  // chronologically precede it: drain failures on data events, kill lines at
  // expiry).
  const logWriteLoss = opts.logWriteLoss ?? createLogWriteLoss()
  const cleanupFailures: string[] = []
  const merged = () => [...logWriteLoss.lines, ...cleanupFailures]

  const drained = Promise.all([
    drain(child.stdout, opts.logPath, logWriteLoss),
    drain(child.stderr, opts.logPath, logWriteLoss),
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
      appendLine(opts.logPath, `${line}\n`, logWriteLoss)
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
      appendLine(opts.logPath, `${line}\n`, logWriteLoss)
      cleanupFailures.push(line)
      return
    }
    const r = killTreeVerified(child.pid)
    if (r.rootWasLive && r.verified) {
      appendLine(opts.logPath, `${killSuccessLine(r)}\n`, logWriteLoss)
    }
    for (const line of killFailureLines(child.pid, r)) {
      appendLine(opts.logPath, `${line}\n`, logWriteLoss)
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
      appendLine(opts.logPath, `\n$ exit code: null (timed out)\n`, logWriteLoss)
      return { timedOut: true, exitCode: null, cleanupFailures: merged() }
    }
    // The pre-T-011 `(timed out, tree killed)` claim is gone: the tree kill
    // is now its own verified line above, not an assertion glued to the exit
    // code.
    appendLine(opts.logPath, `\n$ exit code: ${outcome.code}${timedOut ? ' (timed out)' : ''}\n`, logWriteLoss)
    return { timedOut, exitCode: outcome.code, cleanupFailures: merged() }
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
function drain(stream: Readable | null, logPath: string, loss: LogWriteLoss): Promise<void> {
  if (!stream) return Promise.resolve()
  return new Promise((resolve) => {
    stream.on('data', (chunk: Buffer) => {
      try {
        appendFileSync(logPath, chunk)
        loss.noteWriteSuccess(logPath, chunk.length)
      } catch (err) {
        // Logging must never break a run — but since T-053 the loss is
        // recorded, not silent (first failure per path).
        loss.noteWriteFailure(logPath, err)
      }
    })
    stream.on('end', () => resolve())
    stream.on('error', () => resolve())
  })
}

function appendLine(logPath: string, text: string, loss: LogWriteLoss): void {
  try {
    appendFileSync(logPath, text)
    loss.noteWriteSuccess(logPath, Buffer.byteLength(text))
  } catch (err) {
    // Logging must never break a run — but since T-053 the loss is
    // recorded, not silent (first failure per path).
    loss.noteWriteFailure(logPath, err)
  }
}
