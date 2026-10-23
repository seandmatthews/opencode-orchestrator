# T-048 — Clean's dirty predicate: refuse on uncaptured changes, not on captured evidence

**Status:** proposed
**Category:** ops
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** T-044 (the predicate compares against the captured diff; its semantics are T-044's)

## What

`disposeTargets` refuses any worktree whose `git status --porcelain` is
non-empty (`src/disposal.ts:85-98`) — "uncommitted changes may be the only
un-captured copy." But `WorktreeProvider.diff()` runs `git add -A
--intent-to-add .` on every attempt (capture), and every candidate worth
cleaning has real edits, so porcelain ALWAYS reads dirty for exactly the
worktrees worth cleaning. Verified 2026-10-23 (scratch worktree, post-capture
porcelain: ` M build.js` / `A notes-new-file.md`). Net effect:

- `npm run clean -- --run X` without `--force` refuses every meaningful
  worktree and succeeds only for no-ops;
- the operator learns to always pass `--force`;
- at which point the protection's real target — changes made AFTER capture
  (a verifier stray write, a crashed diff capture, anything the evidence
  does not hold) — is silently discarded too, because `--force` cannot tell
  the two apart.

By construction, every non-ignored change made before capture IS in
`diff.patch` (the capture is `git add -A --intent-to-add .` + full diff).
The refusal therefore fires precisely when evidence exists —
meaningless-by-construction — and fails to fire for the case it was built
for, once habituated `--force` is in play.

The change — make the predicate mean what the message claims:

1. **Evidence-parity check**: a worktree is removable without `--force`
   iff its CURRENT state matches what the captured evidence holds —
   mechanically: re-run the capture form in the worktree (`git add -A
   --intent-to-add .` then the T-044 diff target), byte-compare against the
   run's stored final-attempt `diff.patch`; equal (or both empty) ⇒
   captured ⇒ removable; different, or the stored patch missing/unreadable
   ⇒ refuse with today's message upgraded to name the reason
   ("worktree differs from its captured evidence — post-capture changes;
   re-run with --force to discard").
2. Shared internals: `disposeTargets` drives clean and gc alike (T-020), so
   both commands get the new predicate; the refusal/bypass (`--force`)
   vocabulary is unchanged.
3. Line-ending hazard named up front: byte-comparison can false-refuse on
   autocrlf re-normalization between capture and clean. The check must be
   line-ending-stable on the demo fixture and the fast-tier fixtures
   (Known issue #5's CRLF class); if a tolerant comparison is needed, the
   tolerance is documented in VERIFICATION.md, never silent.

Non-goals: changing `--force` semantics; disposing evidence (never —
unchanged); the ITA-staging side effect itself (diff capture's index
mutation is T-044/capture territory; this ticket only reads).

## Why

A safety refusal that fires on 100% of normal operation is not a safety
refusal — it is a `--force` dispenser. This restores the protection's
meaning (refuse exactly when the evidence does not cover the tree) with a
mechanical, honest comparison, and it is the kind of check the existing
vocabulary already supports (`diff.patch` is durable evidence by design).
Lands after T-044 so the comparison uses the same capture semantics the
evidence was produced with.

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free scratch-repo
      check (the 2026-10-23 repro, re-run): a worktree whose changes were
      fully captured by `diff()` is REFUSED by today's porcelain predicate
      — asserted on main as the red bar.
- [ ] Green, captured: the same worktree post-change is removed by plain
      `clean --run` (no `--force`), with its branch — pinned by the same
      check.
- [ ] Green, protection intact (never weakened — AGENTS #8): the same
      setup plus a post-capture edit (append a line after `diff()` ran)
      is still REFUSED without `--force`, and `--force` still discards —
      pinned by the same check, both legs.
- [ ] Missing-evidence refusal: a worktree whose run dir lacks the stored
      `diff.patch` is refused (evidence-first posture) — pinned by the
      same check.
- [ ] Line-ending stability: the predicate is stable on the CRLF-shaped
      fixture (Known issue #5 class) — no false refusal on a captured-
      then-cleaned cycle — pinned by the same check running the cycle
      with autocrlf active.
- [ ] gc lane: the same predicate rides `npm run gc` (shared
      `disposeTargets`) — pinned by the existing gc check extended with
      both legs.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) — pinned
      by the full fast tier ALL GREEN.
- [ ] **Gate 2 not owed** (no `src/runner`/adapter/report shape — disposal
      only; trigger analysis recorded at landing, the T-041 precedent).
      **Gate 3 n/a.**

## Landed

## Verification

New fast-tier check (next free gate number at landing): captured-removal
red bar, green removal, post-capture refusal, missing-evidence refusal,
CRLF stability, gc lane. Gate 0, full fast tier ALL GREEN; Gate 2 trigger
analysis recorded.

## References

src/disposal.ts:62-119 (`disposeTargets` — the predicate site) ·
src/workspace/worktree.ts:76-85 (the capture whose ITA staging guarantees
the false-positive) · src/clean.ts:79-134 (the command), src/gc.ts (the
shared lane) · VERIFICATION.md Known issue #5 (the CRLF class the
comparison must survive) · docs/tickets/T-002 (the dirty-refusal's origin
intent), T-020 (shared disposal), T-044 (capture semantics dependency) ·
2026-10-23 adversarial review finding F3 (recorded scratch-repo repro).
