// Context inspector (T-012) — read-only CLI over a context plan + packet.
//
//   npm run context -- --plan <path> --packet <path> [--json] [--run-root <path>]
//
// The pure-module + CLI split mirrors src/store/index.ts + src/dag.ts (the
// clean/integrate/dag standalone-entry pattern). Renders the §26.4:1748-1756
// fields — token budget (cap + per-layer ledger), mandatory/selected/
// distilled included artifacts, excluded artifacts with reasons, L3 source
// chains, context fingerprint (producerless components shown as no-producer)
// — the token-free precursor of the Milestone-7 §26.4 UI, exactly as the dag
// dump is §26.2's. `--json` emits the same structure as JSON — the future
// feed for that UI.
//
// Paths resolve absolute or against --run-root (default C:\swarm — same
// literal as src/cli.ts, decisions.md run root). Refusals exit non-zero
// BEFORE any body is printed (the T-005/T-006 refusal pattern): missing
// --plan/--packet, missing file, unparseable JSON, a packet failing
// validation (recorded ledger inconsistent with recomputation, or recorded
// total over cap), fingerprint mismatch on recompute. The CLI never writes:
// input files are byte-identical after an inspect (pinned by Gate 1.13).
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  ContextRefusal,
  fingerprintHashOf,
  parseContextPlan,
  planHashOf,
  type ArtifactRef,
  type ContextLayer,
  type ContextPacket,
  type ManifestEntry,
} from './context.js'

type ExcludedEntry = Extract<ManifestEntry, { disposition: 'excluded-by-plan' | 'excluded-by-budget' }>

const usage = `Inspect a context packet against its plan (read-only).

Usage:
  npm run context -- --plan <path> --packet <path> [options]

Options:
  --plan <path>      Context plan JSON (required)
  --packet <path>    Context packet JSON (required)
  --json             Emit the same structure as JSON
  --run-root <path>  Root relative paths resolve against (default: C:\\swarm)
  --help             Show this help

Renders the §26.4 fields: token budget (cap + per-layer ledger), the
per-layer included artifacts, excluded artifacts with reasons, Layer-3
source chains, and the context fingerprint. Refusals exit non-zero and
print no body: missing --plan/--packet, missing file, unparseable JSON,
a packet failing validation (recorded ledger inconsistent with
recomputation, or recorded total over cap), fingerprint mismatch on
recompute. The inspector never writes.`

interface Options {
  plan: string
  packet: string
  json: boolean
  runRoot: string
}

function parseArgs(argv: string[]): Options {
  const opts: { plan: string | null; packet: string | null; json: boolean; runRoot: string } = {
    plan: null,
    packet: null,
    json: false,
    runRoot: 'C:\\swarm',
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${arg}`)
      return v
    }
    switch (arg) {
      case '--plan': opts.plan = value(); break
      case '--packet': opts.packet = value(); break
      case '--json': opts.json = true; break
      case '--run-root': opts.runRoot = value(); break
      case '--help': case '-h': console.log(usage); process.exit(0)
      default: throw new Error(`unknown option: ${arg}\n\n${usage}`)
    }
  }
  if (!opts.plan) throw new Error(`--plan <path> is required\n\n${usage}`)
  if (!opts.packet) throw new Error(`--packet <path> is required\n\n${usage}`)
  return { plan: opts.plan, packet: opts.packet, json: opts.json, runRoot: opts.runRoot }
}

function refuse(message: string): never {
  console.error(`refused: ${message}`)
  process.exit(1)
}

/** Absolute paths pass through; everything else resolves against --run-root. */
function resolveInput(path: string, runRoot: string): string {
  return isAbsolute(path) ? path : join(runRoot, path)
}

function readJsonFile(path: string, what: string): unknown {
  if (!existsSync(path)) refuse(`no ${what} file at ${path}`)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    return refuse(`cannot read ${what} file at ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    refuse(`${what} file at ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

const LAYER_NAMES = { 1: 'mandatory', 2: 'primary', 3: 'distilled', 4: 'supporting' } as const

/** Structural validation of a packet against this slice's contract. Every
 * check refuses (no body) — the builder guarantees these; a packet that
 * fails them was not produced by this codebase or was tampered with. */
function validatePacketShape(packet: unknown): asserts packet is ContextPacket {
  if (!isPlainObject(packet)) refuse('packet: must be a JSON object')
  const p = packet as Record<string, unknown>
  if (p.jobId !== null && !isNonEmptyString(p.jobId)) refuse('packet: "jobId" must be a non-empty string or null')
  if (!isPlainObject(p.layers)) refuse('packet: "layers" must be an object')
  const layers = p.layers as Record<string, unknown>
  for (const name of ['mandatory', 'primary', 'distilled', 'supporting']) {
    if (!Array.isArray(layers[name])) refuse(`packet: "layers.${name}" must be an array`)
  }
  const layerNumbers: Record<string, ContextLayer> = { mandatory: 1, primary: 2, distilled: 3, supporting: 4 }
  for (const [name, num] of Object.entries(layerNumbers)) {
    for (const [i, ref] of (layers[name] as unknown[]).entries()) {
      const label = `packet: layers.${name}[${i}]`
      if (!isPlainObject(ref)) refuse(`${label}: must be an object`)
      const r = ref as Record<string, unknown>
      if (!isNonEmptyString(r.id)) refuse(`${label}: "id" must be a non-empty string`)
      if (!isNonEmptyString(r.type)) refuse(`${label}: "type" must be a non-empty string`)
      if (!isNonEmptyString(r.contentHash)) refuse(`${label}: "contentHash" must be a non-empty string`)
      if (!isFiniteNumber(r.sizeBytes) || r.sizeBytes < 0) refuse(`${label}: "sizeBytes" must be a non-negative number`)
      if (!Number.isInteger(r.estimatedTokens) || (r.estimatedTokens as number) < 0) {
        refuse(`${label}: "estimatedTokens" must be a non-negative integer`)
      }
      if (r.layer !== num) refuse(`${label}: "layer" must be ${num} inside layers.${name}`)
      if (num === 3) {
        if (!Array.isArray(r.sourceRefs) || (r.sourceRefs as unknown[]).length === 0 || !(r.sourceRefs as unknown[]).every(isNonEmptyString)) {
          refuse(`${label}: a Layer-3 entry must carry a non-empty "sourceRefs" string array (the §7.4 provenance contract)`)
        }
      } else if (r.sourceRefs !== undefined) {
        refuse(`${label}: "sourceRefs" only belongs on Layer-3 entries`)
      }
    }
  }
  if (!Array.isArray(p.manifest)) refuse('packet: "manifest" must be an array')
  for (const [i, entry] of (p.manifest as unknown[]).entries()) {
    const label = `packet: manifest[${i}]`
    if (!isPlainObject(entry)) refuse(`${label}: must be an object`)
    const e = entry as Record<string, unknown>
    if (!isNonEmptyString(e.id)) refuse(`${label}: "id" must be a non-empty string`)
    if (e.disposition === 'included') {
      if (![1, 2, 3, 4].includes(e.layer as number)) refuse(`${label}: an included entry must carry layer 1-4`)
    } else if (e.disposition !== 'excluded-by-plan' && e.disposition !== 'excluded-by-budget') {
      refuse(`${label}: "disposition" must be "included", "excluded-by-plan", or "excluded-by-budget" (got ${JSON.stringify(e.disposition)})`)
    }
  }
  if (!isPlainObject(p.ledger)) refuse('packet: "ledger" must be an object')
  const ledger = p.ledger as Record<string, unknown>
  if (!isFiniteNumber(ledger.capTokens)) refuse('packet: "ledger.capTokens" must be a number')
  if (!isPlainObject(ledger.perLayer)) refuse('packet: "ledger.perLayer" must be an object')
  for (const name of ['mandatory', 'primary', 'distilled', 'supporting']) {
    if (!isFiniteNumber((ledger.perLayer as Record<string, unknown>)[name])) {
      refuse(`packet: "ledger.perLayer.${name}" must be a number`)
    }
  }
  if (!isFiniteNumber(ledger.totalTokens)) refuse('packet: "ledger.totalTokens" must be a number')
  if (!isPlainObject(p.fingerprint)) refuse('packet: "fingerprint" must be an object')
  const fp = p.fingerprint as Record<string, unknown>
  if (!isNonEmptyString(fp.hash)) refuse('packet: "fingerprint.hash" must be a non-empty string')
  if (!isPlainObject(fp.components)) refuse('packet: "fingerprint.components" must be an object')
  const c = fp.components as Record<string, unknown>
  if (!isNonEmptyString(c.model)) refuse('packet: "fingerprint.components.model" must be a non-empty string')
  if (!isNonEmptyString(c.planHash)) refuse('packet: "fingerprint.components.planHash" must be a non-empty string')
  if (!Array.isArray(c.selected)) refuse('packet: "fingerprint.components.selected" must be an array')
  for (const [i, sel] of (c.selected as unknown[]).entries()) {
    if (!isPlainObject(sel) || !isNonEmptyString((sel as Record<string, unknown>).id)
      || !isNonEmptyString((sel as Record<string, unknown>).contentHash)) {
      refuse(`packet: fingerprint.components.selected[${i}] must be { id, contentHash }`)
    }
  }
  for (const key of ['promptVersion', 'roleVersion', 'reasoningConfiguration', 'projectManifestVersion']) {
    if (c[key] !== null) {
      refuse(`packet: fingerprint.components.${key} must be null — no producer exists this slice (recorded, never faked)`)
    }
  }
}

/** Recompute-and-compare validation. Order matters for diagnosability:
 * cap, then per-layer ledger, then total, then the fingerprint chain
 * (selected vs layers, plan hash, hash). */
function validatePacketConsistency(packet: ContextPacket, plan: ReturnType<typeof parseContextPlan>): void {
  if (packet.ledger.capTokens !== plan.maxInputTokens) {
    refuse(
      `packet: recorded ledger cap ${packet.ledger.capTokens} does not match the plan's maxInputTokens ${plan.maxInputTokens}`,
    )
  }
  const actual = {
    mandatory: packet.layers.mandatory.reduce((s, r) => s + r.estimatedTokens, 0),
    primary: packet.layers.primary.reduce((s, r) => s + r.estimatedTokens, 0),
    distilled: packet.layers.distilled.reduce((s, r) => s + r.estimatedTokens, 0),
    supporting: packet.layers.supporting.reduce((s, r) => s + r.estimatedTokens, 0),
  }
  for (const name of ['mandatory', 'primary', 'distilled', 'supporting'] as const) {
    if (packet.ledger.perLayer[name] !== actual[name]) {
      refuse(
        `packet: recorded ledger inconsistent with recomputation — perLayer.${name} records ${packet.ledger.perLayer[name]}, its entries sum to ${actual[name]}`,
      )
    }
  }
  const total = actual.mandatory + actual.primary + actual.distilled + actual.supporting
  if (packet.ledger.totalTokens !== total) {
    refuse(
      `packet: recorded ledger inconsistent with recomputation — totalTokens records ${packet.ledger.totalTokens}, the layers sum to ${total}`,
    )
  }
  if (packet.ledger.totalTokens > packet.ledger.capTokens) {
    refuse(
      `packet: recorded total ${packet.ledger.totalTokens} is over cap ${packet.ledger.capTokens} — no valid build exceeds maxInputTokens`,
    )
  }
  const selectedFromLayers = [
    ...packet.layers.mandatory,
    ...packet.layers.primary,
    ...packet.layers.distilled,
    ...packet.layers.supporting,
  ].map((r: ArtifactRef) => ({ id: r.id, contentHash: r.contentHash }))
  const recordedSelected = packet.fingerprint.components.selected
  const sameSelected = recordedSelected.length === selectedFromLayers.length
    && recordedSelected.every((s, i) => s.id === selectedFromLayers[i]?.id && s.contentHash === selectedFromLayers[i]?.contentHash)
  if (!sameSelected) {
    refuse('packet: fingerprint components inconsistent with the packet — components.selected does not match the included entries in packet order')
  }
  const recomputedPlanHash = planHashOf(plan)
  if (packet.fingerprint.components.planHash !== recomputedPlanHash) {
    refuse(
      `fingerprint mismatch on recompute: plan hash — packet records ${packet.fingerprint.components.planHash}, the --plan file hashes to ${recomputedPlanHash}`,
    )
  }
  const recomputedHash = fingerprintHashOf(
    packet.fingerprint.components.model,
    packet.fingerprint.components.planHash,
    recordedSelected.map((s) => ({ id: s.id, contentHash: s.contentHash })),
  )
  if (packet.fingerprint.hash !== recomputedHash) {
    refuse(
      `fingerprint mismatch on recompute: packet records ${packet.fingerprint.hash}, its own components recompute to ${recomputedHash}`,
    )
  }
}

interface ContextInspection {
  planPath: string
  packetPath: string
  jobId: string | null
  budget: {
    capTokens: number
    perLayer: { mandatory: number; primary: number; distilled: number; supporting: number }
    totalTokens: number
  }
  included: {
    mandatory: ArtifactRef[]
    primary: ArtifactRef[]
    distilled: ArtifactRef[]
    supporting: ArtifactRef[]
  }
  excluded: { id: string; reason: 'excluded-by-plan' | 'excluded-by-budget' }[]
  sourceChains: { id: string; sourceRefs: string[] }[]
  fingerprint: {
    hash: string
    planHash: string
    model: string
    selectedArtifacts: number
    producers: {
      promptVersion: null
      roleVersion: null
      reasoningConfiguration: null
      projectManifestVersion: null
    }
  }
}

function inspectionOf(packet: ContextPacket, planPath: string, packetPath: string): ContextInspection {
  return {
    planPath,
    packetPath,
    jobId: packet.jobId,
    budget: {
      capTokens: packet.ledger.capTokens,
      perLayer: { ...packet.ledger.perLayer },
      totalTokens: packet.ledger.totalTokens,
    },
    included: {
      mandatory: packet.layers.mandatory,
      primary: packet.layers.primary,
      distilled: packet.layers.distilled,
      supporting: packet.layers.supporting,
    },
    excluded: packet.manifest
      .filter((e): e is ExcludedEntry => e.disposition !== 'included')
      .map((e) => ({ id: e.id, reason: e.disposition })),
    sourceChains: packet.layers.distilled.map((r) => ({ id: r.id, sourceRefs: r.sourceRefs ?? [] })),
    fingerprint: {
      hash: packet.fingerprint.hash,
      planHash: packet.fingerprint.components.planHash,
      model: packet.fingerprint.components.model,
      selectedArtifacts: packet.fingerprint.components.selected.length,
      producers: {
        promptVersion: null,
        roleVersion: null,
        reasoningConfiguration: null,
        projectManifestVersion: null,
      },
    },
  }
}

function printText(view: ContextInspection): void {
  console.log('context packet inspection')
  console.log(`  plan: ${view.planPath}`)
  console.log(`  packet: ${view.packetPath}`)
  console.log(`  job: ${view.jobId ?? '(none)'}`)
  console.log('')
  console.log('token budget')
  console.log(`  cap: ${view.budget.capTokens} tokens`)
  for (const name of ['mandatory', 'primary', 'distilled', 'supporting'] as const) {
    console.log(`  ${name}: ${view.budget.perLayer[name]} tokens (${view.included[name].length} artifacts)`)
  }
  console.log(`  total: ${view.budget.totalTokens} tokens`)
  console.log('')
  for (const name of ['mandatory', 'primary', 'distilled', 'supporting'] as const) {
    console.log(`${name} included (${view.included[name].length}):`)
    for (const ref of view.included[name]) {
      console.log(`  ${ref.id}  type=${ref.type}  sha=${ref.contentHash}  ${ref.sizeBytes}B  ~${ref.estimatedTokens} tokens`)
      if (name === 'distilled' && ref.sourceRefs !== undefined) {
        console.log(`    sources: ${ref.sourceRefs.join(', ')}`)
      }
    }
  }
  console.log('')
  console.log(`excluded artifacts (${view.excluded.length}):`)
  for (const e of view.excluded) {
    console.log(`  ${e.id}  ${e.reason}`)
  }
  console.log('')
  console.log('context fingerprint')
  console.log(`  hash: ${view.fingerprint.hash}`)
  console.log(`  plan hash: ${view.fingerprint.planHash}`)
  console.log(`  model: ${view.fingerprint.model}`)
  console.log(`  selected artifacts: ${view.fingerprint.selectedArtifacts}`)
  console.log(`  prompt version: no-producer`)
  console.log(`  role version: no-producer`)
  console.log(`  reasoning configuration: no-producer`)
  console.log(`  project manifest version: no-producer`)
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  const planPath = resolveInput(opts.plan, opts.runRoot)
  const packetPath = resolveInput(opts.packet, opts.runRoot)

  // Refusals before anything is printed: plan load + parse, packet load,
  // packet shape, packet-vs-plan consistency.
  const plan = parseContextPlan(readJsonFile(planPath, 'plan'))
  const packetRaw = readJsonFile(packetPath, 'packet')
  validatePacketShape(packetRaw)
  validatePacketConsistency(packetRaw, plan)

  const view = inspectionOf(packetRaw, planPath, packetPath)
  if (opts.json) console.log(JSON.stringify(view, null, 2))
  else printText(view)
}

try {
  main()
} catch (e: unknown) {
  if (e instanceof ContextRefusal) {
    console.error(`refused: ${e.message}`)
    process.exit(1)
  }
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
