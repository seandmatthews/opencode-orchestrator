# T-035 — Dashboard slice two: per-job drill-down pages over the recorded store

**Status:** done 2026-10-21
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

- [x] `GET /run/<id>/job/<jobId>` renders the job row, the
      `candidates.passed_all_gates` verdict, the job's `gate_results` rows,
      its full `attempts` history, and its `probe_runs` rows, each equal to
      a direct SELECT on the same temp DB, with NULLs rendered as "missing"
      — pinned on the flat fixture AND a retried-attempts variant (the
      elim-variant pattern; Gate 1.6's retried variant already builds
      `attempts` rows) AND the probes variant. Note: the live store
      currently holds 0 `probe_runs` rows, so the probe face is pinned only
      on the hand-built variant. (extended Gate 1.23)
- [x] The hand-built schedule variant (two real phases foundation→app with
      the expanded edge c02→c01 — the check-store construction, the Gate
      1.6/1.23 pattern at VERIFICATION.md:2672-2674) renders per-job pages
      consistent with the store rows. The gate must keep exercising this
      hand-built variant: no scheduled `--jobs` run has ever been ingested —
      every `phases` row in the live `C:\swarm\refinery.db` is the flat
      'main' derivation (queried this session). (extended Gate 1.23)
- [x] The never-dispatched face: a job row with empty worker/model/brief and
      no candidate row (VERIFICATION.md:363-366) renders as never-dispatched
      with no fabricated verdict, gates, or attempts (AGENTS.md #7); an id
      with no `jobs` row renders 404 carrying the refusal message.
      (extended Gate 1.23)
- [x] Read-only proof, not assertion (AGENTS.md #9): the DB sha256
      byte-identity set extends across the new GET routes on every fixture
      DB (the Gate 1.23 proof, VERIFICATION.md:2697-2703), and the
      readOnly-API churn guard — a write against a `readOnly`-opened handle
      throws (Known issues #7) — stays green. (extended Gate 1.23)
- [x] The pins unchanged: `package.json` dependency blocks equal their
      recorded values (zero new npm dependencies; flipping this pin requires
      its own decisions entry), the new pages carry no client-side JS, the
      server binds 127.0.0.1 only, and `POST /approvals/decide` remains the
      ONLY write. (extended Gate 1.23)
- [x] The run page's DAG job list links to the drill-down pages with plain
      `<a href>` (zero JS), and `--help` documents the new route.
      (extended Gate 1.23)
- [x] VERIFICATION.md's Gate 1.23 section (VERIFICATION.md:2622-2736) is
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

## Landed

2026-10-21, lane `ticket/T-035-job-drill-down`. What actually changed:

- `src/dashboard.ts` — one new read route `GET /run/<id>/job/<jobId>`
  (`renderJob`): direct SELECTs on `jobs` (row + expanded dependencies),
  `candidates` (the verdict — `job_id` IS the candidate id; survivor/
  eliminated rendered, never produced), `gate_results` (name, pass/FAIL,
  exit code, duration, output tail; NULL exit → "missing"), `attempts`
  (full history; producer-less `process_identity_json`/`worker_session_id`
  → "missing"; `output_artifacts_json`/`failure_json` verbatim,
  HTML-escaped; `prompt_version` verbatim or "missing"), `probe_runs`
  (probe, scenario, outcome, duration, bundle_path) — all through the same
  `readOnly` open; zero new dependencies, zero client-side JS,
  `POST /approvals/decide` still the only write. The never-dispatched face
  (empty worker/model/brief + no candidate row) renders a refusal-styled
  "never-dispatched" line and NO verdict/gates/attempts/probes sections;
  an id with no `jobs` row renders 404 carrying
  `no recorded job '<jobId>' in run '<runId>'`. The run page's DAG job
  list now links each job id with a plain `<a href>`; `--help` gained the
  route line. No engine file touched.
- `scripts/check-dashboard.mjs` — Gate 1.23 extended: the drill-down faces
  on the flat fixture, the hand-built
  schedule variant (kept exercising), a hand-built retried-attempts
  variant (the check-store construction; attempt 2 carries a recorded
  64-hex `prompt_version`, attempt 1 a null — both render faces pinned),
  the probes variant, the elim variant (eliminated verdict + FAIL gate),
  a never-dispatched variant (a `dispatchIndex: null` schedule job), the
  drill-down 404 faces, the anchor-form DAG link assertion, the `--help`
  route line, and the sha256 byte-identity set extended across the new GET
  routes on every fixture DB; the readOnly churn guard untouched and green;
  plus two standing pins this landing added to the gate's own fetch log —
  every fetched page swept for `<script>` tags (zero client-side JS, the
  ticket's posture pin) and the refused-405 POST face on the drill-down
  route (`POST /approvals/decide` stays the ONLY write).
- `VERIFICATION.md` — Gate 1.23 section extended with the new faces and
  the carve note amended: §26.4 stays carved because NO PRODUCER exists
  (the ingest upsert binds `jobs.context_plan_json` literal null; the only
  plan/packet JSON writer is the gate sandbox) — persisting
  ContextPlan/Packet is the producer-first successor owning its own
  Gate 2 — not merely no page; per-job artifact filtering and
  dispatch/phase-status rendering also named as still carved.
- `docs/tickets/T-035-job-drill-down.md` (this file) and
  `docs/tickets/README.md` index updated in the same change-set.

Measured gates (all run in this lane, on the exact committed tree):

- Gate 0 `npm run typecheck` — exit 0, pre-change baseline AND post-change.
- Extended Gate 1.23 `node node_modules/tsx/dist/cli.mjs
  scripts/check-dashboard.mjs` — pre-change baseline exit 0, ALL GREEN
  (72 `ok:` assertions); post-change exit 0, ALL GREEN (final: 113 `ok:`
  assertions, 0 FAIL — the drill-down faces plus the no-JS sweep and the
  405 POST pin this landing added to the round-1 tree).
- Fast tier `node scripts/verify.mjs fast` (Gate 0+1, every fast-tier gate
  through 1.23) — exit 0 on the final committed tree,
  `=== verify (fast) complete: ALL GREEN ===`, 1369 `ok:` lines, ~1m41
  wall clock.

Provenance: this change-set was first authored on this ticket's round-1
lane (2026-10-21), which bounced on a workflow-infra red that was NOT this
change-set's code — the tee-wrapper escape bug (the note below; its fix is
on `main` as f37f05a, byte-identical to the lane's 5452d71). The round-1
lane was cleared per the lane contract and the change-set re-landed on a
fresh lane from f37f05a; its doc record (the Known issue #13 follow-up and
the round-1 note below) is re-landed in the same commit so the red bar
stays recorded. Every gate number above is from this lane's own runs.

Deviations: none from the ticket text. The retried variant's attempt 2
carries a `promptVersion` value (the ticket names the column without
requiring null); this pins both render faces (recorded value + null →
"missing") in one variant, consistent with T-029's two-value pattern in
check-store. Not run by this lane: `npm run verify:full` (model tokens —
the driving pipeline re-runs the fast tier and owns the full-tier
decision).

Review round 1 (2026-10-21) — the lane bounced on a fast-tier red that was
NOT this change-set's code. The red: `node -e` died at compile time with
`Expected ',', got 'string literal'` / `SyntaxError: Invalid or unexpected
token`, exit 1 — the driving workflow's tee wrapper (`.zcode/workflows/
ticket-implement.dwf.ts`, b4866f5, the Known issue #13 remedy) carried `\n`
inside its double-quoted workflow-script string; the script layer consumed
the escape and `node -e` received a raw newline inside a single-quoted
literal, so EVERY wrapped gate run died before spawning the gate (no output
file written — the fast tier itself never ran in that pass). Reproduced
first-hand from the lane's pre-fix tree (byte-identical error, exit 1, no
outfile), fixed by double-escaping to `\\n` (the `-e` script must receive
backslash-n to parse its own newline), and proven green-after by running
the FULL fast tier through the fixed wrapper: exit 0, ALL GREEN, full
output teed to `C:\swarm\verify-red\T-035-review1-wrapper-proof.log`
(177 KB, Gate 0 through the final ALL GREEN); the wrapper also correctly
teed a red child's output and propagated its exit on an intermediate
mis-argued run. The direct fast tier (`node scripts/verify.mjs fast`) ran
ALL GREEN on the same tree. Recorded in VERIFICATION.md Known issue #13's
follow-up in the same change-set.

## References

docs/spec/inference-refinery-v2.md §26.2:1703-1715 (DAG view node-click
drill-down list — this ticket lands its store-backed text/table slice only);
§26.4:1744-1764 (context inspector — carved, blocked on a producer);
VERIFICATION.md Gate 1.23 (:2622-2736) and its carve note (:2718-2727);
decisions.md 2026-10-10 (machine gates decide survival; run root `C:\swarm`;
harness-agnostic engine) and 2026-10-20 (multi-generation deferral,
adjacent); T-034 (the landed predecessor and its carve list).
