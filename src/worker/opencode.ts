import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import type { WorkerAdapter, WorkerExecutionRequest, WorkerResult } from '../types.js'
import { runChildWithTimeout } from './run-with-timeout.js'

/**
 * Worker adapter for OpenCode in headless mode (`opencode run`).
 *
 * Spawns the real harness executable directly (no shell) so prompts with
 * spaces/quotes/pipe characters survive argv quoting intact. The model is
 * always passed explicitly; harness default-model resolution is never
 * relied upon, because defaults can silently point at models the active
 * credentials do not include.
 *
 * T-011: everything harness-agnostic about the timed run — log draining,
 * the verified process-tree kill at expiry, the exit wait — lives in
 * `runChildWithTimeout` (src/worker/run-with-timeout.ts, pinned token-free
 * by Gate 1.12 S4). This file keeps only the harness specifics: bin path,
 * `run -m <model>` args, the execution-policy translation (T-023), and the
 * PWD/OLDPWD pinning.
 *
 * T-023 (spec §14): a non-'worktree-write' `executionPolicy` translates to
 * the OpenCode built-in plan agent (`--agent plan`), verified first-hand
 * against the vendored opencode-ai 1.19.3: "Plan mode. Disallows all edit
 * tools." with permission rules `edit * → deny` (narrow plan-file allows).
 * The agent name is adapter-internal harness vocabulary — the engine stays
 * harness-agnostic (decisions.md 2026-10-10); there is deliberately no
 * restricted-agent CLI flag (T-023 carve). An adapter that cannot honor a
 * non-'worktree-write' policy must refuse the dispatch at spawn time, never
 * silently downgrade (§14.3:1039) — this one honors both restricted
 * postures, so nothing is refused.
 */
export class OpenCodeWorker implements WorkerAdapter {
  readonly id = 'opencode'

  constructor(private readonly binPath: string) {}

  async execute(req: WorkerExecutionRequest): Promise<WorkerResult> {
    const started = Date.now()
    // Absent policy ≡ 'worktree-write' (the pre-T-023 shape): existing
    // request sites and fake adapters compile and behave unchanged.
    const policy = req.executionPolicy ?? 'worktree-write'
    const args = policy === 'worktree-write'
      ? ['run', '-m', req.model, req.prompt]
      : ['run', '--agent', 'plan', '-m', req.model, req.prompt]
    // The log line reflects the ACTUAL argv (prompt elided), so
    // worker.log / planner.log / reviewer.log record the restriction.
    appendLog(req.logPath, `$ opencode ${args.slice(0, -1).join(' ')} <prompt: ${req.prompt.length} chars>\n`)

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

    // A second collector (no log writes — the helper owns the log) builds
    // the response tail from the same streams.
    let responseText = ''
    const tail = Promise.all([
      collectText(child.stdout),
      collectText(child.stderr),
    ]).then(([out, err]) => {
      responseText = out + err
    })

    const run = await runChildWithTimeout(child, { timeoutMs: req.timeoutMs, logPath: req.logPath })
    await tail

    return {
      ok: !run.timedOut && run.exitCode === 0,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: Date.now() - started,
      logPath: req.logPath,
      responseTail: stripAnsi(responseText).slice(-RESPONSE_TAIL_CHARS),
      pid: child.pid ?? null,
      ...(run.cleanupFailures.length > 0 ? { cleanupFailures: run.cleanupFailures } : {}),
    }
  }
}

const RESPONSE_TAIL_CHARS = 12_000

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
}

/** Response-tail collector only — no log writes (run-with-timeout owns the
 *  log); both collectors on a stream receive every chunk. */
function collectText(stream: Readable | null): Promise<string> {
  if (!stream) return Promise.resolve('')
  return new Promise((resolve) => {
    let text = ''
    stream.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
    })
    stream.on('end', () => resolve(text))
    stream.on('error', () => resolve(text))
  })
}

function appendLog(logPath: string, line: string): void {
  try {
    appendFileSync(logPath, line)
  } catch {
    // Logging must never break a run.
  }
}
