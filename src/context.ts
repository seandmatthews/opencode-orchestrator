// Context system core (T-012; shard distillation core added by T-013;
// packet-level source lineage added by T-014) — Milestone-2 slices of spec
// §34:2035-2047 at the contract level. The pipeline distiller stage — the
// producer that would build strict-mode packets inside real runs — remains
// carved (the T-012/T-013/T-014 Does-NOT lists).
//
// A pure module: no I/O at the core, no model knowledge, zero npm
// dependencies (node:crypto sha256 only — decisions.md: TypeScript on Node
// 22). Nothing in the pipeline produces or consumes a packet after this
// slice; the value is the pinned, re-derivable contract plus inspectability
// (src/context-inspect.ts is the reader). Context selection can therefore
// never influence promotion or elimination — machine gates decide survival,
// models advise (decisions.md 2026-10-10; AGENTS.md #2) — honored by
// construction here: nothing downstream exists yet.
//
// Vocabulary, chosen here and documented (the T-007 choose-and-document
// move — spec §7.1:500-512 uses ArtifactQuery / SelectionRule /
// SourceReferencePolicy / DistillationPlan as field types and never defines
// them):
//
// - `ArtifactQuery` — a conjunction of optional fields mapping 1:1 onto the
//   §7.6:593-605 selector vocabulary (by type / candidate / phase / producer
//   role / machine gate status / lineage / timestamp / explicit ID /
//   deterministic tag). A query naming no known selector field is a parse
//   refusal, and so is any unknown field — refused, never ignored, so a
//   typo can never silently narrow a run (the T-009 unknown-field posture).
//   There is no semantic/LLM selector and no hook for one: every inclusion
//   is explicit plan data ("there is no invisible 'AI relevance filter'",
//   §7.6:609).
// - `SelectionRule` — `{ layer: 'primary' | 'supporting', query, orderBy?,
//   limit? }`. `primary` rules fill Layer 2 in plan order; `supporting`
//   rules fill Layer 4 under the budget-remainder rule.
// - `SourceReferencePolicy = 'artifact-ref'` — the only mode this slice.
//   Layer-3 entries carry `sourceRefs` of the §7.4:567-576 shape
//   (`artifact:<id>#<anchor>`).
//
// Determinism contract (the T-009 tie-break move), pinned by Gate 1.13:
// base canon is id-ascending (the build never depends on input array
// order); rules apply in plan order; `timestamp-desc` is newest-first —
// lexicographic ISO-8601 string compare, no Date parsing, no wall clock —
// with id-ascending tie-break, and records without a timestamp sort last
// (id-ascending among themselves). Identical inputs → byte-identical
// packet JSON (stable key order), same ledger, same fingerprint.
//
// Token estimator: `ceil(chars / 4)` over artifact content — a documented
// approximation, never a tokenizer (zero-deps posture; the better-sqlite3
// precedent, VERIFICATION.md Known issues #7 — a new dependency needs its
// own decisions entry). The pinned contract is reproducibility — same
// inputs → same estimates → same inclusions → same fingerprint — not
// tokenizer accuracy. The ledger covers artifact content only;
// prompt-framing overhead is the carved composer's concern.
//
// Layer assignment priority (documented; each artifact lands in exactly
// one layer): plan `exclusions` are removed before any selection; Layer 1
// mandatory always included, never trimmed — a plan whose mandatory layer
// alone exceeds `maxInputTokens` is refused as unsatisfiable (§7.2:516-518);
// Layer 2 takes primary-rule matches in plan order; Layer 3 is the
// pass-through: every remaining artifact carrying non-empty `sourceRefs`
// (nothing distills this slice — the entries are inputs; a sourceRefs
// carrier is Layer-3 class and is never visible to L2/L4 selection rules).
// When the plan carries a `distillation` block, every Layer-3-class record
// the builder sees must be declared in `expectedArtifactIds`, or the build
// is refused — §7.5 rule 1 enforced at the plan level (opt-in: a plan
// without the block keeps the plain pass-through). Under the block the
// builder additionally enforces §7.4:565-578 / §7.5:580-587 rules 2-3 at
// the packet level (T-014): every Layer-3-class record's `sourceRefs` must
// carry the `artifact:<id>#<anchor>` form and resolve into the build's
// input set (every disposition, not just inclusions — an id outside the
// input set expands to nothing, so the claim is untraceable), and each
// included Layer-3 entry records its per-ref resolution against the
// build's own manifest so the §7.5 chain stays walkable through
// exclusions. Anchors stay opaque — no store to resolve into (§34:2028).
//
// **Locked decision (T-014, closing the question T-013:39-42 handed here):
// lineage enforcement stays keyed to the `distillation` block — the
// default path enforces nothing.** A blockless plan has no declared-input
// contract to enforce against (`expectedArtifactIds` is the block's own
// field), tightening would flip previously-valid inputs (Gate 1.13's
// blockless fixtures ride dead-ref pass-through by design), and no
// pipeline builds strict packets yet, so default-on buys nothing today.
// A future change-set may tighten and must do so by explicitly flipping
// those gate fixtures — a decision to be made, not an omission.
// Layer 4 takes supporting-rule matches. Every layer after Layer 1 includes
// a candidate only while budget remains: an inclusion that would overflow
// `maxInputTokens` is skipped (manifest `excluded-by-budget`) and the
// documented-order scan continues — a later, smaller candidate may still
// fit. Every input artifact appears in the manifest exactly once —
// included, or excluded with `excluded-by-plan` (an exclusion query matched)
// or `excluded-by-budget` (everything else not selected: matched no rule,
// fell past a rule's limit, or did not fit the remaining budget — the
// packet it could have joined was full). Nothing silent (§7.2:544).
//
// §7.7 fingerprint, narrowed to components with producers: sha256 over a
// canonical JSON blob of `{ model, planHash, selected }` where `planHash`
// is the canonical-JSON hash of the normalized plan and `selected` is
// `[{id, contentHash} …]` in packet order. The §7.7:614-620 components
// without producers — prompt version (§6.7:446, §18:1207), role version,
// reasoning configuration, project-manifest version (§13:971) — ride as
// null fields, recorded in the packet and documented. `jobId` (the T-006
// job identity — the candidate id in today's world) is recorded when
// provided and is NOT fingerprinted: it is not a §7.7 component. A later
// packet→prompt composer must reconcile this fingerprint with T-007's
// `input_context_hash` (composed prompt with the workspace-path line
// excluded) — one hash or a documented relationship, that slice's duty.
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types — the pinned vocabulary
// ---------------------------------------------------------------------------

/** §7.6:593-605 selector vocabulary as a query conjunction. All fields
 * optional; at least one required (an empty query is a parse refusal). */
export interface ArtifactQuery {
  type?: string
  candidate?: string
  phase?: string
  producerRole?: string
  gateStatus?: 'passed' | 'failed'
  /** The record's `lineage` array contains this artifact id (membership,
   * not substring). Absent lineage cannot match. */
  lineageContains?: string
  /** ISO-8601 strings compared lexicographically — no Date parsing, no
   * wall clock (consistent with the store's never-Date.now() rule). A
   * record without a timestamp cannot match either bound. */
  newerThan?: string
  olderThan?: string
  /** Explicit artifact IDs. */
  ids?: string[]
  /** The record's `tags` array contains this tag. Absent tags cannot match. */
  tagged?: string
}

export type SelectionLayer = 'primary' | 'supporting'

export interface SelectionRule {
  layer: SelectionLayer
  query: ArtifactQuery
  /** 'id' (default): id-ascending. 'timestamp-desc': newest-first
   * lexicographic, id-ascending tie-break, timestamp-less last. */
  orderBy?: 'id' | 'timestamp-desc'
  /** Positive integer; take the first N candidates after ordering. */
  limit?: number
}

/** The only mode this slice (§7.4:567-576-shaped `artifact:<id>#<anchor>`
 * refs on Layer-3 entries). */
export type SourceReferencePolicy = 'artifact-ref'

/** §7.1:507's `distillation?: DistillationPlan` — the type the spec uses
 * but never defines; chosen here and documented (the T-012
 * choose-and-document move). The block opts a plan into the
 * declared-entries contract: every Layer-3-class record the builder sees
 * must be declared here, or the build is refused — §7.5 rule 1 enforced at
 * the plan level. A plan without the block keeps the T-012 pass-through
 * semantics unchanged (opt-in strictness, pinned by Gate 1.13's untouched
 * Layer-3 fixtures, which ride plans without a block). */
export interface DistillationPlan {
  expectedArtifactIds: string[]
}

/** §7.1:500-512 in full. */
export interface ContextPlan {
  maxInputTokens: number
  mandatory: ArtifactQuery[]
  selectable: SelectionRule[]
  distillation?: DistillationPlan
  sourceReferencePolicy: SourceReferencePolicy
  exclusions?: ArtifactQuery[]
}

/** Builder input: the §6.8:451-467 fields with producers (id, type,
 * contentHash, sizeBytes) + the selector-relevant attributes (all optional;
 * absent → that selector cannot match) + the content the estimator reads +
 * `sourceRefs` on Layer-3 (distilled pass-through) entries. */
export interface ArtifactRecord {
  id: string
  type: string
  contentHash: string
  sizeBytes: number
  candidate?: string
  phase?: string
  producerRole?: string
  gateStatus?: 'passed' | 'failed'
  lineage?: string[]
  timestamp?: string
  tags?: string[]
  content: string
  /** Non-empty → the record is Layer-3 class (distilled pass-through). */
  sourceRefs?: string[]
}

export type ContextLayer = 1 | 2 | 3 | 4

/** The resolution of one `sourceRefs` entry against the build's own
 * manifest (T-014) — `ref` is the full §7.4 ref (anchors stay opaque),
 * `disposition` is the target artifact's manifest disposition in that
 * build. Recorded only on Layer-3 entries built under the
 * `distillation` block, one per `sourceRefs` entry, so a §7.5 chain stays
 * walkable through exclusions instead of hiding them. */
export interface SourceRefResolution {
  ref: string
  disposition: 'included' | 'excluded-by-plan' | 'excluded-by-budget'
}

/** A per-layer included entry. `sourceRefs` only on Layer 3;
 * `sourceRefResolutions` only on Layer-3 entries built under the
 * `distillation` block (strict mode) — rides the entry, never the
 * fingerprint (§7.7 selected stays `{id, contentHash}`). */
export interface ArtifactRef {
  id: string
  type: string
  contentHash: string
  sizeBytes: number
  layer: ContextLayer
  estimatedTokens: number
  sourceRefs?: string[]
  sourceRefResolutions?: SourceRefResolution[]
}

/** Manifest disposition vocabulary — exactly two exclusion reasons,
 * nothing silent (§7.2:544). */
export type ManifestEntry =
  | { id: string; disposition: 'included'; layer: ContextLayer }
  | { id: string; disposition: 'excluded-by-plan' }
  | { id: string; disposition: 'excluded-by-budget' }

/** The §7.7 fingerprint narrowed to components with producers. The four
 * producerless components ride null — recorded, documented, never faked. */
export interface ContextFingerprint {
  hash: string
  components: {
    model: string
    planHash: string
    selected: { id: string; contentHash: string }[]
    promptVersion: null
    roleVersion: null
    reasoningConfiguration: null
    projectManifestVersion: null
  }
}

/** Self-contained this slice (no artifact store to point into, §34:2028):
 * per-layer included entries, a manifest covering every input artifact id
 * exactly once, the budget ledger, and the fingerprint. */
export interface ContextPacket {
  /** Recorded when provided — the T-006 job identity (candidate id in
   * today's world). Not fingerprinted: not a §7.7 component. */
  jobId: string | null
  layers: {
    mandatory: ArtifactRef[]
    primary: ArtifactRef[]
    distilled: ArtifactRef[]
    supporting: ArtifactRef[]
  }
  manifest: ManifestEntry[]
  ledger: {
    capTokens: number
    perLayer: { mandatory: number; primary: number; distilled: number; supporting: number }
    totalTokens: number
  }
  fingerprint: ContextFingerprint
}

/** Refusal with a message naming the offense — parse or build. The CLI
 * turns these into non-zero exits that print no body. */
export class ContextRefusal extends Error {}

// ---------------------------------------------------------------------------
// Deterministic primitives
// ---------------------------------------------------------------------------

/** ceil(chars / 4) over artifact content — documented approximation, never
 * a tokenizer. Same inputs → same estimates, reproducibly. */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

/** Canonical JSON: object keys sorted, undefined-valued keys dropped,
 * array order preserved. Two structurally equal values always produce the
 * same string regardless of key insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Canonical-JSON hash of the normalized plan. */
export function planHashOf(plan: ContextPlan): string {
  return sha256(canonicalJson(plan))
}

/** sha256 over the canonical JSON of `{ model, planHash, selected }`. */
export function fingerprintHashOf(model: string, planHash: string, selected: { id: string; contentHash: string }[]): string {
  return sha256(canonicalJson({ model, planHash, selected }))
}

// ---------------------------------------------------------------------------
// Plan parsing — refusals name the offense, before anything is built
// ---------------------------------------------------------------------------

const SELECTOR_FIELDS = ['type', 'candidate', 'phase', 'producerRole', 'gateStatus', 'lineageContains', 'newerThan', 'olderThan', 'ids', 'tagged'] as const
const PLAN_FIELDS = ['maxInputTokens', 'mandatory', 'selectable', 'distillation', 'sourceReferencePolicy', 'exclusions'] as const
const RULE_FIELDS = ['layer', 'query', 'orderBy', 'limit'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuse(message: string): never {
  throw new ContextRefusal(message)
}

function optionalString(queryLabel: string, query: Record<string, unknown>, field: string): string | undefined {
  const v = query[field]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.length === 0) refuse(`${queryLabel}: selector "${field}" must be a non-empty string`)
  return v
}

/** Validates one query object and returns its normalized form — only the
 * present known selector keys, so canonical JSON is stable. Refuses:
 * non-objects, unknown fields (naming the offense), queries naming no
 * known selector field, and bad values. */
export function parseArtifactQuery(raw: unknown, label: string): ArtifactQuery {
  if (!isPlainObject(raw)) refuse(`${label}: a query must be a JSON object`)
  const query = raw as Record<string, unknown>
  for (const key of Object.keys(query)) {
    if (!(SELECTOR_FIELDS as readonly string[]).includes(key)) {
      refuse(`${label}: unknown selector field "${key}" (§7.6:593-605 vocabulary: ${SELECTOR_FIELDS.join(', ')})`)
    }
  }
  const named = SELECTOR_FIELDS.filter((f) => query[f] !== undefined)
  if (named.length === 0) {
    refuse(`${label}: a query naming no known selector field is refused (§7.6:593-605 vocabulary: ${SELECTOR_FIELDS.join(', ')})`)
  }
  const out: ArtifactQuery = {}
  const type = optionalString(label, query, 'type')
  if (type !== undefined) out.type = type
  const candidate = optionalString(label, query, 'candidate')
  if (candidate !== undefined) out.candidate = candidate
  const phase = optionalString(label, query, 'phase')
  if (phase !== undefined) out.phase = phase
  const producerRole = optionalString(label, query, 'producerRole')
  if (producerRole !== undefined) out.producerRole = producerRole
  if (query.gateStatus !== undefined) {
    if (query.gateStatus !== 'passed' && query.gateStatus !== 'failed') {
      refuse(`${label}: selector "gateStatus" must be "passed" or "failed" (got ${JSON.stringify(query.gateStatus)})`)
    }
    out.gateStatus = query.gateStatus
  }
  const lineageContains = optionalString(label, query, 'lineageContains')
  if (lineageContains !== undefined) out.lineageContains = lineageContains
  const newerThan = optionalString(label, query, 'newerThan')
  if (newerThan !== undefined) out.newerThan = newerThan
  const olderThan = optionalString(label, query, 'olderThan')
  if (olderThan !== undefined) out.olderThan = olderThan
  if (query.ids !== undefined) {
    const ids = query.ids
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== 'string' || i.length === 0)) {
      refuse(`${label}: selector "ids" must be a non-empty array of non-empty strings`)
    }
    out.ids = [...ids] as string[]
  }
  const tagged = optionalString(label, query, 'tagged')
  if (tagged !== undefined) out.tagged = tagged
  return out
}

function parseQueryArray(raw: unknown, label: string): ArtifactQuery[] {
  if (!Array.isArray(raw)) refuse(`${label} must be an array of queries`)
  return raw.map((q, i) => parseArtifactQuery(q, `${label}[${i}]`))
}

function parseSelectionRule(raw: unknown, index: number): SelectionRule {
  const label = `selection rule [${index}]`
  if (!isPlainObject(raw)) refuse(`${label}: a selection rule must be a JSON object`)
  const rule = raw as Record<string, unknown>
  for (const key of Object.keys(rule)) {
    if (!(RULE_FIELDS as readonly string[]).includes(key)) refuse(`${label}: unknown field "${key}"`)
  }
  if (rule.layer !== 'primary' && rule.layer !== 'supporting') {
    refuse(`${label}: "layer" must be "primary" or "supporting" (got ${JSON.stringify(rule.layer)})`)
  }
  if (rule.query === undefined) refuse(`${label}: "query" is required`)
  const out: SelectionRule = { layer: rule.layer, query: parseArtifactQuery(rule.query, `${label} query`) }
  if (rule.orderBy !== undefined) {
    if (rule.orderBy !== 'id' && rule.orderBy !== 'timestamp-desc') {
      refuse(`${label}: "orderBy" must be "id" or "timestamp-desc" (got ${JSON.stringify(rule.orderBy)})`)
    }
    out.orderBy = rule.orderBy
  }
  if (rule.limit !== undefined) {
    const limit = rule.limit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
      refuse(`${label}: "limit" must be a positive integer (got ${JSON.stringify(limit)})`)
    }
    out.limit = limit
  }
  return out
}

/** Parses and normalizes an unknown value into a ContextPlan. Refusals
 * (ContextRefusal) name the offense: unknown plan fields, an invalid
 * `distillation` block (a present block is parsed — never silently ignored;
 * an invalid one is refused with block-level detail via
 * `parseDistillationPlan`), `maxInputTokens ≤ 0` or non-integer, a missing
 * or non-'artifact-ref' sourceReferencePolicy, and any selector outside
 * the §7.6:593-605 vocabulary. */
export function parseContextPlan(raw: unknown): ContextPlan {
  if (!isPlainObject(raw)) refuse('context plan: must be a JSON object')
  const plan = raw as Record<string, unknown>
  for (const key of Object.keys(plan)) {
    if (!(PLAN_FIELDS as readonly string[]).includes(key)) {
      refuse(`context plan: unknown plan field "${key}"`)
    }
  }
  const max = plan.maxInputTokens
  if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) {
    refuse(`context plan: "maxInputTokens" must be a positive integer (got ${JSON.stringify(max)})`)
  }
  if (plan.mandatory === undefined) refuse('context plan: "mandatory" is required (an empty array is valid)')
  const mandatory = parseQueryArray(plan.mandatory, 'mandatory')
  if (plan.selectable === undefined) refuse('context plan: "selectable" is required (an empty array is valid)')
  if (!Array.isArray(plan.selectable)) refuse('context plan: "selectable" must be an array of selection rules')
  const selectable = plan.selectable.map((r, i) => parseSelectionRule(r, i))
  if (plan.sourceReferencePolicy !== 'artifact-ref') {
    refuse(`context plan: "sourceReferencePolicy" must be "artifact-ref" (got ${JSON.stringify(plan.sourceReferencePolicy)}) — the only mode this slice`)
  }
  const out: ContextPlan = {
    maxInputTokens: max,
    mandatory,
    selectable,
    sourceReferencePolicy: 'artifact-ref',
  }
  if (plan.distillation !== undefined) {
    out.distillation = parseDistillationPlan(plan.distillation, 'context plan: "distillation" block')
  }
  if (plan.exclusions !== undefined) {
    const exclusions = parseQueryArray(plan.exclusions, 'exclusions')
    out.exclusions = exclusions
  }
  return out
}

const DISTILLATION_PLAN_FIELDS = ['expectedArtifactIds'] as const

/** Parses one `distillation` block (§7.1:507) into a `DistillationPlan`.
 * Refuses (ContextRefusal, naming the offense): non-object blocks, unknown
 * sub-fields (refuse-don't-ignore — the T-009 unknown-field posture), and
 * an `expectedArtifactIds` that is not a non-empty array of distinct
 * non-empty strings. */
export function parseDistillationPlan(raw: unknown, label = 'distillation plan'): DistillationPlan {
  if (!isPlainObject(raw)) refuse(`${label}: must be a JSON object`)
  const block = raw as Record<string, unknown>
  for (const key of Object.keys(block)) {
    if (!(DISTILLATION_PLAN_FIELDS as readonly string[]).includes(key)) {
      refuse(`${label}: unknown field "${key}"`)
    }
  }
  const ids = block.expectedArtifactIds
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== 'string' || i.length === 0)) {
    refuse(`${label}: "expectedArtifactIds" must be a non-empty array of non-empty strings`)
  }
  const dup = (ids as string[]).find((id, i) => (ids as string[]).indexOf(id) !== i)
  if (dup !== undefined) refuse(`${label}: duplicate entry "${dup}" in "expectedArtifactIds"`)
  return { expectedArtifactIds: [...(ids as string[])] }
}

// ---------------------------------------------------------------------------
// Distillation reports — §23.2:1358-1381, §7.5 rule 1 at the record level
// ---------------------------------------------------------------------------

/** One distilled claim — the camelCase normalization of §23.2:1367-1378's
 * snake_case wire shape (`source_refs` → `sourceRefs`,
 * `disagreement_refs` → `disagreementRefs`). `sourceRefs` carries the
 * §7.4:567-576 `artifact:<id>#<anchor>` form exclusively. */
export interface DistilledClaim {
  id: string
  statement: string
  sourceRefs: string[]
  disagreementRefs?: string[]
}

/** §23.2:1358-1381's distillation-report record — the contract a future
 * pipeline distiller role's output must pass (`parseDistillationReport`,
 * §7.5 rule 1 at the record level). `sourceArtifacts` is the report's
 * declared input set; every ref on every claim — `sourceRefs` and
 * `disagreementRefs` alike, a recorded disagreement also being a citation
 * into the input set — must carry the §7.4 prefixed form and resolve into
 * it. Anchors are opaque: format + declared-input-set resolution only (no
 * artifact store exists to resolve anchors against, §34:2028); real anchor
 * resolution is carved with the store. */
export interface DistillationReport {
  sourceArtifacts: string[]
  claims: DistilledClaim[]
}

const REPORT_FIELDS = ['source_artifacts', 'claims'] as const
const CLAIM_FIELDS = ['id', 'statement', 'source_refs', 'disagreement_refs'] as const

/** The single §7.4-prefixed source-ref predicate (T-013's definition,
 * factored out for reuse — never a second divergent copy):
 * `parseDistillationReport` (record level), the builder's strict
 * lineage check (packet level, T-014), and the inspector's strict
 * packet validation (src/context-inspect.ts) all validate refs through
 * this function. Validates exactly `artifact:<id>#<anchor>` — starts
 * `artifact:`, exactly one `#`, non-empty id and anchor. Bare
 * `<id>#<anchor>` (§23.2:1371-1377's spelling) is refused: this slice
 * standardizes on the prefixed §7.4:565-578 form (consistency with every
 * T-012-pinned fixture and the `sourceReferencePolicy: 'artifact-ref'`
 * mode) — the documented spec divergence. Returns the ref unchanged
 * (validation only; anchors are opaque). */
export function parseSourceRef(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    refuse(`${label}: must be a non-empty "artifact:<id>#<anchor>" string (got ${JSON.stringify(raw)})`)
  }
  const ref = raw as string
  if (!ref.startsWith('artifact:')) {
    refuse(`${label}: ${JSON.stringify(ref)} must be "artifact:<id>#<anchor>" — refs carry the §7.4:567-576 "artifact:" prefix (the bare "id#anchor" spelling is refused)`)
  }
  const rest = ref.slice('artifact:'.length)
  const first = rest.indexOf('#')
  if (first === -1 || first !== rest.lastIndexOf('#')) {
    refuse(`${label}: ${JSON.stringify(ref)} must contain exactly one "#" separating artifact id and anchor`)
  }
  if (first === 0 || first === rest.length - 1) {
    refuse(`${label}: ${JSON.stringify(ref)} must carry a non-empty artifact id and a non-empty anchor`)
  }
  return ref
}

/** The artifact-id half of a validated `artifact:<id>#<anchor>` ref (the
 * shared half of `parseSourceRef`'s single definition). */
export function refArtifactId(ref: string): string {
  return ref.slice('artifact:'.length, ref.indexOf('#'))
}

/** Validates a §23.2:1358-1381 distillation report (the raw wire shape —
 * snake_case) into a `DistillationReport`, the enforcement point §7.5
 * rule 1 ("distillation artifacts cite source artifacts") has at the
 * record level. Refusals (ContextRefusal) name the offense: unknown
 * fields at either level (naming the field, and the claim id where one
 * exists), `source_artifacts` not a non-empty array of non-empty strings,
 * a claim whose `id` is missing or not a non-empty string or duplicates
 * another claim's id, an empty `statement`, a missing/empty
 * `source_refs`, a malformed ref (anything not exactly
 * `artifact:<id>#<anchor>` — the bare §23.2 spelling included), and any
 * `source_refs`/`disagreement_refs` entry whose `<id>` is not in the
 * report's declared `source_artifacts` (refused naming the claim id).
 * `claims: []` is valid — a distiller that found nothing worth claiming
 * still produces the record (documented choice). `disagreement_refs` is
 * optional but, when present, validated and resolved exactly like
 * `source_refs`. Anchors are never resolved (no store, §34:2028). */
export function parseDistillationReport(raw: unknown): DistillationReport {
  if (!isPlainObject(raw)) refuse('distillation report: must be a JSON object')
  const report = raw as Record<string, unknown>
  for (const key of Object.keys(report)) {
    if (!(REPORT_FIELDS as readonly string[]).includes(key)) {
      refuse(`distillation report: unknown field "${key}"`)
    }
  }
  const declared = report.source_artifacts
  if (!Array.isArray(declared) || declared.length === 0 || declared.some((a) => typeof a !== 'string' || a.length === 0)) {
    refuse('distillation report: "source_artifacts" must be a non-empty array of non-empty strings (the declared input set)')
  }
  const declaredSet = new Set<string>(declared as string[])
  if (!Array.isArray(report.claims)) refuse('distillation report: "claims" must be an array')
  const seenIds = new Set<string>()
  const claims: DistilledClaim[] = (report.claims as unknown[]).map((rawClaim, index) => {
    const at = `distillation report: claims[${index}]`
    if (!isPlainObject(rawClaim)) refuse(`${at}: must be a JSON object`)
    const claim = rawClaim as Record<string, unknown>
    if (typeof claim.id !== 'string' || claim.id.length === 0) {
      refuse(`${at}: "id" must be a non-empty string`)
    }
    const who = `${at} (claim "${claim.id}")`
    if (seenIds.has(claim.id)) refuse(`${who}: duplicate claim id — claim ids are unique across the report`)
    seenIds.add(claim.id)
    for (const key of Object.keys(claim)) {
      if (!(CLAIM_FIELDS as readonly string[]).includes(key)) {
        refuse(`${who}: unknown field "${key}"`)
      }
    }
    if (typeof claim.statement !== 'string' || claim.statement.length === 0) {
      refuse(`${who}: "statement" must be a non-empty string`)
    }
    if (!Array.isArray(claim.source_refs) || claim.source_refs.length === 0) {
      refuse(`${who}: "source_refs" must be a non-empty array (§7.5 rule 1: distillation artifacts cite source artifacts)`)
    }
    const sourceRefs = (claim.source_refs as unknown[]).map((ref, i) => {
      const parsed = parseSourceRef(ref, `${who} source_refs[${i}]`)
      const id = refArtifactId(parsed)
      if (!declaredSet.has(id)) {
        refuse(`${who}: source_refs[${i}] ${JSON.stringify(parsed)} cites artifact id "${id}" which is not in the report's declared source_artifacts`)
      }
      return parsed
    })
    let disagreementRefs: string[] | undefined
    if (claim.disagreement_refs !== undefined) {
      if (!Array.isArray(claim.disagreement_refs) || claim.disagreement_refs.length === 0) {
        refuse(`${who}: "disagreement_refs", when present, must be a non-empty array`)
      }
      disagreementRefs = (claim.disagreement_refs as unknown[]).map((ref, i) => {
        const parsed = parseSourceRef(ref, `${who} disagreement_refs[${i}]`)
        const id = refArtifactId(parsed)
        if (!declaredSet.has(id)) {
          refuse(`${who}: disagreement_refs[${i}] ${JSON.stringify(parsed)} cites artifact id "${id}" which is not in the report's declared source_artifacts`)
        }
        return parsed
      })
    }
    const out: DistilledClaim = { id: claim.id, statement: claim.statement, sourceRefs }
    if (disagreementRefs !== undefined) out.disagreementRefs = disagreementRefs
    return out
  })
  return { sourceArtifacts: [...(declared as string[])], claims }
}

// ---------------------------------------------------------------------------
// Selectors — the deterministic §7.6:593-605 subset, exactly
// ---------------------------------------------------------------------------

/** Conjunction of every present selector field. An absent record attribute
 * cannot match (e.g. no timestamp → never matches newerThan/olderThan;
 * no lineage/tags → never matches lineageContains/tagged). Timestamps
 * compare lexicographically — ISO-8601 strings, no Date parsing. */
export function matchesQuery(record: ArtifactRecord, query: ArtifactQuery): boolean {
  if (query.type !== undefined && record.type !== query.type) return false
  if (query.candidate !== undefined && record.candidate !== query.candidate) return false
  if (query.phase !== undefined && record.phase !== query.phase) return false
  if (query.producerRole !== undefined && record.producerRole !== query.producerRole) return false
  if (query.gateStatus !== undefined && record.gateStatus !== query.gateStatus) return false
  if (query.lineageContains !== undefined && !(Array.isArray(record.lineage) && record.lineage.includes(query.lineageContains))) return false
  if (query.newerThan !== undefined && !(typeof record.timestamp === 'string' && record.timestamp > query.newerThan)) return false
  if (query.olderThan !== undefined && !(typeof record.timestamp === 'string' && record.timestamp < query.olderThan)) return false
  if (query.ids !== undefined && !query.ids.includes(record.id)) return false
  if (query.tagged !== undefined && !(Array.isArray(record.tags) && record.tags.includes(query.tagged))) return false
  return true
}

// ---------------------------------------------------------------------------
// The four-layer builder (§7.2:514-545) — a pure function of
// (plan, artifacts, { model, jobId? })
// ---------------------------------------------------------------------------

function orderCandidates(records: ArtifactRecord[], orderBy: 'id' | 'timestamp-desc' | undefined): ArtifactRecord[] {
  const byId = (a: ArtifactRecord, b: ArtifactRecord): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (orderBy !== 'timestamp-desc') return [...records].sort(byId)
  return [...records].sort((a, b) => {
    const at = typeof a.timestamp === 'string' ? a.timestamp : null
    const bt = typeof b.timestamp === 'string' ? b.timestamp : null
    if (at !== null && bt !== null) {
      if (at !== bt) return at < bt ? 1 : -1 // newest-first, lexicographic
      return byId(a, b) // id-ascending tie-break
    }
    if (at === null && bt === null) return byId(a, b) // timestamp-less last, id-ascending
    return at === null ? 1 : -1 // timestamp-less sort last
  })
}

function refOf(record: ArtifactRecord, layer: ContextLayer): ArtifactRef {
  const ref: ArtifactRef = {
    id: record.id,
    type: record.type,
    contentHash: record.contentHash,
    sizeBytes: record.sizeBytes,
    layer,
    estimatedTokens: estimateTokens(record.content),
  }
  if (layer === 3 && Array.isArray(record.sourceRefs) && record.sourceRefs.length > 0) {
    ref.sourceRefs = [...record.sourceRefs]
  }
  return ref
}

function isDistilled(record: ArtifactRecord): boolean {
  return Array.isArray(record.sourceRefs) && record.sourceRefs.length > 0
}

/** T-014's strict-mode packet-level lineage checks (§7.4:565-578,
 * §7.5:580-587 rules 2-3), run per Layer-3-class record the pass-through
 * scan sees, before the budget test inside `include` (mirroring T-013's
 * declaration-before-budget order — budget-luck can never hide an
 * untraceable claim, §7.2:544 nothing-silent):
 * 1. every `sourceRefs` entry carries the §7.4 `artifact:<id>#<anchor>`
 *    form — validated through `parseSourceRef`, T-013's single definition,
 *    so the bare §23.2 spelling is refused here exactly as at the record
 *    level;
 * 2. every ref's `<id>` resolves into the build's input set — the canon of
 *    input artifact ids, every disposition, not just inclusions (§7.4:578:
 *    "a downstream reviewer can expand any distilled statement back to
 *    original evidence" — an id outside the input set expands to nothing,
 *    so the claim is untraceable).
 * Both refusals name the record id (the claim) and the dead/malformed ref.
 * Anchors stay opaque — no store to resolve into (§34:2028). Mutual and
 * self citation are legal: resolution is against the input id set, so
 * cycles build fine; termination is the inspector render's duty
 * (src/context-inspect.ts). Opt-in: called only when the plan carries the
 * `distillation` block — see the locked decision in the module header. */
function enforceSourceLineage(record: ArtifactRecord, inputIds: Set<string>): void {
  for (const [i, ref] of (record.sourceRefs ?? []).entries()) {
    const label = `distilled record "${record.id}" sourceRefs[${i}]`
    const parsed = parseSourceRef(ref, label)
    const id = refArtifactId(parsed)
    if (!inputIds.has(id)) {
      refuse(
        `${label}: ${JSON.stringify(parsed)} cites artifact id "${id}" which is not in the build's input set (§7.5: no untraceable summary chains — an id outside the input set expands to nothing)`,
      )
    }
  }
}

/** Builds the packet. Throws ContextRefusal when the mandatory layer alone
 * exceeds maxInputTokens (unsatisfiable — §7.2:516-518 Layer 1 is never
 * trimmed, so there is nothing to cut), when the input carries duplicate
 * artifact ids (the manifest could not list every input exactly once), or —
 * when the plan carries a `distillation` block — when a Layer-3-class
 * record arrives that the block does not declare (§7.5 rule 1 at the plan
 * level) or whose `sourceRefs` are malformed or dead against the build's
 * input set (§7.4/§7.5 rules 2-3 at the packet level, T-014). See the
 * module header for the layer-assignment and budget rules. */
export function buildContextPacket(
  plan: ContextPlan,
  artifacts: readonly ArtifactRecord[],
  opts: { model: string; jobId?: string },
): ContextPacket {
  // Base canon: id-ascending — the build never depends on input array order.
  const canon = [...artifacts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (let i = 1; i < canon.length; i++) {
    if (canon[i]!.id === canon[i - 1]!.id) {
      refuse(`duplicate artifact id "${canon[i]!.id}" — every input artifact must appear in the manifest exactly once`)
    }
  }
  // The resolution universe for the strict lineage check (T-014): the canon
  // of input artifact ids — every disposition, not just inclusions.
  const inputIds = new Set(canon.map((r) => r.id))

  // Plan exclusions remove before any selection (§7.2:544's exact manifest).
  const excludedByPlan = new Set<string>()
  if (plan.exclusions !== undefined) {
    for (const record of canon) {
      if (plan.exclusions.some((q) => matchesQuery(record, q))) excludedByPlan.add(record.id)
    }
  }
  const pool = canon.filter((r) => !excludedByPlan.has(r.id))

  const layers: ContextPacket['layers'] = { mandatory: [], primary: [], distilled: [], supporting: [] }
  const layerOf = new Map<string, ContextLayer>()
  const tokenTotal = { value: 0 }

  const include = (record: ArtifactRecord, layer: ContextLayer): boolean => {
    if (layerOf.has(record.id)) return false
    const est = estimateTokens(record.content)
    if (layer !== 1 && tokenTotal.value + est > plan.maxInputTokens) return false // budget: skip, scan continues
    layerOf.set(record.id, layer)
    tokenTotal.value += est
    const ref = refOf(record, layer)
    if (layer === 1) layers.mandatory.push(ref)
    else if (layer === 2) layers.primary.push(ref)
    else if (layer === 3) layers.distilled.push(ref)
    else layers.supporting.push(ref)
    return true
  }

  // Layer 1 — mandatory, always included, never trimmed (§7.2:516-518).
  for (const query of plan.mandatory) {
    for (const record of pool) {
      if (matchesQuery(record, query)) include(record, 1)
    }
  }
  const mandatoryTokens = layers.mandatory.reduce((sum, r) => sum + r.estimatedTokens, 0)
  if (mandatoryTokens > plan.maxInputTokens) {
    refuse(
      `unsatisfiable plan: the mandatory layer alone needs ${mandatoryTokens} tokens > maxInputTokens ${plan.maxInputTokens} — Layer 1 is never trimmed`,
    )
  }

  // Layer 2 — primary rules in plan order; a sourceRefs carrier is
  // Layer-3 class and is never visible to L2/L4 selection rules.
  for (const rule of plan.selectable) {
    if (rule.layer !== 'primary') continue
    const candidates = pool.filter((r) => !layerOf.has(r.id) && !isDistilled(r) && matchesQuery(r, rule.query))
    const ordered = orderCandidates(candidates, rule.orderBy)
    const bounded = rule.limit !== undefined ? ordered.slice(0, rule.limit) : ordered
    for (const record of bounded) include(record, 2)
  }

  // Layer 3 — distilled pass-through (nothing distills; the entries are
  // inputs), canon order, budget-respecting. When the plan carries a
  // `distillation` block, every Layer-3-class record this scan sees must be
  // declared in `expectedArtifactIds` — §7.5 rule 1 at the plan level — and
  // its refs must carry the §7.4 form and resolve into the input set
  // (T-014's packet-level lineage, `enforceSourceLineage`). The declaration
  // check and the lineage checks all precede the budget test inside
  // `include`, so a record that would have been excluded-by-budget is
  // refused all the same: budget-luck never hides a provenance violation
  // (nothing silent, §7.2:544). The lineage checks also run for a
  // Layer-3-class record already captured by an earlier layer (Layer 1):
  // every Layer-3-class record the builder sees — the T-013 declaration
  // posture, mirrored. Declared-but-absent ids are not a refusal — the
  // builder refuses what arrived untraceable, not what didn't arrive; the
  // manifest and ledger record the truth. Plan `exclusions` still remove
  // first (§7.2:544): a plan-excluded record never reaches the scan and is
  // recorded `excluded-by-plan` — the builder refuses what arrived
  // untraceable, not what didn't arrive.
  for (const record of pool) {
    if (!isDistilled(record)) continue
    if (plan.distillation !== undefined && !plan.distillation.expectedArtifactIds.includes(record.id)) {
      refuse(
        `untraceable distilled entry "${record.id}" — the plan's distillation.expectedArtifactIds does not declare it (§7.5 rule 1: no untraceable summary chains)`,
      )
    }
    if (plan.distillation !== undefined) enforceSourceLineage(record, inputIds)
    if (layerOf.has(record.id)) continue
    include(record, 3)
  }

  // Layer 4 — supporting rules in plan order, under the budget-remainder
  // rule (§7.2:540-542).
  for (const rule of plan.selectable) {
    if (rule.layer !== 'supporting') continue
    const candidates = pool.filter((r) => !layerOf.has(r.id) && !isDistilled(r) && matchesQuery(r, rule.query))
    const ordered = orderCandidates(candidates, rule.orderBy)
    const bounded = rule.limit !== undefined ? ordered.slice(0, rule.limit) : ordered
    for (const record of bounded) include(record, 4)
  }

  // Manifest — every input artifact id exactly once, nothing silent.
  const manifest: ManifestEntry[] = canon.map((record) => {
    const layer = layerOf.get(record.id)
    if (layer !== undefined) return { id: record.id, disposition: 'included' as const, layer }
    if (excludedByPlan.has(record.id)) return { id: record.id, disposition: 'excluded-by-plan' as const }
    return { id: record.id, disposition: 'excluded-by-budget' as const }
  })

  // T-014: per-ref resolution recorded on the packet entry — strict mode
  // only (the block present), included Layer-3 entries only. Each ref's
  // disposition is read off the final manifest, so a ref naming an excluded
  // input records that exclusion rather than hiding it — the §7.5 chain
  // stays walkable through exclusions (§7.2:544). The lookup cannot miss:
  // every ref id passed the input-set check above and the manifest covers
  // every input id exactly once. The field rides the entry, never the
  // fingerprint (`selected` stays `{id, contentHash}` in packet order), and
  // is never added under a blockless plan — blockless output stays
  // byte-identical (pinned by Gate 1.14's untouched snapshot).
  if (plan.distillation !== undefined) {
    const manifestById = new Map(manifest.map((m) => [m.id, m]))
    for (const entry of layers.distilled) {
      entry.sourceRefResolutions = (entry.sourceRefs ?? []).map((ref) => ({
        ref,
        disposition: manifestById.get(refArtifactId(ref))!.disposition,
      }))
    }
  }

  const sumRefs = (refs: ArtifactRef[]): number => refs.reduce((sum, r) => sum + r.estimatedTokens, 0)
  const ledger: ContextPacket['ledger'] = {
    capTokens: plan.maxInputTokens,
    perLayer: {
      mandatory: sumRefs(layers.mandatory),
      primary: sumRefs(layers.primary),
      distilled: sumRefs(layers.distilled),
      supporting: sumRefs(layers.supporting),
    },
    totalTokens: 0,
  }
  ledger.totalTokens =
    ledger.perLayer.mandatory + ledger.perLayer.primary + ledger.perLayer.distilled + ledger.perLayer.supporting

  // §7.7 fingerprint, narrowed — selected ids/hashes in packet order.
  const selected = [...layers.mandatory, ...layers.primary, ...layers.distilled, ...layers.supporting].map((r) => ({
    id: r.id,
    contentHash: r.contentHash,
  }))
  const planHash = planHashOf(plan)
  const fingerprint: ContextFingerprint = {
    hash: fingerprintHashOf(opts.model, planHash, selected),
    components: {
      model: opts.model,
      planHash,
      selected,
      promptVersion: null,
      roleVersion: null,
      reasoningConfiguration: null,
      projectManifestVersion: null,
    },
  }

  return {
    jobId: opts.jobId ?? null,
    layers,
    manifest,
    ledger,
    fingerprint,
  }
}
