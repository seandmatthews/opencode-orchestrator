# T-056 — Brief-count honesty: no silent cyclic padding — an under- or over-count planner reply is a parse failure (register R9)

**Status:** done 2026-10-26
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

- [x] **Red bar recorded first** (AGENTS #8), token-free: `parseBriefs`
      with a 1-brief array and count 2 returns 2 identical briefs on main
      (the pad asserted as the red bar); a 3-brief array with count 2
      returns 2 (the truncate asserted too).
- [x] Green: the same inputs return null post-change; an exactly-N array
      returns N briefs byte-identical to main's output (the preserved
      case pinned explicitly) — pinned by the same check.
- [x] End-to-end honesty: a stubbed planner phase whose reply is short
      lands in the raw-goal fallback (`fallbackUsed: true`, console line)
      rather than padded dispatch — pinned by the same check via the
      repair-path seams (token-free stub adapter, the Gate 1.17
      precedent).
- [x] Both repairs keep their recorded fixtures green where the fixture
      reply is exactly-N (the Gate 0.5 recorded fixture
      `planner-r2-objects-raw.txt` parses to exactly its count — assert,
      do not weaken); any Gate 0.5 pin that asserted PADDED output is
      replaced with the exact-count expectation and the reasoning recorded
      (strengthened-or-equal, the T-044 precedent).
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6): the
      behavior change stated plainly (short/long replies now fail the
      planner phase), the inertness contract's narrowed scope recorded —
      pinned by the full fast tier ALL GREEN.
- [x] **Gate 2 owed** (planner-phase behavior changed); trigger analysis
      recorded at landing. **Gate 3 n/a.**

## Landed

2026-10-26, Gate 1.42 (`scripts/check-brief-count.mjs`, wired into
`scripts/verify.mjs` fast tier after Gate 1.41).

- `src/parse.ts`: the pad/truncate tails DELETED from both scans —
  `scanBriefs` and `scanBriefObjects` now return their parsed array ONLY
  when the valid-brief count is EXACTLY the requested count (the
  all-or-nothing rule's exact-count clause; a mismatched slice is skipped
  like any invalid slice, so the prose-tolerant leftward bracket scan is
  unchanged); the header docblock states the deliberate narrowing of the
  byte-identity inertness contract to exactly-count inputs. Everything else
  is untouched: `parseBriefs`'s three-resort chain, the separator repair,
  the objects read, trimming, the non-string element filter, `parseReview`.
- No other engine surface changed: `src/runner.ts`'s planner phase
  (`runPlannerPhase`), its bounded repair attempt, the raw-goal fallback,
  and `PlannerReport`'s shape (`ok`/`attempts`/`fallbackUsed`/`briefs`/
  `rawOutputPath`) are consumed exactly as before — the mismatch failure
  now actually reaches them. No report shape change, no adapter change.
- `scripts/check-parse.mjs` (Gate 0.5): the three pins that asserted PADDED
  output were REPLACED with exact-count expectations — strengthened, not
  weakened (the T-044 precedent; the reasoning is recorded at the pins):
  "short array cycles to fill count" (main: `["a"]`@3 → `["a","a","a"]`)
  and "long array truncates to count" (main: 4 briefs@2 → 2) now assert
  null; "objects repair: one-object payload cycles to fill count, longer
  truncates" now asserts null both ways; a new explicit preserved-case pin
  (exactly-N byte-for-byte, trim parity, the filtered-count mixed-array
  case). The T-040 paragraph's absolute byte-identity claim narrowed to
  EXACTLY-COUNT inputs.
- `scripts/check-brief-count.mjs` (new, Gate 1.42, 17 assertions): leg A —
  the ticket's red-bar shapes parse null; exact-count through all three
  scans (plain, separator-repair — the recorded duplicated-quote shape
  parses null at count 3 and both briefs at count 2 — and objects);
  preserved byte-identity pinned explicitly; the recorded
  `planner-r2-objects-raw.txt` fixture parses to exactly its count. Leg B —
  token-free `runSkeleton` e2e with stub adapters (the Gate 1.22 leg-B
  pattern): a SHORT planner reply for 2 candidates lands in the raw-goal
  fallback (`ok: false`, `fallbackUsed: true`, 2 attempts, the loud
  `planner: no valid output, using raw goal in Ns (2 attempts)` console
  line, both candidates riding the RAW GOAL, no worker prompt carrying the
  padded brief, `planner-raw.txt` byte-verbatim, the run still completing
  with gate-decided verdicts); the control face — an exactly-N reply
  dispatches its parsed briefs in order on one attempt with the plain
  success console line.
- `scripts/verify.mjs`: new fast-tier section Gate 1.42 after Gate 1.41.
- VERIFICATION.md: Gate 0.5's intro and both repair paragraphs state the
  exact-count clause and the narrowed inertness scope plainly; new Gate 1.42
  section (the rule, both legs, the recorded red bar, the intermediate red,
  the strengthened-pin reasoning); Gate 2 section notes the planner-
  assertion consequence and the owed status.
- Non-goals kept: no k<count dispatch (the candidate contract), no model
  top-up (mechanical composition only), `--jobs` briefs untouched (never
  parsed by parseBriefs). No decisions.md change, no ride-alongs.

Gates measured: red bar recorded FIRST on main (a read-only probe importing
main's `src/parse.ts` before this change-set existed):
`parseBriefs('["a"]', 2)` → `["a","a"]` (the pad asserted) and
`parseBriefs('["a","b","c"]', 2)` → `["a","b"]` (the truncate asserted).
Intermediate red, post-parser-edit and pre-pin-edit: Gate 0.5 red on
EXACTLY the three padded pins — `check-parse: 3 failure(s)`, exit 1 — with
every exactly-N and recorded-fixture pin green (the intended blast radius).
Post-change: `node node_modules/tsx/dist/cli.mjs scripts/check-parse.mjs`
ALL GREEN (28 assertions); `node node_modules/tsx/dist/cli.mjs
scripts/check-brief-count.mjs` ALL GREEN (17 assertions); full fast tier
`node scripts/verify.mjs fast` ALL GREEN, exit 0 — Gate 0, Gate 1, Gate
0.5, Gates 1.5–1.42 green in the same pass.

Gate 2 trigger analysis (the ticket's criterion): the standing Gate 2
trigger ("Required when touching `src/runner.ts`, any adapter, gates,
workspace handling, or anything that changes report shape") does not fire on
its own — `src/runner.ts` is untouched, no report shape changed — but the
ticket's own criterion owes Gate 2 because PLANNER-PHASE BEHAVIOR changed:
on a real run, `runPlannerPhase`'s parse now fails a mismatched reply into
the bounded repair and the raw-goal fallback. Expected healthy outcome is
GREEN: real exactly-count planner replies parse byte-identically, so Gate
2's `planner.ok === true` / `fallbackUsed === false` assertions double as
the real-token proof the clause did not disturb the working case. A future
run whose real planner genuinely returns a mismatched count records the
fallback honestly and goes red on those assertions — an honest red naming a
real planner failure, not a regression of this change-set. **Gate 2 owed;
the next full run IS the evidence. Gate 3 n/a** (no adapter change).
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
