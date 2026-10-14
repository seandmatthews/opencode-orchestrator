# T-006 — Job DAG: phase/job tables, DAG validation, and a `dag` dump CLI

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** T-003

## What

Second slice of the stage-1 durable control plane (spec §34 Milestone 1's "job DAG"
build item): extend the T-003 store with `phases` and `jobs` (+ `job_dependencies`)
tables, have `ingest` derive each run's actual DAG from the `RunReport` it already
receives, add pure DAG validators, and expose a read-only CLI dump — **zero behavior
change to the pipeline**.

- **`src/store/index.ts` — additive schema, `SCHEMA_VERSION` 1 → 2.** Three new
  tables from spec §27's initial-table list, created with `CREATE TABLE IF NOT
  EXISTS` so an existing `refinery.db` (T-003's) gains them on the next ingest.
  No migration machinery, no backfill: old runs gain DAG rows only when
  re-ingested, which appends a new event block by design (Gate 1.6 re-ingest
  semantics, VERIFICATION.md:158-159). Shape narrowed from §6.3/§6.4 to what has
  a producer:
  - `phases (run_id, phase_id, dependencies_json, completion, early_stop_json,
    approval_gate_json)` — PK `(run_id, phase_id)`;
  - `jobs (run_id, job_id, phase_id, worker_id, model, brief, dependencies_json,
    role_json, workspace_json, permissions_json, prompt_json, context_plan_json,
    input_artifacts_json, expected_outputs_json, retry_policy_json,
    timeout_policy_json, gate_policy_json)` — PK `(run_id, job_id)`. Populated
    fields only: `job_id` = the candidate id, `phase_id` = the run's single
    phase, `worker_id`/`model`/`brief` copied as strings out of `CandidateReport`
    (`src/types.ts:103-121`) — model IDs remain CLI/config-shaped strings the
    store knows nothing about (decisions.md: engine is model/harness-agnostic,
    same posture as `src/store/index.ts:7-8`);
  - `job_dependencies (run_id, job_id, depends_on_job_id)` — PK on all three.
  Every §6.3/§6.4 policy column (`completion`, `earlyStop`, `approvalGate`,
  `workspace`, `permissions`, `retryPolicy`, `timeoutPolicy`, `gatePolicy`, …)
  is **nullable and written null this slice**: `RunReport`/`CandidateReport`
  carry none of those fields (`src/types.ts:123-133`), so there is no producer —
  stated honestly, not smoothed over.
- **Ingest derives the run's actual DAG** — a pure function of the report, like
  the rest of `ingest`: exactly one phase per run (`phase_id = 'main'`,
  dependencies `[]`), one job per candidate with empty dependencies, zero edge
  rows. New state tables upsert by natural key inside the same transaction;
  `job_dependencies` is re-derived (delete + insert) so re-ingest stays
  idempotent; `events` stays append-only.
- **Pure validators**, exported from the store module, no I/O, no model
  involvement: cycle detection via topological sort (refusal names the cycle)
  and an unknown-reference check (a dependency naming a job id not in the set).
  `ingest` runs them on the derived DAG — acyclic by construction today; the
  interesting inputs are synthetic and live in the gate.
- **`src/dag.ts` — read-only dump**, the house standalone-entry pattern
  (`tsx src/dag.ts`, like `src/clean.ts`/`src/integrate.ts`):
  `npm run dag -- --run <runId> [--db <path>] [--json]`. Prints the run's
  phases, jobs, and dependency edges; `--json` emits the same structure as JSON
  (what a future scheduler/dashboard would consume). `--db` defaults to
  `C:\swarm\refinery.db` — same literal as `src/cli.ts:80`, per decisions.md
  (run root is `C:\swarm\`). Refusals exit non-zero **before any DAG body is
  printed** (the T-005 refusal pattern): missing `--run`, missing DB file (a
  dump must never create an empty `refinery.db` as a side effect), a runId with
  no rows. The dump never writes: the DB opens read-only (`node:sqlite`'s
  readOnly open option), and the gate proves the file byte-identical afterward.
- **`package.json`: one new script** `"dag": "tsx src/dag.ts"`. Zero new
  dependencies — `node:sqlite` only (decisions.md: TypeScript on Node 22;
  the named fallback `better-sqlite3` would need its own decisions entry,
  VERIFICATION.md Known issues #7).
- **VERIFICATION.md** gains the extended Gate 1.6 assertions and a new Gate 1.7
  section in the same change-set (AGENTS.md #6).

**Does NOT claim:** no `attempts`/`approval_gates` tables and no retries — the
remaining Milestone-1 slices (spec §27's full list, §34's build list); no live
in-run event emission incl. `JOB_READY` (spec §28:1852 — that touches
`src/runner.ts`, a behavior change; T-003:59-60 carved it for the same reason);
no change to `src/runner.ts`, adapters, gate code, workspace handling, or the
`RunReport` shape — the DAG is derived inside `ingest`, and the runner's call
shape (`ingest(report, dbPath)`, `src/cli.ts:205`) is untouched; no user-facing
job-spec/workflow file format (spec §13 "Project Manifest", :971 — no consumer
until a scheduler exists); no completion/earlyStop/approvalGate enforcement and
no scheduler; no interactive DAG view (spec §26.2:1703-1715 is Milestone-7 UI —
this CLI dump is the token-free precursor); no store-backed integrate
(T-005:108-111's own carve). Validation and the dump are inspection of recorded
structure and never influence verdicts (decisions.md: machine gates decide
survival; `src/store/index.ts:11`; the log-and-continue posture at
`src/cli.ts:202-208` is unchanged).

## Why

`docs/ROADMAP.md:12` maps stage 1 to "remaining: job DAG, attempts, retries,
approvals, scheduler" — job DAG is the repo's own named next item and the
designated successor slice: `src/store/index.ts:19-20` ("Later stage-1 slices
add jobs/attempts/approval_gates/phases, spec §27's full list") and T-003's
Does-NOT-claim (`docs/tickets/T-003-durable-run-records.md:61-62`) reserve
exactly this. Spec basis: §6.3 Phase (`docs/spec/inference-refinery-v2.md:320-341`),
§6.4 Job (`:343-368`), §27 initial tables including `phases`/`jobs`/
`job_dependencies` (`:1807-1838`), §28's event vocabulary (`:1848-1864`), §34
Milestone 1's build list (`:2017-2028`). Every later stage-1 capability —
attempts, retries, approvals, the scheduler — reads this structure, so it is
foundation; and since nothing consumes job rows until a scheduler exists, the
immediate payoff is inspectability: a run's dependency structure becomes
dumpable before any scheduler or UI exists.

**Honest tension, stated rather than smoothed:** the pipeline is a flat fan-out
with no phase/job domain objects — `src/runner.ts:45-91` plans then runs N
parallel candidates with no dependencies, and the report types carry no
phase/job or policy fields (`src/types.ts:103-133`). There is NO producer of
non-trivial DAG data today: the derived DAG is one phase + N dependency-free
jobs; cycle detection and unknown-ref validation are only exercisable on
synthetic specs inside the gate (the Gate 0.5 hand-built-input precedent,
`scripts/check-parse.mjs`); and §6.4's policy columns stay null until a
scheduler or a job-spec manifest (spec §13) exists. This slice lands the shape,
the derivation, and the validation so later slices populate it — it does not
pretend today's graph is interesting.

This is also the **first DB readback in the repo**: T-003:63 — "nothing in the
pipeline reads the DB back". The dump is post-hoc inspection of what ingest
already recorded; it never feeds verdicts, keeping the gates-decide rule intact.

## Acceptance criteria

- [ ] Ingest of the vendored fixture (`scripts/fixtures/report-real.json`)
      produces `phases`/`jobs` rows matching the report's real fan-out — exactly
      one phase, one job per candidate with `job_id` = candidate id and empty
      dependencies, zero `job_dependencies` rows, policy columns null — pinned
      by the **extended Gate 1.6** (`scripts/check-store.mjs`).
- [ ] Re-ingest semantics extend to the new tables: a second ingest leaves
      `phases`/`jobs`/`job_dependencies` idempotent (natural-key upsert, edges
      re-derived) while prior `events` rows are untouched, and
      `PRAGMA integrity_check` returns `ok` — pinned by the **extended Gate
      1.6**.
- [ ] The pure validators refuse — non-zero result with a clear message naming
      the offense — a synthetic cyclic dependency set (topological-sort cycle
      detection) and a synthetic unknown-dependency reference, and accept the
      derived flat DAG — pinned by the **extended Gate 1.6** on hand-built
      inputs (Gate 0.5's pattern: no pipeline, no model tokens).
- [ ] `npm run dag -- --run <runId>` against a DB ingested with the fixture
      exits 0 and prints the run's phases, jobs, and dependency edges; `--json`
      emits the same structure as JSON — pinned by the **new Gate 1.7**
      (`scripts/check-dag.mjs` + new VERIFICATION.md section + hook in
      `scripts/verify.mjs` after Gate 1.6 — the T-003 slice-owns-its-gate
      precedent).
- [ ] Refusals exit non-zero and print no DAG body: unknown runId, missing DB
      file (and the dump must not create an empty DB as a side effect), missing
      `--run` — pinned by **Gate 1.7**.
- [ ] The dump never writes: the DB file is byte-identical after a dump (hash
      before/after) — pinned by **Gate 1.7**.
- [ ] No behavior change to the pipeline: `src/runner.ts`, adapters, gate code,
      workspace handling, and the `RunReport` shape are untouched, and
      `npm run verify` (Gates 0 / 1 / 0.5 / 1.5 / 1.6) stays ALL GREEN, proving
      clean/lock/integrate semantics unaffected — pinned by **`npm run verify`**.
      Gate 1.6 is green before this change (verified 2026-10-14:
      `node node_modules/tsx/dist/cli.mjs scripts/check-store.mjs` →
      "check-store: ALL GREEN", exit 0, only the documented node:sqlite
      ExperimentalWarning on stderr — Known issues #7) and must stay green after.
- [ ] VERIFICATION.md carries the extended Gate 1.6 + new Gate 1.7 sections, and
      the ticket status + index row move in the same change-set (AGENTS.md #6;
      tickets README rules).

## Verification

Gate 0 (`npm run typecheck` — green before this change, verified 2026-10-14,
exit 0) always; Gate 1 (`npm run demo`) sanity, token-free; Gate 0.5 n/a
(`src/parse.ts` untouched); the **extended Gate 1.6** and the **new Gate 1.7**
via `npm run verify` (not yet run for this ticket — no code exists). **Gate 2 is
not required and not run**: the slice touches none of VERIFICATION.md:200-201's
triggers (no `src/runner.ts`, no adapter, no gate code, no workspace handling,
no report-shape change — everything lives in `src/store/index.ts` + the new
`src/dag.ts`) — stated here so it is neither silently skipped nor silently owed;
any successor that changes report shape or the runner's ingest call shape owns a
Gate 2 run. Gate 3 n/a (no adapter, zero model involvement).

## References

spec §6.3 (`docs/spec/inference-refinery-v2.md:320-341`), §6.4 (`:343-368`),
§13 (`:971`), §26.2 (`:1703-1715`), §27 (`:1805-1838`), §28 (`:1844-1864`),
§34 (`:2017-2028`) · T-003 — predecessor store slice; its Does-NOT-claim
(`:61-63`) reserves this work · T-005:108-111 — store-backed integrate carve ·
`docs/decisions.md` (2026-10-10: Node 22 / harness-agnostic / gates decide /
`C:\swarm\` run root).
