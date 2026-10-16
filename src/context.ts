// Context system core (T-012) — first slice of Milestone 2 (spec §34:2035-2047
// minus shard distillation and source lineage, which are carved off).
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
// SourceReferencePolicy as field types and never defines them):
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
// carrier is Layer-3 class and is never visible to L2/L4 selection rules);
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

/** §7.1:500-512 minus `distillation`: a plan carrying a `distillation`
 * block is refused at parse (not silently ignored) until the §7.3-7.5
 * slice defines builder semantics for it. */
export interface ContextPlan {
  maxInputTokens: number
  mandatory: ArtifactQuery[]
  selectable: SelectionRule[]
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

/** A per-layer included entry. `sourceRefs` only on Layer 3. */
export interface ArtifactRef {
  id: string
  type: string
  contentHash: string
  sizeBytes: number
  layer: ContextLayer
  estimatedTokens: number
  sourceRefs?: string[]
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
const PLAN_FIELDS = ['maxInputTokens', 'mandatory', 'selectable', 'sourceReferencePolicy', 'exclusions'] as const
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
 * (ContextRefusal) name the offense: unknown plan fields, a present
 * `distillation` block (not consumed until the §7.3-7.5 slice — refused,
 * never silently ignored), `maxInputTokens ≤ 0` or non-integer, a missing
 * or non-'artifact-ref' sourceReferencePolicy, and any selector outside
 * the §7.6:593-605 vocabulary. */
export function parseContextPlan(raw: unknown): ContextPlan {
  if (!isPlainObject(raw)) refuse('context plan: must be a JSON object')
  const plan = raw as Record<string, unknown>
  for (const key of Object.keys(plan)) {
    if (!(PLAN_FIELDS as readonly string[]).includes(key)) {
      if (key === 'distillation') {
        refuse('context plan: unknown plan field "distillation" — refused until the §7.3-7.5 slice defines distillation builder semantics (never silently ignored)')
      }
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
  if (plan.exclusions !== undefined) {
    const exclusions = parseQueryArray(plan.exclusions, 'exclusions')
    out.exclusions = exclusions
  }
  return out
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

/** Builds the packet. Throws ContextRefusal when the mandatory layer alone
 * exceeds maxInputTokens (unsatisfiable — §7.2:516-518 Layer 1 is never
 * trimmed, so there is nothing to cut) or when the input carries duplicate
 * artifact ids (the manifest could not list every input exactly once).
 * See the module header for the layer-assignment and budget rules. */
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
  // inputs), canon order, budget-respecting.
  for (const record of pool) {
    if (!layerOf.has(record.id) && isDistilled(record)) include(record, 3)
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
