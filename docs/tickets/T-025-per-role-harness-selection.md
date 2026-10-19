# T-025 — Per-role harness selection for the advisory roles (spec §6.6:397-415, §11.1:875)

**Status:** done
**Category:** engine
**Value (1-5):** 2 · **Risk (1-5):** 2
**Depends on:** — (T-023 landed first — the coordination note's "lands second" branch was executed by this landing; see the Landed section)

## What

Today ONE run-level `WorkerAdapter` serves all three roles: `worker: WorkerAdapter` is
the sole adapter on `SkeletonOptions` (src/runner.ts:89), dispatched by the planner at
src/runner.ts:270 (initial) and :277 (repair), by the reviewer at :316/:323, and by
workers via the synthesized jobs' `worker: opts.worker` (src/runner.ts:160) at :440 —
all built once at src/cli.ts:332 (`createWorker(opts.workerId, opts)`). This ticket
gives the two advisory roles their own adapter selection. Five parts, one change-set:

1. **CLI flags — `src/cli.ts` only:**
   - `--planner-worker <id>` and `--reviewer-worker <id>`: a `WORKER_ADAPTERS` registry
     id (`['opencode', 'machine']`, src/cli.ts:236), defaulting to the `--worker` value —
     absent flags ⇒ all three roles ride `--worker` exactly as today.
   - `--planner-command <json>` and `--reviewer-command <json>`: the machine command
     source for the advisory roles — a JSON argv string (e.g. `'["node","-e","…"]'`),
      parsed and shape-validated at parse time (refuse non-array, non-string or empty
     entries, mirroring the scheduler's `command` shape rules). **Required iff that
     role resolves to `'machine'`** — without these flags the new selection flags are
     inert for `machine` (the exact fact T-017's refusal cites) and `opencode` is
     already the effective default. Pairing rule with T-017's `--jobs` parity: a
     command flag on a role that resolves to `'opencode'` is refused.
   - Early validation in `main()` before repo validation, the checkout lock, or any
     artifacts dir (the T-007/T-017 zero-side-effects refusal pattern, src/cli.ts:264-276):
     unknown per-role id (the registry message verbatim); role → `'machine'` without its
     command (mirrors src/cli.ts:245-251); command on a non-machine role.
   - Construction stays in `runPipeline`: a non-default role builds its adapter through
     the same `createWorker(id, opts, command)` (src/cli.ts:238-255 — the optional
     `command` parameter already exists); a default role passes nothing. The
     `createWorker` comment "The run-level call site can never land here" (src/cli.ts:246-247)
     is refreshed — with this ticket a *machine advisory role* is a legitimate run-level
     `machine` construction; the worker tier's refusal is unaffected.
   - The run header (src/cli.ts:312-314) names non-default roles (e.g. the `workers:`
     line gains `planner=machine reviewer=machine`); with no new flags the header is
     byte-identical to today.
2. **Seam — `SkeletonOptions` (src/runner.ts:80-103):** optional
   `plannerWorker?: WorkerAdapter` and `reviewerWorker?: WorkerAdapter`, resolved
   inside `runSkeleton` as `opts.plannerWorker ?? opts.worker` /
   `opts.reviewerWorker ?? opts.worker`, so direct `runSkeleton` callers (the
   Gate 1.8/1.10 checks) compile and behave unchanged.
3. **Runner dispatch sites (src/runner.ts):** the planner phase uses the resolved
   planner adapter on both execute calls (:270, :277 — they share `baseReq`, so one
   local covers both); `runReview` uses the resolved reviewer adapter on both calls
   (:316, :323 — same `baseReq` shape). Composition: the reviewer selection applies in
   **both** modes (review is invoked post-gates at :558-567 in both); the planner flag
   is accepted-but-ignored in `--jobs` mode (the planner is skipped there —
   src/cli.ts:325 passes `plannerModel: null`), documented in usage/README (the
   `--planner-model` precedent). **The worker leg is untouched**: the synthesized
   jobs' `worker: opts.worker` (:160), the :440 dispatch, and `--jobs` per-job worker
   resolution (src/cli.ts:203-230) stay exactly as they are.
4. **Refusal contract that stands:** the run-level `--worker machine` parse-time
   refusal (src/cli.ts:135-147, pinned by Gate 1.17 S6, scripts/check-machine-worker.mjs:336-338)
   is **not** flipped — no run-level machine command for the worker tier, no flip
   discipline owed (nothing an existing gate pins changes; the T-018/T-019 flips,
   VERIFICATION.md:1084-1107, are the precedent for when one would be).
5. **New Gate 1.21** — token-free fast-tier check, `scripts/check-per-role-harness.mjs`
   (numbering under Verification), wired into `scripts/verify.mjs` after the Gate 1.17
   hook, before the fast-tier finish. No existing gate can pin per-role dispatch: the
   fast tier never runs the pipeline and Gate 2 spends model tokens (the recorded
   T-007/T-009 argument, VERIFICATION.md:310-314, :466-469). Legs:
   - **S1 — fake-adapter dispatch capture** (the Gate 1.8/1.10 pattern: drive
     `runSkeleton` with fake `WorkerAdapter`s + fake gates against throwaway fixture
     repos, one per scenario): flags absent ⇒ the single fake serves every planner,
     reviewer, and worker dispatch; `plannerWorker`/`reviewerWorker` present ⇒ each
     role's dispatches (including the repair attempts) hit that role's fake and only
     that fake, and worker dispatches keep hitting the run-level fake.
   - **S2 — real-CLI refusals, exit 1, zero side effects** (no artifacts dir, no
     `locks/` — the Gate 1.17 S6 harness shape): unknown `--planner-worker` id; unknown
     `--reviewer-worker` id; role → `machine` without its command; command flag on a
     role resolving to `opencode`; malformed command JSON; and the unchanged
     `--worker machine` refusal re-pinned verbatim.
   - **S3 — token-free machine-reviewer end-to-end:** a real-CLI `--jobs` run with a
     machine worker job (marker-file gate) plus `--reviewer-worker machine
     --reviewer-command '[…]'` whose command echoes a valid observations object — the
     candidate PASSes its gate, review fires (it only runs post-gates,
     src/runner.ts:558-567), and `review.json` carries parsed observations from the
     machine adapter's output. This is the first token-free run with a non-empty
     advisory review (today T-017:30 requires `--no-review` for a token-free run).

**Decide-and-document — no report shape change:** no adapter-id fields are added to
`PlannerReport`/`ReviewReport`. Which adapter served a role is evidenced by the
per-role log argv headers (src/worker/opencode.ts:30, src/worker/machine.ts:56) and by
Gate 1.21's dispatch capture. The vendored Gate 1.6 fixtures therefore stay green
unchanged.

**Docblock reconciliation (docs only — no adapter file changes):** a machine advisory
role's output is `parseBriefs`/`parseReview`ed advisory evidence — briefs and
observations, never verdicts (decisions.md:19-21; the ladder at src/runner.ts:544 is
untouched) — distinct from a CommandProbe's post-gates `EvidenceBundle` (the
worker-vs-probe seam already drawn in src/worker/machine.ts:15-22). Recorded in
VERIFICATION.md's Gate 1.21 section, not by editing `machine.ts`.

**Coordination note — proposed T-023 (whoever lands second owns the reconciliation):**
T-023 works the same three dispatch sites (planner :260-301, reviewer :303-349,
worker :440-456), pins per-site request shapes in its Gate 1.20 S1, and pins the
sentence "MachineWorker never receives a non-default policy: planner/reviewer cannot
dispatch through it (the run-level `--worker machine` parse-time refusal … stands)"
(T-023:39-41). After this ticket a machine advisory role IS reachable, so that premise
goes stale and the §14.3:1039 honor-or-refuse interaction must be settled: under
T-023's seam a machine advisory dispatch carries a non-default policy
(`'artifact-only'`/`'worktree-read'`), which `MachineWorker` cannot honor — its
dispatch refuses at spawn time and the planner degrades through the existing raw-goal
fallback (src/runner.ts:143-146) unless T-023's landing adds the honor side. If T-023
lands first, this ticket's landing extends its Gate 1.20 pins (its S1 fake-adapter
assertions are per-site and survive per-role adapters unchanged); if this ticket lands
first, T-023's landing rewrites the premise sentence and reconciles Gate 1.20/1.21.
Either way the reconciliation happens in the second change-set.

**Does NOT claim:** the worker-tier half — run-level `--worker machine` with a
run-level machine command (the flip that must explicitly invalidate Gate 1.17 S6 per
the T-018/T-019 discipline, and which changes `--goal` worker semantics: token-free
goal-mode runs, the NO-OP ladder against machine output) — carved to a successor
ticket; §6.6 full `RoleSpec` machinery (prompt refs, `PermissionPolicy`,
`WorkspacePolicy`); §11.1 `capabilities()` / compile-time role-vs-capability refusal
(T-017's carve stands); any change to `src/worker/opencode.ts`, `src/worker/machine.ts`,
`src/types.ts`'s `WorkerAdapter` seam, `src/parse.ts`, `src/scheduler.ts`, gates, or
workspace handling (T-022's single-WorkspaceProvider rule untouched); any change to
model/role semantics — planner/reviewer models remain pure CLI configuration
(`--planner-model`/`--reviewer-model`, decisions.md:16-18); zero new npm dependencies.

## Why

The spec's own domain model already gives each role its worker: §6.6:397-415 —
*"Roles are configuration, not classes"* — with `RoleSpec.defaultWorker: WorkerSpec`
(:407), and §6.4:351 gives per-job `worker: WorkerSpec`. Today's engine narrows both
to one run-level adapter (the choke points listed above, all read-verified this
session). §5.2:234-252 (the Codex/Sol tier for verification, review, and audits) is
the stage-5 end state where per-role mixing pays; §11.1:875's "workflow compilation
fails early if a role requests unsupported capabilities" is the later slice this
per-role selection is the prerequisite for. The registry already has two entries
(src/cli.ts:236, landed by T-017), so "which adapter serves which role" is now a real
configuration question, not a placeholder one.

Honest sizing: with two adapters and no advisory command source, selection flags alone
would be inert — `machine` for planner/reviewer has no command (the very fact
T-017's refusal cites), and `opencode` is already the effective default. That is why
the command flags are in this ticket rather than deferred. Even so the delivered
capability today is modest but real: a fully token-free `--jobs` run currently needs
`--no-review` (T-017:30); with `--reviewer-worker machine --reviewer-command` it gains
a deterministic advisory review. The motivating headline — machine-execution lanes
under an opencode planner in `--goal` mode — belongs to the carved worker-tier half
(in `--jobs` mode it is reachable today via per-job `worker: "machine"` under the
run-level reviewer, T-017:30). Value 2: cheap, correct plumbing ahead of demand.

Decisions checked, not relitigated: decisions.md:11-15 — "Model-to-role mapping is
configuration, never engine code"; per-role adapter selection is CLI configuration and
completes this decision rather than contradicting it (adapters stay behind
`WorkerAdapter`, src/types.ts:65-68; only `src/worker/opencode.ts` knows OpenCode,
AGENTS.md ground rule 1 — no adapter file changes). decisions.md:16-18 — defaults
preserved exactly (absent flags ⇒ today's behavior; existing model flags untouched).
decisions.md:19-21 — a machine planner/reviewer stays advisory evidence; gates decide
survival, and the verdict ladder is untouched.

Prior art: none. `grep -rn -i -E 'planner-worker|plannerWorker|reviewer-worker|
reviewerWorker|per-role|adapter selection|harness mixing'` over `docs/tickets/`,
`docs/spec/`, `src/`, `scripts/`, `README.md`, `AGENTS.md`, `VERIFICATION.md` → exit 1
(no matches), run this session, matching the scout's finding. This is the unclaimed
successor to T-017's explicit carve — "machine workers serving planner/reviewer roles
(refused by construction this slice)" (T-017:40) — and extends T-001's flag surface
(the reviewer landed on "the existing WorkerAdapter", T-001:73) without reopening it.

Pre-change state, run this session: Gate 0 `npm run typecheck` → exit 0;
`node node_modules/tsx/dist/cli.mjs scripts/check-machine-worker.mjs` (Gate 1.17) →
`check-machine-worker: ALL GREEN`, exit 0. Full fast tier and Gate 2 NOT run —
reported as not run.

## Acceptance criteria

- [x] Flags parse, validate, and plumb: `--planner-worker`/`--reviewer-worker` and
      `--planner-command`/`--reviewer-command` reach `runSkeleton` via the optional
      `SkeletonOptions` fields; absent flags leave all three roles on the run-level
      adapter with byte-identical default-mode stdout and report — pinned by Gate 0
      (`npm run typecheck`), new Gate 1.21 S1 (dispatch capture, both the
      flags-absent and per-role cases, repair attempts included), and Gate 1.10's
      existing default-mode pins staying green unchanged.
- [x] Per-role dispatch in default mode: with `plannerWorker`/`reviewerWorker` set,
      planner initial+repair (:270/:277) go through the planner adapter, reviewer
      initial+repair (:316/:323) through the reviewer adapter, and worker dispatches
      (:440) keep the run-level adapter — pinned by Gate 1.21 S1.
- [x] A machine reviewer works end to end, token-free: the Gate 1.21 S3 real-CLI
      `--jobs` run PASSes its machine candidate through a real gate and produces a
      parsed `review.json` from the `--reviewer-command` output — review fired
      post-gates (src/runner.ts:558-567) through the reviewer's own adapter.
- [x] Refusals, all exit 1 with zero side effects (no artifacts dir, no `locks/`):
      unknown `--planner-worker`/`--reviewer-worker` id; a role resolving to `machine`
      without its command flag; a command flag on a role resolving to `opencode`;
      malformed command JSON; and the standing `--worker machine` refusal, message
      verbatim — pinned by Gate 1.21 S2, with Gate 1.17 S6
      (scripts/check-machine-worker.mjs:336-338) staying green verbatim (the proof
      the contract was not flipped; no T-018/T-019 flip discipline owed).
- [x] The worker leg and `--jobs` per-job resolution are untouched — pinned by the
      unchanged Gates 1.8/1.10/1.15/1.17 green inside a full `npm run verify` ALL
      GREEN with Gate 1.21 registered; no existing fast-tier assertion weakened.
- [x] `--jobs` composition: the reviewer selection applies; the planner flag is
      accepted-but-ignored there, and usage/README say so — human-judgement item,
      named manual check: the `--jobs` behavior is pinned by Gate 1.21 S3 (which IS a
      `--jobs` run); the documented ignore is verified by reading the usage/README
      diff against this ticket in change-set review.
- [x] No verdict-semantics or report-shape change: the ladder (src/runner.ts:544),
      gates, probes, and `PlannerReport`/`ReviewReport` are untouched; no adapter-id
      fields added — pinned by Gate 0.5 (n/a: `src/parse.ts` untouched, stated
      rather than run), Gate 1.6's planner_json/review_json round-trip pins green,
      and Gate 2's existing report assertions at landing.
- [x] Machine-advisory honesty recorded in docs, not adapter files: the
      advisory-evidence-vs-verdict and advisory-vs-CommandProbe reconciliations live
      in VERIFICATION.md's Gate 1.21 section — human-judgement item, named manual
      check: the VERIFICATION.md diff is read against this ticket's What in
      change-set review.
- [x] Docs in the same change-set: VERIFICATION.md (new Gate 1.21 section; the
      worker-registry/flag sentence), README (the `--worker` row area, README.md:104;
      the README.md:128-130 sentence "the planner and reviewer have no command to
      run" reworded to the per-role-flags reality), `src/cli.ts` usage text.
- [ ] **Gate 2 runs once at landing** — `src/runner.ts` is on the trigger list
      (VERIFICATION.md:1428-1430) — ALL GREEN with the real harness, recorded in
      `## Landed` with its output; this is also the real-harness face of
      default-mode behavior (defaults ride `--worker`/opencode unchanged).
      NOT run by this lane (model tokens) — the driving pipeline's Gate 2 run is
      the landing evidence (the T-023 lane precedent); the box flips there.
- [x] **T-023 coordination executed in this change-set if this ticket lands second:**
      T-023's premise sentence (T-023:39-41) and Gate 1.20 pins reconciled as spelled
      out in the coordination note — if this ticket lands first, the note's
      obligations pass to T-023's landing (named here so neither landing can silently
      skip it). This ticket landed second: the dated reconciliation note is appended
      to T-023's file, the Gate 1.20 S1 pins are extended to per-role adapters in
      Gate 1.21 S1, the Gate 1.20 section records the stale premise, and the
      §14.3:1039 honor-or-refuse interaction is settled in VERIFICATION.md's Gate
      1.21 section (docs only — no adapter file changes, per this ticket's carve).

## Landed

2026-10-18, lane branch `ticket/T-025-per-role-harness-selection`.

What changed:

- **`src/cli.ts`** — the four flags (`--planner-worker`/`--reviewer-worker`,
  `--planner-command`/`--reviewer-command`); `parseCommandArgv` (JSON argv,
  shape-validated at parse time, mirroring the scheduler's `command` rules);
  `perRoleRefusal` (pure: unknown per-role id with the registry message verbatim;
  role → machine without its command; command on a non-machine role) called in
  `main()` before the `--jobs` spec read — before repo validation, the checkout
  lock, or any artifacts dir; role-id defaulting to `--worker` after the argv
  loop (flag order never matters); non-default advisory roles constructed in
  `runPipeline` through the same `createWorker(id, opts, command)`; the
  `workers:` header line names non-default roles (`planner=machine
  reviewer=machine`, the ticket's example shape), byte-identical with no new
  flags; the `createWorker` machine-case comment refreshed (a machine advisory
  role IS a legitimate run-level machine construction now; the worker tier's
  parse-time refusal is unaffected); usage text for all four flags including the
  `--jobs` accepted-but-ignored note.
- **`src/runner.ts`** — `SkeletonOptions.plannerWorker?`/`reviewerWorker?`
  (resolved as `opts.plannerWorker ?? opts.worker` / `opts.reviewerWorker ??
  opts.worker`); `runPlannerPhase` and `runReview` each hold one local resolved
  adapter covering both execute calls (initial + bounded repair share `baseReq`).
  No verdict surface, dispatch evidence, or report shape touched.
- **`scripts/check-per-role-harness.mjs` (new Gate 1.21)** + the hook in
  `scripts/verify.mjs` after the Gate 1.20 hook, before the fast-tier finish
  (sequential fast-tier hook order; the ticket's "after the Gate 1.17 hook"
  predates T-020/T-021/T-023 landing 1.18-1.20 — the intent, registered in the
  fast tier, is what lands, the T-023 implementation-note precedent). S1a/S1b
  dispatch capture, S2's 13 zero-side-effect refusals (including the `--worker
  machine` message re-pinned verbatim), S3's token-free machine-reviewer
  end-to-end `--jobs` run. 40 ok assertions.
- **`VERIFICATION.md`** — the Gate 1.21 section (pins, the machine-advisory
  honesty reconciliation, the §14.3:1039 settlement for `MachineWorker`, carve
  list, Gate 2/Gate 3 disposition); the Gate 1.17 registry sentence refreshed
  (per-role flags; the run-level refusal's "no machine command" fact is about
  the worker tier alone; the pre-T-025 `--no-review` requirement superseded by
  Gate 1.21 S3) and its carve line updated (machine planner/reviewer landed by
  T-025); the Gate 1.20 section gains the T-025 extension note (stale premise
  superseded; per-site pins survive, extended in Gate 1.21 S1).
- **`README.md`** — the Model-roles flags paragraph (per-role adapter selection,
  the `--jobs` ignore); the Run-flags table gains the four rows around the
  `--worker` row; the README.md:128-130 sentence reworded ("the planner and
  reviewer have no command to run" → the per-role-flags reality; run-level
  `--worker machine` still refused).
- **`docs/tickets/`** — this ticket flipped to done, the index row updated, and
  T-023's file gains the dated coordination note — all in the same change-set.

Implementation notes (the ticket text left implied, and honesty records):

- The ticket's "resolved inside `runSkeleton`" landed as the identical
  resolution expression held in one local inside each phase function
  (`runPlannerPhase`/`runReview`), which is where "one local covers both"
  execute calls applies; signatures are unchanged.
- Red-before/green-after on the new gate's own first run (AGENTS.md #8, the
  T-023 new-check precedent): 4 authored failures — S1b's role scripting was
  call-count-based and broke under two concurrent candidates (c02's first
  review received the valid response, so its repair never fired); re-keyed to
  the runner's repair prompt. S3's reviewer `-e` command had a JavaScript
  syntax error (a missing outer-object brace), so the machine reviewer's
  output was a SyntaxError on both attempts and `review.json` recorded
  `ok: false` — exactly the parse-fail path the design intends for bad
  machine output; fixed. Green in every run since.
- One-off Gate 1.17 red, recorded: the FIRST standalone
  `scripts/check-machine-worker.mjs` run this lane made exited
  `1 failure(s)`; the failing assertion's name was not captured (only the
  tail was kept — a capture mistake, acknowledged). Three consecutive re-runs
  ALL GREEN (36 ok assertions), and Gate 1.17 was green again inside the full
  fast tier. The lane's change-set touches none of the check's inputs'
  behavior (src/cli.ts changes are parse-time and deterministic; the S6
  refusals passed in every re-run). Same class as Known issues #10/#11: a
  loud-by-design one-off in a fast-tier check, benign until observed
  recurring; no code change was made in response.
- Gate 0.5 n/a as the ticket states: `src/parse.ts` untouched (stated; Gate
  0.5 ran green inside the fast tier anyway).

Measured gates (this lane, this change-set):

- Gate 0 `tsc --noEmit` → exit 0 (also `ok: typecheck exit 0` in the tier).
- Gate 1.21 new, `node node_modules/tsx/dist/cli.mjs
  scripts/check-per-role-harness.mjs` → `check-per-role-harness: ALL GREEN`,
  exit 0, 40 ok assertions (green in every run after the two authoring fixes
  recorded above).
- Gate 1.17 standalone → ALL GREEN ×3 consecutive after the one-off red
  recorded above (36 ok assertions each); green again inside the full fast
  tier.
- Full fast tier, `node scripts/verify.mjs fast` → exit 0,
  `verify (fast) complete: ALL GREEN`, 1043 ok lines, 0 failures — every
  section (Gate 0, 1, 0.5, 1.5 ×3, 1.6–1.21) green, Gate 1.21 registered and
  green, Gate 1.8/1.10/1.15/1.17 default-mode and worker-leg pins untouched.
- Gate 2 **owed once at landing** (`src/runner.ts` is on the trigger list)
  and **not run by this lane** (model tokens) — the driving pipeline runs the
  full e2e gate after this change-set lands and records it here; that run is
  also the real-harness face of default-mode behavior (defaults ride
  `--worker`/opencode unchanged).
- Gate 3 n/a — no adapter file added or changed; the PWD/OLDPWD pinning
  (src/worker/opencode.ts:57) is untouched (the T-009 precedent for
  runner/cli-only changes).

Deviations: the three implementation notes above; nothing else. Gate
numbering: **1.21** claimed and landed as planned — the next free integer
after T-023's landed 1.20 (the ticket's 1.18/1.19/1.20-by-proposed-tickets
note is stale history; all three landed before this lane started).

## Verification

Gate 0; Gate 0.5 n/a (`src/parse.ts` untouched — stated, not run); Gate 1 full fast
tier on every run, including **new Gate 1.21** (token-free, fast tier, added here and
wired into `npm run verify` — the T-008 slice-owns-its-gate precedent) and the
unchanged Gate 1.17 S6; **Gate 2 owed once at landing** (VERIFICATION.md:1428-1430 —
`src/runner.ts`), recorded in `## Landed`; **Gate 3 not owed** — no adapter file is
added or changed (the T-009 precedent for runner/cli-only changes), and the PWD/OLDPWD
pinning (src/worker/opencode.ts:38) is untouched.

Numbering: the new gate claims **1.21** — 1.18/1.19/1.20 are claimed by proposed
T-020/T-021/T-023; per the T-017:176 precedent the final number is the next free
integer at landing.

## References

- Spec: docs/spec/inference-refinery-v2.md §6.6:397-415 (`defaultWorker: WorkerSpec`
  :407) · §6.4:351 · §11:851-859 · §11.1:875 · §5.2:234-252 · §14.3:1039 (via the
  T-023 coordination note)
- Code: src/runner.ts:89, :143-146, :160, :260-301, :303-349, :440, :544, :558-567 ·
  src/cli.ts:135-147, :203-230, :236, :238-255, :264-276, :312-314, :325, :332 ·
  src/types.ts:65-68 · src/worker/opencode.ts:30, :38 · src/worker/machine.ts:15-22,
  :51, :56 · scripts/check-machine-worker.mjs:336-338
- VERIFICATION.md: fake-adapter precedent :310-314, :466-469 · flip discipline
  :1084-1107 · Gate 2 trigger list :1428-1430 · Gate 3 :1431-1441
- Tickets: T-017 (the carve this succeeds, :40; the standing refusal contract; gate
  numbering precedent :176) · T-023 (same dispatch sites; Gate 1.20; the premise
  sentence to reconcile) · T-001 (the reviewer flag-surface precedent, :73) ·
  T-009 (Gate 1.10 default-mode pins; engine-category precedent) · T-022 (untouched
  single-provider rule)
- Decisions: docs/decisions.md:11-15 (harness-agnostic; role mapping is
  configuration), :16-18 (two-tier defaults preserved), :19-21 (gates decide;
  models advise)
