# T-060 — Worker orientation block: engine-composed lease path + base tree facts in the worker dispatch (KI#6 prompt-side; register A2)

**Status:** done (2026-10-27)
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 3
**Depends on:** T-059 (shares the digest producer)

## What

Four of the five recorded worker-derailment classes (Known issue #6) are
path/repo confusion, and the engine currently tells the worker nothing
about where it is beyond cwd + pinned env:

- 2026-10-22: both workers probed the CANONICAL fixture instead of their
  lease (inferred from goal text + run-root prefix) and no-op'd on
  auto-rejected reads.
- 2026-10-23: the round-2 brief asserted `vec3.js` at base; the worker
  Read it, failed, gave up (the premise-lie class — T-050 guards the
  brief; the worker still had no way to check).
- 2026-10-24 (a): the worker mis-transcribed its OWN lease path — the
  candidate id's hyphen read as a path separator (`wt\c02\r2`), one
  auto-rejected absolute read, give-up.
- 2026-10-24 (b): explore-then-give-up — a full successful exploration
  of the lease, then nothing (the class with no containment event).

The change — an engine-composed ORIENTATION BLOCK prepended to the
worker dispatch, the T-050 annotation seam's discipline (engine
mechanics, never model judgment; the planner-authored brief text stays
recorded evidence):

1. The candidate's absolute lease path VERBATIM, with one line stating
   that this exact path is the workspace and everything outside it is
   out of scope (the canonical checkout included).
2. The baseSha the lease is pinned to.
3. The capped file tree from T-059's digest producer (the same bytes,
   no second composition path).
4. Deterministic composition, capped total size (named constant); the
   full dispatched prompt (orientation + brief) recorded in the run
   artifacts; the brief text in report.json BYTE-UNCHANGED; the T-050
   premise guard untouched and still inert for briefs whose paths all
   exist at base.

Non-goals: retrying no-ops (the blind-reroll ban stands, decisions.md
2026-10-21; a zero-byte diff still eliminates, AGENTS #7); any verdict
change (gates decide; this is prompt-side only); per-run adaptive
behavior across candidates (every candidate in a run gets the same
block shape — no differential treatment the report cannot explain).

## Why

A2's disposition — "instrument yield-per-run before scaling anything" —
is satisfied (T-049's yield block; T-050's premise guard). The remaining
mechanism-level move is the cheapest one: the two facts every derailed
worker got wrong (where exactly am I, what files exist) are
deterministic, cost a few hundred prompt tokens, and attack all four
confusion classes from the prompt side. Whether the no-op rate actually
moves is the yield block's question, measured opportunistically on this
ticket's driving Gate 2 runs (the T-050 precedent: one honest data point
per run, no same-run promotion).

## Acceptance criteria

- [ ] Red bar recorded first (AGENTS #8), token-free: on main, the
      dispatched worker prompt for a stubbed run carries no orientation
      block — asserted as the red.
- [ ] Determinism + fidelity: for a fixed lease the block composes
      byte-identically across two compositions, and the lease path in
      the block is byte-equal to the actual worktree path — pinned by a
      new fast-tier check (next free gate number at landing).
- [ ] Prompt-version honesty: `Attempt.promptVersion` for worker
      attempts DIFFERS from main's for the same inputs (the T-029
      producer records the composition change; it must not stay silent)
      — same check.
- [ ] Brief integrity: the planner-authored brief bytes in report.json
      are byte-identical to main's for the same inputs (only the
      engine-composed wrapper grows) — same check.
- [ ] Cap enforced: the block's total size stays within its named
      constant, truncation stated in-block when hit — same check.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) —
      pinned by the full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (worker dispatch prompt changed; the standing
      trigger fires): every existing Gate 2 assertion green, the yield
      block recorded, and the run's no-op/derailment picture noted in
      the ticket's Landed section as one data point (no same-run
      promotion, AGENTS #11). **Gate 3 n/a** (no adapter change).

## Landed

2026-10-27. What changed, exactly:

- **`src/worker-orientation.ts` (new)** — the block producer: pure string
  assembly over `{leasePath, baseSha, digest}`; the lease path rides
  VERBATIM on its own two-space-indented line under the one-line scope
  statement (canonical checkout included, copy-never-retype), the baseSha
  line, and the tree section. Documented exported cap
  `MAX_ORIENTATION_CHARS = 8_000` (below the digest's own 12,000 — the
  worker prompt stays token-cheap); overflow re-cuts paths from the END
  with the in-section `TRUNCATED` line naming the binding cap and the
  honest not-shown count. The module spawns nothing.
- **`src/planner-digest.ts`** — the tree-section composer is refactored
  out of `composeText`'s inline form into the exported
  `composeTreeSection` (T-059's composed digest bytes are byte-identical —
  Gate 1.45 re-run green, its pinned literals untouched), and
  `PlannerDigest` additively carries `treePaths` (the post-cap listed
  paths) so the orientation block re-cuts the SAME producer output — the
  ticket's "the same bytes, no second composition path".
- **`src/runner.ts`** — the run's digest is composed ONCE per run for BOTH
  consumers (planner contextBlock + every worker block); the
  planner-side evidence (`planner-digest.txt`, `RunReport.plannerDigest`)
  stays tied to `--no-planner-context` exactly as T-059 pinned it, and a
  composition failure logs loudly once and degrades the whole run to
  today's exact prompt bytes on both sides. New exported
  `workerDispatchPrompt(brief, workspacePath, orientationBlock)` — the
  block prepended to the UNCHANGED builder template with one blank line —
  is the single composition path the dispatch and the pinning gates share.
  Every attempt records its full dispatched prompt as
  `dispatched-prompt.txt` in its evidence dir (riding `outputArtifacts`);
  `Attempt.promptVersion` hashes that exact text (it moves vs main's bare
  `builderPrompt` hash for the same inputs — pinned). `base.brief`,
  `inputContextHash` (deliberately still the template hash — the block's
  per-attempt variation is the lease path, exactly like the excluded
  workspace line), the premise guard, the ladder, and every verdict
  expression are untouched. No report field added.
- **Checks updated in the same change-set, strength preserved (each still
  exact equality; no assertion deleted or loosened)**: Gate 1.8 and 1.24's
  exact `outputArtifacts` arrays gained the per-attempt
  `dispatched-prompt.txt`; Gate 1.24/1.27's attempt-2 `promptVersion`
  recomputations and Gate 1.35's dispatched-prompt equalities moved to the
  `workerDispatchPrompt` composition; Gate 1.45's worker fake matches
  `includes('You are implementing')` (the worker prompt now begins with
  the block; planner prompts never carry the line).

Gates measured in this lane: **Gate 0 green** (`npm run typecheck`, exit
0); **red bar recorded first** — the new Gate 1.46 check run on the
pre-change lane (= main) failed with 13 named failures, exit 1, verbatim
at `C:\swarm\verify-red\T-060-red.log` (module import fails; the E1 drive
records the AC red: the dispatched worker prompt carries no orientation
block, no `dispatched-prompt.txt`, promptVersion equals main's
bare-builder hash); **Gate 1.46 green** (`node node_modules/tsx/dist/cli.mjs
scripts/check-worker-orientation.mjs` — 31 assertions, legs M/O1–O4/E1/E2:
determinism, lease-path fidelity pinned against the run's own
dispatch.jsonl worktreePath, promptVersion movement, brief byte-integrity
against the planner-authored bytes, cap honesty, premise-guard inertness,
same-block-shape-per-run, digest-ON and --jobs faces); **full fast tier
ALL GREEN** (`node scripts/verify.mjs fast`, exit 0 — every gate section
including the updated 1.8/1.24/1.27/1.35/1.45 and the new 1.46).

**Gate 2 owed, not run in this lane** (the driving script re-runs it after
landing — real model tokens, and this lane was instructed not to spend
them): the standing trigger fires because the worker dispatch prompt
changed. The driving run must keep every existing Gate 2 assertion green,
and its no-op/derailment picture is to be recorded HERE as one honest
data point (the T-050 precedent: measured opportunistically on the
driving run, no same-run promotion, AGENTS #11). At landing time this
section records only the fast-tier evidence above — the yield question
the ticket's Why names ("whether the no-op rate actually moves") stays
open until that run lands. Gate 3 n/a (no adapter change).

## Verification

New fast-tier check: composition determinism, lease-path fidelity,
promptVersion movement, brief byte-integrity, cap honesty. Gate 0, full
fast tier ALL GREEN; Gate 2 owed and recorded at landing.

## References

VERIFICATION.md Known issue #6 (all four confusion classes, with their
worker.log evidence) · docs/adversarial-review-2026-10-23.md A2 (the
disposition this extends) · src/runner.ts (worker dispatch composition;
the T-050 annotation seam at src/premise.ts is the discipline
precedent) · docs/tickets/T-029 (promptVersion — the producer that must
record this change), T-049 (the yield measuring stick), T-050 (the
brief-side sibling), T-059 (the shared digest producer).
