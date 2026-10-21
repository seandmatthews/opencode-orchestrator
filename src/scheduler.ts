// Deterministic scheduler core (T-009, spec §34:2024 "deterministic
// scheduler", §6.3/§6.4 minimal job spec, §22:1329 deterministic
// transitions). Pure: no I/O, no model knowledge, no wall clock — the same
// inputs always produce the same schedule.
//
// Three pieces:
//   1. the minimal --jobs spec (§6.3/§6.4 subset — only fields with
//      producers) and its strict parser. Unknown fields are REFUSED, not
//      ignored, so a typo can never silently narrow a run; `completion`
//      accepts only "all" this slice; job ids are restricted to
//      [a-z0-9][a-z0-9-]* so derived lease/branch names stay collision-free
//      (the T-004 hazard).
//   2. `readyJobs` — the one deterministic scheduling decision, and the
//      determinism contract: the topological ready set, tie-broken by
//      ascending job id, never wall-clock, never insertion order, never
//      model opinion. Concurrent COMPLETION interleaving is not
//      deterministic and is not claimed to be; dispatch ORDER is. The
//      phase-level early stop (T-031, `earlyStopMet`) makes the same kind
//      of claim and only that kind: the stop DECISION is a pure function of
//      terminal states — same terminal states ⇒ same stop decision — while
//      WHICH jobs it leaves undispatched is interleaving-sensitive exactly
//      like dispatch order beyond the ready list. The claim is never the
//      same wall-clock behavior.
//   3. `buildSchedule` — the recorded schedule block that makes a run's
//      dispatch order checkable post-hoc.
//
// Validation reuses T-006's exported pure validators
// (src/store/index.ts: unknownDependencyRefusal + cycleRefusal) on the
// expanded job DAG, so a cycle refusal names the cycle.

import { win32 } from 'node:path'
import { cycleRefusal, unknownDependencyRefusal } from './store/index.js'
import type { DagJobSpec } from './store/index.js'
import type { EarlyStopRecord, RunSchedule } from './types.js'
import type { ScenarioSpec } from './probe.js'

/** Phase id charset — same rule as job ids: the ids key schedule records and
 *  store rows, and an unrestricted id could collide or smuggle separators. */
export const SPEC_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Phase-level early stop (T-031, spec §20:1265-1281 "Early Stop and Bounded
 *  Waste"; §6.3:328 names `earlyStop` on PhaseSpec — the type is used but
 *  never defined by the spec, chosen here and documented, the T-013
 *  `DistillationPlan` precedent). Exactly ONE machine-computed condition
 *  this slice — `minSurvivors`, the spec §20 "stop after 20 valid
 *  researchers" shape. The stop only suppresses DISPATCH: in-flight jobs run
 *  to completion — never killed — verdicts are never changed, nobody is
 *  eliminated. No model-confidence condition of any kind (spec §20:1281;
 *  decisions.md 2026-10-10 — machine gates decide survival, models advise):
 *  the condition is a count over terminal states, never a model opinion. */
export interface EarlyStopPolicy {
  /** Conclude the phase early once at least this many of its jobs have
   *  reached terminal SUCCESS. Machine-computed: a count over terminal
   *  states, never a model opinion. */
  minSurvivors: number
}

/** Declared phase (§6.3:323-330 subset): only the fields with a producer.
 *  `earlyStop` (§6.3:328) has one since T-031 (EarlyStopPolicy above);
 *  `approvalGate` (§6.3:329) still does not — its own M8 successor has not
 *  landed — and is refused as an unknown field. */
export interface PhaseSpec {
  id: string
  /** Declared phase-level dependencies (raw, as written in the spec). */
  dependencies: string[]
  /** The one completion policy this slice implements (§6.3:333-341). */
  completion: 'all'
  /** Phase-level early stop (T-031, spec §20): present only when the spec
   *  declares it — a policy-absent phase (and any default-mode run) is
   *  untouched by the stop machinery. */
  earlyStop?: EarlyStopPolicy
}

/** Job (§6.4:346-367 subset): only the fields with a producer. Every §6.4
 *  policy field without one (`workspace`, `permissions`, `role`, `prompt`,
 *  `contextPlan`, `inputArtifacts`, `expectedOutputs`, `retryPolicy`,
 *  `timeoutPolicy`, `gatePolicy`) is refused as an unknown field, not
 *  ignored. `dependencies` holds the EXPANDED edges (job deps + phase-dep
 *  expansion — see parseJobsSpec), the one job DAG the ready function sees. */
export interface JobSpec {
  id: string
  phase: string
  dependencies: string[]
  brief: string
  /** Override the run-level --model for this job. */
  model?: string
  /** Override the run-level --worker adapter id for this job. */
  worker?: string
  /** The deterministic argv a `worker: "machine"` job executes (T-017) —
   *  list-form, spawned directly in the leased worktree, never re-tokenized
   *  from a string. Only valid on jobs whose resolved worker is 'machine'
   *  (job field, else the --worker default); the pairing is enforced by
   *  `commandPairingRefusal` below, which the CLI calls before any side
   *  effect (never inside resolveJobs, which runs after the checkout lock). */
  command?: string[]
  /** Override the run-level --timeout-min for this job. */
  timeoutMs?: number
  /** Override the run-level --gate set for this job (replaces, not merges). */
  gates?: { name: string; command: string }[]
  /** Evidence probes for this job (T-015, spec §12): named, reusable,
   *  evidence-emitting checks that run on the final attempt regardless of
   *  gate outcomes. Survival stays with the gates — probes advise/record. */
  probes?: ScenarioSpec[]
}

/** A parsed, validated --jobs spec. Job dependencies are already expanded:
 *  every job of a phase depends on every job of each phase it depends on,
 *  so the ready function sees one job DAG (phase `dependencies` stay raw). */
export interface JobsSpec {
  phases: PhaseSpec[]
  jobs: JobSpec[]
}

/** The shape the ready function consumes: nodes by id with their expanded
 *  dependency edges. */
export interface SchedulerJobNode {
  readonly id: string
  readonly phaseId: string
  readonly dependencies: readonly string[]
}

/** Terminal states of a dispatched job: terminal success (the job passed
 *  all gates) or terminal failure (any verdict on the ladder — a failed job
 *  is terminal too, and blocks everything depending on it). */
export type TerminalJobState = 'succeeded' | 'failed'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function refuse(message: string): never {
  throw new Error(`--jobs spec refused: ${message}`)
}

function unknownField(where: string, obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      refuse(`${where} has unknown field '${key}' (allowed: ${allowed.join(', ')}) — unknown fields are refused, not ignored, so a typo can never silently narrow a run`)
    }
  }
}

function parseId(where: string, value: unknown): string {
  if (typeof value !== 'string' || !SPEC_ID_PATTERN.test(value)) {
    refuse(`${where} id ${JSON.stringify(value)} does not match [a-z0-9][a-z0-9-]* — derived lease and branch names must stay collision-free`)
  }
  return value
}

function parseStringArray(where: string, value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((d) => typeof d !== 'string')) {
    refuse(`${where} ${field} must be an array of strings`)
  }
  return value as string[]
}

/**
 * Parse and validate the `--jobs` input (already JSON-decoded). Strict: any
 * unknown field, bad id charset, duplicate id, non-"all" completion, unknown
 * phase/dependency reference, or cycle throws with a refusal naming the
 * offense — the caller turns that into an exit-1 refusal BEFORE the checkout
 * lock, repo validation, or any artifacts dir exists. Phase-level
 * dependencies expand to job edges: every job of a phase depends on every
 * job of each phase it depends on, so the ready function sees one job DAG.
 */
export function parseJobsSpec(raw: unknown): JobsSpec {
  if (!isPlainObject(raw)) refuse('the spec must be a JSON object with "phases" and "jobs" arrays')
  unknownField('the spec', raw, ['phases', 'jobs'])

  if (!Array.isArray(raw.phases)) refuse('"phases" must be an array')
  if (!Array.isArray(raw.jobs)) refuse('"jobs" must be an array')
  if (raw.phases.length === 0) refuse('"phases" must be a non-empty array')
  if (raw.jobs.length === 0) refuse('"jobs" must be a non-empty array (empty job set)')

  const phases: PhaseSpec[] = []
  const seenPhases = new Set<string>()
  for (const p of raw.phases) {
    if (!isPlainObject(p)) refuse('every phase must be a JSON object')
    unknownField('phase', p, ['id', 'dependencies', 'completion', 'earlyStop'])
    const id = parseId('phase', p.id)
    if (seenPhases.has(id)) refuse(`duplicate phase id '${id}'`)
    seenPhases.add(id)
    if (p.completion !== undefined && p.completion !== 'all') {
      refuse(`phase '${id}' completion must be "all" (got ${JSON.stringify(p.completion)}) — no other completion policy is implemented this slice`)
    }
    // T-031: the one early-stop policy, parsed strictly (the T-009
    // unknown-field posture) — a plain object with a required positive
    // integer `minSurvivors`; unknown sub-fields are refused naming the
    // offense. `approvalGate` stays refused (see unknownField above).
    let earlyStop: EarlyStopPolicy | undefined
    if (p.earlyStop !== undefined) {
      if (!isPlainObject(p.earlyStop)) {
        refuse(`phase '${id}' earlyStop must be an object with a "minSurvivors" field (got ${JSON.stringify(p.earlyStop)})`)
      }
      unknownField(`phase '${id}' earlyStop`, p.earlyStop, ['minSurvivors'])
      if (typeof p.earlyStop.minSurvivors !== 'number' || !Number.isInteger(p.earlyStop.minSurvivors) || p.earlyStop.minSurvivors < 1) {
        refuse(`phase '${id}' earlyStop.minSurvivors must be a positive integer (got ${JSON.stringify(p.earlyStop.minSurvivors)})`)
      }
      earlyStop = { minSurvivors: p.earlyStop.minSurvivors }
    }
    phases.push({
      id,
      dependencies: parseStringArray(`phase '${id}'`, p.dependencies, 'dependencies'),
      completion: 'all',
      ...(earlyStop !== undefined ? { earlyStop } : {}),
    })
  }

  const jobs: JobSpec[] = []
  const seenJobs = new Set<string>()
  for (const j of raw.jobs) {
    if (!isPlainObject(j)) refuse('every job must be a JSON object')
    unknownField('job', j, ['id', 'phase', 'dependencies', 'brief', 'model', 'worker', 'command', 'timeoutMs', 'gates', 'probes'])
    const id = parseId('job', j.id)
    if (seenJobs.has(id)) refuse(`duplicate job id '${id}'`)
    seenJobs.add(id)
    if (typeof j.phase !== 'string') refuse(`job '${id}' phase must be a string naming a declared phase`)
    if (typeof j.brief !== 'string' || j.brief.length === 0) refuse(`job '${id}' brief must be a non-empty string`)
    if (j.model !== undefined && typeof j.model !== 'string') refuse(`job '${id}' model must be a string (a model ID as configuration, never engine code)`)
    if (j.worker !== undefined && typeof j.worker !== 'string') refuse(`job '${id}' worker must be a string (a worker adapter id)`)
    let command: string[] | undefined
    if (j.command !== undefined) {
      // T-017: a list-form argv, validated once here — anything but a
      // non-empty array of non-empty strings is refused. The command is
      // never re-tokenized from a string (AGENTS.md #4).
      if (!Array.isArray(j.command) || j.command.length === 0
        || j.command.some((c) => typeof c !== 'string' || c.length === 0)) {
        refuse(`job '${id}' command must be a non-empty array of non-empty strings (a list-form argv, e.g. ["node", "scripts/codemod.mjs"] — never a shell string)`)
      }
      command = j.command as string[]
    }
    if (j.timeoutMs !== undefined && (typeof j.timeoutMs !== 'number' || !Number.isInteger(j.timeoutMs) || j.timeoutMs <= 0)) {
      refuse(`job '${id}' timeoutMs must be a positive integer`)
    }
    let gates: { name: string; command: string }[] | undefined
    if (j.gates !== undefined) {
      if (!Array.isArray(j.gates)) refuse(`job '${id}' gates must be an array`)
      gates = j.gates.map((g, i) => {
        if (!isPlainObject(g) || typeof g.name !== 'string' || g.name.length === 0 || typeof g.command !== 'string' || g.command.length === 0) {
          refuse(`job '${id}' gates[${i}] must be an object with non-empty "name" and "command" strings`)
        }
        return { name: g.name, command: g.command }
      })
    }
    let probes: ScenarioSpec[] | undefined
    if (j.probes !== undefined) {
      if (!Array.isArray(j.probes)) refuse(`job '${id}' probes must be an array`)
      const seenProbes = new Set<string>()
      probes = j.probes.map((p, i) => {
        const where = `job '${id}' probes[${i}]`
        if (!isPlainObject(p)) refuse(`${where} must be an object`)
        unknownField(where, p, ['id', 'type', 'command', 'timeoutMs', 'repeats', 'capture', 'url'])
        if (typeof p.id !== 'string' || !SPEC_ID_PATTERN.test(p.id)) {
          refuse(`${where} id ${JSON.stringify(p.id)} does not match [a-z0-9][a-z0-9-]* — it names the probe's evidence files`)
        }
        if (seenProbes.has(p.id)) refuse(`job '${id}' has duplicate probe id '${p.id}' — probe ids must be unique per job`)
        seenProbes.add(p.id)
        if (p.type !== 'command' && p.type !== 'test' && p.type !== 'benchmark' && p.type !== 'screenshot' && p.type !== 'web') {
          refuse(`${where} type must be "command", "test", "benchmark", "screenshot", or "web" (got ${JSON.stringify(p.type)}) — unknown probe types are refused, not ignored`)
        }
        if (!isPlainObject(p.command)) refuse(`${where} command must be an object with "exe" and "args"`)
        unknownField(`${where} command`, p.command, ['exe', 'args'])
        if (typeof p.command.exe !== 'string' || p.command.exe.length === 0) {
          refuse(`${where} command exe must be a non-empty string`)
        }
        if (!Array.isArray(p.command.args) || p.command.args.some((a) => typeof a !== 'string')) {
          refuse(`${where} command args must be an array of strings`)
        }
        if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== 'number' || !Number.isInteger(p.timeoutMs) || p.timeoutMs <= 0)) {
          refuse(`${where} timeoutMs must be a positive integer`)
        }
        // T-018: repeats is REQUIRED (positive integer >= 1) on a benchmark
        // probe — a benchmark with no repetition count is not a benchmark —
        // and REFUSED on every other probe type: the field exists only where
        // it means something (the T-009 unknown-field posture).
        if (p.type === 'benchmark') {
          if (typeof p.repeats !== 'number' || !Number.isInteger(p.repeats) || p.repeats < 1) {
            refuse(`${where} repeats must be a positive integer >= 1 on a benchmark probe (got ${JSON.stringify(p.repeats)})`)
          }
        } else if (p.repeats !== undefined) {
          refuse(`${where} repeats is only valid on a benchmark probe (got type ${JSON.stringify(p.type)})`)
        }
        // T-019: capture is REQUIRED (non-empty, workspace-relative — no
        // absolute path, no '..' segment) on a screenshot probe: it names
        // the PNG the capture command must have written INSIDE the
        // disposable workspace, and the evidence contract stays local to the
        // worktree (the durable copy is the probe's job). REFUSED on every
        // other probe type: the field exists only where it means something
        // (the repeats precedent). win32.isAbsolute regardless of host OS so
        // drive-letter and UNC forms are refused deterministically.
        if (p.type === 'screenshot') {
          if (typeof p.capture !== 'string' || p.capture.length === 0) {
            refuse(`${where} capture must be a non-empty workspace-relative path on a screenshot probe (got ${JSON.stringify(p.capture)})`)
          }
          if (win32.isAbsolute(p.capture)) {
            refuse(`${where} capture must be workspace-relative; absolute paths are refused (got ${JSON.stringify(p.capture)})`)
          }
          if (p.capture.split(/[\\/]/).includes('..')) {
            refuse(`${where} capture must not contain a '..' segment (got ${JSON.stringify(p.capture)})`)
          }
        } else if (p.capture !== undefined) {
          refuse(`${where} capture is only valid on a screenshot probe (got type ${JSON.stringify(p.type)})`)
        }
        // T-024: url is REQUIRED (non-empty http:// or https://) on a web
        // probe — the address the probe polls for readiness and captures,
        // the one probe field pointing OUTSIDE the workspace (absolute by
        // nature; its operator-chosen port is machine-global — the
        // documented limitation). REFUSED on every other probe type: the
        // field exists only where it means something (the repeats/capture
        // precedent).
        if (p.type === 'web') {
          if (typeof p.url !== 'string' || p.url.length === 0) {
            refuse(`${where} url must be a non-empty http(s) URL on a web probe (got ${JSON.stringify(p.url)})`)
          }
          let parsedUrl: URL | null = null
          try {
            parsedUrl = new URL(p.url as string)
          } catch {
            parsedUrl = null
          }
          if (parsedUrl === null || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')) {
            refuse(`${where} url must be an http:// or https:// URL (got ${JSON.stringify(p.url)})`)
          }
        } else if (p.url !== undefined) {
          refuse(`${where} url is only valid on a web probe (got type ${JSON.stringify(p.type)})`)
        }
        return {
          id: p.id,
          type: p.type,
          command: { exe: p.command.exe, args: p.command.args as string[] },
          ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
          ...(p.type === 'benchmark' ? { repeats: p.repeats as number } : {}),
          ...(p.type === 'screenshot' ? { capture: p.capture as string } : {}),
          ...(p.type === 'web' ? { url: p.url as string } : {}),
        }
      })
    }
    if (!seenPhases.has(j.phase)) {
      refuse(`job '${id}' references phase '${String(j.phase)}', which is not in the phase set`)
    }
    jobs.push({
      id,
      phase: j.phase,
      dependencies: parseStringArray(`job '${id}'`, j.dependencies, 'dependencies'),
      brief: j.brief,
      model: j.model as string | undefined,
      worker: j.worker as string | undefined,
      command,
      timeoutMs: j.timeoutMs as number | undefined,
      gates,
      probes,
    })
  }

  for (const p of phases) {
    for (const d of p.dependencies) {
      if (!seenPhases.has(d)) refuse(`phase '${p.id}' depends on '${d}', which is not in the phase set`)
    }
  }
  const phaseJobs = new Map<string, string[]>()
  for (const p of phases) phaseJobs.set(p.id, [])
  for (const j of jobs) phaseJobs.get(j.phase)!.push(j.id)
  for (const p of phases) {
    if (phaseJobs.get(p.id)!.length === 0) {
      refuse(`phase '${p.id}' has no jobs — every phase must carry at least one job this slice`)
    }
  }

  // Expand phase-level dependencies to job edges: every job of a phase
  // depends on every job of each phase it depends on. Then hand the ONE job
  // DAG to T-006's validators — a cycle anywhere (job or phase level)
  // surfaces here, and the refusal names the cycle.
  const expanded: (DagJobSpec & { phaseId: string })[] = jobs.map((j) => {
    const edges = new Set(j.dependencies)
    for (const depPhase of phases.find((p) => p.id === j.phase)!.dependencies) {
      for (const other of phaseJobs.get(depPhase)!) edges.add(other)
    }
    return { id: j.id, phaseId: j.phase, dependencies: [...edges] }
  })
  const dagRefusal = unknownDependencyRefusal(expanded) ?? cycleRefusal(expanded)
  if (dagRefusal) refuse(dagRefusal)

  return {
    phases,
    jobs: jobs.map((j, i) => ({ ...j, dependencies: [...expanded[i]!.dependencies] })),
  }
}

/**
 * T-017 pairing rules between a job's `worker` and its `command`: a
 * `command` is the machine worker's argv, so it is refused on a job whose
 * resolved worker (job field, else the `--worker` default) is not 'machine',
 * and a job resolving to 'machine' without one is refused too. Pure: takes
 * the already-parsed specs, returns a refusal message or null — no I/O, no
 * side effects. Called from the CLI immediately after `loadJobsSpec`
 * (BEFORE repo validation and the checkout lock, the T-007 parse-refusal
 * pattern), deliberately never inside `resolveJobs`, which runs after the
 * checkout lock and would break the zero-side-effects refusal pattern.
 */
export function commandPairingRefusal(jobs: readonly JobSpec[], defaultWorker: string): string | null {
  for (const j of jobs) {
    const resolved = j.worker ?? defaultWorker
    if (resolved !== 'machine' && j.command !== undefined) {
      return `job '${j.id}' sets command but its worker resolves to '${resolved}' — command is the machine worker's argv and is only valid on worker: "machine" jobs`
    }
    if (resolved === 'machine' && j.command === undefined) {
      return `job '${j.id}' resolves to the machine worker but sets no command — a machine job must carry a non-empty command argv`
    }
  }
  return null
}

/**
 * The determinism contract (T-009): given the validated job DAG, the jobs in
 * terminal states, the jobs currently running, and the concurrency cap,
 * return the ordered ready list — jobs whose every dependency has reached
 * terminal SUCCESS (a terminal-failed dependency blocks its dependents for
 * good), never a terminal or running job, at most `cap - running.size`
 * entries, tie-broken by ascending job id. Pure: never wall-clock, never
 * insertion order, never model opinion. This function is what "same inputs
 * produce the same schedule" means and what Gate 1.10 pins; concurrent
 * completion interleaving is not deterministic and is not claimed to be.
 */
export function readyJobs(
  jobs: readonly SchedulerJobNode[],
  terminal: ReadonlyMap<string, TerminalJobState>,
  running: ReadonlySet<string>,
  cap: number,
): string[] {
  const free = cap - running.size
  if (free <= 0) return []
  const ready: string[] = []
  for (const j of jobs) {
    if (terminal.has(j.id) || running.has(j.id)) continue
    if (!j.dependencies.every((d) => terminal.get(d) === 'succeeded')) continue
    ready.push(j.id)
  }
  return ready.sort().slice(0, free)
}

/**
 * The phase-level early-stop decision (T-031, spec §20:1265-1281): the
 * phase's count of terminal-SUCCEEDED jobs ≥ `policy.minSurvivors`. Pure:
 * identical terminal states ⇒ identical decision, no input mutated, no
 * model opinion (decisions.md 2026-10-10 — the condition is a machine
 * count over terminal states, never model confidence, spec §20:1281).
 * Per the module header's determinism contract: which jobs the stop leaves
 * undispatched is interleaving-sensitive; only the DECISION is pinned.
 */
export function earlyStopMet(
  policy: EarlyStopPolicy,
  phaseJobs: readonly SchedulerJobNode[],
  terminal: ReadonlyMap<string, TerminalJobState>,
): boolean {
  let survivors = 0
  for (const j of phaseJobs) {
    if (terminal.get(j.id) === 'succeeded') survivors++
  }
  return survivors >= policy.minSurvivors
}

/**
 * The recorded schedule block (T-009): every phase with its status under
 * `all` (completed = every job terminal-success; failed = some job
 * terminal-failed; blocked = jobs never dispatched because an upstream phase
 * failed; concluded-early = T-031: the phase DECLARED an EarlyStopPolicy,
 * the policy is MET, and at least one of its jobs was never dispatched
 * because the stop suppressed it — precedence
 * failed > concluded-early > completed > blocked, purely derived from the
 * declared policy + terminal states + dispatch indices; a declared-but-unmet
 * policy changes no status), and every job with its 0-based dispatch index —
 * null for jobs that were never dispatched, which are recorded as
 * not-dispatched, never fabricated as terminal. Pure.
 */
export function buildSchedule(
  phases: readonly PhaseSpec[],
  jobs: readonly SchedulerJobNode[],
  terminal: ReadonlyMap<string, TerminalJobState>,
  dispatchIndexOf: ReadonlyMap<string, number>,
): RunSchedule {
  return {
    phases: phases.map((p) => {
      const phaseJobs = jobs.filter((j) => j.phaseId === p.id)
      const failed = phaseJobs.some((j) => terminal.get(j.id) === 'failed')
      const completed = phaseJobs.every((j) => terminal.get(j.id) === 'succeeded')
      const concludedEarly = p.earlyStop !== undefined
        && earlyStopMet(p.earlyStop, phaseJobs, terminal)
        && phaseJobs.some((j) => !dispatchIndexOf.has(j.id))
      return {
        id: p.id,
        dependencies: [...p.dependencies],
        completion: p.completion,
        status: failed ? 'failed' : concludedEarly ? 'concluded-early' : completed ? 'completed' : 'blocked',
      }
    }),
    jobs: jobs.map((j) => ({
      id: j.id,
      phaseId: j.phaseId,
      dependencies: [...j.dependencies],
      dispatchIndex: dispatchIndexOf.has(j.id) ? dispatchIndexOf.get(j.id)! : null,
    })),
  }
}

/**
 * The early-stop evidence block (T-031): one `EarlyStopRecord` per phase
 * that DECLARED a policy, in spec phase order. `met: true` entries are the
 * stop evidence — which condition fired, who survived (report order, which
 * for a `--jobs` wave is the jobs' spec order), who was never dispatched
 * (spec order); `met: false` entries record that a declared policy was
 * evaluated and never fired (the `RoundRecord.executed: false` posture — a
 * policy that silently vanished would be indistinguishable from a bug).
 * Pure; derived from exactly the inputs `buildSchedule` sees, so the
 * records cannot disagree with the schedule block's `dispatchIndex: null`
 * entries. An empty return means no phase declared a policy — the caller
 * omits the block and the report is unchanged.
 */
export function buildEarlyStops(
  phases: readonly PhaseSpec[],
  jobs: readonly SchedulerJobNode[],
  terminal: ReadonlyMap<string, TerminalJobState>,
  dispatchIndexOf: ReadonlyMap<string, number>,
): EarlyStopRecord[] {
  const records: EarlyStopRecord[] = []
  for (const p of phases) {
    if (p.earlyStop === undefined) continue
    const phaseJobs = jobs.filter((j) => j.phaseId === p.id)
    records.push({
      phaseId: p.id,
      condition: 'minSurvivors',
      threshold: p.earlyStop.minSurvivors,
      met: earlyStopMet(p.earlyStop, phaseJobs, terminal),
      survivorIds: phaseJobs.filter((j) => terminal.get(j.id) === 'succeeded').map((j) => j.id),
      neverDispatchedIds: phaseJobs.filter((j) => !dispatchIndexOf.has(j.id)).map((j) => j.id),
    })
  }
  return records
}
