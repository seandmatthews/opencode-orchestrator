// Round composer (T-030) — the T-012-reserved packet→prompt composer at its
// smallest (the reservation src/context.ts:101-104; T-012:91-94). Pure,
// deterministic, zero model knowledge, zero I/O: a fixed finished round's
// report data maps to the same ArtifactRecords, ContextPlan, ContextPacket,
// and rendered text block byte-for-byte on every invocation (no wall clock,
// stable key order — the packet's own determinism contract, pinned by Gate
// 1.13, plus a fixed-framing renderer). The runner (src/runner.ts) writes the
// rendered block under the run artifacts dir and appends it to the round-2
// planner prompt; this module never touches disk and never decides anything.
//
// What it builds: for each gate survivor of the finished round, ONE
// 'survivor-evidence' ArtifactRecord whose content is a deterministic text
// rendering of the evidence the engine already captured — the candidate id,
// the brief it was given, diffBytes, the per-gate results including the
// recorded GateResult.command (evidence only, never a verdict,
// src/types.ts), the advisory review observations (findings, never verdicts),
// and the probe summaries (pointers at validated bundles). The records feed
// through the existing `buildContextPacket` under a ContextPlan that carries
// a `distillation` block opting into the T-014 declared-input contract: the
// block's `expectedArtifactIds` declares EVERY evidence record the builder
// sees, so the strict-mode machinery is armed — any Layer-3-class record
// that arrived undeclared would refuse the build. The composer's records
// deliberately carry NO `sourceRefs`: they are primary evidence, not
// distilled claims — the composer produces NO DistillationReport (there is
// no distiller role; `parseDistillationReport` stays the reserved
// enforcement point for that successor, T-013:44-46), so there is nothing
// for the lineage checks to walk and nothing to declare beyond the ids
// themselves. Records ride Layer 1 (a mandatory type query): survivor
// evidence is never budget-trimmed out of the packet.
//
// FINGERPRINT RECONCILIATION — the src/context.ts:101-104 duty, discharged
// here. The packet fingerprint (§7.7 narrowed: sha256 over the canonical
// JSON of `{ model, planHash, selected }`) and T-007's `input_context_hash`
// (src/runner.ts: sha256 over brief + model + the composed builder prompt
// with the workspace-path line excluded) are two DISJOINT provenance hashes
// that answer different questions and never derive from each other:
//
// - the packet fingerprint hashes the CONTEXT a planner sees — which
//   artifacts were selected, under which plan, for which model — and is
//   workspace-free by construction;
// - `input_context_hash` hashes one worker attempt's composed INPUT modulo
//   its lease path — packet-free (worker attempts never see a packet, and
//   the n=1 planner sees none either).
//
// Neither subsumes the other; one hash could not serve both without losing
// the property each pins (cross-attempt input comparability vs packet-content
// identity). On a rounds-carrying run both are recorded side by side: the
// composed round's report entry carries `packetFingerprint` (this module's
// output), while every candidate attempt — round 1 and round 2 alike — keeps
// its T-007 `inputContextHash` computed exactly as before (the runner is
// untouched on that path). Neither hash ever touches a verdict (decisions.md
// 2026-10-10: machine gates decide survival; hashes are provenance). Pinned
// by Gate 1.22(a): the recorded fingerprint must equal the packet's
// recomputed fingerprint, and the attempt hashes must ride unchanged beside
// it.
import { createHash } from 'node:crypto'
import { buildContextPacket, estimateTokens } from './context.js'
import type { ArtifactRecord, ContextPacket, ContextPlan } from './context.js'
import type { CandidateReport } from './types.js'

/** Fixed framing header/footer of the rendered block — the only prose the
 *  composer adds around packet content. Deterministic; carries the packet
 *  fingerprint for provenance so the planner-facing text names the exact
 *  context it was built from. */
const BLOCK_HEADER = '=== ROUND %ROUND% SURVIVOR EVIDENCE (composed context; fingerprint %FP%) ==='
const BLOCK_FOOTER = '=== END SURVIVOR EVIDENCE ==='

/** Fixed token-budget margin over the evidence content itself. The mandatory
 *  layer must fit the cap (a plan whose mandatory layer alone exceeds
 *  `maxInputTokens` is refused), so the composer sizes the cap FROM the
 *  records: sum of estimates + this margin. Deterministic: a pure function
 *  of the record contents (the `ceil(chars/4)` estimator, src/context.ts). */
const CAP_MARGIN_TOKENS = 1024

/** The evidence type every composer record carries — the plan's mandatory
 *  query selects exactly this type. */
export const SURVIVOR_EVIDENCE_TYPE = 'survivor-evidence'

export interface RoundComposerInput {
  /** The finished round's candidate reports, in report order. Eliminated
   *  candidates are skipped (only survivors become evidence). */
  candidates: CandidateReport[]
  /** The planner-tier model the next round's planner rides — the packet
   *  fingerprint's model component (CLI configuration, never engine code). */
  model: string
  /** 1-based index of the round that finished (its survivors are the
   *  evidence). Appears in record tags and the rendered framing. */
  finishedRound: number
}

export interface RoundComposition {
  /** One 'survivor-evidence' record per gate survivor, in report order. */
  records: ArtifactRecord[]
  /** The plan fed to buildContextPacket — its `distillation` block declares
   *  every record id (the armed T-014 contract). */
  plan: ContextPlan
  /** The built packet (all records in Layer 1; manifest all-included). */
  packet: ContextPacket
  /** The fixed-framing text block rendered from the packet — what the runner
   *  appends to the round-2 planner prompt and writes under the run
   *  artifacts dir. */
  renderedBlock: string
}

/** The deterministic per-survivor evidence text. Field order and line shapes
 *  are fixed; lists iterate in report order; optional sections (review
 *  observations, probe summaries, recorded gate commands) appear only when
 *  the report carries them. Never a verdict input — planning evidence only. */
function survivorEvidenceText(c: CandidateReport, finishedRound: number): string {
  const lines: string[] = [
    `candidate ${c.id} (round ${finishedRound} survivor)`,
    `brief: ${c.brief}`,
    `diffBytes: ${c.diffBytes}`,
    'gates:',
  ]
  for (const g of c.gates) {
    const command = g.command !== undefined ? `, command: ${g.command}` : ''
    lines.push(`- ${g.name}: ${g.passed ? 'PASS' : 'FAIL'} (exit ${g.exitCode}${command})`)
  }
  if (c.review !== undefined) {
    lines.push('review observations (advisory — findings, never verdicts):')
    for (const o of c.review.observations) {
      lines.push(`- [${o.severity}] ${o.finding}${o.evidence !== undefined ? ` (evidence: ${o.evidence})` : ''}`)
    }
  }
  if (c.probes !== undefined && c.probes.length > 0) {
    lines.push('probes (evidence bundles):')
    for (const p of c.probes) {
      lines.push(`- ${p.probeId}/${p.scenarioId}: ${p.success ? 'success' : 'failed'} (bundle: ${p.bundlePath})`)
    }
  }
  return lines.join('\n')
}

/** Builds one survivor's ArtifactRecord. Ids are `ev-<candidateId>` — the
 *  `ev-` prefix keeps the packet's artifact namespace unambiguous (a
 *  candidate id alone could later collide with other artifact classes), and
 *  the round-2 id scheme (`<id>-r2`) keeps records from consecutive
 *  compositions distinct. Charset-safe per SPEC_ID_PATTERN
 *  (src/scheduler.ts) given charset-safe candidate ids. */
function survivorRecord(c: CandidateReport, finishedRound: number): ArtifactRecord {
  const content = survivorEvidenceText(c, finishedRound)
  return {
    id: `ev-${c.id}`,
    type: SURVIVOR_EVIDENCE_TYPE,
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    candidate: c.id,
    producerRole: 'composer',
    tags: [`round-${finishedRound}-survivor`],
    content,
  }
}

/** The round composer (T-030): the finished round's survivors → records →
 *  plan → packet → rendered block. Pure and deterministic — identical inputs
 *  give byte-identical outputs (the packet builder's id-ascending canon
 *  makes the packet independent of the input array order, and the renderer
 *  walks packet order). Throws ContextRefusal from the builder on the
 *  armed-contract refusals; the composer's own inputs cannot trigger them
 *  (its records are declared, carry no sourceRefs, and the cap is sized to
 *  fit them). */
export function composeRoundPacket(input: RoundComposerInput): RoundComposition {
  const survivors = input.candidates.filter((c) => c.passedAllGates)
  const records = survivors.map((c) => survivorRecord(c, input.finishedRound))
  const plan: ContextPlan = {
    maxInputTokens: records.reduce((sum, r) => sum + estimateTokens(r.content), 0) + CAP_MARGIN_TOKENS,
    mandatory: [{ type: SURVIVOR_EVIDENCE_TYPE }],
    selectable: [],
    sourceReferencePolicy: 'artifact-ref',
    // T-014's declared-input contract, armed: every record the builder sees
    // is declared. Records carry no sourceRefs (primary evidence — see the
    // module header), so nothing is Layer-3 class this slice; the
    // declaration is the invariant the packet builder enforces the moment
    // any record class arrives with refs.
    distillation: { expectedArtifactIds: records.map((r) => r.id).sort() },
  }
  const packet = buildContextPacket(plan, records, { model: input.model })
  return { records, plan, packet, renderedBlock: renderRoundBlock(packet, records, input.finishedRound) }
}

/** Renders the packet into the fixed-framing text block: header naming the
 *  finished round and the packet fingerprint, then every included entry's
 *  evidence content in packet order (Layer 1 → 4), then the footer. Pure —
 *  a function of (packet, records, finishedRound) only; the packet carries
 *  ids/hashes, not content, so the composer's own records supply the text. */
export function renderRoundBlock(packet: ContextPacket, records: readonly ArtifactRecord[], finishedRound: number): string {
  const contentById = new Map(records.map((r) => [r.id, r.content]))
  const header = BLOCK_HEADER
    .replace('%ROUND%', String(finishedRound))
    .replace('%FP%', packet.fingerprint.hash)
  const bodies = [...packet.layers.mandatory, ...packet.layers.primary, ...packet.layers.distilled, ...packet.layers.supporting]
    .map((ref) => {
      const content = contentById.get(ref.id)
      if (content === undefined) {
        throw new Error(`renderRoundBlock: packet entry "${ref.id}" has no composer record — the renderer only renders its own builds`)
      }
      return content
    })
  return [header, '', ...bodies.flatMap((b) => [b, '']), BLOCK_FOOTER, ''].join('\n')
}
