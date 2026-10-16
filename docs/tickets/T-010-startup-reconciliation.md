# T-010 — Startup reconciliation: abandoned attempts, process-tree sweep, retry disposition

**Status:** done 2026-10-16
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 3
**Depends on:** T-006 + T-007 (both done 2026-10-16; transitively T-003). **T-009 is NOT a dependency of this carve** — actual rerunning/resume scheduling is carved to its own successor (first Does-NOT-claim below). T-009 landed before this ticket, so the dispatch-recording hook lives in the scheduler's dispatch loop (inside `runJob`, which both modes drive); the records and the `recover` command are identical either way.

## What

The recovery half of the control plane (spec §15.2, the Milestone-3 "abandoned-job
recovery" build item, `docs/spec/inference-refinery-v2.md:2057`): a standalone
`npm run recover -- --run <runId> [--db <path>] [--run-root <path>] [--force-lock]`
that reconciles a run the orchestrator died in — marks the recorded-`running`
attempts `abandoned` with a failure record, kills the recorded worker process trees
after identity verification, inspects the temporary workspaces, and computes each
job's retryable-or-terminal disposition from T-007's retry policy. One mergeable
change-set:

- **`src/runner.ts` — the in-run evidence producer recovery consumes.** The store is
  post-hoc only (`ingest` runs after `runSkeleton` returns, `src/cli.ts:204-208`), so
  a hard-killed run leaves **zero** DB rows, and no `running` producer exists or was
  planned (T-003:59-60, T-006:71-73, T-007:147-148, T-009:139-141 all carve live
  in-run emission; T-007:41-44 records `processIdentity` null). This ticket
  deliberately ends that carve — in a bounded form: an append-only JSON-lines
  **evidence artifact**, never in-run DB writes, so ingest stays post-hoc for
  finished runs and a crashed run leaves partial evidence instead of nothing.
  - `<runDir>/dispatch.jsonl` — written by `runSkeleton` (`src/runner.ts:45-91`),
    best-effort appends that can never break a run (the adapter's `appendLog`
    posture, `src/worker/opencode.ts:87-93`):
    - a header line at run start: `{type:'run', runId, repo, baseSha, goal, model,
      maxAttempts, startedAt}` (`maxAttempts` from T-007's `SkeletonOptions`);
    - one dispatch line per attempt: `{type:'dispatch', jobId, attempt, leaseId,
      branch, worktreePath, startedAt}`;
    - one pid line per attempt as soon as the adapter knows the root pid:
      `{type:'pid', jobId, attempt, pid, at}`;
    - one completion line per attempt: `{type:'completion', jobId, attempt, ok,
      timedOut, exitCode, diffBytes, endedAt}` (`diffBytes` from the capture at
      `src/runner.ts:258-268`).
    The file is part of the run's evidence set: never deleted (the T-002 rule,
    `src/clean.ts:6-8`), structurally ignored by `clean` (it sweeps worktrees and
    `swarm/*` branches only).
- **`src/types.ts` — PID recording through the seam** (decisions.md: engine is
  model/harness-agnostic; recovery learns workspaces and pids, never model IDs):
  - `WorkerExecutionRequest` gains optional `onSpawn?: (pid: number) => void` —
    engine-supplied, called by an adapter **once, right after spawn**, when it knows
    its root process id. This is not the same as `WorkerResult.pid`: the result only
    exists at completion, and recovery must find the pid on disk *after* the crash,
    while `execute()` never resolves.
  - `WorkerResult` gains `pid: number | null` for the completion record
    (T-007:41-44's reserved seam change).
  - Adapters that cannot know a root pid never call `onSpawn` and return `pid:
    null`; recovery treats a dispatch without a recorded pid as report-not-kill.
- **`src/worker/opencode.ts` — still the only harness-aware file.** Calls
  `req.onSpawn?.(child.pid)` immediately after the spawn at `src/worker/opencode.ts:26-35`
  and sets `pid` in its result (the same `child.pid` in hand today for timeout kill,
  `:38-41`). **Gate 3 runs once** (adapter change). The Gate 1.11 fake adapter is
  fixture code behind the same seam, not a harness adapter.
- **`src/store/index.ts` — the abandonment writer, additive-only.** T-007 lands the
  `attempts` table and `AttemptState = 'running' | 'succeeded' | 'failed'`; this
  ticket gives `'abandoned'` its producer (T-007:23-26 explicitly reserved it for
  this slice) and extends `FailureRecord.reason` with `'abandoned'` (documented
  vocabulary extension — §28 names `ATTEMPT_ABANDONED` at `:1863` but no reason
  vocabulary; the T-008 `APPROVAL_REJECTED` precedent of choosing-and-documenting).
  One new exported writer, `recordAbandonedAttempts(runId, attempts, dbPath)` — the
  second DB writer after `ingest` (T-008's approval writers come in its own slice):
  writes one `attempts` row per abandoned attempt (state `'abandoned'`, `failure`
  with reason `'abandoned'`, `process_identity` = `{pid, startedAt, leaseId,
  branch}` from the dispatch record — the field T-007 recorded null now has a
  producer, `started_at` from the dispatch stamp) plus **exactly one
  `ATTEMPT_ABANDONED` event per attempt**, inside one transaction. Never touches
  `runs`/`candidates`/`gate_results` or any prior event row; **completed attempts of
  a crashed run are NOT fabricated into the store** — their evidence lives in
  `dispatch.jsonl`, and the store records only what §15.2 step 1 requires.
  - **Wall-clock deviation, documented not smoothed (the T-008:37-44 precedent):**
    abandonment stamps are primary recovery facts no report carries — the report was
    never written; the run died (`src/store/index.ts:8-11`'s "stamps derive from
    reports, never `Date.now()`" governs everything *derived*; `ingest` itself is
    untouched and Gate 1.6 must stay green). The store header comment and
    VERIFICATION.md state this scoping in the same change-set.
- **`src/recover.ts` — the standalone command** (house standalone-entry pattern:
  `tsx src/recover.ts`, like `src/clean.ts`/`src/integrate.ts`; `npm run recover`
  script; zero new dependencies). Refusals happen before any write (the
  T-006:57-61 pattern), then, under the lock:
  1. **Refuse a finished run** — `report.json` exists ⇒ the run completed, its
     records come from `ingest`, nothing to reconcile; exit non-zero.
  2. **Refuse an already-reconciled run** — `recovery.json` exists ⇒ exit non-zero
     naming it (no duplicate abandonment events; re-reading a reconciliation is
     `cat`, not a second pass).
  3. Read `dispatch.jsonl`. Absent/unreadable (a pre-T-010 crash) ⇒ inspection-only:
     workspaces are still listed and reported, with "no in-run evidence recorded —
     nothing to mark, no pids known"; exit 0 with that report (disposal for such
     runs stays `clean` + `--force-lock`, exactly today's manual path).
  4. Derive the target repo from the dispatch header, falling back to the worktrees'
     own `.git` pointers (the `sniffRepo` crash-mid-run pattern, `src/clean.ts:115-127`
     — reuse/extract that logic, do not duplicate it).
  5. **Take the T-004 checkout lock** (`lockPathFor`, `src/lock.ts:35-38`) and refuse
     without `--force-lock` (the never-auto-reap policy, VERIFICATION.md:78-82 — a
     hard-killed run's lock blocks until a human overrides, and `recover` is not an
     override); release in a `finally` on every path.
  6. **Kill the recorded trees, verify-before-kill.** A dispatch without a matching
     completion line is the recorded-`running` attempt (§15.2:1067). Its recorded
     pid is killed via `killTree` (`src/kill-tree.ts:8-22`, list-form
     `taskkill /T /F`, proven in-run for timeouts at `src/worker/opencode.ts:38-41`)
     **only after identity verification** — Windows reuses pids, and §15.2:1071's
     "no live process is silently reattached based on stale PID metadata" applies
     symmetrically to killing: a pid is killed only when a process with that pid is
     live and its identity matches the dispatch record as far as the platform
     exposes (at minimum an alive check; where obtainable, a creation time not after
     the recorded dispatch `startedAt` — a reused pid necessarily has a newer
     creation time). Unverifiable, already-gone, or never-recorded pids are reported
     as cleanup failures (§15.3:1080's "treat remaining descendants as cleanup
     failures"), never blind-killed. **The lock file's pid is never used for
     anything** — it belongs to the dead orchestrator (`src/lock.ts:97-102`) and is
     useless for tree-kill by construction; only per-attempt recorded pids are.
  7. **Inspect temporary workspaces, report-only.** Worktrees from the dispatch
     records plus `wt/`-discovery (the `src/clean.ts:89-96,150-167` logic), each
     with its branch and dirty state. Recovery removes nothing — not worktrees, not
     branches, not evidence; disposal stays `clean`'s job with its dirty-refusal
     and `--force` semantics (`src/clean.ts:6-8`).
  8. **Retry disposition per job, from T-007's policy.** `RetryPolicy =
     {maxAttempts}` (T-007:31-33), `maxAttempts` from the dispatch header. From
     dispatch records only:
     - completion with `ok` and `diffBytes === 0` ⇒ **terminal**, reason
       `no-op` — a zero-byte diff is a NO-OP verdict, never a pass (decisions.md;
       AGENTS.md #7), and recovery never re-rolls a machine verdict;
     - attempts used ≥ `maxAttempts` ⇒ **terminal**, reason `bound-exhausted`;
     - everything else (never completed, `!ok`, `timedOut`, or completed with a
       diff but no durably recorded verdict) ⇒ **retryable** while the bound allows
       — no machine verdict was ever produced, so re-running is not re-rolling one.
       (A `gates-failed` leg cannot occur in-run — gates never dispatched a worker;
       T-007:58-66's never-re-roll rule for produced verdicts binds the resume
       successor, which will consume stored verdicts.)
  9. **Write `<runDir>/recovery.json`** — `{runId, recoveredAt, abandonedAttempts,
     kills, cleanupFailures, workspaces, jobs: [{jobId, attemptsUsed, maxAttempts,
     disposition, reason}]}`. Exit 0 when every step executed; exit 1 with the
     failure recorded in the report when any cleanup or write failed (the
     `clean.ts:282` exit convention).
- **Recovery never reruns anything**: no lease is taken, no worker is spawned, no
  scheduling happens. It is marks + kills + inspection + disposition, and
  `recovery.json` has no consumer this slice — the run path still never reads the
  DB (`src/store/index.ts:11`'s posture holds: recovery writes, nothing automated
  consumes).

**Does NOT claim:**

- **No resume scheduling / no rerunning** (§29:1880 step 9; the "run continues
  correctly after restart" half of §35:2187): a run is one process with no durable
  mid-run schedule to resume (`src/cli.ts:143-162` → `runSkeleton`, one
  `report.json` write at `src/runner.ts:89`), and T-009's scheduler — the thing
  that could requeue from durable state — is paper (`src/scheduler.ts` does not
  exist at HEAD `b35e1aa`; verified this session). That is its own successor
  ticket, the one T-009:114-124's carve points at; this ticket produces exactly
  the durable state that successor will consume.
- **No §29:1877/1879 steps 6/8** — artifact/hash validation and waiting-approvals
  preservation need T-008's approval records; carved with them.
- **No §27 `workspace_leases` table and no §16 lease GC** — ROADMAP.md:15 stage 3;
  workspace inspection reads `wt/` and dispatch records, not lease rows.
- **No change to the stale-lock policy** — nothing auto-reaps a lock
  (VERIFICATION.md:78-82, T-004); `--force-lock` stays the explicit human override,
  and `recover` honors it exactly as `clean` does (`src/clean.ts:184-204`).
- **No adoption of process or worktree state** — nothing here reattaches to a live
  worker, and any future rerun is a fresh lease at the same `baseSha` (§15.1:1059-1061;
  the T-007:67-76 fresh-workspace rule).
- **No Windows Job Objects** (§15.3:1084 "Later") — `taskkill /T /F` via
  `killTree` stays; the Rust-helper decision (decisions.md 2026-10-10) is untouched.
- **No in-run DB writes, no live event emission for healthy runs** — the bounded
  end of the T-003:59-60 carve reversal is one evidence file; `ingest` stays
  post-hoc, and finished-run persistence is byte-for-byte today's.

## Why

Spec-mandated in three places, and the named successor of two carves. §15.2
(`docs/spec/inference-refinery-v2.md:1063-1071`) lists exactly the five startup
steps this ticket implements: mark recorded-`running` attempts `abandoned`, kill
known descendant trees, inspect temporary workspaces, let retry policy decide, and
never silently reattach from stale PID metadata. §29 Recovery Semantics
(`:1868-1884`) repeats the reconcile/abandon/kill/validate/requeue shape; §15.3
(`:1073-1080`) is the MVP process-tree contract (record root PID, verify
descendants disappear, remaining descendants are cleanup failures); §22:1311-1327
and §28:1863 supply the `abandoned` vocabulary; §35:2187 makes it a Windows
acceptance question ("Does restart mark incomplete jobs abandoned and safely retry
them?"); Milestone 3 lists "abandoned-job recovery" as a build item (`:2057`);
`docs/ROADMAP.md:15` maps it to stage 3. The reservation is explicit:
T-007:135-141 carved §15.2/§29 reconciliation because it had "no exercisable home",
and T-009:114-124 re-carved it to "its own successor ticket" — this is that ticket.

The pain is real and verified. A run is one process — `main` acquires the lock and
runs the pipeline once (`src/cli.ts:143-162`), `runSkeleton` writes `report.json`
once at the end (`src/runner.ts:89`) — so a hard kill mid-run leaves: orphaned
worker processes, leased worktrees under `wt/`, a checkout lock that blocks until a
human overrides (`src/lock.ts:4-11,69-75`; VERIFICATION.md:78-82), and a store with
zero rows for the run (`ingest` is called only after `runSkeleton` returns,
`src/cli.ts:204-208`). Grep over `src/` and `scripts/` this session finds no
recovery code at all — the only `recover` hit is `src/store/index.ts:215`, a
comment about recovering the report.json *path*. Every crashed run today is
lock-blocked debris: manual `--force-lock`, manual `clean`, manual rerun, no
record anywhere of what was in flight or what pid to reap.

**The premise gap, stated plainly rather than smoothed:** the idea says "scan the
T-003 store for attempts recorded as running", but no such rows can exist — the
store is schema v1 with exactly `runs`/`candidates`/`gate_results`/`events`
(`src/store/index.ts:17-65`), ingest derives everything post-hoc from a finished
report, no attempt row is ever written `running` (T-007 derives all-attempt-states-
terminal from the final report and records `processIdentity` null, T-007:41-44),
and the only worker pid in hand is `child.pid` at `src/worker/opencode.ts:40` —
used for the timeout kill and never returned (`WorkerResult`,
`src/types.ts:21-29`). The lock file records only the orchestrator's own pid
(`src/lock.ts:97-102`), useless for tree-kill once the orchestrator is dead. So
this ticket must first create the live producer of in-run state (dispatch.jsonl +
PID recording through the seam) before the startup scan has anything to reconcile —
that is part (a) of the What, not an optional extra.

**Dependencies are paper, stated plainly:** T-006 and T-007 are `proposed`
(docs/tickets/README.md:45-46), T-007:182-186 states it cannot start until T-006
lands, and `RetryPolicy` exists only in T-007:31-33. `src/scheduler.ts`,
`src/dag.ts`, `src/recover.ts`, and an `attempts` table do not exist at HEAD
`b35e1aa` (verified this session: directory listing, docs-only commits
`671abef`/`b35e1aa`). Until T-007 lands, this ticket stays proposed — one ticket =
one mergeable change-set forbids bundling the producer and its consumer
differently.

**Honest tension, stated rather than smoothed** (the T-006:101-111 precedent): the
pinned test in the source idea — "restarts and shows the run continues correctly"
— exceeds any slice without resume scheduling, so this ticket pins the
reconcilable half (abandonment + kill + inspection + disposition, after a real
kill-mid-run) and hands "continues" to the successor. And this is the first code
that writes wall-clock stamps into the store and the first writer that runs
outside a finished run — both bounded and documented above rather than bent
silently.

## Acceptance criteria

- [x] Every run writes `<runDir>/dispatch.jsonl` (header, dispatch, pid, completion
      lines as specified) via best-effort appends, a fake adapter records its real
      child's pid through `onSpawn` before any hang, and today's default run
      behavior is otherwise unchanged (exit code, stdout verdicts, `report.json`) —
      pinned by **Gate 1.11** (fake `WorkerAdapter` run assertions) and **Gate 0**.
- [x] A run hard-killed mid-flight (driver subprocess killed by pid only, leaving a
      real orphaned worker and a stale lock, exactly the §15.2 shape) is refused by
      `recover` without `--force-lock`: non-zero exit, the refusal names the holder,
      and nothing was written — no `recovery.json`, no DB rows, the orphan still
      alive — pinned by **Gate 1.11**.
- [x] With `--force-lock`, `recover` proceeds, releases the lock on every path (no
      residual `.lock` files), and the orphaned worker whose pid was recorded in
      `dispatch.jsonl` is verified (live, identity vs the dispatch record) and then
      actually dead — asserted against the real process, not a mock — pinned by
      **Gate 1.11**.
- [x] Abandonment marks are durable: the un-completed attempt becomes one `attempts`
      row with state `'abandoned'`, a failure record with reason `'abandoned'`, and
      `process_identity` from the dispatch record, plus exactly one
      `ATTEMPT_ABANDONED` event; the completed attempt of the same killed run is
      **not** fabricated into the store; `PRAGMA integrity_check` returns `ok` —
      pinned by **Gate 1.11** (temp-DB assertions).
- [x] Verify-before-kill never blindly kills: a dispatch record whose pid is not
      alive, and a dispatch with no recorded pid, are reported as cleanup failures
      (§15.3:1080) with no kill attempt, the recorded failure appears in
      `recovery.json`, and the command exits non-zero — while the lock file's
      (dead) orchestrator pid is never consulted — pinned by **Gate 1.11**.
- [x] Workspace inspection is report-only: `recover` lists every worktree under
      `wt/` (the `src/clean.ts` discovery path, including the no-`report.json`
      fallback) with branch and dirty state, and afterwards worktrees, branches,
      and all evidence files (`dispatch.jsonl`, logs, anything pre-existing) are
      intact and no disposal happened — pinned by **Gate 1.11**, with **Gate 1.5**
      staying green (`npm run verify`).
- [x] Retry disposition follows T-007's bound and the no-re-roll rule: the same
      kill-mid-run scenario with `maxAttempts 2` yields disposition `retryable`,
      with `maxAttempts 1` yields `terminal` / `bound-exhausted`, and a completion
      line with `ok` + `diffBytes 0` yields `terminal` / `no-op` — all recorded in
      `<runDir>/recovery.json` — pinned by **Gate 1.11**.
- [x] Recovery never reruns: after `recover`, no new worktree exists, no new worker
      process was spawned (no stray node processes beyond the asserted-dead orphan —
      AGENTS.md #10), `dispatch.jsonl` gained no lines from recovery, and
      `recovery.json` is the only new artifact — pinned by **Gate 1.11**.
- [x] Refusals exit non-zero and write nothing: missing/unknown `--run`, a finished
      run (`report.json` present), an already-reconciled run (`recovery.json`
      present — a second `recover` on the killed-run scenario refuses naming it) —
      pinned by **Gate 1.11**.
- [x] Finished-run persistence is untouched: `ingest`, the four-table schema v1
      write path, and the log-and-continue posture are unchanged, and the
      wall-clock deviation for abandonment stamps is documented in the
      `src/store/index.ts` header and VERIFICATION.md in the same change-set —
      pinned by **Gate 1.6** staying green (green before this change, verified
      2026-10-14: `node node_modules/tsx/dist/cli.mjs scripts/check-store.mjs` →
      "check-store: ALL GREEN", exit 0, only the documented node:sqlite
      ExperimentalWarning, Known issues #7) plus change-set review.
- [x] VERIFICATION.md gains the Gate 1.11 section (including the kill-mid-run
      scenario description and the wall-clock scoping), and the ticket status +
      index row move in the same change-set (AGENTS.md #6; tickets README rules) —
      pinned by change-set review.
- [ ] One real-pipeline `npm run verify:full` at landing, recorded in this ticket's
      Landed section — `src/runner.ts` is on VERIFICATION.md:200-201's trigger
      list; the T-003:166-175 / T-007 precedent. Gate 2 is not permanently
      extended. **Not run in the lane session** — the driving pipeline owns it
      (it re-runs the fast tier and runs the full e2e gate on merge exactly
      because `touchesPipeline` is true here); whoever lands the merge must
      confirm the driving `verify:full` is green and append the record below.
- [x] Gate 3 once at landing (adapter change: `onSpawn` + `WorkerResult.pid` in
      `src/worker/opencode.ts`), recorded in Landed.

## Landed

2026-10-16, in one change-set on `ticket/T-010-startup-reconciliation` (lane
base `03a2ca7`, T-009 already landed, so the dispatch hook lives in `runJob` —
the loop both modes drive — exactly as the dependency note anticipated).

- `src/types.ts` — the T-007/T-008 reservations paid off: `AttemptState`
  gains `'abandoned'`, `FailureReason` gains `'abandoned'` (the documented
  vocabulary extension: §28:1863 names `ATTEMPT_ABANDONED` but no reason
  vocabulary; the T-008 `APPROVAL_REJECTED` choose-and-document precedent),
  `WorkerExecutionRequest` gains optional `onSpawn?: (pid: number) => void`,
  and `WorkerResult` gains `pid: number | null`. `ProcessIdentity`'s doc
  updated: the in-run producer is the dispatch evidence; ingest-derived
  attempt rows still record it absent.
- `src/runner.ts` — `runSkeleton` appends `<runDir>/dispatch.jsonl`
  (best-effort, can never break a run): the `run` header at run start, one
  `dispatch` line per attempt when the lease exists, one `pid` line via the
  adapter's `onSpawn` callback, one `completion` line per adapter-resolved
  attempt after diff capture (`diffBytes` from the capture; a thrown attempt
  gets none so recovery treats it as recorded-running and can still kill its
  recorded pid).
- `src/worker/opencode.ts` — still the only harness-aware file: calls
  `req.onSpawn?.(child.pid)` right after the spawn and returns
  `pid: child.pid ?? null`.
- `src/store/index.ts` — additive-only: `recordAbandonedAttempts(runId,
  attempts, dbPath)`, the second DB writer — one `attempts` row per
  abandoned attempt (state `'abandoned'`, failure reason `'abandoned'`,
  `process_identity` = `{pid, startedAt, leaseId, branch}` from the dispatch
  record — the field T-007 recorded null now has a producer — `started_at`
  from the dispatch stamp) plus exactly one `ATTEMPT_ABANDONED` event per
  attempt, one transaction, `runs`/`candidates`/`gate_results`/prior events
  untouched, completed attempts never fabricated. Two documented facts:
  (1) the wall-clock scoping (second case in the header comment) — the
  report was never written, so the abandonment stamp is the recovery
  moment; (2) the connection opens with
  `{ enableForeignKeyConstraints: false }` (verified this session: node:sqlite
  enforces FKs by default, and a crashed run has no `runs` row — fabricating
  one is forbidden, so the writer's own connection disables FKs; `ingest`
  keeps its default FK-on connection and `PRAGMA integrity_check` stays ok).
  Zero attempts ⇒ no-op that never opens the DB.
- `src/workspace/worktree.ts` + `src/clean.ts` — `sniffRepo` and
  `registeredWorktrees` extracted from clean.ts (the ticket's
  "reuse/extract, do not duplicate") plus the shared `normPath`; clean.ts
  imports them, recover reuses them. Clean semantics untouched (Gate 1.5
  green).
- `src/recover.ts` (new) + `npm run recover` in package.json — refusals
  before any write (finished run, already-reconciled, missing/unknown
  `--run`); pre-T-010 crash (no readable dispatch.jsonl) ⇒ inspection-only,
  exit 0 with a noted report; then repo derivation (dispatch header, falling
  back to worktree `.git` pointers), the T-004 lock refused without
  `--force-lock` and released in a `finally` on every path, abandonment
  marks, verify-before-kill (`pid-not-alive` / `no-pid-recorded` /
  `identity-mismatch` / `kill-failed` are cleanup failures, never
  blind-killed; identity = alive check plus a PowerShell creation-time
  window check — a process created before the dispatch stamp or after the
  pid stamp ±10s is not the recorded worker; creation time unobtainable
  degrades to alive-only, noted), report-only workspace inspection, retry
  disposition from dispatch records only (`no-op` terminal / `bound-exhausted`
  terminal / else `retryable` with reason null while the bound allows),
  `recovery.json` written last; exit 1 with the failure recorded when any
  cleanup or write failed. The lock file's pid is never consulted for
  killing.
- `scripts/check-recovery.mjs` (new) + Gate 1.11 hook in
  `scripts/verify.mjs` after Gate 1.10 — 50 assertions across seven
  scenarios (R1 completed run + evidence structure; R2/R3 real kill-mid-run
  at maxAttempts 1 and 2 — driver subprocess killed by pid only, leaving a
  real detached orphan and a stale lock; R4 verify-before-kill with dead /
  never-recorded / identity-mismatch pids and an untouched lock pid; R5
  synthetic dispositions; R6 refusals; R7 pre-T-010 inspection-only). The
  fixture worker spawns the hung child detached because node binds
  non-detached children to the parent's lifetime on Windows — without
  `detached: true` the §15.2 orphan cannot exist to be verified and killed
  (probed this session: a non-detached grandchild dies within ~600ms of the
  orchestrator's death, clean exit or not).
- VERIFICATION.md — the Gate 1.11 section (scenario description, wall-clock
  scoping, carve list). Ticket status + index row in the same change-set.

Deviations, stated rather than smoothed:

- `input_context_hash` is written `''` and `output_artifacts_json` `[]` on
  abandoned rows — the columns are NOT NULL and dispatch evidence carries
  neither hash nor artifact paths; stated in the writer's doc, not smoothed.
- The gate fixture's hung worker is spawned detached (above) — a fixture
  necessity, not an engine behavior: `src/worker/opencode.ts` keeps its
  non-detached spawn (a worker that outlives its orchestrator in production
  is the harness's own process behavior, which is exactly what recovery's
  report-not-kill posture tolerates).
- `identityMatches` uses the window `[dispatch.startedAt − 10s,
  pidLine.at + 10s]` rather than the ticket's literal "creation time not
  after the dispatch `startedAt`": the child is necessarily created after
  the dispatch stamp (spawn follows the line), so a strict `<=` could never
  pass; the window keeps the reused-pid guarantee (any reuse happens after
  the pid line) while letting the real worker verify.
- `recover` writes `recovery.json` on the inspection-only path too (with a
  `note` field beyond the ticket's shape) — "exit 0 with that report" read
  as producing the report; it also makes the already-reconciled refusal
  uniform.

Measured gates (this lane, Node v22.23.1): Gate 0 `npm run typecheck` →
exit 0; `node scripts/verify.mjs fast` (Gates 0 / 1 / 0.5 / 1.5 /
1.6 / 1.7 / 1.8 / 1.9 / 1.10 / 1.11) → `verify (fast) complete: ALL GREEN`,
exit 0 — including the extended Gate 1.6 (`ingest` untouched; only the
documented node:sqlite ExperimentalWarning, Known issues #7) and Gate 1.5
(clean/lock/integrate semantics unchanged after the extraction). New Gate
1.11: 50 ok, `check-recovery: ALL GREEN`, exit 0, three consecutive green
runs (the kill-mid-run scenarios are timing-sensitive, so it was run
back-to-back to check stability). Gate 3 (adapter change), run in the lane:
`node scripts/diag-pwd.mjs C:\swarm\demo-target` → harness reports the
inherited-PWD directory (the Known issues #1 demonstration);
`node scripts/diag-pwd.mjs C:\swarm\demo-target C:\swarm\demo-target` →
harness reports the override target — identical output from the main
checkout's pre-change adapter, confirming the change is invisible to the
probe. Gate 2 not run here — owned by the driving pipeline at landing (the
unchecked criterion above). No stray processes left behind (the gate tears
its orphans down in a `finally`, AGENTS.md #10).

Review round 1 (2026-10-16), fixed in a follow-up commit on the same lane:

- **Write-failure path leaked the checkout lock** (reviewer-verified:
  `process.exit(1)` inside the recovery.json catch skipped the release
  `finally`, leaving a lock naming the now-dead recover — the exact
  never-auto-reap debris this ticket reconciles). Fixed: the failure is
  recorded in a `writeFailed` flag, folded into the exit code, and the exit
  happens after the `finally` releases the lock. Reaching that path also
  required one refusal refinement: the already-reconciled check now requires
  a real FILE at the recovery.json path (a directory squatting there is not
  a reconciliation record; `existsSync` used to mask it as "already
  reconciled" and the write failure was unreachable — the write then fails
  loudly and the lock still releases). Newly pinned by Gate 1.11
  R8: a directory squatting on the `recovery.json` path (EISDIR after the
  lock is held and every other step has run) → exit non-zero naming the
  failed path, **no residual `.lock`**, nothing fabricated.
- **A failed diff capture was encoded as `diffBytes: 0`**, indistinguishable
  from a genuine zero-byte diff, letting worker-ok + capture-failure +
  crash-before-report reconcile as an irreversible terminal `no-op` from
  absent evidence (reviewer's design note, adopted). The completion line now
  records `diffBytes: null` on a failed capture (src/runner.ts), and
  recovery's no-op guard is strict `diffBytes === 0` (src/recover.ts) — a
  failed capture falls through to retryable, because absent evidence is not
  a machine answer. Pinned on both sides: Gate 1.11 R1b (a diff-throwing
  fixture provider produces a completion line with `diffBytes: null`, and
  the run's own ladder still records no diff ⇒ never a pass) and Gate 1.11
  R5 (`ok` + `diffBytes: null` reconciles `retryable`, not terminal no-op).

Re-measured after the fixes (same lane, Node v22.23.1): Gate 0 → exit 0;
`node node_modules/tsx/dist/cli.mjs scripts/check-recovery.mjs` → 56 ok
across nine scenarios (R1b and R8 added), `check-recovery: ALL GREEN`,
exit 0; `node scripts/verify.mjs fast` → `verify (fast) complete: ALL
GREEN`, exit 0. Gate 2 still owned by the driving pipeline at landing.

## Verification

Gate 0 (`npm run typecheck`) always — green before this change, verified
2026-10-14: `npm run typecheck` → exit 0. Gate 1 (`npm run demo`) sanity,
token-free. Gate 0.5 n/a (`src/parse.ts` untouched). Gate 1.6 green before this
change, verified 2026-10-14 (ALL GREEN, exit 0, Known issues #7 warning only) and
must stay green after — `ingest` is untouched. The **new Gate 1.11**
(`scripts/check-recovery.mjs` + new VERIFICATION.md section + hook in
`scripts/verify.mjs` after Gate 1.10, before the fast-tier finish — the
T-003/T-005/T-006/T-007/T-008/T-009 slice-owns-its-gate precedent; no existing
gate can pin recovery: Gate 1.5 pins clean/lock/integrate, Gate 1.6 pins
finished-report ingest, Gate 2 spends model tokens) runs via `npm run verify` —
run in the lane, see Landed. **Gate 2 once**, at landing, recorded in Landed —
required here (trigger list: `src/runner.ts`), not a permanent extension; not
run in the lane session (the driving pipeline owns it). **Gate 3 once**, at
landing (adapter change) — run in the lane, see Landed.

## References

spec §15.1 (`docs/spec/inference-refinery-v2.md:1057-1061`), §15.2 (`:1063-1071`),
§15.3 (`:1073-1080`), §22 (`:1309-1329`, `abandoned` `:1323`), §28 (`:1848-1864`,
`ATTEMPT_ABANDONED` `:1863`), §29 (`:1868-1884`), §34 Milestone 3 (`:2050-2059`,
`abandoned-job recovery` `:2057`), §35 (`:2187`) · T-007 — dependency:
`attempts` table, `RetryPolicy`, the `AttemptState`/`FailureRecord` vocabulary and
its `'abandoned'` reservation (`:23-26`), the §15.2/§29 carve this ticket claims
(`:135-141`) · T-009 — the successor it defers to (`:114-124`) · T-008 — the
bounded wall-clock deviation precedent (`:37-44`) and the
choose-and-document-vocabulary precedent (`:54-60`) · T-004 — the never-auto-reap
stale-lock policy (VERIFICATION.md:78-82) and the lock acquisition/release pattern
`recover` reuses · T-002 — evidence-never-deleted (`src/clean.ts:6-8`) and the
crash-mid-run discovery primitives recovery reuses (`src/clean.ts:89-96,115-127,162-167`)
· `docs/decisions.md` 2026-10-10 (Node 22 / harness-agnostic / gates decide /
mechanism over prompts / `C:\swarm\` run root) · `docs/ROADMAP.md:15`.
