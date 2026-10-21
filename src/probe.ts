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
//   - Web/server semantics (T-024; the spec defines NO server-lifecycle
//     probe anywhere — §12.1:925-935's "Web Probe" is browser automation
//     (load page, interact, console/network errors, accessibility tree,
//     viewport matrix, performance metrics) and needs a browser dependency;
//     chosen and documented here, the T-007/T-012/T-013/T-018/T-019
//     precedent). The scenario carries `url`: a REQUIRED, non-empty
//     http:// or https:// URL — the address the probe polls for readiness
//     and captures, and the one ScenarioSpec field pointing OUTSIDE the
//     workspace (absolute by nature — documented; its operator-chosen port
//     is machine-global: two concurrently-running probes aimed at one port
//     collide, and no ephemeral-port scheme exists this slice). The
//     lifecycle is a LAUNCH-WITHOUT-AWAITING-EXIT beside the
//     run-to-completion executeProbeCommand core: launchTarget spawns the
//     scenario command in the workspace (list-form, windowsHide, refusal
//     recorded never thrown) and returns the LIVE child handle; a bounded
//     readiness poll (stdlib global `fetch` — zero new dependencies per
//     decisions.md 2026-10-10; WEB_PROBE_POLL_INTERVAL_MS between attempts;
//     ONE timeoutMs budget from launch, each attempt aborted at it) runs
//     until the first poll response that CONNECTS — that response IS the
//     capture (status read; body read capped at WEB_PROBE_MAX_BODY_BYTES —
//     the probe records what it read, never the whole body; the artifact's
//     bodySnippet further bounded at WEB_PROBE_SNIPPET_BYTES) — or a face
//     ends the poll first: spawn refusal, the target exiting before
//     readiness (fail-fast, the exit named), or deadline expiry (the last
//     poll error named, e.g. connection refused). Teardown is the T-011
//     verified tree kill (killTreeVerified) on EVERY path while the target
//     is live — after the capture, after every failure face, at deadline
//     expiry; unproven kill outcomes land on the GateResult cleanupFailures
//     (evidence only); nothing-to-kill (spawn refusal, target already
//     exited) is recorded honestly, never fabricated, and a just-exited pid
//     is never taskkilled (the executeProbeCommand boundary rule: a
//     just-exited or reused pid is not ours to kill). Success = target
//     launched AND url ready within the deadline AND the captured response
//     is 2xx AND its body non-empty — no threshold/assertion field of any
//     kind: 2xx + non-empty body is the documented evidence shape; the
//     probe records, never judges (decisions.md 2026-10-10), and `error`
//     names the first failed face (spawn refused / target exited before
//     readiness / readiness deadline expired / non-2xx status / empty
//     body). A probe that captured no response is success: false, NEVER a
//     pass (AGENTS.md #7 applied to bundles — the T-015 posture), and a
//     success:false web bundle changes nothing downstream — the ladder
//     (src/runner.ts) is untouched by construction. Measurements (recorded
//     whenever their face applies — evidence about failures is evidence):
//     `http status` (the captured status code), `body bytes` (unit bytes —
//     what the capped read actually read), `ready duration` (unit ms —
//     launch to the first connected response, recorded whenever readiness
//     was reached, even on later failure faces). Artifacts: the standard
//     .log (launch banner + poll attempts + child output + capture outcome
//     + teardown outcome) plus <probeId>.response.json, kind 'report' (the
//     kind's second producer; {url, status, contentType?, bodySnippet,
//     bodyBytes} — the bounded snippet keeps the file bounded whatever the
//     served body was).
//   - Screenshot semantics (T-019, §34:2069 — the spec defines NO Screenshot
//     Probe; screenshots appear only as capabilities of the Godot probe
//     (§12.1:919) and Web probe (§12.1:931) and as an Artifact example
//     (§6.8:479); chosen and documented here, the
//     T-007/T-012/T-013/T-018 precedent). The scenario carries `capture`: a
//     REQUIRED, non-empty, workspace-relative path naming the PNG file the
//     capture command must have written INSIDE the disposable workspace by
//     the time it exits (absolute paths and any '..' segment are refused —
//     the evidence contract stays local to the worktree; the durable copy is
//     the probe's job, not the command's). The seam runs the capture command
//     ONCE through the shared executeProbeCommand core (one spawn path,
//     AGENTS.md #4, one full timeoutMs budget, the T-011 verified tree kill
//     at expiry): there is NO target-lifecycle concept and no "capture at a
//     given point" — launch, timing, and readiness are encapsulated inside
//     the operator's capture command (a command serving a URL then
//     screenshotting, or an inbox-OS screen capture, are both just
//     commands). Success = the command exited 0 AND the capture-named file
//     exists AND is at least MIN_PNG_BYTES (33 — the smallest
//     syntactically-possible PNG: the 8-byte signature + one 25-byte IHDR
//     chunk) AND starts with the 8-byte PNG signature — PNG-ONLY this
//     slice. A zero-byte, missing, truncated, or non-PNG capture is
//     success: false, NEVER a pass (AGENTS.md #7 applied to image evidence
//     — the T-015 posture); `error` names the first failed face (spawn
//     refused / timed out / exit N / capture file missing / below floor /
//     bad magic). The durable copy is the point: on success the image is
//     COPIED to <artifactsDir>/probes/<candidateId>/<probeId>.png and
//     referenced as a kind-'screenshot' EvidenceArtifactRef — the workspace
//     is disposed immediately after the attempt loop (src/runner.ts), so an
//     image left at its scenario-named path would be destroyed. This is the
//     'screenshot' artifact kind's first producer. Measurements:
//     `capture duration` (unit ms — the execution's durationMs, recorded
//     whenever the command actually ran) and `image bytes` (unit bytes,
//     recorded whenever the capture file exists — even on success:false
//     faces; evidence about failures is evidence). Dimensions and any
//     pixel-content assertion are successor slices (§6.8:480-481). No
//     verdict input of any kind: a success:false screenshot bundle changes
//     nothing downstream (decisions.md 2026-10-10).
//
// Every probe subprocess is list-form `spawn` (never `exec` — AGENTS.md #4,
// stricter than CommandGate's operator-typed shell strings), with the T-011
// verified tree kill at timeout via src/kill-tree.ts. Unproven kill outcomes
// land on the bundle's GateResult `cleanupFailures` — evidence only.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { killFailureLines, killSuccessLine, killTreeVerified } from './kill-tree.js'
import type { GateResult, WorkspaceLease } from './types.js'

/** The generic probe types landed so far (§34:2061-2072's start list;
 *  `benchmark` landed with T-018 — the first Measurement producer — and
 *  `screenshot` with T-019 — the first directly human-reviewable evidence;
 *  `web` with T-024 — the first launch-without-awaiting-exit lifecycle: a
 *  long-running server target, readiness-polled and verified-torn-down
 *  under one timeout budget). Godot/Blender probes and browser-automation
 *  Web proper (§12.1:925-935) are successor slices. */
export type ProbeType = 'command' | 'test' | 'benchmark' | 'screenshot' | 'web'

/** Kind of an evidence artifact file (§12.1 names logs, screenshots, video).
 *  Producers so far write `log` (every probe's combined output), `report`
 *  (T-018's benchmark per-run results table — that kind's first producer),
 *  and `screenshot` (T-019's durable image copy under the run artifacts
 *  dir — that kind's first producer); the vocabulary is documented, not
 *  grown speculatively. */
export type EvidenceArtifactKind = 'log' | 'report' | 'screenshot'

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
  /** Screenshot probes only (T-019): REQUIRED, non-empty, workspace-relative
   *  path naming the PNG file the capture command must have written INSIDE
   *  the disposable workspace by the time it exits. Absolute paths and any
   *  '..' segment are refused — the evidence contract stays local to the
   *  worktree; the durable copy is the probe's job, not the command's.
   *  REFUSED on every other probe type: the field exists only where it
   *  means something (the `repeats` precedent). Enforced by parseJobsSpec
   *  (src/scheduler.ts); this type carries it optionally because the union
   *  is shared. */
  capture?: string
  /** Web probes only (T-024): REQUIRED, non-empty http:// or https:// URL —
   *  the address the probe polls for readiness and captures. The ONE
   *  ScenarioSpec field pointing outside the workspace (absolute by nature
   *  — documented), and its operator-chosen port is machine-global: two
   *  concurrently-running probes aimed at one port collide (no
   *  ephemeral-port scheme this slice). REFUSED on every other probe type:
   *  the field exists only where it means something (the `repeats` /
   *  `capture` precedent). Enforced by parseJobsSpec (src/scheduler.ts);
   *  this type carries it optionally because the union is shared. */
  url?: string
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

/** The PNG size floor (T-019, pinned by Gate 1.15): 33 bytes — the smallest
 *  syntactically-possible PNG (the 8-byte signature + one 25-byte IHDR
 *  chunk). Anything smaller cannot be a PNG, so the floor is checked BEFORE
 *  the signature: a zero-byte, truncated, or otherwise undersized capture is
 *  success: false, never a pass (AGENTS.md #7 applied to image evidence). */
export const MIN_PNG_BYTES = 33

/** The 8-byte PNG signature every captured image must start with. */
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The web probe's readiness-poll interval (T-024, pinned by Gate 1.15):
 *  sleep between poll attempts of `url`. The poll itself is bounded by the
 *  ONE timeoutMs budget from launch — the interval only spaces the
 *  attempts, it never extends the deadline. */
export const WEB_PROBE_POLL_INTERVAL_MS = 250

/** The web probe's body-read cap (T-024, pinned by Gate 1.15): the capture
 *  reads at most this many body bytes from the first connected response —
 *  the probe records what it read, never the whole body; an oversized body
 *  is cancelled past the cap. Evidence stays bounded; the cap bounds the
 *  evidence, it never judges it (the body content itself is recorded in
 *  the bounded 'report' artifact, never in a measurement). */
export const WEB_PROBE_MAX_BODY_BYTES = 1024 * 1024

/** The web probe's body-snippet bound (T-024, pinned by Gate 1.15): at most
 *  this many bytes of the read body, UTF-8-decoded, land in the response
 *  artifact's `bodySnippet` — the artifact stays bounded whatever the
 *  served body was (the validator accepts any finite measurement value,
 *  so body content is an artifact, never a measurement). */
export const WEB_PROBE_SNIPPET_BYTES = 2048

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
  if (v.kind !== 'log' && v.kind !== 'report' && v.kind !== 'screenshot') {
    refuse(`${where} kind must be "log", "report", or "screenshot" (got ${JSON.stringify(v.kind)})`)
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
  // T-027: command, if present, is a non-empty string (refuse '', refuse
  // non-string; absent accepted). Additive strictness — probe-bundle
  // GateResult entries are argv-form evidence of a different shape and stay
  // legitimately command-less.
  if (v.command !== undefined && (typeof v.command !== 'string' || v.command.length === 0)) {
    refuse(`${where} command, if present, must be a non-empty string`)
  }
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

/** A launched long-running target (T-024): the live child handle plus the
 *  launch/exit facts the WebProbe records — never thrown. */
interface LaunchedTarget {
  child: ChildProcess
  /** The spawn refusal's message (e.g. ENOENT) when the command never ran —
   *  recorded, never thrown. */
  spawnError: string | undefined
  /** The target's own process-exit facts, set by the 'exit' event the
   *  moment the process leaves the process table on its own: code on a
   *  normal exit, signal name when killed by a signal; both null while it
   *  is still live. */
  exitCode: number | null
  exitSignal: string | null
}

/**
 * Launch the scenario command WITHOUT awaiting its exit (T-024 — the
 * launch-without-awaiting-exit lifecycle beside the run-to-completion
 * executeProbeCommand core): list-form `spawn` (never exec — AGENTS.md #4),
 * `windowsHide`, cwd = the workspace path. A spawn refusal arrives as the
 * child's 'error' event and is recorded on the returned handle, never
 * thrown. The CALLER owns teardown: killTreeVerified on the returned
 * child's pid while it is live — and never a taskkill of an already-exited
 * child (the executeProbeCommand boundary rule: a just-exited or reused pid
 * is not ours to kill; the caller records nothing-to-kill honestly
 * instead).
 */
function launchTarget(command: { exe: string; args: string[] }, cwd: string): LaunchedTarget {
  const child = spawn(command.exe, command.args, { cwd, windowsHide: true })
  const target: LaunchedTarget = { child, spawnError: undefined, exitCode: null, exitSignal: null }
  child.on('error', (err) => {
    if (target.spawnError === undefined) target.spawnError = err.message
  })
  child.on('exit', (code, signal) => {
    target.exitCode = code
    target.exitSignal = signal
  })
  return target
}

/** The poll's sleep — the only wall-clock wait in the web lifecycle, always
 *  capped by the caller to the remaining budget. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** One poll failure, named usefully: undici surfaces a refused connection as
 *  `TypeError: fetch failed` with the real cause (e.g. `connect ECONNREFUSED
 *  127.0.0.1:PORT`) on `error.cause` — the recorded last-poll-error carries
 *  the cause so the evidence names what actually happened (e.g. connection
 *  refused), not just "fetch failed". */
function describePollError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined
  return cause !== undefined && !message.includes(cause) ? `${message} (${cause})` : message
}

/**
 * Read a fetch response's body, capped at `capBytes` (T-024's documented
 * body-read cap): chunks are accumulated only until the cap is reached, the
 * stream is cancelled past it, and exactly the first capBytes are returned.
 * A response with no body stream (or an already-empty one) reads as zero
 * bytes — recorded, never fabricated. An abort (the caller's deadline) is
 * NOT swallowed here: the in-flight read rejects and the poll loop records
 * the face.
 */
async function readBodyCapped(res: Response, capBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (reader === undefined) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (total < capBytes) {
      const { done, value } = await reader.read()
      if (done || value === undefined) break
      chunks.push(Buffer.from(value))
      total += value.byteLength
    }
  } finally {
    // Cancel whatever remains — an oversized or un-consumed body is never
    // fully read. Cancel on a stream that already ended (or was aborted by
    // the deadline) may reject; that is nothing to report — the read is over.
    try {
      await reader.cancel()
    } catch {
      // Already closed, cancelled, or aborted.
    }
  }
  return Buffer.concat(chunks).subarray(0, capBytes)
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

/** The machine-readable capture record of a web probe (T-024) — the
 *  'report' evidence-artifact kind's SECOND producer (T-018's benchmark
 *  results table is the first): written beside the bundle as
 *  <probeId>.response.json. The snippet is bounded (WEB_PROBE_SNIPPET_BYTES
 *  — see the module docblock), so the file stays bounded whatever the
 *  served body was. Written only when a response was actually captured —
 *  a probe that captured nothing fabricates no artifact. */
function responseArtifact(
  environment: EnvironmentSpec,
  response: {
    probeId: string
    scenarioId: string
    url: string
    status: number
    contentType?: string
    bodySnippet: string
    bodyBytes: number
  },
): EvidenceArtifactRef {
  const dir = probeEvidenceDir(environment.artifactsDir, environment.candidateId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${response.probeId}.response.json`)
  const body = JSON.stringify(response, null, 2)
  writeFileSync(path, body)
  return { name: `${response.probeId}.response.json`, path, kind: 'report', sizeBytes: Buffer.byteLength(body) }
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

/** §12.1's Screenshot Probe (T-019; §34:2069 names `screenshot artifact
 *  probe` in Milestone 4's start list and the spec defines nothing — the
 *  semantics are the module-docblock choices): runs the scenario's capture
 *  command ONCE through the shared executeProbeCommand core (list-form
 *  spawn, full timeoutMs budget, the T-011 verified tree kill at expiry —
 *  no second spawn path, no target lifecycle: launch, timing, and readiness
 *  are encapsulated inside the operator's capture command), then requires
 *  that command to have written a PNG at the scenario's `capture`
 *  workspace-relative path.
 *
 *   - capture: required non-empty workspace-relative path (parseJobsSpec
 *     enforces; absolute paths and '..' segments refused there, and the
 *     class holds the contract too for a directly constructed scenario —
 *     a refusal here is a thrown Error, recorded by the runner's
 *     failedBundle path, never a crash of the run).
 *   - Success = the command exited 0 AND the capture file exists AND is
 *     >= MIN_PNG_BYTES AND starts with PNG_MAGIC — PNG-only this slice.
 *     `error` names the FIRST failed face, in that order.
 *   - The durable copy is the point: on success the image is COPIED to
 *     <artifactsDir>/probes/<candidateId>/<probeId>.png (the workspace is
 *     disposed right after the attempt loop) and referenced as a
 *     kind-'screenshot' artifact whose sizeBytes is the copied file's.
 *   - Measurements (recorded regardless of success whenever their face
 *     applies — evidence about failures is evidence): `capture duration`
 *     (unit ms) whenever the command actually ran (a spawn refusal
 *     produced no run), `image bytes` (unit bytes) whenever the capture
 *     file exists.
 *   - gateResults: one GateResult entry for the one execution. */
export class ScreenshotProbe implements Probe {
  readonly id: string
  readonly scenario: ScenarioSpec

  constructor(scenario: ScenarioSpec) {
    this.id = scenario.id
    this.scenario = scenario
  }

  async run(input: ProbeInput): Promise<EvidenceBundle> {
    const s = input.scenario
    const capture = s.capture ?? ''
    const captureError = this.captureRefusal(capture)
    if (captureError !== null) throw new Error(`screenshot probe '${this.id}': ${captureError}`)
    const timeoutMs = s.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    const execution = await executeProbeCommand(s.command, input.workspace.path, timeoutMs)
    const capturePath = join(input.workspace.path, capture)
    let captureBytes: number | null = null
    if (existsSync(capturePath)) {
      captureBytes = statSync(capturePath).size
    }
    const measurements: Measurement[] = []
    if (execution.spawnError === undefined) {
      // The command ran — its wall-clock duration is evidence even when it
      // failed or timed out. A spawn refusal produced no run: no duration.
      measurements.push({ name: 'capture duration', value: execution.durationMs, unit: 'ms' })
    }
    if (captureBytes !== null) {
      measurements.push({ name: 'image bytes', value: captureBytes, unit: 'bytes' })
    }
    let success = false
    let error: string | undefined
    if (execution.spawnError !== undefined) {
      error = `capture command could not be spawned: ${execution.spawnError}`
    } else if (execution.timedOut) {
      error = `capture command timed out after ${timeoutMs}ms`
    } else if (execution.exitCode !== 0) {
      error = `capture command exited with code ${execution.exitCode}`
    } else if (captureBytes === null) {
      error = `capture file missing: no file at '${capture}' inside the workspace after the capture command exited 0`
    } else if (captureBytes < MIN_PNG_BYTES) {
      error = `capture file below the PNG size floor: ${captureBytes} bytes < ${MIN_PNG_BYTES} (zero-byte, truncated, or undersized captures are never a pass)`
    } else if (!readFileSync(capturePath).subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      error = `capture file at '${capture}' is not a PNG (bad magic bytes)`
    } else {
      success = true
    }
    const logRef = logArtifact(input.environment, this.id, execution.output)
    let imageRef: EvidenceArtifactRef | undefined
    if (success && captureBytes !== null) {
      // The durable copy (the workspace goes away at dispose — this copy is
      // what outlives it): <artifactsDir>/probes/<candidateId>/<probeId>.png
      const dir = probeEvidenceDir(input.environment.artifactsDir, input.environment.candidateId)
      mkdirSync(dir, { recursive: true })
      const imagePath = join(dir, `${this.id}.png`)
      copyFileSync(capturePath, imagePath)
      imageRef = {
        name: `${this.id}.png`,
        path: imagePath,
        kind: 'screenshot',
        sizeBytes: statSync(imagePath).size,
      }
    }
    const bundle: EvidenceBundle = {
      probeId: this.id,
      scenarioId: s.id,
      success,
      artifacts: imageRef !== undefined ? [logRef, imageRef] : [logRef],
      measurements,
      gateResults: [toGateResult(this.id, execution, { passed: success })],
      ...(error !== undefined ? { error } : {}),
    }
    return bundle
  }

  /** The capture-path contract for a directly constructed scenario (the
   *  parseJobsSpec refusals are the --jobs enforcement point; this keeps a
   *  hand-built scenario from silently escaping the same rule). */
  private captureRefusal(capture: string): string | null {
    if (typeof capture !== 'string' || capture.length === 0) {
      return 'capture must be a non-empty workspace-relative path'
    }
    return null
  }
}

/** §12.1 territory's server-lifecycle probe (T-024; the spec defines no
 *  server-lifecycle probe anywhere — §12.1:925-935's "Web Probe" is browser
 *  automation; the semantics are the module-docblock choices): LAUNCHES the
 *  scenario command as a long-running target and does NOT await its exit,
 *  polls `url` for readiness, captures the first connected response, and
 *  tears the target down — all under ONE timeoutMs budget (default
 *  DEFAULT_PROBE_TIMEOUT_MS) from launch.
 *
 *   - url: required non-empty http(s) URL (parseJobsSpec enforces; the
 *     class holds the contract too for a directly constructed scenario —
 *     a refusal here is a thrown Error, recorded by the runner's
 *     failedBundle path, never a crash of the run, and never a silent
 *     5-minute poll of a malformed scenario). The one ScenarioSpec field
 *     pointing outside the workspace; its operator-chosen port is
 *     machine-global (the documented limitation).
 *   - The lifecycle: launchTarget (list-form spawn, windowsHide, refusal
 *     recorded never thrown) → a bounded readiness poll of `url` (stdlib
 *     global `fetch`, zero new deps; WEB_PROBE_POLL_INTERVAL_MS between
 *     attempts; every attempt aborted at the deadline; the poll fail-fasts
 *     the moment the target exits before readiness) → the first poll
 *     response that CONNECTS is the capture (status read; body read capped
 *     at WEB_PROBE_MAX_BODY_BYTES; the artifact's bodySnippet further
 *     bounded at WEB_PROBE_SNIPPET_BYTES). A face that ends the poll
 *     without a capture: spawn refusal / target exited before readiness
 *     (the exit named) / deadline expiry (the last poll error named).
 *   - Teardown on EVERY path: killTreeVerified on the live target — after
 *     a successful capture, after every failure face, at deadline expiry;
 *     unproven kill outcomes land on the GateResult's cleanupFailures
 *     (evidence only). Nothing-to-kill (spawn refusal, target already
 *     exited) is recorded in the log honestly, never fabricated, and a
 *     just-exited pid is never taskkilled (pid reuse — the
 *     executeProbeCommand boundary rule).
 *   - Success = target launched AND url ready within the deadline AND the
 *     captured response is 2xx AND its body non-empty. `error` names the
 *     FIRST failed face. A probe that captured no response is success:
 *     false, never a pass (AGENTS.md #7). No threshold/assertion input of
 *     any kind — 2xx + non-empty body is the documented evidence shape;
 *     the probe records, never judges (decisions.md 2026-10-10).
 *   - Measurements (recorded whenever their face applies — evidence about
 *     failures is evidence): `http status` (the captured status code),
 *     `body bytes` (unit bytes — what the capped read actually read),
 *     `ready duration` (unit ms — launch to the first connected response,
 *     recorded whenever readiness was reached, even on later failure
 *     faces). A capture-failed face records none of them (readiness was
 *     never reached); a spawn refusal records none (nothing ran).
 *   - Artifacts: the standard `.log` (launch banner + poll attempts +
 *     child output + capture/teardown outcome), plus — only when a
 *     response was captured — the kind-'report' response artifact
 *     <probeId>.response.json ({url, status, contentType?, bodySnippet,
 *     bodyBytes}).
 *   - gateResults: one GateResult entry for the whole lifecycle; exitCode
 *     is the target's own exit code when it exited on its own before
 *     teardown, null otherwise (still live at teardown / killed by the
 *     verified tree kill / spawn refused); durationMs spans launch through
 *     teardown's conclusion. */
export class WebProbe implements Probe {
  readonly id: string
  readonly scenario: ScenarioSpec

  constructor(scenario: ScenarioSpec) {
    this.id = scenario.id
    this.scenario = scenario
  }

  async run(input: ProbeInput): Promise<EvidenceBundle> {
    const s = input.scenario
    const url = s.url ?? ''
    // The url contract for a directly constructed scenario (the
    // parseJobsSpec refusals are the --jobs enforcement point; this keeps a
    // hand-built scenario from silently escaping the same rule — or from
    // silently burning the whole timeout polling a garbage url).
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(`web probe '${this.id}': url must be a non-empty http(s) URL`)
    }
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      throw new Error(`web probe '${this.id}': url must be an http:// or https:// URL (got ${JSON.stringify(url)})`)
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`web probe '${this.id}': url must be an http:// or https:// URL (got ${JSON.stringify(url)})`)
    }

    const timeoutMs = s.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    const started = Date.now()
    const deadline = started + timeoutMs
    const logParts: string[] = []
    const measurements: Measurement[] = []
    let responseRef: EvidenceArtifactRef | undefined

    // Launch — without awaiting exit.
    const target = launchTarget(s.command, input.workspace.path)
    logParts.push('=== web probe launch ===')
    logParts.push(`$ ${[s.command.exe, ...s.command.args].join(' ')} (list-form, cwd=${input.workspace.path})`)
    // Child stdout+stderr, collected for the log (the 16 MiB CommandGate
    // posture) — a server that announces itself (pid, bind) leaves that
    // evidence here.
    let childOutput = ''
    target.child.stdout?.on('data', (chunk: string) => { if (childOutput.length < 16 * 1024 * 1024) childOutput += chunk })
    target.child.stderr?.on('data', (chunk: string) => { if (childOutput.length < 16 * 1024 * 1024) childOutput += chunk })

    // The bounded readiness poll — ONE budget from launch.
    logParts.push(`=== readiness poll: ${url} (deadline ${timeoutMs}ms from launch) ===`)
    let captured: { status: number; contentType: string | undefined; body: Buffer; readyMs: number } | null = null
    let lastPollError: string | undefined
    let attempts = 0
    while (captured === null) {
      if (target.spawnError !== undefined) break
      if (target.exitCode !== null || target.exitSignal !== null) break
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      attempts++
      // Each attempt is aborted at the deadline — a server that accepts the
      // connection but never responds cannot stretch the budget.
      const ac = new AbortController()
      const abortTimer = setTimeout(() => ac.abort(), remaining)
      try {
        const res = await fetch(url, { signal: ac.signal })
        // The first poll response that connects IS the capture. The body
        // read stays deadline-bounded too: an abort mid-read rejects and is
        // recorded as the face's last poll error.
        const bodyTimer = setTimeout(() => ac.abort(), Math.max(0, deadline - Date.now()))
        let body: Buffer
        try {
          body = await readBodyCapped(res, WEB_PROBE_MAX_BODY_BYTES)
        } finally {
          clearTimeout(bodyTimer)
        }
        captured = {
          status: res.status,
          contentType: res.headers.get('content-type') ?? undefined,
          body,
          readyMs: Date.now() - started,
        }
      } catch (e) {
        lastPollError = describePollError(e)
        logParts.push(`poll attempt ${attempts} failed: ${lastPollError}`)
      } finally {
        clearTimeout(abortTimer)
      }
      if (captured === null) {
        const sleepMs = Math.min(WEB_PROBE_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))
        if (sleepMs > 0) await sleep(sleepMs)
      }
    }

    logParts.push(`=== child output (stdout+stderr, as collected) ===`)
    logParts.push(childOutput)

    // Teardown on EVERY path (the snapshot below is taken before the kill so
    // the GateResult's exitCode can never race the kill's own exit event).
    const preTeardownExit = target.exitCode
    const preTeardownSignal = target.exitSignal
    const cleanupFailures: string[] = []
    logParts.push('=== teardown ===')
    if (target.spawnError !== undefined) {
      logParts.push(`spawn refused: ${target.spawnError} — no target process to tear down`)
    } else if (preTeardownExit !== null || preTeardownSignal !== null) {
      const how = preTeardownSignal !== null ? `signal ${preTeardownSignal}` : `exit code ${preTeardownExit}`
      logParts.push(`target already exited (${how}) before teardown — nothing to kill (a just-exited or reused pid is never taskkilled)`)
    } else if (target.child.pid === undefined) {
      logParts.push('no root pid recorded for the launched target — nothing to kill')
    } else {
      const kill = killTreeVerified(target.child.pid)
      const killLines = killFailureLines(target.child.pid, kill)
      cleanupFailures.push(...killLines)
      logParts.push(killLines.length === 0 ? killSuccessLine(kill) : killLines.join('\n'))
    }
    const durationMs = Date.now() - started

    // The faces, in order: spawn refusal → captured (readiness WAS reached —
    // decide on the capture, even if the target exited afterwards) → exited
    // before readiness → deadline expiry.
    let success = false
    let error: string | undefined
    if (target.spawnError !== undefined) {
      error = `target could not be spawned: ${target.spawnError}`
    } else if (captured !== null) {
      // Readiness was reached — the three measurements are evidence even on
      // the failing status/body faces.
      measurements.push(
        { name: 'ready duration', value: captured.readyMs, unit: 'ms' },
        { name: 'http status', value: captured.status },
        { name: 'body bytes', value: captured.body.length, unit: 'bytes' },
      )
      const snippet = captured.body.subarray(0, WEB_PROBE_SNIPPET_BYTES).toString('utf8')
      responseRef = responseArtifact(input.environment, {
        probeId: this.id,
        scenarioId: s.id,
        url,
        status: captured.status,
        ...(captured.contentType !== undefined ? { contentType: captured.contentType } : {}),
        bodySnippet: snippet,
        bodyBytes: captured.body.length,
      })
      logParts.push(`=== captured === status ${captured.status}, ${captured.body.length} body bytes, ready in ${captured.readyMs}ms`)
      if (captured.status < 200 || captured.status > 299) {
        error = `captured HTTP status ${captured.status} is not 2xx`
      } else if (captured.body.length === 0) {
        error = 'captured response body is empty (0 bytes) — an empty body is never a pass'
      } else {
        success = true
      }
    } else if (preTeardownExit !== null || preTeardownSignal !== null) {
      const how = preTeardownSignal !== null ? `signal ${preTeardownSignal}` : `exit code ${preTeardownExit}`
      error = `target exited before readiness was reached (${how})`
    } else {
      error = `readiness deadline expired after ${timeoutMs}ms (last poll error: ${lastPollError ?? 'none recorded'})`
    }

    const gateResult: GateResult = {
      name: this.id,
      passed: success,
      exitCode: target.spawnError === undefined ? preTeardownExit : null,
      durationMs,
      outputTail: logParts.join('\n').slice(-TAIL_BYTES),
      ...(cleanupFailures.length > 0 ? { cleanupFailures } : {}),
    }
    const bundle: EvidenceBundle = {
      probeId: this.id,
      scenarioId: s.id,
      success,
      artifacts: responseRef !== undefined
        ? [logArtifact(input.environment, this.id, logParts.join('\n')), responseRef]
        : [logArtifact(input.environment, this.id, logParts.join('\n'))],
      measurements,
      gateResults: [gateResult],
      ...(error !== undefined ? { error } : {}),
    }
    return bundle
  }
}

/** The --jobs probe factory: the parsed ScenarioSpec's type has already been
 *  narrowed to 'command' | 'test' | 'benchmark' | 'screenshot' | 'web' by
 *  parseJobsSpec (src/scheduler.ts). */
export function createProbe(scenario: ScenarioSpec): Probe {
  switch (scenario.type) {
    case 'test':
      return new TestProbe(scenario)
    case 'benchmark':
      return new BenchmarkProbe(scenario)
    case 'screenshot':
      return new ScreenshotProbe(scenario)
    case 'web':
      return new WebProbe(scenario)
    default:
      return new CommandProbe(scenario)
  }
}
