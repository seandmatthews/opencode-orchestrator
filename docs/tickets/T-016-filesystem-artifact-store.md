# T-016 — Filesystem artifact store: artifacts + probe_runs records, hash-at-ingest, re-verification (spec §34:2028)

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** — (builds on landed slices: T-003/T-006/T-007/T-008 store, T-015 probe summaries)

## What

The spec's last unclaimed Milestone-1 build item (§34:2028 "filesystem artifact store"),
as one store-only slice. Run evidence lives today by convention as loose files under
`C:\swarm\<runId>\`; the store records none of it as artifacts. This slice gives the
evidence files a finished `RunReport` names recorded handles in SQLite, so reports,
diffs, logs, and probe bundles become addressable rows — with content hashes and sizes
computed **at ingest** — and re-verifiable against the files on disk.

1. **Schema v4 → v5 in `src/store/index.ts`** (the additive T-006/T-007/T-008 pattern:
   everything `CREATE TABLE IF NOT EXISTS`, no migration machinery — an existing v4
   `refinery.db` gains the tables on its next use; `SCHEMA_VERSION` bumps to 5 and the
   pinned assertion moves per `scripts/check-store.mjs:86-88`'s own rule):
   - `artifacts` (spec §6.8:448-468 narrowed to producers): `run_id`, `artifact_id`,
     `kind`, `job_id` nullable, `attempt_number` nullable, `path`, `size_bytes`
     nullable, `content_hash` nullable — PK `(run_id, artifact_id)`. The §6.8
     `producerAttemptId` narrows to the `(job_id, attempt_number)` pair (the T-007
     attempts PK; probes attach to the final attempt, `src/types.ts:244-249`).
     Columns without a producer are **omitted, not pre-defined** (the documented-
     narrowing precedent, T-006's policy columns): `media_type`, `lineage`,
     `metadata`, `retention_class` — stated honestly, not smoothed over.
   - `probe_runs` (§27:1831 narrowed to the summary a report carries):
     `run_id`, `job_id`, `probe_id`, `scenario_id`, `success`, `duration_ms`,
     `bundle_path` — PK `(run_id, job_id, probe_id)`, field-for-field the
     `ProbeRunSummary` shape (`src/types.ts:279-285`, landed by T-015).
2. **Ingest derivation, report-named paths only.** One `artifacts` row per evidence
   path the finished `RunReport` itself names — never path guessing:
   - `report.json` (recovered via the existing `reportPathOf` heuristic,
     `src/store/index.ts:989-1000`, promoted into the derivation; written
     `src/runner.ts:214`),
   - `planner.rawOutputPath` (`src/types.ts:208`; written `src/runner.ts:264,291`),
   - per candidate: `diffPath` (`src/types.ts:240-241`; written `src/runner.ts:482`),
     every path in `attempts[].outputArtifacts` (`src/types.ts:196`; `worker.log`
     pushed at `src/runner.ts:422`, `diffPath` appended at `:483`), `review.rawOutputPath`
     (`src/types.ts:226`; written `src/runner.ts:337`), and `probes[].bundlePath`
     (`src/types.ts:266,284`; written validated-only, `src/probe.ts:244-253`).
   Files the report does not name (`dispatch.jsonl`, `planner.log`, `review.json`,
   probe `.log` artifacts living inside bundles, `src/probe.ts:369-380`) get **no row**
   this slice; a path named twice (e.g. `diffPath` also in `outputArtifacts`) yields
   **one** deduplicated row. `artifact_id` is a deterministic function of
   `(candidateId, attempt, path)` — stable across re-ingest, exact scheme pinned by
   Gate 1.6.
3. **Hash-at-ingest — the documented bounded deviation.** At ingest, each derived
   path is `stat`-ed and sha256-hashed (read-only over evidence); `size_bytes` /
   `content_hash` record what was measured. A missing file records **NULL** in both —
   never fabricated (AGENTS.md #7; the diffBytes-null precedent,
   `VERIFICATION.md:519-521`). This deviates from "ingest is a pure function of the
   report" (`src/store/index.ts:9-11`) by adding a **read** of the named evidence
   files; it is documented in the module header as the third scoping case in the
   T-008/T-010 wall-clock-scoping style: ingest is deterministic as a function of
   *(report, the evidence files it names)*, reads evidence but never writes it, and
   the wall clock still never enters any stamp. The alternative — recording hashes in
   the report at capture time — is a report-shape change touching `src/runner.ts`
   that owns its own Gate 2 run; it is explicitly **not** this ticket.
4. **`ARTIFACT_CREATED` events (§28:1854), post-hoc.** Ingest-derived, one per
   `artifacts` row, appended after the existing derived blocks; every `at` is a pure
   function of the report's own stamps (candidate finish-stamp derivation shared with
   the schedule events, `src/store/index.ts:852-879`; run-level artifacts at
   `finishedAt`) — never `Date.now()`. Re-ingest leaves all state rows idempotent
   (upsert; hash columns recompute from the files, which are immutable-by-convention)
   while `events` appends a fresh deterministic block (`scripts/check-store.mjs:121-123`
   pattern).
5. **Re-verification primitive (the §29:1877 face).** An exported function in
   `src/store/index.ts` that re-hashes a run's recorded artifacts against the files on
   disk and reports `verified` / `mutated` (hash mismatch) / `missing` (file gone) /
   `unverified` (row was recorded null). This is the substrate a later recovery slice
   integrates into `npm run recover`; **no CLI this slice** — if the implementer adds
   any readback entry point anyway, its `--db`/`--run-root` defaults are the
   `C:\swarm` literals of `src/cli.ts:103-105` (the T-006/T-008 precedent).

**Does NOT claim:** `artifact_lineage` / `context_plans` / `context_packets` tables
(§27:1825-1827 — need pipeline producers; the T-012:139-141 successor reservation);
§7.4:565-578 real `artifact:<id>#<anchor>` resolution (stays carved,
`VERIFICATION.md:964-966`); §29:1877 step-6 **integration into `recover`** (this slice
only makes hashes exist and checkable); retention classes / worktree-GC linkage
(stage 3, ROADMAP.md:15); benchmark/screenshot probes (T-015's carve — they are
*consumers* of this substrate, not part of it); probe bundle-internal `.log`
enumeration (the bundle stays the addressable unit); any report-shape change; any
change to gate verdicts — artifact rows and `ARTIFACT_CREATED` events are recorded
evidence that must never enter promotion or elimination (decisions.md 2026-10-10:
gates decide survival; the store's own posture, `src/store/index.ts:12`).

## Why

The spec puts "filesystem artifact store" in Milestone 1's build list (§34:2028), and
`docs/ROADMAP.md:12` names it explicitly unticketed while `:16` lists "artifact store +
`probe_runs`" as stage-4 remaining. The gap is real and measured (scout-verified, and
re-verified line-by-line this session): run evidence is written by convention —
`report.json` once at `src/runner.ts:214`, `worker.log`/`diff.patch` per attempt at
`:411-412`/`:482`, review raw + `review.json` at `:337`/`:345`, `planner-raw.txt` at
`:264,291`, probe bundles validated-then-written at `src/probe.ts:244-253` — but the
store records none of it: a grep for `ARTIFACT_CREATED|probe_runs|artifact_lineage`
over `src/` and `scripts/` returns zero hits (run this session, exit 1), and
materializing `SCHEMA_SQL` (`src/store/index.ts:52-158`) yields exactly 9 tables at
`SCHEMA_VERSION = 4` (`:38`). The only artifact linkage today is `runs.report_path`
recovered heuristically from the report's own paths (`:989-1000`) and
`attempts.output_artifacts_json` path strings (`:832`). Gate results are already
addressable store rows (PK `(run_id, candidate_id, gate_name)`, `:79-88`) — what is
missing for gates is evidence-file handling, not verdicts.

Three landed tickets are explicitly waiting on this substrate: T-015's Does-NOT-claim
(`docs/tickets/T-015-probe-layer-first-slice.md:93-97`) names it the blocker for
§27:1831 `probe_runs` / §28:1854 `ARTIFACT_CREATED`; T-012:139-141 (and the T-013/T-014
carves) reserve the context store tables behind it; T-010 (`:154-155`) carved §29:1877
"validate artifact files/hashes" — which needs recorded hashes to validate. Probes are
cheaply producible end-to-end today (Gate 1.15's P5 leg, `VERIFICATION.md:1042-1052`),
so the rows have real producers immediately.

**The honest tension, stated not smoothed:** hashing at ingest adds a disk read to a
function that is today pure over the report (`src/store/index.ts:9-11`), pinned by
Gate 1.6's byte-identical assertion (`VERIFICATION.md:212-213`). This ticket takes
that deviation deliberately, bounded and documented (read-only, nullable-on-missing,
no wall clock), because the alternative route — hashes captured into the report —
changes the report shape, touches `src/runner.ts`, and owns a Gate 2 run. Gate 1.6's
read-only-over-evidence pin continues to bind either way.

Pre-change state, run this session: Gate 0 `npm run typecheck` → exit 0; Gate 1.6
`node node_modules/tsx/dist/cli.mjs scripts/check-store.mjs` → `check-store: ALL GREEN`,
exit 0 (only the documented node:sqlite ExperimentalWarning).

## Acceptance criteria

- [ ] `SCHEMA_VERSION` is 5 and a fresh ingest materializes exactly 11 tables (the
      prior 9 + `artifacts` + `probe_runs`); an existing v4 `refinery.db` gains both on
      next use with no migration machinery — pinned by the moved schema assertion and a
      table census in extended Gate 1.6 (`scripts/check-store.mjs:88` moves in this
      change-set, per its own comment).
- [ ] Extended Gate 1.6, main fixture: ingesting `scripts/fixtures/report-real.json`
      derives one `artifacts` row per report-named path with exact deterministic counts
      (planner raw; per candidate: diff + deduped `outputArtifacts` + review raw when
      present; `report.json` itself), paths verbatim; **zero `probe_runs` rows** (the
      fixture predates probes, `VERIFICATION.md:160-161`); no `media_type`/`lineage`/
      `retention_class` columns exist.
- [ ] Extended Gate 1.6, probes variant (the elim-variant pattern,
      `scripts/check-store.mjs:132-143`): a hand-built fixture carrying `probes[]` with
      sandbox-local bundle files derives one `probe_runs` row per summary
      (run_id/job_id/probe_id/scenario_id/success/duration_ms/bundle_path verbatim,
      `src/types.ts:279-285`) plus a matching probe-bundle `artifacts` row.
- [ ] Hash-at-ingest pinned by extended Gate 1.6 sandbox variant: `size_bytes`/
      `content_hash` equal the `stat`/sha256 of controlled file content; a report-named
      path with no file on disk records NULL for both (never fabricated); the source
      fixture is byte-identical after ingestion (read-only over evidence — the
      `VERIFICATION.md:212-213` pin holds even while hashing). Exact hash values are
      pinned **only** on sandbox variants (the main fixture's real run-dir files may or
      may not exist on a given machine).
- [ ] `ARTIFACT_CREATED` events: extended Gate 1.6 asserts the post-hoc block (one per
      artifacts row) with every `at` derived from report stamps — never `Date.now()` —
      and re-ingest leaves state idempotent while events append a fresh deterministic
      block; `PRAGMA integrity_check` returns `ok`.
- [ ] **New Gate 1.16** (tamper-evidence, fast tier, hooked into `scripts/verify.mjs`
      before the fast-tier finish): against a sandbox run — re-verification of intact
      files reports all `verified`; flipping one file's bytes is detected as `mutated`;
      deleting one reports `missing`; a null-hash row reports `unverified`, not
      `mutated`. No existing gate pins this (Gate 1.15 pins bundle writing, not store
      persistence, `VERIFICATION.md:1042-1052`; Gate 2 spends model tokens).
- [ ] Gate 1.5 stays green structurally — DB rows do not affect clean, and the artifact
      *files* under run dirs are already evidence-preserved
      (`VERIFICATION.md:217-220`).
- [ ] Gate 0 green (`tsc --noEmit`) over the changed `src/store/index.ts` and scripts.
- [ ] Gate 2 **not owed**, recorded here: the change-set touches only
      `src/store/index.ts`, `scripts/check-store.mjs`, the new Gate 1.16 script, the
      `scripts/verify.mjs` hook, `VERIFICATION.md`, and docs — no `src/runner.ts`, no
      adapter, no gate code, no workspace handling, no report-shape change (the
      T-006/T-008 trigger analysis). Recording hashes at capture time instead would be
      a different ticket owing its own Gate 2 run.
- [ ] `VERIFICATION.md` extended in the same change-set: the Gate 1.6 additions, the
      new Gate 1.16 section, the schema-v5 statements, and the carve sentence at
      `VERIFICATION.md:964-966` updated to reflect that `artifacts`/`probe_runs` landed
      (anchor resolution and the context tables stay carved).

## Verification

Gate 0; extended Gate 1.6 (fast tier); new Gate 1.16 (fast tier, added here, wired into
`npm run verify`); Gate 1 and Gate 1.5 structurally; Gate 2 not owed per the trigger
analysis above; Gate 3 n/a (no adapter — artifacts know paths/kinds/hashes, never
harness specifics, per decisions.md 2026-10-10).

## References

`docs/spec/inference-refinery-v2.md` §6.8:448-468 (Artifact type), §27:1824/:1831
(`artifacts`/`probe_runs`), §28:1854 (`ARTIFACT_CREATED`), §29:1877 (validate artifact
files/hashes), §7.4:565-578 (anchor refs — downstream), §34:2028 (this build item) ·
`docs/tickets/T-015-probe-layer-first-slice.md:93-97` (the named successor carve) ·
`docs/tickets/T-012-context-system-core.md:139-141` ·
`docs/tickets/T-010-startup-reconciliation.md:154-155` · `docs/ROADMAP.md:12,16`.
