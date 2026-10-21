# T-035 — Dashboard slice two: per-job drill-down pages over the recorded store

**Status:** proposed
**Category:** ops
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** T-034

## What

Extend the landed T-034 dashboard (`src/dashboard.ts`) with one new read
route: `GET /run/<id>/job/<jobId>` — a per-job page whose every value is a
direct SELECT on existing schema-v5 store tables, opened `{ readOnly: true }`
(the src/dashboard.ts:562-564 pattern). Nothing is recomputed, nothing is
served from report.json, and no page produces or influences a verdict
(decisions.md 2026-10-10: gates decide survival — the page renders recorded
verdicts and produces none).

The page renders, per job:

- the `jobs` row: phase, worker, model, brief, expanded dependencies
  (schema src/store/index.ts:148-167);
- the verdict: the `candidates.passed_all_gates` row — `job_id` IS the
  candidate id in the derived DAG (VERIFICATION.md:313-319) — rendered as
  survivor/eliminated, equal to the machine verdict;
- the job's `gate_results` rows (PK `run_id`/`candidate_id`/`gate_name`,
  src/store/index.ts:122-131): gate name, pass/FAIL, exit code, duration,
  output tail — NULLs render as "missing", never fabricated (AGENTS.md #7);
- the job's attempt history from `attempts` (PK `run_id`/`job_id`/
  `attempt_number`, src/store/index.ts:174-188): one row per attempt with
  state, started_at/ended_at, input_context_hash, prompt_version, and
  output_artifacts_json/failure_json as recorded; producer-less columns
  (`process_identity_json`, `worker_session_id`) render as missing;
- the job's `probe_runs` rows (PK `run_id`/`job_id`/`probe_id`,
  src/store/index.ts:212-221): probe, scenario, outcome, duration,
  bundle_path.

Plus the never-dispatched face: a job recorded with empty worker/model/brief
and NO candidate row (VERIFICATION.md:363-366) renders as never-dispatched —
no verdict, no gates, no attempts, nothing fabricated (AGENTS.md #7). An id
with no `jobs` row at all is a 404 carrying the refusal message (the
src/dashboard.ts:447-449 notFound pattern).

Navigation: each job id in the run page's DAG job list (rendered today at
src/dashboard.ts:246-247) becomes a plain `<a href>` link to its drill-down
page. No client-side JS — the T-034 zero-JS posture (stdlib string
templates) holds; the usage/help text (src/dashboard.ts:54-75) gains the new
route line.

Constraints carried over from T-034 unchanged: zero new npm dependencies
(`node:http` + `node:sqlite` reads only); binds 127.0.0.1 only;
`--db` keeps the shared `C:\swarm\refinery.db` default (src/dashboard.ts:52);
`POST /approvals/decide` remains the ONLY write; no engine file touched —
the engine stays harness-agnostic (decisions.md 2026-10-10).

What this ticket does NOT claim — the carve list, stated not smoothed:

1. **The §26.4:1744-1764 context-inspector page is carved OFF, and BLOCKED
   on a producer.** The idea's premise — "the context system already writes
   ContextPlan/Packet records" — is false (evidence in Why). Persisting
   ContextPlan/Packet into the store (the reserved `jobs.context_plan_json`
   column or a report block) is an engine/report-shape change owning its own
   Gate 2; the inspector page is that producer ticket's consumer successor,
   not this ticket.
2. **Dispatch order and phase/job-status rendering stay carved** (T-034's
   carve, src/dashboard.ts:26-27, VERIFICATION.md:2725): `dispatchIndex` and
   `PhaseStatus` live only in report.json's schedule block
   (src/types.ts:361-362, :344, :368-371), not the store. A small later
   ticket may render them, honestly labeled as report.json reads (via
   `runs.report_path`); this one does not.
3. §26.2's interactive graph JS (this drill-down is the store-backed
   text/table, no-JS slice of §26.2's node-click list; the T-006 `dag` CLI
   stays the §26.2 precursor, T-006:78), §26.3 candidate comparison, §26.5
   artifact contents, §26.7/§26.8 — T-034's carve list stands
   (VERIFICATION.md:2718-2727). Per-job artifact *filtering* is not claimed
   either: the run page keeps its full artifacts table.

## Why

The store already answers "why did c02 fail, and what did it try?" — but no
surface renders it. The live store holds 32 `attempts` rows and 76
`gate_results` rows across 17 ingested runs (read-only query against
`C:\swarm\refinery.db`, run this session), yet `renderRun`
(src/dashboard.ts:266-407) reads runs/candidates/gate_results/artifacts/
probe_runs/phases/jobs/job_dependencies and never the `attempts` table —
attempt history is rendered by NO surface, so an operator must open the DB
by hand. This is operator ergonomics only (the T-034 precedent): no engine
capability is unblocked.

The idea's context-inspector half does not survive premise checks — each
verified by reading/querying this session:

- `jobs.context_plan_json` is defined (src/store/index.ts:160) but the
  ingest upsert binds it literal null among the nine §6.4 policy columns
  (src/store/index.ts:1201-1210; comment :1175-1176: "Every §6.4 policy
  column stays null — no producer"). Live-store query: 0 `jobs` rows carry a
  non-null value. The only writer of plan/packet JSON anywhere is the gate
  sandbox (scripts/check-context.mjs:281-282); the composer is pure and
  writes nothing (src/rounds.ts:156-158); the run writes only the rendered
  block (src/runner.ts:227-228); the only context state recorded per run is
  `RoundRecord.packetFingerprint` + `renderedBlockPath` (src/types.ts:404-408),
  report.json-only. T-014's lineage chains live inside packets
  (src/context-inspect.ts:413-414) and are never persisted by a run either.
  §26.4 has literally nothing store-backed to render; T-012:149's carve
  ("no §26.4 UI — the CLI is the token-free precursor") stands for a sharper
  reason than the idea assumed: no producer, not merely no page.
- "Dispatch order from the store's DAG tables" is likewise false: the full
  schema (src/store/index.ts:95-222) carries no dispatch-index or job-status
  column; derived `JOB_READY` events carry payload `{jobId, phaseId}` only,
  emitted in schedule order (src/store/index.ts:1299, loop :1287-1304).

Adjacent, not touched: the multi-generation deferral (decisions.md
2026-10-20, T-033) concerns candidate lineage/generations. T-014's packet
source lineage is context-claim lineage, not candidate lineage; this ticket
creates no lineage record, so that deferral and its re-entry condition (c)
stand untouched.

## Acceptance criteria

- [ ] `GET /run/<id>/job/<jobId>` renders the job row, the
      `candidates.passed_all_gates` verdict, the job's `gate_results` rows,
      its full `attempts` history, and its `probe_runs` rows, each equal to
      a direct SELECT on the same temp DB, with NULLs rendered as "missing"
      — pinned on the flat fixture AND a retried-attempts variant (the
      elim-variant pattern; Gate 1.6's retried variant already builds
      `attempts` rows) AND the probes variant. Note: the live store
      currently holds 0 `probe_runs` rows, so the probe face is pinned only
      on the hand-built variant. (extended Gate 1.23)
- [ ] The hand-built schedule variant (two real phases foundation→app with
      the expanded edge c02→c01 — the check-store construction, the Gate
      1.6/1.23 pattern at VERIFICATION.md:2672-2674) renders per-job pages
      consistent with the store rows. The gate must keep exercising this
      hand-built variant: no scheduled `--jobs` run has ever been ingested —
      every `phases` row in the live `C:\swarm\refinery.db` is the flat
      'main' derivation (queried this session). (extended Gate 1.23)
- [ ] The never-dispatched face: a job row with empty worker/model/brief and
      no candidate row (VERIFICATION.md:363-366) renders as never-dispatched
      with no fabricated verdict, gates, or attempts (AGENTS.md #7); an id
      with no `jobs` row renders 404 carrying the refusal message.
      (extended Gate 1.23)
- [ ] Read-only proof, not assertion (AGENTS.md #9): the DB sha256
      byte-identity set extends across the new GET routes on every fixture
      DB (the Gate 1.23 proof, VERIFICATION.md:2697-2703), and the
      readOnly-API churn guard — a write against a `readOnly`-opened handle
      throws (Known issues #7) — stays green. (extended Gate 1.23)
- [ ] The pins unchanged: `package.json` dependency blocks equal their
      recorded values (zero new npm dependencies; flipping this pin requires
      its own decisions entry), the new pages carry no client-side JS, the
      server binds 127.0.0.1 only, and `POST /approvals/decide` remains the
      ONLY write. (extended Gate 1.23)
- [ ] The run page's DAG job list links to the drill-down pages with plain
      `<a href>` (zero JS), and `--help` documents the new route.
      (extended Gate 1.23)
- [ ] VERIFICATION.md's Gate 1.23 section (VERIFICATION.md:2622-2736) is
      extended in the same change-set with the new faces, and its carve note
      (VERIFICATION.md:2718-2727) is amended to state WHY the §26.4
      context-inspector page stays carved: no producer exists (persisting
      ContextPlan/Packet is the producer-first successor and owns its own
      Gate 2) — not merely no page. (Gate 1.23's own docs pin)

## Verification

- Gate 0 (typecheck) — always, before anything else.
- The fast tier (`npm run verify`) stays green — Gate 1's own checks are
  untouched by a consumer-only change.
- **Extended Gate 1.23** (`node node_modules/tsx/dist/cli.mjs
  scripts/check-dashboard.mjs`) is the pinning gate for every criterion
  above — token-free, zero model calls. Baseline recorded this session
  pre-change: `check-dashboard: ALL GREEN`.
- Gate 2 NOT triggered: the change-set touches nothing on its trigger list
  (src/runner.ts, adapters, gates, workspace handling, report shape) — the
  T-034/T-006/T-008 standalone-consumer precedent (VERIFICATION.md:2732-2734).
- Gate 3 n/a: no adapter, no harness spawn — nothing to PWD-probe.

## References

docs/spec/inference-refinery-v2.md §26.2:1703-1715 (DAG view node-click
drill-down list — this ticket lands its store-backed text/table slice only);
§26.4:1744-1764 (context inspector — carved, blocked on a producer);
VERIFICATION.md Gate 1.23 (:2622-2736) and its carve note (:2718-2727);
decisions.md 2026-10-10 (machine gates decide survival; run root `C:\swarm`;
harness-agnostic engine) and 2026-10-20 (multi-generation deferral,
adjacent); T-034 (the landed predecessor and its carve list).
