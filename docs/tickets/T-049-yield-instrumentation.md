# T-049 — Yield instrumentation: a machine-derived per-run yield block — the A2 measuring stick

**Status:** done 2026-10-24
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

- [x] **Red bar recorded first** (AGENTS #8), token-free: the new check
      drives a synthetic multi-candidate report through the derivation and
      asserts the yield block's fields — on main the block does not exist
      (the check fails as the red bar).
- [x] Green, arithmetic pinned: a synthetic report containing one survivor,
      one gate-failed candidate, one worker-failed candidate, one no-op
      (workerOk, zero diff), and one retried-then-survived candidate yields
      exactly the expected counts in every field — pinned by the same check.
- [x] Round-aware: a `rounds: 2` shape reports per-round sub-totals —
      pinned by the same check.
- [x] Marker note: an attempt whose worker.log carries the recorded
      auto-reject marker AND a zero diff gets the note citing the marker
      string; absence of either → no note, and the report shape is
      byte-identical to today's for clean runs — pinned by the same check.
- [x] Verdict inertness: candidates' `passedAllGates`/elimination fields are
      byte-identical with and without the block — pinned by the same check.
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6), recording
      the metric definitions and the literal marker string — pinned by the
      full fast tier ALL GREEN.
- [x] **Gate 2 owed** (report shape + `src/` change; trigger analysis
      recorded at landing). **Gate 3 n/a.**

## Landed

2026-10-24, Gate 1.36 (`scripts/check-yield.mjs`, wired into
`scripts/verify.mjs` fast tier).

- `RunYield`/`RunYieldRound`/`DerailmentMarkerNote` (`src/types.ts`) and
  the additive, producer-only `RunReport.yield` block. Produced by the
  runner (`src/runner.ts`) after every other report block attaches, via
  `deriveRunYield` (`src/yield.ts`, the premise/rounds pure-module
  pattern): counts only from data the report already holds (the ladder
  vocabulary, the store's elimination classes — the exact metric
  definitions recorded in VERIFICATION.md's Gate 1.36), plus the one
  recorded-bytes read beyond the report: the no-op attempts' worker.log
  marker scan. Producer-only: no machine-known no-op elimination → no
  block, report shape byte-identical to pre-T-049; a derivation failure
  logs and records nothing (the probes/verifier posture — an instrument
  never breaks the run it measures).
- The marker literal: `permission requested: external_directory` — the
  stable path-independent frame of the harness's auto-reject line,
  recorded verbatim (full path-carrying line included) in
  VERIFICATION.md's Gate 1.36. Provenance honesty: the ticket pointed
  the implementer at `C:\swarm\20261024021432\wt\...` worker.logs, but
  that run's artifacts were wiped from disk by a later Gate 2 run's
  root reset (`verify.mjs` clears the verify root per full-tier run) —
  the literal is cited from VERIFICATION.md's own Known issue #6
  2026-10-24 entry (recorded at T-047's landing from that run's
  worker.log) and byte-cross-checked against the same harness frame on
  disk in run 20261010235146's c02/c03 worker.logs. Never a paraphrase.
- One existing pin extended in the same change-set, not weakened (the
  T-030 precedent of adding `rounds` to the then-existing key pin):
  Gate 1.22 leg B's exact top-level key set gains `yield` — that
  fixture intentionally carries a no-op round-2 candidate ("change
  nothing"), exactly this block's producer. VERIFICATION.md's Gate 1.22
  prose updated to match.
- Store columns, dashboard tiles, cross-run aggregation: carved, none
  built (the ticket's non-goal). No CLI summary change, no
  decisions.md change, no store schema change. No ride-alongs.

Gates measured: red bar — the landed check against main's engine at the
lane (engine at 9545d67): 11 failures of the 20 assert faces reachable
on main (9 green — the preserved semantics), exit 1
(`C:\swarm\verify-red\T-049-redbar.log`; the remaining 15 faces are
nested behind the derivation's existence and are unreachable on main by
construction). Post-change:
`node node_modules/tsx/dist/cli.mjs scripts/check-yield.mjs` ALL GREEN
(35 assertions); Gate 0 (`npm run typecheck`) exit 0; full fast tier
(`node scripts/verify.mjs fast`) ALL GREEN. **Gate 2 owed and run by
the driving script after the lane lands** — trigger analysis: the
change-set touches report shape (a new optional `RunReport.yield`
block) and `src/runner.ts` (the producer), the standing Gate 2 trigger.
The real-run surfaces it exercises: a no-op-free Gate 2 run must carry
NO yield block (byte-identical report shape), and a Known-issue-#6
no-op run must carry the block with its counts and — when the no-op's
worker.log holds the auto-reject line — its marker note. Whether a real
run produces a no-op at all is model-behavior variance, recorded
honestly either way (the T-047/T-050 lane precedent). **Gate 3 n/a**
(no adapter change).

## Verification

Gate 1.36 (`scripts/check-yield.mjs`, fast tier): derivation arithmetic
(the five-candidate fixture, every field exact), round sub-totals
(including the not-executed-round zeros face), marker note
presence/absence (clean log, non-no-op marker, missing log, no log
artifact), clean-negative (real `runSkeleton` drive: no block, exactly
the pre-T-049 key set), verdict inertness, and the real producer end to
end (no-op drive: block on the in-memory report AND on-disk
report.json). Gate 0, full fast tier ALL GREEN; Gate 2 owed — run by
the driving script, trigger analysis in Landed; Gate 3 n/a.

## References

docs/adversarial-review-2026-10-23.md §4 A2 (the disposition this
implements) · VERIFICATION.md Known issue #6 (the two 2026-10-23/24
observations whose rate this measures) · docs/tickets/T-043, T-047 (the
lanes whose Gate 2 reds are the motivating data points; runs 20261023204747
and 20261024021432) · src/runner.ts (the ladder fields the block derives
from), src/types.ts (`RunReport` — the additive-block precedent).
