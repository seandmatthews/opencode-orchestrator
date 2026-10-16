import { existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CommandGate } from './gate/command.js'
import { acquireCheckoutLock, releaseCheckoutLock } from './lock.js'
import { runSkeleton } from './runner.js'
import { ingest } from './store/index.js'
import type { WorkerAdapter } from './types.js'
import { WorktreeProvider } from './workspace/worktree.js'
import { OpenCodeWorker } from './worker/opencode.js'

const usage = `Stage-0 walking skeleton: fan out N headless worker agents over isolated git
worktrees of one repo at one base SHA, then decide survival with machine gates.

Usage:
  npm run skeleton -- --repo <path> --goal "<text>" [options]

Options:
  --repo <path>            Target git repository (required)
  --goal "<text>"          What the candidates should implement (required)
  --model <id>             Worker-tier model ID passed for every candidate
                           (default: zai-coding-plan/glm-5.3-flash)
  --planner-model <id>     Planner-tier model ID that turns the goal into N
                           distinct briefs (default: zai-coding-plan/glm-5.3)
  --no-planner             Skip the planner; all candidates get the raw goal
  --reviewer-model <id>    Reviewer-tier model ID for advisory post-gate review
                           of passing candidates (default: zai-coding-plan/glm-5.3)
  --no-review              Skip the reviewer phase
  --worker <id>            Worker adapter (default: opencode)
  --candidates <n>         Number of candidates (default: 3)
  --concurrency <n>        Parallel lanes (default: same as candidates)
  --base <ref>             Base commit: branch or SHA (default: HEAD)
  --gate "name=command"    Machine gate; repeatable (e.g. --gate "build=node build.js")
  --run-root <path>        Where runs live (default: C:\\swarm)
  --force-lock             Take the checkout lock even if another (suspected-
                           stale) holder still owns it
  --db <path>              SQLite DB for durable run records (default:
                           C:\\swarm\\refinery.db)
  --timeout-min <n>        Per-worker wall-clock limit in minutes (default: 15)
  --max-attempts <n>       Retry a mechanically failed candidate (worker
                           non-zero exit/timeout or thrown error) as a fresh
                           attempt in a fresh worktree, up to n total
                           attempts per candidate (default: 1; values < 1
                           refused). Verdicts (no-op, gates-failed) are
                           never retried.
  --clean                  Dispose candidate workspaces after evidence capture
  --opencode-bin <path>    Override the opencode executable path

Artifacts per run: report.json, <candidate>/worker.log, <candidate>/diff.patch,
plus candidate workspaces under wt/ unless --clean. Exit code is 0 whenever the
run completes mechanically; the report carries the verdicts.`

interface Options {
  repo: string
  goal: string
  model: string
  plannerModel: string | null
  reviewerModel: string | null
  workerId: string
  candidates: number
  concurrency: number
  base: string
  runRoot: string
  forceLock: boolean
  db: string
  timeoutMs: number
  maxAttempts: number
  clean: boolean
  gates: { name: string; command: string }[]
  opencodeBin: string
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    repo: '',
    goal: '',
    model: 'zai-coding-plan/glm-5.3-flash',
    plannerModel: 'zai-coding-plan/glm-5.3',
    reviewerModel: 'zai-coding-plan/glm-5.3',
    workerId: 'opencode',
    candidates: 3,
    concurrency: 0,
    base: 'HEAD',
    runRoot: 'C:\\swarm',
    forceLock: false,
    db: 'C:\\swarm\\refinery.db',
    timeoutMs: 15 * 60_000,
    maxAttempts: 1,
    clean: false,
    gates: [],
    opencodeBin: '',
  }
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  opts.opencodeBin = join(projectRoot, 'node_modules', 'opencode-ai', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode')

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${arg}`)
      return v
    }
    switch (arg) {
      case '--repo': opts.repo = value(); break
      case '--goal': opts.goal = value(); break
      case '--model': opts.model = value(); break
      case '--planner-model': opts.plannerModel = value(); break
      case '--no-planner': opts.plannerModel = null; break
      case '--reviewer-model': opts.reviewerModel = value(); break
      case '--no-review': opts.reviewerModel = null; break
      case '--worker': opts.workerId = value(); break
      case '--candidates': opts.candidates = Number(value()); break
      case '--concurrency': opts.concurrency = Number(value()); break
      case '--base': opts.base = value(); break
      case '--run-root': opts.runRoot = value(); break
      case '--force-lock': opts.forceLock = true; break
      case '--db': opts.db = value(); break
      case '--timeout-min': opts.timeoutMs = Number(value()) * 60_000; break
      case '--max-attempts': {
        // Refused at parse time: parseArgs runs before repo validation, the
        // checkout lock, and any artifacts dir exists.
        const n = Number(value())
        if (!Number.isInteger(n) || n < 1) throw new Error(`--max-attempts expects an integer >= 1, got: ${argv[i]}`)
        opts.maxAttempts = n
        break
      }
      case '--clean': opts.clean = true; break
      case '--opencode-bin': opts.opencodeBin = value(); break
      case '--gate': {
        const spec = value()
        const eq = spec.indexOf('=')
        if (eq <= 0) throw new Error(`--gate expects "name=command", got: ${spec}`)
        opts.gates.push({ name: spec.slice(0, eq), command: spec.slice(eq + 1) })
        break
      }
      case '--help': case '-h': console.log(usage); process.exit(0)
      default: throw new Error(`unknown option: ${arg}\n\n${usage}`)
    }
  }

  if (!opts.repo || !opts.goal) throw new Error(`--repo and --goal are required\n\n${usage}`)
  if (!opts.concurrency) opts.concurrency = opts.candidates
  return opts
}

function createWorker(workerId: string, opts: Options): WorkerAdapter {
  switch (workerId) {
    case 'opencode':
      if (!existsSync(opts.opencodeBin)) {
        throw new Error(`opencode executable not found at ${opts.opencodeBin} — run: npm install`)
      }
      return new OpenCodeWorker(opts.opencodeBin)
    default:
      throw new Error(`unknown worker adapter '${workerId}' (available: opencode)`)
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

  opts.repo = opts.repo
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: opts.repo, stdio: 'ignore', windowsHide: true })
  } catch {
    throw new Error(`--repo '${opts.repo}' is not a git repository with at least one commit`)
  }

  // Cross-run checkout lock (T-004): held for the whole run, released on every
  // path. A refusal happens before any planner tokens are spent and before the
  // artifacts dir exists.
  const lockPath = acquireCheckoutLock(opts.runRoot, opts.repo, { cmd: 'run' }, opts.forceLock)
  try {
    await runPipeline(opts)
  } finally {
    releaseCheckoutLock(lockPath)
  }
}

async function runPipeline(opts: Options): Promise<void> {
  if (opts.gates.length === 0) {
    console.warn('warning: no --gate given; every candidate passes vacuously')
  }

  const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const artifactsDir = join(opts.runRoot, runId)
  mkdirSync(artifactsDir, { recursive: true })

  const baseSha = execFileSync('git', ['rev-parse', opts.base], { cwd: opts.repo, encoding: 'utf8', windowsHide: true }).trim()

  console.log(`run ${runId}: ${opts.candidates} candidates, concurrency ${opts.concurrency}`)
  console.log(`repo:     ${opts.repo} @ ${baseSha.slice(0, 12)}`)
  console.log(`planner:  ${opts.plannerModel ?? '(disabled — candidates get the raw goal)'}`)
  console.log(`reviewer: ${opts.reviewerModel ?? '(disabled)'}`)
  console.log(`workers:  ${opts.model} (worker: ${opts.workerId})`)
  console.log(`goal:     ${opts.goal}`)
  console.log(`artifacts: ${artifactsDir}`)
  console.log('')

  const report = await runSkeleton({
    runId,
    repo: opts.repo,
    baseSha,
    goal: opts.goal,
    model: opts.model,
    plannerModel: opts.plannerModel,
    reviewerModel: opts.reviewerModel,
    candidateIds: Array.from({ length: opts.candidates }, (_, i) => `c${String(i + 1).padStart(2, '0')}`),
    concurrency: opts.concurrency,
    timeoutMs: opts.timeoutMs,
    maxAttempts: opts.maxAttempts,
    gates: opts.gates.map((g) => new CommandGate(g.name, g.command)),
    worker: createWorker(opts.workerId, opts),
    workspaces: new WorktreeProvider(opts.repo, join(artifactsDir)),
    artifactsDir,
    cleanWorkspaces: opts.clean,
  })

  // Persistence records verdicts, never influences them: a failed DB write is
  // loud but must not change the run's exit code, stdout verdicts, or artifacts.
  try {
    ingest(report, opts.db)
  } catch (e) {
    console.error(`PERSISTENCE FAILED: run ${report.runId} was not recorded to ${opts.db}: ${e instanceof Error ? e.message : String(e)}`)
  }

  console.log('')
  console.log('=== RUN SUMMARY ===')
  for (const c of report.candidates) {
    const gateText = c.gates.length > 0
      ? c.gates.map((g) => `${g.name} ${g.passed ? 'PASS' : 'FAIL'}`).join(', ')
      : 'no gates'
    const verdict = c.error ? `ERROR (${c.error})` : !c.workerOk ? 'WORKER FAILED' : c.diffBytes === 0 ? 'NO-OP (no diff)' : c.passedAllGates ? 'PASS' : 'FAIL'
    const reviewText = c.review
      ? `  review:${c.review.ok ? `${c.review.observations.length} obs` : 'PARSE FAILED'}`
      : ''
    console.log(
      `${c.id}  worker:${c.workerOk ? 'ok' : 'failed'} ${(c.workerDurationMs / 1000).toFixed(0)}s` +
      `  diff:${(c.diffBytes / 1024).toFixed(1)}KiB  ${gateText} => ${verdict}${reviewText}`,
    )
  }
  console.log(`\nreport: ${join(artifactsDir, 'report.json')}`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
