# T-031 — Phase-level early stop: `EarlyStopPolicy.minSurvivors` on the `--jobs` spec — stop dispatching, never kill, record the stop (spec §20, §34 M8)

**Status:** done 2026-10-20
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 3
**Depends on:** T-009, T-030 (both done; T-006's reserved `early_stop_json` column is carved, not populated)

## What

The run today always drives every planned candidate: `driveJobs` is one `for(;;)`
loop that dispatches every ready job until all reach terminal state and takes no
stop-condition input (`src/runner.ts:297-329`), and `readyJobs` has no
survivor-count input (`src/scheduler.ts:377-392`). This change-set adds phase-level
early stop in `--jobs` mode with exactly ONE machine-computed condition, and
nothing else:

1. **`EarlyStopPolicy` — chosen here and documented** (the type is used but never
   defined by the spec — §6.3:328 names `earlyStop?: EarlyStopPolicy` on
   PhaseSpec and nothing defines the type; the T-013 `DistillationPlan`
   choose-and-document precedent, VERIFICATION.md:1066-1071). New type in
   `src/scheduler.ts`:

   ```ts
   export interface EarlyStopPolicy {
     /** Conclude the phase early once at least this many of its jobs have
      *  reached terminal SUCCESS. Machine-computed: a count over terminal
      *  states, never a model opinion. */
     minSurvivors: number
   }
   ```

   Exactly one condition this slice — `minSurvivors` (spec §20:1265-1281's
   "stop after 20 valid researchers" shape; the owner's "target survivor count
   exists"). Parsed strictly (the T-009 unknown-field posture,
   `src/scheduler.ts:107-113`): must be a plain object, `minSurvivors` required
   positive integer, unknown sub-fields refused naming the offense. No
   model-confidence condition of any kind (spec §20:1281; decisions.md:19-21,
   2026-10-10 — machine gates decide survival, models advise).

2. **`PhaseSpec.earlyStop?: EarlyStopPolicy`** — the phase allow-list at
   `src/scheduler.ts:152` gains `earlyStop` with the strict sub-field
   validation above. `approvalGate` stays REFUSED as an unknown field (its own
   M8 successor has not landed); the module comment at `src/scheduler.ts:35-37`
   is updated to say exactly that — earlyStop now has a producer, approvalGate
   still does not.

3. **The pure stop function** — exported from `src/scheduler.ts` (e.g.
   `earlyStopMet(policy, phaseJobs, terminal): boolean`): the phase's count of
   terminal-SUCCEEDED jobs ≥ `minSurvivors`. Pure: identical terminal states ⇒
   identical decision, no input mutated. Documented in the module header next
   to the ready-function contract: the stop DECISION is a pure function of
   terminal states; which jobs it leaves undispatched is interleaving-sensitive
   exactly like dispatch order beyond the ready list (`src/scheduler.ts:16-17`)
   — the claim is "same terminal states ⇒ same stop decision", never the same
   wall-clock behavior.

4. **Evaluation in `driveJobs` (`src/runner.ts:297-329`).** Policies come from
   `opts.scheduled.phases` (default mode: `opts.scheduled` absent ⇒ no policies
   ⇒ the loop is untouched). Per loop iteration, a phase whose policy is met
   has its ready-but-undispatched jobs filtered out of the dispatch pass.
   Guarantees, each mechanical in today's code:
   - The stop only suppresses DISPATCH. In-flight jobs run to completion —
     never killed; no cancellation path is added or needed.
   - Never-dispatched jobs of the stopped phase record `dispatchIndex: null`
     (the existing not-dispatched shape, `src/scheduler.ts:424`), with no
     candidate report, no lease, no branch, no worktree — recorded as
     not-dispatched, never fabricated as terminal.
   - Dependents of a concluded-early phase stay never-dispatched for free:
     `readyJobs` requires dependencies at terminal success
     (`src/scheduler.ts:388`), a never-dispatched job never reaches terminal,
     so downstream jobs are never ready. No new dependency logic.
   - Termination is unchanged: suppressed jobs stay non-terminal and never
     dispatch; `inFlight` drains; the `inFlight.size === 0` break
     (`src/runner.ts:325`) fires exactly as today.
   - A dispatched job's verdict comes from exactly today's ladder — the stop
     touches nothing downstream of dispatch (gates, probes, review, reports,
     store rows all unchanged per job).

5. **Schedule semantics — `PhaseStatus` gains a fourth value
   `concluded-early`** (`src/types.ts:339`), derived in `buildSchedule`
   (`src/scheduler.ts:402-427`): a phase with a DECLARED policy that is MET and
   has ≥ 1 never-dispatched job. Without this, such a phase derives `blocked`
   today (`src/scheduler.ts:409-418`) — active misinformation, since `blocked`
   means starved by an upstream failure (`src/types.ts:335-337`). Precedence
   rule, chosen and documented: `failed` (any terminal-failed job, unchanged) >
   `concluded-early` > `completed` > `blocked`. Purely derived from the
   declared policy + terminal states + dispatch indices — `buildSchedule` needs
   NO new inputs (PhaseSpec already carries the policy). Declared-but-unmet
   policies change no status. The `PHASE_COMPLETED` filter is unchanged
   (`src/store/index.ts:1300-1309`, `p.status !== 'completed'` continue): a
   concluded-early phase gets no event, like failed/blocked today — §28 names
   no such event (`src/store/index.ts:1272-1274`); the stop's evidence is the
   report block below, not a store event.

6. **Report shape — additive `earlyStops` block on `RunReport`** (the T-030
   `rounds` precedent, `src/types.ts:418-421`): present only when a `--jobs`
   phase DECLARED a policy — default mode AND policy-less `--jobs` reports are
   unchanged. One record per declaring phase, in spec phase order:
   `{ phaseId, condition: 'minSurvivors', threshold, met, survivorIds, neverDispatchedIds }`.
   `met: true` entries are the stop evidence — recorded as evidence rather than
   silently truncating: which condition fired, who survived (report order),
   who was never dispatched (spec order). `met: false` entries record that a
   declared policy was evaluated and never fired (survivorIds = all
   terminal-succeeded; neverDispatchedIds = starved-by-failure jobs if any) —
   the `RoundRecord.executed: false` posture (`src/types.ts:384-387`): a policy
   that silently vanished would be indistinguishable from a bug. The
   `condition` literal keeps future conditions additive. Stop evidence rides
   the run artifacts dir like the rounds block (decisions.md:25-26 run root;
   `src/runner.ts:221` precedent).

7. **No CLI flag, no default-mode lever — stated rather than shipped.** The
   policy arrives ONLY via the `--jobs` spec file; no `--stop`/`--min-survivors`
   flag is added because in default `--goal` mode nothing could bind: the
   synthesized degenerate spec carries no policy, and `--concurrency` defaults
   to the candidate count (`src/cli.ts:407-408`), so the entire wave dispatches
   in `driveJobs`' first iteration and an early stop could prevent ZERO
   dispatches there. The lever exists only where dispatch is actually
   staggered: explicit `--concurrency` below the job count, or `--jobs` DAGs
   whose phases fan out under the cap. Gate 2's 2-candidate runs save nothing
   today — the token-economy payoff is load-bearing for future shapes (rounds
   n > 2, large staggered fan-outs), not current defaults. `--rounds` + `--jobs`
   are already mutually refused (T-030), so no interaction.

**Does NOT claim (carved for successors):**

- **No run-level stop conditions** — §20's run token ceiling, wall-clock
  ceiling, and human cancellation have no run-level policy input this slice.
- **No generation-loop stop conditions** — §20's
  consecutive-generations-no-new-survivor and max-generation-count need the
  rounds loop beyond n ≤ 2 (T-030's cap, `src/runner.ts:209-211`); the rounds
  structure (`src/runner.ts:209-257`) is the natural extension point.
- **No `approvalGate`** — still refused (`src/scheduler.ts:36-37`); its own M8
  successor.
- **No completion policies beyond `all`** — the T-009:125-129 carve stands.
- **No default-`--goal` stop** — no flag that cannot bind (item 7).
- **No store change** — `phases.early_stop_json` (`src/store/index.ts:144`)
  stays null this slice; the record rides the report block (the rounds
  store-invisible precedent, VERIFICATION.md:2296-2302); the column's producer
  is a later ticket. Only the `upsertPhase` comment
  (`src/store/index.ts:1151-1156`) is updated to stay truthful (earlyStop now
  HAS a producer; the record lives in the report block, not the column);
  `approval_gate_json` stays null exactly as before. No new store event, no new
  table. The store reads only `id`/`dependencies`/`completion` off schedule
  phases (`src/store/index.ts:1002`), so the new status is store-row-neutral.
- **No adapter, workspace, or harness change** (decisions.md:31-68,
  2026-10-18 — WorktreeProvider-only, untouched, not re-entered; AGENTS.md #1
  — no model knowledge anywhere; Gate 3 n/a).

## Why

Spec gap plus three explicit reservations, all verified by reading this
session: §6.3:328 names `earlyStop` on PhaseSpec with no implementation; §20
"Early Stop and Bounded Waste" (:1265-1281) lists seven example stop conditions
under "Waste is useful. Unbounded waste is a bug." and rules out
model-confidence conditions (:1281); §34:2133-2141 lists early stop among the
Milestone-8 adds; ROADMAP.md:20 puts stage 8 ("Generations, adversarial probes,
early stop") at spec M8, and ROADMAP.md:18 names early stop as remaining for
literal M6/M8. On the reservations: T-009 refused `earlyStop` as an unknown
field and carved it to "own successor tickets"
(docs/tickets/T-009-deterministic-scheduler.md:127-129) — this IS that
successor; T-030 carved "No early stop, no in-run approval pause — M8
vocabulary (spec §20:1265-1281) with no producer"
(docs/tickets/T-030-bounded-rd-loop.md:83-86); T-006 reserved the
`early_stop_json` column "written null this slice … no producer"
(docs/tickets/T-006-job-dag.md:23-38; `src/store/index.ts:144`, the hardcoded
null and its comment). The refusal pins exist and are load-bearing:
`scripts/check-scheduler.mjs:250-252` ("approvalGate and earlyStop are refused
until their successor tickets land") and the fixture-table entry at `:512`.

Design bound by the locked decisions: the stop condition is machine-computed
over terminal states — survivor counts — never model confidence (spec
§20:1281) and never a model opinion (decisions.md:19-21). The stop may only
skip not-yet-dispatched work; it never changes a verdict, never eliminates
anyone, never kills in-flight work. Default (no policy anywhere) is
byte-identical everywhere: no policy ⇒ no loop change, `concluded-early`
unreachable, no report block. Risk is bounded by the opt-in-additive-block
pattern (probes/rounds precedents) and Gate 1.10's token-free fake-adapter
harness (VERIFICATION.md:654-739), which already drives `parseJobsSpec` and the
runner end-to-end.

## Acceptance criteria

- [ ] Parsing: `earlyStop: { minSurvivors: <positive integer> }` parses and is
      preserved on PhaseSpec; a non-object `earlyStop`, a missing/non-integer/
      `< 1` `minSurvivors`, and any unknown sub-field refuse naming the
      offense — pinned by **Gate 1.10** parse faces
      (`scripts/check-scheduler.mjs`).
- [ ] The two pinned refusals flip explicitly (the T-018/T-019 flip
      discipline, VERIFICATION.md:1341-1347): the
      "approvalGate and earlyStop are refused until their successor tickets
      land" face (`scripts/check-scheduler.mjs:250-252`) becomes
      approvalGate-only refusal PLUS the new earlyStop positive/negative
      coverage; the fixture-table entry
      `['phase earlyStop', …, "unknown field 'earlyStop'"]` (`:512`) is
      replaced by the earlyStop cases. approvalGate refusal is retained; no
      other existing check weakened. VERIFICATION.md's Gate 1.10 prose (the
      unknown-fields bullet naming `earlyStop`, ~:693, and the carve paragraph
      "earlyStop/approvalGate … refused until their successor tickets land",
      ~:735) updated in the same change-set.
- [ ] The stop function is pure and deterministic: identical terminal maps ⇒
      identical decisions, no input mutated — pinned by direct-call faces in
      **Gate 1.10**.
- [ ] Met condition end-to-end (fake adapter, token-free): a `--jobs` run, one
      phase, N jobs, `minSurvivors: k` with `k < N`, cap < N — after the k-th
      success the remaining ready jobs are never dispatched
      (`dispatchIndex: null`, no candidate report, no lease/branch/worktree
      created), every ALREADY-dispatched job runs to completion exactly once
      (never killed — the fake adapter counts executions == dispatches), and
      the phase status is `concluded-early` — pinned by **Gate 1.10**.
- [ ] Dependents of a concluded-early phase stay never-dispatched (no branch,
      no candidate) while an independent phase still runs to completion
      (`completed`) — pinned by **Gate 1.10** (multi-phase early-stop face).
- [ ] In-flight survival: a job dispatched before the stop fires completes
      with its full verdict ladder (gates run, candidate report written) even
      though its phase concluded early — pinned by **Gate 1.10**.
- [ ] Report block: `earlyStops` present only for specs that declare a policy;
      `met: true` entries name condition/threshold/survivorIds/
      neverDispatchedIds and agree exactly with the schedule block's
      `dispatchIndex: null` entries for that phase; a `met: false` entry
      records a declared-but-unfired policy; a policy-less spec (default mode
      AND `--jobs`) carries NO block — pinned by **Gate 1.10** report faces.
- [ ] Default byte-identity: policy-absent runs produce today's report.json,
      schedule statuses, dispatch behavior, and evidence paths exactly —
      pinned by **Gate 1.10**'s existing default-mode and no-schedule faces
      riding green unchanged, plus **Gate 1.6**'s existing fixtures.
- [ ] Store: `ingest` accepts an earlyStops-carrying report and persists
      verdicts only — `phases.early_stop_json`/`approval_gate_json` stay null
      (the VERIFICATION.md:365-368 pin and `src/store/index.ts:1163` do NOT
      flip); rows identical to the same report without the block — pinned by a
      **Gate 1.6** (`scripts/check-store.mjs`) tolerance fixture (the T-030
      rounds-variant pattern, VERIFICATION.md:2296-2302).
- [ ] **Gate 2** once at landing (mandated: this change-set touches
      `src/runner.ts` and report shape, VERIFICATION.md:2474-2475):
      `npm run verify:full` ALL GREEN; the wrapper-budget note
      (VERIFICATION.md:2453-2472) applies to whoever drives it.
- [ ] VERIFICATION.md extended in the same change-set (Gate 1.10's new faces +
      the recorded flip; the Gate 1.6 tolerance note), and this ticket's
      status + the index row updated in the same change. If implementation
      discovers an additional existing fixture must flip: red-before/
      green-after per AGENTS.md #8.

## Landed

2026-10-20, one change-set on `ticket/T-031-early-stop` (lane worktree, base
cd6a61a). Files: `src/scheduler.ts`, `src/types.ts`, `src/runner.ts`,
`src/store/index.ts` (the `upsertPhase` comment only — no store behavior
change), `scripts/check-scheduler.mjs` (Gate 1.10: the recorded flip + the
new early-stop faces), `scripts/check-store.mjs` (Gate 1.6 tolerance
fixture), VERIFICATION.md, ROADMAP.md (the stage-6 remaining list and the
stage-8 disposition row — early stop now `done`), this ticket, and the
index row. No CLI change
(item 7 stated, not shipped: no flag that cannot bind), no adapter change
(Gate 3 n/a), no new npm dependency, no new store table or event.

- `src/scheduler.ts` — `EarlyStopPolicy` (exactly ONE machine-computed
  condition: `minSurvivors`, required positive integer), chosen and
  documented in the module header beside the ready-function contract (the
  stop DECISION is a pure function of terminal states; which jobs it leaves
  undispatched is interleaving-sensitive, exactly like dispatch order
  beyond the ready list); `PhaseSpec.earlyStop?` with strict sub-field
  parsing (plain object, unknown sub-fields refused naming the offense;
  `approvalGate` stays refused — the phase comment now says exactly that);
  the pure `earlyStopMet(policy, phaseJobs, terminal)`; `buildSchedule`
  derives the fourth `PhaseStatus` value `concluded-early` (declared policy
  MET + ≥ 1 never-dispatched job; precedence failed > concluded-early >
  completed > blocked; declared-but-unmet changes no status) with NO new
  inputs; `buildEarlyStops` derives the report block from exactly the
  schedule block's inputs.
- `src/types.ts` — `PhaseStatus` gains `'concluded-early'` (doc comment
  carries the precedence rule); additive `EarlyStopRecord` and
  `RunReport.earlyStops?` (present only when a `--jobs` phase declared a
  policy; default mode AND policy-less `--jobs` reports unchanged).
- `src/runner.ts` — `driveJobs` reads policies from `opts.scheduled.phases`
  only (default mode: no policies, the loop untouched), evaluates
  `earlyStopMet` per iteration (monotone — once met it stays met), and
  filters the met phases' not-yet-dispatched jobs out of the
  dispatch-ELIGIBLE input BEFORE the ready call's concurrency-cap slice
  (`eligibleForDispatch` — review round 1: a post-slice filter could let a
  suppressed-but-ready job occupy the whole cap slice and strand another
  phase's dispatchable work); the stop only suppresses DISPATCH (in-flight
  jobs run to completion; no cancellation path added); suppressed jobs
  record `dispatchIndex: null` with no candidate report and no lease;
  dependents stay never-dispatched for free (a never-dispatched dependency
  never reaches terminal success); termination unchanged (the
  `inFlight.size === 0` break fires exactly as before). `runSkeleton`
  attaches the `earlyStops` block when non-empty.
- `src/store/index.ts` — only the `upsertPhase` docblock updated (earlyStop
  now HAS a producer; the record lives in the report block, not
  `early_stop_json`, which stays null; `approval_gate_json` stays null
  exactly as before). The `PHASE_COMPLETED` filter is untouched — a
  concluded-early phase gets no event. No row shape change: the store reads
  only `id`/`dependencies`/`completion` off schedule phases.
- `scripts/check-scheduler.mjs` (Gate 1.10) — the recorded flip, this
  change-set's only intentional invalidations of existing assertions: the
  G2 face "approvalGate and earlyStop are refused until their successor
  tickets land" became approvalGate-only refusal PLUS the earlyStop
  positive face (`{ minSurvivors: 2 }` parses and is preserved verbatim on
  PhaseSpec) and negative faces (non-object, missing/non-integer/`< 1`
  minSurvivors, unknown sub-field — each naming the offense); the S7
  fixture-table entry `['phase earlyStop', …, "unknown field 'earlyStop'"]`
  was replaced by the five earlyStop refusal cases. Net strictness
  increases (the T-018/T-019 precedent); no other existing check weakened.
  New legs, all green: the pure `earlyStopMet` direct-call faces; ES1 (met
  end-to-end, cap 1 < N 3, k 1: the remaining ready jobs never dispatched —
  `dispatchIndex: null`, no candidate, no branch/worktree; executions ==
  dispatches; `concluded-early`; the block agreeing with the schedule on
  disk); ES2 (multi-phase: dependents never-dispatched while the
  independent phase completes); ES3 (in-flight survival: both pre-stop
  dispatches complete with full verdict ladders); ES4 (declared-but-unfired
  policies recorded met:false — a failing phase keeps `failed` precedence,
  a starved phase keeps `blocked`); ES5 (met + zero never-dispatched ⇒
  `completed`); ES6 (policy-less `--jobs` carries no block); ES7 (review
  round 1 — a suppressed job sorting AHEAD of an independent phase's job
  under cap 1 never consumes the dispatch capacity: `z1` still dispatches,
  `zz` records `completed`, never a false `blocked`); the S6 default-mode
  face extended with the no-earlyStops pin.
- `scripts/check-store.mjs` (Gate 1.6) — the earlyStops-carrying tolerance
  variant (the rounds-variant pattern): policy columns stay null, verdict
  rows identical to the same report minus the block, no new table, a
  concluded-early status deriving no `PHASE_COMPLETED` event, re-ingest
  idempotent.

**Review round 1 (2026-10-21), red-before/green-after per AGENTS.md #8.**
The reviewer found a real stranding bug: the suppression filter sat AFTER
`readyJobs`' concurrency-cap slice, so a suppressed-but-ready job sorting
ahead of another phase's ready job could occupy the whole cap slice every
iteration — an independent policy-less phase's job never dispatched (a free
slot wasted for the rest of the run) and its phase recorded `blocked`
(starved-by-upstream-failure — active misinformation, the exact failure
this ticket's `concluded-early` status exists to prevent). My landed ES
faces missed it because their ids sorted favorably (ES2's own comment said
so). Reproduced red on the lane code with the reviewer's exact scenario
(phase `aa` {a1, a2, minSurvivors 1}, independent `zz` {z1}, cap 1, ids
ascending) pinned as ES7 FIRST — Gate 1.10 exited 1 with exactly the two
new ES7 assertions failing (`FAIL: ES7: the independent job still
dispatches…`, `FAIL: ES7: the independent phase records completed…`, the
third ES7 face — what the stop owes its own phase — already green), every
pre-existing face unchanged and green. Then the fix: suppression is applied
to the dispatch-eligible input BEFORE the cap slice (`eligibleForDispatch`
in `src/runner.ts` — a stopped phase may only skip its own undispatched
work; it never consumes another phase's dispatch capacity; no policies ⇒
the input passes through unchanged). Same check re-run: ALL GREEN, exit 0,
all three ES7 faces ok. This is an added pin, not a weakened one — no
existing assertion changed in this round.

Gates measured in the lane (every number from this change-set's runs):

- Gate 0 `tsc --noEmit`: exit 0.
- Gate 1.10 standalone
  (`node node_modules/tsx/dist/cli.mjs scripts/check-scheduler.mjs`):
  ALL GREEN — the new ES legs 19/19 ok plus every pre-existing face
  unchanged and green (the G2/S7 flips ride green with the new messages).
- Gate 1.6 standalone (`… scripts/check-store.mjs`): ALL GREEN — the 7 new
  earlyStops-variant assertions ok, every pre-existing fixture unchanged.
- Full fast tier `node scripts/verify.mjs fast` (Gate 0+0.5+1+1.5+1.6+
  1.7-1.22): ALL GREEN, 0 failures.
- Review round 1 re-runs (2026-10-21, in the lane): the red bar — Gate 1.10
  with ES7 landed BEFORE the fix: exit 1, `check-scheduler: 2 failure(s)`,
  only the two ES7 assertions failing; after the fix — Gate 1.10 standalone
  ALL GREEN (exit 0, all three ES7 faces ok), then the full fast tier
  `node scripts/verify.mjs fast` ALL GREEN, `grep -c '^FAIL'` = 0.
- **Gate 2 (`npm run verify:full`) NOT run by this lane** — mandated by
  VERIFICATION.md ("Required when touching `src/runner.ts` … or anything
  that changes report shape") and delegated to the driving wrapper per the
  wrapper-budget note (VERIFICATION.md Gate 2 section): it spends real
  model tokens and minutes. The driving run must record it here if it
  lands after this commit.

Deviations from the ticket text: none of substance. `buildEarlyStops` lives
in `src/scheduler.ts` beside `buildSchedule` (the ticket named only
`earlyStopMet` as the exported pure function; the record builder is
schedule-derived evidence and belongs beside the schedule builder it must
agree with — pinned through Gate 1.10's report faces). The acceptance
checkboxes above are left unchecked per the T-030 convention; the Landed
section records what pinned them.

## Verification

Gate 0, Gate 0.5, Gate 1, Gate 1.5, Gate 1.6 (tolerance fixture), Gate 1.10
(extended — the load-bearing pin: it already drives `parseJobsSpec` and the
runner end-to-end with fake adapters, zero model tokens) — all via
`npm run verify`; **Gate 2** once (`npm run verify:full`, mandated by
VERIFICATION.md:2474-2475). Gate 3 not triggered — no adapter change.

## References

docs/spec/inference-refinery-v2.md §6.3:328 (the named-but-undefined field),
§20:1265-1281 (Early Stop and Bounded Waste; the no-model-confidence rule at
:1281), §34:2133-2141 (M8 adds) · docs/decisions.md 2026-10-10 (machine gates
decide survival, :19-21; run root `C:\swarm\`, :25-26) and 2026-10-18
(WorktreeProvider-only, :31-68 — untouched, not re-entered) · docs/ROADMAP.md
:18, :20 (stage 8 / remaining-for-M6-M8) · T-009:127-129 (the refusal carve
this fills), T-030:83-86 (the M8 carve this fills), T-006:23-38 (the reserved
column, carved) · VERIFICATION.md Gate 1.10:654-739 (the not-dispatched pin at
:711-716), :365-368 (the unflipped null-column pin), :1066-1071
(choose-and-document precedent), :1341-1347 (flip discipline), :2296-2302
(store-invisible block precedent), :2453-2475 (Gate 2 mandate + wrapper
budget).
