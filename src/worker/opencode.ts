import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import type { WorkerAdapter, WorkerExecutionRequest, WorkerResult } from '../types.js'
import { killTree } from '../kill-tree.js'

/**
 * Worker adapter for OpenCode in headless mode (`opencode run`).
 *
 * Spawns the real harness executable directly (no shell) so prompts with
 * spaces/quotes/pipe characters survive argv quoting intact. The model is
 * always passed explicitly; harness default-model resolution is never
 * relied upon, because defaults can silently point at models the active
 * credentials do not include.
 */
export class OpenCodeWorker implements WorkerAdapter {
  readonly id = 'opencode'

  constructor(private readonly binPath: string) {}

  execute(req: WorkerExecutionRequest): Promise<WorkerResult> {
    const started = Date.now()
    const args = ['run', '-m', req.model, req.prompt]
    appendLog(req.logPath, `$ opencode run -m ${req.model} <prompt: ${req.prompt.length} chars>\n`)

    const child = spawn(this.binPath, args, {
      cwd: req.cwd,
      // OpenCode resolves its project directory from env.PWD (a Unix-ism)
      // rather than the process cwd, so a spawned worker inherits the
      // *parent shell's* PWD and operates on the wrong repository. Pin the
      // working-directory env vars to the contracted cwd.
      env: { ...process.env, PWD: req.cwd, OLDPWD: req.cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // T-010: report the root pid to the engine the moment it exists (before
    // any hang), so startup reconciliation can find and verify it on disk
    // after a crash while execute() never resolves.
    if (child.pid !== undefined) req.onSpawn?.(child.pid)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, req.timeoutMs)

    const drained = Promise.all([
      collect(child.stdout, req.logPath),
      collect(child.stderr, req.logPath),
    ])

    const exitCode = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
      child.on('error', () => resolve(null))
    })

    return Promise.all([drained, exitCode]).then(([[stdout, stderr], code]) => {
      clearTimeout(timer)
      appendLog(req.logPath, `\n$ exit code: ${code}${timedOut ? ' (timed out, tree killed)' : ''}\n`)
      return {
        ok: !timedOut && code === 0,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        logPath: req.logPath,
        responseTail: stripAnsi(stdout + stderr).slice(-RESPONSE_TAIL_CHARS),
        pid: child.pid ?? null,
      }
    })
  }
}

const RESPONSE_TAIL_CHARS = 12_000

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

function collect(stream: Readable | null, logPath: string): Promise<string> {
  if (!stream) return Promise.resolve('')
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      appendFileSync(logPath, chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function appendLog(logPath: string, line: string): void {
  try {
    appendFileSync(logPath, line)
  } catch {
    // Logging must never break a run.
  }
}
