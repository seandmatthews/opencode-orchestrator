# VERIFICATION.md — gates and definition of done

**Status:** alive — extend this file in the same change-set as any feature it verifies.
A change is done when the gates it touches pass, its acceptance criteria each name the
check that pins them, and docs/tickets moved in the same change.

## Gate 0 — static (seconds)

```bash
npm run typecheck
```

Pass: exit 0. Required for every change, no exceptions.

## Gate 0.5 — structured-output parser contract (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-parse.mjs
```

Pins the JSON extraction rules for planner briefs and reviewer observations
(prose-tolerant scanning, cycling, rejection shapes) without spending model tokens.
Required whenever `src/parse.ts` changes.

## Gate 1 — fixture baseline (seconds)

```bash
npm run demo
```

Regenerates `C:\swarm\demo-target` from `scripts/demo-target.mjs` and runs its own
baseline `node build.js` + `node test.js`. Pass: exit 0, `build ok` + `tests ok`
printed, one commit on `main`. This is the harness the skeleton runs against; a broken
fixture invalidates every downstream gate.

## Gate 1.5 — run artifact cleanup (seconds, fast tier)

```bash
npm run clean -- --run <runId> [--force] [--run-root <path>]
npm run clean -- --all [--force] [--run-root <path>]
```

Disposes a run's git worktrees and `swarm/*` branches (T-002). Never deletes
evidence — `report.json`, `diff.patch`, logs survive. A worktree holding
uncommitted changes is refused (non-zero exit, per-item message) unless `--force`:
un-captured changes may be the only copy. `--all` cleans every run directory under
the run root except the newest (run directories are 14-digit timestamp names).
Worktrees come from the run's `report.json` plus anything else discovered under its
`wt/`; the target repo comes from the report's `repo` field, falling back to the
worktrees' own `.git` pointers (crash-mid-run recovery). All git subprocess calls
are list-form — this command exists partly to retire the Known issues #4 quoting
hazard.

The fast tier pins this against a throwaway sandbox repo: a recorded run cleans
with exit 0, leaving only `main` in `worktree list` and no `swarm/*` branches, with
`report.json` intact; a dirty worktree is refused while its clean sibling is still
disposed (per-item results), and disposed under `--force` (no report.json, so the
`wt/`-discovery path is exercised too); `--all` disposes the older run and leaves
the newest untouched.

### Checkout lock (T-004)

```bash
node node_modules/tsx/dist/cli.mjs src/lock.ts acquire <repo> [--run-root <path>] [--run-id <id>] [--force-lock]
node node_modules/tsx/dist/cli.mjs src/lock.ts release <repo> [--run-root <path>]
```

`src/lock.ts` is a zero-dependency cross-process checkout lock (`fs.openSync(wx)`)
so runs and clean can never concurrently mutate one target repo's worktrees.
Lock files live under `<run-root>\locks\<sha256(norm(repo))>.lock` — normalized
repo paths (`c:/x` and `C:\X` contend on one lock), never inside the target repo,
and `locks/` is structurally safe from `clean --all`'s `/^\d{14}$/` sweep.
`npm run skeleton` takes the lock after repo validation and releases it in a
`finally` on every path — a refusal happens before planner tokens are spent and
before the artifacts dir exists. `npm run clean` takes it per target repo inside
the per-run disposal (so `--all` locks each run's own repo in turn).

**Stale-lock policy: never auto-reap, never guess liveness.** Any existing lock
refuses with the holder pid, its age, and the lock file path; only the explicit
`--force-lock` flag takes it from a suspected-stale holder. A hard-killed run
therefore leaves a lock that blocks until a human overrides — by design (spec
§15.2: no live process is silently reattached based on stale PID metadata).

The fast tier pins: a held lock makes clean refuse non-zero removing nothing
(worktrees, branches, and evidence intact; refusal names pid + age + path); a
held lock makes a run refuse non-zero before any worktree or artifacts dir
exists (token-free); every proceeding clean releases its lock (no residual
`.lock` under `<run-root>\locks\`, asserted after the original clean scenarios
too); a failure after acquisition (bad `--base`) still releases; `--all` locks
per repo (a held lock on one run's repo refuses that run while another repo's
run still cleans, final exit 1); the stale policy above, including that
`--force-lock` proceeds and releases afterward. Uncontended behavior (exit
codes, stdout, `report.json`) was proven unchanged once by a real
`npm run verify:full` recorded in T-004's Landed section — not a permanent
Gate 2 extension.

### Integration replay (T-005)

```bash
npm run integrate -- --run <runId> --candidate cXX --gate "name=command" [...]
```

Replays a surviving candidate's captured `diff.patch` onto a fresh detached
worktree of the target repo at its **current HEAD** and re-runs the
operator-supplied gates there (spec §17.2 steps 1-4 and 6; no model
involvement anywhere). The `--gate` name set must exactly match the gates the
candidate passed in the run — gate commands are not recorded in `report.json`,
so the name set is the integrity check. Policy refusals (non-zero, nothing
created): non-survivor candidate, missing/empty diff (a NO-OP is never a
pass), unknown candidate id, gate-name mismatch, already-present integration
worktree. `git apply --check` then `git apply` (atomic — a rejecting patch
leaves the tree untouched); an apply that lands but changes nothing is a NO-OP
refusal; a diff touching a binary file can never replay (capture lacks
`--binary`) and is refused with a pointer at the carved-off capture fix. The
verdict artifact `<runDir>/integrate/<id>.json` records
applied/treeChanged/gates/passed; exit 0 iff applied + treeChanged + all gates
passed. Replay never commits, never branches, never moves a ref (§17.4).

The replayed worktree is left in place for inspection, dirty by construction:
plain `clean` refuses it (dirty-protection proven intact on this worktree
class) and `clean --force` disposes it via the existing `wt/`-discovery, while
`integrate/<id>.json`, `diff.patch`, and `report.json` survive. The whole flow
runs under the T-004 checkout lock, released on every path.

The fast tier pins all of it against a throwaway sandbox (diffs captured
exactly like `src/workspace/worktree.ts`): clean replay onto drifted HEAD
(exit 0, post-drift `targetHead`, change present, canonical checkout and HEAD
untouched, no new branches, detached worktree), conflict refusal with an empty
worktree, every policy refusal, gate-name contract (extra/missing/renamed)
refusing before any worktree exists, both disposal faces, and no residual
lock files afterward.

## Gate 1.6 — store ingest (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-store.mjs
```

Pins the durable run records (T-003), the derived job DAG (T-006), the
attempt records (T-007), and the recorded schedule (T-009):
`src/store/index.ts` ingests a finished `RunReport`
into SQLite (`node:sqlite`, schema v4: `runs`, `candidates`, `gate_results`,
`events`, T-006's `phases`/`jobs`/`job_dependencies`, T-007's `attempts`, and
T-008's `approval_gates` — which ingest never writes; Gate 1.9 owns it)
— zero npm dependencies. All tables are `CREATE TABLE IF NOT EXISTS`, so an
existing v1/v2/v3 `refinery.db` gains the newer tables on its next use — no
migration machinery, no backfill: old runs gain DAG/attempt rows only when
re-ingested, which appends a fresh event block by design.
One call site in `src/cli.ts` immediately after `runSkeleton` returns, behind
`--db <path>` (default `C:\swarm\refinery.db`). Failure policy is
log-and-continue: a failed DB write prints one loud `PERSISTENCE FAILED` line
and never changes the run's exit code, stdout verdicts, or artifacts —
persistence records verdicts, it never influences them.

The gate ingests the vendored real report (`scripts/fixtures/report-real.json`,
a verbatim copy of run 20261011022419) into a fresh temp DB and asserts:

- exact row counts and field values across `runs`/`candidates`/`gate_results`,
  including `planner_json`/`review_json` round-trips,
- the fixture predates attempts and yields zero `attempts` rows (pre-T-007
  reports ingest unchanged),
- the derived job DAG (T-006) matches the report's real fan-out: exactly one
  `phases` row (`phase_id = 'main'`, `dependencies_json` `[]`, §6.3 policy
  columns null), one `jobs` row per candidate (`job_id` = the candidate id,
  `worker_id`/`model`/`brief` copied verbatim, empty dependencies, every §6.4
  policy column null), and zero `job_dependencies` rows — the flat derivation
  is the fallback for schedule-less reports; a report carrying a schedule
  block derives its REAL structure instead (the T-009 bullet below),
- the pure validators (`unknownDependencyRefusal`, `cycleRefusal`, exported
  from the store module, no I/O) accept the derived flat DAG and refuse
  hand-built synthetic inputs — a 3-cycle and a self-dependency (the refusal
  names every job on the cycle) and an unknown-dependency reference (the
  refusal names the offender and the missing id) — Gate 0.5's hand-built-input
  pattern: no pipeline, no model tokens,
- `events` semantics: an all-pass report emits exactly `RUN_CREATED` at the
  report's own `startedAt`; a modified report with a failed gate and an
  eliminated candidate emits `GATE_FAILED` + `CANDIDATE_ELIMINATED` with `at`
  derived from `startedAt` + the candidate's worker duration (never
  `Date.now()`, so re-ingest is deterministic),
- the attempts table (T-007), on a hand-built retried-candidate variant of
  the fixture (the elim-variant pattern): one row per recorded attempt keyed
  `(run_id, job_id, attempt_number)` with
  state/started_at/ended_at/input_context_hash/output_artifacts_json/
  failure_json copied from the report record, `prompt_version`/
  `process_identity_json`/`worker_session_id` null (no producer this slice —
  stated, not smoothed), a candidate still carrying the pre-T-007 shape (no
  `attempts` array) yielding zero rows, exactly one derived `ATTEMPT_STARTED`
  per attempt with `at` taken from the attempt's own `startedAt` and a
  payload naming job/attempt id/number,
- re-ingest of the same report leaves `runs`/`candidates`/`gate_results` —
  the DAG tables (`phases`/`jobs` upsert by natural key, `job_dependencies`
  re-derived delete+insert) — and the `attempts` rows (upsert by natural
  key) idempotent, while `events` appends a fresh deterministic block and
  never rewrites prior rows,
- the schedule block (T-009), on a hand-built DAG variant of the fixture
  (the elim-variant pattern: two real phases `foundation` → `app` with the
  expanded edge `c02 -> c01`, c02's gates failed): two `phases` rows with
  the real ids, declared dependencies, and the `completion` policy (its
  first producer; `early_stop_json`/`approval_gate_json` stay null), job
  rows carrying their real phase and expanded edges with worker/model/brief
  joined from the candidate reports, exactly one real `job_dependencies`
  edge, and the derived schedule events after the per-candidate block in
  schedule order — `JOB_READY` (§28:1852) per dispatched job with `at` = the
  max of its dependencies' finish stamps (run `startedAt` for
  dependency-free jobs), `JOB_SUCCEEDED`/`JOB_FAILED` (the documented §28
  vocabulary extensions — §28 names no job-terminal events) at each job's
  own finish stamp, `PHASE_COMPLETED` only for the phase that reached
  terminal success on every job — every `at` a pure function of the report
  (never `Date.now()`); re-ingest leaves the DAG rows idempotent while
  events append a fresh deterministic block,
- `PRAGMA integrity_check` returns `ok`,
- the source fixture is byte-identical after ingestion (persistence is
  read-only over evidence — T-002 rule),
- ingest into an unopenable DB path (existing directory, or missing parent
  directory) throws — the loud, non-fatal failure the CLI catches.

Structural safety from cleanup: the DB is a bare file under the run root
(`C:\swarm\refinery.db`); clean `--all` sweeps only directories matching
`/^\d{14}$/` (`src/clean.ts:249-252`), never a bare file, so the store is
outside every cleanup path (Gate 1.5 stays green with the hook in place).

Not pinned here and not permanently required: pipeline no-behavior-change
(exit code, stdout verdicts, `report.json` content) was proven once by a real
`npm run verify:full` run recorded in T-003's Landed section. Gate 2 is not
extended for the store — spending model tokens on every verify buys nothing.

## Gate 1.7 — dag dump CLI (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-dag.mjs
```

Pins the read-only job-DAG dump (T-006): `npm run dag -- --run <runId>
[--db <path>] [--json]` (`src/dag.ts`, the clean/integrate standalone-entry
pattern) prints a run's recorded DAG — its phases, jobs, and dependency
edges; `--json` emits the same structure as JSON (what a future
scheduler/dashboard would consume). This is the repo's first DB readback:
post-hoc inspection of what ingest already recorded, feeding no verdict
(decisions.md: machine gates decide survival). `--db` defaults to
`C:\swarm\refinery.db` — same literal as `src/cli.ts` (decisions.md: run root
is `C:\swarm\`).

The gate ingests the vendored fixture into a fresh temp DB and asserts:

- `--run <runId>` exits 0 and prints the phases, jobs, and edges sections;
  `--json` exits 0 and parses to exactly the derived structure — one `main`
  phase with no dependencies, one job per candidate (`jobId` = candidate id,
  `workerId`/`model`/`brief` verbatim, empty dependencies), zero edges,
- refusals exit non-zero with nothing on stdout (the T-005 refusal pattern):
  an unknown runId (message names it), a missing DB file — and the dump must
  not create an empty `refinery.db` as a side effect (asserted absent
  afterward) — and a missing `--run` (message names the requirement),
- the dump never writes: the DB file is byte-identical (sha256 before/after
  both dumps), and a write against a `readOnly`-opened handle throws —
  pinning the open option itself against node:sqlite churn (Known issues #7).

## Gate 1.8 — attempts + bounded same-config retry (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-retry.mjs
```

Pins the T-007 runner semantics: per-job Attempt records in the report plus a
bounded same-config retry (`--max-attempts`, default 1), with the
`CandidateReport.attempts` array added (report-shape change). The check
drives `runSkeleton` directly with a **fake `WorkerAdapter`** (the seam at
`src/types.ts` makes this trivial — the engine stays harness-agnostic) and
fake `Gate` objects against throwaway fixture repos (one per scenario, so
`swarm/*` branch namespaces cannot collide; list-form git calls only), zero
model tokens. It asserts:

- **fail-once-then-succeed × `maxAttempts` 2** → exactly two attempts;
  attempt 1 `failed` with a `FailureRecord` (reason `worker-failed`, exit
  code, not timed out), attempt 2 `succeeded` with no failure record; the
  final candidate's verdict is identical in shape to today's (worker ok,
  gates pass, `diffBytes > 0`, no error) and its `workspacePath` is the final
  attempt's worktree; the worker executed exactly twice; the on-disk
  `report.json` carries the attempts arrays (the store ingests the artifact).
- **fresh workspace per attempt (spec §15.1)**: attempt 1 leases `wt/<id>`
  (branch `swarm/wt-c01`), attempt 2 leases `wt/<id>-a2` (branch
  `swarm/wt-c01-a2`) at the same `baseSha` (both worktrees' `rev-parse HEAD`
  equals the run base); attempt 2's diff contains only its own change —
  nothing adopted from attempt 1's worktree or branch; one branch per
  attempt, each leased by exactly one worktree, no collisions.
- **attempt-scoped evidence**: attempt 1's `worker.log`/`diff.patch` survive
  at today's paths (`<id>/worker.log` is not overwritten — its content is
  still attempt 1's), attempts ≥ 2 write under `<id>/attempt-<n>/`, and each
  attempt's `outputArtifacts` names its own paths with the files existing on
  disk (a thrown attempt names just its `worker.log`).
- **the bound eliminates**: an always-failing worker yields exactly
  `maxAttempts` attempts and the candidate's final verdict is the same
  elimination the ladder produces today (worker failed, no gates pass).
- **default is today's behavior**: with `maxAttempts` 1 (the CLI default) a
  succeeding candidate records exactly one `succeeded` attempt with today's
  lease id (`wt/c01`), branch (`swarm/wt-c01`), and evidence paths
  (`<id>/worker.log`, `<id>/diff.patch`), and no attempt-scoped directory; a
  failing one records exactly one attempt and is eliminated as before —
  the only report difference is the added `attempts` array of length 1.
- **retry fires only on the mechanical legs**: a worker that succeeds with a
  zero-byte diff, or succeeds and fails gates, is eliminated exactly as
  today and never re-rolled (no-op-then-pass and gates-fail-then-pass fake
  workers produce exactly one attempt each, with the attempt `succeeded` and
  no failure record); a thrown attempt (ladder leg `error`) IS retried —
  attempt 1's `FailureRecord` carries reason `error`, the message, exit code
  null, `timedOut` false — and the retried candidate passes.
- **input-context hash**: the same brief+model hashes identically across
  attempts (64-hex sha256 over brief + model + the composed prompt with the
  workspace-path line excluded — the §7.7 fingerprint narrowed to what has a
  producer); `promptVersion` is null on every attempt.
- **CLI**: `--help` documents `--max-attempts <n>` (default 1, values < 1
  refused); `--max-attempts 0` (and a non-integer) refuse with exit 1
  naming the flag, before the checkout lock is taken or any artifacts dir
  exists (the run root stays empty, no `locks/` directory).

Not pinned here: a real harness retry (Gate 2 exercises real workers with
default `maxAttempts` 1 — no behavior change), §15.2/§29 startup
reconciliation (`abandoned` has no producer until the reconciliation slice),
§30's other failure policies, and the full §7.7 fingerprint (Milestone-2
context system).

## Gate 1.9 — approval gates (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-approvals.mjs
```

Pins the durable approval records (T-008): the `approval_gates` table (schema
v4) in the T-003 store, written only by `requestApproval`/`decideApproval`
through the standalone `npm run approvals` CLI (`src/approvals.ts`, the
clean/integrate/dag standalone pattern) — `request` records
`waiting_for_approval` for a finished run's survivors, `decide` records
`approved`/`rejected` on one pending row, `list` is the pending-approval
queue (spec §26.6's Milestone-7 UI, token-free precursor, exactly as the
`dag` dump is §26.2's). Zero behavior change to the pipeline: plain ingest is
approval-blind and nothing automated consumes a decision this slice — the
value delivered is the durable decision record and the queue; the successor
ticket that wires approval state into `integrate` extends T-005's refusal
contract and owns its own Gate 2 run.

**Wall-clock scoping of the determinism rule — documented, not discovered:**
ingest's stamps stay pure functions of the report (never `Date.now()`), but
approval requests and decisions are primary human facts no report carries, so
their rows (`requested_at`/`decided_at`) and events are legitimately
wall-clock stamped, written only by operator action through the CLI. The
determinism rule continues to govern everything report-derived (`ingest` is
untouched). The gate pins both halves: approval stamps parse as ISO-8601 and
differ from the report's own stamps, while `RUN_CREATED` stays at the
report's `startedAt`.

The check ingests the vendored fixture into fresh temp DBs (plus its
elim-variant, where c02's build gate fails and only c01 survives) and drives
ingest and the CLI as separate subprocess invocations — each subcommand sees
the state the previous process persisted, proving state lives in the DB, not
in any process. That is the exercisable form of "survives orchestrator
restart" today; the paused-execution form is carved until the scheduler or
crash-recovery slices exist (T-007's carve stands). It asserts:

- plain ingest is approval-blind: zero `approval_gates` rows and no
  `APPROVAL_*` events — approval state exists only through explicit operator
  action,
- `request` records the queue: exactly one row per surviving candidate keyed
  `(run_id, phase_id, job_id)` with `phase_id` from T-006's derived phase and
  `job_id` = candidate id, state `waiting_for_approval`, `requested_at`
  wall-clock, `requested_by` recorded (`--by` or the OS username default) —
  plus exactly one `APPROVAL_REQUESTED` event per row, `at` the row's own
  stamp, payload naming phase/job/requester; `--job` narrows to one; jobs
  already carrying an approval row are skipped, never rewritten
  (additive-only); survivors only — the elim-variant run records nothing for
  the eliminated candidate,
- `decide --decision approved|rejected` flips the row with
  `decided_at`/`decided_by` recorded and appends exactly one
  `APPROVAL_GRANTED` / `APPROVAL_REJECTED` event — `APPROVAL_REJECTED` is
  the slice's documented vocabulary extension (spec §28 names no rejection
  event),
- rejection corrupts nothing: after a reject, `runs`, `candidates`, and
  `gate_results` rows are value-identical to before (full-table comparisons),
  every prior event row (seq, type, at, payload) is unchanged with exactly
  one row appended, and `PRAGMA integrity_check` returns `ok`,
- the queue view: `list` exits 0 and prints pending rows; decided rows drop
  out of the default queue; the empty queue prints `no pending approvals`;
  `--json` emits the same structure as JSON,
- read-only views never write: the DB file is byte-identical (sha256
  before/after `list` and `list --json`; readOnly open), and a write against
  a readOnly-opened handle throws — the Known issues #7 node:sqlite churn
  guard, same as Gate 1.7,
- refusals exit non-zero with nothing on stdout and no DB side effects:
  missing DB file for all three subcommands (no subcommand ever creates a
  `refinery.db` — asserted absent afterward), unknown runId on request and
  decide (`list --run` is a filter — an unknown run simply has an empty
  queue, stated rather than smoothed over), request/decide for an eliminated
  candidate (the refusal names the rule: an approval must not resurrect one
  — decisions.md 2026-10-10, gates decide survival), decide on an unknown
  job or a survivor with no recorded request, double-decide (the refusal
  names the row's current state — the audit record is not rewritable),
  unknown `--decision` value, missing flags, unknown subcommand — and the
  refusals wrote nothing (row/event counts re-checked after),
- process death: request, decide, and list run as separate processes and each
  sees the state the previous one persisted.

Not pinned here and carved by the ticket: the `'cancelled'` state and
`APPROVAL_CANCELLED` event (no producer until an abort/cancel slice), §24's
other outcomes (`return to generation`, `pin candidate for later`), §26.6's
UI (the CLI `list` is the precursor), approval-gate enforcement anywhere in
the pipeline (`npm run integrate` does not gate on approval state), and
in-run pause/resume.

## Gate 1.10 — deterministic scheduler (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-scheduler.mjs
```

Pins the T-009 scheduler: the minimal `--jobs` spec (the §6.3/§6.4 subset —
only fields with a producer; `completion` accepts only `"all"`; job ids are
`[a-z0-9][a-z0-9-]*` so derived lease/branch names stay collision-free),
`src/scheduler.ts`'s pure ready-queue function, the DAG-driven runner loop
in `src/runner.ts` under the existing concurrency cap, the T-007 retry rule
verbatim with attempt-scoped `wt/<jobId>-a<n>` leases, phase completion
`all`, lazy leasing at the run's `baseSha`, and the recorded
`RunReport.schedule` block. No existing gate can pin scheduler behavior —
the fast tier never runs the pipeline and Gate 2 spends model tokens and
cannot assert determinism — so this gate drives the exported pure function
directly and the runner end-to-end with a **fake `WorkerAdapter`** (the
`src/types.ts` seam; the Gate 1.8 pattern) against throwaway fixture repos
(one per scenario, list-form git calls only), zero model tokens. It asserts:

- the ready-queue function is pure and dependency-safe on synthetic DAGs
  (chain, diamond, independent, mixed): only jobs whose every dependency has
  reached terminal SUCCESS are returned — a terminal-FAILED dependency
  blocks its dependents for good while independents stay ready — tie-broken
  by ascending job id, bounded by the cap minus in-flight, with identical
  inputs giving identical output and no input mutated; the determinism
  contract is the ready order (never wall-clock, never insertion order,
  never model opinion), documented in `src/scheduler.ts`,
- `parseJobsSpec`: phase dependencies expand to job edges (every job of a
  phase depends on every job of each phase it depends on), defaults apply
  (`completion: "all"`, empty dependencies), optional per-job
  `model`/`worker`/`timeoutMs`/`gates` are preserved, and every refusal
  names its offense: unknown fields (including `approvalGate`,
  `earlyStop`, and the §6.4 policy fields), non-`all` completion, empty job
  set, duplicate ids, id charset violations, unknown phase references,
  job-less phases, unknown dependencies (T-006's validator message), and a
  cycle — job-level or surfacing through expanded phase edges — whose
  refusal names the cycle (T-006's `cycleRefusal`),
- determinism end-to-end: two runs over the same `--jobs` spec with the same
  fake-worker outcomes produce identical recorded schedule blocks (per-job
  `dispatchIndex` equal across the reports), under a cap-1 two-phase DAG and
  a wide-cap chain; concurrent completion interleaving is not deterministic
  and is not claimed to be,
- the concurrency cap is never exceeded: the fake adapter counts in-flight
  executions; on five dependency-free jobs under cap 2 the observed maximum
  is 2 (parallelism observed, never exceeded) with every job executed
  exactly once,
- dependent jobs dispatch only after their dependencies reach terminal
  success — across phases via expanded phase edges (the fake adapter records
  the worker call order; the recorded `dispatchIndex` and expanded edges
  agree with it),
- the T-007 retry rule verbatim in `--jobs` mode: fail-once-then-succeed
  requeues the job as a fresh attempt in `wt/<jobId>-a<n>` at the same
  `baseSha` (exactly two attempts, one dispatch, one branch per attempt, no
  collisions); an always-failing worker hits the `maxAttempts` bound and the
  job records terminal failure; a succeeded-but-no-op or gates-failed leg is
  never re-rolled (exactly one attempt, job failed); a thrown leg IS
  retried,
- phase completion `all`: a failed job fails its phase, the dependent
  phase's job is never dispatched — recorded as not-dispatched
  (`dispatchIndex: null`, no candidate report, no branch/worktree ever
  created), never fabricated as terminal — and the independent phase still
  runs to completion (`completed`),
- default mode is today's behavior: without `--jobs`, candidate ids in
  order, one dispatch per candidate, today's lease ids/branches and evidence
  paths (`wt/<id>`, `swarm/wt-<id>`, `<id>/worker.log`, `<id>/diff.patch`),
  the runner's stdout attempt/gate lines unchanged, and **no `schedule`
  block** in the report (in memory or on disk); the degenerate one-phase
  spec is synthesized and driven through the same loop, and the legacy
  fan-out is deleted,
- spec refusals exit 1 and write nothing, before the checkout lock, repo
  validation, or any artifacts dir exists (the T-007 CLI-refusal pattern):
  each bad spec is refused through the real CLI with a non-git `--repo`, so
  the jobs refusal winning over the repo error proves the ordering, and the
  run root stays empty (no artifacts dir, no `locks/` directory) across all
  refusal cases; `--help` documents `--jobs <path>`.

Not pinned here and carved by the ticket: completion policies beyond `all`
(quorum, all-machine-gates, at-least-n — no requeue/elimination semantics
defined), `earlyStop`/`approvalGate` in the spec (refused until their
successor tickets land), in-run approval pause and restart reconciliation
(§29, the T-007/T-008 carves stand), live in-run event emission (ingest
stays post-hoc and derived), and any adapter change (`src/worker/opencode.ts`
untouched; Gate 3 n/a). The real-harness face of the rewritten loop is
pinned once at landing by a real `npm run verify:full` (recorded in T-009's
Landed section) — not a permanent Gate 2 extension.

## Gate 1.11 — startup reconciliation (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-recovery.mjs
```

Pins T-010: the in-run evidence producer recovery consumes, and the
standalone `npm run recover -- --run <runId> [--db <path>] [--run-root
<path>] [--force-lock]` (src/recover.ts, the clean/integrate standalone
pattern) that reconciles a run the orchestrator died in — marks + kills +
inspection + disposition, and it NEVER reruns anything (no lease, no worker,
no scheduling; recovery.json has no consumer this slice — the resume
scheduler is its own successor ticket).

The evidence producer is `<runDir>/dispatch.jsonl` (written by runSkeleton,
src/runner.ts): a `run` header line
(`{type:'run', runId, repo, baseSha, goal, model, maxAttempts, startedAt}`),
one `dispatch` line per attempt
(`{type:'dispatch', jobId, attempt, leaseId, branch, worktreePath,
startedAt}`), one `pid` line per attempt as soon as the adapter knows its
root pid (`{type:'pid', jobId, attempt, pid, at}` — engine-supplied
`WorkerExecutionRequest.onSpawn`, called by an adapter once, right after
spawn), and one `completion` line per adapter-resolved attempt
(`{type:'completion', jobId, attempt, ok, timedOut, exitCode, diffBytes,
endedAt}` — a thrown attempt gets none, so recovery conservatively treats it
as recorded-running and can still kill its recorded pid). Best-effort
appends that can never break a run (the adapter's appendLog posture); part
of the run's evidence set, never deleted, structurally ignored by `clean`.
`WorkerResult.pid` carries the same pid for the completion record. The store
is post-hoc only, so a hard-killed run leaves partial evidence instead of
zero DB rows.

**Wall-clock scoping of the determinism rule — documented, not discovered
(the T-008 precedent):** abandonment stamps are primary recovery facts no
report carries — the report was never written, the run died — so the
attempts rows and `ATTEMPT_ABANDONED` events written by
`recordAbandonedAttempts` (the second DB writer, src/store/index.ts) are
legitimately wall-clock stamped (`started_at` from the dispatch evidence,
the abandonment stamp from the moment of recovery). The determinism rule
continues to govern everything report-derived: `ingest` is untouched and
stays a pure function of the report (Gate 1.6 stays green).

The check drives the runner with a **fake `WorkerAdapter`** (the
src/types.ts seam; the Gate 1.8/1.10 pattern) whose real child is a spawned
node sleeper, and builds the kill-mid-run scenario for real: a subprocess
"orchestrator" (tsx + runSkeleton, holding the T-004 checkout lock the way
src/cli.ts does) is killed **by pid only** (`taskkill /F`, no `/T`),
leaving a real orphaned worker (spawned detached, since node binds
non-detached children to the parent's lifetime on Windows), a stale lock,
and zero DB rows — exactly the spec §15.2 shape. All process assertions run
against the real process table, never a mock. It asserts:

- **evidence**: every run writes dispatch.jsonl with the four line shapes
  above (pid recorded through onSpawn before any hang, dispatch before pid
  before completion, completion carrying the captured diffBytes); a
  completed run's exit code, stdout verdict lines, and report.json are
  unchanged (the T-009 default-mode assertions stay green in Gate 1.10);
- **the lock refusal**: the crashed run is refused by `recover` without
  `--force-lock` — exit 1 naming the holder pid and lock path, and nothing
  written (no recovery.json, no DB file, the orphan still alive);
- **the kill, verified**: with `--force-lock`, recover proceeds, releases
  the lock on every path (no residual `.lock` files), and the recorded
  orphan is identity-verified live (creation time inside the dispatch
  evidence window — Windows reuses pids; §15.2:1071 applies symmetrically to
  killing) and then actually dead;
- **durable abandonment marks**: the un-completed attempt becomes exactly
  one `attempts` row (state `abandoned`, failure reason `abandoned`,
  `process_identity` = `{pid, startedAt, leaseId, branch}` from the dispatch
  record, `started_at` from the dispatch stamp) plus exactly one
  `ATTEMPT_ABANDONED` event; the completed attempt of the same killed run is
  NOT fabricated into the store; `runs`/`candidates` stay empty;
  `PRAGMA integrity_check` returns `ok`;
- **verify-before-kill never blindly kills** (§15.3:1080): a recorded-but-
  dead pid (`pid-not-alive`), a dispatch with no recorded pid
  (`no-pid-recorded`), and a live pid outside the evidence window
  (`identity-mismatch` — by construction: a backdated dispatch record naming
  the live gate process) are each reported as cleanup failures with no kill
  attempt, the command exits non-zero, the marks still land, and the lock
  file's (dead) orchestrator pid is never consulted;
- **workspace inspection is report-only**: every worktree under `wt/` (plus
  the dispatch records' paths, with the no-report.json fallback) is listed
  with branch and dirty state, and worktrees, branches, logs, diffs, and
  dispatch.jsonl are byte-identical afterwards — no disposal happened (Gate
  1.5 pins clean's own semantics);
- **retry disposition from dispatch records only**: completion `ok` +
  `diffBytes 0` ⇒ terminal `no-op` (a machine verdict is never re-rolled);
  attempts used ≥ the dispatch header's maxAttempts ⇒ terminal
  `bound-exhausted`; everything else (never completed, `!ok`, timedOut, or
  completed with a diff but no durably recorded verdict) ⇒ `retryable` while
  the bound allows — pinned across the real kill-mid-run scenario at
  maxAttempts 1 and 2, and synthetic evidence;
- **refusals exit non-zero and write nothing**: missing `--run`, unknown
  run dir, a finished run (report.json present), an already-reconciled run
  (recovery.json present — a second recover names it, and appends no
  events);
- **a pre-T-010 crash** (no dispatch.jsonl) reconciles inspection-only:
  exit 0, workspaces listed, nothing marked, no DB created, and the report
  records the note;
- **recovery never reruns**: no new worktree, no new branch, dispatch.jsonl
  byte-identical, and recovery.json is the only new artifact.

Not pinned here and carved by the ticket: resume scheduling / rerunning
(the "run continues correctly after restart" half of §35 — recovery.json has
no consumer until the successor ticket), §29 steps 6/8 (artifact/hash
validation, waiting-approvals preservation — needs T-008's records), the §27
`workspace_leases` table and §16 lease GC, adoption of process or worktree
state (any future rerun is a fresh lease), and Windows Job Objects (§15.3
"Later" — `killTree`'s `taskkill /T /F` stays). Gate 2 runs once at landing
(`src/runner.ts` is on the trigger list), recorded in T-010's Landed section
— not a permanent extension. Gate 3 runs once at landing (adapter change:
`onSpawn` + `WorkerResult.pid`).

## Gate 2 — harness end-to-end (minutes, spends model tokens)

```bash
npm run verify:full
```

Runs a real two-tier skeleton run (GLM-5.3 planner + flash workers, 2 candidates) on a
fresh fixture, then asserts on the artifacts:

- every candidate's worker exited 0,
- every diff is non-empty (`diffBytes > 0` — the NO-OP rule, AGENTS.md #7),
- every gate passed,
- the planner produced briefs (`planner.ok`, no fallback),
- every passing candidate was reviewed: `review.json` on disk, `review.ok`, observations
  well-formed with severity in {info, concern, blocker-advisory} (T-001),
- failing candidates were NOT reviewed — gates decide, review is advisory,
- the canonical repo is clean afterward (`git status --short` empty, only `main` in
  `worktree list`, no `swarm/*` branches left),
- no stray fixture files in this repo directory (the contamination check from the
  PWD-bug incident),
- the run's worktrees and branches are disposed through the clean command
  (`tsx src/clean.ts --run <runId> --run-root <verify root> --force`; `--force`
  is correct here — the run captured the evidence before disposal) (T-002).

Required when touching `src/runner.ts`, any adapter, gates, workspace handling, or
anything that changes report shape. Fast tier alone does not clear you here.

## Gate 3 — harness directory-resolution probe (adapter changes only)

```bash
node scripts/diag-pwd.mjs <any-git-dir>
node scripts/diag-pwd.mjs <any-git-dir> <same-dir-as-PWD-override>
```

Required when adding or changing a worker adapter, or after an opencode upgrade. Pass:
without override, the harness reports the directory it was spawned in; with the
override it reports the override target. A harness that reports something else does not
get trusted with worktrees — see Known issues #1.

## Known issues

1. **OpenCode resolves its project directory from `env.PWD`, not the process cwd**
   (verified on opencode-ai 1.18.35, Windows). Any spawn must set
   `PWD`/`OLDPWD` to the intended cwd — done in `src/worker/opencode.ts`. First run
   before the fix: all three workers edited the orchestrator repo while gates blessed
   untouched worktrees and everything reported PASS; only zero-byte diffs exposed it.
2. **`opencode run` has no directory flag** (`--help` confirmed) — cwd + env pinning is
   the only mechanism. `opencode run` also auto-attaches to a running server if one
   exists (`--attach` in help); kill stale opencode processes before measuring.
3. **`glm-5.3-highspeed` is not in the plan.** The default `build` agent resolves to it
   when no `-m` is given and fails after ~70s of retries with exit code 0 through a
   pipeline. Always pass `--model`/`-m` explicitly; never trust harness defaults.
4. **Git Bash mangles variables inside double-quoted backslash paths** (`wt\$c` became
   a literal `$`). Use forward-slash paths or explicit literals in shell commands.
   Post-run disposal no longer touches this hazard at all: it goes through
   `src/clean.ts`, whose git calls are list-form (T-002).
5. **CRLF warnings from git on fixture files are benign** (`.gitattributes` normalizes;
   the fixture regenerates from scratch each run).
6. **The planner's read-only-ness is prompt-reinforced only** — it runs with build-agent
   write tools in the target repo cwd. Mechanism-level capability restriction lands
   with the worker permission model (spec §14). Until then, planner output and the
   repo state after Gate 2 are the tripwire.
7. **`node:sqlite` is experimental on Node 22** — first use emits
   `ExperimentalWarning: SQLite is an experimental feature and might change at any
   time` on stderr (benign), and the API may churn across Node minors. Named
   fallback: `better-sqlite3` — a native dependency that would need its own
   docs/decisions.md entry against the 2026-10-10 "TypeScript on Node 22" decision.
   `src/store/index.ts` uses only DatabaseSync open/exec/prepare semantics.
   Gate 1's stderr therefore contains this warning; it is not a failure.

## Definition of done (per ticket)

- every acceptance criterion demonstrably true and naming its pinning gate,
- Gate 0 (+ Gate 1) green; Gate 2 run when the change touches the pipeline,
- ticket status flipped and index updated in the same change,
- VERIFICATION.md extended in the same change if the change adds behavior,
- no weakened assertions, no ride-along changes.
