# T-008 — Approval gates: durable records, `approvals` decide CLI, and the pending queue

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** T-006 (proposed — must land first; transitively T-003)

## What

Fourth slice of the stage-1 durable control plane (spec §34 Milestone 1's
"approvals" build item, `docs/spec/inference-refinery-v2.md:2026`): persist
human approval decisions in the T-003 store, decide them through a standalone
CLI, and expose the pending-approval queue — **zero behavior change to the
pipeline**. A rejection is a recorded event that appends to the audit stream and
never rewrites run state (spec §35:2193's "reject without corrupting run
state").

- **`src/store/index.ts` — additive schema, `approval_gates` table.**
  `SCHEMA_VERSION` bumps to the next integer after whatever stage-1 slices have
  landed (v4 under the planned T-006 → T-007 → this ordering), `CREATE TABLE IF
  NOT EXISTS` so any existing `refinery.db` gains it on next use — no migration
  machinery, T-006's additive precedent. Exactly spec §27:1834's
  `approval_gates` table, narrowed to what has a producer:
  `approval_gates (run_id, phase_id, job_id, state, requested_at, requested_by,
  decided_at, decided_by, note)` — PK `(run_id, phase_id, job_id)`, with
  `phase_id`/`job_id` read from T-006's derived phase/job rows (`phase_id` =
  the run's single phase, `job_id` = candidate id, T-006:40-48).
  - **State vocabulary chosen here** (the T-007:19-23 precedent — spec §6.3
    declares `approvalGate?: ApprovalGateSpec` at `:329` but never defines the
    type anywhere; grep over the whole spec: exactly that 1 hit): §21:1289-1294
    names the four states. This slice exports
    `ApprovalState = 'waiting_for_approval' | 'approved' | 'rejected'` — the
    three with a producer. `'cancelled'` (§21:1294) is **not** pre-defined; it
    has no producer until an abort/cancel slice exists (T-007 did the same
    with `'abandoned'`).
  - **One documented, bounded deviation from ingest determinism**
    (`src/store/index.ts:8-10`: event stamps derive from the report, "never
    from the wall clock"): approval requests and decisions are primary human
    facts no report carries, so their rows and events are legitimately
    wall-clock stamped (`requested_at`/`decided_at`, and the events' `at`).
    The determinism rule continues to govern everything derived — `ingest`
    itself is untouched and stays a pure function of the report. The store
    header comment and VERIFICATION.md state this scoping in the same
    change-set; it is not smoothed over.
  - **Writes are additive-only and operator-driven.** Two new exported store
    functions — `requestApproval(...)` and `decideApproval(...)` — are the
    only writers of approval state; nothing in `ingest` or the run path calls
    them. Approve/reject upsert the one row's state/`decided_at`/`decided_by`
    and append exactly one event, inside one transaction. They never touch
    `runs`, `candidates`, `gate_results`, artifacts, or any prior event row
    (the T-002 evidence-never-deleted rule, `src/clean.ts:6-8`; Gate 1.6
    already pins the fixture byte-identical after ingest,
    `scripts/check-store.mjs:111`). Rejections rewrite nothing — they append.
- **Events** (spec §28:1848's "Example events" is example, not exhaustive;
  §21:1292 supplies the `rejected` state): `APPROVAL_REQUESTED`
  (§28:1861) per requested row, `APPROVAL_GRANTED` (§28:1862) on approve, and
  **one new name this ticket documents**: `APPROVAL_REJECTED` on reject —
  §28 names no rejection event, so the vocabulary extension is chosen and
  recorded here rather than discovered later. `APPROVAL_CANCELLED` is not
  defined (no producer, same rule as the `cancelled` state).
- **`src/approvals.ts` — standalone CLI entry** (the house standalone pattern:
  `tsx src/approvals.ts`, like `src/clean.ts`/`src/integrate.ts`; T-006:51-61's
  `src/dag.ts` precedent), three subcommands:
  - `npm run approvals -- request --run <runId> [--job <jobId>] [--db <path>]
    [--by <who>] [--note "..."]` — records `waiting_for_approval` for the
    finished run's **survivors** (jobs whose candidate passed all gates, read
    from `candidates.passed_all_gates`), one row + one `APPROVAL_REQUESTED`
    event per job; `--job` narrows to a single job. An approval for an
    eliminated candidate is refused — gates decide survival (decisions.md
    2026-10-10), and a human approval must not resurrect an eliminated
    candidate.
  - `npm run approvals -- list [--run <runId>] [--db <path>] [--json]` — the
    **pending-approval queue**: rows in `waiting_for_approval`, the token-free
    precursor of §26.6:1770-1772's Milestone-7 UI exactly as the `dag` dump is
    the precursor of §26.2. Read-only: the DB opens with `node:sqlite`'s
    readOnly option; the gate proves the file byte-identical afterward.
  - `npm run approvals -- decide --run <runId> --job <jobId> --decision
    approved|rejected [--by <who>] [--db <path>] [--note "..."]` — records the
    decision (`decided_by` defaults to the OS username; `decided_at` is
    wall-clock) and appends `APPROVAL_GRANTED`/`APPROVAL_REJECTED`.
  - **Refusals exit non-zero and write nothing:** missing DB file (no
    subcommand ever creates a `refinery.db` as a side effect — the
    T-006:57-61 refusal pattern), unknown runId, unknown/non-survivor job,
    double-decide (the row is already `approved`/`rejected` — the audit
    record is not rewritable; the refusal names the current state), unknown
    `--decision` value, missing flags. Refusals happen before any write.
  - `--db` defaults to `C:\swarm\refinery.db` — same literal as
    `src/cli.ts:80`, per decisions.md (run root is `C:\swarm\`).
- **`package.json`: one new script** `"approvals": "tsx src/approvals.ts"`.
  Zero new dependencies — `node:sqlite` only (decisions.md: TypeScript on
  Node 22; the named fallback `better-sqlite3` would need its own decisions
  entry, VERIFICATION.md Known issues #7).
- **New Gate 1.9 — `scripts/check-approvals.mjs`** (fast tier, token-free),
  hooked into `scripts/verify.mjs` after the stage-1 store/DAG/retry gates and
  before the fast-tier finish (`scripts/verify.mjs:448`) — the T-003:149
  slice-owns-its-gate precedent. Gate number: next free after T-006's claimed
  1.7 (`scripts/check-dag.mjs`, T-006:137-139) and T-007's claimed 1.8
  (`scripts/check-retry.mjs`, T-007:112-114). No existing gate can pin any of
  this: Gate 1.6 pins only the four-table fixture ingest and the three
  derived-event types (`scripts/check-store.mjs:67,97-98`), and nothing else
  in the repo reads the DB back. The check drives ingest + the new CLI as
  separate subprocess invocations against temp DBs seeded from
  `scripts/fixtures/report-real.json`, and pins every acceptance criterion
  below.
- **VERIFICATION.md** gains the Gate 1.9 section (including the wall-clock
  scoping above) in the same change-set (AGENTS.md #6).

**Does NOT claim:**

- **No in-run indefinite pause and no restart-resume** (§21:1305 "paused
  indefinitely", §29:1879 step 8 "preserve waiting approvals"): they have no
  exercisable home — a run is one process (`src/runner.ts:45-91` plans, leases
  all worktrees up front `:61-64`, fans out lanes, writes `report.json` once
  `:89` and returns; entered once from `src/cli.ts:143-162`), no scheduler
  exists (T-006:77-79 carves it; `docs/ROADMAP.md:12` lists scheduler as
  remaining), and T-007:135-141 already carved §29's reconciliation for
  exactly this reason. What survives an orchestrator restart here is the
  **durable record and the queue** (state lives in the DB, proven across
  separate CLI processes by Gate 1.9) — not a paused execution. The pause
  lands with the scheduler or Milestone-3 crash recovery; this carve stands
  until then.
- **No approvalGate enforcement anywhere in the pipeline** — T-006:77-79
  explicitly reserved it. In particular `npm run integrate` does **not** gate
  on approval state: that extends T-005's enumerated refusal contract
  (VERIFICATION.md:108-117) and gives approvals their first real consumer;
  it is its own successor ticket (T-005:108-111 already flagged a
  store-backed integrate as a possible successor). Until a consumer exists, a
  decision changes nothing automated — the value this slice delivers is the
  durable decision record and the queue.
- **No §24:1559-1566 outcomes beyond approve/reject** — `return to
  generation` and `pin candidate for later` have no downstream model (no
  generations, no candidate pinning) and are carved.
- **No §30:1899 pause-for-human failure policy** — T-007:143-144's carve
  stands.
- **No §26.6 approval-queue UI** — Milestone 7 (`docs/ROADMAP.md:19`); the CLI
  `list` is the precursor.
- **No `'cancelled'` state / `APPROVAL_CANCELLED` event** — no producer until
  an abort/cancel slice.
- **Zero runner/report/adapter change** — `src/runner.ts`, adapters, gate
  code, workspace handling, the `RunReport` shape, and `src/cli.ts`'s run path
  are untouched; approvals are store + CLI only, zero model/harness knowledge
  (decisions.md: engine is model/harness-agnostic).

## Why

`docs/ROADMAP.md:12` maps stage 1 to "remaining: job DAG, attempts, retries,
approvals, scheduler" — approvals are the repo's own named next item after the
DAG and attempts slices, and the reservation is explicit:
`src/store/index.ts:19-20` ("Later stage-1 slices add
jobs/attempts/approval_gates/phases") and T-003's Does-NOT-claim
(`docs/tickets/T-003-durable-run-records.md:61-62`). Spec basis: §6.3:329
declares `approvalGate` on every phase; §21 "Human Checkpoint Semantics"
(`:1285-1305`) makes approval "a persisted job state" with the four-state
vocabulary and says the workflow "can remain paused indefinitely"; §27:1834
puts `approval_gates` in the initial table list; §28:1861-1862 names
`APPROVAL_REQUESTED`/`APPROVAL_GRANTED`; §29:1879 requires restart to preserve
waiting approvals; §30:1899 lists "pause for human" among failure policies;
§34:2026 lists "approvals" in Milestone 1's build list; §35:2190-2193 asks the
two Human Control questions this slice makes the first part of answerable:
durable decisions that survive process death, and rejection without corrupting
run state. §9.3:837 ("Human approval remains explicit") sits consistently with
decisions.md 2026-10-10 (machine gates decide survival; models advise): a
human approval is operator input recorded after the fact, never a model
verdict, and nothing automated consumes it this slice.

**Dependency:** T-006 is proposed, not landed — HEAD `3adaac5` is its
docs-only commit (`git show --stat 3adaac5`: only `docs/tickets/README.md` +
the T-006 file), `src/` has no `dag.ts`, and the store is schema v1 with
exactly the four tables (`src/store/index.ts:17-65`; verified this session).
Approval rows key on `(run_id, phase_id, job_id)`, so the phase/job model must
exist first; one ticket = one change-set forbids bundling it. Until T-006
lands, this ticket stays proposed (the T-007:182-186 precedent).

**Honest tension, stated rather than smoothed** (T-006:101-111 precedent): the
spec's approval gate pauses a *running* workflow; today's pipeline is a
one-shot process with nothing to pause and nothing to resume, so "pause
indefinitely" is not groundable in this slice — the mergeable core is the
post-hoc durable record, the decide CLI, and the queue. Nothing consumes a
decision until an integrate pre-flight or the scheduler exists, exactly as
nothing consumed T-006's job rows. And because ingest's determinism rule
(`src/store/index.ts:8-10`) says "never from the wall clock", this ticket
documents a bounded deviation for primary human facts rather than bending
either the rule or the feature silently.

## Acceptance criteria

- [ ] Plain ingest is approval-blind: ingesting the fixture
      (`scripts/fixtures/report-real.json`) produces zero `approval_gates`
      rows and no approval events — approval state is written only by explicit
      operator action through the CLI — pinned by the **new Gate 1.9**
      (`scripts/check-approvals.mjs` + new VERIFICATION.md section + hook in
      `scripts/verify.mjs`).
- [ ] `request` records the queue: against a fixture-ingested temp DB,
      `approvals request --run <runId>` creates exactly one
      `approval_gates` row per surviving candidate — keyed
      `(run_id, phase_id, job_id)` with `phase_id` from T-006's derived phase
      and `job_id` = candidate id, state `waiting_for_approval`,
      `requested_at` wall-clock, `requested_by` recorded — and appends exactly
      one `APPROVAL_REQUESTED` event per row; `--job` narrows to one — pinned
      by **Gate 1.9**.
- [ ] Approve transitions per §21: `decide --decision approved` flips the row
      to `approved` with `decided_at`/`decided_by` recorded and appends
      exactly one `APPROVAL_GRANTED` event — pinned by **Gate 1.9**.
- [ ] Reject transitions per §21 and appends the documented extension:
      `decide --decision rejected` flips the row to `rejected` and appends
      exactly one `APPROVAL_REJECTED` event — pinned by **Gate 1.9**.
- [ ] Rejection corrupts nothing: after a reject, `runs`, `candidates`, and
      `gate_results` rows are value-identical to before, every prior event row
      (seq, type, at, payload) is unchanged (append-only stream), and
      `PRAGMA integrity_check` returns `ok` — pinned by **Gate 1.9**
      (full-table comparisons before/after).
- [ ] The record survives process death: request, decide, and list run as
      separate CLI process invocations (the gate spawns each subcommand as its
      own process), and each sees the state the previous one persisted —
      proving state lives in the DB, not in any process — pinned by **Gate
      1.9**. (This is the exercisable form of "survives orchestrator restart"
      today; the paused-execution form is carved, per What.)
- [ ] The queue view: `approvals list` exits 0 and prints pending
      (`waiting_for_approval`) rows; decided rows drop out of the default
      queue; `--json` emits the same structure as JSON — pinned by **Gate
      1.9**.
- [ ] Refusals exit non-zero and write nothing: missing DB file (and no empty
      DB created as a side effect — asserted absent afterward), unknown
      runId, decide on an unknown or non-survivor job (an approval must not
      resurrect an eliminated candidate), double-decide (refusal names the
      row's current state), unknown `--decision` value, missing flags —
      pinned by **Gate 1.9**.
- [ ] Read-only views never write: after `approvals list`, the DB file is
      byte-identical (hash before/after; readOnly open) — pinned by **Gate
      1.9**.
- [ ] The wall-clock deviation is documented, not discovered: approval rows
      and events carry wall-clock stamps while every report-derived stamp
      stays deterministic; the scoped rule is stated in the
      `src/store/index.ts` header comment and VERIFICATION.md's Gate 1.9
      section in the same change-set — pinned by **Gate 1.9** (stamps parse as
      ISO-8601 and are not report-derived) plus change-set review.
- [ ] No behavior change to the pipeline: `src/runner.ts`, adapters, gate
      code, workspace handling, the `RunReport` shape, and `src/cli.ts`'s run
      path are untouched, and `npm run verify` stays ALL GREEN — pinned by
      **`npm run verify`**. Gate 1.6 is green before this change (verified
      2026-10-14: `node node_modules/tsx/dist/cli.mjs scripts/check-store.mjs`
      → "check-store: ALL GREEN", exit 0, only the documented node:sqlite
      ExperimentalWarning on stderr — Known issues #7) and must stay green
      after.
- [ ] VERIFICATION.md carries the new Gate 1.9 section, and the ticket status
      + index row move in the same change-set (AGENTS.md #6; tickets README
      rules) — pinned by change-set review.

## Verification

Gate 0 (`npm run typecheck` — green before this change, verified 2026-10-14,
exit 0) always; Gate 1 (`npm run demo`) sanity, token-free; Gate 0.5 n/a
(`src/parse.ts` untouched); Gate 1.6 green before this change, verified
2026-10-14 (ALL GREEN, exit 0, Known issues #7 warning only). The **new Gate
1.9** runs via `npm run verify` (not yet run for this ticket — no code
exists). **Gate 2 is not required and not run**: the slice touches none of
VERIFICATION.md:200-201's triggers (no `src/runner.ts`, no adapter, no gate
code, no workspace handling, no report-shape change, and `src/cli.ts`'s run
path untouched — everything lives in `src/store/index.ts` + the new
`src/approvals.ts`) — the T-005:222-224 precedent, stated here so it is
neither silently skipped nor silently owed; any successor that wires approval
state into the run or integrate path owns a Gate 2 run. Gate 3 n/a (no
adapter, zero model involvement).

## References

spec §6.3 (`docs/spec/inference-refinery-v2.md:329`), §9.3 (`:837`), §21
(`:1285-1305`), §24 (`:1559-1566`), §26.6 (`:1770-1772`), §27 (`:1834`), §28
(`:1848-1864`), §29 (`:1879`), §30 (`:1899`), §34 (`:2026`), §35
(`:2190-2193`) · T-003 — predecessor store slice; its Does-NOT-claim
(`docs/tickets/T-003-durable-run-records.md:61-62`) reserves the
`approval_gates` table; `:149` slice-owns-its-gate precedent · T-006 —
dependency: phase/job model + the standalone-CLI and refusal patterns
(`:51-61`); its approvalGate carve (`:77-79`) reserves this work · T-007 —
never-defined-vocabulary precedent (`:19-23`), §29/§30 carves
(`:135-141,:143-144`), blocked-on-T-006 precedent (`:182-186`) · T-005 —
Milestone-7 approval-queue carve (`:105-106`), store-backed-integrate successor
note (`:108-111`), Gate-2-not-required precedent (`:222-224`) ·
`docs/decisions.md` (2026-10-10: Node 22 / harness-agnostic / gates decide /
`C:\swarm\` run root) · `docs/ROADMAP.md:12` · `src/clean.ts:6-8` (evidence
never deleted).
