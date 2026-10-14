# T-012 — Context system core: ContextPlan/ContextPacket, deterministic budgets + selectors, fingerprints, `context inspect` CLI

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** T-006 (proposed) — an **ordering dependency, not a build dependency**: this slice's pure core and CLI import nothing from T-006's code (no store, no runner, no `src/dag.ts`), but the packet's job identity is defined against T-006's §6.4 job model and the store-resident successor slice cannot start until T-006 lands. Stated, not smoothed.

## What

First slice of Milestone 2 (spec §34:2035-2047 — the context-system build list minus
shard distillation and source lineage, which are carved): a pure context module, a
read-only inspection CLI, and their own fast-tier gate. **Zero behavior change to the
pipeline** — nothing in `src/runner.ts`, the `RunReport`, the adapters, or the gate
code produces or consumes a packet after this slice; the value is the pinned,
re-derivable contract plus inspectability (the T-006 posture: land the shape and its
proof before any consumer exists).

- **`src/context.ts` — new pure module** (no I/O at the core, no model knowledge,
  zero new npm dependencies — `node:crypto` sha256 only; decisions.md: TypeScript on
  Node 22):
  - **Types, vocabulary chosen here and documented** (the T-007:18-33
    choose-and-document move — the spec uses `ContextPlan`/`ArtifactQuery`/
    `SelectionRule`/`SourceReferencePolicy` as field types, §7.1:500-512, and never
    defines the latter three):
    - `ContextPlan` per §7.1:500-512 **minus `distillation`**: `maxInputTokens`,
      `mandatory: ArtifactQuery[]`, `selectable: SelectionRule[]`,
      `sourceReferencePolicy`, `exclusions?: ArtifactQuery[]`. A plan carrying a
      `distillation` block is refused at parse (not silently ignored) until the
      §7.3-7.5 slice defines builder semantics for it — the T-009:25-28
      unknown-field posture.
    - `ArtifactQuery` — a conjunction of optional fields mapping 1:1 onto the
      §7.6:593-605 selector vocabulary: `type?`, `candidate?`, `phase?`,
      `producerRole?`, `gateStatus?` (`'passed' | 'failed'`), `lineageContains?`,
      `newerThan?`/`olderThan?` (ISO-8601 strings, lexicographic compare — no Date
      parsing, no wall clock, consistent with the store's never-`Date.now()` rule,
      `src/store/index.ts:8-11`), `ids?` (explicit artifact IDs), `tagged?`. A
      query naming no known selector field is a parse refusal.
    - `SelectionRule = { layer: 'primary' | 'supporting', query: ArtifactQuery,
      orderBy?: 'id' | 'timestamp-desc', limit?: number }` — `primary` rules fill
      Layer 2 in plan order; `supporting` rules fill Layer 4 under the
      budget-remainder rule.
    - `SourceReferencePolicy = 'artifact-ref'` — the only mode this slice:
      Layer-3 entries carry `sourceRefs: string[]` of §7.4:567-576-shaped refs
      (`artifact:<id>#<anchor>`).
    - `ArtifactRecord` — builder input: the §6.8:451-467 fields with producers
      (`id`, `type`, `contentHash`, `sizeBytes`) + the selector-relevant attributes
      above (all optional; absent → that selector cannot match) + `content: string`
      + `sourceRefs?: string[]` (Layer-3 entries).
    - `ContextPacket` — **self-contained this slice** (no artifact store to point
      into, §34:2028): `jobId?` (recorded when provided — the T-006 job-model
      attachment point, candidate id in today's world; not fingerprinted, it is not
      a §7.7 component), per-layer included entries (`ArtifactRef` =
      id/type/contentHash/sizeBytes/layer/estimatedTokens, + `sourceRefs` on L3),
      the manifest (every input artifact id exactly once — included, or excluded
      with the reason `excluded-by-plan` vs `excluded-by-budget`), the budget
      ledger (cap, per-layer estimates, total), and the fingerprint + its
      null-and-documented components.
  - **Deterministic token estimator:** `ceil(chars / 4)` over artifact content — a
    documented approximation, never a tokenizer (zero-deps posture; the
    better-sqlite3 precedent, VERIFICATION.md:238-243 — a new dependency needs its
    own decisions entry). The pinned contract is reproducibility — same inputs →
    same estimates → same inclusions → same fingerprint — not tokenizer accuracy.
    The ledger covers artifact content only; prompt-framing overhead is the carved
    composer's concern.
  - **Four-layer builder** (§7.2:514-545), a pure function of
    `(plan, ArtifactRecord[], { model })` — `model` a CLI/config string, the only
    place a model exists in this code (decisions.md: engine is
    model/harness-agnostic; `src/worker/opencode.ts` stays the only harness-aware
    file): Layer 1 mandatory always included, never trimmed (§7.2:516-518) — a
    plan whose mandatory layer alone exceeds `maxInputTokens` is refused as
    unsatisfiable; plan `exclusions` removed before any selection, recorded
    `excluded-by-plan`; Layer 2 primary evidence per the rules; Layer 3 distilled
    pass-through with source refs (nothing distills — the entries are inputs);
    Layer 4 supporting included only while budget remains (§7.2:540-542), the
    remainder excluded `excluded-by-budget`. The emitted manifest describes
    exactly what was included and excluded (§7.2:544) — nothing silent.
    **Determinism contract** (the T-009:38-44 tie-break move): base canon is
    id-ascending; rules apply in plan order; `timestamp-desc` is newest-first with
    id-ascending tie-break. Identical inputs → byte-identical packet JSON (stable
    key order), same ledger, same fingerprint.
  - **§7.6 selectors — the deterministic subset, exactly:** the nine §7.6:593-605
    kinds mapped onto `ArtifactQuery` above. No semantic/LLM selection and no hook
    for one: "There is no invisible 'AI relevance filter'" (§7.6:609) is honored
    by construction — every inclusion is explicit plan data.
  - **§7.7 fingerprint, narrowed to components with producers:** sha256 over a
    canonical JSON blob of `{ model, planHash (canonical-JSON hash of the
    normalized plan), selected: [{id, contentHash} …] in packet order }`; the
    §7.7:614-620 components without producers — prompt version (§6.7:446,
    §18:1207), role version, reasoning configuration, project-manifest version
    (§13:971) — ride as null fields, recorded in the packet and documented. This
    is the producer T-007:94-100 reserved and T-007:149-151 Does-NOT-claimed; a
    later packet→prompt composer must reconcile with T-007's `input_context_hash`
    definition (composed prompt with the workspace-path line excluded,
    T-007:94-97) — one hash or a documented relationship, that slice's duty.
- **`src/context-inspect.ts` — read-only CLI**, the house standalone-entry pattern
  (`tsx src/context-inspect.ts`, like `src/clean.ts`/`src/integrate.ts`/T-006's
  `src/dag.ts`; pure module + CLI split mirrors `src/store/index.ts` + `src/dag.ts`):
  `npm run context -- --plan <path> --packet <path> [--json] [--run-root <path>]`.
  Paths resolve absolute or against `--run-root` (default `C:\swarm\` — same
  literal as `src/cli.ts:78-80`, decisions.md run root). Renders the
  §26.4:1748-1756 fields: token budget (cap + per-layer ledger), mandatory/
  selected/distilled included artifacts, excluded artifacts with reasons, L3
  source chains, context fingerprint (producerless components shown as
  no-producer). `--json` emits the same structure as JSON — the future feed for
  the §26.4 UI (Milestone 7, ROADMAP.md:19), the dag-dump-to-§26.2 relationship
  (T-006:78-79). Refusals exit non-zero **before any body is printed** (the
  T-005/T-006 refusal pattern): missing `--plan`/`--packet`, missing file,
  unparseable JSON, a packet failing validation (recorded ledger inconsistent
  with recomputation, or recorded total over cap), fingerprint mismatch on
  recompute. The CLI never writes: input files are byte-identical after an
  inspect.
- **New fast-tier gate — `scripts/check-context.mjs`**, claiming **Gate 1.13
  under the planned ordering — "next free integer at landing"** (the T-008:96
  move): 1.7 (T-006:136-139), 1.8 (T-007:112-114), 1.9 (T-008:93-96), 1.10
  (T-009:97-99), 1.11 (T-010:56), 1.12 (T-011:91-92) are all claimed by unlanded
  tickets. Hooked into `scripts/verify.mjs` after Gate 1.6, before the fast-tier
  finish (`scripts/verify.mjs:448`) — the slice-owns-its-gate precedent
  (T-003/T-005/T-006/T-007). No existing gate can pin any context criterion: the
  fast tier never runs the pipeline and Gate 2 spends model tokens and cannot
  assert on synthetic packets (the T-007:112-116 / T-009:100-106 argument
  verbatim). The check drives the pure functions directly and the CLI as a
  subprocess (list-form spawn — AGENTS.md #4) over **hand-built plan + artifact
  fixtures** — the Gate 0.5 `check-parse.mjs` precedent, since no artifact store
  exists to produce inputs (§34:2028 is the unclaimed Milestone-1 build item;
  T-009:144-145 explicitly does not claim it).
- **VERIFICATION.md** gains the new gate section in the same change-set
  (AGENTS.md #6); ticket status + index row move together.

**Does NOT claim:**

- **No packet→prompt composition in `src/runner.ts`** — a behavior change owning
  its own Gate 2 run (VERIFICATION.md:200-201) that also collides with T-009's
  unlanded rewrite of the same file. Prompts stay hand-composed strings
  (`builderPrompt`/`plannerPrompt`/`reviewerPrompt`, `src/runner.ts:29-43,93-105,
  109-133` — scout-verified). The pipeline cannot see a packet this slice, which
  is also exactly why context selection can never influence promotion or
  elimination here: machine gates decide survival, models advise
  (decisions.md; AGENTS.md #2) — honored by construction, claimed explicitly.
- **No `context_plans`/`context_packets` store tables** (§27:1826-1827) — needs
  T-006 landed plus a producer in the pipeline; T-003's later-tables reservation
  (T-003:61-63, `src/store/index.ts:19-20`) is left for that successor.
- **No distillation workflows** (§7.3-7.5) — per the ask; Layer-3 entries are
  pass-through inputs with source refs, nothing produces them, and `distillation`
  is refused at plan parse until that slice defines semantics.
- **No artifact-store integration** — selectors run over hand-built sets in the
  gate; real produced artifacts wait for §34:2028's unclaimed build item.
- **No full §7.7 fingerprint** — the four producerless components stay null; the
  reconciliation duty toward T-007's hash is documented above.
- **No §26.4 UI** (Milestone 7, ROADMAP.md:19) — the CLI is the token-free
  precursor, as T-006's dump is for §26.2.
- **No new npm dependencies, no adapter change** — Gate 3 n/a; Gate 0.5 n/a
  (`src/parse.ts` untouched).

## Why

`docs/ROADMAP.md:14` maps stage 2 to spec Milestone 2 — "required before large
fan-in" (§34:2047) — and §34:2039-2045's build list is exactly this slice plus
shard distillation and source lineage (carved per the ask). The reservation chain
is explicit: T-007 narrows its `input_context_hash` to "the §7.7:611-621
fingerprint narrowed to what exists … none has a producer until the Milestone-2
context system" (T-007:94-100) and Does-NOT-claims the full fingerprint
(T-007:149-151); T-009 refuses `contextPlan`/`inputArtifacts` as unknown job-spec
fields "not ignored, so a typo can never silently narrow a run" (T-009:25-28) and
carves "No artifact store, no context plans" (T-009:144-145) — this slice is that
future producer, and the landing order matters only for T-009's job-spec schema.

The gap is real, verified this session at HEAD `60bc055` (clean tree):
`grep -rniE "contextplan|contextpacket|fingerprint|ArtifactQuery|selectable"`
over `src/`, `scripts/*.mjs`, `package.json` returns nothing (exit 1, re-run
first-hand); `src/` has no `context.ts` and `src/types.ts` has no Context or
Artifact types (scout read all 134 lines); the only budget-like mechanism today
is the reviewer's `MAX_DIFF_CHARS = 30_000` diff truncation (`src/runner.ts:107`,
applied `:110,125-126`); prompts are hand-composed strings. Nothing bounds what a
worker or reviewer sees, and nothing can ever answer §26.4:1758-1764's operator
questions ("Why did this agent know this? / Why did it not see that?") about a
run. This slice builds the record that answers them and the CLI that reads it
back — the §26.4 precursor, not the Milestone-7 UI.

**Honest tensions, stated rather than smoothed** (the T-006:101-111 precedent):

1. **No producer exists for selector inputs.** The filesystem artifact store is
   Milestone 1's one unclaimed build item (§34:2028; T-009:144-145 does not
   claim it), so every selector/budget/fingerprint assertion in the gate runs on
   hand-built artifact sets — the Gate 0.5 `check-parse.mjs` precedent. Nothing
   here pretends artifacts flow.
2. **Token budgets are a documented approximation, not a tokenizer.** No
   tokenizer npm dependency (decisions.md: TypeScript on Node 22). `ceil(chars/4)`
   is pinned for reproducibility, never sold as accuracy.
3. **§35:2197 ("Did Sol receive a bounded, inspectable context packet?") stays
   unanswerable for real runs after this slice** — nothing consumes packets yet.
   Immediate payoff is the pinned contract + the inspector, the same
   shape-before-consumer posture T-006 took toward the DAG.
4. **The fingerprint is narrowed** — four §7.7 components ride null (no
   producers); the composer successor owns reconciling with T-007's
   `input_context_hash`.
5. **Dependency on T-006 is an ordering dependency** (stated in the header):
   T-006 is `proposed`, its commit docs-only, `src/dag.ts` does not exist — but
   this slice imports nothing from it; only the store-resident successor is
   blocked. Stage 1 being open (ROADMAP.md:12) does not block the pure core.

## Acceptance criteria

- [ ] ContextPlan parsing: a valid plan parses; unknown fields, a present
      `distillation` block (not yet consumed), `maxInputTokens ≤ 0`, and a
      selector outside the §7.6:593-605 vocabulary are each refused — non-zero
      with a message naming the offense, before anything is built — pinned by
      the **new Gate 1.13** (`scripts/check-context.mjs` + new VERIFICATION.md
      section + hook in `scripts/verify.mjs` before the fast-tier finish,
      `scripts/verify.mjs:448`; gate number = next free integer at landing,
      1.13 under the planned ordering, the T-008:96 move).
- [ ] Determinism: two builds from identical plan + artifact inputs produce
      byte-identical packet JSON, and the same inputs → same inclusions → same
      fingerprint — pinned by **Gate 1.13**.
- [ ] Layer 1 is always present and never trimmed (§7.2:516-518); a plan whose
      mandatory layer alone exceeds `maxInputTokens` is refused as
      unsatisfiable — pinned by **Gate 1.13**.
- [ ] Budget enforcement: Layer 4 entries are included only while budget remains
      (§7.2:540-542) in the documented deterministic order; plan `exclusions`
      remove before selection; every input artifact appears in the manifest
      exactly once — included, or excluded with `excluded-by-plan`/
      `excluded-by-budget` — nothing silent (§7.2:544) — pinned by **Gate 1.13**.
- [ ] Each deterministic §7.6:593-605 selector (type, candidate, phase, producer
      role, machine gate status, lineage, timestamp, explicit ID, tag) returns
      exactly the matching artifacts on hand-built sets; timestamps compare
      lexicographically (no Date parsing, no wall clock) — pinned by
      **Gate 1.13**.
- [ ] Layer-3 distilled entries pass through with §7.4:567-576-style source refs
      carried into the packet and rendered by the inspector — pinned by
      **Gate 1.13**.
- [ ] Fingerprint (§7.7 narrowed): identical inputs → identical hash; changing
      any produced component — one selected artifact's hash, the selection set,
      the model string, any plan field — yields a different hash; the four
      producerless §7.7:614-620 components are recorded null — pinned by
      **Gate 1.13**.
- [ ] `npm run context -- --plan <p> --packet <p>` exits 0 and renders the
      §26.4:1748-1756 fields — token budget (cap + per-layer ledger), per-layer
      included artifacts, excluded artifacts with reasons, L3 source chains,
      context fingerprint; `--json` emits the same structure as JSON — pinned by
      **Gate 1.13**.
- [ ] Inspector refusals exit non-zero and print no body: missing `--plan`/
      `--packet`, missing file, unparseable JSON, packet whose recorded ledger is
      inconsistent or over cap, fingerprint mismatch on recompute — pinned by
      **Gate 1.13**.
- [ ] The inspector never writes: plan and packet files are byte-identical after
      an inspect (hash before/after) — pinned by **Gate 1.13**.
- [ ] No pipeline behavior change: `src/runner.ts`, the `RunReport` shape,
      adapters, gate code, and workspace handling are untouched (context
      selection cannot influence verdicts — decisions.md: gates decide;
      AGENTS.md #2), `package.json` gains exactly one script, and
      **`npm run verify`** (Gates 0/1/0.5/1.5/1.6) stays ALL GREEN — green
      before this change, verified 2026-10-14 this session: `npm run typecheck`
      → exit 0 (Gate 0); `npm run verify` → "verify (fast) complete: ALL GREEN",
      exit 0 — and it must stay green after.
- [ ] VERIFICATION.md carries the new gate section, and the ticket status + index
      row move in the same change-set (AGENTS.md #6; tickets README rules) —
      pinned by change-set review.

## Verification

Gate 0 (`npm run typecheck`) always — green before this change, verified
2026-10-14: `npm run typecheck` → exit 0. Gate 1 (`npm run demo`) sanity,
token-free. Gate 0.5 n/a (`src/parse.ts` untouched — the plan parser is new code
in `src/context.ts`, not the harness-output parser). Gate 1.6 untouched in code
but must stay green via `npm run verify`. The **new Gate 1.13** runs via
`npm run verify` (not yet run for this ticket — no code exists). **Gate 2 is not
required and not run**: the slice touches none of VERIFICATION.md:200-201's
triggers (no `src/runner.ts`, no adapter, no gate code, no workspace handling, no
report-shape change — everything lives in the new `src/context.ts` +
`src/context-inspect.ts` + `scripts/check-context.mjs`) — stated here so it is
neither silently skipped nor silently owed (the T-006:162-168 / T-008:249-263
precedent); any successor that composes packets into prompts owns a Gate 2 run.
Gate 3 n/a (no adapter; zero model involvement — the model enters only as the
fingerprint's CLI/config string, decisions.md: engine is model/harness-agnostic).

## References

spec §6.7 (`docs/spec/inference-refinery-v2.md:446`), §6.8 (`:448-468`), §7.1
(`:498-512`), §7.2 (`:514-545`), §7.4 (`:565-578`), §7.6 (`:589-610`), §7.7
(`:611-621`), §13 (`:971`), §18 (`:1207`), §26.4 (`:1744-1764`), §27
(`:1826-1827`), §34 (`:2035-2047`), §35 (`:2197`) · T-006 — ordering dependency
and the precedent pack (read-only dump CLI, refusals before any body, byte-proof
`:51-61,140-144`; honest-tension framing `:101-111`; slice-owns-its-gate
`:136-139`; Gate-2-not-required trigger analysis `:162-168`) · T-007 — the
narrowed `input_context_hash` this slice's fingerprint must reconcile with
(`:94-100`) and its Does-NOT-claim (`:149-151`) · T-009 — refuses `contextPlan`
until this producer exists (`:25-28,:144-145`) · T-008 — the
gate-number-under-uncertain-order move (`:96`) · `docs/decisions.md` (2026-10-10:
Node 22 zero-deps / harness-agnostic / gates decide / `C:\swarm\` run root) ·
`docs/ROADMAP.md:12,14,19`.
