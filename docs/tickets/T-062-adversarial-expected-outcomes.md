# T-062 — Adversarial-probe expected outcomes: correct input validation stops recording as a crash (register R16)

**Status:** proposed
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
