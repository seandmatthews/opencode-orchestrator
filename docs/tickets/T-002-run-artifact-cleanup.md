# T-002 — Run artifact cleanup automation

**Status:** done 2026-10-10
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

- [x] `npm run clean -- --run <runId>` removes all worktrees and `swarm/*` branches
      recorded in that run's `report.json` (or discovered under `wt/`), exits 0, and
      prints per-item results — pinned by a fast-tier check that creates a throwaway
      fixture repo + worktree + branch, cleans it, and asserts `worktree list` and
      `branch --list swarm/*` are empty. (Gate 1.5)
- [x] Cleanup refuses (non-zero exit, clear message) when a worktree contains
      uncommitted changes, unless `--force` — pinned by the same fast-tier check with
      a dirtied worktree. (Gate 1.5)
- [x] `--all` cleans every run directory under `C:\swarm` that is not the newest —
      documented behavior; manual spot-check noted in the ticket (no auto-pin).
      (Manual spot-check 2026-10-10, see Landed; additionally pinned in the sandbox
      by Gate 1.5.)
- [x] `npm run verify:full` performs its post-run disposal through this path — pinned
      by Gate 2's existing hygiene assertions passing after the switch.
- [x] VERIFICATION.md documents the clean command in the same change-set.

## Verification

Gate 0, Gate 1, Gate 2 (post-switch), fast-tier cleanup check (new, added here).

## Landed (2026-10-10)

- `src/clean.ts` — the clean command: `--run <runId>`, `--all`, `--force`,
  `--run-root` (default `C:\swarm`). Removes worktrees (list-form
  `git worktree remove --force`), then `git branch -D` on their `swarm/*` branches;
  prints per-item results; exits 1 on any refusal or failure. Worktree list comes
  from `report.json` plus anything discovered under `wt/`; the repo comes from the
  report's `repo` field, falling back to the worktrees' own `.git` pointers
  (crash-mid-run recovery). Evidence is never deleted; emptied `wt/` dirs are tidied.
- Branch-name derivation extracted to `branchForLeaseId()` in
  `src/workspace/worktree.ts` — single source shared by lease and cleanup.
- `npm run clean` script added; Gate 2's post-run disposal switched to the command
  (`--force` — the run captured the evidence before disposal); hand-rolled loop
  removed from `scripts/verify.mjs`, hygiene assertions unchanged and green after
  the switch.
- Gate 1.5 added to the fast tier (throwaway sandbox repo under `C:\swarm\verify-clean`):
  pins AC#1 (report-driven clean), AC#2 (dirty refusal + `--force`, exercising the
  `wt/`-discovery path), and — beyond the ticket's "manual only" note — `--all`
  keep-newest semantics. No existing assertion was weakened.
- Docs: VERIFICATION.md (Gate 1.5 section, Gate 2 disposal bullet, Known issues #4
  pointer), README usage, AGENTS.md run-it + layout.

Deviations:

- The optional cross-run checkout lock was **not** built — the ticket marks it
  optional and no acceptance criterion names it. Concurrent cleanup/run racing is
  not real yet (runs are single-session); the lock discipline lands with the stage-1
  control plane or the pigeon-style `checkout-lock.ps1`.
- ROADMAP: also synced the T-001 row (still said "next" although T-001 landed
  2026-10-11) — one status cell, no other changes.

Gate numbers: Gate 0 exit 0 · Gate 1 `build ok` + `tests ok` · Gate 0.5 ALL GREEN ·
Gate 1.5 ALL GREEN (`npm run verify` ALL GREEN) · Gate 2 ALL GREEN post-switch
(planner 2 briefs, c01+c02 PASS with parsed reviews, clean disposed 4/4 items,
"only main remains" + "no swarm/* branches" ok).

Manual spot-check (`--all` on the real `C:\swarm`): kept newest run 20261011011732
untouched; swept the three older runs (20261010235146, 20261010235809,
20261011000536) — their worktrees/branches were already gone (manually disposed in
earlier sessions, the exact pain this ticket removes), empty `wt/` dirs removed,
`demo-target` untouched, exit 0.

## References

docs/spec/inference-refinery-v2.md §16 (worktree lifecycle and GC), VERIFICATION.md
Known issues #4.
