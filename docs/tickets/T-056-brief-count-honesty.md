# T-056 — Brief-count honesty: no silent cyclic padding — an under- or over-count planner reply is a parse failure (register R9)

**Status:** proposed
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** —

## What

`parseBriefs` silently pads a SHORT planner array by cyclic repetition and
truncates a LONG one (`src/parse.ts:58-59` and the mirror tail in
`scanBriefObjects`, :88-89): a 1-brief reply for 4 candidates dispatches the
same sample four times at full token cost, laundered as four "distinct"
briefs — while the report shows `ok: true` with no trace. The review's R9:
"N candidates frequently buy ~1 independent sample." The honest behavior
the ladder already has elsewhere: a planner reply that is not exactly N
distinct briefs is a FAILED planner output — it flows through the existing
bounded repair attempt and, still short/long, the raw-goal fallback
(`fallbackUsed: true`, already recorded loudly).

The change — **a deliberate, documented behavior change** to the
pad/truncate tail (this ticket intentionally breaks parse.ts's
"every previously-parsing input parses byte-identically" inertness contract
FOR THE COUNT-MISMATCH CASE ONLY; the contract's purpose — never break
working inputs — is honored by the fact that exactly-N replies, the
overwhelming case, are untouched byte-for-byte):

1. `scanBriefs` and `scanBriefObjects` return their parsed array ONLY when
   `length === count`; any other count → null (both scans; the
   all-or-nothing rule gains an exact-count clause). The pad/truncate loops
   are deleted.
2. The consequence path is the existing one: null → one bounded repair
   attempt → still null → `fallbackUsed` raw-goal run, with the console
   line already saying so. A run that would have ridden 4 copies of 1 brief
   now rides 4 honest raw-goal copies AND records the planner failure —
   same tokens, honest provenance.
3. `PlannerReport` already records `ok`/`fallbackUsed`/`briefs` — no shape
   change needed; the raw-output path (`planner-raw.txt`) already preserves
   the bytes for diagnosis.

Non-goals: accepting k<Count briefs and dispatching k candidates (changes
the candidate contract — carved); asking the planner to top up (a model
call composes briefs — against the mechanical-composition posture);
touching `--jobs` briefs (operator-owned, never parsed by parseBriefs).

## Why

Silent fake distinctness corrupts the exact metric the system now runs on
(T-049's yield block counts survivors per attempt — four copies of one
brief masquerade as four attempts' worth of search). The fix makes the
failure visible in the report and the console at zero token cost, using
degradation paths that already exist and are already honest.

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free: `parseBriefs`
      with a 1-brief array and count 2 returns 2 identical briefs on main
      (the pad asserted as the red bar); a 3-brief array with count 2
      returns 2 (the truncate asserted too).
- [ ] Green: the same inputs return null post-change; an exactly-N array
      returns N briefs byte-identical to main's output (the preserved
      case pinned explicitly) — pinned by the same check.
- [ ] End-to-end honesty: a stubbed planner phase whose reply is short
      lands in the raw-goal fallback (`fallbackUsed: true`, console line)
      rather than padded dispatch — pinned by the same check via the
      repair-path seams (token-free stub adapter, the Gate 1.17
      precedent).
- [ ] Both repairs keep their recorded fixtures green where the fixture
      reply is exactly-N (the Gate 0.5 recorded fixture
      `planner-r2-objects-raw.txt` parses to exactly its count — assert,
      do not weaken); any Gate 0.5 pin that asserted PADDED output is
      replaced with the exact-count expectation and the reasoning recorded
      (strengthened-or-equal, the T-044 precedent).
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6): the
      behavior change stated plainly (short/long replies now fail the
      planner phase), the inertness contract's narrowed scope recorded —
      pinned by the full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (planner-phase behavior changed); trigger analysis
      recorded at landing. **Gate 3 n/a.**

## Landed

## Verification

New fast-tier check (next free gate number at landing): pad/truncate red
bar, exact-count green, preserved-case byte-identity, fallback e2e, the
Gate 0.5 fixture pins. Gate 0, Gate 0.5 green, full fast tier ALL GREEN;
Gate 2 owed and recorded.

## References

src/parse.ts:40-97 (both scans + the pad/truncate tails) · src/runner.ts:536-555
(the repair/fallback path the failure now flows through),
docs/adversarial-review-2026-10-23.md R9 (the disposition this promotes) ·
docs/tickets/T-040 (the recorded objects fixture + the inertness
contract's origin), T-029 (repair 1), T-049 (the yield consumer this
protects) · scripts/fixtures/planner-r2-objects-raw.txt (the exact-count
fixture to preserve).
