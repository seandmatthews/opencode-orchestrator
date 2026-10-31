import { exec } from 'node:child_process'
import type { Gate, GateResult } from '../types.js'
import { killFailureLines, killTreeVerified } from '../kill-tree.js'

const TAIL_BYTES = 4000

/**
 * A gate is a shell command evaluated in the candidate workspace:
 * exit 0 passes, anything else fails. No model judgment involved.
 *
 * T-011: this class owns its timeout and its process-tree kill. exec's
 * built-in `timeout` option is deliberately NOT used — it kills only the
 * direct shell child and orphans the whole subtree (the recorded red bar:
 * grandparent AND grandchild alive after an exec timeout). At expiry a
 * verified tree kill fires while the shell child lives
 * (`killTreeVerified(child.pid)`); kill outcomes that are not proven good
 * land on `GateResult.cleanupFailures` — evidence, never a verdict.
 */
export class CommandGate implements Gate {
  readonly name: string

  constructor(
    name: string,
    private readonly command: string,
    private readonly timeoutMs = 5 * 60_000,
  ) {
    this.name = name
  }

  run(cwd: string): Promise<GateResult> {
    const started = Date.now()
    return new Promise((resolve) => {
      let settled = false
      let timedOut = false
      let cleanupFailures: string[] = []
      // No `timeout` option here (see class doc); windowsHide/cwd/encoding/
      // maxBuffer are byte-identical to the pre-T-011 spawn options.
      const child = exec(
        this.command,
        { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          const output = `${stdout}\n${stderr}`.trim()
          // Timeout FAIL semantics stay exactly the pre-T-011 exec-timeout
          // shape: passed false, exitCode null (a killed shell carries no
          // meaningful numeric code), durationMs >= timeoutMs, outputTail as
          // collected.
          const exitCode = timedOut
            ? null
            : err === null ? 0 : typeof err.code === 'number' ? err.code : null
          resolve({
            name: this.name,
            passed: !timedOut && !err,
            exitCode,
            durationMs: Date.now() - started,
            outputTail: output.slice(-TAIL_BYTES),
            // T-027: the verdict carries a photograph of the command that
            // produced it — every resolve path (pass, fail, and timeout
            // alike: a killed shell still ran a known command).
            command: this.command,
            ...(cleanupFailures.length > 0 ? { cleanupFailures } : {}),
          })
        },
      )
      const timer = setTimeout(() => {
        timedOut = true
        // The ChildProcess knows its own exit before the exec callback
        // delivers it — never taskkill a shell that exited naturally at the
        // boundary (a just-exited or reused pid is not ours to kill). Its
        // stdio can still be held open by a pipe-holding descendant though,
        // which wedges the close-gated callback forever — end the streams
        // (the callback then delivers the partial output, T-065).
        if (child.exitCode !== null || child.signalCode !== null) {
          child.stdin?.destroy()
          child.stdout?.destroy()
          child.stderr?.destroy()
          return
        }
        if (child.pid === undefined) {
          cleanupFailures = ['CLEANUP FAIL: no root pid to kill for this gate']
          return
        }
        cleanupFailures = killFailureLines(child.pid, killTreeVerified(child.pid))
        // The kill is root-only off-Windows (KI#9): a surviving descendant
        // can hold exec's stdio open forever, wedging the close-gated
        // callback past the kill. The root is dead or dying; end the streams
        // so the timeout verdict resolves with the output collected so far.
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
      }, this.timeoutMs)
    })
  }
}
