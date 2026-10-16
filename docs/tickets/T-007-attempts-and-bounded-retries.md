# T-007 — Attempt records + bounded same-config retry

**Status:** done 2026-10-16
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 3
**Depends on:** T-006 (done 2026-10-16; transitively T-003)

## What

Third slice of the stage-1 durable control plane (spec §34 Milestone 1's separate
"attempts" and "retries" build items, `docs/spec/inference-refinery-v2.md:2023,2025`):
per-job Attempt records in the store (§6.5) plus a bounded same-config retry in the
runner — a failed job re-runs as a fresh attempt with complete audit history, bound
enforced, default behavior unchanged. This is the first slice that changes the
runner's execution semantics: T-003 and T-006 explicitly carve runner changes;
T-002/T-004/T-005 added commands around the pipeline, not inside it.

- **`src/types.ts` — attempt types, vocabulary chosen here.** The spec uses
  `AttemptState`/`FailureRecord`/`ProcessIdentity`/`RetryPolicy` only as field types
  (§6.4:364, §6.5:379,384,391) and never defines any of them (grep over the whole
  spec — the four names have exactly those four hits); §22:1309-1329 is the JOB state
  machine, not attempts. So this ticket picks and documents the vocabulary:
  - `AttemptState = 'running' | 'succeeded' | 'failed'` — only `'succeeded'`/`'failed'`
    have a producer this slice (a finished-run store records terminal states);
    `'abandoned'` (spec §15.2:1067/§29:1874 vocabulary) is added by the carve-off
    reconciliation slice, not pre-defined here.
  - `FailureRecord = { reason, message, timedOut, exitCode }` — `reason` reuses the
    existing elimination-ladder vocabulary (`error | worker-failed | no-op | no-gates |
    gates-failed`, `src/store/index.ts:207-213`); retryable attempts only ever produce
    `error`/`worker-failed`.
  - `RetryPolicy = { maxAttempts: number }` — narrowed to the one policy this slice
    drives (§30:1893 "retry same worker once", generalized to a bound). §30's other
    policies are carved off (below).
  - `Attempt` per §6.5:374-393 — `id` (`<candidateId>-a<n>`), `jobId` (the candidate
    id; T-006 derives one job per candidate), `number` (1-based), `state`,
    `startedAt`/`endedAt` (stamped in-run, like `RunReport.startedAt`,
    `src/runner.ts:46` — part of the report artifact, so ingest stays a pure function
    of it), `inputContextHash`, `promptVersion: string | null` (null this slice —
    §6.5 types it nullable; §6.7:446/§18:1207 have no producer until prompt
    versioning exists), `outputArtifacts: string[]`, `failure?: FailureRecord`,
    `processIdentity?`/`workerSessionId?` — optional and null this slice: no producer
    (`WorkerResult`, `src/types.ts:21-29`, carries neither; `child.pid` is in hand at
    `src/worker/opencode.ts:40` but unreturned; §11:847's `cancel(attemptId)` is
    carved).
  - `CandidateReport` gains `attempts: Attempt[]`. The existing top-level fields
    (`workerOk`, `workerDurationMs`, `diffPath`, `diffBytes`, `gates`,
    `passedAllGates`, `error`) keep their meaning as **the final attempt's** values,
    so the verdict ladder (`src/cli.ts:216`), the run summary, and the store's
    per-candidate writes are unchanged. Gates attach only to the final attempt
    (retryable legs never reach gates — see the retry rule below), so no per-attempt
    gate results this slice. Additive field = report-shape change = owns the one
    Gate 2 run (VERIFICATION.md:200-201).
- **`src/runner.ts` — bounded per-candidate retry in `runCandidate`
  (`src/runner.ts:226-302`, which today executes the worker exactly once,
  `:246-252`).**
  - `SkeletonOptions` gains `maxAttempts: number` (default 1).
  - **Retry rule (mechanical, and a documented decision):** an attempt that throws
    (ladder leg `error`) or whose worker fails (`!workerOk` — non-zero exit or
    timeout) is retried while `attempts.length < maxAttempts`. A worker that
    *succeeded* but produced a zero-byte diff or failed gates is **not** retried —
    those are verdicts (`no-op`/`gates-failed` on the ladder), and re-rolling until
    gates pass would be model-shopping around a machine verdict (decisions.md
    2026-10-10 "machine gates decide survival"; AGENTS.md #7; §30's
    "eliminate candidate" stands for those legs). Same gates re-run per attempt;
    a retried attempt with a zero-byte diff is still a NO-OP, never a pass
    (`diffBytes > 0` enforcement, `src/runner.ts:275`).
  - **Fresh workspace per attempt (§15.1:1059-1061):** attempt 1 leases `wt/<id>`
    exactly as today (`src/runner.ts:63`, branch `swarm/wt-c01` via
    `branchForLeaseId`, `src/workspace/worktree.ts:10-13`); attempt n ≥ 2 leases
    `wt/<id>-a<n>` at the same `baseSha`. Never the old attempt's worktree, branch,
    or process state — a fresh attempt adopts nothing (§15.1 "running attempts are
    not assumed to be adoptable"; consistent with T-004's stale-lock philosophy,
    VERIFICATION.md:78-82). Attempt-scoped lease ids also avoid the documented
    branch-collision hazard: two leases on `wt/<id>` both derive `swarm/wt-c01`
    (T-004's hazard note) and attempt 2 would overwrite `<id>/worker.log`
    (`src/runner.ts:250`).
  - **Attempt-scoped evidence paths:** attempt 1 keeps today's exact paths
    (`<runDir>/<id>/worker.log`, `<runDir>/<id>/diff.patch`) — clean/integrate/Gate 2
    discovery keeps working unchanged; attempts ≥ 2 write
    `<runDir>/<id>/attempt-<n>/worker.log` and `diff.patch`. Each attempt's paths go
    into its `outputArtifacts`.
  - Retries happen inside the candidate's lane, so lane/concurrency semantics are
    untouched.
- **`src/store/index.ts` — `attempts` table, `SCHEMA_VERSION` 2 → 3** (on top of
  T-006's 1 → 2), `CREATE TABLE IF NOT EXISTS` so existing DBs gain it on next ingest
  (T-006's additive precedent; no migration machinery):
  `attempts (run_id, job_id, attempt_number, state, started_at, ended_at,
  input_context_hash, prompt_version, process_identity_json, worker_session_id,
  output_artifacts_json, failure_json)` — PK `(run_id, job_id, attempt_number)`,
  `job_id` = candidate id. Columns narrowed to producers: `prompt_version`,
  `process_identity_json`, `worker_session_id` written null this slice — stated, not
  smoothed. Ingest derives rows from the report's `attempts` arrays; stamps copied
  from report-carried values, never `Date.now()` (`src/store/index.ts:8-11` rule).
  `input_context_hash` = sha256 over brief + model + the composed prompt **with the
  workspace-path line excluded**, so the same brief+model hashes identically across
  attempts (an input-context hash compares inputs, not worktree paths). This is the
  §7.7:611-621 fingerprint narrowed to what exists; the full version adds prompt
  version, role version, selected artifact IDs/hashes, reasoning configuration, and
  project-manifest version (§7.7:615-620) — none has a producer until the Milestone-2
  context system.
  - **Events:** exactly one derived `ATTEMPT_STARTED` per attempt (spec
    §28:1853 vocabulary), `at` from the attempt's recorded `startedAt` —
    deterministic and append-only like the rest. `ATTEMPT_ABANDONED` (§28:1863) has
    no producer this slice (reconciliation carve). Re-ingest: attempts upsert by
    natural key inside the same transaction; `events` never rewrites prior rows.
- **`src/cli.ts` — `--max-attempts <n>`**, default 1 (today's behavior), values < 1
  refused at parse time (exit 1 before the lock, repo validation, or any artifact
  dir exists), documented in the usage text. The bound is CLI configuration and
  plain engine logic — zero model knowledge (decisions.md: engine is
  model/harness-agnostic). Adapters untouched: `src/worker/opencode.ts` stays the
  only harness-aware file.
- **New Gate 1.8 — `scripts/check-retry.mjs`** (fast tier, token-free), hooked into
  `scripts/verify.mjs` after Gate 1.6 (before the fast-tier finish,
  `scripts/verify.mjs:448`) — the T-003/T-005 slice-owns-its-gate precedent. No
  existing gate can pin retry behavior: the fast tier never runs the pipeline and
  Gate 2 spends tokens. The check drives `runSkeleton` directly with a **fake
  `WorkerAdapter`** (the seam at `src/types.ts:35-38` makes this trivial) against a
  throwaway fixture repo (the Gate 1.5/demo-target sandbox pattern, list-form git
  calls), and asserts: fail-once-then-succeed × `maxAttempts 2` → exactly two
  attempts, attempt 2 in a fresh baseSha-clean worktree, final candidate passes;
  always-failing × `maxAttempts 2` → exactly two attempts then eliminated;
  default → exactly one attempt with today's paths; attempt-scoped evidence exists
  and attempt 1's survives; no branch/worktree collisions; no-op-then-pass is NOT
  retried; CLI parse refusals (`--max-attempts 0`) and the usage line.
- **Extended Gate 1.6 — attempt assertions in `scripts/check-store.mjs`**, using a
  retried-candidate fixture variant hand-built from
  `scripts/fixtures/report-real.json` exactly like the eliminated-candidate variant
  (`scripts/check-store.mjs:88-107`): row shape/values, `ATTEMPT_STARTED`
  derivation, re-ingest idempotency with append-only events, `integrity_check`.
- **VERIFICATION.md** gains the Gate 1.8 section and the extended Gate 1.6
  description in the same change-set (AGENTS.md #6).

**Does NOT claim:**

- **No §15.2/§29 startup reconciliation** (`running` → `abandoned`, requeue
  retryable, process-tree sweep): it has no exercisable home — a run is one process
  (`src/cli.ts:143-162` → `runPipeline`), no scheduler exists (T-006:69-73 carves
  it; `docs/ROADMAP.md:12` lists scheduler as remaining), so any criterion naming it
  would be unverifiable. Lands with the scheduler or Milestone-3 crash recovery.
  What this slice honors of §15.1 is the design rule, pinned by Gate 1.8: a fresh
  attempt never adopts the prior attempt's process or worktree state.
- **No §30 policies beyond bounded same-config retry** — no alternate model, schema
  repair, switch-worker/model, quorum, pause-for-human, abort-phase/run.
- **No adapter `cancel(attemptId)` / processIdentity / workerSessionId**
  (§11:847) — in-run timeout kill already covers termination this slice needs
  (`src/worker/opencode.ts:38-41`, kill-tree); those fields are recorded null.
- **No live in-run event emission** — T-006:71-73's carve stands; ingest stays
  post-hoc and derived.
- **No full §7.7 fingerprint** — needs the Milestone-2 context system (roles,
  context plans, artifact store); the narrowed hash and its delta are documented in
  the ticket and VERIFICATION.md.
- **No scheduler/queue consumption** — the flat fan-out stays; attempts attach to
  T-006's derived jobs (`job_id` = candidate id).

## Why

Today a single transient worker failure permanently kills a candidate and wastes
its planner brief: `runCandidate` executes the worker exactly once
(`src/runner.ts:246-252`) and failure flows straight to the verdict ladder
(`src/cli.ts:216`). Known issues #3 is a real transient shape — a harness-level
retry loop that exhausts after ~70s and surfaces as a worker failure — and one
occurrence is fatal. There is no retry machinery and no attempt record anywhere:
`src/types.ts` has no `Attempt` type (the only "attempts" are in-memory parse-repair
counters, `PlannerReport.attempts` `src/types.ts:77` / `ReviewReport.attempts`
`:97`, driven at `src/runner.ts:146-164,192-210`, plus `src/lock.ts:5`'s "no retry
loop" comment); the store is schema v1 with exactly
`runs`/`candidates`/`gate_results`/`events` (`src/store/index.ts:17-65`), whose
comment at `:19-20` explicitly reserves attempts for later slices, emitting only
`RUN_CREATED`/`GATE_FAILED`/`CANDIDATE_ELIMINATED` (`:67-68`).

Spec basis: §6.5:370-395 — the `Attempt` type, "supports retrying with a fresh
session … and complete audit history"; §15.1:1057-1061 — jobs idempotent, running
attempts never adoptable after restart; §27:1817 — `attempts` in the initial table
list; §28:1853,1863 — `ATTEMPT_STARTED`/`ATTEMPT_ABANDONED` in the event vocabulary;
§30:1888-1904 — failure-policy vocabulary ("failures … should be visible and
boring"); §6.7:446 + §18:1207 — prompt version per attempt (null here); §7.7:611-621
— the context fingerprint the narrowed hash stands in for. `docs/ROADMAP.md:12`
maps stage 1 to "remaining: job DAG, attempts, retries, approvals, scheduler" —
attempts and retries are the repo's own named next items, and the attempt history is
the foundation the scheduler (§29's "requeue retryable jobs") and approvals read.

**Dependency:** T-006 is proposed, not landed — HEAD `3adaac5` is its docs-only
commit, `src/` has no `dag.ts`, and the store has no `jobs` table (verified this
session). Attempts key on `jobId` (§6.5:376-378), so T-006 must land first; one
ticket = one change-set forbids bundling them. Until then this ticket stays
proposed.

**Honest tension, stated rather than smoothed** (T-006:101-111 precedent): the spec
never defines the attempt vocabulary — this ticket chooses `AttemptState`,
`FailureRecord`, and `RetryPolicy` and documents the choice above. Nothing consumes
attempt rows until a scheduler exists, so the immediate payoffs are (a) transient
failures stop being fatal (bounded retry), and (b) the audit history becomes
inspectable in the DB. And because this slice changes `src/runner.ts` and the report
shape after two zero-behavior-change store slices, it carries the risk they deferred:
worktree/log path collisions across attempts and harder store invariants (attempt
rows + derived events must stay deterministic and idempotent under re-ingest) —
hence Risk 3, and the owning Gate 2 run.

## Acceptance criteria

- [x] Default run is today's behavior: without `--max-attempts` every candidate
      records exactly one attempt, with today's lease id (`wt/<id>`), branch
      (`swarm/wt-c01`), and evidence paths (`<id>/worker.log`, `<id>/diff.patch`);
      the only report difference is the added `attempts` array of length 1 — pinned
      by **Gate 1.8** (default-mode assertions).
- [x] Bounded retry end-to-end: a fake worker that fails once then succeeds, with
      `maxAttempts = 2`, yields exactly two recorded attempts — attempt 1 `failed`
      with a `FailureRecord` (reason `worker-failed`), attempt 2 `succeeded` — and a
      final candidate verdict identical in shape to today's — pinned by **Gate 1.8**
      (fake `WorkerAdapter` + throwaway fixture repo, zero model tokens).
- [x] The bound is respected and failure after the bound eliminates: an
      always-failing worker yields exactly `maxAttempts` attempts, then the
      candidate's final verdict is the same elimination the ladder produces today —
      pinned by **Gate 1.8**.
- [x] Fresh workspace per attempt (§15.1): attempt n ≥ 2 runs in a new lease at the
      same `baseSha`, clean at lease time (nothing adopted from attempt 1's worktree
      or branch), and lease ids/branches never collide across attempts — pinned by
      **Gate 1.8**.
- [x] Attempt evidence is attempt-scoped: attempt 1's `worker.log`/`diff.patch`
      survive attempt 2 (no overwrite of `<id>/worker.log`), attempts ≥ 2 write under
      `<id>/attempt-<n>/`, and each attempt's `outputArtifacts` names its own paths —
      pinned by **Gate 1.8**.
- [x] Retry fires only on the mechanical legs: a worker that succeeds with a
      zero-byte diff, or succeeds and fails gates, is eliminated exactly as today and
      never re-rolled — pinned by **Gate 1.8** (no-op-then-pass and
      gates-fail-then-pass fake workers produce exactly one attempt each).
- [x] Store: ingest of a retried-candidate report produces one `attempts` row per
      attempt keyed `(run_id, job_id, attempt_number)` with
      state/started_at/ended_at/input_context_hash/output_artifacts_json/failure_json
      as recorded, and `prompt_version`/`process_identity_json`/`worker_session_id`
      null — pinned by the **extended Gate 1.6** (hand-built retried-candidate
      variant of `scripts/fixtures/report-real.json`, the elim-variant pattern
      `scripts/check-store.mjs:88-107`).
- [x] Derived attempt events stay deterministic and append-only: exactly one
      `ATTEMPT_STARTED` per attempt with `at` from the report-carried stamp (never
      `Date.now()`); re-ingest upserts attempt rows by natural key while prior
      `events` rows are untouched and `PRAGMA integrity_check` returns `ok` — pinned
      by the **extended Gate 1.6**.
- [x] CLI: `--max-attempts <n>` appears in the usage text, defaults to 1, and a
      value < 1 is refused with exit 1 before the checkout lock is taken or any
      artifacts dir exists — pinned by **Gate 1.8** (CLI parse-refusal assertions)
      and **Gate 0**.
- [x] VERIFICATION.md gains the Gate 1.8 section and the extended Gate 1.6
      description, and the ticket status + index row move in the same change-set
      (AGENTS.md #6; tickets README rules) — pinned by change-set review.
- [x] One real-pipeline `npm run verify:full` at landing, recorded in this ticket's
      Landed section — `src/runner.ts` and the report-shape change are both on
      VERIFICATION.md:200-201's trigger list; the T-003:166-175 precedent. Gate 2 is
      not permanently extended. **Not run in the lane session** — the driving
      pipeline owns it (it re-runs the fast tier and runs the full e2e gate on
      merge exactly because `touchesPipeline` is true here); recorded 2026-10-16:
      the driving script ran `node scripts/verify.mjs full` in the lane pre-merge →
      exit 0, then merged as `cfaa4fa` and re-ran the fast tier green on main.

## Landed

2026-10-16, in one change-set on `ticket/T-007-attempts-and-bounded-retries`.

- `src/types.ts` — the attempt vocabulary, chosen and documented here per the
  ticket: `AttemptState = 'running' | 'succeeded' | 'failed'` (`'abandoned'`
  left for the reconciliation slice), `FailureReason` = the elimination-ladder
  vocabulary with `FailureRecord = { reason, message, timedOut, exitCode }`,
  `RetryPolicy = { maxAttempts: number }`, `Attempt` per §6.5 field-for-field
  (`startedAt`/`endedAt` optional as §6.5 types them; `promptVersion: string |
  null`; `processIdentity?`/`workerSessionId?` absent this slice), and
  `CandidateReport.attempts: Attempt[]`. One choice the ticket left open:
  `ProcessIdentity` (the spec never defines it) is pinned as `{ pid, startedAt }`
  — the same shape the checkout lock records (`src/lock.ts`) — with no producer
  until T-010/T-011.
- `src/runner.ts` — `SkeletonOptions.maxAttempts` (required; CLI default 1);
  `runCandidate` loops attempts inside the candidate's lane. Attempt 1 keeps the
  up-front lease (`wt/<id>`); attempt n ≥ 2 leases `wt/<id>-a<n>` at the same
  `baseSha` inside the lane and writes evidence under `<id>/attempt-<n>/`.
  Retry rule exactly as specified: an attempt whose worker failed (`!workerOk`,
  non-zero exit or timeout) or that threw (ladder leg `error`) is retried while
  `attempts.length < maxAttempts`; a succeeded worker is final no matter the
  upcoming verdict (no-op / gates-failed are never re-rolled); gates run only on
  the final attempt, whose values fill the unchanged top-level `CandidateReport`
  fields, so the verdict ladder, run summary, and store per-candidate writes are
  byte-for-byte the old flow. `inputContextHash` = sha256 over brief + model +
  the composed prompt with the workspace-path line excluded (computed per
  attempt; identical across attempts for the same brief+model).
- `src/store/index.ts` — `SCHEMA_VERSION` 2 → 3; `attempts` table appended to
  `SCHEMA_SQL` with `CREATE TABLE IF NOT EXISTS` (PK `(run_id, job_id,
  attempt_number)`, the twelve ticket columns); ingest derives one row per
  recorded attempt (upsert by natural key inside the existing transaction;
  stamps copied from the report, never `Date.now()`;
  `prompt_version`/`process_identity_json`/`worker_session_id` written null)
  plus exactly one derived `ATTEMPT_STARTED` per attempt with `at` from the
  attempt's `startedAt`; `events` untouched and append-only. Reports predating
  T-007 (no `attempts` array) ingest unchanged with zero attempt rows.
- `src/cli.ts` — `--max-attempts <n>`, default 1, values < 1 (and non-integers)
  refused at parse time with exit 1 — parse runs before repo validation, the
  checkout lock, and any artifacts dir; documented in the usage text. Adapters
  untouched; `src/worker/opencode.ts` remains the only harness-aware file.
- `scripts/check-retry.mjs` (new) + Gate 1.8 hook in `scripts/verify.mjs`
  after Gate 1.7 (the T-003/T-005 slice-owns-its-gate precedent) — 41
  assertions across eight scenarios: fail-once-then-succeed ×2, always-fail
  ×2 (bound), default succeed/fail ×1, no-op-then-pass ×2 (not re-rolled),
  gates-fail-then-pass ×2 (not re-rolled), throw-once-then-succeed ×2, and
  the CLI usage/parse-refusal checks. Beyond the ticket's listed set it also
  pins the throw leg (the ticket's retry rule names "an attempt that throws"
  as retryable) and that the on-disk `report.json` carries the attempts the
  store will ingest.
- `scripts/check-store.mjs` — extended Gate 1.6 with 12 new assertions (and
  the `SCHEMA_VERSION is 3` update): zero attempt rows for the pre-T-007
  fixture, the hand-built retried-candidate variant (row values, producer-less
  columns null, the no-attempts candidate tolerated), `ATTEMPT_STARTED`
  derivation with payloads, and re-ingest idempotency with append-only events.
- VERIFICATION.md — extended Gate 1.6 section (schema v3, attempts + retried-
  variant bullets) and the new Gate 1.8 section. Ticket status + index row in
  the same change-set.

Deviations, stated rather than smoothed:

- Diff evidence is captured on **every** attempt, including retryable legs
  (gates still run only on the final attempt). The ticket fixes attempt 1's
  paths and requires each attempt's `outputArtifacts` to name its own paths;
  capturing the failed leg's diff keeps that promise honest and gives §6.5's
  "complete audit history". A thrown attempt captures no diff and names only
  its `worker.log`.
- `--max-attempts` also refuses non-integer values (`nope`), not only values
  < 1 — `Number('nope') < 1` is false, so the integer guard is what makes the
  ticket's refusal real; pinned by Gate 1.8 S8.
- Known narrow gap left as-is (no ride-along): for a retried candidate,
  `clean`'s report-driven fallback branch (`branchForLeaseId('wt/' + id)`)
  names `swarm/wt-c01` while the final attempt's worktree branch is
  `swarm/wt-c01-a2`. Benign in every git-visible state — disposal uses the
  branch observed in `worktree list --porcelain` (`src/clean.ts:216-217`) and
  wt/-discovery maps attempt directories by name (`src/clean.ts:165`) — and
  only reachable if a worktree was hand-removed while its branch survived. A
  successor touching `src/clean.ts` should derive the fallback from the last
  attempt's lease id.
- Measured gates (this lane, Node v22.23.1): Gate 0 `npm run typecheck` →
  exit 0 (green before the change too, at lane creation); Gate 1 fixture
  regenerated, `build ok` + `tests ok`, tree clean; Gate 0.5 ALL GREEN
  (17 ok); Gate 1.5 clean/lock/integrate sections ALL GREEN; extended Gate
  1.6 → 67 ok + `check-store: ALL GREEN`, exit 0, only the documented
  node:sqlite ExperimentalWarning (Known issues #7); Gate 1.7 ALL GREEN
  (22 ok); new Gate 1.8 → 41 ok + `check-retry: ALL GREEN`, exit 0;
  `node scripts/verify.mjs fast` (Gates 0 / 1 / 0.5 / 1.5 / 1.6 / 1.7 / 1.8)
  → `verify (fast) complete: ALL GREEN`, exit 0. Gate 2 not run here — owned
  by the driving pipeline at landing (see the unchecked criterion above);
  Gate 3 n/a (no adapter change; `processIdentity` stays null).

## Verification

Gate 0 (`npm run typecheck`) always — green before this change, verified 2026-10-14:
`npm run typecheck` → exit 0. Gate 1 (`npm run demo`) sanity, token-free. Gate 0.5
n/a (`src/parse.ts` untouched). Gate 1.6 green before this change, verified
2026-10-14: `node node_modules/tsx/dist/cli.mjs scripts/check-store.mjs` →
"check-store: ALL GREEN", exit 0, only the documented node:sqlite
ExperimentalWarning on stderr (Known issues #7). The **extended Gate 1.6** and the
**new Gate 1.8** run via `npm run verify` (not yet run for this ticket — no code
exists). **Gate 2 once**, at landing, recorded in Landed — required here (trigger
list: `src/runner.ts` + report shape), not a permanent extension. Gate 3 n/a (no
adapter change; `processIdentity` stays null this slice).

## References

spec §6.4 (`docs/spec/inference-refinery-v2.md:343-368`), §6.5 (`:370-395`),
§6.7 (`:446`), §7.7 (`:611-621`), §11 (`:841-849`), §15.1/§15.2 (`:1057-1071`),
§18 (`:1207`), §22 (`:1309-1329`), §27 (`:1817`), §28 (`:1853,:1863`),
§29 (`:1868-1884`), §30 (`:1888-1904`), §34 (`:2023,:2025`) · T-003 — predecessor
store slice; its Does-NOT-claim (`docs/tickets/T-003-durable-run-records.md:61-62`)
reserves the attempts table · T-006 — dependency: jobs table + `job_id` derivation ·
T-004 — stale-lock philosophy (`VERIFICATION.md:78-82`) and the branch-collision
hazard attempt-scoped leases avoid · `docs/decisions.md` (2026-10-10: Node 22 /
harness-agnostic / gates decide / `C:\swarm\` run root) · `docs/ROADMAP.md:12`.
