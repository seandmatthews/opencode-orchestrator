// Shard-distillation-core self-check (Gate 1.14, fast tier, T-013) — run
// under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-distillation.mjs
// Pins the §7.3-7.5 record/contract level that T-012 reserved and this slice
// chose: the `DistillationPlan` block (§7.1:507 — the type the spec uses but
// never defines), `parseDistillationReport` (§23.2:1358-1381 — the §7.5
// rule-1 enforcement point at the record level), the builder's plan-level
// untraceable-chain refusal, planHash sensitivity to the block, and the CLI
// round-trip. Drives the pure functions (src/context.ts) directly over
// hand-built fixtures — the Gate 1.13 pattern, since no artifact store
// exists to produce inputs (§34:2028) — plus the inspector CLI as a
// list-form subprocess (AGENTS.md #4). Zero model tokens, zero npm deps.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ContextRefusal,
  buildContextPacket,
  parseContextPlan,
  parseDistillationPlan,
  parseDistillationReport,
  planHashOf,
} from '../src/context.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const ids = (refs) => refs.map((r) => r.id)
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
const MODEL = 'zai-coding-plan/glm-5.3-flash'

const SPEC_REPORT = {
  source_artifacts: ['research-001', 'research-002', 'research-003'],
  claims: [
    {
      id: 'claim-1',
      statement: 'Yaw acceleration appears in multiple reports as a likely source of sluggishness.',
      source_refs: ['artifact:research-001#obs-3', 'artifact:research-003#obs-1'],
      disagreement_refs: ['artifact:research-002#obs-6'],
    },
  ],
}
// The §23.2:1371-1377 bare spelling — refused; this slice standardizes on
// the §7.4:565-578 prefixed form (the documented divergence reconciliation).
const BARE_REF_FORM = { ...SPEC_REPORT, claims: [{ ...SPEC_REPORT.claims[0], source_refs: ['research-001#obs-3'] }] }
const claimOver = (over) =>
  parseDistillationReport({ ...SPEC_REPORT, claims: [{ ...SPEC_REPORT.claims[0], ...over }] })

const DIST_ARTIFACTS = [
  { id: 'dist-a', type: 'distillation-report', contentHash: 'sha-da', sizeBytes: 40, sourceRefs: ['artifact:research-001#obs-1'], content: 'A'.repeat(40) }, // 10 tokens
  { id: 'note-b', type: 'note', contentHash: 'sha-nb', sizeBytes: 40, content: 'B'.repeat(40) }, // 10 tokens
]
const BLOCKLESS_PLAN_RAW = {
  maxInputTokens: 100,
  mandatory: [],
  selectable: [{ layer: 'supporting', query: { type: 'note' } }],
  sourceReferencePolicy: 'artifact-ref',
}

// Pinned byte-for-byte: the blockless build's output is unchanged by this
// slice by construction (plans carrying `distillation` were refused outright
// before T-013 — src/context.ts's parse refusal — so blockless parsing and
// building are untouched; the T-012:94-100 narrowed-hash stability argument,
// verbatim). This snapshot is that pre-change output, so any future change
// to blockless behavior fails here loudly.
const BLOCKLESS_SNAPSHOT = `{
  "jobId": null,
  "layers": {
    "mandatory": [],
    "primary": [],
    "distilled": [
      {
        "id": "dist-a",
        "type": "distillation-report",
        "contentHash": "sha-da",
        "sizeBytes": 40,
        "layer": 3,
        "estimatedTokens": 10,
        "sourceRefs": [
          "artifact:research-001#obs-1"
        ]
      }
    ],
    "supporting": [
      {
        "id": "note-b",
        "type": "note",
        "contentHash": "sha-nb",
        "sizeBytes": 40,
        "layer": 4,
        "estimatedTokens": 10
      }
    ]
  },
  "manifest": [
    {
      "id": "dist-a",
      "disposition": "included",
      "layer": 3
    },
    {
      "id": "note-b",
      "disposition": "included",
      "layer": 4
    }
  ],
  "ledger": {
    "capTokens": 100,
    "perLayer": {
      "mandatory": 0,
      "primary": 0,
      "distilled": 10,
      "supporting": 10
    },
    "totalTokens": 20
  },
  "fingerprint": {
    "hash": "fdcb3f8377db6943e6b26b06d7dee56fb97e58c075aa8a1ce3d9747c824b8584",
    "components": {
      "model": "zai-coding-plan/glm-5.3-flash",
      "planHash": "f00d94d62fbb7df16ed848f973ed4504c09ce758f925355a413c30134b70a7ff",
      "selected": [
        {
          "id": "dist-a",
          "contentHash": "sha-da"
        },
        {
          "id": "note-b",
          "contentHash": "sha-nb"
        }
      ],
      "promptVersion": null,
      "roleVersion": null,
      "reasoningConfiguration": null,
      "projectManifestVersion": null
    }
  }
}`

const sandbox = mkdtempSync(join(tmpdir(), 't013-distillation-'))
try {
  // =========================================================================
  // 1. DistillationPlan parse — positive + every refusal
  // =========================================================================
  console.log('\n--- DistillationPlan parse ---')
  const goodPlan = parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: ['d1', 'd2'] } })
  t('a valid block parses with expectedArtifactIds intact', goodPlan.distillation !== undefined && eq(goodPlan.distillation.expectedArtifactIds, ['d1', 'd2']))
  t('parseDistillationPlan returns the normalized block', eq(parseDistillationPlan({ expectedArtifactIds: ['d1'] }), { expectedArtifactIds: ['d1'] }))
  t('non-object block refused', throwsRefusal(() => parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: 5 }), /"distillation" block: must be a JSON object/))
  t('unknown sub-field refused naming it', throwsRefusal(() => parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: ['d1'], shards: 5 } }), /unknown field "shards"/))
  t('non-array expectedArtifactIds refused', throwsRefusal(() => parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: 'd1' } }), /expectedArtifactIds/))
  t('empty expectedArtifactIds refused', throwsRefusal(() => parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: [] } }), /expectedArtifactIds/))
  t('non-string entry refused', throwsRefusal(() => parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: ['d1', 5] } }), /expectedArtifactIds/))
  t('empty-string entry refused', throwsRefusal(() => parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: [''] } }), /expectedArtifactIds/))
  t('duplicate entries refused naming the duplicate', throwsRefusal(() => parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: ['d1', 'd1'] } }), /duplicate entry "d1"/))
  t('parseDistillationPlan direct: non-object refused', throwsRefusal(() => parseDistillationPlan(null), /must be a JSON object/))
  t('parseDistillationPlan direct: unknown sub-field refused naming it', throwsRefusal(() => parseDistillationPlan({ expectedArtifactIds: ['d1'], shards: 5 }), /shards/))

  // =========================================================================
  // 2. parseDistillationReport — §23.2 shape, every refusal, §7.5 rule 1
  // =========================================================================
  console.log('\n--- parseDistillationReport (§23.2:1358-1381, §7.4-prefixed refs) ---')
  const specReport = parseDistillationReport(SPEC_REPORT)
  t('the §23.2 example (adapted to the pinned §7.4-prefixed refs) parses with camelCase normalization', eq(specReport, {
    sourceArtifacts: ['research-001', 'research-002', 'research-003'],
    claims: [{
      id: 'claim-1',
      statement: SPEC_REPORT.claims[0].statement,
      sourceRefs: ['artifact:research-001#obs-3', 'artifact:research-003#obs-1'],
      disagreementRefs: ['artifact:research-002#obs-6'],
    }],
  }))
  t('claims: [] is valid — nothing worth claiming still produces the record (documented choice)', eq(parseDistillationReport({ source_artifacts: ['r1'], claims: [] }), { sourceArtifacts: ['r1'], claims: [] }))
  t('a claim without disagreement_refs omits the optional field', parseDistillationReport({ source_artifacts: ['r1'], claims: [{ id: 'c1', statement: 's', source_refs: ['artifact:r1#a'] }] }).claims[0].disagreementRefs === undefined)
  t('anchors are opaque and never resolved (no store, §34:2028): a non-numeric anchor passes', parseDistillationReport({ source_artifacts: ['r1'], claims: [{ id: 'c1', statement: 's', source_refs: ['artifact:r1#totally-not-checked'] }] }).claims[0].sourceRefs[0] === 'artifact:r1#totally-not-checked')
  t('an unknown top-level field refused naming it', throwsRefusal(() => parseDistillationReport({ ...SPEC_REPORT, extra: true }), /unknown field "extra"/))
  t('non-object report refused', throwsRefusal(() => parseDistillationReport('nope'), /must be a JSON object/))
  t('missing claims array refused', throwsRefusal(() => parseDistillationReport({ source_artifacts: ['r1'] }), /"claims" must be an array/))
  t('empty source_artifacts refused', throwsRefusal(() => parseDistillationReport({ source_artifacts: [], claims: [] }), /source_artifacts/))
  t('non-string source_artifacts entry refused', throwsRefusal(() => parseDistillationReport({ source_artifacts: ['r1', 5], claims: [] }), /source_artifacts/))
  t('empty-string source_artifacts entry refused', throwsRefusal(() => parseDistillationReport({ source_artifacts: [''], claims: [] }), /source_artifacts/))
  t('a claim missing its id refused', throwsRefusal(() => parseDistillationReport({ ...SPEC_REPORT, claims: [{ statement: 's', source_refs: ['artifact:research-001#obs-3'] }] }), /"id" must be a non-empty string/))
  t('a non-string claim id refused', throwsRefusal(() => claimOver({ id: 7 }), /"id" must be a non-empty string/))
  t('duplicate claim ids refused naming the claim id', throwsRefusal(() => parseDistillationReport({ ...SPEC_REPORT, claims: [SPEC_REPORT.claims[0], { ...SPEC_REPORT.claims[0] }] }), /claim "claim-1".*duplicate claim id/s))
  t('an unknown claim field refused naming it and the claim id', throwsRefusal(() => claimOver({ confidence: 0.9 }), /claim "claim-1".*unknown field "confidence"/s))
  t('an empty statement refused naming the claim id', throwsRefusal(() => claimOver({ statement: '' }), /claim "claim-1".*"statement" must be a non-empty string/s))
  t('a missing source_refs refused naming the claim id', throwsRefusal(() => { const c = { ...SPEC_REPORT.claims[0] }; delete c.source_refs; return parseDistillationReport({ ...SPEC_REPORT, claims: [c] }) }, /claim "claim-1".*"source_refs" must be a non-empty array/s))
  t('an empty source_refs refused naming the claim id', throwsRefusal(() => claimOver({ source_refs: [] }), /claim "claim-1".*"source_refs" must be a non-empty array/s))
  t('the bare "id#anchor" spelling (§23.2:1371-1377) is refused — the documented divergence, pinned', throwsRefusal(() => parseDistillationReport(BARE_REF_FORM), /bare "id#anchor" spelling is refused/))
  t('a ref missing "#" refused', throwsRefusal(() => claimOver({ source_refs: ['artifact:research-001'] }), /exactly one "#"/))
  t('a ref with two "#" refused', throwsRefusal(() => claimOver({ source_refs: ['artifact:r1#obs-3#x'] }), /exactly one "#"/))
  t('an empty artifact id refused', throwsRefusal(() => claimOver({ source_refs: ['artifact:#obs-3'] }), /non-empty artifact id and a non-empty anchor/))
  t('an empty anchor refused', throwsRefusal(() => claimOver({ source_refs: ['artifact:research-001#'] }), /non-empty artifact id and a non-empty anchor/))
  t('a non-string ref refused', throwsRefusal(() => claimOver({ source_refs: [42] }), /artifact:<id>#<anchor>/))
  t('an unresolvable source_ref is refused naming the claim id and the missing id', throwsRefusal(() => claimOver({ source_refs: ['artifact:research-004#obs-3'] }), /claim "claim-1".*cites artifact id "research-004" which is not in the report's declared source_artifacts/s))
  t('disagreement_refs is resolved like source_refs: an unresolvable entry refused naming the claim id', throwsRefusal(() => claimOver({ disagreement_refs: ['artifact:research-999#obs-6'] }), /claim "claim-1".*disagreement_refs\[0\].*research-999/s))
  t('an empty disagreement_refs array refused', throwsRefusal(() => claimOver({ disagreement_refs: [] }), /"disagreement_refs", when present, must be a non-empty array/))

  // =========================================================================
  // 3. Builder integration — the plan-level untraceable-chain refusal
  // =========================================================================
  console.log('\n--- builder integration (declaration precedes the budget test) ---')
  const blockless = buildContextPacket(parseContextPlan(BLOCKLESS_PLAN_RAW), DIST_ARTIFACTS, { model: MODEL })
  t('a blockless plan builds byte-identically to the pre-change fixture output (pinned snapshot)', JSON.stringify(blockless, null, 2) === BLOCKLESS_SNAPSHOT)
  const undeclaredFits = parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: ['other-report'] } })
  t('an undeclared Layer-3-class record is refused naming its id, when it would fit', throwsRefusal(() => buildContextPacket(undeclaredFits, DIST_ARTIFACTS, { model: MODEL }), /untraceable distilled entry "dist-a"/))
  const tightBlockless = buildContextPacket(parseContextPlan({ ...BLOCKLESS_PLAN_RAW, maxInputTokens: 5 }), DIST_ARTIFACTS, { model: MODEL })
  t('counterfactual: under a cap of 5 the same record is excluded-by-budget', tightBlockless.layers.distilled.length === 0 && tightBlockless.manifest[0].disposition === 'excluded-by-budget')
  const undeclaredBudget = parseContextPlan({ ...BLOCKLESS_PLAN_RAW, maxInputTokens: 5, distillation: { expectedArtifactIds: ['other-report'] } })
  t('an undeclared Layer-3-class record is refused even when it would be excluded-by-budget (declaration precedes the budget test)', throwsRefusal(() => buildContextPacket(undeclaredBudget, DIST_ARTIFACTS, { model: MODEL }), /untraceable distilled entry "dist-a"/))
  const declaredPlan = parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: ['dist-a'] } })
  const declared = buildContextPacket(declaredPlan, DIST_ARTIFACTS, { model: MODEL })
  t('a declared entry is admitted with Layer-3 semantics unchanged', eq(ids(declared.layers.distilled), ['dist-a']) && declared.ledger.perLayer.distilled === 10)
  t('…with ledger and manifest identical to the blockless build', JSON.stringify(declared.ledger) === JSON.stringify(blockless.ledger) && JSON.stringify(declared.manifest) === JSON.stringify(blockless.manifest))
  const absentPlan = parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: ['dist-a', 'never-arrived'] } })
  const absent = buildContextPacket(absentPlan, DIST_ARTIFACTS, { model: MODEL })
  t('declared-but-absent is not a refusal — the builder refuses what arrived untraceable, not what didn\'t arrive', absent.manifest.every((m) => m.id !== 'never-arrived') && eq(ids(absent.layers.distilled), ['dist-a']))
  const l1Plan = parseContextPlan({ maxInputTokens: 100, mandatory: [{ ids: ['dist-a'] }], selectable: [], sourceReferencePolicy: 'artifact-ref', distillation: { expectedArtifactIds: ['other-report'] } })
  t('a Layer-3-class record captured by Layer 1 is still a declaration-check target (every Layer-3-class record the builder sees)', throwsRefusal(() => buildContextPacket(l1Plan, DIST_ARTIFACTS, { model: MODEL }), /untraceable distilled entry "dist-a"/))

  // =========================================================================
  // 4. Fingerprint — planHash covers the block; nothing previously valid moves
  // =========================================================================
  console.log('\n--- planHash sensitivity ---')
  t('a plan carrying the block hashes differently from the same plan without it', planHashOf(declaredPlan) !== planHashOf(parseContextPlan(BLOCKLESS_PLAN_RAW)))
  t('different expectedArtifactIds hash differently', planHashOf(parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: ['x'] } })) !== planHashOf(parseContextPlan({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: ['y'] } })))
  t('the block changes the fingerprint through the planHash (identical inclusions)', declared.fingerprint.hash !== blockless.fingerprint.hash && eq(ids(declared.layers.distilled), ids(blockless.layers.distilled)))

  // =========================================================================
  // 5. CLI round-trip — valid block inspects; invalid block refuses, no body
  // =========================================================================
  console.log('\n--- CLI round-trip ---')
  const validPacket = declared
  const validPlanPath = join(sandbox, 'plan-valid.json')
  const validPacketPath = join(sandbox, 'packet-valid.json')
  writeFileSync(validPlanPath, JSON.stringify({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: ['dist-a'] } }))
  writeFileSync(validPacketPath, JSON.stringify(validPacket, null, 2))
  const okRun = runCli(['--plan', validPlanPath, '--packet', validPacketPath])
  t('a valid block round-trips through the inspector: exit 0', okRun.code === 0 && /distilled included \(1\):/.test(okRun.stdout))
  const badPlanPath = join(sandbox, 'plan-badblock.json')
  writeFileSync(badPlanPath, JSON.stringify({ ...BLOCKLESS_PLAN_RAW, distillation: { expectedArtifactIds: ['dist-a'], shards: 3 } }))
  const badRun = runCli(['--plan', badPlanPath, '--packet', validPacketPath])
  t('an invalid block exits non-zero', badRun.code !== 0)
  t('an invalid block prints no body', badRun.stdout.trim() === '')
  t('the invalid-block refusal names the offense', /shards/.test(badRun.stderr))
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\ncheck-distillation: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-distillation: ALL GREEN')
