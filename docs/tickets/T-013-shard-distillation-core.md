# T-013 — Shard distillation core: DistillationPlan semantics, distilled-claim records, §7.5 no-untraceable-chain refusal

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** T-012 — this slice removes the parse refusal T-012 installed (`src/context.ts:367-369`) and defines the semantics T-012's Layer-3 pass-through reserved; Gate 1.13's fixture set is this slice's regression baseline.

## What

Second and final contract-level slice of Milestone 2 (spec §34:2035-2047 — completes the
build list T-012 carved: "shard distillation, source lineage" at the record/contract
level, `docs/ROADMAP.md:14`). Like T-012: a pure-module change plus its own fast-tier
gate, **zero behavior change to the pipeline** — nothing in `src/runner.ts`,
`src/scheduler.ts`, the adapters, the gate code, or the store produces or consumes a
distilled claim after this slice; the value is the pinned, re-derivable contract that
makes §7.5's refusal rule enforceable somewhere, before any producer exists.

- **`src/context.ts` — the pure module extends** (no I/O, no model knowledge, zero new
  npm dependencies — `node:crypto` sha256 only; the `ceil(chars/4)` estimator at
  `src/context.ts:222-224` untouched; decisions.md: TypeScript on Node 22):
  - **`DistillationPlan` — defined here and documented** (the spec puts
    `distillation?: DistillationPlan` on `ContextPlan`, §7.1:507, and never defines the
    type — the same choose-and-document gap `ArtifactQuery`/`SelectionRule`/
    `SourceReferencePolicy` had before T-012 chose them, T-012:21-30):
    ```ts
    /** §7.1:507's `distillation?: DistillationPlan` — the type the spec uses
     * but never defines; chosen here and documented. The block opts a plan
     * into the declared-entries contract: every Layer-3-class record the
     * builder sees must be declared here, or the build is refused — §7.5
     * rule 1 enforced at the plan level. A plan without the block keeps the
     * T-012 pass-through semantics unchanged. */
    export interface DistillationPlan {
      expectedArtifactIds: string[]
    }
    ```
    `expectedArtifactIds` must be a non-empty array of non-empty strings, duplicates
    refused; unknown sub-fields refused (refuse-don't-ignore, the T-009 unknown-field
    posture). **Opt-in strictness, stated:** a plan omitting the block rides today's
    pass-through exactly (pinned by Gate 1.13's untouched Layer-3 fixtures, which ride
    plans without a block); declaring the block is what switches on the declaration
    contract. Default-tightening for blockless plans belongs with the carved
    packet-level lineage successor, not here.
  - **`parseDistillationReport(raw: unknown): DistillationReport` — the §23.2:1358-1381
    distillation-report validator**, the enforcement point a future pipeline distiller
    role's output must pass (§7.5 rule 1 at the record level):
    - Shape: exactly `source_artifacts` (non-empty array of non-empty strings — the
      report's declared input set) and `claims` (array; `claims: []` is valid — a
      distiller that found nothing worth claiming still produces the record; documented
      choice). Each claim: `id` (non-empty string, unique across the report),
      `statement` (non-empty string), `source_refs` (non-empty array), optional
      `disagreement_refs`. Unknown fields at either level refused, naming the offense.
    - **Ref format — §7.5 rule 1's enforcement:** every `source_refs` and
      `disagreement_refs` entry must be `artifact:<id>#<anchor>` — starts `artifact:`,
      exactly one `#`, non-empty id and anchor — the form T-012 pinned
      (`src/context.ts:119-121`; fixtures `scripts/check-context.mjs:70,154,249`).
      **Spec divergence reconciled and documented:** §23.2:1371-1377 writes bare
      `research-001#obs-3` while §7.4:565-578 writes `artifact:research-003#obs-4`;
      this slice standardizes on the prefixed §7.4 form (consistency with every
      T-012-pinned fixture and the `sourceReferencePolicy: 'artifact-ref'` mode) and
      the bare form is refused.
    - **Resolution:** every ref's `<id>` — in `source_refs` and in
      `disagreement_refs` (a recorded disagreement is also a citation into the input
      set) — must appear in the report's declared `source_artifacts`; a violation is
      refused **naming the claim id**. Anchors are opaque: existence is not checked
      (no artifact store to resolve into, §34:2028) — format + declared-input-set
      resolution only; real anchor resolution is carved with the store.
    - Refusals are `ContextRefusal` naming the offense (the module's existing class,
      `src/context.ts:214`).
  - **`parseContextPlan` — the refusal lifts:** `PLAN_FIELDS` (`src/context.ts:256`)
    gains `'distillation'`; the special-case refusal at `src/context.ts:367-369` is
    removed and replaced by a `parseDistillationPlan` sub-parse (a present block is
    parsed, never silently ignored — an invalid one is still refused, now with
    block-level detail). The `ContextPlan` doc comment updates to "§7.1:500-512 in
    full".
  - **`buildContextPacket` — plan-level untraceable-chain refusal:** in the Layer-3
    pass-through scan (`src/context.ts:527-531`), when `plan.distillation` is present,
    every Layer-3-class record the builder sees whose id is not in
    `expectedArtifactIds` is refused naming its id — **including** a record that would
    have been `excluded-by-budget` (the declaration check runs before the budget test,
    so budget-luck never hides a provenance violation; nothing silent, §7.2:544).
    Declared-but-absent ids are **not** a refusal — the builder refuses what arrived
    untraceable, not what didn't arrive; the manifest and ledger record the truth.
    Layer-3 admission/budget semantics otherwise unchanged (a declared entry is
    admitted, and `excluded-by-budget` when it cannot fit, exactly as today).
  - **Fingerprint:** `distillation` rides inside the normalized plan, so `planHashOf`
    (`src/context.ts:242-244`) covers it — a plan carrying the block fingerprints
    differently from the same plan without it. **No previously-valid fingerprint input
    changes:** plans carrying `distillation` were refused outright before this slice
    (`src/context.ts:367-369`), so every plan that parsed before parses to the
    identical normalized form now — the T-007:94-100 narrowed-hash stability argument
    T-012 used, verbatim.
  - **`ArtifactRecord.sourceRefs` stays untouched:** ref-format enforcement lives in
    `parseDistillationReport` (reports are the distiller output contract); the builder
    and the inspector continue to admit/validate `sourceRefs` as non-empty string
    arrays (`src/context-inspect.ts:156-159`). Extending format checks to builder-input
    refs belongs with the carved packet-level lineage successor.
- **`scripts/check-context.mjs` — Gate 1.13's two time-boxed assertions flip, nothing
  weakened (AGENTS.md #8):**
  - `:100` (parser refuses a present `distillation` block) → replaced by positive
    parse tests: `{ ...PLAN_A, distillation: { expectedArtifactIds: ['distilled-research'] } }`
    parses with all fields intact; an unknown sub-field inside the block is still
    refused naming it.
  - `:335-337` (CLI refuses a plan carrying a distillation block) → replaced by: a
    plan carrying a **valid** block, with a packet built from that parsed plan,
    inspects exit 0 (the CLI parses via `parseContextPlan` at
    `src/context-inspect.ts:383` and recomputes `planHashOf` at `:253`, so no CLI
    change is needed), **and** a plan carrying an invalid block still exits non-zero
    with no body. Net strictness increases: one refusal each becomes
    positive-coverage-plus-refusal.
  - All other Gate 1.13 assertions untouched and green — including the Layer-3
    pass-through/budget fixtures, which ride plans without a block (semantics
    unchanged).
- **`scripts/check-distillation.mjs` — new Gate 1.14** ("next free integer at
  landing" — 1.13 is verify.mjs's last gate section, `scripts/verify.mjs:508-516`; the
  T-008:96 move): hooked into `scripts/verify.mjs` after the Gate 1.13 block, before
  the fast-tier finish (`:518`), tsx-loaded like its siblings, list-form spawn
  (AGENTS.md #4). Drives the pure functions directly over hand-built fixtures (the
  Gate 1.13 pattern — no artifact store exists to produce inputs, §34:2028), zero
  model tokens. It asserts: `DistillationPlan` parse (positive + every refusal);
  `parseDistillationReport` (the §23.2 example adapted to the pinned prefixed-ref form
  + every refusal, including the unresolvable-ref refusal naming the claim id and the
  bare-`id#anchor` format refusal pinning the divergence reconciliation); builder
  integration (an undeclared Layer-3-class record refused when it would fit **and**
  when it would be excluded-by-budget; a declared entry admitted with unchanged
  ledger/manifest; a blockless plan building byte-identically to the pre-change
  fixture output; planHash sensitivity to the block); and the CLI round-trip (valid
  block inspects exit 0; invalid block exits non-zero, no body).
- **VERIFICATION.md** gains the Gate 1.14 section, records Gate 1.13's time-box expiry
  (the sentence at `:714-716` — "a present `distillation` block (refused, never
  silently ignored, until the §7.3-7.5 slice defines builder semantics)" — this ticket
  is that slice), and updates the carved-list paragraph (`:775-786`), all in the same
  change-set (AGENTS.md #6). Ticket status + index row move in the same change-set.

**Does NOT claim:**

- **No pipeline distiller stage.** Jobs still cannot receive artifacts:
  `inputArtifacts`/`contextPlan`/`role` remain refused job-spec fields
  (`src/scheduler.ts:153`; T-009:144-145) and dependencies gate dispatch order only
  (`src/runner.ts:173-189`). §7.3:546-563's shard/cross-shard tiering is a pipeline
  structure — this ticket pins the contract the stage will produce and consume; the
  stage itself is carved and owns a Gate 2 run when it lands.
- **No packet-level lineage enforcement.** A Layer-3 entry's refs are not validated
  against the input artifact id set; multi-hop chain resolution (§7.3's cross-shard
  tier; §7.5 rules 2-3) is carved — the pre-authorized follow-up ticket.
- **No store tables.** `artifacts`/`artifact_lineage`/`context_plans`/
  `context_packets` (§27:1825-1827) — blocked on the filesystem artifact store
  (§34:2028, Milestone 1's unclaimed build item) and a pipeline producer.
- **No §7.5 rule 4.** "Show source chain" UI is Milestone 7 (`docs/ROADMAP.md:19`);
  the inspector's existing sourceChains render (`src/context-inspect.ts:321` —
  no file change here) stays the token-free precursor.
- **No advisory-ness change.** Nothing in this slice can influence promotion or
  elimination: no pipeline file consumes any of it (decisions.md: gates decide
  survival, models advise; AGENTS.md #2 — a distiller is advisory compression,
  honored by construction, the T-012 posture).
- **No new npm dependencies, no adapter change, no CLI surface change** — Gate 3 n/a;
  Gate 0.5 n/a (`src/parse.ts` untouched); `package.json` untouched.

## Why

`docs/ROADMAP.md:14` names stage 2's remainder verbatim — "remaining: shard
distillation, source lineage" — and §34:2035-2047's Milestone-2 build list is exactly
T-012's landed slice plus these two items, ":2047 required before large fan-in".
§35:2164-2165's operator questions ("Did large fan-in pass through explicit
distillation? / Can a distilled claim be traced to primary evidence?") become
answerable at the record level once this contract exists and is gated.

The reservation chain is explicit: `src/context.ts:367-369` refuses a present
`distillation` block naming "the §7.3-7.5 slice" as its successor; T-012:142-144
carved §7.3-7.5; VERIFICATION.md:714-716 documents the refusal as time-boxed "until
the §7.3-7.5 slice defines builder semantics". This ticket is that expiry — the
refusal's own message books the successor, and AGENTS.md #8 requires the flip to be
explicit, never silent.

The gap is real, verified this session at HEAD `1898177` (clean tree): a grep over
`src/`, `scripts/*.mjs`, and `package.json` surfaces `distill` only in the refusal,
the Layer-3 pass-through naming, and Gate 1.13's own two time-boxed assertions —
nothing distills, nothing produces or validates a distilled claim, and §7.5's
no-untraceable-summary-chains rule has no enforcement point anywhere. The only
`sourceRefs` validation in the repo is the inspector's non-empty-string-array check
(`src/context-inspect.ts:156-159`) — no ref-format check, no resolution check. Meanwhile
the pipeline-side half of the idea is **not buildable today**: jobs cannot receive
artifacts (the scheduler refuses `inputArtifacts`/`contextPlan`/`role` outright,
`src/scheduler.ts:153`; dependencies gate dispatch order only, `src/runner.ts:173-189`)
and there is no artifact store to read inputs from or write distilled packets into
(§34:2028) — which is why this carve is pure-module and the pipeline stage is carved
off, exactly as the ask pre-authorizes.

**Honest tensions, stated rather than smoothed** (the T-012:179-199 precedent):

1. **Nothing consumes distilled evidence yet.** The pipeline cannot see a packet
   (T-012:135-138); today's only model-facing fan-in is the reviewer's single diff
   truncated at `MAX_DIFF_CHARS = 30_000` (`src/runner.ts:227,245-246`). §35:2164-2165
   stays unanswerable for real runs after this slice; the immediate payoff is the
   pinned contract + its gate — the shape-before-consumer posture T-012 took.
2. **The declaration contract is opt-in.** A blockless plan keeps T-012's pass-through
   (pinned by Gate 1.13's fixtures). Strictness by default would flip more of
   Gate 1.13 than the two time-boxed assertions and would change behavior of
   previously-valid plans; the carved lineage successor owns any tightening.
3. **Anchor resolution is format-only.** Without the artifact store there is nothing
   to resolve `#obs-4` against; `parseDistillationReport` enforces format + the
   report's own declared input set, which is the whole of §7.5 rule 1 checkable today.
4. **The `DistillationPlan` shape is chosen here** — the spec names the type and never
   defines it (§7.1:507); this slice documents the choice and pins it, the
   T-007/T-012 move.

## Acceptance criteria

- [ ] `DistillationPlan` parsing: a plan carrying a valid `distillation` block parses
      with all other fields intact; unknown sub-fields, a non-array or empty
      `expectedArtifactIds`, non-string/empty entries, and duplicate entries are each
      refused (ContextRefusal naming the offense) — pinned by **Gate 1.14**; the
      flipped parser assertion in **Gate 1.13** (`scripts/check-context.mjs:100`)
      covers the positive parse on the shared fixture plan.
- [ ] `parseDistillationReport`: the §23.2:1358-1381 shape (with §7.4:565-578-prefixed
      refs) parses; unknown top-level or claim fields, an empty `statement`, duplicate
      claim ids, missing/empty `source_refs`, malformed refs (anything not
      `artifact:<id>#<anchor>`, including §23.2:1371-1377's bare `id#anchor` — the
      documented divergence), and any `source_refs`/`disagreement_refs` entry whose
      `<id>` is not in the report's `source_artifacts` are each refused **naming the
      claim id**; `claims: []` is valid; `disagreement_refs` is optional but resolved
      when present; anchors are not resolved (no store, §34:2028) — pinned by
      **Gate 1.14**.
- [ ] Builder integration: with a `distillation` block present, a Layer-3-class record
      the block does not declare is refused naming its id — both when it would fit and
      when it would be `excluded-by-budget` (the declaration check precedes the budget
      test); a declared entry is admitted with Layer-3 budget/manifest semantics
      unchanged; declared-but-absent is not a refusal; a plan without the block builds
      byte-identically to the pre-change fixture output — pinned by **Gate 1.14** +
      **Gate 1.13**'s untouched Layer-3/determinism assertions.
- [ ] Fingerprint stability: `planHashOf` covers the new block (a plan carrying it
      hashes differently from the same plan without it), and no previously-valid plan
      changes hash or behavior — plans carrying `distillation` could not parse before
      (`src/context.ts:367-369`), so every previously-valid input is untouched
      (T-007:94-100) — pinned by **Gate 1.13**'s determinism/fingerprint assertions
      plus **Gate 1.14**'s planHash-sensitivity assertion.
- [ ] Gate 1.13's two time-boxed refusal assertions (`scripts/check-context.mjs:100`
      and `:335-337`) are replaced in this same change-set by strictly stronger
      coverage — positive parse/inspect of valid blocks plus refusal of invalid
      blocks — and VERIFICATION.md's time-box sentence (`:714-716`) records the
      expiry; no existing assertion is weakened or removed without replacement
      (AGENTS.md #8) — pinned by **Gate 1.13 + Gate 1.14** both green and by
      change-set review.
- [ ] New **Gate 1.14** (`scripts/check-distillation.mjs`, next free integer at
      landing) is hooked into `scripts/verify.mjs` after the Gate 1.13 block and
      before the fast-tier finish (`scripts/verify.mjs:508-518`), runs token-free over
      hand-built fixtures, and VERIFICATION.md carries its section in the same
      change-set (AGENTS.md #6) — pinned by `npm run verify` completing ALL GREEN with
      both gate sections running.
- [ ] Zero pipeline surface: `src/runner.ts`, `src/scheduler.ts`, adapters, gate code,
      store, `RunReport` shape, `src/context-inspect.ts`, and `package.json` are
      untouched; zero new npm dependencies — pinned by **Gate 0** (`npm run
      typecheck`), the full fast tier (`npm run verify` ALL GREEN), and change-set
      review.
- [ ] Ticket status + index row move in the same change-set (tickets README rules) —
      pinned by change-set review.

## Verification

Gate 0 always — green before this change, verified this session 2026-10-16 at HEAD
`1898177` (clean tree): `npm run typecheck` → exit 0; full fast tier `npm run verify`
→ "verify (fast) complete: ALL GREEN", exit 0 (Gates 0/1/0.5/1.5/1.6-1.13, including
Gate 1.13 "check-context: ALL GREEN" with today's distillation refusal live). Gate 1
(`npm run demo`) sanity rides the fast tier. Gate 0.5 n/a (`src/parse.ts` untouched).
The new **Gate 1.14** runs via `npm run verify`. **Gate 2 is not required and not
run**: the change-set touches none of VERIFICATION.md:812-814's triggers — no
`src/runner.ts`, no adapter, no gate code, no workspace handling, no report-shape
change (everything lives in `src/context.ts`, `scripts/check-context.mjs`, the new
`scripts/check-distillation.mjs`, the one hook line in `scripts/verify.mjs`, and
docs) — stated so it is neither silently skipped nor silently owed (the T-012 trigger
analysis); the carved pipeline distiller stage owns a Gate 2 run when it lands.
Gate 3 n/a (no adapter; the model enters only as the fingerprint's CLI/config string,
decisions.md: engine is model/harness-agnostic).

## References

spec §6.8 (`docs/spec/inference-refinery-v2.md:463` lineage, `:489`
distillation-report type), §7.1 (`:507`), §7.3 (`:546-563`), §7.4 (`:565-578`), §7.5
(`:580-587`), §23.2 (`:1358-1381`), §27 (`:1825-1827`), §34 (`:2028`, `:2035-2047`),
§35 (`:2163-2165`) · T-012 — the reserved successor (refusal `src/context.ts:367-369`,
Layer-3 pass-through `:53-56,:527-531`, pinned ref form `:119-121` +
`scripts/check-context.mjs:70,154,249`; carve `T-012:142-144`; choose-and-document
`:21-30`; honest-tension framing `:179-199`) · T-009 — job-spec unknown-field
refusals (`src/scheduler.ts:153`) and the artifact-store does-not-claim
(T-009:144-145) · T-007 — narrowed `input_context_hash` fingerprint stability
(`:94-100`) · T-008 — gate-number-at-landing move (`:96`) · VERIFICATION.md Gate 1.13
(`:700-786`; time-box sentence `:714-716`; Gate 2 triggers `:812-814`) ·
`docs/decisions.md` 2026-10-10 (gates decide / harness-agnostic / Node 22 zero-deps /
`C:\swarm\` run root — the last binds any future CLI default; this slice adds none) ·
`docs/ROADMAP.md:14,19`.
