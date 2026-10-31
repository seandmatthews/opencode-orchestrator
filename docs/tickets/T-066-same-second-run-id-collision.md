# T-066 — Same-second runs on one run root share one artifacts dir (second-resolution run ids)

**Status:** filed 2026-10-31 (observed during T-065's WSL lane; the engine fix is deliberately NOT in that change-set — findings promote via tickets, never same-run)
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** —

## What

`src/cli.ts:716` derives the run id from a second-resolution wall clock:
`new Date().toISOString().replace(/\D/g, '').slice(0, 14)` — and the
artifacts dir is `join(opts.runRoot, runId)` with no existence check. Two
runs that start in the SAME WALL-CLOCK SECOND on the same `--run-root` get
the SAME id and share ONE artifacts dir: the second run dispatches into the
first run's directory (its evidence, its planner provenance) and its
report.json overwrites the first's; the durable store keys runs by run_id,
so the second ingest rides the first's row.

## Observed first-hand (T-065 lane, 2026-10-31, Ubuntu 22.04 WSL2)

Gate 1.22's C(n=1) leg (the real-CLI `--rounds 1` run) failed
intermittently (~50%) on a fast machine and never on a slower one. A probe
inside the check's fake planner captured the mechanism: the one-round run
and the preceding 2-round loop run started in the same wall-clock second
(`run 20261031160142; loop run 20261031160142`), so the one-round run's
planner dispatched from `<loopRunDir>/planner-scratch`, saw the loop run's
round-2 provenance marker one level up (`planner-r2.log`), emitted the
round-2 briefs (including the deliberate `change nothing` brief), and the
run gained a NO-OP candidate — whose T-049 yield block then tripped the
key-set pin. Full diagnostic trail in the T-065 ticket and the check's
on-mismatch diagnostic line (check-rounds.mjs, the C (n=1) leg).

The check-side exposure is FIXED in the T-065 change-set (the one-round run
now uses its own run root — the isolation the fixture already intended for
its branch namespaces). The ENGINE hazard remains: any operator running two
runs against one run root within the same second hits it.

## Fix directions (next lane's decision, not this one's)

1. **Refuse on collision (smallest honest fix):** create the artifacts dir
   mkdir-exclusive (`wx`); an existing dir at `<runRoot>/<runId>` refuses
   the run with a loud "same-second run on this run root" message and exit 1.
   No format change; every 14-digit pin survives.
2. **Uniqueness suffix / higher resolution:** changes the 14-digit id shape
   pinned by many gates (long-path plan, dispatch parsing, recovery,
   artifact ids) — a much wider change-set.
3. **Per-run-root serialization** through the checkout lock — does NOT fix
   it (the lock serializes per TARGET REPO; two runs on DIFFERENT repos
   sharing a run root still collide).

## Acceptance (for the fixing change-set)

- AC1 — two runs started in the same wall-clock second on one run root:
  the second refuses loudly (direction 1) or receives a distinct id
  (direction 2); no artifacts intermix, no report overwrite.
- AC2 — every existing 14-digit-id pin (Gate 1.19's plan, recovery,
  integrate, artifact ids) still green unchanged (direction 1) or updated
  deliberately (direction 2).
