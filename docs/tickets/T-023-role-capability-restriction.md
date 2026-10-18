# T-023 — Planner/reviewer capability restriction: §14 execution policy at the WorkerAdapter seam (spec §3.6, §14, §34 M5)

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** —

## What

Mechanism-level capability restriction for the two advisory roles, using the §14
vocabulary at the existing `WorkerAdapter` seam. Five parts, one change-set:

1. **Seam** (src/types.ts:8-35): `WorkerExecutionRequest` gains an optional
   execution-policy field carrying spec §14 vocabulary narrowed to the three
   postures that have a producer today (the spec defines the `WorkspacePolicy`
   union, §14.2:1018-1027, but only *names* `PermissionPolicy`, §6.6:409 — this
   repo's choose-and-document precedent applies, the T-013 types.ts:110-114 one):

   ```ts
   /**
    * Execution capability policy for one dispatch (spec §14). The spec never
    * defines PermissionPolicy (§6.6:409 names it without a type); this union
    * is the repo's documented narrowing — exactly the three postures with a
    * producer. An adapter that receives a non-`worktree-write` policy it
    * cannot honor must refuse the dispatch at spawn time, never silently
    * downgrade (§14.3:1039 — "The implementation can vary. The contract
    * does not.").
    */
   export type ExecutionPolicy =
     | 'artifact-only'   // no repo checkout is this dispatch's cwd (§14.2 "artifact-only")
     | 'worktree-read'   // tool-restricted read over the supplied disposable worktree (§14.3 "tool restriction")
     | 'worktree-write'  // builder posture: full tools inside the candidate worktree
   ```

   `executionPolicy?: ExecutionPolicy` on `WorkerExecutionRequest`; absent ≡
   `'worktree-write'`, so existing adapters (`MachineWorker`, T-017) and fake
   adapters in existing checks compile unchanged. The runner passes it
   *explicitly* on all three dispatch sites so the check can pin what was sent,
   not what was defaulted. MachineWorker never receives a non-default policy:
   planner/reviewer cannot dispatch through it (the run-level `--worker machine`
   parse-time refusal, src/cli.ts:135-147, stands).

2. **Runner** (src/runner.ts):
   - **Planner** (`runPlannerPhase`, :260-301): `cwd` moves off the canonical
     checkout — today `cwd: opts.repo` (:269, with the comment "enforcement
     moves into capability restrictions later"; this ticket *is* that later) —
     to a fresh disposable scratch dir `<artifactsDir>\planner-scratch\`,
     created before the phase and removed best-effort after it (its contents are
     never evidence; planner evidence stays `planner.log` + `planner-raw.txt`).
     Both execute calls (initial + repair, :270/:277) share `baseReq`, so one
     change covers both. Policy `'artifact-only'`. The planner prompt carries no
     repo path today (plannerPrompt, :218-230 — goal + count only), so this
     removes an accidental capability, not a used one.
   - **Reviewer** (`runReview`, :303-349): `cwd` stays the candidate worktree
     lease (`ctx.workspacePath`, :562) — a disposable workspace whose diff and
     gate results were already captured before review runs (diff at :478-488,
     review invoked at :558-567). Policy `'worktree-read'`. The prompt's
     "Do not modify any files" line (:241) stays as reinforcement.
   - **Worker** dispatch (:440-456): behavior unchanged, policy `'worktree-write'`.
   - **No verdict surface changes**: the ladder (:544), gates, probes, and the
     report shape are untouched. A harness-level failure of a restricted role
     degrades through the *existing* paths — planner raw-goal fallback
     (:143-146, `fallbackUsed`) and reviewer parse-fail — never becoming a
     candidate verdict (decisions.md:19-21: capability restriction is a
     spawn-time mechanism, not a gate result).

3. **Adapter translation** (src/worker/opencode.ts — the only OpenCode-aware
   file, decisions.md:11-15): a non-`'worktree-write'` policy adds
   `--agent plan` to the `run` argv (:29) — the OpenCode built-in plan agent,
   verified first-hand this session against the vendored opencode-ai **1.19.3**
   (node_modules/opencode-ai/package.json): `run --help` shows
   `--agent <string>`; `opencode debug agent plan` reports *"Plan mode. Disallows
   all edit tools."* with permission rules `edit * → deny` (narrow plan-file
   allows). The spawn log line (:30) reflects the actual argv so worker.log /
   planner.log / reviewer.log record the restriction. `PWD`/`OLDPWD` pinning
   (:38) is untouched on every path (ground rule 5; decisions.md:22-24). The
   agent name is adapter-internal harness vocabulary; **no new CLI flag** in
   this ticket.

4. **Gate 1.20** — new token-free fast-tier check, `scripts/check-capabilities.mjs`
   (Gate 1.20; 1.18/1.19 are claimed by proposed T-020/T-021), registered in the
   fast tier next to Gate 1.5:
   - **S1 — request capture** (the Gate 1.8/1.10 pattern: drive `runSkeleton`
     with a fake `WorkerAdapter` + fake gates against throwaway fixture repos,
     the check-retry shape, VERIFICATION.md:310-314): planner requests carry
     `'artifact-only'` with a cwd that exists, is under the run artifacts dir,
     and is neither `opts.repo` nor inside it; reviewer requests carry
     `'worktree-read'` with cwd = the candidate workspace path; worker requests
     carry `'worktree-write'` with cwd = the worktree; `report.json` shape
     unchanged.
   - **S2 — stub-bin argv pin** (constructor-injected `binPath`, opencode.ts:25;
     the Gate 1.12 S2 pin face, VERIFICATION.md:711-715): `OpenCodeWorker`
     pointed at a stub executable that records argv and `env.PWD`/`OLDPWD`:
     `'artifact-only'` and `'worktree-read'` → argv contains `--agent plan`;
     `'worktree-write'` and absent → it never appears; `PWD`/`OLDPWD` equal
     `req.cwd` in all four cases.

5. **VERIFICATION.md** in the same change-set: the Gate 1.20 section; Known
   issue #6 (:1473-1476) rewritten from "prompt-reinforced only" to
   mechanism-landed, recording the honest residuals (below); Known issue #2's
   "no directory flag" claim (:1461-1463, pinned against 1.18.35) refreshed per
   the landing Gate 3 result — 1.19.3's `run --help` now shows `--dir`
   (verified this session), which makes cwd+env pinning no longer the *only*
   mechanism, though it remains the one in use (ground rule 5).

**Honest residuals to record in the Known issue rewrite** (all observed in the
same first-hand 1.19.3 dump):

- The plan agent's tool list still includes `bash: true` — shell-mediated
  writes are **not** denied by the permission layer. The planner's scratch cwd
  is therefore load-bearing, not decorative: a bash `cd`/absolute-path escape
  remains possible in principle, bounded by the prompt naming no repo path and
  briefs being content-parsed engine-side. For the reviewer the same residual
  is contained by ordering: diff and gate evidence are captured before review
  runs, into evidence files, and the worktree is disposable
  (runner.ts:478-488 → :558-567).
- Whether a headless non-TTY `opencode run` auto-denies `ask`-action
  permissions (the plan agent's `external_directory → ask`) is **unverified** —
  no model session was run for this ticket. The landing Gate 2/3 runs are where
  a probe observation gets recorded, or the residual stays recorded as
  unverified.
- Output-content threats (a planner brief containing a hostile path) are a
  *different* threat class — §14 governs execution capability, not output
  content; sanitization is carved (below).

**Does NOT claim / carved:** no `WorkspaceProvider` implementation, factory, or
`--workspace` flag — T-022's single-provider rule stands, and this ticket does
**not** trigger T-022's re-entry condition (a): the reviewer's workspace stays
the existing worktree lease, the planner's scratch dir is plain `fs.mkdir` (not
a provider), and the stage-5 read-only *verifier roles* that would consume
`{ type: "disposable-clone-readonly" }` (spec §34 M5:2082-2094) remain
re-entry (a)'s owners. Also carved: §14.4 secrets/network allowlisting; §6.6
RoleSpec / §11.1 `capabilities()` compile-time refusal machinery (T-017's carve
stands); `--jobs` spec `workspace`/`permissions`/`role` fields stay refused
(src/scheduler.ts:46-51); OS-ACL/container isolation (§14.3's other mechanisms);
worker-tier tool restriction (builders keep full tools — §14.1:1014 is
satisfied by worktrees); brief-output content sanitization; custom-agent config
hardening beyond the built-in plan agent, and any restricted-agent CLI flag.

## Why

The repo's oldest recorded honesty debt. VERIFICATION.md Known issue #6
(:1473-1476), verbatim: *"The planner's read-only-ness is prompt-reinforced
only — it runs with build-agent write tools in the target repo cwd.
Mechanism-level capability restriction lands with the worker permission model
(spec §14). Until then, planner output and the repo state after Gate 2 are the
tripwire."* T-001 landed the reviewer's prompt-only posture citing the same
issue (T-001:73); this ticket supersedes that posture's "for now", it does not
reopen T-001.

In default `--goal` mode the planner executes through the unrestricted
run-level worker with `cwd: opts.repo` (src/runner.ts:267-270) — the canonical
target checkout handed to a full-tool build agent as its working directory. That
makes AGENTS.md ground rule 3's "the canonical checkout is never handed to a
model" false for the planner today, and leaves decisions.md:22-24 ("Mechanism
over prompts for isolation… Prompt statements of policy are defense-in-depth,
never the boundary") recorded but unimplemented for both advisory roles. The
spec is unambiguous: §3.6:144 — *"'Do not edit files' is not a security
boundary"*, §14.1:1014 — *"A write-capable model worker never receives the
canonical checkout as its writable workspace"*, §14.3:1039 — *"The
implementation can vary. The contract does not."*

The outputs flow onward, which is why execution-time restriction is the right
seam: planner briefs are embedded verbatim into worker prompts
(`builderPrompt(job.brief, …)`, src/runner.ts:441), and reviewer observations
land in `review.json`/`report.json` and the console summary — prompt-supplied
paths or commands in either role's output reach worker instructions and human
reports.

The mechanism already exists in the vendored harness: `--agent plan` deny-lists
edit tools (verified first-hand, 1.19.3 — see What §3), so this is adapter argv,
not a new dependency (decisions.md:6-10). Planner runs in default `--goal` mode
only (runner.ts:143); review runs in both modes post-gates (runner.ts:558-567),
so both roles are covered by the two dispatch sites.

Value 4 because it closes that debt and is the enabling primitive for stage-5
read-only roles (§34 M5 "read-only workspace where applicable"). Not 5 because
the Gate 2 canonical-clean tripwire (scripts/verify.mjs:612) has held and no
incident has fired since the PWD fix. Risk 2 because this touches the live
harness spawn path where the PWD incident lived, on a harness that already
drifted 1.18.35 → 1.19.3 under us, and moves the planner's cwd, which can shift
brief quality (Gate 2 pins only brief existence/count, verify.mjs:591-592 — the
landing run's briefs are the recorded evidence, and the limit is named here, not
hidden) — but every verdict surface is untouched, all new pins are token-free,
and Gate 2/Gate 3 landing runs cover the real-harness face.

## Acceptance criteria

- [ ] The seam field, the three runner dispatch sites, and the adapter
      translation compile — pinned by Gate 0 (`npm run typecheck`).
- [ ] Planner dispatches carry `'artifact-only'` with a scratch cwd under the
      run artifacts dir, not `opts.repo`; reviewer dispatches carry
      `'worktree-read'` at the candidate worktree; worker dispatches carry
      `'worktree-write'` at the worktree — pinned by Gate 1.20 S1.
- [ ] The adapter's argv contains `--agent plan` exactly for non-default
      policies and never for workers; `PWD`/`OLDPWD` stay pinned to `req.cwd`
      on every path — pinned by Gate 1.20 S2.
- [ ] Planner/reviewer output parsing is unchanged — pinned by Gate 0.5
      (check-parse.mjs) staying green.
- [ ] No existing fast-tier assertion is weakened (especially the worker
      workspace shapes in Gate 1.8/1.10) — pinned by the full fast tier
      (`npm run verify`) green with the new Gate 1.20 registered.
- [ ] VERIFICATION.md gains the Gate 1.20 section and the Known issue #6
      rewrite with the three residuals above; Known issue #2 is refreshed per
      the Gate 3 result — human-judgement items, named manual check: the
      VERIFICATION.md diff is read against this ticket's What §5 in
      change-set review.
- [ ] Report shape unchanged (no new `report.json` fields, verdict lines
      identical) — pinned by Gate 2's existing report assertions plus Gate 0.
- [ ] **Landing, once, recorded in `## Landed`:** Gate 2 (`npm run verify:full`)
      ALL GREEN on the real harness — planner produced briefs with
      `fallbackUsed: false` (verify.mjs:591-592), candidates PASS with parsed
      reviews (:601-604), fixture working tree clean (:612). This run is also
      the harness-drift tripwire: if 1.19.3 rejected `--agent plan`, the planner
      would fall back to the raw goal and `fallbackUsed` would flip this
      assertion red. Spends model tokens, hence landing-only (the recorded
      T-007/T-009 no-permanent-gate argument).
- [ ] **Landing, once:** Gate 3 (`node scripts/diag-pwd.mjs`, VERIFICATION.md
      :1431-1435) re-run against the vendored 1.19.3 — required by the adapter
      change (:1431-1435) and due anyway for the 1.18.35 → 1.19.3 drift — with
      the result and any Known issue #2 refresh recorded in `## Landed`.

## Verification

Gate 0, Gate 0.5, Gate 1 including new Gate 1.20 (fast tier, token-free) on
every run; Gate 2 (`npm run verify:full`) and Gate 3 exactly once at landing,
recorded in `## Landed`.

## References

- Spec: docs/spec/inference-refinery-v2.md §3.6:142-148 · §14.1:1012-1016 ·
  §14.2:1018-1027 · §14.3:1029-1039 · §14.4:1041-1049 (carved) · §6.6:397-415 ·
  §11.1:861-875 (carved) · §34 M5:2082-2094
- Code: src/types.ts:8-35, 77-85 · src/runner.ts:143-146, 218-230, 260-301,
  303-349, 440-456, 478-488, 544, 558-567 · src/worker/opencode.ts:22-45 ·
  src/cli.ts:135-147 · src/scheduler.ts:46-51 · scripts/verify.mjs:591-612
- VERIFICATION.md: Known issues #1, #2, #6 · Gate 2 :1418-1430 · Gate 3
  :1431-1441 · fake-adapter precedent :310-314 · Gate 1.12 S2 pin :711-715
- Tickets: T-001 (supersedes its prompt-only reviewer posture, T-001:73) ·
  T-022 (single-WorkspaceProvider rule and re-entry condition (a) — reconciled,
  not triggered) · T-017 (planner/reviewer machine-worker carve stands) ·
  T-013 (choose-and-document seam precedent)
- Decisions: docs/decisions.md:6-10, :11-15, :19-21, :22-24
