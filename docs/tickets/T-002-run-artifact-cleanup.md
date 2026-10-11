# T-002 — Run artifact cleanup automation

**Status:** proposed
**Category:** ops
**Value (1-5):** 4 · **Risk (1-5):** 3
**Depends on:** —

## What

Add `npm run clean -- --run <runId> [--all]`: removes a run's worktrees
(`git worktree remove --force`), deletes its `swarm/*` branches, and reports what was
removed and what was refused. The verify script uses it for post-run disposal instead
of hand-rolled loops. Optionally a cross-run checkout lock file so concurrent cleanup
and runs never race (precursor to the pigeon-style `checkout-lock.ps1` discipline).

## Why

Every session so far has ended with manual `git worktree remove` + `branch -D` calls,
and Git Bash quoting bit us on the variable-expansion path twice (VERIFICATION.md
Known issues #4). Leftover branches silently block reuse of candidate IDs and pollute
`worktree list`. This is proven, repeated pain with a small mechanical fix.

## Acceptance criteria

- [ ] `npm run clean -- --run <runId>` removes all worktrees and `swarm/*` branches
      recorded in that run's `report.json` (or discovered under `wt/`), exits 0, and
      prints per-item results — pinned by a fast-tier check that creates a throwaway
      fixture repo + worktree + branch, cleans it, and asserts `worktree list` and
      `branch --list swarm/*` are empty.
- [ ] Cleanup refuses (non-zero exit, clear message) when a worktree contains
      uncommitted changes, unless `--force` — pinned by the same fast-tier check with
      a dirtied worktree.
- [ ] `--all` cleans every run directory under `C:\swarm` that is not the newest —
      documented behavior; manual spot-check noted in the ticket (no auto-pin).
- [ ] `npm run verify:full` performs its post-run disposal through this path — pinned
      by Gate 2's existing hygiene assertions passing after the switch.
- [ ] VERIFICATION.md documents the clean command in the same change-set.

## Verification

Gate 0, Gate 1, Gate 2 (post-switch), fast-tier cleanup check (new, added here).

## References

docs/spec/inference-refinery-v2.md §16 (worktree lifecycle and GC), VERIFICATION.md
Known issues #4.
