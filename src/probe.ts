// The Probe seam + structured probe-output contract (T-015, spec §12 — the
// first slice of Milestone 4, §34:2061-2072). A probe converts a candidate
// workspace plus a scenario into evidence artifacts: workspace + scenario →
// evidence. Probes PRODUCE EVIDENCE; survival still belongs to machine gates
// (decisions.md 2026-10-10) — a probe result, including a failing one, never
// enters any verdict. A probe does not interpret; it records what happened.
//
// The spec uses ScenarioSpec / EnvironmentSpec / Measurement / EvidenceBundle
// only as field types (§12:891-893, §12.2:956-963) and never defines them.
// These are the vocabulary choices this repo locks, documented here (the
// T-007:18-33 / T-012:21-30 / T-013:21-35 precedent), together with three
// explicit reconciliations with the landed spec text:
//
//   1. ArtifactRef name collision. §12.2's `artifacts: ArtifactRef[]`
//      collides with the already-landed `ArtifactRef` of the context system
//      (src/context.ts — id/type/contentHash/sizeBytes/layer/estimatedTokens,
//      a context-packet concept). The evidence vocabulary renames it
//      EvidenceArtifactRef: {name, path, kind, sizeBytes} — a pointer at a
//      file the probe captured under the run's artifacts dir. This module
//      never imports from src/context.ts; the two vocabularies stay disjoint.
//   2. WorkspaceLease divergence. §16:1114-1123's lease
//      (createdAt/expiresAt/retentionClass) is the worktree-GC slice's shape;
//      the Probe input binds the repo's WorkspaceLease (src/types.ts:
//      id/path/branch/baseSha). Documented, not relitigated.
//   3. Command-vs-test split. §12.1's single Command Probe description
//      already covers tests; Milestone 4 names them separately with no
//      definition. Chosen vocabulary: COMMAND = an exit-0 evidence probe —
//      it records what happened (exit code, duration, output tail,
//      full-output artifact) and parses nothing; TEST = a probe that parses a
//      test-report format into structured measurements (TAP this slice — what
//      `node --test` emits, zero new deps per decisions.md 2026-10-10).
//
// Additional documented choices:
//   - EvidenceBundle.gateResults reuses the existing GateResult
//     (src/types.ts): each command/test probe records its one execution as a
//     GateResult entry — recorded evidence inside a bundle, never a verdict
//     (the T-011 cleanupFailures evidence-only precedent).
//   - EvidenceBundle.error (not in §12.2) records WHY success is false when
//     it is not a clean command failure: a spawn refusal, a timeout, or
//     unparseable test output. Evidence, never a verdict input.
//   - probeId and scenarioId carry the same value this slice: the --jobs
//     probe entry has one id (src/scheduler.ts), used for both.
//   - The spec's Probe interface (§12:885-893) carries only `id` and receives
//     the scenario through run(input). This slice's probes are constructed
//     FROM their ScenarioSpec (the --jobs probe entry) and expose it as
//     `scenario`, so the runner can keep the spec-shaped run(input) signature.
//   - The runner runs probes only on the FINAL COMPLETED attempt (right after
//     the gate ladder, before review and workspace dispose, regardless of
//     gate outcomes — evidence about failures is evidence). A thrown final
//     attempt has no completed workspace pass to probe; it records no probe
//     evidence this slice.
//   - Benchmark semantics (T-018, §12.1:907-909 — the spec names the
//     Benchmark Probe in one line, "Produces structured performance results",
//     and defines nothing; chosen and documented here, the
//     T-007/T-012/T-013 precedent). A benchmark probe runs its command
//     `repeats` times, SEQUENTIALLY, each through the shared
//     executeProbeCommand core (one spawn path, AGENTS.md #4) — each repeat
//     gets the FULL timeoutMs budget (a per-repeat budget; total wall time
//     bounded by repeats × timeoutMs). Every requested repeat runs regardless
//     of earlier outcomes, and one `run-<i> duration` measurement (unit ms,
//     i 1-based) is recorded per repeat that actually RAN — a repeat that
//     exited non-zero or timed out still ran and its durationMs is real
//     wall-clock evidence; a repeat whose spawn was REFUSED produced no run
//     and gets no duration. Summary measurements min/median/p95 (unit ms)
//     over the recorded durations: each the NEAREST-RANK order statistic of
//     the ascending-sorted durations — sorted[ceil(q·n)−1] for median
//     (q = 0.5) and p95 (q = 0.95), sorted[0] for min; no interpolation,
//     stdlib sort only (zero new deps, decisions.md 2026-10-10). The probe
//     carries NO threshold/assertion input of any kind: it records, never
//     judges (decisions.md 2026-10-10) — a success:false benchmark bundle
//     changes nothing downstream. Its 'report'-kind results artifact
//     (<probeId>.results.json) is that kind's first producer.
//
// Every probe subprocess is list-form `spawn` (never `exec` — AGENTS.md #4,
// stricter than CommandGate's operator-typed shell strings), with the T-011
// verified tree kill at timeout via src/kill-tree.ts. Unproven kill outcomes
// land on the bundle's GateResult `cleanupFailures` — evidence only.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { killFailureLines, killTreeVerified } from './kill-tree.js'
import type { GateResult, WorkspaceLease } from './types.js'

/** The generic probe types landed so far (§34:2061-2072's start list;
 *  `benchmark` landed with T-018 — the first Measurement producer).
 *  Screenshot, Godot/Web/Blender probes are successor slices. */
export type ProbeType = 'command' | 'test' | 'benchmark'

/** Kind of an evidence artifact file (§12.1 names logs, screenshots, video).
 *  Producers so far write `log` (every probe's combined output) and — since
 *  T-018's BenchmarkProbe — `report` (the benchmark's machine-readable
 *  per-run results table, that kind's first producer); the vocabulary is
 *  documented, not grown speculatively. */
export type EvidenceArtifactKind = 'log' | 'report'

/** The probe's configuration, as written in the --jobs spec (§12:891-893's
 *  ScenarioSpec, chosen here): what to run, where its id lives, and the
 *  optional wall-clock limit. */
export interface ScenarioSpec {
  /** Unique per job; names the probe's evidence files. */
  id: string
  type: ProbeType
  /** List-form command (AGENTS.md #4): the executable plus its arguments. */
  command: { exe: string; args: string[] }
  /** Wall-clock limit; defaults to DEFAULT_PROBE_TIMEOUT_MS. */
  timeoutMs?: number
  /** Repetition count. REQUIRED on a benchmark probe (a positive integer
   *  >= 1 — a benchmark with no repetition count is not a benchmark) and
   *  REFUSED on every other probe type: the field exists only where it
   *  means something (the T-009 unknown-field posture). Enforced by
   *  parseJobsSpec (src/scheduler.ts); this type carries it optionally
   *  because the union is shared. */
  repeats?: number
}

/** The run-level context a probe needs beyond the workspace (§12:891-893's
 *  EnvironmentSpec, chosen here): where evidence is written and who ran. */
export interface EnvironmentSpec {
  /** The run's artifacts dir; evidence goes under
   *  <artifactsDir>/probes/<candidateId>/ — never the worktree as the
   *  durable copy (decisions.md 2026-10-10: run root C:\swarm\). */
  artifactsDir: string
  candidateId: string
}

/** One probe execution's input (§12:885-893, spec-shaped). */
export interface ProbeInput {
  workspace: WorkspaceLease
  scenario: ScenarioSpec
  environment: EnvironmentSpec
}

/** The Probe seam (§12:885-893). Like WorkerAdapter/Gate, the engine knows
 *  nothing about specific probe implementations. */
export interface Probe {
  readonly id: string
  /** The scenario this instance was constructed from; passed back through
   *  run() so the §12 signature stays intact (see module docblock). */
  readonly scenario: ScenarioSpec
  run(input: ProbeInput): Promise<EvidenceBundle>
}

/** A pointer at one file the probe captured under the run artifacts dir —
 *  the evidence rename of §12.2's colliding `artifacts: ArtifactRef[]`
 *  (reconciliation 1 in the module docblock). */
export interface EvidenceArtifactRef {
  name: string
  path: string
  kind: EvidenceArtifactKind
  sizeBytes: number
}

/** One structured measurement (§12.2's Measurement, chosen here). */
export interface Measurement {
  name: string
  value: number
  unit?: string
}

/** The structured probe-output contract (§12.2). Produced by every probe
 *  run, validated before it is written to disk. */
export interface EvidenceBundle {
  probeId: string
  scenarioId: string
  success: boolean
  artifacts: EvidenceArtifactRef[]
  measurements: Measurement[]
  gateResults: GateResult[]
  /** Present only when success is false for a reason that is not a clean
   *  command failure: a spawn refusal, a timeout, or unparseable test
   *  output. Evidence, never a verdict input. */
  error?: string
}

/** Default wall-clock limit — the CommandGate default (src/gate/command.ts). */
export const DEFAULT_PROBE_TIMEOUT_MS = 5 * 60_000

/** Tail length for a GateResult's outputTail — the CommandGate shape. */
const TAIL_BYTES = 4000

// ---------- The bundle validator (the contract's enforcement point) ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function refuse(detail: string): never {
  throw new Error(`evidence bundle refused: ${detail}`)
}

function needString(where: string, v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) refuse(`${where} ${field} must be a non-empty string`)
  return v
}

function validateArtifactRef(where: string, v: unknown): void {
  if (!isPlainObject(v)) refuse(`${where} must be an object`)
  needString(where, v.name, 'name')
  needString(where, v.path, 'path')
  if (v.kind !== 'log' && v.kind !== 'report') {
    refuse(`${where} kind must be "log" or "report" (got ${JSON.stringify(v.kind)})`)
  }
  if (typeof v.sizeBytes !== 'number' || !Number.isFinite(v.sizeBytes) || v.sizeBytes < 0) {
    refuse(`${where} sizeBytes must be a finite number >= 0`)
  }
}

function validateMeasurement(where: string, v: unknown): void {
  if (!isPlainObject(v)) refuse(`${where} must be an object`)
  needString(where, v.name, 'name')
  if (typeof v.value !== 'number' || !Number.isFinite(v.value)) {
    refuse(`${where} value must be a finite number`)
  }
  if (v.unit !== undefined && typeof v.unit !== 'string') refuse(`${where} unit must be a string`)
}

function validateGateResult(where: string, v: unknown): void {
  if (!isPlainObject(v)) refuse(`${where} must be an object`)
  needString(where, v.name, 'name')
  if (typeof v.passed !== 'boolean') refuse(`${where} passed must be a boolean`)
  if (v.exitCode !== null && typeof v.exitCode !== 'number') refuse(`${where} exitCode must be a number or null`)
  if (typeof v.durationMs !== 'number' || !Number.isFinite(v.durationMs) || v.durationMs < 0) {
    refuse(`${where} durationMs must be a finite number >= 0`)
  }
  if (typeof v.outputTail !== 'string') refuse(`${where} outputTail must be a string`)
  if (v.cleanupFailures !== undefined) {
    if (!Array.isArray(v.cleanupFailures) || v.cleanupFailures.some((l) => typeof l !== 'string')) {
      refuse(`${where} cleanupFailures must be an array of strings`)
    }
  }
}

/**
 * The EvidenceBundle contract's enforcement point: accepts a well-formed
 * bundle, refuses anything else naming the offense — missing probeId/
 * scenarioId, non-boolean success, non-array artifacts/measurements/
 * gateResults, and malformed entries inside those arrays. The runner
 * validates every bundle BEFORE writing it (an unvalidated bundle is never
 * emitted); the fast-tier probe gate pins both faces on hand-built fixtures.
 */
export function validateEvidenceBundle(raw: unknown): EvidenceBundle {
  if (!isPlainObject(raw)) refuse('the bundle must be a JSON object')
  needString('the bundle', raw.probeId, 'probeId')
  needString('the bundle', raw.scenarioId, 'scenarioId')
  if (typeof raw.success !== 'boolean') refuse('the bundle success must be a boolean')
  for (const field of ['artifacts', 'measurements', 'gateResults'] as const) {
    if (!Array.isArray(raw[field])) refuse(`the bundle ${field} must be an array`)
  }
  const bundle = raw as unknown as EvidenceBundle
  bundle.artifacts.forEach((a, i) => validateArtifactRef(`the bundle artifacts[${i}]`, a))
  bundle.measurements.forEach((m, i) => validateMeasurement(`the bundle measurements[${i}]`, m))
  bundle.gateResults.forEach((g, i) => validateGateResult(`the bundle gateResults[${i}]`, g))
  if (raw.error !== undefined && typeof raw.error !== 'string') refuse('the bundle error must be a string')
  return bundle
}

// ---------- The evidence writer ----------

/** Where a probe's evidence lives under the run artifacts dir. */
export function probeEvidenceDir(artifactsDir: string, candidateId: string): string {
  return join(artifactsDir, 'probes', candidateId)
}

/** The validated-bundle artifact path: <artifactsDir>/probes/<candidateId>/<probeId>.json */
export function evidenceBundlePath(artifactsDir: string, candidateId: string, probeId: string): string {
  return join(probeEvidenceDir(artifactsDir, candidateId), `${probeId}.json`)
}

/**
 * Validate, then write a bundle to <artifactsDir>/probes/<candidateId>/<probeId>.json.
 * Returns the bundle path (what CandidateReport.probes[].bundlePath carries).
 * An unvalidated bundle is never written to disk.
 */
export function writeEvidenceBundle(
  bundle: EvidenceBundle,
  paths: { artifactsDir: string; candidateId: string },
): string {
  validateEvidenceBundle(bundle)
  const path = evidenceBundlePath(paths.artifactsDir, paths.candidateId, bundle.probeId)
  mkdirSync(probeEvidenceDir(paths.artifactsDir, paths.candidateId), { recursive: true })
  writeFileSync(path, JSON.stringify(bundle, null, 2))
  return path
}

/** The minimal success:false bundle for a probe that THREW — the run must
 *  never break on a probe (evidence about failures is evidence). */
export function failedBundle(probeId: string, scenarioId: string, message: string): EvidenceBundle {
  return {
    probeId,
    scenarioId,
    success: false,
    artifacts: [],
    measurements: [],
    gateResults: [{
      name: probeId,
      passed: false,
      exitCode: null,
      durationMs: 0,
      outputTail: message.slice(0, TAIL_BYTES),
    }],
    error: message,
  }
}

// ---------- The shared list-form spawn + verified-tree-kill core ----------

interface ProbeExecution {
  timedOut: boolean
  exitCode: number | null
  /** Combined stdout + stderr as collected. */
  output: string
  durationMs: number
  cleanupFailures: string[]
  /** The spawn refusal's message (e.g. ENOENT), when the command never ran. */
  spawnError?: string
}

/**
 * List-form spawn (never exec — AGENTS.md #4) with the T-011 verified tree
 * kill at timeout: at expiry killTreeVerified fires while the child lives;
 * kill outcomes that are not proven good land on the returned
 * cleanupFailures — evidence only, never a verdict. A spawn refusal
 * ('error' event) is a recorded outcome, never a throw.
 */
function executeProbeCommand(
  command: { exe: string; args: string[] },
  cwd: string,
  timeoutMs: number,
): Promise<ProbeExecution> {
  const started = Date.now()
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let spawnError: string | undefined
    let cleanupFailures: string[] = []
    let output = ''
    const child = spawn(command.exe, command.args, { cwd, windowsHide: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    // Cap collected output at the CommandGate's maxBuffer posture.
    child.stdout.on('data', (chunk: string) => { if (output.length < 16 * 1024 * 1024) output += chunk })
    child.stderr.on('data', (chunk: string) => { if (output.length < 16 * 1024 * 1024) output += chunk })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({
        timedOut: false,
        exitCode: null,
        output,
        durationMs: Date.now() - started,
        cleanupFailures,
        spawnError: err.message,
      })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({
        timedOut,
        exitCode: timedOut ? null : (code ?? null),
        output,
        durationMs: Date.now() - started,
        cleanupFailures,
      })
    })
    const timer = setTimeout(() => {
      timedOut = true
      // The ChildProcess knows its own exit before close delivers it — never
      // taskkill a process that exited naturally at the boundary (a
      // just-exited or reused pid is not ours to kill).
      if (child.exitCode !== null || child.signalCode !== null) return
      if (child.pid === undefined) {
        cleanupFailures = ['CLEANUP FAIL: no root pid to kill for this probe']
        return
      }
      cleanupFailures = killFailureLines(child.pid, killTreeVerified(child.pid))
    }, timeoutMs)
  })
}

/** One probe execution as a recorded GateResult entry — evidence inside a
 *  bundle, never a verdict. `name` is the entry's self-naming name: the
 *  probe id for command/test probes, '<probeId>#run-<i>' for a benchmark
 *  probe's per-repeat entries (T-018). */
function toGateResult(name: string, e: ProbeExecution, extra: { passed: boolean }): GateResult {
  // A spawn refusal produced no output — the refusal itself is the only
  // thing the entry's tail can record (the bundle's `error` names it too).
  const tail = e.spawnError !== undefined && e.output.length === 0
    ? `spawn refused: ${e.spawnError}`
    : e.output
  return {
    name,
    passed: extra.passed,
    exitCode: e.exitCode,
    durationMs: e.durationMs,
    outputTail: tail.slice(-TAIL_BYTES),
    ...(e.cleanupFailures.length > 0 ? { cleanupFailures: e.cleanupFailures } : {}),
  }
}

/** Write the full combined output next to the bundle and reference it. */
function logArtifact(
  environment: EnvironmentSpec,
  probeId: string,
  output: string,
): EvidenceArtifactRef {
  const dir = probeEvidenceDir(environment.artifactsDir, environment.candidateId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${probeId}.log`)
  writeFileSync(path, output)
  return { name: `${probeId}.log`, path, kind: 'log', sizeBytes: Buffer.byteLength(output) }
}

/** The machine-readable per-run table of a benchmark probe (T-018) — the
 *  FIRST producer of the 'report' evidence-artifact kind: written beside the
 *  bundle as <probeId>.results.json. When no repeat ran (every spawn
 *  refused) the table carries an empty durationsMs and no summary fields —
 *  nothing fabricated. */
function resultsArtifact(
  environment: EnvironmentSpec,
  results: {
    probeId: string
    scenarioId: string
    repeats: number
    durationsMs: number[]
    minMs?: number
    medianMs?: number
    p95Ms?: number
  },
): EvidenceArtifactRef {
  const dir = probeEvidenceDir(environment.artifactsDir, environment.candidateId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${results.probeId}.results.json`)
  const body = JSON.stringify(results, null, 2)
  writeFileSync(path, body)
  return { name: `${results.probeId}.results.json`, path, kind: 'report', sizeBytes: Buffer.byteLength(body) }
}

// ---------- CommandProbe: the exit-0 evidence probe ----------

/** §12.1's Command Probe, narrowed to the documented split (module docblock,
 *  reconciliation 3): success = exit 0. It parses NOTHING — exit code and
 *  duration live in the bundle's GateResult entry; the full combined output
 *  is written to <artifactsDir>/probes/<candidateId>/<probeId>.log and
 *  referenced as an EvidenceArtifactRef. */
export class CommandProbe implements Probe {
  readonly id: string
  readonly scenario: ScenarioSpec

  constructor(scenario: ScenarioSpec) {
    this.id = scenario.id
    this.scenario = scenario
  }

  async run(input: ProbeInput): Promise<EvidenceBundle> {
    const s = input.scenario
    const timeoutMs = s.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    const execution = await executeProbeCommand(s.command, input.workspace.path, timeoutMs)
    const success = execution.spawnError === undefined && !execution.timedOut && execution.exitCode === 0
    let error: string | undefined
    if (execution.spawnError !== undefined) {
      error = `command could not be spawned: ${execution.spawnError}`
    } else if (execution.timedOut) {
      error = `command timed out after ${timeoutMs}ms`
    }
    const bundle: EvidenceBundle = {
      probeId: this.id,
      scenarioId: s.id,
      success,
      artifacts: [logArtifact(input.environment, this.id, execution.output)],
      measurements: [],
      gateResults: [toGateResult(this.id, execution, { passed: success })],
      ...(error !== undefined ? { error } : {}),
    }
    return bundle
  }
}

// ---------- TestProbe: the TAP-parsing probe ----------

interface TapSummary {
  tests: number
  pass: number
  fail: number
}

/**
 * Parse a TAP stream into tests/pass/fail (the documented measurement
 * vocabulary): TAP 14 summary lines (`# tests` / `# pass` / `# fail`) when
 * present — what `node --test` emits — counted `ok` / `not ok` lines
 * otherwise (every such line, including indented subtests). Returns null
 * when nothing could be parsed: a probe that parsed nothing is never a
 * pass (AGENTS.md rule 7 applied to bundles — an empty bundle is a recorded
 * fact, never a success).
 */
export function parseTapSummary(output: string): TapSummary | null {
  let tests: number | null = null
  let pass: number | null = null
  let fail: number | null = null
  let okLines = 0
  let notOkLines = 0
  for (const line of output.split(/\r?\n/)) {
    const summary = /^#\s*(tests|pass|fail)\s+(\d+)\s*$/.exec(line)
    if (summary) {
      const n = Number(summary[2])
      if (summary[1] === 'tests') tests = n
      else if (summary[1] === 'pass') pass = n
      else fail = n
      continue
    }
    if (/^\s*ok\b/.test(line)) okLines++
    else if (/^\s*not ok\b/.test(line)) notOkLines++
  }
  if (tests !== null && pass !== null && fail !== null) {
    return { tests, pass, fail }
  }
  if (okLines + notOkLines > 0) {
    return { tests: okLines + notOkLines, pass: okLines, fail: notOkLines }
  }
  return null
}

/** §12.1's Test Probe (the documented split): runs a test command and
 *  requires TAP output. Success = exit 0 AND parseable TAP AND fail count 0.
 *  Measurements: tests/pass/fail (empty when nothing parsed). Exit 0 with
 *  unparseable output → success false, never a pass. */
export class TestProbe implements Probe {
  readonly id: string
  readonly scenario: ScenarioSpec

  constructor(scenario: ScenarioSpec) {
    this.id = scenario.id
    this.scenario = scenario
  }

  async run(input: ProbeInput): Promise<EvidenceBundle> {
    const s = input.scenario
    const timeoutMs = s.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    const execution = await executeProbeCommand(s.command, input.workspace.path, timeoutMs)
    const tap = parseTapSummary(execution.output)
    let success = false
    let error: string | undefined
    if (execution.spawnError !== undefined) {
      error = `test command could not be spawned: ${execution.spawnError}`
    } else if (execution.timedOut) {
      error = `test command timed out after ${timeoutMs}ms`
    } else if (tap === null) {
      error = 'TAP output unparseable: no summary lines and no ok/not ok lines — parsed nothing, never a pass'
    } else if (execution.exitCode !== 0) {
      error = `test command exited with code ${execution.exitCode}`
    } else if (tap.fail > 0) {
      error = `TAP reports ${tap.fail} failing test(s)`
    } else {
      success = true
    }
    const bundle: EvidenceBundle = {
      probeId: this.id,
      scenarioId: s.id,
      success,
      artifacts: [logArtifact(input.environment, this.id, execution.output)],
      measurements: tap === null ? [] : [
        { name: 'tests', value: tap.tests },
        { name: 'pass', value: tap.pass },
        { name: 'fail', value: tap.fail },
      ],
      gateResults: [toGateResult(this.id, execution, { passed: success })],
      ...(error !== undefined ? { error } : {}),
    }
    return bundle
  }
}

/** The nearest-rank order statistic (the documented percentile convention,
 *  module docblock): for quantile q over the ascending-sorted durations the
 *  value is sorted[ceil(q·n)−1] — no interpolation, stdlib sort only. */
function nearestRank(sorted: number[], q: number): number {
  return sorted[Math.ceil(q * sorted.length) - 1]!
}

/** §12.1's Benchmark Probe (T-018; §12.1:907-909 names it in one line and
 *  defines nothing — the semantics are the module-docblock choices):
 *  runs the scenario's command `repeats` times, sequentially, each through
 *  the shared executeProbeCommand core (list-form spawn, T-011 verified tree
 *  kill — no second spawn path), and records QUANTITATIVE measurements —
 *  the first probe producing structured numbers rather than pass/fail
 *  evidence. It RECORDS, never JUDGES: no threshold/assertion input exists
 *  on the scenario or here (decisions.md 2026-10-10), and the verdict
 *  ladder is gate-only, untouched by construction.
 *
 *   - repeats: required positive integer >= 1 on a benchmark scenario
 *     (parseJobsSpec enforces; refused on other probe types). Each repeat
 *     gets the FULL timeoutMs budget (default DEFAULT_PROBE_TIMEOUT_MS) —
 *     a per-repeat budget, total wall time bounded by repeats × timeoutMs.
 *   - Every requested repeat runs, sequentially, regardless of earlier
 *     outcomes — evidence about failures is evidence. Measurements are
 *     recorded regardless of success: one `run-<i> duration` (unit ms)
 *     per repeat that actually ran (a non-zero exit or a timeout still
 *     ran — its durationMs is real wall-clock evidence), plus min/median/
 *     p95 (unit ms) over the recorded durations, each the nearest-rank
 *     order statistic. A spawn-refused repeat produced no run: no
 *     `run-<i>` duration for it.
 *   - Success = EVERY requested repeat spawned cleanly, exited 0, and did
 *     not time out. `error` names the FIRST failing repeat with counts
 *     ("run 2/5 exited with code 3" / "run 3/5 timed out after Nms" /
 *     "run 1/5 could not be spawned: ENOENT"). A benchmark that completes
 *     zero repeats is success: false, never a pass (AGENTS.md #7 applied
 *     to bundles).
 *   - Artifacts: the combined output of all repeats in one .log artifact
 *     with `=== run <i> ===` separators, plus the 'report'-kind results
 *     artifact <probeId>.results.json — the machine-readable per-run table
 *     {probeId, scenarioId, repeats, durationsMs, minMs, medianMs, p95Ms}.
 *   - gateResults: one GateResult entry per repeat, in run order, named
 *     '<probeId>#run-<i>' so each repeat's evidence row is self-naming. */
export class BenchmarkProbe implements Probe {
  readonly id: string
  readonly scenario: ScenarioSpec

  constructor(scenario: ScenarioSpec) {
    this.id = scenario.id
    this.scenario = scenario
  }

  async run(input: ProbeInput): Promise<EvidenceBundle> {
    const s = input.scenario
    const repeats = s.repeats ?? 0
    const timeoutMs = s.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    const durations: number[] = []
    const measurements: Measurement[] = []
    const gateResults: GateResult[] = []
    const logParts: string[] = []
    let firstError: string | undefined
    for (let i = 1; i <= repeats; i++) {
      logParts.push(`=== run ${i} ===`)
      const execution = await executeProbeCommand(s.command, input.workspace.path, timeoutMs)
      logParts.push(execution.output)
      const repeatPassed = execution.spawnError === undefined && !execution.timedOut && execution.exitCode === 0
      gateResults.push(toGateResult(`${this.id}#run-${i}`, execution, { passed: repeatPassed }))
      if (execution.spawnError === undefined) {
        // The repeat ran — its wall-clock duration is evidence even when it
        // failed or timed out. A spawn refusal produced no run: no duration.
        durations.push(execution.durationMs)
        measurements.push({ name: `run-${i} duration`, value: execution.durationMs, unit: 'ms' })
      }
      if (firstError === undefined) {
        if (execution.spawnError !== undefined) {
          firstError = `run ${i}/${repeats} could not be spawned: ${execution.spawnError}`
        } else if (execution.timedOut) {
          firstError = `run ${i}/${repeats} timed out after ${timeoutMs}ms`
        } else if (execution.exitCode !== 0) {
          firstError = `run ${i}/${repeats} exited with code ${execution.exitCode}`
        }
      }
    }
    // Nearest-rank summaries over the recorded durations — omitted entirely
    // when no repeat ran (nothing measured, nothing fabricated).
    let minMs: number | undefined
    let medianMs: number | undefined
    let p95Ms: number | undefined
    if (durations.length > 0) {
      const sorted = [...durations].sort((a, b) => a - b)
      minMs = sorted[0]!
      medianMs = nearestRank(sorted, 0.5)
      p95Ms = nearestRank(sorted, 0.95)
      measurements.push(
        { name: 'min', value: minMs, unit: 'ms' },
        { name: 'median', value: medianMs, unit: 'ms' },
        { name: 'p95', value: p95Ms, unit: 'ms' },
      )
    }
    // Zero completed repeats is never a pass (AGENTS.md #7 applied to
    // bundles): repeats >= 1 && durations.length === repeats is exactly
    // "every requested repeat spawned cleanly", which success also requires.
    const success = firstError === undefined && repeats >= 1 && durations.length === repeats
    const bundle: EvidenceBundle = {
      probeId: this.id,
      scenarioId: s.id,
      success,
      artifacts: [
        logArtifact(input.environment, this.id, logParts.join('\n')),
        resultsArtifact(input.environment, {
          probeId: this.id,
          scenarioId: s.id,
          repeats,
          durationsMs: durations,
          ...(minMs !== undefined ? { minMs } : {}),
          ...(medianMs !== undefined ? { medianMs } : {}),
          ...(p95Ms !== undefined ? { p95Ms } : {}),
        }),
      ],
      measurements,
      gateResults,
      ...(firstError !== undefined ? { error: firstError } : {}),
    }
    return bundle
  }
}

/** The --jobs probe factory: the parsed ScenarioSpec's type has already been
 *  narrowed to 'command' | 'test' | 'benchmark' by parseJobsSpec
 *  (src/scheduler.ts). */
export function createProbe(scenario: ScenarioSpec): Probe {
  switch (scenario.type) {
    case 'test':
      return new TestProbe(scenario)
    case 'benchmark':
      return new BenchmarkProbe(scenario)
    default:
      return new CommandProbe(scenario)
  }
}
