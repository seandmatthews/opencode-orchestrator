# T-064 — The no-gates warning tells the truth: elimination, not vacuous passing (register R8; the fold that never landed)

**Status:** done 2026-10-27
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

- [x] Red bar recorded first (AGENTS #8), token-free: on main, the
      no-gates console line contains "passes vacuously" — asserted as
      the red.
- [x] Post-change the line names elimination and the remedy — pinned
      by a small fast-tier check added with the change (the Gate 1.28
      prompt-transport pattern: a focused cli-pinning check, next free
      gate number at landing).
- [x] No behavior change: for the same inputs a no-gates run's
      report.json shape, candidate verdicts (all `passedAllGates:
      false`), and exit code are byte/semantically identical to main's
      — same check.
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6) —
      pinned by the full fast tier ALL GREEN.
- [x] **Gate 2 not owed** (a console string; no pipeline touch —
      record the trigger analysis at landing). **Gate 3 n/a.**

## Landed

2026-10-27, lane `ticket/T-064-no-gates-warning-honesty` off main
a9f22d4. The diff is one `console.warn` block in `src/cli.ts` (line +
trigger), the new check, verify.mjs wiring, and docs — runner, adapters,
gates, workspace, store byte-unchanged.

**Red bar, recorded first, token-free, on the pristine lane (= main
a9f22d4)**, by running the new check against unchanged sources (the
Gate 1.28 pattern; output verbatim in VERIFICATION.md's Gate 1.50
section): 5 failures — the four W1 truth legs (the line read
`warning: no --gate given; every candidate passes vacuously` while the
same run's summary line read `j1 worker:ok 0s diff:0.1KiB no gates =>
FAIL` — passing claimed, elimination done) and the W3 trigger leg (the
same warning fired on a jobs-with-gates run whose candidate genuinely
passed, `build PASS => PASS` — the lie in the second direction). All
seven W2 behavior legs were GREEN on that same pre-change run: the
no-behavior-change baseline, recorded mechanically.

**The change — the line and its trigger, nothing else**: the warning now
reads `warning: no --gate given (and no --jobs job carries gates) — the
ladder eliminates every candidate on the zero-gate leg (passing requires
at least one gate); pass --gate "name=command" to give candidates a
survival bar, or drive --jobs probes for an evidence-only run`, and it
fires on the run's EFFECTIVE gate set (`distinctGatesFor(opts,
jobsSpec)` — the same deduplicated union the T-043 baseline check uses)
instead of the run-level `--gate` list alone. One deliberate trigger
consequence, recorded here: a `--jobs` run whose jobs carry their own
gates no longer sees the warning — pre-T-064 it fired there with the
"passes vacuously" lie, and under the new text it would fire with the
"eliminates every candidate" lie; a run with a survival bar must not be
told it has none (the ticket's title is the contract: the warning tells
the truth). Everything the ACs name as behavior-free is pinned
untouched by the same check: the no-gates run still proceeds (exit 0),
report.json keeps the completed-run 9-key shape, and every candidate is
eliminated by the zero-gate ladder leg specifically (`gates []`,
`workerOk` true, `diffBytes > 0`, `passedAllGates` false).

**Gate numbers measured**: Gate 0 typecheck exit 0; new Gate 1.50
(`scripts/check-no-gates-warning.mjs`, wired into `scripts/verify.mjs`)
ALL GREEN, 18 assertions — the W1 warning-truth legs (one line, no
"passes vacuously", elimination + zero-gate leg + `--gate` remedy +
`--jobs` evidence pointer), the W2 no-behavior-change legs (exit 0,
report shape, single candidate eliminated by the zero-gate leg), and the
W3 truth-scoping legs (jobs-with-gates run unwarned, candidate genuinely
passes). Full fast tier `node scripts/verify.mjs fast`: **ALL GREEN**.

**Gate 2 not owed — trigger analysis**: a console string. No report
shape change, no runner/adapter/gate/workspace byte touched, pipeline
decisions byte-identical (the ladder line in src/runner.ts is
untouched; W2 pins the no-gates run's shape, verdicts, and exit code
leg by leg). Gate 3 n/a.

## Verification

New small fast-tier check: the red/green warning pair + the
no-behavior-change pin. Gate 0, full fast tier ALL GREEN.

## References

src/cli.ts:674 (the lying line), src/runner.ts:1323 (the ladder that
fails everyone) · docs/adversarial-review-2026-10-23.md R8 (the
disposition this promotes; its T-043 fold vehicle named and missed) ·
docs/tickets/T-043 (the intended vehicle that landed without it).
