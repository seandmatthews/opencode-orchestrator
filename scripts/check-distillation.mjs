// Shard-distillation-core self-check (Gate 1.14, fast tier, T-013) — run
// under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-distillation.mjs
// Pins the §7.3-7.5 record/contract level that T-012 reserved and this slice
// chose: the `DistillationPlan` block (§7.1:507 — the type the spec uses but
// never defines), `parseDistillationReport` (§23.2:1358-1381 — the §7.5
// rule-1 enforcement point at the record level), the builder's plan-level
// untraceable-chain refusal, planHash sensitivity to the block, and the CLI
// round-trip. Extended by T-014 (same gate number — the ticket's "extension
// of T-013's landed gate" move) with the packet-level source lineage:
// builder-input ref enforcement, per-ref resolution recording, and
// claim-chain inspection (§7.4:565-578, §7.5:580-587 rules 2-3). Drives the
// pure functions (src/context.ts) directly over hand-built fixtures — the
// Gate 1.13 pattern, since no artifact store exists to produce inputs
// (§34:2028) — plus the inspector CLI as a list-form subprocess (AGENTS.md
// #4). Zero model tokens, zero npm deps.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ContextRefusal,
  buildContextPacket,
  fingerprintHashOf,
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
  // T-014 corrected this fixture's ref at preserved assertion strength (the
  // ticket's provision for T-013 landed fixtures whose refs do not resolve
  // into their input sets): `dist-a` cited `artifact:research-001#obs-1`,
  // and the strict builder now refuses refs dead against the build's input
  // set ({dist-a, note-b}), so the declared-entry-admitted assertions below
  // ride `artifact:note-b#obs-1` instead — ref value only; ids, hashes,
  // sizes, and contents are untouched.
  { id: 'dist-a', type: 'distillation-report', contentHash: 'sha-da', sizeBytes: 40, sourceRefs: ['artifact:note-b#obs-1'], content: 'A'.repeat(40) }, // 10 tokens
  { id: 'note-b', type: 'note', contentHash: 'sha-nb', sizeBytes: 40, content: 'B'.repeat(40) }, // 10 tokens
]
const BLOCKLESS_PLAN_RAW = {
  maxInputTokens: 100,
  mandatory: [],
  selectable: [{ layer: 'supporting', query: { type: 'note' } }],
  sourceReferencePolicy: 'artifact-ref',
}

// Pinned byte-for-byte: the blockless build's output is unchanged by the
// strict slices by construction (plans carrying `distillation` were refused
// outright before T-013 — src/context.ts's parse refusal — so blockless
// parsing and building are untouched; the T-012:94-100 narrowed-hash
// stability argument, verbatim). This snapshot is that pre-change output, so
// any future change to blockless behavior fails here loudly. T-014 re-pinned
// exactly one line — the `sourceRefs` value — when the fixture's dead ref was
// corrected above; planHash and fingerprint are ref-blind (selected carries
// {id, contentHash}), so their lines are byte-identical to the T-013 pin.
// A blockless build still carries no per-ref resolution field — the field is
// block-keyed (T-014's locked decision), asserted in section 6 below.
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
          "artifact:note-b#obs-1"
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

  // =========================================================================
  // 6. Builder-input lineage (T-014) — strict-only enforcement before the
  //    budget test, per-ref resolution recorded on the packet entry
  // =========================================================================
  console.log('\n--- packet-level source lineage (T-014: §7.4 refs resolve into the input set) ---')
  // Mutual + self citation are legal at build (§7.3's cross-shard tier):
  // claim-a ⇄ claim-b cite each other; self-cite cites itself. All inputs
  // 10 tokens each.
  const LINEAGE_ARTIFACTS = [
    { id: 'claim-a', type: 'distillation-report', contentHash: 'sha-ca', sizeBytes: 40, sourceRefs: ['artifact:src-1#obs-1', 'artifact:claim-b#sum'], content: 'a'.repeat(40) }, // 10 tokens
    { id: 'claim-b', type: 'distillation-report', contentHash: 'sha-cb', sizeBytes: 40, sourceRefs: ['artifact:claim-a#sum', 'artifact:src-2#obs-2', 'artifact:src-3#obs-3'], content: 'b'.repeat(40) }, // 10 tokens
    { id: 'self-cite', type: 'distillation-report', contentHash: 'sha-sc', sizeBytes: 40, sourceRefs: ['artifact:self-cite#obs-0'], content: 'c'.repeat(40) }, // 10 tokens
    { id: 'src-1', type: 'note', contentHash: 'sha-s1', sizeBytes: 40, content: '1'.repeat(40) }, // 10 tokens
    { id: 'src-2', type: 'note', contentHash: 'sha-s2', sizeBytes: 40, content: '2'.repeat(40) }, // 10 tokens
    { id: 'src-3', type: 'note', contentHash: 'sha-s3', sizeBytes: 40, content: '3'.repeat(40) }, // 10 tokens
  ]
  const LINEAGE_PLAN_RAW = {
    maxInputTokens: 100000,
    mandatory: [],
    selectable: [{ layer: 'supporting', query: { type: 'note' } }],
    sourceReferencePolicy: 'artifact-ref',
    distillation: { expectedArtifactIds: ['claim-a', 'claim-b', 'self-cite'] },
  }
  const lineagePlan = parseContextPlan(LINEAGE_PLAN_RAW)
  const lineage = buildContextPacket(lineagePlan, LINEAGE_ARTIFACTS, { model: MODEL })
  t('a strict build whose refs resolve is admitted', eq(ids(lineage.layers.distilled), ['claim-a', 'claim-b', 'self-cite']) && lineage.ledger.totalTokens === 60)
  t('per-ref resolutions are recorded on the included Layer-3 entry, agreeing with the manifest', eq(lineage.layers.distilled[0].sourceRefResolutions, [
    { ref: 'artifact:src-1#obs-1', disposition: 'included' },
    { ref: 'artifact:claim-b#sum', disposition: 'included' },
  ]))
  t('two Layer-3 records citing each other build fine (mutual citation, §7.3 cross-shard tier)', lineage.layers.distilled[0].sourceRefResolutions.some((x) => x.ref === 'artifact:claim-b#sum' && x.disposition === 'included') && lineage.layers.distilled[1].sourceRefResolutions[0].ref === 'artifact:claim-a#sum')
  t('self-citation builds fine (resolution is against the input id set; cycles are the render\'s duty)', eq(lineage.layers.distilled.find((r) => r.id === 'self-cite').sourceRefResolutions, [{ ref: 'artifact:self-cite#obs-0', disposition: 'included' }]))
  t('the resolution field rides the entry, never the fingerprint (selected stays {id, contentHash} in packet order)', eq(lineage.fingerprint.components.selected, [
    { id: 'claim-a', contentHash: 'sha-ca' },
    { id: 'claim-b', contentHash: 'sha-cb' },
    { id: 'self-cite', contentHash: 'sha-sc' },
    { id: 'src-1', contentHash: 'sha-s1' },
    { id: 'src-2', contentHash: 'sha-s2' },
    { id: 'src-3', contentHash: 'sha-s3' },
  ]) && lineage.fingerprint.hash === fingerprintHashOf(MODEL, planHashOf(lineagePlan), lineage.fingerprint.components.selected))
  t('two strict builds from identical inputs stay byte-identical (the recorded field is deterministic)', JSON.stringify(buildContextPacket(parseContextPlan(LINEAGE_PLAN_RAW), LINEAGE_ARTIFACTS, { model: MODEL }), null, 2) === JSON.stringify(lineage, null, 2))
  const planExcluded = buildContextPacket(parseContextPlan({ ...LINEAGE_PLAN_RAW, exclusions: [{ ids: ['src-2'] }] }), LINEAGE_ARTIFACTS, { model: MODEL })
  t('a ref naming an excluded-by-plan input records exactly that (the §7.5 chain stays walkable through exclusions)', eq(planExcluded.layers.distilled.find((r) => r.id === 'claim-b').sourceRefResolutions, [
    { ref: 'artifact:claim-a#sum', disposition: 'included' },
    { ref: 'artifact:src-2#obs-2', disposition: 'excluded-by-plan' },
    { ref: 'artifact:src-3#obs-3', disposition: 'included' },
  ]))
  const cap55 = buildContextPacket(parseContextPlan({ ...LINEAGE_PLAN_RAW, maxInputTokens: 55 }), LINEAGE_ARTIFACTS, { model: MODEL })
  t('a ref naming an excluded-by-budget input records exactly that (nothing hidden)', eq(cap55.layers.distilled.find((r) => r.id === 'claim-b').sourceRefResolutions[2], { ref: 'artifact:src-3#obs-3', disposition: 'excluded-by-budget' }) && cap55.manifest.find((m) => m.id === 'src-3').disposition === 'excluded-by-budget' && cap55.ledger.totalTokens === 50)
  t('a blockless build carries no resolution field — the field exists only under the block (the locked decision)', blockless.layers.distilled[0].sourceRefResolutions === undefined)
  // Refusals — malformed and dead refs, each naming the claim id and the
  // ref, each exercised would-fit AND would-be-excluded-by-budget (the
  // check precedes the budget test inside include, so budget-luck can
  // never hide an untraceable claim).
  const claimWith = (refs) => [
    { id: 'src-1', type: 'note', contentHash: 'sha-s1', sizeBytes: 40, content: '1'.repeat(40) }, // 10 tokens
    { id: 'claim-x', type: 'distillation-report', contentHash: 'sha-cx', sizeBytes: 40, sourceRefs: refs, content: 'x'.repeat(40) }, // 10 tokens
  ]
  const strictPlanFor = (cap) => parseContextPlan({ ...LINEAGE_PLAN_RAW, maxInputTokens: cap, distillation: { expectedArtifactIds: ['claim-x'] } })
  for (const [label, refs, re] of [
    ['bare "id#anchor" spelling (§23.2:1371-1377)', ['src-1#obs-1'], /distilled record "claim-x" sourceRefs\[0\].*bare "id#anchor" spelling is refused/s],
    ['missing anchor', ['artifact:src-1#'], /claim-x.*non-empty artifact id and a non-empty anchor/s],
    ['doubled "#"', ['artifact:src-1#obs-1#x'], /claim-x.*exactly one "#"/s],
    ['dead id', ['artifact:missing-input#obs-1'], /claim-x.*cites artifact id "missing-input" which is not in the build's input set/s],
  ]) {
    t(`a ${label} ref is refused naming the claim and the ref (would fit)`, throwsRefusal(() => buildContextPacket(strictPlanFor(100000), claimWith(refs), { model: MODEL }), re))
    t(`a ${label} ref is refused even when the record would be excluded-by-budget (the check precedes the budget test)`, throwsRefusal(() => buildContextPacket(strictPlanFor(5), claimWith(refs), { model: MODEL }), re))
  }
  const cap5Blockless = buildContextPacket(parseContextPlan({ ...LINEAGE_PLAN_RAW, maxInputTokens: 5, distillation: undefined }), claimWith(['artifact:missing-input#obs-1']), { model: MODEL })
  t('counterfactual: at cap 5 without the block the same dead-ref record rides excluded-by-budget unchecked (blockless pass-through, byte-stable)', cap5Blockless.manifest.find((m) => m.id === 'claim-x').disposition === 'excluded-by-budget' && cap5Blockless.layers.distilled.length === 0)
  const l1Lineage = parseContextPlan({ maxInputTokens: 100, mandatory: [{ ids: ['claim-x'] }], selectable: [], sourceReferencePolicy: 'artifact-ref', distillation: { expectedArtifactIds: ['claim-x'] } })
  t('a declared Layer-3-class record captured by Layer 1 is still a lineage-check target (every Layer-3-class record the builder sees)', throwsRefusal(() => buildContextPacket(l1Lineage, claimWith(['artifact:ghost#x']), { model: MODEL }), /distilled record "claim-x".*ghost/s))

  // =========================================================================
  // 7. Lineage CLI (T-014) — chain render (text + --json), strict-keyed
  //    tamper refusals, blockless unresolved, read-only proof
  // =========================================================================
  console.log('\n--- lineage CLI (T-014: claim-chain rendering, strict-keyed refusals) ---')
  const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
  const refusal = (label, args, re) => {
    const r = runCli(args)
    t(`${label} exits non-zero`, r.code !== 0)
    t(`${label}: no body printed`, r.stdout.trim() === '')
    if (re !== undefined) t(`${label}: refusal names the offense`, re.test(r.stderr))
    return r
  }
  const linPlanPath = join(sandbox, 'plan-lineage.json')
  const linPacketPath = join(sandbox, 'packet-lineage.json')
  writeFileSync(linPlanPath, JSON.stringify(LINEAGE_PLAN_RAW))
  writeFileSync(linPacketPath, JSON.stringify(lineage, null, 2))
  const linBefore = { plan: sha256File(linPlanPath), packet: sha256File(linPacketPath) }

  const linOk = runCli(['--plan', linPlanPath, '--packet', linPacketPath])
  t('strict happy path exits 0 rendering the transitive chain (text)', linOk.code === 0
    && /source chains \(lineage\):/.test(linOk.stdout)
    && /artifact:src-1#obs-1 → included \(layer 4\)/.test(linOk.stdout)
    && /artifact:claim-b#sum → included \(layer 3\)/.test(linOk.stdout)
    && /artifact:claim-a#sum → ↺ claim-a/.test(linOk.stdout)
    && /artifact:self-cite#obs-0 → ↺ self-cite/.test(linOk.stdout))
  const linJson = runCli(['--plan', linPlanPath, '--packet', linPacketPath, '--json'])
  let linView = null
  try {
    linView = JSON.parse(linJson.stdout)
  } catch { linView = null }
  t('--json exits 0 and carries the lineage chains', linJson.code === 0 && linView !== null)
  t('--json: the transitive walk with statuses — cycle and self-reference render terminated', eq(linView.lineageChains, [
    {
      claimId: 'claim-a',
      lines: [
        { depth: 0, ref: 'artifact:src-1#obs-1', status: 'included (layer 4)' },
        { depth: 0, ref: 'artifact:claim-b#sum', status: 'included (layer 3)' },
        { depth: 1, ref: 'artifact:claim-a#sum', status: '↺ claim-a' },
        { depth: 1, ref: 'artifact:src-2#obs-2', status: 'included (layer 4)' },
        { depth: 1, ref: 'artifact:src-3#obs-3', status: 'included (layer 4)' },
      ],
    },
    {
      claimId: 'claim-b',
      lines: [
        { depth: 0, ref: 'artifact:claim-a#sum', status: 'included (layer 3)' },
        { depth: 1, ref: 'artifact:src-1#obs-1', status: 'included (layer 4)' },
        { depth: 1, ref: 'artifact:claim-b#sum', status: '↺ claim-b' },
        { depth: 0, ref: 'artifact:src-2#obs-2', status: 'included (layer 4)' },
        { depth: 0, ref: 'artifact:src-3#obs-3', status: 'included (layer 4)' },
      ],
    },
    { claimId: 'self-cite', lines: [{ depth: 0, ref: 'artifact:self-cite#obs-0', status: '↺ self-cite' }] },
  ]))

  // Tamper refusals — strict-keyed: the strict builder resolves before
  // recording, so a packet failing these was not produced by this builder.
  const writeTampered = (name, mutate) => {
    const p = JSON.parse(JSON.stringify(lineage))
    mutate(p)
    const path = join(sandbox, name)
    writeFileSync(path, JSON.stringify(p, null, 2))
    return path
  }
  const deadRefPacket = writeTampered('packet-lineage-dead.json', (p) => {
    p.layers.distilled[0].sourceRefs[0] = 'artifact:ghost#x'
    p.layers.distilled[0].sourceRefResolutions[0].ref = 'artifact:ghost#x'
  })
  refusal('a strict packet tampered post-build with a dead ref', ['--plan', linPlanPath, '--packet', deadRefPacket], /cites artifact id "ghost" which is in neither the manifest nor the packet layers/)
  const disagreePacket = writeTampered('packet-lineage-disagree.json', (p) => {
    p.layers.distilled[0].sourceRefResolutions[0].disposition = 'excluded-by-budget'
  })
  refusal('a resolution-record disagreeing with the manifest', ['--plan', linPlanPath, '--packet', disagreePacket], /records "excluded-by-budget" but the manifest records "included"/)
  const malformedRecordedPacket = writeTampered('packet-lineage-malformed.json', (p) => {
    p.layers.distilled[0].sourceRefResolutions[0].ref = 'artifact:src-1'
  })
  refusal('a malformed recorded ref', ['--plan', linPlanPath, '--packet', malformedRecordedPacket], /exactly one "#"/)
  const absentRecordedPacket = writeTampered('packet-lineage-absent.json', (p) => {
    p.layers.distilled[0].sourceRefResolutions[0].ref = 'artifact:src-2#obs-2'
  })
  refusal('a recorded ref absent from the entry\'s sourceRefs', ['--plan', linPlanPath, '--packet', absentRecordedPacket], /absent from the entry's "sourceRefs"/)
  const missingFieldPacket = writeTampered('packet-lineage-nofield.json', (p) => {
    delete p.layers.distilled[0].sourceRefResolutions
  })
  refusal('a Layer-3 entry missing the resolution field (strict mode)', ['--plan', linPlanPath, '--packet', missingFieldPacket], /must carry "sourceRefResolutions"/)

  // Blockless packets never promised resolution: an unresolvable ref
  // inspects exit 0, rendering it `unresolved`.
  const blocklessDeadPlanRaw = { maxInputTokens: 100000, mandatory: [], selectable: [], sourceReferencePolicy: 'artifact-ref' }
  const blocklessDeadPacket = buildContextPacket(parseContextPlan(blocklessDeadPlanRaw), claimWith(['artifact:nowhere-001#obs-1']), { model: MODEL })
  const blPlanPath = join(sandbox, 'plan-blockless-dead.json')
  const blPacketPath = join(sandbox, 'packet-blockless-dead.json')
  writeFileSync(blPlanPath, JSON.stringify(blocklessDeadPlanRaw))
  writeFileSync(blPacketPath, JSON.stringify(blocklessDeadPacket, null, 2))
  const blBefore = { plan: sha256File(blPlanPath), packet: sha256File(blPacketPath) }
  const blRun = runCli(['--plan', blPlanPath, '--packet', blPacketPath])
  t('a blockless packet with an unresolvable ref inspects exit 0 rendering it unresolved', blRun.code === 0 && /artifact:nowhere-001#obs-1 → unresolved/.test(blRun.stdout))
  const blJson = runCli(['--plan', blPlanPath, '--packet', blPacketPath, '--json'])
  let blView = null
  try {
    blView = JSON.parse(blJson.stdout)
  } catch { blView = null }
  t('--json: blockless unresolved status (computed at render time, no refusal)', blView !== null && eq(blView.lineageChains, [
    { claimId: 'claim-x', lines: [{ depth: 0, ref: 'artifact:nowhere-001#obs-1', status: 'unresolved' }] },
  ]))

  // The inspector never writes (sha256 before/after the strict and
  // blockless inspects above — successful and refused alike).
  t('read-only: plan + packet byte-identical after every inspect (sha256)', sha256File(linPlanPath) === linBefore.plan && sha256File(linPacketPath) === linBefore.packet && sha256File(blPlanPath) === blBefore.plan && sha256File(blPacketPath) === blBefore.packet)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\ncheck-distillation: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-distillation: ALL GREEN')
