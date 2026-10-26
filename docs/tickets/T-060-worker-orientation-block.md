# T-060 — Worker orientation block: engine-composed lease path + base tree facts in the worker dispatch (KI#6 prompt-side; register A2)

**Status:** proposed
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
