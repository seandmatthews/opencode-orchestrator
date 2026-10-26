# T-064 — The no-gates warning tells the truth: elimination, not vacuous passing (register R8; the fold that never landed)

**Status:** proposed
**Category:** engine
**Value (1-5):** 2 · **Risk (1-5):** 1
**Depends on:** —

## What

`src/cli.ts:674` warns: `warning: no --gate given; every candidate
passes vacuously`. The ladder requires the opposite
(src/runner.ts:1323: `base.passedAllGates = base.gates.length > 0 &&
…`) — a run with no gates FAILS every candidate on the zero-gate leg.
The warning says passing; the engine does elimination. An operator who
reads the warning and proceeds loses every candidate to a rule they
were told did not exist.

The register folded this into "the next cli-touching ticket (T-043 is
the likely vehicle)" — T-043 landed without it, and the line still
reads "passes vacuously" (verified 2026-10-26, this batch's filing
pass). The fold is dead; the fix gets its own ticket.

The change, minimal and behavior-free:

1. The warning states the truth: with no gates, every candidate is
   eliminated (the zero-gate ladder leg), and names the remedy (pass
   `--gate`; cite `--jobs` probes if the run is evidence-only).
2. Nothing else changes: a no-gates run still proceeds (probe-only /
   evidence-gathering runs are legitimate), report shape, exit-code
   semantics, and the ladder are untouched.

Non-goals: refusing a no-gates run outright (a real behavior change
with legitimate-use casualties — carved unless a future run shows
one); touching the baseline-lease vacuous-path comments (cli.ts:598-602
— those already tell the truth).

## Why

Ground rule #9 in miniature: a lying console line is a check we present
as evidence about what the run will do. Cheapest ticket in the batch;
it exists because the fold vehicle never came and honesty lines should
not wait on luck.

## Acceptance criteria

- [ ] Red bar recorded first (AGENTS #8), token-free: on main, the
      no-gates console line contains "passes vacuously" — asserted as
      the red.
- [ ] Post-change the line names elimination and the remedy — pinned
      by a small fast-tier check added with the change (the Gate 1.28
      prompt-transport pattern: a focused cli-pinning check, next free
      gate number at landing).
- [ ] No behavior change: for the same inputs a no-gates run's
      report.json shape, candidate verdicts (all `passedAllGates:
      false`), and exit code are byte/semantically identical to main's
      — same check.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) —
      pinned by the full fast tier ALL GREEN.
- [ ] **Gate 2 not owed** (a console string; no pipeline touch —
      record the trigger analysis at landing). **Gate 3 n/a.**

## Landed

## Verification

New small fast-tier check: the red/green warning pair + the
no-behavior-change pin. Gate 0, full fast tier ALL GREEN.

## References

src/cli.ts:674 (the lying line), src/runner.ts:1323 (the ladder that
fails everyone) · docs/adversarial-review-2026-10-23.md R8 (the
disposition this promotes; its T-043 fold vehicle named and missed) ·
docs/tickets/T-043 (the intended vehicle that landed without it).
