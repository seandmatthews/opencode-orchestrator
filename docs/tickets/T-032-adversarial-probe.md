# T-032 — Adversarial probe: seeded fuzz cases fed over argv → crash/survival EvidenceBundle (spec §34:2139 M8, §24 Phase 9; fills T-030:95's carve)

**Status:** done 2026-10-21
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** T-015 (done 2026-10-17 — the Probe seam + EvidenceBundle contract this extends). T-018/T-019/T-024 (all done) are the change-set **template** (new type + per-type field rule + one explicit Gate 1.15 flip), not dependencies. T-030 (done 2026-10-20) is a **composition note, not a build dependency**: its round composer already renders any probe summary into the round-2 planner evidence (src/rounds.ts:126-131), so adversarial summaries compose with zero composer edits.

## What

ROADMAP stage 8's first landed slice (docs/ROADMAP.md:20 — the row is empty today). The spec names this probe as Milestone-8 vocabulary with zero definition: §34:2133-2141 lists "adversarial probes" among the adds (:2139); §1:29 names "adversarially test them" as run step 9; §25:1657-1661 shows the workflow-level shape — an `adversarial` phase depending on generation-1, `foreach: candidate`, running probes; §24 Phase 9 (:1513-1527) gives only Godot-game scenario examples (carved, below). Like the T-015/T-018/T-019/T-024 vocabulary moves, the semantics below are **chosen-and-documented in the module docblock** (the T-015:17-31 precedent).

A probe that actively tries to break a candidate: it feeds the target N **deterministic, replayable input cases** — a fixed edge-case corpus, malformed-data strings, and seeded randomized fuzz — and records which cases the target survived and which it crashed on, as EvidenceBundle evidence with `probe_runs` rows via the landed store. Verdicts stay with the gates (decisions.md:19-21); adversarial findings advise the human and the round-2 planner (T-030's feedback edge).

1. **`src/probe.ts` — `ProbeType` gains `'adversarial'`** (today exactly
   `'command' | 'test' | 'benchmark' | 'screenshot' | 'web'`, src/probe.ts:182):
   - `ScenarioSpec` gains `seed?: number` (beside `repeats`/`capture`/`url`,
     src/probe.ts:195-230) with a docblock contract: **required, positive integer
     ≥ 1, when `type: 'adversarial'`; refused on every other probe type** — a
     fuzz run with no seed is not replayable, so it is not an adversarial probe.
     The field exists only where it means something (the `repeats`/`capture`/
     `url` precedent; the T-009 unknown-field posture). Enforced by
     parseJobsSpec (src/scheduler.ts); the type carries it optionally because
     the union is shared.
   - **The seeded case generator — exported, pure: `generateAdversarialCases(seed: number): string[]`.**
     JS has no stdlib seeded PRNG (decisions.md:6-10's zero-new-deps posture —
     no `Chance`, no `seedrandom`), so the module docblock **chooses and
     documents one**: a ~6-line 32-bit PRNG (mulberry32) seeded from the
     integer seed, plus the fixed case-mix recipe it drives: a documented
     seed-independent edge-case corpus (empty string; control characters;
     non-ASCII; numeric edges such as `'NaN'`/`'Infinity'`/`'1e308'`/`'-0'`;
     malformed-JSON-looking strings) and a seeded randomized portion (PRNG-driven
     ASCII soup and corpus permutations). Same seed → **byte-identical case
     list**, every time, on every platform (no wall clock, no `Math.random`,
     no locale — the T-030 composer's determinism contract, src/rounds.ts:2-6).
     The list is recomputable by any consumer from the seed alone; the gate
     recomputes it and pins byte-equality. Case count is a documented constant
     (`ADVERSARIAL_PROBE_CASE_COUNT`) — the docblock records the mix, the gate
     pins the exact list.
   - **A documented max-case-length constant — `ADVERSARIAL_PROBE_MAX_CASE_CHARS`**
     (beside `WEB_PROBE_MAX_BODY_BYTES`, src/probe.ts:316): the generator never
     emits a case longer than it, because cases ride **argv** and Windows bounds
     a spawned command line (CreateProcess's ~32k limit) — the constant bounds
     the probe's contribution with margin; the operator's base `command` is
     expected to stay small (documented limitation). The per-case report
     **truncates recorded inputs to this bound** (the `WEB_PROBE_SNIPPET_BYTES`
     posture, src/probe.ts:318-323) — evidence stays bounded whatever the case
     was; the case content is artifact material, never a measurement (the
     validator accepts finite numbers only).
   - **`AdversarialProbe implements Probe`** (new class beside `BenchmarkProbe`,
     templated on its per-run loop, src/probe.ts:886-968): runs each case
     **sequentially**, the case appended to the scenario's `command.args` and
     executed through the landed `executeProbeCommand` (src/probe.ts:479-535 —
     list-form spawn, AGENTS.md #4, the T-011 verified tree kill at expiry;
     **no second spawn path is forked and the shared core is unchanged** — it
     has no stdin support, which makes argv-feeding the path of least change;
     stdin is carved). Each case gets the **full** `timeoutMs` budget (default
     `DEFAULT_PROBE_TIMEOUT_MS`, src/probe.ts:292) — a per-case budget, total
     wall time bounded by case count × timeoutMs (the BenchmarkProbe
     per-repeat-budget posture).
   - **Crash/survival vocabulary (docblock)**: a case's run **survives** when
     the target spawned cleanly, exited 0, and did not time out; it **crashes**
     when it ran and exited non-zero or timed out. A **spawn-refused** case
     (e.g. ENOENT) produced no run — neither survived nor crashed (a target
     cannot crash on an input it never received): no `case-<i>` duration for
     it, and `error` names it.
   - **Measurements** (the landed `Measurement` type; its validator accepts any
     finite number — no contract change): one `case-<i> duration` (unit ms) per
     case that actually ran (a crashing or timing-out case still ran — its
     `durationMs` is real wall-clock evidence), plus `cases-run` and
     `cases-crashed` counts (unit `'cases'`).
   - **Artifacts**: the combined output of all cases in one `.log` artifact with
     `=== case <i> ===` separators (the `logArtifact` pattern, src/probe.ts:647),
     **plus one `'report'`-kind per-case table artifact** `<probeId>.results.json`
     (the `resultsArtifact` pattern, src/probe.ts:664) —
     `{probeId, scenarioId, seed, cases: [{index, input, outcome, durationMs}],
     casesRun, casesCrashed}` where `outcome ∈ survived | crashed-exit |
     crashed-timeout | spawn-refused` and every `input` is truncated to
     `ADVERSARIAL_PROBE_MAX_CASE_CHARS`.
   - **`gateResults`: one `GateResult` entry per case**, in case order, named
     `'<probeId>#case-<i>'` (the `<id>#run-<i>` precedent, `toGateResult`,
     src/probe.ts:630) so each case's evidence row is self-naming — the crash
     list is machine-readable from the failed rows.
   - **Success semantics**: `success` = the case list is non-empty AND every
     case spawned cleanly AND every case survived (the no-crash target passes —
     the BenchmarkProbe success shape, src/probe.ts:945). Zero completed cases
     is `success: false`, **never a pass** (AGENTS.md #7 applied to bundles —
     the T-018 posture). `error` names the FIRST breaking case with counts
     ("case 3/12 exited with code 1", "case 5/12 timed out after Nms", "case
     1/12 could not be spawned: ENOENT"). Measurements are recorded **regardless
     of success** — evidence about crashes is the point.
   - **No verdict input.** A `success:false` adversarial bundle changes nothing
     downstream: the ladder (src/runner.ts:750 — `passedAllGates`) is untouched
     by construction and this ticket edits no runner code — the pipeline is
     type-agnostic (`runProbes` iterates `job.probes` with no type switch,
     src/runner.ts:823-852, driven post-gates regardless of outcome at
     :760-762), `probe_runs` ingest and upsert have no type knowledge
     (src/store/index.ts:212-221, :1016-1023, :1403-1415), and
     `ProbeRunSummary` is type-agnostic (src/types.ts:324-330).
   - `createProbe` gains the adversarial branch (src/probe.ts:1321-1334); its
     docblock updates.

2. **`src/scheduler.ts` — one validation surface** (`parseJobsSpec`'s probes
   map): `seed` joins the allowed probe-field list (src/scheduler.ts:205); the
   type refusal at :211-212 becomes `type must be "command", "test",
   "benchmark", "screenshot", "web", or "adversarial"`; shape validation per
   the landed field-rule pattern (src/scheduler.ts:225-279): `seed` required
   positive integer ≥ 1 on `adversarial` (missing, 0, negative, non-integer,
   non-number — all refused naming the offense), **refused on
   `command`/`test`/`benchmark`/`screenshot`/`web`** probes. The parsed spec
   carries `seed` only on adversarial probes (the conditional-spread return,
   src/scheduler.ts:280-288).

3. **`scripts/check-probe.mjs` — Gate 1.15 extended in place** (no new gate
   number; the T-018/T-019/T-024 extension precedent):
   - **The mandatory flip (AGENTS.md #8).** Gate 1.15's P2 leg **actively pins
     the five-type refusal message** today (scripts/check-probe.mjs:440-441,
     `type must be "command", "test", "benchmark", "screenshot", or "web"`,
     with `'godot'` as the genuinely-unknown example). This change-set
     invalidates that assertion, so the flip happens **explicitly in this
     change-set, never silently**: the expected message gains `"adversarial"`
     and `'godot'` stays genuinely unknown and remains the example (only the
     message string changes — exactly T-024's flip shape, VERIFICATION.md:1366-1379).
     Net strictness increases (the T-013 flip precedent); no other existing
     assertion is weakened.
   - New **P2** legs: `seed` validation — missing/0/-1/1.5/`'seven'` on an
     adversarial probe all refused naming the offense; `seed` present on a
     `command`/`benchmark` probe refused (`seed is only valid on an adversarial
     probe`); an adversarial probe with `seed` parses and is preserved verbatim.
   - New **P3** direct-execution legs on a **generated known-weak-spot sandbox
     fixture** (the T-024 write-and-run pattern — zero-dep scripts generated
     per leg in the verify sandbox, no checked-in fixture; VERIFICATION.md:1487-1491):
     a fuzzee script whose known weak spots exit non-zero on an
     independently-known subset of the generated case classes (e.g. it throws
     exactly on inputs failing `Number.isFinite(Number(arg))` — the same weak-spot
     class as the real demo target's `add()`: mixed-type concat and numeric
     overflow, scripts/demo-target.mjs:15-35).
     - **Determinism/replayability**: the check imports the exported
       `generateAdversarialCases`, recomputes the case list from the scenario's
       seed, and asserts (a) two generator invocations with the same seed
       produce byte-identical lists, (b) the probe's recorded per-case table
       inputs match the recomputed list case-for-case, and (c) two probe runs
       with the same seed against the same fixture agree case-for-case on
       outcome (replayable crash lists).
     - **Crash face**: the weak-spot fixture crashes on the known subset →
       success false; exactly that subset recorded as failed `'<id>#case-<i>'`
       rows; `cases-crashed` equals the subset size; `error` names the first
       breaking case.
     - **No-crash face**: a robust fixture → success true, `cases-crashed` 0,
       every `'<id>#case-<i>'` row passed.
     - **Spawn-refusal / zero-completed face**: a non-existent exe → success
       false, zero `case-<i>` duration measurements, never a pass (AGENTS.md #7).
     - **Timeout face** (the P4 sleeper pattern with its process-table
       assertions, scripts/check-probe.mjs:975-995): a case that sleeps past
       `timeoutMs` → that case's GateResult exitCode null, durationMs ≥
       timeoutMs, the duration still recorded, the spawned tree verified dead
       on the real process table, kill evidence on that case's entry.
     - **Length bound**: over several seeds, every generated case's length is
       ≤ `ADVERSARIAL_PROBE_MAX_CASE_CHARS`.
   - **P5** e2e: the existing `--jobs` drive (scripts/check-probe.mjs:1013)
     gains an adversarial probe on a job, asserting the `probes[]` ↔
     `bundlePath` correspondence for it (bundle on disk, validator-clean, the
     on-disk `'report'` results artifact parses with inputs bounded, success
     agreeing with the summary) and that survival is untouched by the
     adversarial outcome — a passing-gates/failing-adversarial job still passes
     (extending the existing leg, scripts/check-probe.mjs:1055).

4. **Docs in the same change-set** (AGENTS.md #6): VERIFICATION.md's Gate 1.15
   section (the probe narrative gains `AdversarialProbe`; a recorded T-032 flip
   paragraph beside T-018's/T-019's/T-024's, VERIFICATION.md:1341-1379; the
   carve list drops adversarial — it moves from carved to pinned); docs/ROADMAP.md:20's
   stage-8 row (partial: adversarial probes — T-032; remaining: candidate
   lineage/generations, early stop (T-031 proposed)); README's `--jobs` probes
   doc (README.md:153-189 — the type list gains `"adversarial"`, `seed`
   documented, the crash/survival recording posture, the argv length bound,
   and the evidence-not-verdict posture that section already states).

**Does NOT claim** (each carved, never silently assumed): **inline
adversarial-failure detail in the round-2 planner prompt** — the landed
composer already carries the failure FACT + bundle path (src/rounds.ts:126-131),
but `ProbeRunSummary` carries no error/detail field (src/types.ts:324-330), so
"the round-2 planner sees WHAT broke" beyond that pointer is a report-shape
change = its own Gate 2 obligation = a successor ticket; **Godot/§24-Phase-9
domain scenarios** (rapid alternating input, wall contact, scene reload — the
spec's examples are game-specific, §24:1513-1527); **any measurement→verdict
bridge** (fuzz findings as gates — the T-018:124-133 Gate-seam carve stands;
decisions.md:19-21); **coverage-guided/corpus fuzzing and cross-candidate fuzz
comparison** (pure seeded generation only this slice); **stdin feeding** (would
extend the shared `executeProbeCommand` core — argv only this slice); **the
§25:1657-1661 workflow-level `adversarial` phase** — `foreach: candidate` is
not a landed scheduler concept (the allowed job fields, src/scheduler.ts:166,
have no `foreach`), so an operator writes an explicit per-candidate job in a
`--jobs` spec today; this ticket adds the probe type, not phase semantics;
Godot/Blender probes (§12.1:911-947).

## Why

The spec names adversarial probes as M8 vocabulary with zero definition —
§34:2139 (one phrase in the add list), §1:29 (run step 9), §24 Phase 9
(:1513-1527, Godot-game examples only), §25:1657-1661 (the workflow shape). Every
landed slice has re-carved it: T-030:95 ("n ≤ 2; no adversarial probes; no
memoization") and VERIFICATION.md:2402 (the same carve in Gate 1.22's list);
docs/ROADMAP.md:20 leaves stage 8 unstarted. The gap is real and grep-verified
(scout, this session; re-confirmed by this ticket writer): a grep for
`adversarial|fuzz` over `src/`, `scripts/`, `README.md`, `VERIFICATION.md`,
`docs/ROADMAP.md` returns only those carve lines — no code, no competing claim;
the only open ticket, T-031, claims M8's early-stop add, a different item.

The substrate is fully built and verified type-agnostic, so this is the T-018
shape once more: the Probe seam + EvidenceBundle contract with its validator and
validate-then-write writer (src/probe.ts:182-247, :328-437), the sequential
per-run loop to template on (BenchmarkProbe, src/probe.ts:886-968), the list-form
spawn core (src/probe.ts:479-535 — no stdin today, so argv-feeding changes
nothing shared), and a pipeline with **zero edits to `src/runner.ts`,
`src/cli.ts`, `src/types.ts`, or `src/store/`** (src/runner.ts:750, :823-852;
src/store/index.ts:1016-1023; src/types.ts:324-330). The round-composition edge
already exists: T-030's composer renders probe summaries — success or failed,
with the bundle path — into the round-2 planner evidence (src/rounds.ts:126-131),
so "round-2 planner can see what broke round-1 survivors" lands as the failure
fact + replayable bundle pointer with no composer change.

**Honest tension (stated, not smoothed).** By design this cannot affect any
verdict: adversarial findings are evidence, never a verdict (decisions.md:19-21 —
gates decide survival, models advise), so its effect on outcomes is indirect —
advisory to the human, planning-input for round 2. What is genuinely new: M8's
first landed slice on a standing carve; the first probe whose evidence is about
inputs the target was never tested against (gates exercise the paths the author
thought of; this one exercises generated ones); and the replayability property —
a crash list recomputable from a seed is a reproducible bug report a human or a
round-2 planner can act on.

## Acceptance criteria

- [x] `ProbeType` includes `'adversarial'`; `AdversarialProbe` exists behind the
      landed Probe seam with the documented contract above (required
      positive-integer `seed` on adversarial and refused elsewhere; the exported
      pure `generateAdversarialCases(seed)` — same seed → byte-identical list,
      zero new deps, the PRNG chosen-and-documented in the module docblock;
      argv feeding through the unchanged `executeProbeCommand` — never `exec`,
      never a second spawn path; per-case full timeout budget; the
      `'<probeId>#case-<i>'` GateResult rows; the survived/crashed/
      spawn-refused vocabulary; measurements recorded regardless of success;
      zero completed cases never a pass; the `ADVERSARIAL_PROBE_MAX_CASE_CHARS`
      bound; no threshold or verdict input of any kind); zero model/harness
      knowledge in the module (decisions.md:11-15) — pinned by **Gate 0**
      (`tsc --noEmit`) plus the **Gate 1.15 P3** contract legs.
- [x] The parser accepts an adversarial probe with `seed` verbatim and refuses:
      a genuinely-unknown type with the updated message; missing/zero/negative/
      non-integer/non-number `seed` on adversarial; `seed` on a
      `command`/`test`/`benchmark`/`screenshot`/`web` probe — pinned by
      **Gate 1.15 P2** (contract fixtures over `parseJobsSpec`, token-free).
- [x] **The scripts/check-probe.mjs:440-441 five-type-refusal pin is explicitly
      flipped** — the expected message gains `"adversarial"`, `'godot'` stays
      the genuinely-unknown example — recorded here and in VERIFICATION.md as
      the change-set's one intentional invalidation of an existing assertion;
      no other existing check is weakened — pinned by the full fast tier,
      **`npm run verify` ALL GREEN** with the flipped Gate 1.15.
- [x] Determinism/replayability, token-free: `generateAdversarialCases(seed)`
      invoked twice with the same seed returns byte-identical case lists; a
      probe run against a fixture records a per-case table whose inputs match
      the independently recomputed list case-for-case; two same-seed runs
      against the same fixture agree case-for-case on outcome — pinned by
      **Gate 1.15 P3**.
- [x] Crash faces on a generated known-weak-spot fixture (the T-024
      write-and-run pattern): a target crashing on an independently-known
      subset of the recomputed cases → success false, exactly that subset
      recorded as failed `'<id>#case-<i>'` rows, `cases-crashed` == the subset
      size, `error` names the first breaking case; a no-crash target → success
      true with `cases-crashed` 0; a non-existent exe → success false with zero
      `case-<i>` durations, never a pass — pinned by **Gate 1.15 P3**.
- [x] Timeout face (the P4 sleeper pattern): a timing-out case → that case's
      GateResult exitCode null, durationMs ≥ timeoutMs with the duration still
      recorded, the spawned tree verified dead on the real process table, kill
      evidence on that case's entry — pinned by **Gate 1.15 P3** (the P4
      process-table pattern).
- [x] Evidence emission in a real pipeline: a `--jobs` run carrying an
      adversarial probe writes its bundle under `<artifactsDir>/probes/<candidateId>/`
      (decisions.md:25-26 — run root `C:\swarm\`; never the worktree as the
      durable copy), the report's `probes[]` names its `bundlePath` and agrees
      with the bundle (probeId/scenarioId/success), the on-disk `'report'`
      results artifact parses with every recorded input bounded by
      `ADVERSARIAL_PROBE_MAX_CASE_CHARS`, and survival is untouched by the
      adversarial outcome (a passing-gates/failing-adversarial job still
      passes) — pinned by **Gate 1.15 P5** (the fake-WorkerAdapter `runSkeleton`
      drive).
- [x] Zero runner/CLI/report/store drift: no `src/runner.ts`, `src/cli.ts`,
      `src/types.ts`, or `src/store/` edits (the pipeline is type-agnostic:
      src/runner.ts:750, :823-852; src/store/index.ts:1016-1023; src/types.ts:324-330);
      the verdict ladder byte-identical; adversarial summaries persist through
      `probe_runs` unchanged with **no store change** — pinned by **Gate 0**
      plus the change-set file list (`git status --porcelain`: exactly
      `src/probe.ts`, `src/scheduler.ts`, `scripts/check-probe.mjs`,
      `VERIFICATION.md`, `docs/ROADMAP.md`, `README.md`, the ticket file + the
      index; package.json/package-lock.json diff-free — **Gate 1.6** rides
      green unchanged inside the tier).
- [x] No new npm dependencies (decisions.md:6-10 — the PRNG is ~6 stdlib lines)
      and zero model knowledge in the probe module (decisions.md:11-15) —
      pinned by **Gate 0** and the package.json/package-lock.json diff-free
      change-set.
- [x] Docs extended in the same change-set (AGENTS.md #6): VERIFICATION.md's
      Gate 1.15 section (the recorded T-032 flip paragraph; adversarial moves
      from the carve list to pinned; the new legs named), docs/ROADMAP.md:20's
      stage-8 row, README's `--jobs` probes doc — pinned by **`npm run verify`
      ALL GREEN** with the updated sections present.
- [x] **Gate 2 NOT owed — recorded, not silently skipped** (the T-018:223-228
      trigger-analysis precedent): the change-set touches no `src/runner.ts`,
      no adapter, no gate code, no workspace handling, and no report shape —
      none of Gate 2's triggers (VERIFICATION.md:2474-2475); Gate 2 is
      additionally a `--goal`-mode run that executes no probe code — probe
      emission rides `--jobs` runs (VERIFICATION.md:1381-1383) — so it could
      not pin an adversarial criterion anyway. **Gate 3 n/a** (no adapter
      touched, no new harness).

## Landed

**2026-10-21.** The change-set is exactly `src/probe.ts`, `src/scheduler.ts`,
`scripts/check-probe.mjs`, `VERIFICATION.md`, `docs/ROADMAP.md`, `README.md`,
this ticket + the index — verified `git status --porcelain`;
`package.json`/`package-lock.json` diff-free (`git diff --stat` empty).

- **`src/probe.ts`** — `ProbeType` gains `'adversarial'`; `ScenarioSpec`
  gains `seed?: number` (docblock: required positive integer ≥ 1 on
  adversarial, refused elsewhere — the repeats/capture/url precedent); the
  module docblock gains the adversarial-semantics section (the
  choose-and-document precedent). The exported, pure
  `generateAdversarialCases(seed)` documents and uses **mulberry32** — the
  chosen ~6-line 32-bit PRNG, integer math only (`Math.imul`), zero new
  deps (decisions.md 2026-10-10) — over the documented mix: the
  seed-independent 12-entry `ADVERSARIAL_EDGE_CORPUS` (empty string;
  control characters; non-ASCII; numeric edges
  `'NaN'`/`'Infinity'`/`'1e308'`/`'-0'`/`'0x10'`/`'1,000'`;
  malformed-JSON-looking strings) in corpus order, + 4 PRNG-driven
  ASCII-soup strings + 4 corpus permutations (seeded Fisher-Yates, first
  two entries space-joined) = `ADVERSARIAL_PROBE_CASE_COUNT` (20); every
  emitted case sliced to `ADVERSARIAL_PROBE_MAX_CASE_CHARS` (8192 — the
  CreateProcess ~32k argv bound with margin). `AdversarialProbe` feeds each
  case as the LAST argv element through the unchanged `executeProbeCommand`
  core (no second spawn path forked, no stdin), full per-case `timeoutMs`;
  the survived/crashed-exit/crashed-timeout/spawn-refused vocabulary; one
  `'<probeId>#case-<i>'` GateResult per case in case order; `case-<i>
  duration` + `cases-run`/`cases-crashed` measurements recorded regardless
  of success; the `=== case <i> ===` combined `.log` plus the
  'report'-kind `<probeId>.results.json` per-case table (the kind's THIRD
  producer; inputs truncated to the bound); success = non-empty list AND
  every case spawned cleanly AND every case survived (zero completed
  cases never a pass); `error` names the FIRST breaking case with counts;
  the class holds the seed contract for directly constructed scenarios
  (the screenshot/web precedent). `createProbe` gains the adversarial
  branch. Zero edits to `src/runner.ts`, `src/cli.ts`, `src/types.ts`,
  `src/store/` — the verdict ladder byte-identical.
- **`src/scheduler.ts`** — `seed` joins the allowed probe fields; the type
  refusal becomes `type must be "command", "test", "benchmark",
  "screenshot", "web", or "adversarial"` (`'godot'` stays the example);
  `seed` required positive integer ≥ 1 on adversarial (missing/0/-1/1.5/
  non-number refused naming the offense) and refused on the other five
  types; the parsed spec carries `seed` only on adversarial probes.
- **`scripts/check-probe.mjs`** — Gate 1.15 extended in place, no new gate
  number: the P2 five-type-refusal pin explicitly FLIPPED (the change-set's
  one intentional invalidation, recorded in VERIFICATION.md beside
  T-018's/T-019's/T-024's; `'godot'` stays the example, only the message
  string changed) plus the adversarial positive-parse face and the seed
  shape-refusal faces; P3 direct-execution legs on a generated
  known-weak-spot fuzzee fixture (the T-024 write-and-run pattern; the
  fuzzee exits non-zero exactly on inputs failing
  `Number.isFinite(Number(arg))` — the demo target's `add()` weak-spot
  class, scripts/demo-target.mjs:15-35), with the expected crash subset
  derived INDEPENDENTLY from the recomputed case list: generator
  determinism (byte-identical same-seed lists), the length bound over 5
  seeds, recorded table inputs == recomputed list case-for-case, two
  same-seed runs agreeing case-for-case on outcome, the crash face (exactly
  the derived subset as failed rows, counts, `error` naming case 1, the
  results artifact parsing to outcomes matching the derivation), the
  no-crash face, the spawn-refusal/zero-completed face, the P4-pattern
  timeout face (exitCode null, durationMs ≥ budget, duration still
  recorded, tree verified dead on the real process table, kill evidence on
  the case's entry), and the class-level seed-contract throw; P5: the
  `--jobs` drive gains a FAILING adversarial probe on job-a (5→6 probes,
  the T-024 drive-extension precedent) with bundle/artifact/count pins
  against the independently recomputed seed-7 list, the results artifact
  under the artifacts dir never inside the worktree, and survival
  untouched (a passing-gates/failing-adversarial job still passes).
- **Docs in the same change-set** (AGENTS.md #6): VERIFICATION.md Gate
  1.15 (the probe narrative gains `AdversarialProbe`; the T-032 semantics
  paragraph; the recorded T-032 flip paragraph; P2/P3/P5 bullet
  extensions) and Gate 1.22's carve paragraph (adversarial moves from
  carved to pinned — "no adversarial probes" dropped with a pointer);
  docs/ROADMAP.md:20's stage-8 row (partial: early stop done — T-031;
  adversarial probes done — T-032; generations deferred);
  README.md:153-189's probes doc (the type list gains `"adversarial"`,
  `seed` documented, the crash/survival recording posture, the 8192-char
  argv bound, evidence-not-verdict).

**Implementation notes (honest):**

- The P5 e2e adversarial target is the fixture repo's own `adv-fuzzee.js`
  (script-file form), not an inline `-e` source: node's CLI parses an
  appended leading-`-` case as an OPTION in `-e` mode — observed
  first-hand while debugging this change-set (`node -e <src> -0` →
  `bad option: -0`, exit 9; the probe recorded it honestly as a crash,
  which IS correct fuzz evidence about such a target, but useless as a
  predictable fixture). Script-file mode passes the case through as
  `argv[2]`, keeping the crash subset independently derivable.
- The timeout-face fixture embeds the exact first case (the corpus leads
  with the empty string) as its hang trigger, so exactly one case burns
  the 1200ms budget and the face stays fast.
- Carved, unchanged from the ticket: stdin feeding, the workflow-level
  `adversarial` phase (`foreach: candidate`), inline failure detail in the
  round-2 planner prompt (the composer carries the failure fact + bundle
  path only — a report-shape change, a successor's Gate 2),
  measurement→verdict bridges, coverage-guided/corpus fuzzing,
  Godot/§24-Phase-9 domain scenarios.

**Gates (measured on the lane, this change-set):** baseline re-confirmed
first at HEAD c02ee4b before edits — Gate 0 exit 0; `check-probe` ALL
GREEN with **104 `ok:` lines** (the ticket's stated baseline). After the
change: **Gate 0** (`tsc --noEmit`) exit 0; `node
node_modules/tsx/dist/cli.mjs scripts/check-probe.mjs` → `check-probe: ALL
GREEN`, exit 0, **124 `ok:` assertion lines** (104 baseline + 20 new
adversarial assertions, the flipped pin included); full fast tier `node
scripts/verify.mjs fast` → `=== verify (fast) complete: ALL GREEN ===`,
exit 0 (~1m37s wall), Gate 1 and Gate 1.6 riding green unchanged inside
the tier. **Gate 2 NOT owed** — the change-set touches no `src/runner.ts`,
no adapter, no gate code, no workspace handling, no report shape (none of
VERIFICATION.md's Gate 2 triggers), and Gate 2 is a `--goal`-mode run that
executes no probe code. **Gate 3 n/a** (no adapter touched).

## Verification

**Gate 0** (typecheck) throughout; **Gate 1.15 extended in place** — this ticket
claims **no new gate number** and extends the probe gate's existing legs: P2
parser legs (the :440-441 flip + `seed` validation), P3 direct-execution
adversarial legs (determinism/replay, crash/no-crash/spawn-refusal faces on the
generated known-weak-spot fixture, the P4-pattern timeout face, the length
bound), P5 e2e correspondence leg; the whole existing fast tier stays green
(`npm run verify`) — the one flipped assertion is named in the criteria, nothing
else weakened. Gate 1 (fixture regeneration) untouched and green inside the
tier; **Gate 1.6 rides green unchanged** (`probe_runs` ingest is type-agnostic,
src/store/index.ts:1016-1023). **Gate 2 not owed** per the recorded trigger
analysis above; **Gate 3 n/a** (no adapter).

Baseline at HEAD 381272a (clean tree), re-run by this session's ticket writer:
`npm run typecheck` → exit 0; `node node_modules/tsx/dist/cli.mjs
scripts/check-probe.mjs` → `check-probe: ALL GREEN`, exit 0, 104 `ok:`
assertion lines — the baseline the :440-441 flip above modifies is green today.

## References

docs/spec/inference-refinery-v2.md §34:2133-2141 (M8 add list; "adversarial
probes" :2139), §1:29 (run step 9), §12.1:901-951 (the six defined probe types —
none adversarial), §24:1513-1527 (Phase 9, Godot-game examples), §25:1657-1661
(the `adversarial` phase shape) · docs/tickets/T-030-bounded-rd-loop.md:95 (the
carve this fills), :126-131 → src/rounds.ts:126-131 (the landed composition
edge) · docs/tickets/T-015-probe-layer-first-slice.md:17-31 (the
choose-and-document precedent) · docs/tickets/T-018-benchmark-probe.md (the
change-set template; :124-133 the measurement→verdict carve;
:223-228 the Gate 2 trigger-analysis precedent) · VERIFICATION.md:1341-1379
(the recorded T-018/T-019/T-024 flip discipline), :1381-1383 (Gate 2 executes
no probe code), :1487-1491 (the T-024 write-and-run fixture pattern), :2402
(the standing carve), :2474-2475 (Gate 2's trigger list) · docs/decisions.md:6-10
(zero-new-deps), :11-15 (harness-agnostic), :19-21 (gates decide survival),
:25-26 (run root C:\swarm) · docs/ROADMAP.md:20 · src/probe.ts:182, :195-230,
:292, :316, :318-323, :328-437, :479-535, :630, :647, :664, :848, :886-968,
:1321-1334 · src/scheduler.ts:166, :205, :211-212, :225-288 · src/runner.ts:750,
:760-762, :823-852 · src/store/index.ts:212-221, :1016-1023, :1403-1415 ·
src/types.ts:324-330 · scripts/check-probe.mjs:440-441, :492, :893, :975-995,
:1013, :1055 · scripts/demo-target.mjs:15-35 · README.md:153-189.

## Re-land record (2026-10-21, post-batch)

The batch merge `d530fb0` was auto-reverted the same day (`e73d9a2`) — the
project's first auto-revert: the lane's fast tier was green, the driving
workflow's post-merge fast tier on main went red, and the red's output was
not captured anywhere durable (VERIFICATION.md Known issue #13). Diagnosis
the same day: the exact merged tree `d530fb0` re-run detached at main's own
checkout path came back ALL GREEN. The content re-landed by reverting the
revert; its post-merge fast tier ran ALL GREEN with full output captured
(`C:\swarm\verify-red\T-032-reland-post-merge-fast.log`). Two green runs of
the content, zero reproduced reds; the red's class stays unidentified
(output lost, gate name unknown — not countable toward any threshold), and
the remedy is structural: the driving workflow now tees every gate run's
full output to `C:\swarm\verify-red\`, so the next red of any class arrives
with its bar attached.
