# T-030 — Bounded R&D loop: survivor-evidence feedback rounds (`--rounds`) + the T-012-reserved packet→prompt composer

**Status:** done 2026-10-20
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 3
**Depends on:** T-007, T-012, T-013, T-014, T-015, T-016, T-017, T-025, T-027 (all done)

## What

The engine is a one-pass refinery: `runSkeleton` dispatches the job DAG once,
writes one report.json, and returns (`src/runner.ts:188-226`), and `ingest` runs
once after it (`src/cli.ts:451-455`). Nothing feeds survivors' evidence back into
planning: `plannerPrompt` is exactly goal + count (`src/runner.ts:228-240`), and
the reviewer's observations are written to review.json/report only, with no
consumer (`src/runner.ts:342-404`). This change-set adds the bounded loop and
its composer, and nothing else:

1. **`--rounds <n>` CLI flag (`src/cli.ts`), default 1 = today byte-for-byte.**
   Integer 1..2 (capped at 2 this slice). A value outside 1..2, a non-integer,
   or `--rounds 2` combined with `--jobs` (no planner exists in DAG mode,
   `src/runner.ts:153`) or `--no-planner` refuses at parse time — before the
   checkout lock, repo validation, or any artifacts dir exists (the
   T-007 zero-side-effects refusal pattern, `src/cli.ts:352-355`).

2. **The round-composer — new engine module (e.g. `src/rounds.ts`)**, the
   T-012-reserved packet→prompt composer at its smallest
   (`src/context.ts:101-104`; T-012:91-94). Pure, deterministic, zero model
   knowledge. Input: the finished round's report data. For each survivor it
   builds ArtifactRecords — candidate id, brief, diffBytes, per-gate results
   including the recorded `GateResult.command` (evidence only, never a verdict:
   `src/types.ts:125-135`), advisory review observations
   (`src/types.ts:312-313`), probe summaries (`src/types.ts:311`) — feeds them
   through the existing `buildContextPacket` under a ContextPlan that carries a
   distillation block (opting into the T-014 lineage enforcement,
   `src/context.ts:74-82`; `expectedArtifactIds` declares every evidence record
   the builder sees). The composer produces **no** DistillationReport — there is
   no distiller role; `parseDistillationReport` stays the reserved enforcement
   point for that successor (T-013:44-46). It renders the packet into a
   fixed-framing text block; `plannerPrompt` (`src/runner.ts:228-240`) gains an
   optional section carrying it.

3. **Round loop in `runSkeleton` (`src/runner.ts:131-226`).** Round 1 is today's
   mechanics verbatim (planner → candidates → gates → review of passers). When
   n=2 and round 1 produced ≥ 1 survivor: composer runs, round 2 re-enters
   `runPlannerPhase` unchanged — same artifact-only scratch-dir posture
   (`src/runner.ts:290-299`); the composer adds prompt text, never capability —
   `parseBriefs` parses round-2 briefs exactly as round-1's, and the candidate
   wave repeats. Round-2 candidates lease fresh worktrees pinned to the **same
   baseSha** (survivor diffs are planning evidence, never stacked patches —
   candidate lineage is M8, spec §34:2137) and get deterministic distinct ids,
   charset-safe per `SPEC_ID_PATTERN` (`src/scheduler.ts:33`), scheme `<id>-r2`,
   so branches, store rows, and report entries never collide across rounds. One
   runId, one checkout lock held across both rounds (acquired once, as today);
   dispatch.jsonl keeps its current line shapes — round 2 is just more dispatch
   lines, and the run header recovery reads is written once
   (`src/runner.ts:134-145`).

4. **Report shape — additive `rounds` block, probes precedent.** Present only
   when `--rounds 2`; absent otherwise, so default-mode report.json is
   unchanged (the `CandidateReport.probes` pattern, `src/types.ts:304-311`).
   The block records per round: executed flag, survivor ids, the packet
   fingerprint, and the rendered block's location under the run artifacts dir
   (round evidence lives under `C:\swarm\<runId>\` per decisions.md 2026-10-10
   run-root).

5. **Fingerprint reconciliation — the `src/context.ts:101-104` duty, owed
   here.** The composer documents and implements the relationship between the
   packet fingerprint (§7.7 narrowed, `src/context.ts:93-99`) and T-007's
   `input_context_hash` (`src/runner.ts:406-414`): the round-2 planner dispatch
   records the packet fingerprint alongside the existing hash; one documented
   relationship, pinned by Gate 1.22(a).

**Does NOT claim (carved for successors):**

- **No Sol verifier per surviving candidate** (spec §34:2111) — needs the Codex
  adapter, stage 5 (ROADMAP.md:17; T-017's Does-NOT carves CodexWorker).
- **No researcher/distiller/synthesizer roles** (spec §34:2105-2107) — the job
  model has builder jobs only (`src/scheduler.ts:52-76`), and read-only
  researchers are decisions.md:36-43 clone re-entry condition (a). This slice
  avoids the clone question entirely: the only model round added is the
  planner's, riding the existing `artifact-only` posture — no new
  WorkspaceProvider, no new dated decisions entry needed.
- **No early stop, no in-run approval pause** — M8 vocabulary (spec
  §20:1265-1281) with no producer; the scheduler refuses `earlyStop`/
  `approvalGate` as unknown fields (`src/scheduler.ts:37-44`, `152-158`);
  `AttemptState` has no waiting state (`src/types.ts:165`); approvals stay
  operator-driven post-hoc (T-008:47-48).
- **No candidate lineage/generation records, no `context_plans`/
  `context_packets`/`artifact_lineage` store tables** (T-016:78-80 stay
  reserved) — the store keeps persisting verdicts only; Gate 1.6 extends solely
  to tolerate the additive rounds block.
- **No new WorkerAdapter or harness code** (decisions.md 2026-10-10
  harness-agnostic); **no execution-policy change** (mechanism over prompts,
  decisions.md 2026-10-10 — and this slice changes neither).
- n ≤ 2; no adversarial probes; no memoization.

**M6-vs-M8 labeling, stated honestly:** spec Milestone 6 (§34:2100-2114) is a
single-pass RUN composition — 5 researchers / 2 distillers / 2 synthesizers /
3 candidate builders / machine probes / 3 GLM reviewers / 1 Sol verifier per
survivor / 1 final synthesis / human approval — naming **no** feedback rounds.
The owner's "survivors' evidence feeds the next planning round … bounded rounds"
is Milestone 8 vocabulary (§34:2133-2141: second-generation briefs, bounded
generation loops; §1:27-29 run steps 7-9). This ticket is therefore "M6-shaped
composition of parts that all exist + the M8 feedback edge worn early, bounded
to n=2": it fills ROADMAP.md:18's empty stage-6 slot with the loop demonstrably
running end to end, and carves the rest of literal M6/M8 to the successors
above. Whether a feedback round improves outcomes is the empirical question the
first real run exists to answer — no reading establishes it; the Gate 2 round-2
comparison is recorded in Landed when this lands.

## Why

The spec is about an R&D loop; the engine stops after one pass and throws the
ore away. Every producer the loop needs is landed and dormant, verified by
reading this session: the deterministic scheduler and `--jobs` DAG
(`src/scheduler.ts:139-340`, `readyJobs` `:377-392`); the pinned, re-derivable
packet contract including distillation parsing and lineage (`src/context.ts:157-172`,
`:560-623`, `:706-717`) whose own header says "Nothing in the pipeline produces
or consumes a packet after this slice" (`src/context.ts:12-14`); probes →
validated EvidenceBundles under `<artifactsDir>/probes/` (`src/runner.ts:698-727`);
the artifact store (`src/store/index.ts:76-95`); recorded gate commands
(`src/types.ts:125-135`); per-role harness selection (`src/runner.ts:98-99`,
`src/cli.ts:344-345`). T-012, T-013, T-014 and T-016 each explicitly reserved
this slice's duties on record (`src/context.ts:101-104`; T-013:44-46;
T-016:78-80). Landing it turns the one-pass skeleton into the thing the
architecture is actually about, and activates the dormant contract instead of
letting it rot unpinned to reality. Risk is bounded by design: `--rounds 1`
(absent flag) is today byte-for-byte, and the token-free loop gate catches
regressions before Gate 2 spends tokens.

## Acceptance criteria

- [ ] `--rounds` parsing: default 1; values `< 1`, non-integers, `> 2`, and
      `--rounds 2` combined with `--jobs` or `--no-planner` refuse with a clear
      message BEFORE the checkout lock or any artifacts dir exists (zero side
      effects, no `locks/` left behind) — pinned by refusal faces in the new
      **Gate 1.22** (next free fast-tier integer; last is 1.21,
      VERIFICATION.md:2084; the T-013:113-120 slice-owns-its-gate precedent).
- [ ] Default unchanged: flag-absent and `--rounds 1` runs execute today's
      single-pass path exactly and report.json carries NO rounds block — pinned
      by **Gate 1.10** (VERIFICATION.md:644) and **Gate 1.21** (VERIFICATION.md:2084)
      riding green unchanged, plus a Gate 1.22 report-shape face asserting the
      absent block at n=1.
- [ ] Deterministic composition: for a fixed round-1 report fixture, the
      composer's ArtifactRecords → plan → packet → rendered planner-input block
      is byte-stable across invocations (stable key order, no wall clock) —
      pinned by **Gate 1.22(a)** fixtures, hand-built inputs, zero model tokens.
- [ ] Round-2 planner input demonstrably contains round-1 survivor evidence —
      pinned by **Gate 1.22(b)**, a token-free REAL-CLI 2-round loop (the
      Gate 1.17 S5 / Gate 1.21 S3 machine-worker pattern,
      `scripts/check-machine-worker.mjs`): planner on
      `--planner-worker machine --planner-command <json>`, whose adapter logs
      `req.prompt` verbatim as a provenance header (`src/worker/machine.ts:34-39`),
      so the captured round-2 planner.log is asserted to carry round-1 survivor
      ids, gate results, and review observations; backed by a fake-adapter
      capture face (the Gate 1.21 S1 pattern) asserting the composed prompt
      directly.
- [ ] Gates decide every round (decisions.md 2026-10-10: distilled evidence is
      planning INPUT only): in the Gate 1.22(b) loop, each round's candidate
      verdicts derive only from gate results and diffBytes; no review
      observation or probe value participates in any verdict; a round-2
      zero-byte diff is a NO-OP elimination regardless of what the planner saw
      (AGENTS.md #7).
- [ ] Fingerprint relationship implemented and documented (the
      `src/context.ts:101-104` duty) — pinned by a **Gate 1.22(a)** assertion.
- [ ] n=2 disposal: after a 2-round loop, `npm run clean -- --run <runId>`
      disposes every round's worktrees and `swarm/*` branches, exits 0, evidence
      kept (Gate 1.5 semantics hold per round, VERIFICATION.md:49) — pinned by a
      clean face appended to Gate 1.22(b) and by Gate 2's existing disposal
      assertions.
- [ ] Store: `ingest` accepts the additive rounds block and keeps persisting
      verdicts only — pinned by a **Gate 1.6** (VERIFICATION.md:279) extension
      fixture; no new tables.
- [ ] **Gate 2** real run (VERIFICATION.md:2223; mandated at VERIFICATION.md:2260-2261
      — this change-set touches `src/runner.ts` and report shape):
      `npm run verify:full` ALL GREEN on a real 2-round run where round-2's
      planner input demonstrably contains round-1 survivor evidence and gates
      decided both rounds.
- [ ] VERIFICATION.md extended in the same change-set (the Gate 1.22 section,
      Gate 2's loop assertions, the rounds-block report-shape note) and
      ROADMAP.md:18's stage-6 row updated in the same change. No existing gate
      fixture flips; if implementation discovers one must, red-before/
      green-after per AGENTS.md #8.

## Verification

Gate 0, Gate 0.5, Gate 1, Gate 1.5, Gate 1.6 (extended), Gate 1.10, Gate 1.13 /
Gate 1.14 (packet contract riding green untouched — VERIFICATION.md:925, :1045),
Gate 1.17, Gate 1.21 — all via `npm run verify`; **new Gate 1.22** (this
change-set's load-bearing pin: no existing gate exercises two rounds, so the
fast-tier loop check is not optional); **Gate 2** (`npm run verify:full`,
required per VERIFICATION.md:2260-2261). Gate 3 not triggered — no adapter
change, no new harness to probe.

## References

docs/spec/inference-refinery-v2.md §34:2100-2114 (M6), §34:2133-2141 (M8),
§1:27-29 (run steps 7-9), §14.2 (artifact-only posture) · docs/decisions.md
2026-10-10 entries (gates decide survival; harness-agnostic; mechanism over
prompts; run root) and 2026-10-18 (WorktreeProvider-only — avoided, not
re-entered) · docs/ROADMAP.md:18 (the stage-6 slot this fills) ·
T-012:91-94 / src/context.ts:101-104 (the reserved composer),
T-013:44-46 (reserved distiller enforcement point), T-016:78-80 (reserved
tables) · VERIFICATION.md Gates 1.5, 1.6, 1.10, 1.13, 1.14, 1.17 S5, 1.21, 2.

## Landed

2026-10-20, one change-set on `ticket/T-030-bounded-rd-loop` (lane worktree,
base 8da8e95). Files: `src/rounds.ts` (new), `src/runner.ts`, `src/cli.ts`,
`src/types.ts`, `src/context.ts` (module-header comments only — the
:101-104 composer reservation and the "nothing produces or consumes a
packet" sentence updated; no behavior change, Gates 1.13/1.14 ride green
untouched), `scripts/check-rounds.mjs` (new, Gate 1.22),
`scripts/check-store.mjs` (Gate 1.6 extension),
`scripts/verify.mjs` (Gate 1.22 wired into the fast tier; Gate 2 made the
mandated real 2-round run), VERIFICATION.md, ROADMAP.md (stage-6 row), this
ticket, and the index row. No adapter file touched (Gate 3 n/a); no
store-module change (the rounds block is verdict-neutral by construction —
ingest never reads it; pinned by the extended Gate 1.6).

- `src/cli.ts` — the `--rounds <n>` flag: default 1; integer 1..2 enforced
  at parse time (values outside the bound, non-integers, and junk refuse
  naming the flag); `--rounds 2` + `--jobs` and `--rounds 2` +
  `--no-planner` refuse after the whole argv is read (flag-order
  independent) — all before repo validation, the checkout lock, or any
  artifacts dir (zero side effects, no `locks/`); `--help` documents the
  flag; `rounds` passes through to `runSkeleton`.
- `src/rounds.ts` — the composer: per gate survivor one
  `'survivor-evidence'` ArtifactRecord (deterministic text rendering of
  brief/diffBytes/gates with recorded commands/review observations/probe
  summaries; no `sourceRefs` — primary evidence, no DistillationReport,
  `parseDistillationReport` stays the reserved enforcement point) through
  `buildContextPacket` under a plan whose `distillation.expectedArtifactIds`
  declares every record (the T-014 contract armed; mandatory type query —
  records never budget-trimmed) and `renderRoundBlock`'s fixed framing.
  The header documents the fingerprint reconciliation: the packet
  fingerprint (§7.7 narrowed) and T-007's `input_context_hash` are disjoint
  provenance hashes, recorded side by side on a rounds-carrying report,
  neither deriving from the other, neither ever a verdict input — the
  `src/context.ts:101-104` duty, discharged (AC#6).
- `src/runner.ts` — round loop in `runSkeleton`: the scheduler loop
  extracted verbatim into `driveJobs` (pure code motion; each round drives
  its own wave on fresh state); round 2 runs only when n≥2, planner mode,
  and ≥1 round-1 survivor — otherwise recorded `executed: false`, never
  fabricated; `plannerPrompt` gained the optional block section (absent ⇒
  byte-identical to the pre-T-030 text); `runPlannerPhase` gained the
  round parameter (count/contextBlock/evidenceTag — round 2 writes
  `planner-r2.log`/`planner-r2-raw.txt`, round 1 keeps today's paths);
  round-2 ids `<survivorId>-r2` at the same baseSha; the run header stays
  the single first dispatch.jsonl line; the report's `planner` block is
  the last executed planner phase's (round 2's when the loop ran);
  `finishedAt` stamped after all rounds.
- `src/types.ts` — `RoundRecord` + `RunReport.rounds` (additive, present
  only when `--rounds 2`; per round `round`/`executed`/`survivorIds`,
  plus `packetFingerprint`/`renderedBlockPath` on a composed round — the
  probes optional-field precedent).
- Design choices the ticket left open, recorded here: round 2 dispatches
  one candidate per round-1 survivor (the survivors are the evidence; a
  refined candidate each); the ticketed rounds fields are the required
  minimum and the entries carry exactly those; the composer record id is
  `ev-<candidateId>` (namespace-unambiguous, SPEC_ID_PATTERN-safe).

Gates measured in the lane (this session, this change-set):

- Gate 0 (`npm run typecheck`): exit 0 (run during iteration and inside
  the fast tier).
- Full fast tier (`node scripts/verify.mjs fast`): **ALL GREEN**, measured
  **1m43.8s** wall — Gates 0, 0.5, 1, 1.5, 1.6 (extended), 1.7–1.21 riding
  green unchanged, and the new Gate 1.22.
- Gate 1.22 standalone (`node node_modules/tsx/dist/cli.mjs
  scripts/check-rounds.mjs`): **ALL GREEN**, 58 assertions over legs A
  (composer fixtures: determinism, permutation-invariance, survivor-only
  records, the armed declaration contract, the §7.7-narrowed fingerprint,
  the reconciliation source pins), B (fake-adapter capture: the exact
  recomputed block verbatim in the round-2 planner request, the ticketed
  rounds fields, the recorded fingerprint = the recomputation, same-baseSha
  `-r2` worktrees, one run header, the round-2 NO-OP elimination despite a
  PASSing gate, n=1 flag-absent with no rounds block), C (token-free
  REAL-CLI 2-round loop via `--planner-worker machine` + `--opencode-bin`
  pointed at node with the stub committed AS the repo-root `run` file: the
  captured `planner-r2.log` carries round-1 survivor ids, gate results with
  commands, review observations, and the fingerprint; the store accepted
  the rounds report; the `--rounds 1` real-CLI n=1 face; the n=2 disposal
  face — clean exits 0, both rounds' worktrees and `swarm/wt-*-r2` branches
  disposed, evidence kept), and D (the six refusal faces + `--help`).
- Gate 1.6 standalone (`node node_modules/tsx/dist/cli.mjs
  scripts/check-store.mjs`): **ALL GREEN** — the new rounds-variant
  fixture: ingest accepts the block and persists verdicts only (rows
  identical to the same report without the block; census stays 11 tables;
  re-ingest idempotent).
- **Gate 2: NOT run by this lane** (real model tokens — the driving
  pipeline re-runs it). It is wired as the ticket mandates:
  `scripts/verify.mjs` Gate 2 now runs `--rounds 2` and asserts the loop
  (two executed rounds, round-1 survivors present, the 64-hex packet
  fingerprint, the on-disk block carrying every survivor id, one
  `<survivorId>-r2` candidate per survivor, one round-2 brief per
  round-2 candidate, and the round-2 planner input grown by the block —
  the adapter's `<prompt: N chars>` lines), with the per-candidate
  gate/ladder/review assertions covering both rounds' waves unchanged. The
  outer ceiling moved 20 → 35 min (the runner's worst legitimate path is
  now TWO planner+15-min-worker+review legs — a stall in each round ≈
  34 min; the same never-preempt-the-runner discipline as the T-023/T-027
  raises, with the wrapper-budget note recorded in Gate 2's section).
  Consequently the ticket's empirical question — whether the feedback
  round improves outcomes (the M6-vs-M8 note) — is NOT answered here; it
  lands with the driving Gate 2 run's recorded comparison.
