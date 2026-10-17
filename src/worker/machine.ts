import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import type { WorkerAdapter, WorkerExecutionRequest, WorkerResult } from '../types.js'
import { runChildWithTimeout } from './run-with-timeout.js'

/**
 * MachineWorker (T-017, spec §4:186-187, §5.3:254-273, §11:851-859,
 * §34:2030-2033): a WorkerAdapter that executes a brief by running one
 * configured deterministic command (an argv list) directly in the leased
 * worktree — no external agent harness, no model tokens, no shell.
 *
 * Reconciliations (required, so the seams do not blur):
 *
 * - *Worker vs probe.* This adapter runs PRE-gates: its file effects ARE the
 *   candidate diff (captured engine-side, src/runner.ts) and its exit code
 *   drives `workerOk`/retry. A CommandProbe (src/probe.ts, T-015) runs
 *   POST-gates on the final attempt, produces an EvidenceBundle, and never
 *   enters a verdict nor produces a diff. §5.3's evidence-flavored tasks
 *   (tests, benchmarks, screenshots) stay probe-layer successors; this
 *   adapter is the §5.3 deterministic-command leg that produces candidate
 *   WORK.
 * - *§11's fuller contract.* §11:845-847's `capabilities()`/`cancel()` are
 *   deliberately NOT implemented: the seam stays `id` + `execute`
 *   (src/types.ts); termination is onSpawn/pid + T-011's verified kill
 *   (the T-011 carve).
 *
 * Honest about the fields a machine worker cannot mean: `req.prompt` (the
 * composed brief, src/runner.ts) is logged to `logPath` as a provenance
 * header and never interpreted or executed; `req.model` is ignored — the
 * report/store keep recording the per-job/run model string verbatim
 * (CandidateReport.model, src/types.ts) for a candidate no model touched.
 * Documented here, not smoothed over.
 *
 * cwd by mechanism: the spawn cwd IS the working directory. No `PWD`/`OLDPWD`
 * pinning — VERIFICATION.md Known issue #1 is an OpenCode env-resolution
 * quirk, not a spawn-semantics fact: a plainly spawned child resolves its
 * working directory from its spawn cwd, never from `env.PWD` (which a child
 * merely inherits). Gate 1.17 S1 asserts the child's real `process.cwd()`.
 *
 * The timed run goes through the harness-agnostic core `runChildWithTimeout`
 * (src/worker/run-with-timeout.ts, pinned token-free by Gate 1.12 S4): log
 * draining, the verified process-tree kill at expiry, `cleanupFailures`
 * passthrough (src/types.ts). This file keeps only the specifics: the argv.
 */
export class MachineWorker implements WorkerAdapter {
  readonly id = 'machine'

  /** The argv. Spawn is list-form, never through a shell (AGENTS.md #4);
   *  the command is never re-tokenized from a string. */
  constructor(private readonly command: string[]) {}

  async execute(req: WorkerExecutionRequest): Promise<WorkerResult> {
    const started = Date.now()
    appendLog(req.logPath, [
      `$ machine ${JSON.stringify(this.command)}  (argv, list-form; never re-tokenized)`,
      `  model: ${req.model} (ignored — a machine worker runs no model; the report records the configured string verbatim)`,
      '  brief (provenance only — never interpreted or executed by this worker):',
      req.prompt,
      '',
    ].join('\n'))

    const child = spawn(this.command[0]!, this.command.slice(1), {
      cwd: req.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    // T-010: report the root pid to the engine the moment it exists (before
    // any hang), so startup reconciliation can find and verify it on disk
    // after a crash while execute() never resolves. The same pid is returned
    // as WorkerResult.pid below.
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
