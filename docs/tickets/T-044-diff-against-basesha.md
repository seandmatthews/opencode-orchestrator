# T-044 — Evidence-destruction guard: diff capture pins baseSha (not HEAD) + `swarm/*` branch deletion refuses non-base tips

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** —

## What

`gc.ts:296-299` justifies `git branch -D` with "Workers never commit (the
diff is captured first), so a swarm/* branch carries no unique evidence."
Nothing enforces the premise — and the spec itself says prompts are not
boundaries (§3.6: "reinforce, never implement, policy"). The builder prompt's
"do not create git commits" line (`src/runner.ts:173`) is exactly such a
prompt-rule, and committing is a natural LLM action. Today the chain is:

worker commits → `WorktreeProvider.diff`'s `git diff HEAD`
(`src/workspace/worktree.ts:84`) returns EMPTY (tree == HEAD) → `diffBytes
=== 0` → NO-OP verdict (`src/runner.ts:1201`; store elimination mapping
`src/store/index.ts:1430-1436`) → the worktree now reads CLEAN, so
disposal's dirty-refusal (`src/disposal.ts:85-98`) doesn't fire → worktree
removed, `removeBranch` force-deletes (`src/disposal.ts:47-60`) → **the
commit — the only copy of the work — is destroyed, silently, with the
candidate mislabeled a no-op.**

Two changes, one invariant ("evidence is captured before disposal" — made
true by mechanism instead of premise):

1. **Diff against the lease's recorded `baseSha`, not HEAD.**
   `WorktreeProvider.diff` keeps `git add -A --intent-to-add .` (untracked
   capture, T-026 posture) and changes the diff target:
   `git diff <lease.baseSha> --binary`. A committing worker's work then
   appears in the captured diff; NO-OP comes to mean its honest semantics —
   "no change relative to the pinned base" (a worker that commits AND
   reverts to base is a true no-op). **Structurally inert for every
   non-committing worker**: each lease checks out at `baseSha`, so
   `HEAD === baseSha` until a commit moves it, and the diff bytes are
   identical — the change class this repo favors (the parse-repair
   precedent). The NO-OP ladder expression itself is untouched.
2. **The branch guard.** `removeBranch` gains the expected base (report
   `baseSha` plumbed through `disposal.ts`'s `RunReportLike`/`readReport`)
   and REFUSES `git branch -D` when the branch tip != baseSha, with a loud
   line naming the branch, tip, and base ("carries commits beyond baseSha —
   evidence; re-run with --force to discard"). Bypass = the existing
   `--force`, the same posture as the dirty-refusal. Applies everywhere
   `removeBranch` runs (clean and gc — shared internals, T-020).

## Why

This is the leading instance of a pattern the 2026-10-23 adversarial review
named as the most dangerous in the codebase: **invariants that gate
destruction are documented, not enforced**. The cheapest adversarial worker
— or one ordinary derailing model — wins not by faking a pass but by
violating an unenforced premise so the machine itself mislabels and shreds
the evidence. The fix is two small mechanical changes at the exact seams
already built for this (the lease knows its baseSha; disposal already has a
refusal vocabulary), needs no decisions.md change (it enforces the existing
"evidence before disposal" rule rather than any new verdict semantics), and
its inertness for honest runs is provable byte-for-byte.

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free scratch-repo check:
      a lease at a base commit, a simulated committing worker (`git commit`
      in the worktree), then today's `diff()` — asserts the empty capture
      (the NO-OP mislabel) and that `removeBranch` deletes the
      commit-carrying branch — the check fails on main as the red bar.
- [ ] Green, capture: the same scenario post-change — `diff()` returns the
      committed work (non-empty, contains the commit's change), the
      candidate ladder sees `diffBytes > 0` — pinned by the same check.
- [ ] Green, guard: `removeBranch` refuses a branch whose tip != baseSha,
      prints the loud evidence line, and `--force` still removes it —
      pinned by the same check (both legs).
- [ ] Inertness pin: for a non-committing worktree the new diff bytes are
      byte-identical to the old (`git diff HEAD` ≡ `git diff <baseSha>`
      when HEAD === baseSha) — pinned by the check comparing both forms on
      an identical tree, and by the existing binary-safe capture/replay
      checks (Gate 1.x, T-026) riding green unchanged.
- [ ] True no-op semantics preserved: a worktree returned exactly to base
      (edits reverted, or commit-then-revert) still captures an empty diff
      and the ladder still records the NO-OP verdict — pinned by the check.
- [ ] gc's lane rides the same guard (shared `removeBranch`) — pinned by
      the existing gc check extended with a commit-carrying-branch refusal
      assertion.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) — pinned
      by the full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (`src/` changed: workspace provider + disposal);
      trigger analysis recorded at landing. **Gate 3 n/a**.

## Landed

## Verification

New fast-tier check (next free gate number at landing): commit-capture red
bar, branch-tip guard both legs, inertness byte-compare, true-no-op
preservation, gc lane. Gate 0, T-026's binary round-trip checks green, full
fast tier ALL GREEN; Gate 2 owed and recorded.

## References

src/workspace/worktree.ts:67-85 (lease/diff — the seam and its recorded
baseSha) · src/disposal.ts:47-60 (`removeBranch`), :85-98 (the dirty-refusal
the clean-tree commit sidesteps) · src/gc.ts:296-299 (the documented
premise this enforces) · src/runner.ts:173 (the prompt-rule that is not a
boundary), :1201 (ladder) · src/store/index.ts:1430-1436 (no-op elimination
mapping) · docs/spec/inference-refinery-v2.md §3.6 (prompts reinforce,
never implement) · docs/tickets/T-026 (binary-safe capture), T-020 (shared
disposal) · 2026-10-23 adversarial review finding F5.
