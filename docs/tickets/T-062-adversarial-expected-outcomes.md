# T-062 — Adversarial-probe expected outcomes: correct input validation stops recording as a crash (register R16)

**Status:** done (2026-10-27)
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** —

## What

The adversarial probe's survival rule is exit 0
(src/probe.ts:1799-1805: `exitCode !== 0 → 'crashed-exit'`), so a
well-behaved CLI that validates its argv and exits 1 on the malformed
corpus cases (`'{"a":'`, control characters, …) is recorded
`crashed-exit` / `success: false` — while a no-op handler that never
reads argv survives all 20. The evidence semantics are inverted against
the candidates that validate; `src/rounds.ts` then renders those cases
as "failed" into the round-2 planner prompt, systematically bad-mouthing
exactly the better candidates. Never a verdict; corrupts planning
evidence.

The change — per-case expectations attached to the ENGINE-AUTHORED
corpus (T-032's fixed edge-case list; the seeded soup keeps exit-0 as
its expectation):

1. The corpus cases whose INPUT IS INVALID BY CONSTRUCTION (the
   malformed-JSON-looking strings, control-character cases, the
   empty-input edge where rejection is the defensible behavior — the
   exact split is fixed at implementation and recorded in the check)
   expect rejection: a clean non-zero exit within the budget records
   `rejected-as-expected` and counts toward survival. The honest
   boundary, stated in the ticket because it is a real limit: non-zero
   exit is non-zero exit — an unhandled throw on the same input records
   identically. The expectation is authored per-case by the engine, not
   inferred from the target's behavior; nothing is reclassified after
   watching the target run.
2. A timeout or spawn failure remains exactly what it was — never
   survival (the T-032 refusal vocabulary unchanged).
3. Probe success = every case spawned AND every case met its
   expectation (`passed: outcome === 'survived' ||
   outcome === 'rejected-as-expected'` at the case-gate mapping,
   src/probe.ts:1806).
4. The recorded tables (results.json, the case records) gain the
   expectation and the outcome class; `casesSurvived` /
   `casesCrashed` keep their meanings, with the new class counted
   honestly beside them (no silent merge into survived).
5. `src/rounds.ts` renders `rejected-as-expected` as validated input
   handling, not "failed".
6. Seed determinism untouched: same seed → byte-identical case list AND
   byte-identical expectation list (expectations are a function of the
   engine-authored corpus, not of the seed's random tail).

Non-goals: operator-authored per-case expectations in the jobs spec
(a spec surface change — carved to a successor if a real corpus needs
it); distinguishing clean validation exits from crash exits
mechanically (not possible at the process boundary; the ticket is
honest about it above); touching the other probe types.

## Why

R16. The adversarial probe is the honest partial answer to A1
(gate-content) for robustness goals — but as it stands it punishes
input validation, which is precisely the behavior a robustness goal
wants. Every future robustness-seeking run that feeds this probe's
results to round 2 inherits the inversion.

## Acceptance criteria

- [ ] Red bar recorded first (AGENTS #8), token-free: on main, a
      fixture target that validates argv and exits 1 on malformed input
      records `crashed-exit` / `success: false` for those cases —
      asserted as the red.
- [ ] Post-change, the same fixture's malformed-corpus cases record
      `rejected-as-expected`, count toward survival, and the probe
      succeeds when every case met its expectation — pinned by a new
      fast-tier check (next free gate number at landing).
- [ ] No loosening where exit 0 is the expectation: a seeded-soup case
      exiting non-zero STILL records crashed and sinks probe success —
      same check.
- [ ] Timeouts and spawn refusals still never count as survival — same
      check (the T-032 refusal pins stay green, strengthened-or-equal).
- [ ] Determinism: same seed → byte-identical case list and expectation
      list across two runs — same check (the Gate 1.15 seam).
- [ ] Composer honesty: the round-2 rendered evidence no longer marks
      rejected-as-expected cases as failed — same check.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) —
      pinned by the full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (probe record shape changes → report shape
      changes; the standing trigger fires): every existing Gate 2
      assertion green. **Gate 3 n/a.**

## Landed

2026-10-27, lane `ticket/T-062-adversarial-expected-outcomes`.

- **The expectation seam** (`src/probe.ts`): the corpus became
  `{input, expectation}` records; `generateAdversarialCases` output stays
  byte-identical (strings, order, count unchanged). New exported pure
  `adversarialCaseExpectations(cases)` derives the per-case
  `'exit-0' | 'reject'` list — the implementation-fixed reject split is
  corpus indices 0 (empty string), 1 (control characters), 9-11 (the three
  malformed-JSON-looking strings); every other corpus entry and every
  generated case (soup AND permutations) expects exit-0. Expectations are
  seed-independent (different seeds derive the identical list) and total
  (non-corpus lists derive uniformly exit-0).
- **The outcome classes** (`AdversarialProbe.run`): outcome union extended
  to `survived | rejected-as-expected | unexpected-exit-0 | crashed-exit |
  crashed-timeout | spawn-refused`. A clean non-zero exit on a
  reject-expected case records `rejected-as-expected` (PASSED row, counts
  toward survival); an exit 0 on a reject-expected case records
  `unexpected-exit-0` (the no-op handler — unmet expectation, failed row,
  first-error vocabulary `case N/M exited 0 where rejection was expected
  (input invalid by construction)`); timeouts and spawn refusals keep
  exactly their T-032 meanings on either expectation (a reject-expected
  timeout records crashed-timeout, never rejection). Probe success = every
  case spawned AND every case met its expectation, exactly the ticket's
  `passed: outcome === 'survived' || outcome === 'rejected-as-expected'`
  at the case-gate mapping.
- **The recorded tables**: `results.json` rows gain `expectation` beside
  `outcome`; the table and the bundle measurements gain `casesRejected` /
  `casesUnexpectedExit0` / `cases-rejected` / `cases-unexpected-exit-0`
  beside the unchanged-meaning casesRun / casesCrashed (no silent merge —
  the ticket's naming note resolved against the landed vocabulary: the
  pre-change counters were `casesRun`/`casesCrashed`; both keep their
  meanings with the new class counted beside them).
- **The composer seam**: `ProbeRunSummary` gains optional `casesRejected`
  (present only when the bundle carried non-zero rejections — the
  optional-field pattern), the runner fills it from the bundle's own
  `cases-rejected` measurement, and `src/rounds.ts` renders `N input
  case(s) rejected as expected — validated input handling, not a failure`
  in the probe line — never "failed" for rejections, and the annotation
  never launders a genuinely failed probe.
- **Gates**: new **Gate 1.48**
  (`scripts/check-adversarial-outcomes.mjs`, wired into
  `scripts/verify.mjs` fast tier, 15 assertions: determinism with
  expectations, the exact authored split, the validating-fixture green
  pair, soup-case strictness, the no-op inversion face, reject-expected
  timeout + spawn refusal never-survival, composer honesty + back-compat).
  Gate 1.15's adversarial faces rewired onto the expectation-aware
  derivation — the two intentional flips recorded in VERIFICATION.md (the
  no-crash face became the no-op face: success true → false with five
  unexpected-exit-0 rows; the crash-face/P5 first-error and counts are now
  expectation-derived) — 124 assertions green. Red bar recorded first,
  token-free, on the pristine lane (= main): the validating fixture's five
  malformed cases recorded `crashed-exit` / `success: false` (`error:
  case 1/20 exited with code 1`), verbatim at
  `C:\swarm\verify-red\T-062-red.log`. Fast tier ALL GREEN; **Gate 2 owed**
  (report-shape trigger: the optional `casesRejected` summary field) — NOT
  run in this lane; the full-tier re-run rides the landing pipeline and its
  result is recorded there.

## Verification

New fast-tier check: the validating-fixture red/green pair, soup-case
strictness, timeout/spawn-refusal pins, seed determinism with
expectations, composer rendering. Gate 0, full fast tier ALL GREEN;
Gate 2 owed and recorded at landing.

## References

src/probe.ts:1790-1810 (the outcome ternary and the case-gate `passed`
mapping), :1601 (the outcome union), src/rounds.ts (the "failed"
rendering the register cites) ·
docs/adversarial-review-2026-10-23.md R16 (the disposition this
promotes) · docs/tickets/T-032 (the probe's determinism contract this
must preserve), T-030 (the composer that consumes the evidence).
