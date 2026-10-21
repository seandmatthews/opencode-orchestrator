# T-034 — Run dashboard first slice: local read-only HTTP view over the recorded store — runs, gates, evidence pointers, DAG, approval queue + decide (spec §26.1, §26.2, §26.6, §34 M7; ROADMAP stage 7)

**Status:** proposed
**Category:** ops
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** T-003, T-006, T-008, T-016

## What

Add `npm run dashboard -- [--port <port>] [--db <path>]`: a new standalone entry
`src/dashboard.ts` (the `src/clean.ts` / `src/dag.ts` / `src/approvals.ts`
pattern) serving a localhost-only, read-only HTML view of what the schema-v5
store already recorded. **Zero new npm dependencies** — plain `node:http` for
serving plus the store's own `node:sqlite` reads; `package.json` gains exactly
one script and nothing else. No engine code is touched: the dashboard is a
consumer of recorded state, it knows no harness, spawns no models, spawns no
processes, and touches no repository (decisions.md 2026-10-10: the engine is
harness-agnostic; gates decide survival — the dashboard renders recorded
verdicts and produces none).

Routes (HTML rendered by stdlib string templates; no framework, no client-side
JS this slice):

- `GET /` — the run list from `runs` (run_id, repo, base_sha, goal, model,
  started_at/finished_at) plus per-run survivor/eliminated counts derived from
  `candidates.passed_all_gates`. Labeled honestly as ingested post-hoc state —
  never live (see "does NOT claim").
- `GET /run/<id>` — one run's candidates with their `gate_results` (gate name,
  passed, exit code, duration, output tail) and evidence pointers from
  `artifacts` (`path` / `size_bytes` / `content_hash`, src/store/index.ts:201-211;
  null rendered as missing, never fabricated — AGENTS.md #7) and `probe_runs`
  (`bundle_path`); plus the run's recorded DAG from `phases` / `jobs` /
  `job_dependencies` rendered as text/table — the same structure
  `readDag` (src/dag.ts:77-98) reads, cross-checked by the new gate.
- `GET /approvals` — the pending queue via the existing `listPendingApprovals`
  (src/store/index.ts:732, already a readOnly open) called verbatim — no
  duplicated SQL.
- `POST /approvals/decide` (form fields `run`, `job`, `decision`, optional
  `by`/`note`) — the existing `decideApproval` (src/store/index.ts:674) called
  verbatim: the dashboard's ONLY write, operator-driven, whose wall-clock
  stamping is the documented T-008 scoping case (src/store/index.ts:23-30).
  Every store refusal (unknown run, unknown job, non-survivor, double-decide,
  unknown decision) surfaces as an HTTP 4xx carrying the refusal message, with
  nothing written.

All read routes open the DB `{ readOnly: true }` (the src/dag.ts:69-75
`openReadOnly` pattern). `--db` defaults to the `C:\swarm\refinery.db` literal
shared by src/cli.ts:168, src/dag.ts:37, and src/approvals.ts:84 (decisions.md:
run root is `C:\swarm\`). A missing DB file refuses startup with a clear
message and never creates a refinery.db as a side effect (the T-006/T-008
refusal pattern, src/dag.ts:125 / src/approvals.ts:111). Binds 127.0.0.1 only;
no auth (operator-local tooling, same trust domain as the CLI precursors).

What it does NOT claim — stated, not smoothed:

- **No live monitoring.** The store has no run-status column and ingest is
  post-hoc and derived (the VERIFICATION.md carve: "live in-run event emission
  (ingest stays post-hoc and derived)"). The dashboard shows only INGESTED
  (finished) runs' derived state — survivor/eliminated counts, never in-flight
  progress.
- **No §26.1 fields without a store producer.** Token usage, disk usage, and
  worktree count (spec §26.1:1686-1701) have no producer anywhere in the schema
  or src/types.ts — they stay off the page.
- **No dispatch order.** `ScheduleJob.dispatchIndex` lives only in report.json's
  schedule block (src/types.ts:357; `RunReport.schedule?` :416-417); the store
  tables carry no dispatch-index column. `runs.report_path`
  (src/store/index.ts:105) points at it — rendering it is a later carve.
- **No artifact contents.** Pointers only; serving file bytes is §26.5's
  artifact viewer, carved.
- **No interactive graph.** The DAG renders as text/table; §26.2's interactive
  node-click JS stays carved (T-006:78's carve is narrowed, not closed).
- **Nothing rendered can influence a verdict.** The pages are evidence views;
  the only mutation is the human decide POST through the already-gate-pinned
  `decideApproval` writer.

Carved off this slice (named for later tickets): §26.4 context-inspector page
(T-012:149's carve stands — the CLI is the precursor); §26.5 artifact viewer
serving contents; §26.3 candidate comparison; §26.7 retention/disk view
(T-021:124's carve stands); §26.8 prompt registry (T-029's carve stands);
§26.2's interactive graph JS; live status/auto-refresh (no producer — ingest is
post-hoc); §26.1's producerless fields (token usage, disk usage, worktree
count); dispatchIndex rendering from report.json; §34:2131's Sol
screenshot-based UI verification (needs the stage-5 Codex/Sol adapter,
ROADMAP.md:17, unlanded); auth or binding beyond localhost; any engine/store
write beyond the existing `decideApproval`.

## Why

ROADMAP stage 7 — "UI (run dashboard, DAG, context inspector, approval queue)"
(docs/ROADMAP.md:19) — is spec Milestone 7 (§34:2116-2131), the last stage, and
no existing ticket touches any of it: the three open tickets (T-031, T-032,
T-033) are engine/engine/docs. Three DONE tickets carve explicitly to exactly
this work, so this ticket is their named successor, not a duplicate: T-008:135
("No §26.6 approval-queue UI — Milestone 7; the CLI list is the precursor"),
T-006:78 ("no interactive DAG view (spec §26.2:1703-1715 is Milestone-7 UI —
this CLI dump is the token-free precursor)"), T-012:149 ("No §26.4 UI — the CLI
is the token-free precursor"). decisions.md 2026-10-10 (TypeScript on Node 22)
anticipates "the future dashboard shares the language".

The state plane is already complete for the slice — everything the pages render
has a producer: `runs`/`candidates`/`gate_results` (T-003),
`phases`/`jobs`/`job_dependencies` (T-006), `attempts` (T-007),
`approval_gates` (T-008), `artifacts`/`probe_runs` (T-016), all in
src/store/index.ts:95-222 (SCHEMA_VERSION 5 at :76). The read-back pattern
exists too (src/dag.ts:69-98 readOnly open, never writes), and the approval
queue and its decide action exist end to end
(`listPendingApprovals`/`decideApproval` behind `npm run approvals`,
src/approvals.ts:127-162) with its refusal contract pinned (Gate 1.9).

The pain: all of that recorded state is visible only through per-run CLI
invocations — one datum family at a time, with run/job ids typed by hand. The
first UI slice makes recorded runs, verdicts, evidence pointers, the recorded
DAG, and the pending approval queue human-visible in one token-free place, at
zero dependency cost. It unblocks no engine capability — the CLI precursors
already expose every datum — so it is operator ergonomics, which is why this is
`ops` (the T-002 standalone-consumer precedent), not `engine`.

## Acceptance criteria

- [ ] `npm run dashboard -- [--port <p>] [--db <path>]` serves the pages on
      127.0.0.1; `--db` defaults to `C:\swarm\refinery.db`; a missing DB file
      refuses startup with a clear message and never creates a refinery.db as a
      side effect — pinned by the new Gate 1.23.
- [ ] `GET /` renders the ingested fixture run (scripts/fixtures/report-real.json
      → run 20261011022419, candidates c01/c02) with goal/repo/dates and derived
      survivor/eliminated counts equal to the `candidates.passed_all_gates`
      rows, labeled as ingested post-hoc state — pinned by Gate 1.23 (fixture
      ingested into a temp DB: the Gate 1.6/1.9 pattern).
- [ ] `GET /run/<id>` renders every candidate id, per-candidate gate
      name/pass/exit/duration, and artifact evidence pointers (path,
      size_bytes, content_hash) equal to the temp DB's rows, and its DAG
      section equals `readDag`'s output over the same DB (cross-check against
      src/dag.ts's read of the same file) — pinned by Gate 1.23, including a
      hand-built schedule+approval variant (the Gate 1.9 elim-variant pattern:
      seed a pending row via `requestApproval` on the temp DB) exercising
      phases/jobs/edges and the queue.
- [ ] `GET /approvals` renders exactly `listPendingApprovals`'s rows — pinned
      by Gate 1.23 (page content checked against a direct store call on the
      same temp DB).
- [ ] `POST /approvals/decide` flips one pending row through the real
      `decideApproval` (state → approved/rejected, one APPROVAL_GRANTED/
      APPROVAL_REJECTED event), the queue drops the row, and every store
      refusal (unknown run, unknown job, non-survivor, double-decide, unknown
      decision) surfaces as an HTTP 4xx carrying the refusal message with
      nothing written — pinned by Gate 1.23 (the T-008 refusal contract over
      HTTP, no store behavior changed).
- [ ] Read-only proof, not assertion (AGENTS.md #9): the DB file's sha256 is
      byte-identical across ALL GET routes — pinned by Gate 1.23 (the Gate
      1.7/1.9 byte-identity pin pattern; the decide POST is expected to mutate
      and is not in the byte-identity set).
- [ ] Zero new npm dependencies: `package.json` gains exactly the one
      `dashboard` script and no dependency change — pinned by Gate 1.23
      asserting the dependency blocks are unchanged, plus Gate 0 green.
- [ ] Engine untouched: no pipeline file changes behavior (src/runner.ts,
      adapters, gates, workspace, report shape, the store's ingest — all
      untouched; src/dashboard.ts imports only the store's existing
      readers/writers and node builtins) — Gate 0 green; Gate 2 not triggered
      (trigger list, VERIFICATION.md:2474-2475; the T-006/T-008/T-012
      standalone-consumer precedent); Gate 3 n/a (no adapter file added or
      changed, no harness spawn at all).
- [ ] VERIFICATION.md gains the Gate 1.23 section in the same change-set
      (AGENTS.md #6), including the node:sqlite-is-experimental caveat
      (Known issue #7) — the dashboard rides the same engine as the store; the
      named fallback (better-sqlite3) would be a new dependency and its own
      decisions entry, deliberately not this slice.

## Verification

- **Gate 0** (`npm run typecheck`) — always.
- **Gate 1.23 (new, this ticket)** — `node node_modules/tsx/dist/cli.mjs
  scripts/check-dashboard.mjs`, wired into the fast tier of
  scripts/verify.mjs after Gate 1.22 and before the fast-tier `finish()` (the
  fast tier currently ends at Gate 1.22 — scripts/verify.mjs:876-886 — so 1.23
  is the next free number). Token-free: stdlib `fetch` drives the server on an
  ephemeral localhost port (the T-024 WebProbe client precedent), zero model
  tokens.
- **Gate 1** (demo fixture) unaffected; fast tier stays green with 1.23 added.
- **Gate 2 not triggered** — the change-set touches nothing on the trigger
  list (src/runner.ts, adapters, gates, workspace handling, report shape).
- **Gate 3 n/a** — no adapter; the dashboard spawns no harness, so there is
  nothing to PWD-probe.

## References

docs/spec/inference-refinery-v2.md §26.1:1686-1701 (run overview),
§26.2:1703-1715 (DAG view), §26.6:1770-1772 (approval queue), §34:2116-2131
(Milestone 7 build list); docs/ROADMAP.md:19 (stage 7); decisions.md 2026-10-10
(TypeScript/Node 22, gates decide survival, run root C:\swarm); VERIFICATION.md
Known issue #7 (node:sqlite experimental); predecessor carves T-006:78,
T-008:135, T-012:149, T-021:124.
