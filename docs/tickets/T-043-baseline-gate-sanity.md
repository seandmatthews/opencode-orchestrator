# T-043 — Baseline gate sanity: gates proven green on the untouched base before any dispatch; `--allow-red-base` override

**Status:** done 2026-10-23
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** —

## What

The engine never runs the run's gates on an untouched worktree at `baseSha`
before fanning out. If the base is already red — a colleague broke the build,
the environment regressed, a gate needs a dependency install nothing provides
(the T-042-era review's F9 class) — every candidate fails gates for reasons
unrelated to its work, the run burns its full token and wall-clock budget,
and the honest report reads "N bad candidates" instead of "the base is red".

The NO-OP rule's own logic implies the inverse check: gates on an untouched
tree prove nothing ABOUT A WORKER, but they are the only thing that proves
the base itself is green — without that, a gate FAIL is uninterpretable
(candidate-broke-it vs base-was-always-broken). Today neither the runner nor
the CLI establishes it (`src/runner.ts` runs gates only after a worker
executes; `src/cli.ts` validates only that the repo has a commit).

The change:

1. **The check** — in `runPipeline` (`src/cli.ts`), after `baseSha` resolution
   and BEFORE `runSkeleton` (zero planner/worker tokens spent): lease one
   worktree at `baseSha` through the same `WorktreeProvider` (a lease id that
   cannot collide with any job id — reserved, not matching the job-id
   charset), run every DISTINCT gate (name, command) the run will use — the
   run-level set in default mode; the deduplicated union across jobs in
   `--jobs` mode — sequentially, with the standard gate timeout, under the
   checkout lock already held.
2. **The refusal** — any failing gate aborts the run before dispatch: exit 1
   with a loud per-gate block (name, command, exitCode, outputTail), a
   `baseline-check.json` artifact in the run dir (the report.json shape is
   for completed runs; this is a refusal artifact), and the worktree disposed
   before exit.
3. **The escape hatch** — `--allow-red-base`: "repair a red base" is a
   legitimate goal, so the refusal is overrideable exactly once and
   explicitly (the `--force-lock` posture: a named human override, not a
   knob). When overridden, the baseline block still runs and is recorded in
   `baseline-check.json` with every failure — the run proceeds, and the
   evidence of the red base rides the run dir. The header/refusal state is
   recorded so a report can never silently mean "passed gates over a red
   base".

Non-goals: no verdict changes, no report.json schema change (the refusal
happens before a report exists), no parallelization of the baseline gates,
no new numeric knobs (gate timeout stays the gate's own).

## Why

One extra lease + one gate pass converts an entire class of wasted,
misattributed runs into a one-line refusal — the cheapest token savings in
the repo. It also gives the dependency-blindness class (no install story,
T-047's environment asymmetry) an immediate, named failure mode on run one
of any real target repo, instead of N mysterious candidate FAILs. And it is
the symmetric completion of the engine's own honesty posture: the ladder
already refuses to bless an untouched tree as a PASS; it should equally
refuse to interpret FAILs against a base it never verified.

## Acceptance criteria

- [x] **Red bar recorded first** (AGENTS #8): a real CLI run (machine-worker
      composition acceptable — the trigger analysis records the choice)
      against a fixture whose base is red (break `test.js` at the base
      commit) proceeds to dispatch candidates today; the recorded run dir +
      report is the red evidence — referenced from this ticket.
- [x] Green, refusal: the same red-base fixture, post-change — the run
      refuses before any dispatch (zero planner/worker dispatch evidence in
      the run dir), exits non-zero, prints the per-gate failure block, and
      writes `baseline-check.json` naming gate name/command/exitCode —
      pinned by a new fast-tier check (token-free, real CLI invocation with
      a stub/machine composition).
- [x] Green, override: the same run with `--allow-red-base` dispatches
      candidates AND carries the recorded baseline block in the run dir —
      pinned by the same check.
- [x] Green-base runs are unchanged: against the standard demo fixture the
      baseline gates pass, the run proceeds, and the report.json is
      shape-identical to today's (additive `baseline-check.json` aside) —
      pinned by the existing Gate 1 fixture check riding green.
- [x] `--jobs` mode: per-job gate sets are checked (deduplicated union) —
      pinned by the check script with a two-job spec carrying disjoint
      gates, one red.
- [x] The baseline worktree is disposed on every path (pass, refusal,
      override) and its `swarm/*` branch removed — pinned by the check
      script asserting no residual worktree/branch after each path.
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6) — pinned
      by the full fast tier ALL GREEN.
- [x] **Gate 2 owed** (`src/cli.ts`/runner path changed); trigger analysis
      recorded at landing. **Gate 3 n/a** (no adapter touched).

## Landed

`src/cli.ts` only — `runPipeline` now runs `checkBaselineGates` after
`baseSha` resolution and before `runSkeleton`: one lease at the reserved
id `wt/_baseline` (underscore outside the job-id charset — SPEC_ID_PATTERN
`[a-z0-9][a-z0-9-]*` — so no job lease can ever collide), every DISTINCT
gate (name+command dedup; the run-level set in default mode, the
deduplicated union of per-job effective sets in `--jobs` mode) run
sequentially with the standard CommandGate timeout, worktree removed and
`swarm/wt--baseline` branch deleted on every path (a disposal failure
aborts loudly — a leftover branch would refuse the next run's baseline
lease), and `<runDir>/baseline-check.json` written on every path
(green/refusal/override, plus the vacuous no-gates record). Red base ⇒ the
loud per-gate block thrown (exit 1, zero planner/worker tokens, lock
released by main's finally) unless `--allow-red-base` (the --force-lock
posture) proceeds with the `BASELINE RED (OVERRIDDEN)` block printed and
`overridden: true` recorded. No verdict, ladder, or report.json change.

Red bar (pre-change tree = main at 2106975, machine-worker composition —
the trigger analysis: a red base is a run-pipeline property, not an
adapter property): run `20261023201554` at
`C:\swarm\verify-red\T-043-redbar\runs\20261023201554` — exit 0, both
candidates dispatched and burned, reported as bad candidates over a base
that was always broken (report.json + dispatch.jsonl kept as the
evidence).

Pinned by **Gate 1.29** (`scripts/check-baseline-gate.mjs`, wired into
`scripts/verify.mjs` fast tier): 38 ok, ALL GREEN — refusal/union/override/
green-inertness/run-level-set/vacuous faces, per-path disposal. Five
existing fast-tier fixtures whose real-CLI gates were red at their own
bases followed the contract (base-state content committed; every
assertion at full strength, re-measured green): Gate 1.17 S5, Gate 1.19,
Gate 1.21 S3, Gate 1.24 G5b/G5c, Gate 1.25 S6. Full fast tier ALL GREEN
(1641 ok). Gate 2 owed (the run pipeline entry changed — the standard
e2e now runs the baseline leg over the demo fixture's green base,
additive stdout only); Gate 3 n/a (no adapter touched).

## Verification

New fast-tier check (next free gate number at landing): red-base refusal,
override leg, green-base inertness, jobs-mode union, disposal on all paths.
Gate 0, Gate 1 (fixture baseline semantics unchanged), full fast tier ALL
GREEN; Gate 2 owed and recorded.

## References

src/cli.ts:487-519 (`runPipeline` — the insertion point), :469-475 (repo
validation, the only pre-run check today) · src/runner.ts:1076-1090 (gates
run only post-worker), :1201 (the ladder whose interpretability this
establishes) · src/workspace/worktree.ts:67-74 (lease at baseSha) ·
AGENTS.md #7 (the NO-OP rule — whose inverse this completes) · docs/tickets/
T-004 (`--force-lock` override posture) · 2026-10-23 adversarial review
finding F8.
