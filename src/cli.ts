import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CommandGate } from './gate/command.js'
import { acquireCheckoutLock, releaseCheckoutLock } from './lock.js'
import { createProbe } from './probe.js'
import { runSkeleton } from './runner.js'
import type { ResolvedJob } from './runner.js'
import { parseJobsSpec, commandPairingRefusal } from './scheduler.js'
import type { JobsSpec } from './scheduler.js'
import { ingest } from './store/index.js'
import type { GateResult, WorkerAdapter } from './types.js'
import { WorktreeProvider } from './workspace/worktree.js'
import { OpenCodeWorker } from './worker/opencode.js'
import { MachineWorker } from './worker/machine.js'

const usage = `Stage-0 walking skeleton: fan out N headless worker agents over isolated git
worktrees of one repo at one base SHA, then decide survival with machine gates.

Usage:
  npm run skeleton -- --repo <path> --goal "<text>" [options]
  npm run skeleton -- --repo <path> --jobs <spec.json> [options]

Options:
  --repo <path>            Target git repository (required)
  --goal "<text>"          What the candidates should implement (required
                           without --jobs)
  --jobs <path>            Run a validated job spec (JSON: phases + jobs,
                           see src/scheduler.ts) instead of planner briefs:
                           deterministic DAG-driven dispatch under
                           --concurrency, one candidate per job, per-job
                           model/worker/command/timeoutMs/gates defaulting
                           to the run-level flags. --goal is not required;
                           --candidates and the planner are ignored.
                           Spec refusals exit 1 before the checkout lock,
                           repo validation, or any artifacts dir exists.
  --model <id>             Worker-tier model ID passed for every candidate
                           (default: zai-coding-plan/glm-5.3-flash)
  --planner-model <id>     Planner-tier model ID that turns the goal into N
                           distinct briefs (default: zai-coding-plan/glm-5.3)
  --no-planner             Skip the planner; all candidates get the raw goal
  --no-planner-context     Omit the planner repo digest (T-059). Default ON:
                           a deterministic file-tree/manifest digest of the
                           TARGET repo at the run's base commit (git ls-tree
                           order, forward-slash paths, package.json
                           name/version; capped by documented constants with
                           loud truncation lines) rides the planner prompt of
                           BOTH rounds as context — bytes, never access: the
                           planner's scratch cwd and capability posture are
                           unchanged. Evidence: planner-digest.txt under the
                           run artifacts dir, its sha256 in report.json.
                           Inert in --jobs/--no-planner runs (no planner).
  --reviewer-model <id>    Reviewer-tier model ID for advisory post-gate review
                           of passing candidates (default: zai-coding-plan/glm-5.3)
  --no-review              Skip the reviewer phase
  --verifier-model <id>    Verifier-tier model ID for active pre-disposition
                           verification (T-039): after the gates and probes, on
                           every candidate whose final attempt completed — gate
                           outcome regardless — the verifier runs NEW checks in
                           the candidate worktree and records findings (with the
                           commands it ran) under each candidate's "verifier"
                           report block. Findings, never verdicts. Off unless
                           given (no default model).
  --verifier-worker <id>   Adapter for the verifier role (default: the --worker
                           value). "machine" requires --verifier-command.
                           Applies in both --goal and --jobs mode.
  --verifier-command <json>
                           The machine command for a verifier resolved to
                           "machine" — a JSON argv list. Refused on a
                           verifier resolving to "opencode".
  --worker <id>            Worker adapter (default: opencode). "machine"
                           (T-017) is per-job only — a --jobs spec's
                           worker+command fields; run-level --worker machine
                           is refused at parse time. This id is also the
                           default adapter for the planner and reviewer
                           roles (see --planner-worker/--reviewer-worker).
  --planner-worker <id>    Adapter for the planner role (default: the --worker
                           value). "machine" requires --planner-command.
  --reviewer-worker <id>   Adapter for the reviewer role (default: the --worker
                           value). "machine" requires --reviewer-command.
                           Applies in both --goal and --jobs mode.
  --planner-command <json> The machine command for a planner resolved to
                           "machine" — a JSON argv list (e.g.
                           '["node","scripts/task.js"]', never a shell
                           string). Refused on a planner resolving to
                           "opencode". Accepted but ignored in --jobs mode
                           (the planner is skipped there — the
                           --planner-model precedent).
  --reviewer-command <json>
                           The machine command for a reviewer resolved to
                           "machine" — a JSON argv list. Refused on a
                           reviewer resolving to "opencode".
  --candidates <n>         Number of candidates (default: 3)
  --rounds <n>             Bounded R&D loop rounds (T-030; default: 1 = the
                           single-pass behavior exactly). 2 = round 1's gate
                           survivors are composed (src/rounds.ts) into the
                           round-2 planner prompt and a fresh candidate wave
                           (ids <survivorId>-r2, same base SHA) repeats the
                           mechanics; report.json gains an additive "rounds"
                           block. Values outside 1..2, non-integers, and
                           --rounds 2 combined with --jobs or --no-planner
                           are refused before the checkout lock, repo
                           validation, or any artifacts dir exists.
  --concurrency <n>        Parallel lanes (default: same as candidates)
  --base <ref>             Base commit: branch or SHA (default: HEAD)
  --gate "name=command"    Machine gate; repeatable with UNIQUE names — a repeated
                           name refuses at parse time, before any side effect
                           (e.g. --gate "build=node build.js")
  --run-root <path>        Where runs live (default: C:\\swarm)
  --force-lock             Take the checkout lock even if another (suspected-
                           stale) holder still owns it
  --allow-red-base         Proceed over a base whose own gates fail (T-043).
                           Before any dispatch the run leases one worktree at
                           the base SHA and proves every distinct gate the
                           run will use green on that untouched tree; a red
                           base refuses before any planner/worker tokens are
                           spent. This flag is the one explicit human
                           override (the --force-lock posture, not a knob):
                           with it the run proceeds and the red-base evidence
                           rides <runDir>/baseline-check.json.
  --db <path>              SQLite DB for durable run records (default:
                           C:\\swarm\\refinery.db)
  --timeout-min <n>        Per-worker wall-clock limit in minutes (default: 15)
  --max-attempts <n>       Retry a mechanically failed candidate (worker
                           non-zero exit/timeout or thrown error) as a fresh
                           attempt in a fresh worktree, up to n total
                           attempts per candidate (default: 1; values < 1
                           refused). Mechanical failures only; verdicts are
                           never blindly re-rolled (--gate-retry adds the
                           one bounded exception).
  --gate-retry             Grant each candidate EXACTLY ONE extra attempt
                           when its worker succeeded but the machine gates
                           rejected the change (T-038): the retry brief is
                           composed mechanically from the gates' own
                           recorded output (name, command, output tail)
                           plus the captured diff, and the same gates re-run
                           unchanged on the retry. Blind re-rolls stay
                           banned: zero-byte diffs, no-gates candidates, and
                           failed diff captures are never retried, and a
                           retry that fails again is eliminated by the
                           unchanged ladder. Total attempts per candidate <=
                           --max-attempts + 1. The report's retried
                           candidates carry an additive "gateRetry" block.
  --clean                  Dispose candidate workspaces after evidence capture
  --opencode-bin <path>    Override the opencode executable path

Artifacts per run: report.json, <candidate>/worker.log, <candidate>/diff.patch,
plus candidate workspaces under wt/ unless --clean. Exit code is 0 whenever the
run completes mechanically; the report carries the verdicts.`

interface Options {
  repo: string
  goal: string
  /** Path to a --jobs spec file; empty string = default (planner) mode. */
  jobs: string
  model: string
  plannerModel: string | null
  reviewerModel: string | null
  /** T-039: the verifier role is opt-in — null (the default) skips it. */
  verifierModel: string | null
  /** T-039: per-role adapter id; null until defaulted to `workerId` in main(). */
  verifierWorkerId: string | null
  /** T-039: the verifier's machine command source (a JSON argv). */
  verifierCommand: string[] | null
  workerId: string
  /** T-025: per-role adapter ids; null until defaulted to `workerId` in main(). */
  plannerWorkerId: string | null
  reviewerWorkerId: string | null
  /** T-025: the advisory roles' machine command sources (a JSON argv). */
  plannerCommand: string[] | null
  reviewerCommand: string[] | null
  candidates: number
  /** T-030 bounded R&D loop rounds; 1 = today's single-pass behavior. */
  rounds: number
  /** T-059: the planner repo digest rides the planner prompts. Default ON
   *  (--no-planner-context opts out, the --no-planner/--no-review idiom);
   *  always passed through to runSkeleton, whose seam treats false as
   *  today's exact prompt bytes. */
  plannerContext: boolean
  concurrency: number
  base: string
  runRoot: string
  forceLock: boolean
  /** T-043: the one explicit human override of a red baseline check. */
  allowRedBase: boolean
  db: string
  timeoutMs: number
  maxAttempts: number
  /** T-038: the one bounded feedback-informed gate retry per candidate. */
  gateRetry: boolean
  clean: boolean
  gates: { name: string; command: string }[]
  opencodeBin: string
}

/** T-025: parse + shape-validate an advisory role's machine command at parse
 *  time — a JSON-encoded argv list, mirroring the scheduler's `command` shape
 *  rules (src/scheduler.ts: a non-empty array of non-empty strings; the
 *  command is never re-tokenized from a shell string, AGENTS.md #4). */
function parseCommandArgv(flag: string, raw: string): string[] {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${flag} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!Array.isArray(decoded) || decoded.length === 0
    || decoded.some((c) => typeof c !== 'string' || c.length === 0)) {
    throw new Error(`${flag} must be a JSON argv list — a non-empty array of non-empty strings (e.g. '["node", "scripts/task.js"]' — never a shell string)`)
  }
  return decoded as string[]
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    repo: '',
    goal: '',
    jobs: '',
    model: 'zai-coding-plan/glm-5.3-flash',
    plannerModel: 'zai-coding-plan/glm-5.3',
    reviewerModel: 'zai-coding-plan/glm-5.3',
    verifierModel: null,
    verifierWorkerId: null,
    verifierCommand: null,
    workerId: 'opencode',
    plannerWorkerId: null,
    reviewerWorkerId: null,
    plannerCommand: null,
    reviewerCommand: null,
    candidates: 3,
    rounds: 1,
    plannerContext: true,
    concurrency: 0,
    base: 'HEAD',
    runRoot: 'C:\\swarm',
    forceLock: false,
    allowRedBase: false,
    db: 'C:\\swarm\\refinery.db',
    timeoutMs: 15 * 60_000,
    maxAttempts: 1,
    gateRetry: false,
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
      case '--jobs': opts.jobs = value(); break
      case '--model': opts.model = value(); break
      case '--planner-model': opts.plannerModel = value(); break
      case '--no-planner': opts.plannerModel = null; break
      // T-059: the repo digest's opt-out (default ON above; the
      // --no-planner/--no-review boolean idiom — a bare flag, never a knob).
      case '--no-planner-context': opts.plannerContext = false; break
      case '--reviewer-model': opts.reviewerModel = value(); break
      case '--no-review': opts.reviewerModel = null; break
      case '--verifier-model': opts.verifierModel = value(); break
      case '--verifier-worker': opts.verifierWorkerId = value(); break
      case '--verifier-command': opts.verifierCommand = parseCommandArgv('--verifier-command', value()); break
      case '--worker': {
        const id = value()
        // T-017: `machine` is refused at run level, at parse time (the
        // --max-attempts refusal pattern): the planner and reviewer phases
        // execute through the run-level worker (src/runner.ts) and no
        // machine command exists for them. Machine selection is per-job, in
        // a --jobs spec's worker+command fields.
        if (id === 'machine') {
          throw new Error(`--worker machine is not valid at run level — the planner and reviewer phases run through the run-level worker and have no machine command; select machine per job in a --jobs spec (worker: "machine" + command)`)
        }
        opts.workerId = id
        break
      }
      case '--planner-worker': opts.plannerWorkerId = value(); break
      case '--reviewer-worker': opts.reviewerWorkerId = value(); break
      case '--planner-command': opts.plannerCommand = parseCommandArgv('--planner-command', value()); break
      case '--reviewer-command': opts.reviewerCommand = parseCommandArgv('--reviewer-command', value()); break
      case '--candidates': opts.candidates = Number(value()); break
      case '--rounds': {
        // T-030: refused at parse time — parseArgs runs before repo
        // validation, the checkout lock, and any artifacts dir exists (the
        // --max-attempts zero-side-effects refusal pattern). Bounded 1..2
        // this slice: the loop is capped at one feedback round.
        const n = Number(value())
        if (!Number.isInteger(n) || n < 1 || n > 2) {
          throw new Error(`--rounds expects an integer between 1 and 2 (the loop is capped at one feedback round this slice), got: ${argv[i]}`)
        }
        opts.rounds = n
        break
      }
      case '--concurrency': opts.concurrency = Number(value()); break
      case '--base': opts.base = value(); break
      case '--run-root': opts.runRoot = value(); break
      case '--force-lock': opts.forceLock = true; break
      case '--allow-red-base':
        // T-043: a run-level boolean override — the --force-lock posture (a
        // named human override, not a knob). Parsed here so the whole argv is
        // read first; the check itself runs after baseSha resolution, under
        // the checkout lock, before runSkeleton.
        opts.allowRedBase = true
        break
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
      case '--gate-retry':
        // T-038: a run-level boolean — no numeric knob (the RetryPolicy
        // carve posture, src/types.ts). Accepted in every mode: --jobs
        // rides the same runJob per job, --no-planner composes from the
        // raw goal, and the retry lives inside each round's ladder.
        opts.gateRetry = true
        break
      case '--clean': opts.clean = true; break
      case '--opencode-bin': opts.opencodeBin = value(); break
      case '--gate': {
        const spec = value()
        const eq = spec.indexOf('=')
        if (eq <= 0) throw new Error(`--gate expects "name=command", got: ${spec}`)
        // T-057: a repeated --gate name refuses at parse time. The store's
        // gate_results is keyed (run_id, candidate_id, gate_name) with a
        // last-write-wins upsert, so a same-named pair would record only
        // the LAST verdict while report.json carried both. Zero side
        // effects: this fires before repo validation, the checkout lock,
        // and any artifacts dir (the --max-attempts parse-refusal
        // pattern).
        const name = spec.slice(0, eq)
        if (opts.gates.some((g) => g.name === name)) {
          throw new Error(`duplicate --gate name '${name}' — gate names must be unique per run (the store keeps one verdict per name; every verdict but the last would be silently dropped)`)
        }
        opts.gates.push({ name, command: spec.slice(eq + 1) })
        break
      }
      case '--help': case '-h': console.log(usage); process.exit(0)
      default: throw new Error(`unknown option: ${arg}\n\n${usage}`)
    }
  }

  // T-030: the loop's round-2 needs a planner phase to feed. Both
  // combinations are refused at parse time — before repo validation, the
  // checkout lock, or any artifacts dir exists (zero side effects; the whole
  // argv is read first, so flag order never matters).
  if (opts.rounds >= 2 && opts.jobs) {
    throw new Error('--rounds 2 requires planner mode — a --jobs run drives a fixed DAG and has no planner phase to feed survivor evidence into')
  }
  if (opts.rounds >= 2 && opts.plannerModel === null) {
    throw new Error('--rounds 2 requires the planner — --no-planner leaves no planning phase to feed round-1 survivor evidence into')
  }

  if (!opts.repo) throw new Error(`--repo is required\n\n${usage}`)
  if (!opts.goal && !opts.jobs) throw new Error(`--goal (or --jobs) is required\n\n${usage}`)
  return opts
}

/** Read + decode + validate the --jobs spec. Called from main() BEFORE repo
 *  validation and the checkout lock (the T-007 --max-attempts parse-refusal
 *  pattern): a bad spec must cost zero side effects — no artifacts dir, no
 *  lock, no repo access. */
function loadJobsSpec(path: string): JobsSpec {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`--jobs file not found: ${path}`)
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (e) {
    throw new Error(`--jobs ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  return parseJobsSpec(decoded)
}

/** Bind the parsed spec to run-level defaults and adapter/gate objects. */
function resolveJobs(jobsSpec: JobsSpec, opts: Options): ResolvedJob[] {
  const workers = new Map<string, WorkerAdapter>()
  // T-017: the cache keys by adapter id + serialized command, so two machine
  // jobs with identical commands share one instance and distinct commands
  // get distinct instances (pinned behaviorally by Gate 1.17 S5).
  const workerFor = (id: string, command?: string[]): WorkerAdapter => {
    const key = command !== undefined ? `${id}\u0000${JSON.stringify(command)}` : id
    let w = workers.get(key)
    if (!w) {
      w = createWorker(id, opts, command)
      workers.set(key, w)
    }
    return w
  }
  return jobsSpec.jobs.map((j) => ({
    id: j.id,
    phaseId: j.phase,
    dependencies: j.dependencies,
    brief: j.brief,
    model: j.model ?? opts.model,
    worker: workerFor(j.worker ?? opts.workerId, j.command),
    timeoutMs: j.timeoutMs ?? opts.timeoutMs,
    gates: (j.gates ?? opts.gates).map((g) => new CommandGate(g.name, g.command)),
    // T-015: probes attach via the --jobs spec only — no run-level flag this
    // slice, and default --goal mode carries none. Absent stays absent.
    ...(j.probes !== undefined ? { probes: j.probes.map(createProbe) } : {}),
  }))
}

/** The adapter ids createWorker knows. Shared with the early per-job
 *  validation in main() so an unknown job worker id refuses BEFORE the
 *  checkout lock or any artifacts dir exists (the AC's zero-side-effects
 *  refusal set), with exactly the message the registry itself throws. */
const WORKER_ADAPTERS: readonly string[] = ['opencode', 'machine']

function createWorker(workerId: string, opts: Options, command?: string[]): WorkerAdapter {
  switch (workerId) {
    case 'opencode':
      if (!existsSync(opts.opencodeBin)) {
        throw new Error(`opencode executable not found at ${opts.opencodeBin} — run: npm install`)
      }
      return new OpenCodeWorker(opts.opencodeBin)
    case 'machine':
      // Constructed from a job's command (resolveJobs) or, since T-025, from
      // an advisory role's command (a machine planner/reviewer IS a
      // legitimate run-level machine construction, via
      // --planner-worker/--reviewer-worker machine plus the role's command
      // flag, validated in main()). The WORKER tier still can never land
      // here without a command: --worker machine is refused at parse time.
      if (command === undefined) {
        throw new Error(`the machine worker requires a per-job command argv (a --jobs spec "command" field)`)
      }
      return new MachineWorker(command)
    default:
      throw new Error(`unknown worker adapter '${workerId}' (available: ${WORKER_ADAPTERS.join(', ')})`)
  }
}

/** T-025 per-role selection rules, checked BEFORE repo validation, the
 *  checkout lock, or any artifacts dir (the T-007/T-017 zero-side-effects
 *  refusal pattern). Pure: returns the refusal message or null.
 *  - an unknown per-role id refuses with the registry's own message;
 *  - a role resolving to 'machine' without its command flag refuses (the
 *    machine worker has no other command source — the same fact the
 *    run-level --worker machine refusal cites);
 *  - a command flag on a role resolving to 'opencode' refuses (the T-017
 *    --jobs command-pairing rule, at role level). */
function perRoleRefusal(opts: Options): string | null {
  const roles = [
    { role: 'planner', id: opts.plannerWorkerId!, flag: '--planner-worker', commandFlag: '--planner-command', command: opts.plannerCommand },
    { role: 'reviewer', id: opts.reviewerWorkerId!, flag: '--reviewer-worker', commandFlag: '--reviewer-command', command: opts.reviewerCommand },
    // T-039: the verifier's pairing rules ride the same table — validated
    // whenever its flags appear, independently of whether --verifier-model
    // enables the role (flag-level validity, like the planner's flags in
    // --jobs mode).
    { role: 'verifier', id: opts.verifierWorkerId!, flag: '--verifier-worker', commandFlag: '--verifier-command', command: opts.verifierCommand },
  ]
  for (const r of roles) {
    if (!WORKER_ADAPTERS.includes(r.id)) {
      return `unknown worker adapter '${r.id}' (available: ${WORKER_ADAPTERS.join(', ')})`
    }
    if (r.id === 'machine' && r.command === null) {
      return `${r.flag} machine requires a machine command — pass ${r.commandFlag} <json argv> (a non-empty list-form argv like '["node", "scripts/task.js"]')`
    }
    if (r.id !== 'machine' && r.command !== null) {
      return `${r.commandFlag} sets a machine command but the ${r.role} resolves to the '${r.id}' worker — command is the machine worker's argv; pair it with ${r.flag} machine`
    }
  }
  return null
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  // T-025: the advisory roles default to the --worker id — absent flags ⇒ all
  // three roles ride --worker exactly as before. Resolved here, after the
  // whole argv is read, because --worker may appear after --planner-worker.
  opts.plannerWorkerId = opts.plannerWorkerId ?? opts.workerId
  opts.reviewerWorkerId = opts.reviewerWorkerId ?? opts.workerId
  // T-039: the verifier role defaults to the --worker adapter, exactly as the
  // planner/reviewer selections do; absent --verifier-model keeps the whole
  // role off.
  opts.verifierWorkerId = opts.verifierWorkerId ?? opts.workerId
  // T-025: the per-role id/pairing refusals happen before the --jobs spec is
  // even read — before repo validation, the checkout lock, or any artifacts
  // dir exists (zero side effects, the parse-refusal pattern).
  const roleRefusal = perRoleRefusal(opts)
  if (roleRefusal) throw new Error(roleRefusal)

  // T-009: the --jobs spec is read and validated BEFORE repo validation, the
  // checkout lock, or any artifacts dir exists — a refusal must write
  // nothing (the T-007 --max-attempts parse-refusal pattern).
  const jobsSpec = opts.jobs ? loadJobsSpec(opts.jobs) : null
  // T-017: the worker/command pairing rules and the per-job worker-id
  // validity refuse here — before the checkout lock or any artifacts dir —
  // never inside resolveJobs, which runs after the checkout lock and would
  // break the zero-side-effects refusal pattern.
  if (jobsSpec) {
    const pairing = commandPairingRefusal(jobsSpec.jobs, opts.workerId)
    if (pairing) throw new Error(`--jobs spec refused: ${pairing}`)
    for (const j of jobsSpec.jobs) {
      if (j.worker !== undefined && !WORKER_ADAPTERS.includes(j.worker)) {
        throw new Error(`unknown worker adapter '${j.worker}' (available: ${WORKER_ADAPTERS.join(', ')})`)
      }
    }
  }
  // Concurrency default (generalized: the job count in --jobs mode, the
  // candidate count in default mode).
  if (!opts.concurrency) opts.concurrency = jobsSpec ? jobsSpec.jobs.length : opts.candidates

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
    await runPipeline(opts, jobsSpec)
  } finally {
    releaseCheckoutLock(lockPath)
  }
}

/**
 * T-043: the reserved baseline lease id. Every job-derived lease id is
 * `wt/<jobId>` (plus `-a<n>` on retries), and job ids are validated against
 * SPEC_ID_PATTERN (`[a-z0-9][a-z0-9-]*`, src/scheduler.ts:39) — candidate ids
 * `c01..cNN` included, and rounds' `-r2` suffixes stay inside the charset.
 * The underscore is outside that charset, so `wt/_baseline` can never collide
 * with any job's lease or branch, by construction rather than by reservation
 * list. Its branch is `swarm/wt--baseline` (branchForLeaseId).
 */
const BASELINE_LEASE_ID = 'wt/_baseline'

/**
 * The distinct gates the run will use (T-043): the run-level set in default
 * mode; the deduplicated union across jobs in --jobs mode — a job's `gates`
 * REPLACE the run-level set (src/scheduler.ts's JobSpec contract, mirrored by
 * resolveJobs's `j.gates ?? opts.gates`), so the union is over each job's
 * effective set. Dedup key is name+command (two gates sharing a name with
 * different commands are distinct checks); first-seen order is kept.
 */
function distinctGatesFor(opts: Options, jobsSpec: JobsSpec | null): { name: string; command: string }[] {
  const specs = jobsSpec ? jobsSpec.jobs.flatMap((j) => j.gates ?? opts.gates) : opts.gates
  const seen = new Set<string>()
  const distinct: { name: string; command: string }[] = []
  for (const g of specs) {
    const key = `${g.name}\u0000${g.command}`
    if (seen.has(key)) continue
    seen.add(key)
    distinct.push(g)
  }
  return distinct
}

/** The T-043 refusal/override artifact — written on every path (green, red
 *  refusal, red override), the report.json-shape-is-for-completed-runs rule
 *  being why this is its own file. Gates are GateResult[] verbatim (the
 *  CommandGate stamp carries each command, T-027). */
interface BaselineCheckRecord {
  baseSha: string
  /** The reserved baseline lease; null when the run carried no gates (the
   *  vacuous check — nothing was leased or run). */
  lease: { id: string; branch: string } | null
  gates: GateResult[]
  /** green = every gate passed on the untouched base (or none to run); red =
   *  at least one failed. */
  outcome: 'green' | 'red'
  /** True only when --allow-red-base overrode a red outcome and the run
   *  proceeded — recorded so a report can never silently mean "passed gates
   *  over a red base". */
  overridden: boolean
  checkedAt: string
}

/**
 * T-043 baseline gate sanity: prove the run's gates green on the UNTOUCHED
 * base before runSkeleton — zero planner/worker tokens are spent on a red
 * base. Leases one worktree at baseSha through the same WorktreeProvider the
 * candidates will use, runs every distinct gate sequentially with the
 * standard gate timeout (the CommandGate default the run's own gates run
 * under), under the checkout lock main() already holds. The worktree and its
 * swarm/* branch are disposed on every path before returning or throwing.
 *
 * NO-OP symmetry (AGENTS.md #7): gates on an untouched tree prove nothing
 * ABOUT A WORKER — but they are the only thing that proves the base itself is
 * green; without them a gate FAIL is uninterpretable (candidate-broke-it vs
 * base-was-always-broken). A red base refuses (the thrown block below, exit 1
 * through main's catch) unless --allow-red-base was given — the one explicit
 * human override ("repair a red base" is a legitimate goal; the --force-lock
 * posture: named override, not a knob). Either way the evidence rides
 * <artifactsDir>/baseline-check.json.
 */
async function checkBaselineGates(
  opts: Options,
  gates: { name: string; command: string }[],
  artifactsDir: string,
  baseSha: string,
): Promise<BaselineCheckRecord> {
  const checkedAt = new Date().toISOString()
  const artifactPath = join(artifactsDir, 'baseline-check.json')
  if (gates.length === 0) {
    // Vacuous: a run with no gates has nothing to verify about its base (the
    // ladder's own vacuous-pass posture). Recorded honestly, nothing run.
    const record: BaselineCheckRecord = { baseSha, lease: null, gates: [], outcome: 'green', overridden: false, checkedAt }
    writeFileSync(artifactPath, JSON.stringify(record, null, 2))
    console.log('baseline: no gates on this run — the base check is vacuous')
    return record
  }
  console.log(`baseline: proving the run's ${gates.length} distinct gate${gates.length > 1 ? 's' : ''} green on the untouched base @ ${baseSha.slice(0, 12)}`)
  const workspaces = new WorktreeProvider(opts.repo, artifactsDir)
  const lease = workspaces.lease(BASELINE_LEASE_ID, baseSha)
  const results: GateResult[] = []
  try {
    for (const g of gates) {
      // The standard gate object: same command, same default timeout the
      // candidates' gates run under (src/gate/command.ts).
      const r = await new CommandGate(g.name, g.command).run(lease.path)
      results.push(r)
      console.log(`[baseline] gate ${r.name}: ${r.passed ? 'PASS' : 'FAIL'} (${(r.durationMs / 1000).toFixed(1)}s)`)
    }
  } finally {
    // Dispose on every path — the lease is scaffolding, never evidence. Both
    // steps are attempted even if the first fails: a leftover swarm/wt--
    // baseline branch would make the NEXT run's baseline lease refuse
    // (`git worktree add -b` refuses an existing branch), so a disposal
    // failure is loud and aborts the run rather than poisoning the repo.
    let disposalError: unknown = null
    try {
      workspaces.dispose(lease)
    } catch (e) {
      disposalError = e
    }
    try {
      execFileSync('git', ['branch', '-D', lease.branch], { cwd: opts.repo, stdio: 'ignore', windowsHide: true })
    } catch (e) {
      disposalError ??= e
    }
    if (disposalError !== null) {
      throw new Error(`baseline worktree disposal failed (${disposalError instanceof Error ? disposalError.message : String(disposalError)}) — remove the leftover ${lease.branch} branch (npm run clean -- --run <runId>, or git branch -D ${lease.branch}) before the next run`)
    }
  }
  const failed = results.filter((r) => !r.passed)
  const record: BaselineCheckRecord = {
    baseSha,
    lease: { id: lease.id, branch: lease.branch },
    gates: results,
    outcome: failed.length > 0 ? 'red' : 'green',
    overridden: failed.length > 0 && opts.allowRedBase,
    checkedAt,
  }
  writeFileSync(artifactPath, JSON.stringify(record, null, 2))
  if (failed.length === 0) {
    console.log(`baseline: green — all ${results.length} gate${results.length > 1 ? 's' : ''} pass on the base commit`)
    return record
  }
  // The loud per-gate block, printed on both faces: the refusal points at the
  // override; the override names itself.
  const block = [
    `BASELINE ${record.overridden ? 'RED (OVERRIDDEN)' : 'GATE FAILURE'} — the base commit itself fails ${failed.length} of the run's ${results.length} gate${results.length > 1 ? 's' : ''}:`,
    ...failed.map((r) => `  gate ${r.name}: FAIL${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''} — command: ${r.command}`),
    ...failed.flatMap((r) => (r.outputTail.trim() === '' ? [] : [`    output tail: ${r.outputTail.trim().split('\n').join('\n    ')}`])),
  ]
  if (record.overridden) {
    console.log(block.join('\n'))
    console.log(`baseline: proceeding over the red base (--allow-red-base) — the evidence rides ${artifactPath}`)
    return record
  }
  throw new Error([
    block.join('\n'),
    `Every candidate would fail these gates for reasons unrelated to its work; refusing before any dispatch.`,
    `baseline evidence: ${artifactPath}`,
    `Re-run with --allow-red-base to proceed over a red base (a named human override — the refusal is the default).`,
  ].join('\n'))
}

async function runPipeline(opts: Options, jobsSpec: JobsSpec | null): Promise<void> {
  // T-064: the no-gates warning tells the truth (register R8). The pre-T-064
  // line read "every candidate passes vacuously" while the ladder does the
  // OPPOSITE — `passedAllGates` requires `gates.length > 0` (src/runner.ts) —
  // so a run with no gates ELIMINATES every candidate on the zero-gate leg,
  // and an operator who read the old warning and proceeded lost every
  // candidate to a rule they were told did not exist. The trigger is the
  // run's EFFECTIVE gate set — the same deduplicated union the baseline
  // check uses (distinctGatesFor below): a --jobs run whose jobs carry their
  // own gates HAS a survival bar, and warning "eliminates every candidate"
  // there would be the same lie in the other direction (pre-T-064 the old
  // line fired in that face too). A no-gates run still proceeds (probe-only
  // / evidence-gathering runs are legitimate); nothing but this console line
  // changes — report shape, exit-code semantics, and the ladder are
  // untouched (pinned token-free by Gate 1.50).
  if (distinctGatesFor(opts, jobsSpec).length === 0) {
    console.warn('warning: no --gate given (and no --jobs job carries gates) — the ladder eliminates every candidate on the zero-gate leg (passing requires at least one gate); pass --gate "name=command" to give candidates a survival bar, or drive --jobs probes for an evidence-only run')
  }

  const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const artifactsDir = join(opts.runRoot, runId)
  mkdirSync(artifactsDir, { recursive: true })

  const baseSha = execFileSync('git', ['rev-parse', opts.base], { cwd: opts.repo, encoding: 'utf8', windowsHide: true }).trim()

  console.log(`run ${runId}: ${jobsSpec ? `${jobsSpec.jobs.length} jobs from ${opts.jobs}` : `${opts.candidates} candidates`}, concurrency ${opts.concurrency}`)
  console.log(`repo:     ${opts.repo} @ ${baseSha.slice(0, 12)}`)
  console.log(`planner:  ${jobsSpec ? '(skipped — briefs come from the jobs spec)' : opts.plannerModel ?? '(disabled — candidates get the raw goal)'}`)
  console.log(`reviewer: ${opts.reviewerModel ?? '(disabled)'}`)
  // T-039: the verifier line is printed only when the role is enabled — the
  // producer-only pattern holds for stdout too, so flag-less runs are
  // byte-identical.
  if (opts.verifierModel) {
    console.log(`verifier: ${opts.verifierModel}`)
  }
  // T-025: the workers line names non-default advisory roles; with no new
  // flags it is byte-identical to today.
  const rolesText = [
    opts.plannerWorkerId !== opts.workerId ? `planner=${opts.plannerWorkerId}` : null,
    opts.reviewerWorkerId !== opts.workerId ? `reviewer=${opts.reviewerWorkerId}` : null,
    opts.verifierWorkerId !== opts.workerId ? `verifier=${opts.verifierWorkerId}` : null,
  ].filter(Boolean).join(' ')
  console.log(`workers:  ${opts.model} (worker: ${opts.workerId}${rolesText ? `, ${rolesText}` : ''})`)
  console.log(`goal:     ${opts.goal || (jobsSpec ? '(none — briefs come from the jobs spec)' : '')}`)
  console.log(`artifacts: ${artifactsDir}`)
  console.log('')

  // T-043 baseline gate sanity: prove the run's distinct gates green on the
  // untouched base BEFORE runSkeleton — zero planner/worker tokens spent on a
  // red base, under the checkout lock main() already holds. Throws the
  // refusal (exit 1 through main's catch, lock released by its finally)
  // unless --allow-red-base was given; either way the evidence rides
  // <artifactsDir>/baseline-check.json.
  await checkBaselineGates(opts, distinctGatesFor(opts, jobsSpec), artifactsDir, baseSha)
  console.log('')

  const report = await runSkeleton({
    runId,
    repo: opts.repo,
    baseSha,
    goal: opts.goal,
    model: opts.model,
    plannerModel: jobsSpec ? null : opts.plannerModel,
    reviewerModel: opts.reviewerModel,
    // T-039: the verifier role rides both modes like the reviewer; null (the
    // default) keeps it off entirely — no dispatches, no report block.
    verifierModel: opts.verifierModel,
    candidateIds: jobsSpec ? [] : Array.from({ length: opts.candidates }, (_, i) => `c${String(i + 1).padStart(2, '0')}`),
    concurrency: opts.concurrency,
    // T-030: the bounded loop flag; 1 (the default) = today's single pass.
    rounds: opts.rounds,
    // T-059: the planner repo digest — the CLI's run-level default TRUE
    // (--no-planner-context opts out), always passed so every real run
    // carries it; the seam treats false as today's exact prompt bytes.
    plannerContext: opts.plannerContext,
    timeoutMs: opts.timeoutMs,
    maxAttempts: opts.maxAttempts,
    // T-038: the bounded gate-failure retry flag; false (the default) =
    // today's ladder exactly.
    gateRetry: opts.gateRetry,
    gates: opts.gates.map((g) => new CommandGate(g.name, g.command)),
    worker: createWorker(opts.workerId, opts),
    // T-025: a non-default advisory role builds its own adapter through the
    // same createWorker (a machine role's command was validated in main());
    // a default role passes nothing and rides the run-level adapter exactly
    // as before. The planner flags are accepted but inert in --jobs mode
    // (the planner phase is skipped there); the reviewer selection applies
    // in both modes.
    ...(opts.plannerWorkerId !== opts.workerId
      ? { plannerWorker: createWorker(opts.plannerWorkerId!, opts, opts.plannerCommand ?? undefined) }
      : {}),
    ...(opts.reviewerWorkerId !== opts.workerId
      ? { reviewerWorker: createWorker(opts.reviewerWorkerId!, opts, opts.reviewerCommand ?? undefined) }
      : {}),
    // T-039: a non-default verifier role builds its own adapter through the
    // same createWorker (a machine verifier's command was validated in
    // main()); the default passes nothing and rides the run-level adapter.
    ...(opts.verifierWorkerId !== opts.workerId
      ? { verifierWorker: createWorker(opts.verifierWorkerId!, opts, opts.verifierCommand ?? undefined) }
      : {}),
    workspaces: new WorktreeProvider(opts.repo, join(artifactsDir)),
    artifactsDir,
    cleanWorkspaces: opts.clean,
    scheduled: jobsSpec ? { phases: jobsSpec.phases, jobs: resolveJobs(jobsSpec, opts) } : undefined,
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
    // T-045: the run summary line carries the overlap marker when the
    // candidate's recorded block flags evaluator-file tampering — evidence
    // beside the verdict, never part of it (the block changes no verdict).
    const overlapText = c.gateCommandOverlap
      ? `  gate-overlap:${c.gateCommandOverlap.map((o) => `${o.gate}(${o.touched.join('+')})`).join(',')}`
      : ''
    console.log(
      `${c.id}  worker:${c.workerOk ? 'ok' : 'failed'} ${(c.workerDurationMs / 1000).toFixed(0)}s` +
      `  diff:${(c.diffBytes / 1024).toFixed(1)}KiB  ${gateText} => ${verdict}${reviewText}${overlapText}`,
    )
  }
  if (report.schedule) {
    const phases = report.schedule.phases.map((p) => `${p.id}=${p.status}`).join(', ')
    const notDispatched = report.schedule.jobs.filter((j) => j.dispatchIndex === null).map((j) => j.id)
    console.log(`schedule: ${phases}${notDispatched.length > 0 ? `; not dispatched: ${notDispatched.join(', ')}` : ''}`)
  }
  console.log(`\nreport: ${join(artifactsDir, 'report.json')}`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
