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
 * The harness-agnostic core of a timed worker run (T-011): drains the child's
 * stdout/stderr into the log, waits for exit, and at `timeoutMs` fires a
 * verified process-tree kill — alive check, pre-kill CIM snapshot, list-form
 * `taskkill /pid X /T /F`, post-kill verification (src/kill-tree.ts). The
 * outcome is appended to the log, never asserted: `tree killed, verified: N
 * processes reaped` on success, loud `CLEANUP FAIL: ...` lines otherwise.
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

  const timer = setTimeout(() => {
    timedOut = true
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

  return Promise.all([drained, exitCode]).then(([, code]) => {
    clearTimeout(timer)
    // The pre-T-011 `(timed out, tree killed)` claim is gone: the tree kill
    // is now its own verified line above, not an assertion glued to the exit
    // code.
    appendLine(opts.logPath, `\n$ exit code: ${code}${timedOut ? ' (timed out)' : ''}\n`)
    return { timedOut, exitCode: code, cleanupFailures }
  })
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
