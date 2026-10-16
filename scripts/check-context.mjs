// Context-system-core self-check (Gate 1.13, fast tier, T-012) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-context.mjs
// Pins the pure context module (src/context.ts) and the read-only inspector
// CLI (src/context-inspect.ts) over hand-built plan + artifact fixtures —
// the Gate 0.5 check-parse.mjs pattern, since no artifact store exists to
// produce inputs (§34:2028 is the unclaimed Milestone-1 build item). No
// existing gate can pin any context criterion: the fast tier never runs the
// pipeline and Gate 2 spends model tokens and cannot assert on synthetic
// packets (the T-007/T-009 argument). Zero model tokens, zero npm deps.
//
// All subprocess calls are list-form (AGENTS.md #4).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ContextRefusal,
  buildContextPacket,
  canonicalJson,
  estimateTokens,
  fingerprintHashOf,
  matchesQuery,
  parseContextPlan,
  planHashOf,
} from '../src/context.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
// A refusal fires (ContextRefusal) with a message naming the offense.
const throwsRefusal = (fn, re) => {
  try {
    fn()
    return false
  } catch (e) {
    return e instanceof ContextRefusal && (re === undefined || re.test(e.message))
  }
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const inspectTs = join(root, 'src', 'context-inspect.ts')
const runCli = (args) => {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [tsxCli, inspectTs, ...args], { encoding: 'utf8', windowsHide: true }), stderr: '' }
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message) }
  }
}

// ---------------------------------------------------------------------------
// Hand-built fixtures (no artifact store exists — nothing pretends artifacts
// flow; the builder takes plain records)
// ---------------------------------------------------------------------------
const ARTIFACTS = [
  { id: 'goal-primary', type: 'goal', contentHash: 'sha-goal', sizeBytes: 80, content: 'G'.repeat(80) }, // 20 tokens
  { id: 'schema-roles', type: 'schema', contentHash: 'sha-schema', sizeBytes: 40, content: 'S'.repeat(40) }, // 10
  { id: 'diff-c01-a', type: 'diff', contentHash: 'sha-a', sizeBytes: 200, candidate: 'c01', timestamp: '2026-10-15T10:00:00.000Z', content: 'a'.repeat(200) }, // 50
  { id: 'diff-c01-b', type: 'diff', contentHash: 'sha-b', sizeBytes: 160, candidate: 'c01', timestamp: '2026-10-16T09:00:00.000Z', content: 'b'.repeat(160) }, // 40
  { id: 'diff-c02', type: 'diff', contentHash: 'sha-c02', sizeBytes: 120, candidate: 'c02', timestamp: '2026-10-14T09:00:00.000Z', content: 'c'.repeat(120) }, // 30
  { id: 'probe-failed-1', type: 'probe', contentHash: 'sha-p1', sizeBytes: 120, gateStatus: 'failed', timestamp: '2026-10-16T08:00:00.000Z', content: 'p'.repeat(120) }, // 30
  { id: 'probe-failed-2', type: 'probe', contentHash: 'sha-p2', sizeBytes: 120, gateStatus: 'failed', timestamp: '2026-10-16T07:00:00.000Z', content: 'q'.repeat(120) }, // 30
  { id: 'probe-failed-3', type: 'probe', contentHash: 'sha-p3', sizeBytes: 120, gateStatus: 'failed', timestamp: '2026-10-16T06:00:00.000Z', content: 'r'.repeat(120) }, // 30
  { id: 'distilled-research', type: 'distillation-report', contentHash: 'sha-dist', sizeBytes: 100, sourceRefs: ['artifact:research-003#obs-4', 'artifact:research-011#obs-2'], content: 'd'.repeat(100) }, // 25
  { id: 'sup-tag-1', type: 'note', contentHash: 'sha-s1', sizeBytes: 40, tags: ['context'], content: '1'.repeat(40) }, // 10
  { id: 'sup-tag-2', type: 'note', contentHash: 'sha-s2', sizeBytes: 80, tags: ['context'], content: '2'.repeat(80) }, // 20
  { id: 'sup-tag-3', type: 'note', contentHash: 'sha-s3', sizeBytes: 200, tags: ['context'], content: '3'.repeat(200) }, // 50
  { id: 'sup-tag-4', type: 'note', contentHash: 'sha-s4', sizeBytes: 400, tags: ['context'], content: '4'.repeat(400) }, // 100
  { id: 'poison-artifact', type: 'diff', contentHash: 'sha-poison', sizeBytes: 80, candidate: 'c01', content: 'x'.repeat(80) }, // 20 — matches an exclusion AND the primary diff rule
]
const MODEL = 'zai-coding-plan/glm-5.3-flash'

const PLAN_A = {
  maxInputTokens: 300,
  mandatory: [{ type: 'goal' }, { ids: ['schema-roles'] }],
  selectable: [
    { layer: 'primary', query: { type: 'diff', candidate: 'c01' }, orderBy: 'timestamp-desc' },
    { layer: 'primary', query: { gateStatus: 'failed' }, limit: 2 },
    { layer: 'supporting', query: { tagged: 'context' }, orderBy: 'id' },
  ],
  sourceReferencePolicy: 'artifact-ref',
  exclusions: [{ ids: ['poison-artifact'] }],
}

const sandbox = mkdtempSync(join(tmpdir(), 't012-context-'))
try {
  // =========================================================================
  // 1. ContextPlan parsing — refusals name the offense, before anything builds
  // =========================================================================
  console.log('\n--- plan parsing ---')
  const parsedA = parseContextPlan(PLAN_A)
  t('a valid plan parses with its fields intact', parsedA.maxInputTokens === 300 && parsedA.mandatory.length === 2 && parsedA.selectable.length === 3 && parsedA.sourceReferencePolicy === 'artifact-ref' && parsedA.exclusions?.length === 1)
  t('unknown plan field refused, naming it', throwsRefusal(() => parseContextPlan({ ...PLAN_A, relevance: 'ai' }), /relevance/))
  t('a present distillation block is refused, not silently ignored', throwsRefusal(() => parseContextPlan({ ...PLAN_A, distillation: { shards: 5 } }), /distillation/))
  t('maxInputTokens 0 refused', throwsRefusal(() => parseContextPlan({ ...PLAN_A, maxInputTokens: 0 }), /maxInputTokens/))
  t('negative maxInputTokens refused', throwsRefusal(() => parseContextPlan({ ...PLAN_A, maxInputTokens: -5 }), /maxInputTokens/))
  t('selector outside the §7.6 vocabulary refused, naming it', throwsRefusal(() => parseContextPlan({ ...PLAN_A, mandatory: [{ relevance: 'ai' }] }), /relevance/))
  t('a query naming no known selector field is refused', throwsRefusal(() => parseContextPlan({ ...PLAN_A, mandatory: [{}] }), /no known selector field/))
  t('bad gateStatus value refused', throwsRefusal(() => parseContextPlan({ ...PLAN_A, mandatory: [{ gateStatus: 'green' }] }), /gateStatus/))
  t('empty query in selectable refused', throwsRefusal(() => parseContextPlan({ ...PLAN_A, selectable: [{ layer: 'primary', query: {} }] }), /no known selector field/))
  t('unknown rule field refused', throwsRefusal(() => parseContextPlan({ ...PLAN_A, selectable: [{ layer: 'primary', query: { type: 'x' }, weight: 2 }] }), /weight/))
  t('rule layer outside primary|supporting refused', throwsRefusal(() => parseContextPlan({ ...PLAN_A, selectable: [{ layer: 'distilled', query: { type: 'x' } }] }), /layer/))
  t('bad orderBy refused', throwsRefusal(() => parseContextPlan({ ...PLAN_A, selectable: [{ layer: 'primary', query: { type: 'x' }, orderBy: 'relevance' }] }), /orderBy/))
  t('non-positive limit refused', throwsRefusal(() => parseContextPlan({ ...PLAN_A, selectable: [{ layer: 'primary', query: { type: 'x' }, limit: 0 }] }), /limit/))
  t('wrong sourceReferencePolicy refused', throwsRefusal(() => parseContextPlan({ ...PLAN_A, sourceReferencePolicy: 'inline' }), /sourceReferencePolicy/))
  t('non-object plan refused', throwsRefusal(() => parseContextPlan('nope'), /object/))
  t('parse normalization is key-order independent (same planHash)', planHashOf(parseContextPlan({
    sourceReferencePolicy: 'artifact-ref',
    selectable: PLAN_A.selectable,
    mandatory: PLAN_A.mandatory,
    maxInputTokens: PLAN_A.maxInputTokens,
    exclusions: PLAN_A.exclusions,
  })) === planHashOf(parsedA))

  // =========================================================================
  // 2. Determinism — byte-identical packets, same ledger, same fingerprint
  // =========================================================================
  console.log('\n--- determinism ---')
  const packet1 = buildContextPacket(parsedA, ARTIFACTS, { model: MODEL, jobId: 'c01' })
  const packet2 = buildContextPacket(parsedA, ARTIFACTS, { model: MODEL, jobId: 'c01' })
  t('two builds from identical inputs → byte-identical packet JSON', JSON.stringify(packet1, null, 2) === JSON.stringify(packet2, null, 2))
  const shuffled = [...ARTIFACTS].reverse()
  t('input array order never matters (base canon is id-ascending)', JSON.stringify(buildContextPacket(parsedA, shuffled, { model: MODEL, jobId: 'c01' }), null, 2) === JSON.stringify(packet1, null, 2))
  t('same inputs → same fingerprint hash', packet1.fingerprint.hash === packet2.fingerprint.hash && packet1.fingerprint.hash.length === 64)
  t('normalized plan embeds stably (canonical JSON, sorted keys)', canonicalJson(parsedA) === canonicalJson(JSON.parse(canonicalJson(parsedA))))

  // =========================================================================
  // 3. Layer 1 — always present, never trimmed; unsatisfiable refused
  // =========================================================================
  console.log('\n--- layer 1: mandatory ---')
  const ids = (refs) => refs.map((r) => r.id)
  t('mandatory queries fill Layer 1 in plan order', eq(ids(packet1.layers.mandatory), ['goal-primary', 'schema-roles']))
  const bigMand = { id: 'big-mand', type: 'goal', contentHash: 'sha-big', sizeBytes: 120, content: 'B'.repeat(120) } // exactly 30 tokens
  const cap30Plan = parseContextPlan({ ...PLAN_A, maxInputTokens: 30, mandatory: [{ ids: ['big-mand'] }], exclusions: undefined })
  const cap30 = buildContextPacket(cap30Plan, [...ARTIFACTS, bigMand], { model: MODEL })
  t('mandatory layer alone filling the cap exactly is satisfiable (never trimmed)', eq(ids(cap30.layers.mandatory), ['big-mand']) && cap30.ledger.totalTokens === 30 && cap30.ledger.capTokens === 30)
  t('with the cap consumed by Layer 1, nothing else is included', cap30.layers.primary.length === 0 && cap30.layers.supporting.length === 0 && cap30.layers.distilled.length === 0)
  t('Layer-1 remainder is excluded-by-budget, nothing silent', cap30.manifest.filter((m) => m.disposition === 'excluded-by-budget').length === ARTIFACTS.length)
  const cap29Plan = parseContextPlan({ ...PLAN_A, maxInputTokens: 29, mandatory: [{ ids: ['big-mand'] }], exclusions: undefined })
  t('mandatory layer alone over cap is refused as unsatisfiable', throwsRefusal(() => buildContextPacket(cap29Plan, [...ARTIFACTS, bigMand], { model: MODEL }), /unsatisfiable.*mandatory.*30.*29/s))

  // =========================================================================
  // 4. Budget enforcement + exclusions + manifest (nothing silent)
  // =========================================================================
  console.log('\n--- budget, exclusions, manifest ---')
  t('Layer 2 primary rule 1 (diff×c01, timestamp-desc): newest first', eq(ids(packet1.layers.primary).slice(0, 2), ['diff-c01-b', 'diff-c01-a']))
  t('Layer 2 primary rule 2 (gateStatus failed, limit 2): id-ascending, bound honored', eq(ids(packet1.layers.primary).slice(2), ['probe-failed-1', 'probe-failed-2']))
  t('Layer 3 distilled pass-through carries §7.4 sourceRefs', eq(packet1.layers.distilled.map((r) => ({ id: r.id, sourceRefs: r.sourceRefs })), [{ id: 'distilled-research', sourceRefs: ['artifact:research-003#obs-4', 'artifact:research-011#obs-2'] }]))
  t('Layer 4 supporting fills the budget remainder in documented order, then stops fitting', eq(ids(packet1.layers.supporting), ['sup-tag-1', 'sup-tag-2', 'sup-tag-3']))
  t('plan exclusions remove before selection (poison matches the primary rule yet never enters a layer)', !packet1.layers.primary.some((r) => r.id === 'poison-artifact') && ids(packet1.layers.mandatory).concat(ids(packet1.layers.primary), ids(packet1.layers.distilled), ids(packet1.layers.supporting)).every((id) => id !== 'poison-artifact'))
  t('manifest covers every input artifact exactly once', packet1.manifest.length === ARTIFACTS.length && new Set(packet1.manifest.map((m) => m.id)).size === ARTIFACTS.length)
  const manifestById = new Map(packet1.manifest.map((m) => [m.id, m]))
  t('excluded-by-plan is recorded with that exact reason', manifestById.get('poison-artifact')?.disposition === 'excluded-by-plan')
  t('unselected-but-eligible artifacts are excluded-by-budget', manifestById.get('diff-c02')?.disposition === 'excluded-by-budget' && manifestById.get('probe-failed-3')?.disposition === 'excluded-by-budget' && manifestById.get('sup-tag-4')?.disposition === 'excluded-by-budget')
  const includedCount = packet1.manifest.filter((m) => m.disposition === 'included').length
  t('manifest inclusions equal the packet layers', includedCount === packet1.layers.mandatory.length + packet1.layers.primary.length + packet1.layers.distilled.length + packet1.layers.supporting.length)
  t('ledger: cap, per-layer sums, total (285 ≤ 300)', packet1.ledger.capTokens === 300 && packet1.ledger.perLayer.mandatory === 30 && packet1.ledger.perLayer.primary === 150 && packet1.ledger.perLayer.distilled === 25 && packet1.ledger.perLayer.supporting === 80 && packet1.ledger.totalTokens === 285 && packet1.ledger.totalTokens <= packet1.ledger.capTokens)
  t('token estimator is ceil(chars/4)', estimateTokens('abcd') === 1 && estimateTokens('abcde') === 2 && estimateTokens('') === 0)

  // =========================================================================
  // 5. Selectors — each §7.6:593-605 kind, exactly the matching artifacts
  // =========================================================================
  console.log('\n--- selectors (§7.6:593-605) ---')
  const widePlan = parseContextPlan({
    maxInputTokens: 100000,
    mandatory: [],
    selectable: [
      { layer: 'primary', query: { type: 'sel-type' } },
      { layer: 'primary', query: { candidate: 'cX' } },
      { layer: 'primary', query: { phase: 'build' } },
      { layer: 'primary', query: { producerRole: 'worker' } },
      { layer: 'primary', query: { gateStatus: 'passed' } },
      { layer: 'primary', query: { gateStatus: 'failed' } },
      { layer: 'primary', query: { lineageContains: 'root-art' } },
      { layer: 'primary', query: { newerThan: '2026-10-01' } },
      { layer: 'primary', query: { olderThan: '2026-10-01' } },
      { layer: 'primary', query: { ids: ['explicit-2', 'explicit-7'] } },
      { layer: 'primary', query: { tagged: 'nightly' } },
      { layer: 'supporting', query: { type: 'diff', candidate: 'c01' } },
    ],
    sourceReferencePolicy: 'artifact-ref',
  })
  const sel = [
    { id: 'sel-type-a', type: 'sel-type', contentHash: 'h', sizeBytes: 1, content: 'a' },
    { id: 'sel-type-b', type: 'other', contentHash: 'h', sizeBytes: 1, content: 'a' },
    { id: 'sel-cand-a', type: 'note', contentHash: 'h', sizeBytes: 1, candidate: 'cX', content: 'a' },
    { id: 'sel-cand-b', type: 'note', contentHash: 'h', sizeBytes: 1, candidate: 'cY', content: 'a' },
    { id: 'sel-phase-a', type: 'note', contentHash: 'h', sizeBytes: 1, phase: 'build', content: 'a' },
    { id: 'sel-role-a', type: 'note', contentHash: 'h', sizeBytes: 1, producerRole: 'worker', content: 'a' },
    { id: 'sel-role-b', type: 'note', contentHash: 'h', sizeBytes: 1, producerRole: 'reviewer', content: 'a' },
    { id: 'sel-gate-p', type: 'probe', contentHash: 'h', sizeBytes: 1, gateStatus: 'passed', content: 'a' },
    { id: 'sel-gate-f', type: 'probe', contentHash: 'h', sizeBytes: 1, gateStatus: 'failed', content: 'a' },
    { id: 'sel-gate-n', type: 'probe', contentHash: 'h', sizeBytes: 1, content: 'a' }, // absent gateStatus matches neither
    { id: 'sel-lin-a', type: 'note', contentHash: 'h', sizeBytes: 1, lineage: ['x', 'root-art'], content: 'a' },
    { id: 'sel-lin-b', type: 'note', contentHash: 'h', sizeBytes: 1, lineage: ['other'], content: 'a' },
    { id: 'sel-lin-c', type: 'note', contentHash: 'h', sizeBytes: 1, content: 'a' }, // no lineage attr
    { id: 'ts-oct', type: 'note', contentHash: 'h', sizeBytes: 1, timestamp: '2026-10-16', content: 'a' },
    { id: 'ts-sep', type: 'note', contentHash: 'h', sizeBytes: 1, timestamp: '2026-9-16', content: 'a' },
    { id: 'ts-none', type: 'note', contentHash: 'h', sizeBytes: 1, content: 'a' },
    { id: 'explicit-2', type: 'note', contentHash: 'h', sizeBytes: 1, content: 'a' },
    { id: 'explicit-7', type: 'note', contentHash: 'h', sizeBytes: 1, content: 'a' },
    { id: 'explicit-9', type: 'note', contentHash: 'h', sizeBytes: 1, content: 'a' },
    { id: 'sel-tag-a', type: 'note', contentHash: 'h', sizeBytes: 1, tags: ['nightly', 'x'], content: 'a' },
    { id: 'sel-tag-b', type: 'note', contentHash: 'h', sizeBytes: 1, content: 'a' },
    { id: 'conj-1', type: 'diff', contentHash: 'h', sizeBytes: 1, candidate: 'c01', content: 'a' },
    { id: 'conj-2', type: 'diff', contentHash: 'h', sizeBytes: 1, candidate: 'c02', content: 'a' },
    { id: 'conj-3', type: 'report', contentHash: 'h', sizeBytes: 1, candidate: 'c01', content: 'a' },
  ]
  const selPacket = buildContextPacket(widePlan, sel, { model: MODEL })
  const primaryIds = ids(selPacket.layers.primary)
  t('by artifact type', eq(primaryIds.filter((id) => id.startsWith('sel-type')), ['sel-type-a']))
  t('by candidate', eq(primaryIds.filter((id) => id.startsWith('sel-cand')), ['sel-cand-a']))
  t('by phase', eq(primaryIds.filter((id) => id.startsWith('sel-phase')), ['sel-phase-a']))
  t('by producer role', eq(primaryIds.filter((id) => id.startsWith('sel-role')), ['sel-role-a']))
  t('by machine gate status, both values; absent never matches', eq(primaryIds.filter((id) => id.startsWith('sel-gate')), ['sel-gate-p', 'sel-gate-f']))
  t('by lineage (array membership; absent lineage never matches)', eq(primaryIds.filter((id) => id.startsWith('sel-lin')), ['sel-lin-a']))
  const tsRec = (id) => sel.find((r) => r.id === id)
  t('by timestamp is lexicographic — no Date parsing (bounds 2026-10-01)',
    matchesQuery(tsRec('ts-oct'), { newerThan: '2026-10-01' })
    && matchesQuery(tsRec('ts-sep'), { newerThan: '2026-10-01' })
    && !matchesQuery(tsRec('ts-sep'), { olderThan: '2026-10-01' })
    && !matchesQuery(tsRec('ts-oct'), { olderThan: '2026-10-01' })
    && !matchesQuery(tsRec('ts-none'), { newerThan: '2026-10-01' })
    && !matchesQuery(tsRec('ts-none'), { olderThan: '2026-10-01' }))
  t('  … 2026-9-16 sorts AFTER 2026-10-01 stringwise although it is chronologically before — a Date-based compare would flip both', '2026-9-16' > '2026-10-01')
  t('by timestamp in the build: newerThan rule matches both, olderThan none', eq(primaryIds.filter((id) => id.startsWith('ts-')), ['ts-oct', 'ts-sep']))
  t('by explicit artifact ID, exactly the named set', eq(primaryIds.filter((id) => id.startsWith('explicit')), ['explicit-2', 'explicit-7']))
  t('by deterministic tag (absent tags never match)', eq(primaryIds.filter((id) => id.startsWith('sel-tag')), ['sel-tag-a']))
  t('conjunction: type AND candidate must both match', eq(ids(selPacket.layers.supporting), ['conj-1']))
  t('matchesQuery is the direct predicate behind the build', matchesQuery(sel.find((r) => r.id === 'conj-1'), { type: 'diff', candidate: 'c01' }) && !matchesQuery(sel.find((r) => r.id === 'conj-2'), { type: 'diff', candidate: 'c01' }) && !matchesQuery(sel.find((r) => r.id === 'conj-3'), { type: 'diff', candidate: 'c01' }))

  // =========================================================================
  // 6. Layer 3 — distilled pass-through semantics
  // =========================================================================
  console.log('\n--- layer 3: distilled pass-through ---')
  const distillPlan = parseContextPlan({
    maxInputTokens: 100000,
    mandatory: [],
    selectable: [{ layer: 'primary', query: { type: 'distillation-report' } }],
    sourceReferencePolicy: 'artifact-ref',
  })
  const distillPacket = buildContextPacket(distillPlan, [ARTIFACTS.find((a) => a.id === 'distilled-research')], { model: MODEL })
  t('a sourceRefs carrier is Layer-3 class even when a rule names its type', distillPacket.layers.primary.length === 0 && distillPacket.layers.distilled.length === 1 && distillPacket.layers.distilled[0].sourceRefs.length === 2)
  const smallCapDistill = parseContextPlan({ ...distillPlan, maxInputTokens: 10 })
  const distillNoFit = buildContextPacket(smallCapDistill, [ARTIFACTS.find((a) => a.id === 'distilled-research')], { model: MODEL })
  t('Layer 3 respects the budget: a distilled entry that cannot fit is excluded-by-budget', distillNoFit.layers.distilled.length === 0 && distillNoFit.manifest[0].disposition === 'excluded-by-budget')

  // =========================================================================
  // 7. Fingerprint (§7.7 narrowed) — sensitivity + producerless nulls
  // =========================================================================
  console.log('\n--- fingerprint ---')
  const baseHash = packet1.fingerprint.hash
  const hashChangedArt = ARTIFACTS.map((a) => (a.id === 'diff-c01-b' ? { ...a, contentHash: 'sha-b-changed' } : a))
  const hashChangedSel = buildContextPacket(parsedA, hashChangedArt, { model: MODEL, jobId: 'c01' })
  const differentSelection = buildContextPacket(parseContextPlan({ ...PLAN_A, selectable: PLAN_A.selectable.slice(0, 2) }), ARTIFACTS, { model: MODEL, jobId: 'c01' })
  const differentModel = buildContextPacket(parsedA, ARTIFACTS, { model: 'zai-coding-plan/glm-5.3', jobId: 'c01' })
  const differentPlan = buildContextPacket(parseContextPlan({ ...PLAN_A, maxInputTokens: 301 }), ARTIFACTS, { model: MODEL, jobId: 'c01' })
  t('changing one selected artifact’s contentHash changes the hash', hashChangedSel.fingerprint.hash !== baseHash)
  t('changing the selection set changes the hash', differentSelection.fingerprint.hash !== baseHash)
  t('changing the model string changes the hash', differentModel.fingerprint.hash !== baseHash)
  t('changing any plan field changes the hash (even with identical inclusions)', differentPlan.fingerprint.hash !== baseHash && eq(ids(differentPlan.layers.supporting), ids(packet1.layers.supporting)))
  const c = packet1.fingerprint.components
  t('the four producerless §7.7 components are recorded null', c.promptVersion === null && c.roleVersion === null && c.reasoningConfiguration === null && c.projectManifestVersion === null)
  t('fingerprint components carry model + planHash + selected in packet order', c.model === MODEL && c.planHash === planHashOf(parsedA) && eq(c.selected, [...packet1.layers.mandatory, ...packet1.layers.primary, ...packet1.layers.distilled, ...packet1.layers.supporting].map((r) => ({ id: r.id, contentHash: r.contentHash }))))
  const otherJob = buildContextPacket(parsedA, ARTIFACTS, { model: MODEL, jobId: 'zz-other-job' })
  t('jobId is recorded when provided and never fingerprinted (different jobId → identical hash)', packet1.jobId === 'c01' && otherJob.jobId === 'zz-other-job' && otherJob.fingerprint.hash === baseHash)

  // =========================================================================
  // 8. Inspector CLI — happy path, --json, --run-root resolution
  // =========================================================================
  console.log('\n--- inspector CLI ---')
  const planPath = join(sandbox, 'plan-a.json')
  const packetPath = join(sandbox, 'packet-a.json')
  writeFileSync(planPath, JSON.stringify(PLAN_A, null, 2))
  writeFileSync(packetPath, JSON.stringify(packet1, null, 2))
  const planShaBefore = sha256File(planPath)
  const packetShaBefore = sha256File(packetPath)

  const happy = runCli(['--plan', planPath, '--packet', packetPath])
  t('inspect exits 0', happy.code === 0)
  t('renders the token budget (cap + per-layer ledger + total)', /token budget/.test(happy.stdout) && /cap: 300/.test(happy.stdout) && /mandatory: 30 tokens/.test(happy.stdout) && /primary: 150 tokens/.test(happy.stdout) && /distilled: 25 tokens/.test(happy.stdout) && /supporting: 80 tokens/.test(happy.stdout) && /total: 285 tokens/.test(happy.stdout))
  t('renders mandatory / selected / distilled / supporting included artifacts', /mandatory included \(2\):/.test(happy.stdout) && /primary included \(4\):/.test(happy.stdout) && /distilled included \(1\):/.test(happy.stdout) && /supporting included \(3\):/.test(happy.stdout) && happy.stdout.includes('diff-c01-b') && happy.stdout.includes('probe-failed-2'))
  t('renders excluded artifacts with reasons', /excluded artifacts \(4\):/.test(happy.stdout) && /poison-artifact\s+excluded-by-plan/.test(happy.stdout) && /sup-tag-4\s+excluded-by-budget/.test(happy.stdout))
  t('renders the L3 source chain', /sources: artifact:research-003#obs-4, artifact:research-011#obs-2/.test(happy.stdout))
  t('renders the context fingerprint with no-producer components', /context fingerprint/.test(happy.stdout) && happy.stdout.includes(baseHash) && /prompt version: no-producer/.test(happy.stdout) && /project manifest version: no-producer/.test(happy.stdout))
  t('renders the job id', /job: c01/.test(happy.stdout))

  const happyJson = runCli(['--plan', planPath, '--packet', packetPath, '--json'])
  t('--json exits 0 and parses', happyJson.code === 0)
  let view = null
  try {
    view = JSON.parse(happyJson.stdout)
  } catch { view = null }
  t('--json emits the same structure: budget', view !== null && view.budget.capTokens === 300 && view.budget.totalTokens === 285 && view.budget.perLayer.primary === 150)
  t('--json: per-layer included artifacts', view !== null && eq(ids(view.included.mandatory), ['goal-primary', 'schema-roles']) && eq(ids(view.included.supporting), ['sup-tag-1', 'sup-tag-2', 'sup-tag-3']))
  t('--json: excluded with reasons + L3 source chains', view !== null && view.excluded.some((e) => e.id === 'poison-artifact' && e.reason === 'excluded-by-plan') && eq(view.sourceChains, [{ id: 'distilled-research', sourceRefs: ['artifact:research-003#obs-4', 'artifact:research-011#obs-2'] }]))
  t('--json: fingerprint block matches the packet', view !== null && view.fingerprint.hash === baseHash && view.fingerprint.planHash === planHashOf(parsedA) && view.fingerprint.model === MODEL && view.fingerprint.producers.promptVersion === null)

  const rel = runCli(['--plan', 'plan-a.json', '--packet', 'packet-a.json', '--run-root', sandbox])
  t('relative paths resolve against --run-root', rel.code === 0 && /total: 285 tokens/.test(rel.stdout))

  // The inspector never writes.
  t('plan + packet files byte-identical after an inspect', sha256File(planPath) === planShaBefore && sha256File(packetPath) === packetShaBefore)

  // =========================================================================
  // 9. Inspector refusals — non-zero, no body printed
  // =========================================================================
  console.log('\n--- inspector refusals (exit non-zero, no stdout body) ---')
  const refusal = (label, args, re) => {
    const r = runCli(args)
    t(`${label} exits non-zero`, r.code !== 0)
    t(`${label}: no body printed`, r.stdout.trim() === '')
    if (re !== undefined) t(`${label}: refusal names the offense`, re.test(r.stderr))
    return r
  }
  refusal('missing --plan', ['--packet', packetPath], /--plan/)
  refusal('missing --packet', ['--plan', planPath], /--packet/)
  refusal('missing plan file', ['--plan', join(sandbox, 'absent-plan.json'), '--packet', packetPath], /absent-plan/)
  refusal('missing packet file', ['--plan', planPath, '--packet', join(sandbox, 'absent-packet.json')], /absent-packet/)

  const badJsonPath = join(sandbox, 'bad.json')
  writeFileSync(badJsonPath, '{not json')
  refusal('unparseable plan JSON', ['--plan', badJsonPath, '--packet', packetPath], /not valid JSON/)
  refusal('unparseable packet JSON', ['--plan', planPath, '--packet', badJsonPath], /not valid JSON/)

  const unknownFieldPlan = join(sandbox, 'plan-unknown.json')
  writeFileSync(unknownFieldPlan, JSON.stringify({ ...PLAN_A, relevance: 'ai' }))
  refusal('plan with an unknown field', ['--plan', unknownFieldPlan, '--packet', packetPath], /relevance/)
  const distillationPlan = join(sandbox, 'plan-distillation.json')
  writeFileSync(distillationPlan, JSON.stringify({ ...PLAN_A, distillation: { shards: 5 } }))
  refusal('plan carrying a distillation block', ['--plan', distillationPlan, '--packet', packetPath], /distillation/)
  const zeroCapPlan = join(sandbox, 'plan-zerocap.json')
  writeFileSync(zeroCapPlan, JSON.stringify({ ...PLAN_A, maxInputTokens: 0 }))
  refusal('plan with maxInputTokens 0', ['--plan', zeroCapPlan, '--packet', packetPath], /maxInputTokens/)

  // Ledger inconsistent with recomputation: bump one recorded per-layer sum.
  const tampered = JSON.parse(JSON.stringify(packet1))
  tampered.ledger.perLayer.mandatory += 1
  const tamperedPath = join(sandbox, 'packet-ledger.json')
  writeFileSync(tamperedPath, JSON.stringify(tampered))
  refusal('recorded ledger inconsistent with recomputation', ['--plan', planPath, '--packet', tamperedPath], /inconsistent with recomputation/)

  // Recorded total over cap — internally consistent, still refused.
  const overcapPlanRaw = { ...PLAN_A, maxInputTokens: 100, mandatory: [], selectable: [], exclusions: undefined }
  const overcapPlanParsed = parseContextPlan(overcapPlanRaw)
  const overcapPlanPath = join(sandbox, 'plan-overcap.json')
  writeFileSync(overcapPlanPath, JSON.stringify(overcapPlanRaw))
  const overRef = { id: 'overcap-ref', type: 'diff', contentHash: 'sha-over', sizeBytes: 600, layer: 2, estimatedTokens: 150 }
  const overcapPacket = {
    jobId: null,
    layers: { mandatory: [], primary: [overRef], distilled: [], supporting: [] },
    manifest: [{ id: 'overcap-ref', disposition: 'included', layer: 2 }],
    ledger: { capTokens: 100, perLayer: { mandatory: 0, primary: 150, distilled: 0, supporting: 0 }, totalTokens: 150 },
    fingerprint: {
      hash: fingerprintHashOf(MODEL, planHashOf(overcapPlanParsed), [{ id: 'overcap-ref', contentHash: 'sha-over' }]),
      components: {
        model: MODEL,
        planHash: planHashOf(overcapPlanParsed),
        selected: [{ id: 'overcap-ref', contentHash: 'sha-over' }],
        promptVersion: null,
        roleVersion: null,
        reasoningConfiguration: null,
        projectManifestVersion: null,
      },
    },
  }
  const overcapPath = join(sandbox, 'packet-overcap.json')
  writeFileSync(overcapPath, JSON.stringify(overcapPacket))
  refusal('recorded total over cap', ['--plan', overcapPlanPath, '--packet', overcapPath], /over cap/)

  // Recorded cap inconsistent with the plan.
  const capMismatch = JSON.parse(JSON.stringify(packet1))
  capMismatch.ledger.capTokens = 299
  const capMismatchPath = join(sandbox, 'packet-capmismatch.json')
  writeFileSync(capMismatchPath, JSON.stringify(capMismatch))
  refusal('recorded cap inconsistent with the plan', ['--plan', planPath, '--packet', capMismatchPath], /maxInputTokens/)

  // components.selected diverging from the packet layers (hash re-tampered
  // to stay internally consistent, so ONLY the cross-check can fire).
  const selMismatch = JSON.parse(JSON.stringify(packet1))
  selMismatch.fingerprint.components.selected = selMismatch.fingerprint.components.selected.slice(1)
  selMismatch.fingerprint.hash = fingerprintHashOf(MODEL, selMismatch.fingerprint.components.planHash, selMismatch.fingerprint.components.selected)
  const selMismatchPath = join(sandbox, 'packet-selmismatch.json')
  writeFileSync(selMismatchPath, JSON.stringify(selMismatch))
  refusal('fingerprint selected inconsistent with the packet', ['--plan', planPath, '--packet', selMismatchPath], /selected/)

  // Packet built against a different plan → plan-hash mismatch on recompute.
  // Same cap on purpose: the cap check must not fire before the plan hash.
  const otherPlanPath = join(sandbox, 'plan-b.json')
  writeFileSync(otherPlanPath, JSON.stringify({ ...PLAN_A, selectable: [] }))
  refusal('plan-hash mismatch on recompute', ['--plan', otherPlanPath, '--packet', packetPath], /plan hash/)

  // Recorded hash tampered → fingerprint mismatch on recompute.
  const hashMismatch = JSON.parse(JSON.stringify(packet1))
  hashMismatch.fingerprint.hash = '0'.repeat(64)
  const hashMismatchPath = join(sandbox, 'packet-hashmismatch.json')
  writeFileSync(hashMismatchPath, JSON.stringify(hashMismatch))
  refusal('fingerprint mismatch on recompute', ['--plan', planPath, '--packet', hashMismatchPath], /fingerprint mismatch/)

  // Structural shape refusals.
  const badShape = JSON.parse(JSON.stringify(packet1))
  badShape.layers.mandatory = 'oops'
  const badShapePath = join(sandbox, 'packet-badshape.json')
  writeFileSync(badShapePath, JSON.stringify(badShape))
  refusal('packet with a non-array layer', ['--plan', planPath, '--packet', badShapePath], /layers\.mandatory/)

  const l3NoRefs = JSON.parse(JSON.stringify(packet1))
  delete l3NoRefs.layers.distilled[0].sourceRefs
  const l3NoRefsPath = join(sandbox, 'packet-l3norefs.json')
  writeFileSync(l3NoRefsPath, JSON.stringify(l3NoRefs))
  refusal('Layer-3 entry without sourceRefs', ['--plan', planPath, '--packet', l3NoRefsPath], /sourceRefs/)

  // Refusals wrote nothing: the inputs are still byte-identical.
  t('refused inspects never wrote the inputs', sha256File(planPath) === planShaBefore && sha256File(packetPath) === packetShaBefore)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\ncheck-context: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-context: ALL GREEN')
