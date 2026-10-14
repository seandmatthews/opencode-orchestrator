# T-009 — Deterministic scheduler core: minimal job spec, DAG-driven execution, all-completion

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 4
**Depends on:** T-006 + T-007 (both proposed — must land first; transitively T-003). **T-008 is NOT a dependency of this carve** — see the first Does-NOT-claim: nothing here consumes approval state, so the approval-honoring part of the idea is a successor ticket, not this one.

## What

The capstone slice of Milestone 1's execution loop (spec §34:2024, "deterministic
scheduler"): replace the flat fan-out in `src/runner.ts` with a deterministic
DAG-driving scheduler that picks ready jobs in a deterministic order under the
existing concurrency cap, executes each through the untouched `WorkerAdapter` /
`WorkspaceProvider` / `Gate` seams, applies T-007's retry rule verbatim, evaluates
the `all` completion policy, and records the schedule so the T-003 store can derive
every transition as events. One mergeable change-set:

- **`src/scheduler.ts` — new file, the pure scheduling core (no I/O, no model
  knowledge):**
  - **Minimal job-spec types + parser** for the `--jobs <path>` input (JSON): an
    object with `phases` (§6.3:323-330 subset: `id`, `dependencies`, `completion`)
    and `jobs` (§6.4:346-367 subset: `id`, `phase`, `dependencies`, `brief`,
    optional `model`/`worker`/`timeoutMs`/`gates`). Only fields with producers —
    the §6.4 policy fields without any (`workspace`, `permissions`, `role`,
    `prompt`, `contextPlan`, `inputArtifacts`, `expectedOutputs`, `retryPolicy`,
    `timeoutPolicy`, `gatePolicy`) and `earlyStop`/`approvalGate` (§6.3:328-329)
    are **refused as unknown fields**, not ignored, so a typo can never silently
    narrow a run. `completion` accepts only `"all"` this slice. Job ids are
    restricted to `[a-z0-9][a-z0-9-]*` so derived lease/branch names stay
    collision-free (T-004's hazard, see below). Parse failures and validation
    refusals exit 1 **before the checkout lock, repo validation, or any artifacts
    dir exists** (the T-007 `--max-attempts` parse-refusal pattern).
  - **Validation reuses T-006's exported pure validators** (cycle detection via
    topological sort, unknown-reference check) on the parsed spec; refusals name
    the offense (a cycle refusal prints the cycle). Phase-level dependencies
    expand to job edges: every job of a phase depends on every job of each phase
    it depends on, so the ready function sees one job DAG.
  - **The exported pure ready-queue function**: given the validated job DAG, the
    set of jobs in terminal states, and the concurrency cap, returns the ordered
    ready list — topological ready-set, **tie-break by ascending job id,
    documented here as the determinism contract**, never wall-clock, never
    insertion order, never model opinion. This function is what "same inputs
    produce the same schedule" means and what the gate pins; concurrent
    *completion* interleaving is not deterministic and is not claimed to be.
- **`src/runner.ts` — the scheduler loop replaces the flat fan-out
  (`src/runner.ts:66-76`, the shared `next` counter):**
  - **`--jobs` mode:** each job maps 1:1 onto a `CandidateReport` (`id` = job id),
    so the run summary, store ingest, `clean`, and `integrate` keep working
    unchanged. Briefs come from the spec; the planner phase is skipped and
    `--goal` is not required. Per-job `model`/`worker`/`timeoutMs`/`gates`
    default to the run-level flags (`--model`, `--worker`, `--timeout-min`,
    `--gate`) exactly as `SkeletonOptions` (`src/runner.ts:6-27`) carries them
    today. Concurrency: the existing `--concurrency` flag, defaulting to the job
    count (the `src/cli.ts:127` default rule, generalized).
  - **Default mode (no `--jobs`) synthesizes the degenerate spec** — one phase,
    N dependency-free jobs from `--candidates`/briefs, exactly T-006's derived
    DAG — and drives it through the same scheduler. Observable behavior is
    today's: candidate ids in order, today's lease ids and evidence paths
    (`wt/<id>`, `<id>/worker.log`, `<id>/diff.patch`), one dispatch per
    candidate, no schedule block in `report.json`, unchanged exit code and
    stdout verdict lines. The legacy loop is deleted, not kept alongside.
  - **T-007's retry rule verbatim:** a job leg that throws or fails the worker
    (`!workerOk`) is retried in a fresh attempt-scoped lease (`wt/<jobId>-a<n>`,
    the T-007 scheme with jobId in place of candidateId) while
    `attempts.length < maxAttempts`; a succeeded-but-no-op or gates-failed leg is
    a verdict and is **never re-rolled** (decisions.md: machine gates decide
    survival; AGENTS.md #7). Exhausted retries fail the job.
  - **Lazy leasing:** worktrees are leased per ready job at the run's `baseSha`
    (never up front as at `src/runner.ts:61-64`), disposed after evidence capture
    under `cleanWorkspaces` as today. Job ids are unique per spec and
    charset-restricted, so `swarm/wt-<jobId>` branches cannot collide mid-run —
    the hazard T-004 flagged and T-007:75-77 cited.
  - **Phase completion, `all` only:** a phase completes when every job reaches
    terminal success. A failed job fails its phase; jobs of dependent phases are
    never dispatched; **independent phases still run** (no abort-phase/abort-run
    this slice — §30's policies are carved, see below).
- **`src/types.ts` — additive `RunReport.schedule?`** (undefined in default mode
  = no change for existing consumers): `{ phases: [{ id, dependencies, completion,
  status }], jobs: [{ id, phaseId, dependencies, dispatchIndex }] }` — the
  recorded dispatch order that makes the schedule checkable post-hoc.
  Additive report-shape change ⇒ **owns one Gate 2 run** (VERIFICATION.md:200-201;
  the T-007:51-52 precedent).
- **`src/store/index.ts` — ingest consumes the schedule block when present:**
  T-006's derived phases/jobs/job_dependencies rows now carry the *real*
  structure (multiple phases, real dependency edges) instead of the flat
  derivation — **this slice is the non-trivial-DAG producer T-006:75-77 flagged
  as absent**. Events stay **ingest-derived post-hoc, never live in-run**
  (T-006:71-73 / T-007:147-148 carve stands): `JOB_READY` (§28:1852) derived per
  job, `at` = the max of its dependencies' recorded finish stamps (run
  `startedAt` for dependency-free jobs), plus **three documented vocabulary
  extensions, chosen here per the T-008:54-60 precedent** (§28 names no job
  terminal or phase events): `JOB_SUCCEEDED`, `JOB_FAILED`, `PHASE_COMPLETED`.
  All stamps derive from the report (never `Date.now()`, the
  `src/store/index.ts:8-10` rule); persistence still records verdicts and never
  influences them (`src/store/index.ts:11`), and the log-and-continue posture at
  `src/cli.ts:202-208` is unchanged.
- **New Gate 1.10 — `scripts/check-scheduler.mjs`** (fast tier, token-free),
  hooked into `scripts/verify.mjs` after T-008's claimed Gate 1.9 and before the
  fast-tier finish (`scripts/verify.mjs:448`) — the T-003/T-005/T-006/T-007/T-008
  slice-owns-its-gate precedent. No existing gate can pin scheduler behavior: the
  fast tier never runs the pipeline, and Gate 2 spends model tokens and cannot
  assert determinism. The check drives the runner directly with a **fake
  `WorkerAdapter`** (the seam at `src/types.ts:35-38`; T-007:112-124's Gate 1.8
  pattern) against a throwaway fixture repo (Gate 1.5/demo-target sandbox
  pattern, list-form git calls — AGENTS.md #4), and pins the acceptance criteria
  below. **Extended Gate 1.6** (`scripts/check-store.mjs`) gains the DAG-shaped
  report assertions.
- **VERIFICATION.md** gains the Gate 1.10 section and the extended Gate 1.6
  description in the same change-set (AGENTS.md #6). Zero new npm dependencies
  (decisions.md: TypeScript on Node 22).

**Does NOT claim:**

- **No in-run approval-gate pause and no restart/resume** — the idea's "honor
  T-008 approval gates" is **carved to its own successor ticket**, deliberately:
  honoring an approval in-run is §21:1305's "paused indefinitely", which means a
  run holds the T-004 checkout lock for the whole wait (`src/cli.ts:156-161` —
  blocking every clean and other run, under the never-auto-reap stale policy,
  VERIFICATION.md:78-82) and drags in §29:1868-1884's restart reconciliation,
  which T-007:135-141 carved precisely because it had no exercisable home and
  T-008:110-121 deferred to "the scheduler or Milestone-3 crash recovery". That
  is a feature (pause + resume + reconcile) with its own lock semantics, not a
  rider on this change-set — one ticket = one mergeable change-set. The minimal
  spec refuses `approvalGate` as an unknown field until that successor lands.
- **No completion policies beyond `all`** — `quorum`, `all-machine-gates`,
  `at-least-n`, and custom deterministic expressions (§6.3:333-341) each need
  their own requeue/elimination semantics defined before they are implementable;
  own successor tickets.
- **No `earlyStop`** (§6.3:328) and **no §30:1888-1904 policies beyond T-007's
  bounded same-config retry** — no retry-fresh-session, schema repair,
  switch-worker/model, continue-after-quorum, pause-for-human, abort-phase,
  abort-run.
- **No §22:1313-1327 state vocabulary beyond what has producers** —
  `waiting_for_schema_repair`, `waiting_for_approval`, `retryable`, `abandoned`,
  `cancelled`, `skipped`, `cached` have no producer this slice (the T-007
  `'abandoned'` / T-008 `'cancelled'` precedents). §22:1329's "transitions are
  deterministic and persisted" is honored post-hoc: derived events replay the
  transitions from the recorded schedule.
- **No live in-run event emission** — ingest stays post-hoc and derived, so
  re-ingest stays deterministic and a DB failure can never influence a run
  (`src/store/index.ts:8-11`).
- **No full §13 Project Manifest / §6.2 Workflow** — the `--jobs` file is the
  minimal §6.3/§6.4 subset, not the manifest format; §6.2's `concurrencyPolicy`/
  `budgetPolicy`/`retentionPolicy` (`:314-316`) remain CLI concerns. No
  artifact store, no context plans (§6.4 fields without producers are refused).
- **No adapter change** — `src/worker/opencode.ts` stays the only
  harness-aware file; PWD pinning is untouched; model IDs enter only as config
  strings on job specs (decisions.md: engine is model/harness-agnostic;
  AGENTS.md #1). Gate 3 n/a.

## Why

`docs/ROADMAP.md:12` maps stage 1 to "remaining: job DAG, attempts, retries,
approvals, scheduler" — the scheduler is the repo's own last named item, and the
reservation chain is explicit: T-006:77-79 carves "no scheduler", T-007:153
carves "no scheduler/queue consumption", T-008:110-121 defers the in-run pause
to "the scheduler". Spec basis: §34:2019-2028 lists "deterministic scheduler"
(:2024) in Milestone 1's build list — of the eight build items it is the last
execution-loop item with no ticket (SQLite state + event log → T-003, job DAG →
T-006, attempts + retries → T-007, approvals → T-008; "filesystem artifact
store" `:2028` is the other unclaimed item and is *not* this ticket). §22:1329
requires deterministic, persisted transitions; §6.3:333-341 defines the
completion policies; §28:1852-1863 supplies the event vocabulary.

The problem is real and verified this session: `grep -rn
"scheduler\|readyQueue\|JOB_READY" src/ scripts/` returns nothing (exit 1), the
only "scheduling" today is the flat lane fan-out with a shared `next` counter
(`src/runner.ts:66-76`) executing each candidate exactly once
(`src/runner.ts:246-252`), and `src/dag.ts` / `src/approvals.ts` do not exist at
HEAD `81b2ce8` — T-006/T-007/T-008 are paper: all `proposed` in the index
(docs/tickets/README.md:45-47), their commits docs-only. The idea's phrasing
("apply T-007 retry policy, honor T-008 gates") describes tickets, not code —
**this ticket cannot start until T-006 and T-007 land**, stated plainly rather
than smoothed over.

The value is conversion, not novelty: this slice is the **first consumer** of
T-006's phases/jobs tables and validators, T-007's attempt rows and retry rule,
and the first producer of non-trivial DAG data — turning three paper structures
into a working loop. Until richer multi-phase specs exist, `--jobs` runs will
often still look like today's fan-out; that is foundation value, stated
honestly (hence Value 4, not 5).

**Honest tensions, stated rather than smoothed** (the T-006:101-111 precedent):

1. **Determinism is pinned on the scheduling decision, not on time.** Two runs
   of the same spec interleave worker completions differently; only the
   ready-queue order, tie-break, and requeue decisions are deterministic. The
   report therefore records `dispatchIndex`, and the gate compares dispatch
   sequences — not wall-clock timelines.
2. **Approvals move to a successor** (first Does-NOT-claim): the idea's
   "honor T-008 gates" would make this ticket own an indefinite pause while
   holding the checkout lock plus §29 reconciliation — a different feature with
   its own risk profile.
3. **Report shape changes** ⇒ this ticket owns one real-pipeline Gate 2 run at
   landing (VERIFICATION.md:200-201 triggers: `src/runner.ts` + report shape).
4. **Lazy leasing re-enters T-004's branch-collision surface** — mitigated
   mechanically (unique, charset-restricted job ids; T-007's attempt-scoped
   scheme), and pinned by Gate 1.10's no-collision assertion. Risk 4: this
   rewrites the core execution loop immediately after T-007 touches it, adds a
   new input format, and moves leasing from up-front to per-ready-job —
   mitigated by default-mode-unchanged pinning and the owning Gate 2 run.

## Acceptance criteria

- [ ] The exported ready-queue function is pure and correct on synthetic DAGs:
      chain, diamond, independent, and mixed specs return dependency-safe ready
      lists under a given cap, tie-broken by ascending job id; a job is never
      returned before all its dependencies are terminal-success — pinned by the
      **new Gate 1.10** (`scripts/check-scheduler.mjs` + new VERIFICATION.md
      section + hook in `scripts/verify.mjs` after Gate 1.9; direct function
      assertions, no pipeline, no repo, no model tokens).
- [ ] Determinism end-to-end: two scheduler runs over the same `--jobs` spec
      with the same fake-worker outcomes produce **identical recorded dispatch
      sequences** (per-job `dispatchIndex` equal across the two reports) —
      pinned by **Gate 1.10** (run twice, compare).
- [ ] The concurrency cap is never exceeded: the fake adapter counts in-flight
      executions and the observed maximum is ≤ the cap, on a spec with more
      ready jobs than slots — pinned by **Gate 1.10**.
- [ ] Dependent jobs dispatch only after their dependencies reach terminal
      success (including across phases via expanded phase edges) — pinned by
      **Gate 1.10** (fake adapter records the dispatch order).
- [ ] T-007's retry rule verbatim: a mechanical-leg failure (`error`/
      `!workerOk`) requeues the job as a fresh attempt in a `wt/<jobId>-a<n>`
      lease up to `maxAttempts`; a succeeded-but-no-op or gates-failed leg is
      never re-rolled and fails the job per the verdict ladder — pinned by
      **Gate 1.10** (fail-once, always-fail, no-op-then-pass, and
      gates-fail-then-pass fake workers; no branch/worktree collisions observed).
- [ ] Phase completion `all`: a phase completes only when every job reaches
      terminal success; a failed job fails its phase and dependent phases' jobs
      are never dispatched (recorded as not-dispatched, not fabricated as
      terminal); independent phases still run to completion — pinned by
      **Gate 1.10**.
- [ ] Default mode is today's behavior: without `--jobs`, candidate ids in
      order, today's lease ids/branches and evidence paths, one dispatch per
      candidate, **no `schedule` block in `report.json`**, exit code and stdout
      verdict lines unchanged — pinned by **Gate 1.10** (default-mode assertions
      with the fake adapter) and by **`npm run verify`** staying ALL GREEN
      (clean/lock/integrate semantics untouched).
- [ ] Spec refusals exit 1 and write nothing, before the checkout lock, repo
      validation, or any artifacts dir: missing/unparseable file, empty job set,
      duplicate job id, job id outside the allowed charset, unknown field
      (including `approvalGate`/`earlyStop`/policy fields), non-`all`
      `completion`, unknown dependency, and a cycle whose refusal names the
      cycle (proving T-006's validators are exercised) — pinned by **Gate
      1.10** (subprocess refusal assertions, the T-007 CLI-refusal pattern).
- [ ] Store: ingest of a schedule-carrying report derives `phases`/
      `jobs`/`job_dependencies` rows with the real multi-phase structure and
      real dependency edges, plus exactly one derived `JOB_READY` per job with
      `at` computed from report-carried stamps (never `Date.now()`) and the
      documented `JOB_SUCCEEDED`/`JOB_FAILED`/`PHASE_COMPLETED` extensions —
      pinned by the **extended Gate 1.6** (hand-built DAG variant of
      `scripts/fixtures/report-real.json`, the elim-variant pattern in
      `scripts/check-store.mjs`).
- [ ] Derived schedule events stay deterministic and append-only: re-ingest
      leaves `phases`/`jobs`/`job_dependencies` idempotent while prior `events`
      rows are untouched and `PRAGMA integrity_check` returns `ok` — pinned by
      the **extended Gate 1.6**.
- [ ] VERIFICATION.md carries the new Gate 1.10 section and the extended Gate
      1.6 description, and the ticket status + index row move in the same
      change-set (AGENTS.md #6; tickets README rules) — pinned by change-set
      review.
- [ ] One real-pipeline `npm run verify:full` at landing, recorded in this
      ticket's Landed section — `src/runner.ts` and the report-shape change are
      both on VERIFICATION.md:200-201's trigger list (the T-003:166-175 /
      T-007 precedent). Gate 2 is not permanently extended.

## Verification

Gate 0 (`npm run typecheck`) always — green before this change, verified
2026-10-14: `npm run typecheck` → exit 0. Gate 1 (`npm run demo`) sanity,
token-free. Gate 0.5 n/a (`src/parse.ts` untouched — the `--jobs` parser is new
code in `src/scheduler.ts`, not the harness-output parser). Gate 1.6 green
before this change, verified 2026-10-14:
`node node_modules/tsx/dist/cli.mjs scripts/check-store.mjs` → "check-store: ALL
GREEN", exit 0, only the documented node:sqlite ExperimentalWarning on stderr
(Known issues #7) — and it must stay green after. The **new Gate 1.10** and the
**extended Gate 1.6** run via `npm run verify` (not yet run for this ticket — no
code exists). **Gate 2 once**, at landing, recorded in Landed — required here
(trigger list: `src/runner.ts` + report shape), not a permanent extension. Gate
3 n/a (no adapter change; jobs execute behind the untouched `WorkerAdapter`
seam, PWD pinning untouched).

## References

spec §6.2 (`docs/spec/inference-refinery-v2.md:306-318`), §6.3 (`:320-341`),
§6.4 (`:343-368`), §13 (`:971`), §21 (`:1285-1305`), §22 (`:1309-1329`), §27
(`:1807-1838`), §28 (`:1848-1864`), §29 (`:1868-1884`), §30 (`:1888-1904`), §34
(`:2019-2028`) · T-006 — dependency: phases/jobs/job_dependencies tables, pure
validators, `job_id` derivation; its scheduler carve (`:75-79`) reserves this ·
T-007 — dependency: `attempts` + the bounded retry rule and attempt-scoped
leases; its carves at `:135-141` (§29 reconciliation) and `:153` (no scheduler
consumption) are honored here · T-008 — successor dependency for the approval
pause; its carve (`:110-121`) defers to this ticket, which re-defers with
reason · T-004 — branch-collision hazard and stale-lock policy
(VERIFICATION.md:78-82) · `docs/decisions.md` (2026-10-10: Node 22 /
harness-agnostic / gates decide / mechanism over prompts / `C:\swarm\` run
root) · `docs/ROADMAP.md:12`.
