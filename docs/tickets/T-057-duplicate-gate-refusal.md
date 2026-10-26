# T-057 — Duplicate gate names refused at parse time: the store's last-write-wins can no longer drop gate evidence (register R7a)

**Status:** proposed
**Category:** engine
**Value (1-5):** 2 · **Risk (1-5):** 1
**Depends on:** —

## What

`gate_results` is keyed `(run_id, candidate_id, gate_name)` with an upsert
(`src/store/index.ts:122-131`, :1357-1370), and NOTHING refuses duplicate
gate names: `parseJobsSpec` enforces unique probe ids but never gate names
(`src/scheduler.ts:236-245` — no `seen` set, unlike probes at :249-257),
and the run-level `--gate` flag accepts repeats unchecked
(`src/cli.ts:291-296`). A spec or CLI invocation with two gates named
`build` records both in report.json but the store keeps only the LAST —
if the first failed and the second passed, the durable record shows an
all-pass gate table for an eliminated candidate: evidence loss via
last-write-wins, invisible to the dashboard and to every later reader.
The ladder itself is unaffected (it reads the in-memory array), which is
exactly why the divergence between report and store went unnoticed.

The change — refusal at both parse sites, the zero-side-effects pattern
(refusal before the checkout lock, repo validation, or any artifacts dir):

1. `parseJobsSpec`: per-job gate names must be unique — a `seen` set, the
   probe-id precedent verbatim, refusing with the message naming the job
   and the duplicated name.
2. `parseArgs`: repeated `--gate` names refuse at parse time, naming the
   duplicate. (Integrate's `gateContract` already matches gates by name —
   duplicates were already unrepresentable there; refusal upstream is the
   honest fix.)

Intentional-shape check the implementer must record: no existing fixture,
spec, or check in the repo uses duplicate gate names (assert during the
red-bar leg — if one does, this ticket's premise is wrong and the lane
stops for review rather than "fixing" the fixture).

## Why

The cheapest class of silent evidence loss in the store, closed by the
same parser-refusal pattern the repo already uses for probe ids, worker
ids, and flag pairing. R7's disposition listed this sub-item as the
parser-refusal piece of the store-gaps ticket-later; it is small enough to
land on its own.

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free: a `--jobs` spec
      with two gates named `build` on one job PARSES on main (asserted as
      the red bar); repeated `--gate "a=…" --gate "a=…"` parses on main
      too. Ingest divergence shown once for the record: the same-named
      pair upserts to one `gate_results` row (the loss, demonstrated).
- [ ] Green, spec: the same spec post-change refuses at parse time with
      the job name + duplicated gate name, zero side effects (no artifacts
      dir, no lock) — pinned by the new fast-tier check.
- [ ] Green, CLI: repeated `--gate` names refuse at parse time — pinned
      by the same check.
- [ ] Distinct names unaffected: every existing spec/check fixture
      (unique-named gates) parses byte-identically — pinned by the full
      fast tier riding green unchanged.
- [ ] The intentional-shape check's result (no fixture used duplicates)
      recorded in the ticket's Landed.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) — pinned
      by the full fast tier ALL GREEN.
- [ ] **Gate 2 not owed** (parser refusals + docs only — no runner,
      adapter, or report-shape change; trigger analysis recorded per the
      T-041 precedent). **Gate 3 n/a.**

## Landed

## Verification

New fast-tier check (next free gate number at landing): both red bars, the
ingest-divergence demonstration, both refusals green, zero-side-effects
assertion. Gate 0, full fast tier ALL GREEN; Gate 2 trigger analysis
recorded.

## References

src/store/index.ts:122-131, :1357-1370 (the key + upsert — the loss site) ·
src/scheduler.ts:236-257 (gates without the seen set; probes with it — the
precedent) · src/cli.ts:291-296 (the run-level repeat), :314-316 (the
parse-refusal pattern) · src/integrate.ts:147-169 (name-keyed contract —
duplicates already unrepresentable) · docs/adversarial-review-2026-10-23.md
R7 (the parent disposition; this ticket closes sub-item (a)).
