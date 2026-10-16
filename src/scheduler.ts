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
//      deterministic and is not claimed to be; dispatch ORDER is.
//   3. `buildSchedule` — the recorded schedule block that makes a run's
//      dispatch order checkable post-hoc.
//
// Validation reuses T-006's exported pure validators
// (src/store/index.ts: unknownDependencyRefusal + cycleRefusal) on the
// expanded job DAG, so a cycle refusal names the cycle.

import { cycleRefusal, unknownDependencyRefusal } from './store/index.js'
import type { DagJobSpec } from './store/index.js'
import type { RunSchedule } from './types.js'

/** Phase id charset — same rule as job ids: the ids key schedule records and
 *  store rows, and an unrestricted id could collide or smuggle separators. */
export const SPEC_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Declared phase (§6.3:323-330 subset): only the fields with a producer.
 *  `earlyStop`/`approvalGate` (§6.3:328-329) have none until their successor
 *  tickets land and are refused as unknown fields. */
export interface PhaseSpec {
  id: string
  /** Declared phase-level dependencies (raw, as written in the spec). */
  dependencies: string[]
  /** The one completion policy this slice implements (§6.3:333-341). */
  completion: 'all'
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
  /** Override the run-level --timeout-min for this job. */
  timeoutMs?: number
  /** Override the run-level --gate set for this job (replaces, not merges). */
  gates?: { name: string; command: string }[]
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
    unknownField('phase', p, ['id', 'dependencies', 'completion'])
    const id = parseId('phase', p.id)
    if (seenPhases.has(id)) refuse(`duplicate phase id '${id}'`)
    seenPhases.add(id)
    if (p.completion !== undefined && p.completion !== 'all') {
      refuse(`phase '${id}' completion must be "all" (got ${JSON.stringify(p.completion)}) — no other completion policy is implemented this slice`)
    }
    phases.push({ id, dependencies: parseStringArray(`phase '${id}'`, p.dependencies, 'dependencies'), completion: 'all' })
  }

  const jobs: JobSpec[] = []
  const seenJobs = new Set<string>()
  for (const j of raw.jobs) {
    if (!isPlainObject(j)) refuse('every job must be a JSON object')
    unknownField('job', j, ['id', 'phase', 'dependencies', 'brief', 'model', 'worker', 'timeoutMs', 'gates'])
    const id = parseId('job', j.id)
    if (seenJobs.has(id)) refuse(`duplicate job id '${id}'`)
    seenJobs.add(id)
    if (typeof j.phase !== 'string') refuse(`job '${id}' phase must be a string naming a declared phase`)
    if (typeof j.brief !== 'string' || j.brief.length === 0) refuse(`job '${id}' brief must be a non-empty string`)
    if (j.model !== undefined && typeof j.model !== 'string') refuse(`job '${id}' model must be a string (a model ID as configuration, never engine code)`)
    if (j.worker !== undefined && typeof j.worker !== 'string') refuse(`job '${id}' worker must be a string (a worker adapter id)`)
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
      timeoutMs: j.timeoutMs as number | undefined,
      gates,
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
 * The recorded schedule block (T-009): every phase with its status under
 * `all` (completed = every job terminal-success; failed = some job
 * terminal-failed; blocked = jobs never dispatched because an upstream phase
 * failed), and every job with its 0-based dispatch index — null for jobs
 * that were never dispatched, which are recorded as not-dispatched, never
 * fabricated as terminal. Pure.
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
      return {
        id: p.id,
        dependencies: [...p.dependencies],
        completion: p.completion,
        status: failed ? 'failed' : completed ? 'completed' : 'blocked',
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
