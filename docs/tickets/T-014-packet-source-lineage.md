# T-014 — Packet-level source lineage: builder-input ref enforcement + claim-chain inspection

**Status:** done 2026-10-17
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** T-013 — and T-013 is paper as of this ticket: its commit at HEAD `c913903` is docs-only (verified: `git show --stat c913903` → exactly 2 files, `docs/tickets/README.md` +1 and the T-013 file +289), `src/context.ts:367-369` still refuses a present `distillation` block, and grep for `DistillationPlan`/`parseDistillationReport`/`check-distillation` over `src/`, `scripts/`, `package.json` returns zero hits (verified this session). **This ticket cannot start until T-013's implementation lands** — the T-009:170-173 paper-dependency precedent, stated plainly rather than papered over. What follows is written against T-013's pinned surface and must be reconciled against what actually lands.

## What

Third and final contract-level slice of Milestone 2 (spec §34:2035-2047 — after this,
"source lineage" `:2044` is landed and the milestone's build list is complete at the
contract level; `docs/ROADMAP.md:14` "remaining: shard distillation, source lineage"
clears). This is the follow-up T-013 pre-authorized: "No packet-level lineage
enforcement. A Layer-3 entry's refs are not validated against the input artifact id
set; multi-hop chain resolution (§7.3's cross-shard tier; §7.5 rules 2-3) is carved —
the pre-authorized follow-up ticket" (T-013:143-145), with "extending format checks to
builder-input refs" reserved at T-013:96. Like T-012/T-013: a pure-module change plus a
read-only CLI extension plus its own fast-tier gate, **zero behavior change to the
pipeline**. It consumes T-013's records — the `DistillationPlan` opt-in, the pinned
`artifact:<id>#<anchor>` ref format, `ContextRefusal` — and never re-pins them.

- **`src/context.ts` — builder-input lineage enforcement** (pure module unchanged in
  character: no I/O, no model knowledge, zero new npm dependencies — decisions.md,
  TypeScript on Node 22; `node:crypto` only):
  - **Opt-in, keyed to T-013's block.** All new enforcement runs only when the plan
    carries `distillation`. A blockless plan builds **byte-identically** to T-013's
    output — no new packet field, no refusal — pinned by Gate 1.13's untouched
    fixtures, which ride blockless plans.
  - **Two checks in the Layer-3 pass-through scan** (`src/context.ts:529-531`), run
    per record **before the budget test** inside `include` (`src/context.ts:490-502`)
    — mirroring T-013:76-84's declaration-before-budget order, so budget-luck can
    never hide an untraceable claim (§7.2:544 nothing-silent):
    1. **Format:** every `sourceRefs` entry of a Layer-3-class record (`isDistilled`,
       `src/context.ts:455-457`) must match the T-013-pinned `artifact:<id>#<anchor>`
       (starts `artifact:`, exactly one `#`, non-empty id and anchor). The format
       predicate is **T-013's single definition** — factored out of
       `parseDistillationReport` and reused here, never a second divergent copy;
       §23.2:1371-1377's bare `id#anchor` is refused per T-013's documented
       reconciliation.
    2. **Resolution:** every ref's `<id>` must appear in the build's input set — the
       canon of input artifact ids (`src/context.ts:470`), every disposition, not just
       inclusions. §7.4:578: "a downstream reviewer can expand any distilled statement
       back to original evidence" — an id outside the input set expands to nothing, so
       the claim is untraceable (§7.5:580-587).
  - A violation is a `ContextRefusal` (`src/context.ts:214`) **naming the record id
    (the claim) and the dead/malformed ref**. Anchors stay opaque — no store to
    resolve into (§34:2028; T-013:63-66's rule, consumed not restated). Records
    removed by plan exclusions (`src/context.ts:478-484`) never reach the scan and are
    recorded `excluded-by-plan` — the same posture as T-013's declaration check: the
    builder refuses what arrived untraceable, not what didn't arrive.
  - **Per-ref resolution recorded on the packet entry.** In strict mode, each included
    Layer-3 entry additionally records, per ref, its resolution against the build's
    own manifest (§7.2:544 — every input exactly once): a new optional `ArtifactRef`
    field, present **only** on Layer-3 entries built under the block, shaped like
    `{ ref, disposition: 'included' | 'excluded-by-plan' | 'excluded-by-budget' }[]`
    (exact field name chosen at implementation and documented; one form, pinned by the
    gate). A ref naming an excluded input records that exclusion rather than hiding it
    — the §7.5 chain stays walkable through exclusions. `sourceRefs: string[]` itself
    is untouched (T-012's pinned pass-through shape).
  - **Fingerprint untouched.** `selected` is `{id, contentHash}` in packet order
    (`src/context.ts:566-569`); the new field rides the entry, never the fingerprint.
    No new plan field, so `planHashOf` inputs are unchanged. Stated so nobody mistakes
    this for a hash change: strict-mode packet JSON gains the field, but nothing pins
    strict-mode bytes cross-version — T-013's byte-identical acceptance is
    blockless-only, and that is exactly what stays byte-identical.
  - **Mutual and self citation are legal at build.** A ref may name another
    Layer-3-class input (§7.3:546-563's cross-shard tier) or the record itself —
    resolution is against the input id set, so cycles build fine; termination is the
    inspector render's duty (below).
- **`src/context-inspect.ts` — per-claim chain rendering + strict-keyed dead-chain
  refusal.** The CLI gains no new flags (`--plan/--packet/--json/--run-root`
  unchanged; the run-root default already carried at `src/context-inspect.ts:68` —
  decisions.md run root). The inspector parses the plan (`:383`), so it knows strict
  mode: `plan.distillation` present.
  - **Strict-mode packet validation** extends `validatePacketShape` (`:133-206`):
    every Layer-3 entry must carry the per-ref resolution field; a resolution whose
    `ref` is malformed, is absent from the entry's `sourceRefs`, or whose disposition
    disagrees with the manifest is refused — a packet like that cannot have been
    produced by this builder (the builder resolves before recording), so it is tamper:
    exit non-zero, no body (the inspector's refusal pattern, `:16-20`).
  - **Chain render added, nothing replaced.** The existing one-hop `sources:` line
    (`:354-355`) and the `--json` `sourceChains` shape (`:287`, `:321`) are untouched —
    Gate 1.13 pins both (`scripts/check-context.mjs:290`, `:302`). A new text section
    and a new `--json` field render, per distilled entry, every sourceRef with its
    resolution status — `included (layer N)` / `excluded-by-plan` /
    `excluded-by-budget` — **expanded transitively** when a ref names another
    Layer-3-class entry included in the packet (§7.3's cross-shard hop; §7.5 rules
    2-3's walkable chain), depth-labeled and **cycle-safe**: a visited-set renders a
    revisit as a terminated marker (`↺ <id>`), self-reference included. A ref naming
    an excluded input terminates at its recorded disposition. Statuses come from the
    recorded resolutions in strict mode, and are computed at render time against the
    manifest in blockless mode — where a dead ref renders `unresolved` and does
    **not** refuse (below).
  - **Dead-chain refusal is strict-keyed — forced, not stylistic.** In strict mode the
    builder refuses dead refs, so a ref whose id is in neither the manifest nor the
    packet layers is tamper evidence: the inspector refuses (non-zero, no body). In
    blockless mode the builder verbatim-copies refs (`src/context.ts:449-451`) and
    never promised resolution, so no refusal. This keying is the only reading
    consistent with the baseline: Gate 1.13's own happy-path fixture cites
    `research-003`/`research-011` (`scripts/check-context.mjs:70`) — ids absent from
    its input set — and its exit-0 assertions (`:285-291`, `:302`) must stay green
    untouched; an unkeyed refusal would break Gate 1.13 or force weakening its
    fixtures (AGENTS.md #8). Read-only guarantee unchanged (sha256 before/after,
    pinned at `scripts/check-context.mjs:309`, `:420`).
- **The lineage gate — extension of T-013's `scripts/check-distillation.mjs` if that
  is what landed, else the next free integer at landing (the T-008:96 move).** Hooked
  into `scripts/verify.mjs` after the Gate 1.13 block, before the fast-tier finish
  (`:508-518`), tsx-loaded like its siblings, list-form spawn (AGENTS.md #4),
  hand-built fixtures (no artifact store exists to produce inputs, §34:2028), zero
  model tokens. Content pinned regardless of the number it lands under:
  - builder refusals: malformed refs (bare `id#anchor`, missing anchor, double `#`)
    and dead-id refs, each refused naming claim id + ref, each exercised **would-fit
    and excluded-by-budget**;
  - builder happy path: a strict-mode build whose refs resolve is admitted, with
    per-ref resolutions recorded correctly across all three dispositions (a ref
    naming an excluded-by-plan input records exactly that); two Layer-3 records
    citing each other build fine;
  - byte-identity: a blockless build is byte-identical to the pre-change fixture
    output and carries no resolution field;
  - CLI: strict happy path exits 0 rendering the transitive chain (text + `--json`);
    a cycle renders terminated; a strict-mode packet tampered post-build with a dead
    ref is refused; a resolution-record disagreeing with the manifest is refused; a
    blockless packet with an unresolvable ref inspects exit 0 rendering `unresolved`;
    read-only sha256 proof;
  - **T-013's landed gate stays green:** if its strict-mode builder fixtures carry
    refs that do not resolve into their input sets, those fixtures' refs are
    corrected in this same change-set so the declared-entry-admitted assertions hold
    under the new enforcement — assertion strength preserved, nothing weakened or
    removed (AGENTS.md #8); a candidate deviation to record in Landed if it happens.
  - **Gate 1.13 stays green untouched:** its fixtures ride blockless plans —
    including the `research-003`-refs fixture — and must not be edited.
- **VERIFICATION.md** gains the lineage gate's section (and updates the carved-list
  paragraph at `:775-786` if it still names packet-level lineage as carved) in the
  same change-set (AGENTS.md #6). Ticket status + index row move in the same
  change-set.

**Does NOT claim:**

- **No store persistence.** §27:1824-1827's `artifacts`/`artifact_lineage`/
  `context_plans`/`context_packets` tables: the store today is exactly 9 tables
  (`src/store/index.ts:53-146` — runs, candidates, gate_results, events, phases,
  jobs, job_dependencies, attempts, approval_gates; grep for the lineage tables over
  `src/` + `scripts/` returns zero hits, verified this session), and the filesystem
  artifact store (§34:2028) is Milestone 1's unclaimed build item (T-009:160-161,
  T-012:139-141). Lineage lives in the packet JSON this slice — self-contained by
  design (`src/context.ts:190-192`), which is what makes chain inspection checkable
  with no store.
- **No pipeline producer or consumer.** Jobs still cannot carry
  `inputArtifacts`/`contextPlan`/`role` (`src/scheduler.ts:153` — verified: the
  allowed list is `id, phase, dependencies, brief, model, worker, timeoutMs, gates`);
  nothing in `src/runner.ts` is touched. After this slice nothing in the pipeline
  builds a strict-mode packet or reads a chain; the value is the pinned, gated
  contract — the T-012/T-013 shape-before-consumer posture.
- **No real anchor resolution.** `#obs-4` stays opaque; expanding a ref to actual
  content needs the store — carved with persistence.
- **No §7.5 rule 4.** The "show source chain" UI is Milestone 7 (`docs/ROADMAP.md:19`);
  the extended CLI render is still the token-free precursor, as the dag dump is §26.2's.
- **The blockless-tightening question T-013:39-42 handed here is decided and
  documented: enforcement stays keyed to the `distillation` block.** Rationale: a
  blockless plan has no declared-input contract to enforce against
  (`expectedArtifactIds` is the block's own field); tightening would flip more of
  Gate 1.13 than the time-boxed pair and change previously-valid inputs (AGENTS.md #8
  territory); and no pipeline builds strict packets yet, so default-on buys nothing
  today. A future change-set may tighten and must do so by explicitly flipping gate
  fixtures — recorded here so this is a decision, not an omission.
- **No T-013 re-pinning.** The ref format standardization (prefixed §7.4 form over
  §23.2's bare form), report-level resolution (`source_refs` against the report's own
  `source_artifacts`), the plan-level declaration refusal (`expectedArtifactIds`), and
  the §23.2-vs-§7.4 divergence reconciliation are T-013's — consumed via reuse, never
  restated or reimplemented.
- **No new npm dependencies, no adapter change, no `package.json` change** — Gate 3
  n/a; Gate 0.5 n/a (`src/parse.ts` untouched).

## Why

`docs/ROADMAP.md:14` names stage 2's remainder verbatim — "remaining: shard
distillation, source lineage" — and this ticket is the second half of that remainder,
completing Milestone 2's contract surface ("required before large fan-in",
§34:2047). §35:2165's operator question — "Can a distilled claim be traced to primary
evidence?" — becomes answerable at the packet level: inspect a claim, walk its chain
to primary evidence, or hit a named machine refusal. §7.4:565-578 mandates the
`artifact:<id>#<anchor>` refs and the expansion promise; §7.5:580-587 rules 1-3
mandate the no-untraceable-chains discipline (rule 4 is the Milestone-7 UI). T-013
enforces the rule at the report level and the plan-declaration level; the packet
level — what the builder actually accepts as input — was explicitly left open
(T-013:96, :143-145). That gap is real, verified first-hand this session at HEAD
`c913903` (clean tree):

- the builder copies `sourceRefs` through verbatim (`src/context.ts:449-451`) and
  admits any non-empty string array as Layer-3 class (`:455-457`);
- the only `sourceRefs` validation anywhere in the repo is the inspector's
  non-empty-string-array shape check (`src/context-inspect.ts:157-158`) — so a
  strict-mode packet carrying `sourceRefs: ['nonsense']` would build and inspect
  green; Gate 1.13's fixtures never exercise a malformed ref (the only ref fixture,
  `scripts/check-context.mjs:70`, is well-formed);
- `lineage` exists only as a selector attribute on the input record
  (`src/context.ts:147`, matched at `:412`) — nothing produces or checks a chain;
- §7.5's no-untraceable-chains rule has no packet-level enforcement point at all.

The refusal is machine code over records, never a model verdict (decisions.md
2026-10-10 "Machine gates decide survival; models advise" — honored by construction:
the checks live in the pure builder and the read-only CLI, and no model output can
influence them). Absent lineage fails loud, never silent (§7.2:544; the NO-OP rule's
spirit, AGENTS.md #7).

**Honest tensions, stated rather than smoothed** (the T-012/T-013 precedent):

1. **Still no consumer.** After this slice §35:2165 stays unanswerable for real runs —
   nothing produces a strict-mode packet in the pipeline. The payoff is the pinned,
   gated contract, the same posture T-012 and T-013 took.
2. **The default path enforces nothing.** Blockless plans keep pass-through exactly;
   the decision and its revisit conditions are documented in the change-set (above),
   so the gap is chosen, not forgotten.
3. **The gate number depends on T-013's landing.** Whether this extends
   `check-distillation.mjs` or claims the next integer is decided at landing (the
   T-008:96 move); the asserted content is pinned here regardless.
4. **Touching the predecessor's fixtures is possible.** If T-013's landed
   strict-mode fixtures carry non-resolving refs, this ticket must correct them to
   stay green — scoped to ref values, strength-preserving, and recorded as a
   deviation if it happens (AGENTS.md #8).

## Acceptance criteria

- [x] Builder ref enforcement (strict mode): a Layer-3-class record whose `sourceRefs`
      carry a malformed entry (anything not `artifact:<id>#<anchor>`, including
      §23.2:1371-1377's bare form) or a ref whose `<id>` is not in the build's input
      set is refused — `ContextRefusal` naming the record id and the ref — both when
      the record would fit and when it would be `excluded-by-budget` (the check
      precedes the budget test); plan-excluded records are recorded `excluded-by-plan`,
      not checked; anchors are not resolved (no store, §34:2028) — pinned by the
      **lineage gate**.
- [x] Per-ref resolution recording: a strict-mode build records each included
      Layer-3 entry's per-ref resolution agreeing with the build's manifest, with all
      three dispositions exercised; two Layer-3 records citing each other build fine;
      a blockless build is byte-identical to the pre-change fixture output and carries
      no resolution field; fingerprint and planHash are unchanged by the new field —
      pinned by the **lineage gate** + **Gate 1.13**'s determinism/fingerprint
      assertions (`scripts/check-context.mjs:127-131`).
- [x] Inspector chain rendering: a strict-mode packet renders each distilled entry's
      refs with resolution status, expanded transitively through included Layer-3
      entries, cycle-safe (a cycle or self-reference renders terminated, not looping),
      in both text and `--json`; the existing `sources:` line and `--json`
      `sourceChains` shape are untouched; a blockless packet with an unresolvable ref
      still inspects exit 0, rendering it `unresolved` — pinned by the **lineage
      gate**'s CLI section + **Gate 1.13**'s inspector assertions (`:285-291`, `:302`).
- [x] Inspector refusals (strict mode only): a dead ref (id in neither manifest nor
      packet layers), a Layer-3 entry missing the resolution field, a resolution
      disagreeing with the manifest, and a malformed recorded ref each exit non-zero
      with no body, naming the offense — pinned by the **lineage gate**'s CLI section
      (the Gate 1.13 inspector pattern: exit codes, no-body-on-refusal, sha256
      read-only proof, `scripts/check-context.mjs:277-420`).
- [x] No drift: every existing Gate 1.13 assertion stays green untouched — its
      fixtures ride blockless plans, including the `research-003`-refs fixture at
      `scripts/check-context.mjs:70`, which must not be edited; T-013's landed gate
      stays green, with any strict-mode-fixture ref corrections made in this
      change-set at preserved assertion strength (AGENTS.md #8) — pinned by **Gate
      1.13 + T-013's gate + the lineage gate** all green in `npm run verify`, and
      change-set review.
- [x] The lineage gate (extension of T-013's `scripts/check-distillation.mjs` if that
      is what landed, else the next free integer at landing — content pinned above
      regardless) is hooked into `scripts/verify.mjs` after the Gate 1.13 block before
      the fast-tier finish (`:508-518`), runs token-free over hand-built fixtures, and
      VERIFICATION.md carries its section in the same change-set (AGENTS.md #6) —
      pinned by `npm run verify` completing ALL GREEN with the section running.
- [x] Zero pipeline surface: `src/runner.ts`, `src/scheduler.ts`, adapters, gate
      code, store, `RunReport` shape, and `package.json` are untouched; zero new npm
      dependencies — pinned by **Gate 0** (`npm run typecheck`), the full fast tier
      (`npm run verify` ALL GREEN), and change-set review.
- [x] The blockless-tightening decision (stays keyed to the `distillation` block) is
      documented in the change-set itself — code comment + VERIFICATION.md wording —
      closing the question T-013:39-42 handed here — pinned by change-set review.
- [x] Ticket status + index row move in the same change-set (tickets README rules) —
      pinned by change-set review.

## Landed

2026-10-17, lane branch `ticket/T-014-packet-source-lineage`. T-013's implementation
had landed before this ticket started (commit `e8a31b7`, merged `448c3c9` — Gate 1.14
with `scripts/check-distillation.mjs`), so the ticket's at-landing moves resolved as
follows.

What changed:

- **The lineage gate is an extension of T-013's landed
  `scripts/check-distillation.mjs`** — Gate 1.14 keeps its number (the extension arm
  of the ticket's at-landing move), already hooked in `scripts/verify.mjs` after the
  Gate 1.13 block and before the fast-tier finish; the hook's section label now names
  both halves ("shard distillation core + packet source lineage").
- **`src/context.ts`** (pure module unchanged in character: no I/O, no model
  knowledge, zero npm dependencies): `parseSourceRef`/`refArtifactId` — T-013's
  single ref-format definition — are now exported and reused at the packet level
  (never a second divergent copy); `enforceSourceLineage` runs per Layer-3-class
  record in the pass-through scan, after T-013's declaration check and before the
  budget test inside `include` (format + input-set resolution; refusals name the
  record id and the ref; a Layer-1-captured declared record is still checked); the
  new packet field is **`sourceRefResolutions`** — `{ ref, disposition }[]`, one per
  `sourceRefs` entry, recorded only on included Layer-3 entries built under the
  block, dispositions read off the final manifest (name chosen at implementation as
  the ticket reserved; documented on the `SourceRefResolution` interface); the
  blockless-tightening decision (stays keyed to the block) is documented in the
  module header as a locked decision with its revisit conditions.
- **`src/context-inspect.ts`** (no new flags): `validatePacketShape` gained a
  `strict` parameter keyed to the plan's block, adding the per-ref validation — a
  Layer-3 entry missing `sourceRefResolutions`, a recorded ref malformed (the shared
  `parseSourceRef`), absent from the entry's `sourceRefs`, or dead against the
  manifest, or a recorded disposition disagreeing with the manifest, each refuses
  non-zero with no body naming the offense; `lineageChains` added to the inspection
  view — a new `source chains (lineage):` text section and `--json` field rendering
  per distilled entry every ref with its status (`included (layer N)` /
  `excluded-by-plan` / `excluded-by-budget` / `unresolved` / the terminated marker
  `↺ <id>`), transitive through included Layer-3 entries, depth-labeled, cycle-safe;
  statuses come from the recorded resolutions in strict mode, computed at render
  time in blockless mode; the one-hop `sources:` line and the `--json`
  `sourceChains` shape are untouched.
- **Deviations — the ticket's anticipated fixture corrections, both
  strength-preserving and scoped to ref values (AGENTS.md #8):**
  1. `scripts/check-distillation.mjs`: `dist-a` cited `artifact:research-001#obs-1`
     against input set `{dist-a, note-b}` — dead under the new enforcement, so the
     declared-entry-admitted assertions went red exactly as the ticket predicted.
     Corrected to `artifact:note-b#obs-1`; the byte-for-byte blockless snapshot was
     re-pinned on exactly its `sourceRefs` line (planHash and fingerprint lines are
     ref-blind and byte-identical to the T-013 pin — documented in the snapshot
     comment). No assertion changed.
  2. `scripts/check-context.mjs`: the T-013-added strict round-trip fixture (its
     :336-347 block, not a blockless rider) built under the block with
     `distilled-research` citing `research-003`/`research-011`, absent from the
     input set — that build now refuses. Corrected to a dedicated `distilled-strict`
     artifact citing included Layer-1 inputs (`goal-primary`/`schema-roles`), sized
     to the same 25 tokens its assertions pin, with `distilled-research` removed via
     plan exclusion. Every assertion text unchanged; every blockless fixture —
     including the `research-003`-refs fixture at :70 — untouched. Gate 1.13: ALL
     GREEN, 126 ok lines, zero assertion edits.
- **Blockless-tightening decision**: documented in `src/context.ts`'s module header
  (code comment) and in VERIFICATION.md's Gate 1.14 lineage paragraph — enforcement
  stays keyed to the `distillation` block; revisit conditions stated.

Measured this session (lane, after the full change-set):

- Gate 0: `npm run typecheck` → exit 0.
- Full fast tier: `node scripts/verify.mjs fast` → "verify (fast) complete: ALL
  GREEN", exit 0 — Gates 0/1/0.5/1.5/1.6-1.14, Gate 1.13 "check-context: ALL
  GREEN" untouched, Gate 1.14 (extended) ALL GREEN with **92 ok lines, up from
  52** (+40: 19 builder-lineage assertions, 21 lineage-CLI assertions including
  5 refusals × 3).
- Gate 2 not run — the change-set touches none of VERIFICATION.md's Gate 2
  triggers: no `src/runner.ts`, no adapter, no gate code, no workspace handling,
  no report-shape change (the diff is `src/context.ts`, `src/context-inspect.ts`,
  `scripts/check-distillation.mjs`, `scripts/check-context.mjs` (fixture
  correction only), the `scripts/verify.mjs` section label, and docs). Any
  successor that composes packets into prompts or consumes chains in the
  pipeline owns a Gate 2 run. Gate 0.5 n/a (`src/parse.ts` untouched). Gate 3
  n/a (no adapter).
- Zero pipeline surface confirmed: `src/runner.ts`, `src/scheduler.ts`, adapters,
  gate code, store, `RunReport`, and `package.json` untouched; zero new npm
  dependencies.

## Verification

Gate 0 always — green before this change, verified this session 2026-10-16 at HEAD
`c913903` (clean tree): `npm run typecheck` → exit 0; full fast tier `npm run verify`
→ "verify (fast) complete: ALL GREEN", exit 0 (Gates 0/1/0.5/1.5/1.6-1.13, including
Gate 1.13 "check-context: ALL GREEN" with today's distillation refusals live at
`scripts/check-context.mjs:100` and `:335-337`). Gate 1 (`npm run demo`) sanity rides
the fast tier. Gate 0.5 n/a (`src/parse.ts` untouched). The lineage gate runs via
`npm run verify`. **Gate 2 is not required and not run**: the change-set touches none
of VERIFICATION.md:812-814's triggers — no `src/runner.ts`, no adapter, no gate code,
no workspace handling, no report-shape change (everything lives in `src/context.ts`,
`src/context-inspect.ts`, the lineage gate script, the hook line in
`scripts/verify.mjs`, and docs) — stated so it is neither silently skipped nor
silently owed (the T-012 Verification / T-013:264-270 trigger-analysis precedent);
any successor that composes packets into prompts or consumes chains in the pipeline
owns a Gate 2 run. Gate 3 n/a (no adapter; the model enters only as the fingerprint's
CLI/config string, `src/context.ts:247`; decisions.md: engine is
model/harness-agnostic).

## References

spec §6.8 (`docs/spec/inference-refinery-v2.md:463` lineage, `:489`
distillation-report type), §7.2 (`:544` nothing-silent manifest), §7.3
(`:546-563`), §7.4 (`:565-578`), §7.5 (`:580-587`), §23.2 (`:1358-1381`), §26.4
(`:1744-1756`), §27 (`:1824-1827`), §34 (`:2028`, `:2035-2047`), §35 (`:2163-2165`) ·
T-013 — the predecessor (carves `:92-96`, `:142-145`; opt-in `:36-42`; declaration-
before-budget `:76-84`; pinned ref format `:55-60`; anchor opacity `:63-66`; Gate 2
analysis `:264-270`) · T-012 — the inspector surface extended here
(`src/context-inspect.ts:68`, `:133-206`, `:287`, `:321`, `:354-355`, `:383`;
store-table carve `T-012:139-141`) and Gate 1.13 (`VERIFICATION.md:688-786`; time-box
sentence `:714-716`; carved list `:775-786`) · T-009 — paper-dependency precedent
(`:170-173`) and job-spec refusals (`src/scheduler.ts:153`) · T-008 —
gate-number-at-landing move (`:96`) · VERIFICATION.md Gate 2 triggers (`:812-814`) ·
`docs/decisions.md` 2026-10-10 (gates decide / harness-agnostic / Node 22 zero-deps /
`C:\swarm\` run root — the last already carried by `src/context-inspect.ts:68`; this
slice adds no CLI default) · `docs/ROADMAP.md:14,19`.
