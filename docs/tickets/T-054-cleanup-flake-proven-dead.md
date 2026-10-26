# T-054 — Known issue #10's owed code change: a provably-dead tree stops being reported as a cleanup failure (the captured fifth observation's fix)

**Status:** proposed
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 3
**Depends on:** —

## What

VERIFICATION.md Known issue #10 ("a verified-dead tree can still be REPORTED
as a cleanup failure on a transient snapshot/kill hiccup") records five
observations across T-011..T-052's lanes; its own threshold clause — "code
change MET on next recurrence, pending captured diagnosis" — is now due:
T-052's lane captured the previously-missing line AND the diagnosed leg
(commit `d5d1f8e`, the issue's fifth observation). This ticket lands the fix
that clause promises.

**The implementer MUST drive the mechanism from the recorded diagnosis**
(VERIFICATION.md Known issue #10, fifth observation + the T-052 lane's
captured line) — not from this ticket's paraphrase. The candidate surface in
`src/kill-tree.ts` (read 2026-10-25): `killTreeVerified` reports
`verified: false` on three legs — root already gone at the alive check
(:59-61), snapshot failure proceeding unverified (:73-80), and post-kill
survivors (:82-88) — and `killFailureLines` (:143-153) turns the first two
into loud `CLEANUP FAIL:` lines even when the OUTCOME is provably good (a
root that died in the expiry-to-kill race has no tree left for THIS kill to
leak; a snapshot failure followed by a clean post-kill re-verification
proves the kill worked). The invariants that must NOT move: genuine
survivors keep their per-pid lines; a truly unverifiable outcome stays loud
(fail-closed — the T-011 posture); `snapshotTree`'s throw-and-proceed
(:73-80 comment) never skips a kill; Known issue #8's dead-roots caveat is
untouched (a dead root never RELIES on taskkill reaping reparented
descendants — the fix may only stop REPORTING what post-hoc liveness
proves dead).

Shape (mechanism owned by the diagnosis): add the missing verification leg —
e.g. on `rootWasLive: false` and on snapshot-failure, one post-kill
liveness re-check that can UPGRADE the outcome to verified-when-proven-dead
(keeping the loud line only when something is actually alive or genuinely
unverifiable) — plus whatever narrower form the recorded leg demands.
Known issue #10's entry updated in the same change-set (the fifth
observation's disposition becomes "fixed by Gate <N>", the class retired or
narrowed to what remains loud).

## Why

Five observations is the issue's own threshold; the diagnosis is captured;
the flake class costs every timed-out leg a spurious `cleanupFailures`
entry that humans (and T-049's yield markers) must then hand-triage. The
honesty property is preserved exactly: the fix makes the report MORE
accurate (proven-dead is not a failure), never less loud.

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free: the diagnosed leg
      (driven via `killTreeVerified`/`killFailureLines` with the recorded
      shape — stubbed snapshot/liveness where needed, injected per the
      T-052 identity-probe precedent) produces a `CLEANUP FAIL:` line on
      main for an outcome the post-hoc check proves good — asserted as the
      red bar.
- [ ] Green: the same leg post-change reports the verified-dead outcome
      with NO failure line (the success line or a silent-good result per
      the diagnosis) — pinned by the same check.
- [ ] Never-weakened pins: genuine survivors still emit per-pid lines; a
      genuinely-unverifiable outcome (re-check also impossible) still emits
      its loud line — pinned by the same check, both legs.
- [ ] Existing kill checks ride green unchanged (Gate 1.12's suite; any
      pin that asserted the OLD spurious line for the diagnosed shape is
      updated with the reasoning recorded — strengthened-or-equal, the
      T-044 precedent).
- [ ] Known issue #10's VERIFICATION.md entry updated in the same
      change-set (AGENTS #6): the fix, the gate number, the disposition of
      the five observations — pinned by the full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (`src/` kill/timeout core touched — the trigger
      list); trigger analysis recorded at landing. **Gate 3 n/a.**

## Landed

## Verification

New fast-tier check (next free gate number at landing): the diagnosed-leg
red bar, the proven-dead green, both never-weakened legs. Gate 0, Gate
1.12's suite green, full fast tier ALL GREEN; Gate 2 owed and recorded.

## References

VERIFICATION.md Known issue #10 (the threshold clause + the fifth
observation — the driving diagnosis), #8/#9 (the caveats this must not
disturb) · src/kill-tree.ts:58-89, :143-153 (the reporting surface) ·
src/worker/run-with-timeout.ts + src/probe.ts (the consumers of
`cleanupFailures`), src/recover.ts (the identity-probe injection
precedent, T-052) · docs/tickets/T-011 (the loud-by-design posture this
refines), T-052 (the lane that captured the diagnosis) · commit `d5d1f8e`.
