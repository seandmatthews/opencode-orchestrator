import { exec } from 'node:child_process'
import type { Gate, GateResult } from '../types.js'

const TAIL_BYTES = 4000

/**
 * A gate is a shell command evaluated in the candidate workspace:
 * exit 0 passes, anything else fails. No model judgment involved.
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
      exec(
        this.command,
        { cwd, timeout: this.timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const output = `${stdout}\n${stderr}`.trim()
          const exitCode = err === null ? 0 : typeof err.code === 'number' ? err.code : null
          resolve({
            name: this.name,
            passed: !err,
            exitCode,
            durationMs: Date.now() - started,
            outputTail: output.slice(-TAIL_BYTES),
          })
        },
      )
    })
  }
}
