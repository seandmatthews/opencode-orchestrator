# T-018 — Benchmark probe: repeated measured command → quantitative EvidenceBundle (per-run durations + min/median/p95)

**Status:** proposed
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** T-015 (done 2026-10-17 — the Probe seam + EvidenceBundle contract this extends). T-016 (proposed) is an **ordering note, not a build dependency**: `probe_runs` persistence is T-016's claim and `ProbeRunSummary` (src/types.ts:279-285) is type-agnostic, so a benchmark probe's summary persists through it unchanged whenever it lands; this ticket touches no store code.

## What

Stage-4 remainder (docs/ROADMAP.md:16): the third generic probe of spec Milestone 4's
start list (§34:2061-2069 — command, test, **benchmark**, screenshot), which T-015
explicitly carved (docs/tickets/T-015-probe-layer-first-slice.md:93). §12.1 names the
Benchmark Probe in one line — "Produces structured performance results."
(§12.1:907-909) — and defines nothing: like the T-007/T-012/T-013 vocabulary moves,
the semantics below are chosen-and-documented in the module docblock. This is the
first probe that produces **quantitative measurements** rather than pass/fail
evidence, and the template for the Godot-class probes (frame timing, telemetry — all
Measurement producers).

1. **`src/probe.ts` — `ProbeType` gains `'benchmark'`** (today exactly
   `'command' | 'test'`, src/probe.ts:66; the docblock at :64-65 still calls
   benchmark a successor slice — it updates):
   - `ScenarioSpec` gains `repeats?: number` (src/probe.ts:76-84) with a docblock
     contract: **required, positive integer ≥ 1, when `type: 'benchmark'`; refused
     on every other probe type** (a benchmark with no repetition count is not a
     benchmark — the strictest honest shape per the T-009 unknown-field posture:
     the field exists only where it means something).
   - **`BenchmarkProbe implements Probe`** (new class beside CommandProbe/TestProbe):
     runs the scenario's command `repeats` times, **sequentially, each through the
     landed `executeProbeCommand`** (src/probe.ts:295-351 — list-form `spawn`,
     AGENTS.md #4, with the T-011 verified tree kill; **no second spawn path is
     forked**). Each repeat gets the **full** `timeoutMs` budget (default
     `DEFAULT_PROBE_TIMEOUT_MS`, src/probe.ts:146) — a per-repeat budget, documented;
     total wall time is bounded by `repeats × timeoutMs`.
   - **Measurements** (the landed `Measurement` type, src/probe.ts:123-128 — its
     validator already accepts any finite number, :178-185; **no contract change**):
     one `{ name: 'run-<i> duration', value, unit: 'ms' }` per repeat that actually
     ran (i is 1-based; a repeat that exited non-zero or timed out still ran — its
     `durationMs` from `executeProbeCommand` is real wall-clock evidence and is
     recorded), plus three summary measurements `min`, `median`, `p95` (unit `'ms'`),
     each the **nearest-rank order statistic of the sorted recorded durations**
     (`sorted[ceil(q·n)−1]`; no interpolation, stdlib sort only — zero new deps,
     decisions.md:6-10). The convention is stated in the module docblock; the gate
     pins exact values.
   - **Artifacts**: the combined output of all repeats in one `.log` artifact with
     `=== run <i> ===` separators (the `logArtifact` pattern, src/probe.ts:369-380),
     **plus one `'report'`-kind results artifact** `<probeId>.results.json` — the
     machine-readable per-run table (`{probeId, scenarioId, repeats, durationsMs,
     minMs, medianMs, p95Ms}`), written beside the bundle. `EvidenceArtifactKind`
     already includes `'report'` (src/probe.ts:71) but **no producer writes it yet —
     this probe becomes its first producer**.
   - **`gateResults`: one `GateResult` entry per repeat**, in run order, named
     `'<probeId>#run-<i>'` so each repeat's evidence row is self-naming (documented
     choice; the landed `toGateResult` shape otherwise — per-repeat durationMs,
     output tail, `cleanupFailures` on unproven kills, src/probe.ts:353-367).
   - **Success semantics**: `success` = **every** requested repeat spawned cleanly,
     exited 0, and did not time out. Measurements are recorded **regardless of
     success** (evidence about failures is evidence). `EvidenceBundle.error` names
     the first failing repeat with counts ("run 2/5 exited with code 3", "run 3/5
     timed out after Nms", "run 1/5 could not be spawned: ENOENT"). A repeat whose
     **spawn was refused** produced no run: no `run-<i>` duration for it. A
     benchmark that completes **zero** repeats is `success: false`, **never a pass**
     (AGENTS.md #7 applied to bundles — the T-015 posture,
     docs/tickets/T-015-probe-layer-first-slice.md:57-58).
   - **No threshold field.** The probe carries no assertion/bar input of any kind —
     it records, never judges (decisions.md:19-21). A `success:false` benchmark
     bundle changes nothing downstream: the ladder
     (`src/runner.ts:544` — `passedAllGates = gates.length > 0 && every passed &&
     diffBytes > 0`) is untouched by construction — this ticket edits no runner code.
   - `createProbe` gains the benchmark branch (today binary, src/probe.ts:516-520);
     its docblock comment updates.

2. **`src/scheduler.ts` — one validation surface** (`parseJobsSpec`'s probes map,
   src/scheduler.ts:183-212): the type refusal at :192-194 becomes
   `type must be "command", "test", or "benchmark"`; the allowed probe-field list at
   :186 gains `repeats`; shape validation: `repeats` required positive integer ≥ 1
   on `benchmark` (missing, 0, negative, non-integer, non-number — all refused
   naming the offense), **refused on `command`/`test`** probes. The parsed spec
   carries `repeats` only on benchmark probes.

3. **`scripts/check-probe.mjs` — Gate 1.15 extended in place** (no new gate number;
   no collision with T-016's claimed 1.16,
   docs/tickets/T-016-filesystem-artifact-store.md:157-162, or T-017's claimed 1.17,
   docs/tickets/T-017-machine-worker-adapter.md:66-70):
   - **The mandatory flip (AGENTS.md #8).** Gate 1.15's P2 leg **actively pins
     `type: 'benchmark'` as refused** today (scripts/check-probe.mjs:291-292,
     message `type must be "command" or "test"`). This change-set invalidates that
     assertion, so the flip happens **explicitly in this change-set, never
     silently**: the pin becomes positive coverage (a benchmark probe with
     `repeats` parses and is preserved verbatim) **plus** refusal of a
     genuinely-unknown type (e.g. `'screenshot'`) with the updated message — one
     refusal becomes positive-coverage-plus-refusal, net strictness increases (the
     T-013 flip precedent, docs/tickets/T-013-shard-distillation-core.md:97-109).
     No other existing assertion is weakened.
   - New **P2** legs: `repeats` validation (missing on benchmark; `0`/`-1`/`1.5`/
     `'three'`; present on a `command` probe).
   - New **P3** direct-execution legs (the demo-fixture pattern,
     scripts/check-probe.mjs:310-347): `BenchmarkProbe{node build.js, repeats: 5}` →
     success true; exactly 5 `run-*` duration measurements + min/median/p95;
     **min ≤ median ≤ p95**; each per-run duration equals its GateResult entry's
     durationMs; min/median/p95 recomputed in the check from the recorded durations
     under the documented nearest-rank convention and compared exactly; the results
     artifact is kind `'report'`, sizeBytes > 0, parses, and carries the 5
     durations; the bundle passes `validateEvidenceBundle`. Failure faces: a
     non-zero-exiting command (repeats 3) → success false, `error` names the failing
     run, **all 3 durations still recorded**; a non-existent exe → success false,
     **zero** `run-*` measurements, never a pass. Timeout face (the P4 sleeper
     pattern with its process-table assertions and sweep fallback,
     scripts/check-probe.mjs:414-438): the timing-out repeat → exitCode null,
     durationMs ≥ timeoutMs, the spawned tree verified dead on the real process
     table, kill evidence on that repeat's GateResult entry.
   - **P5** e2e: a `--jobs` drive carrying a benchmark probe asserts the
     `probes[]` ↔ `bundlePath` correspondence for it (bundle on disk,
     validator-clean, success agreeing with the summary) and that survival is
     untouched by the benchmark outcome, extending the existing drive
     (scripts/check-probe.mjs:441-521).

4. **Docs in the same change-set** (AGENTS.md #6): VERIFICATION.md's Gate 1.15
   section (the probe type list at VERIFICATION.md:1000; the carve list at
   :1054-1055 drops benchmark — it moves from carved to pinned, with the new legs
   named); docs/ROADMAP.md:16's stage-4 row; README's `--jobs` probes doc
   (README.md:129-137 — the type list gains `"benchmark"` and `repeats`).

**Does NOT claim:** the screenshot-artifact probe (§34:2069); Godot/Web/Blender
probes (§12.1:911-947); any **measurement→verdict bridge** (perf bars as gates that
read bundles — a Gate-seam question: `Gate.run(cwd)` carries no evidence-path
context and decisions.md:19-21 keeps verdicts gate-only; named here so it is neither
silently assumed nor silently owed — a successor ticket's question); statistical
sophistication (warmup runs, outlier rejection, cross-candidate comparison — each
owns its ticket when wanted); the §13:986-996 project-manifest `probes:` block;
run-level `--probe` CLI flags; and **`probe_runs` persistence** (T-016's claim —
docs/tickets/T-016-filesystem-artifact-store.md:29-32, :82-84, which carves
benchmark probes out to this ticket; clean handoff, no store work duplicated here).

## Why

The spec names the Benchmark Probe twice — §12.1:907-909 (one line, no definition)
and Milestone 4's generic start list (§34:2061-2069, `benchmark probe` at :2068) —
and every landed slice has re-carved it: T-015:93 ("Does NOT claim: benchmark
probe"), T-016:82-84, T-017:40, and docs/ROADMAP.md:16 lists "benchmark/screenshot
probes" as stage-4 remaining. The gap is real and grep-verified (scout, this
session): a grep for `benchmark` over `src/`, `scripts/`, `package.json` returns
exactly two hits, both placeholders — src/probe.ts:65 (the successor-slice docblock)
and scripts/check-probe.mjs:292 (Gate 1.15 actively refusing the type).

The substrate makes this a small additive slice, and the hard part is already
landed: the `Measurement` type with a finite-number validator (src/probe.ts:123-128,
:178-185), the `'report'` artifact kind (src/probe.ts:71), the proven list-form
spawn + verified-tree-kill execution core returning per-execution `durationMs`
(src/probe.ts:277-286, :295-351), validate-then-write bundle emission
(src/probe.ts:244-253), and a **type-agnostic pipeline** — `runProbes` iterates
`job.probes` with no type switch (src/runner.ts:608-619, driven at :554-555) — so
the change-set needs **zero edits to src/runner.ts and src/cli.ts**.

**Honest tension (stated, not smoothed).** "Widens what goals the swarm can
mechanically accept (e.g. performance regression bars)" is only half true: a gate is
already any shell command, exit 0 passes (decisions.md:19-21; src/gate/command.ts),
so a perf bar was **already** mechanically enforceable by a hand-typed gate script.
What is genuinely new is **structured, comparable measurements as evidence** — and
until T-016 lands they are consumerless bundle JSON, and nothing can ever *act* on
them (gates decide survival; the ladder, src/runner.ts:544-555, is gate-only).
Hence Value 3 standalone; sequenced after T-016 it rises toward 4, when timing rows
become addressable `probe_runs` records. The spec defines no percentile convention
(§12.1 defines nothing), so nearest-rank above is the documented choose-and-document
move (the T-007:18-33 / T-012:21-30 precedent) — and the gate, not the docblock
alone, pins it.

## Acceptance criteria

- [ ] `ProbeType` includes `'benchmark'`; `BenchmarkProbe` exists behind the landed
      Probe seam with the documented contract above (required positive-integer
      `repeats` on benchmark and refused elsewhere, per-repeat full timeout budget,
      nearest-rank min/median/p95, the `'report'` results artifact, one GateResult
      per repeat, measurements recorded regardless of success, zero-completed-repeats
      never a pass, **no threshold field**); zero model/harness knowledge in the
      module (decisions.md:11-15) — pinned by **Gate 0** (`tsc --noEmit`) plus the
      **Gate 1.15 P3** contract legs.
- [ ] The parser accepts a benchmark probe with `repeats` verbatim and refuses: a
      genuinely-unknown type with the updated message; missing/zero/negative/
      non-integer/non-number `repeats` on benchmark; `repeats` on a `command`/`test`
      probe — pinned by **Gate 1.15 P2** (contract fixtures over `parseJobsSpec`,
      token-free).
- [ ] **The scripts/check-probe.mjs:291-292 benchmark-refusal pin is explicitly
      flipped** to positive-coverage-plus-genuine-unknown-refusal in this
      change-set — recorded here as the change-set's one intentional invalidation
      of an existing assertion; no other existing check is weakened — pinned by the
      full fast tier, **`npm run verify` ALL GREEN** with the flipped Gate 1.15.
- [ ] Happy path, token-free: `BenchmarkProbe{node build.js, repeats: 5}` on a fresh
      demo-target fixture yields success true; exactly 5 `run-<i> duration`
      measurements + `min`/`median`/`p95` (unit `'ms'`); min ≤ median ≤ p95; the
      summaries exactly equal the nearest-rank recomputation over the recorded
      durations; each per-run duration equals its GateResult entry's durationMs; a
      `'report'`-kind results artifact with sizeBytes > 0 carrying the 5 durations;
      the bundle passes `validateEvidenceBundle` — pinned by **Gate 1.15 P3**.
- [ ] Failure faces: non-zero exit (repeats 3) → success false with the failing run
      named in `error` and all 3 durations recorded; non-existent exe → success
      false with zero `run-*` measurements, never a pass; a timing-out repeat →
      exitCode null, durationMs ≥ timeoutMs, the spawned tree verified dead on the
      real process table, kill evidence on that repeat's GateResult entry — pinned
      by **Gate 1.15 P3** (timeout leg per the P4 process-table pattern).
- [ ] Evidence emission in a real pipeline: a `--jobs` run carrying a benchmark
      probe writes its bundle under `<artifactsDir>/probes/<candidateId>/`, the
      report's `probes[]` names its `bundlePath` and agrees with the bundle
      (probeId/scenarioId/success), and survival is untouched by the benchmark
      outcome (a passing-gates/failing-benchmark job still passes) — pinned by
      **Gate 1.15 P5** (the fake-WorkerAdapter `runSkeleton` drive).
- [ ] Zero runner/CLI/report-shape drift: no `src/runner.ts` or `src/cli.ts` edits
      (the pipeline is type-agnostic, src/runner.ts:554-555, :608-619);
      `CandidateReport.probes`/`ProbeRunSummary` shapes unchanged (src/types.ts:
      279-285); the verdict ladder byte-identical (src/runner.ts:544) — pinned by
      **Gate 0** plus the change-set file list (`git status --porcelain` /
      `git diff --stat`: exactly `src/probe.ts`, `src/scheduler.ts`,
      `scripts/check-probe.mjs`, `VERIFICATION.md`, `docs/ROADMAP.md`, `README.md`,
      the ticket file + index).
- [ ] No new npm dependencies (decisions.md:6-10); every repeat is a list-form spawn
      through `executeProbeCommand` (never `exec`, never a second spawn path) —
      pinned by **Gate 0** and the package.json/package-lock.json diff-free
      change-set.
- [ ] Docs extended in the same change-set: VERIFICATION.md's Gate 1.15 section
      (type list :1000, carve list :1054-1055, new legs), docs/ROADMAP.md:16's
      stage-4 row, README's `--jobs` probes doc (README.md:129-137) — pinned by
      **`npm run verify` ALL GREEN** with the updated sections present.
- [ ] **Gate 2 NOT owed — recorded, not silently skipped** (the T-012:327-335
      trigger-analysis precedent): the change-set touches no `src/runner.ts`, no
      adapter, no gate code, no workspace handling, and no report shape — none of
      VERIFICATION.md:1097-1098's triggers; Gate 2 is additionally a `--goal`-mode
      run that executes no probe code (VERIFICATION.md:1008-1010), so it could not
      pin any benchmark criterion anyway. **Gate 3 n/a** (no adapter touched).

## Verification

**Gate 0** (typecheck) throughout; **Gate 1.15 extended in place** — this ticket
claims **no new gate number** (no collision with T-016's claimed 1.16 or T-017's
claimed 1.17) and extends the probe gate's existing legs: P2 parser legs (the
:291-292 flip + `repeats` validation), P3 direct-execution benchmark legs
(happy/failure/timeout with the measurement invariants), P5 e2e correspondence leg;
the whole existing fast tier stays green (`npm run verify`) — the one flipped
assertion is named in the criteria, nothing else weakened. Gate 1 (fixture
regeneration) untouched and green inside the tier. **Gate 2 not owed** per the
recorded trigger analysis above; **Gate 3 n/a** (no adapter).

Baseline at HEAD 8d4e1e2 (clean tree): `npm run typecheck` → exit 0 (re-run by this
session's ticket writer); `node scripts/verify.mjs fast` → "verify (fast) complete:
ALL GREEN", exit 0, including Gate 1.15 "check-probe: ALL GREEN" (scout's run at the
same HEAD — the baseline the flips above modify).

## References

docs/spec/inference-refinery-v2.md §12.1:907-909 (Benchmark Probe — one line, no
definition), §12:879-967 (Probe seam + output contract), §34:2061-2069 (Milestone 4
start list; `benchmark probe` at :2068) · docs/tickets/T-015-probe-layer-first-slice.md:93
(the carve this fills), :57-58 (AGENTS #7 applied to bundles) ·
docs/tickets/T-016-filesystem-artifact-store.md:29-32, :82-84, :157-162 (`probe_runs`
ownership, the consumers carve, the Gate 1.16 claim) ·
docs/tickets/T-017-machine-worker-adapter.md:40 (re-carve), :66-70 (Gate 1.17 claim) ·
docs/tickets/T-013-shard-distillation-core.md:97-109 (the explicit-flip precedent) ·
docs/decisions.md:6-10 (zero-new-deps), :11-15 (harness-agnostic seams), :19-21
(gates decide survival), :25-26 (run root C:\swarm) · docs/ROADMAP.md:16 ·
src/probe.ts:64-66, :71, :76-84, :123-128, :146, :178-185, :244-253, :277-286,
:295-351, :353-367, :369-380, :516-520 · src/scheduler.ts:186, :192-194 ·
src/runner.ts:544-555, :608-619 · src/types.ts:279-285 ·
scripts/check-probe.mjs:291-292, :310-347, :414-438, :441-521 ·
VERIFICATION.md:977-1071 (Gate 1.15; type list :1000, carve :1054-1055), :1008-1010
(Gate 2 exercises no probe code), :1097-1098 (Gate 2 triggers) · README.md:129-137.
