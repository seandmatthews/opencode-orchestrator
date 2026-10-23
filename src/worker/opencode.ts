import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import type { WorkerAdapter, WorkerExecutionRequest, WorkerResult } from '../types.js'
import { runChildWithTimeout } from './run-with-timeout.js'

/**
 * Worker adapter for OpenCode in headless mode (`opencode run`).
 *
 * Spawns the real harness executable directly (no shell) so model names and
 * flag values survive argv quoting intact. The model is always passed
 * explicitly; harness default-model resolution is never relied upon, because
 * defaults can silently point at models the active credentials do not
 * include.
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
 *
 * T-042: the prompt NEVER rides argv. Windows caps the whole spawned command
 * line at 32,767 UTF-16 chars and Node's spawn throws ENAMETOOLONG
 * synchronously above it (pinned by Gate 1.28's C0 leg, the recorded red
 * bar) — the composed gate-retry brief (30K diff cap + 12K summary + gate
 * tails + findings, src/runner.ts) crosses that routinely, killing the
 * T-038/T-040 retry exactly when it has real feedback to carry. The prompt
 * streams over STDIN instead: the vendored harness (opencode-ai 1.19.3) was
 * probed first-hand (scripts/diag-stdin.mjs, the diag-pwd.mjs precedent)
 * and reads piped stdin as the message when no message positional is given
 * (observed 2026-10-23: exact marker reply, exit 0). A side benefit: no
 * goal, brief, or retry-diff bytes are visible to local process listings.
 * The argv log line still records the actual spawn shape with the prompt
 * elided; PWD/OLDPWD pinning, responseTail collection, onSpawn, and the
 * timeout/kill path (`runChildWithTimeout` untouched) are unchanged.
 */
export class OpenCodeWorker implements WorkerAdapter {
  readonly id = 'opencode'

  constructor(private readonly binPath: string) {}

  async execute(req: WorkerExecutionRequest): Promise<WorkerResult> {
    const started = Date.now()
    // Absent policy ≡ 'worktree-write' (the pre-T-023 shape): existing
    // request sites and fake adapters compile and behave unchanged.
    const policy = req.executionPolicy ?? 'worktree-write'
    // T-042: no prompt positional — the prompt travels over stdin (see the
    // class docblock). The log line reflects the ACTUAL argv (prompt elided,
    // size recorded in the `<prompt: N chars>` marker, byte-identical to the
    // pre-T-042 format so existing log consumers — Gate 2's round-growth
    // regex — read it unchanged), so worker.log / planner.log /
    // reviewer.log record the restriction and the prompt's size without its
    // bytes.
    const args = policy === 'worktree-write'
      ? ['run', '-m', req.model]
      : ['run', '--agent', 'plan', '-m', req.model]
    appendLog(req.logPath, `$ opencode ${args.join(' ')} <prompt: ${req.prompt.length} chars>\n`)

    const child = spawn(this.binPath, args, {
      cwd: req.cwd,
      // OpenCode resolves its project directory from env.PWD (a Unix-ism)
      // rather than the process cwd, so a spawned worker inherits the
      // *parent shell's* PWD and operates on the wrong repository. Pin the
      // working-directory env vars to the contracted cwd.
      env: { ...process.env, PWD: req.cwd, OLDPWD: req.cwd },
      // T-042: stdin is the prompt transport (piped + fed below).
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // T-010: report the root pid to the engine the moment it exists (before
    // any hang), so startup reconciliation can find and verify it on disk
    // after a crash while execute() never resolves.
    if (child.pid !== undefined) req.onSpawn?.(child.pid)

    // T-042: stream the prompt out-of-band. `end()` never blocks the event
    // loop — Node buffers whatever the child has not read yet, so a prompt
    // of any size drains as the harness consumes it. A harness that exits
    // without draining stdin emits EPIPE here; swallowed on purpose: the
    // exit path (runChildWithTimeout) owns the outcome, and a write error
    // must never masquerade as a worker failure (the listener is required —
    // an unhandled 'error' on a stream would crash the run).
    child.stdin.on('error', () => {})
    child.stdin.end(req.prompt, 'utf8')

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
