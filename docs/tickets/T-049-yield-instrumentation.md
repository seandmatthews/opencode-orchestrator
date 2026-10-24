# T-049 — Yield instrumentation: a machine-derived per-run yield block — the A2 measuring stick

**Status:** proposed
**Category:** verification
**Value (1-5):** 4 · **Risk (1-5):** 1
**Depends on:** —

## What

The 2026-10-23 review's A2 assessment ("worker derailment is the binding
constraint; the engine adapts nothing per-run") was confirmed empirically the
next day: two of six Gate 2 legs died to worker derailment — two NEW
mechanisms under Known issue #6 in one day (round-2 brief-premise mismatch,
T-043's lane; lease-path mis-transcription, T-047's lane) — and zero to
engine defects. Every decision that matters next (which worker model, which
prompt posture, whether `--rounds 2` earns its tokens) is currently made from
anecdote. This ticket adds the instrument, not any adaptation.

1. **The yield block** — a mechanically derived, additive `RunReport.yield`
   block (the producer-only optional-field pattern; absent blocks never
   appear): candidates, attempts dispatched, workerOk attempts, non-zero-diff
   attempts, gate-failed final attempts, no-op eliminations, survivors —
   each a count derived from data the report already holds (the ladder
   vocabulary, the store's elimination reasons). Per-round sub-totals when
   `rounds` ran.
2. **Derailment markers, evidence-only** — per attempt, when `workerOk` &&
   `diffBytes === 0` (the machine-known no-op class), the block records the
   attempt id; and when that attempt's `worker.log` contains the harness's
   external_directory auto-reject line (the exact string as recorded in the
   cited run evidence — the implementer reads it from
   `C:\swarm\20261024021432\wt\...` worker.logs and records the literal in
   VERIFICATION.md, never a paraphrase), a `derailmentMarkers` note citing
   the marker. Deterministic string match on recorded bytes — labeled
   heuristic evidence, never a verdict input, never a classification the
   ladder reads.
3. **Store + dashboard carved** — the report is the durable copy this slice;
   store columns, dashboard tiles, and any cross-run aggregation are later
   slices (the T-034 producer-only precedent). No decisions, no thresholds,
   no early-stop wiring (A2 explicitly does NOT feed verdicts).

## Why

You cannot manage what the honest report tells you only anecdotally. The
review's A2 recommendation is "instrument yield-per-run before scaling
anything" — this is that instrument, at its cheapest: pure derivation over
recorded evidence, zero new failure surface, and the number that the next
model/prompt/rounds decision will need either way.

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free: the new check
      drives a synthetic multi-candidate report through the derivation and
      asserts the yield block's fields — on main the block does not exist
      (the check fails as the red bar).
- [ ] Green, arithmetic pinned: a synthetic report containing one survivor,
      one gate-failed candidate, one worker-failed candidate, one no-op
      (workerOk, zero diff), and one retried-then-survived candidate yields
      exactly the expected counts in every field — pinned by the same check.
- [ ] Round-aware: a `rounds: 2` shape reports per-round sub-totals —
      pinned by the same check.
- [ ] Marker note: an attempt whose worker.log carries the recorded
      auto-reject marker AND a zero diff gets the note citing the marker
      string; absence of either → no note, and the report shape is
      byte-identical to today's for clean runs — pinned by the same check.
- [ ] Verdict inertness: candidates' `passedAllGates`/elimination fields are
      byte-identical with and without the block — pinned by the same check.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6), recording
      the metric definitions and the literal marker string — pinned by the
      full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (report shape + `src/` change; trigger analysis
      recorded at landing). **Gate 3 n/a.**

## Landed

## Verification

New fast-tier check (next free gate number at landing): derivation
arithmetic, round sub-totals, marker note presence/absence, verdict
inertness. Gate 0, full fast tier ALL GREEN; Gate 2 owed and recorded.

## References

docs/adversarial-review-2026-10-23.md §4 A2 (the disposition this
implements) · VERIFICATION.md Known issue #6 (the two 2026-10-23/24
observations whose rate this measures) · docs/tickets/T-043, T-047 (the
lanes whose Gate 2 reds are the motivating data points; runs 20261023204747
and 20261024021432) · src/runner.ts (the ladder fields the block derives
from), src/types.ts (`RunReport` — the additive-block precedent).
