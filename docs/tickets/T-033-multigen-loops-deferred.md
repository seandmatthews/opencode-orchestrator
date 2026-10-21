# T-033 — Multi-generation feedback loops deferred: `--rounds` stays 1..2 (ROADMAP stage 8; spec §20, §34 M8)

**Status:** proposed
**Category:** docs
**Value (1-5):** 3 · **Risk (1-5):** 1
**Depends on:** —

## What

A docs-only change-set that converts the standing but undated ROADMAP deferral of
multi-generation loops into a dated, re-enterable decisions.md entry — the T-022
shape: three files plus the index row, zero behavior change.

1. **docs/decisions.md** gains one dated entry (2026-10-20) — *Multi-generation
   feedback loops are deferred; `--rounds` stays integer 1..2.* The entry:
   - States the rule: `--rounds` accepts only integers 1..2 — the parse-time cap
     (`src/cli.ts:218-219`, refusal "capped at one feedback round this slice"),
     machine-pinned by Gate 1.22 leg D's `--rounds 3 (beyond the cap)` refusal
     face (`scripts/check-rounds.mjs:556`; VERIFICATION.md:2386, :2251).
   - Names the scope, so ROADMAP.md:22's ambiguity dies with it: the deferral
     covers (i) widening the T-030 survivor-evidence feedback loop beyond one
     feedback round — spec §34:2140's "bounded generation loops" — AND (ii) any
     adversarial-in-loop generation structure (the second reading of
     ROADMAP.md:22's "multi-generation adversarial loops"). It does NOT cover
     T-032's adversarial probe (evidence bundle, never a verdict, no loop) and
     does NOT ban candidate lineage records as such (§34:2137, carved by
     T-030:88-90) — lineage is re-entry condition (c) below, not a forbidden
     structure. Whatever shape eventually re-enters keeps composed survivor
     evidence a planning input only, never a verdict input (decisions.md:19-21)
     — already how `src/rounds.ts` is built and pinned (Gate 1.22).
   - Carries the honest empirical grounding: the bounded loop demonstrably runs
     end to end on real tokens — the driving Gate 2 run's artifacts at
     `C:\swarm\verify\20261020171354\report.json` record round 1 executed with
     survivors `[c01, c02]` and round 2 executed with survivors
     `[c01-r2, c02-r2]`, all four candidates `passedAllGates`, planner `ok` —
     but as an improvement signal the run shows NOTHING: round-1 survival was
     100% (2/2), so round 2 had nothing to recover (the larger round-2
     `diffBytes` — 4761/8915 vs 3888/4830 — ride different briefs, not a
     controlled comparison). T-030's staged question (T-030:107-108, mirrored
     VERIFICATION.md:2401-2403) is unanswered, not answered-yes. Two honesty
     caveats the entry carries: that run id appears in no repo doc today
     (grep over VERIFICATION.md, docs/, README.md, AGENTS.md → zero hits), so
     the entry becomes its first durable record; and the run's artifacts live
     outside the repo with the wrapper's exit status recorded nowhere in it —
     the entry cites the artifacts, never a passing verdict.
   - Names three re-entry conditions, any of which reopens this via a new dated
     entry that rewrites this one (the mechanism at the top of decisions.md,
     :3-4), never a relitigation: (a) recorded runs where round-1 survival is
     below 100% and round 2 demonstrably recovers — T-030's staged empirical
     question actually answered; (b) T-031's generation-loop stop conditions
     land (spec §20:1273-1274, consecutive-generations-no-new-survivor /
     max-generation-count) and need generations to iterate — the extension
     point T-031 itself names (T-031:128-131, `src/runner.ts:209-257`); or
     (c) candidate lineage lands (§34:2137; T-030:88-90's carve) — without
     generation identity beyond the `-rN` id suffix, iterated generations are
     unaccountable.
2. **docs/ROADMAP.md** — the stage-8 row (`:20`) gains the stage's disposition:
   early stop → T-031 (proposed); adversarial probes → T-032 (proposed);
   bounded generation loops + candidate lineage → deferred (decisions.md
   2026-10-20). The deliberately-deferred line (`:22`) gains the
   dated-decision pointer for the multi-generation item, exactly the
   disposable-clones precedent beside it.
3. **docs/tickets/README.md** — this ticket's index row. Nothing else in the
   index changes.

**Does NOT claim:** no `src/` or `scripts/` change; no VERIFICATION.md change
(AGENTS.md #6 extends verification with *features* — this records the absence
of one; Gate 1.22 stays byte-identical and rides green, which is the point);
no claim that the empirical question is answered; no reopening or weakening of
T-030's landed pin; no scope claim over T-031 or T-032 — it composes with them
(T-031:128-131's carve becomes re-entry (b); T-032:189-192's phase carve is
adjacent, and adversarial-in-loop structure stays deferred even after T-032
lands the probe type). The widening implementation itself is carved off, held
behind the re-entry conditions, and deliberately NOT ticketed now: loop
generalization of the hand-unrolled two-round block (`src/runner.ts:209-257`,
hard-coded `round-2-context-block.txt` at :221 and `-r2` ids at :223), the N>2
id-scheme design (`c01-r2-r3` vs `c01-r3`), the explicit AGENTS.md-#8 flips of
Gate 1.22's leg-D refusal face and `-r2` shape assertions
(`scripts/check-rounds.mjs` carries 30 `-r2` occurrences — :178, :261,
:291-295 among them) plus Gate 2's two-EXECUTED-rounds assertions and its
two-leg 35-min outer ceiling (VERIFICATION.md:2427-2433, :2454-2462), and the
generation-loop stop conditions that would ride the widened loop.

## Why

ROADMAP.md:22 defers "multi-generation adversarial loops" undated, without
re-entry conditions, and ambiguously — nothing distinguishes "any feedback
loop past n=2" from "adversarial structures in the loop". decisions.md has no
deferral entry for it (full read, 69 lines: seven 2026-10-10 entries plus
clones 2026-10-18), so unlike clones there is no dated home a future widening
ticket would have to rewrite first — a widening could land silently as
"not a relitigation" when it is one. The ambiguity is live right now: two
proposed stage-8 tickets (T-031 early stop, T-032 adversarial probes) both
carve around the unowned remainder, and the spec's own vocabulary is divided —
§34:2134-2141 lists "second-generation briefs" and "bounded generation loops"
as separate M8 adds (the former landed via T-030, the latter is exactly the
widening), while the canonical run shape is ONE extra generation with no
loop-back (§1:28-29, steps 8-9) and only §20:1273-1274 contemplates iterating
generations, under `:1267` "Waste is useful. Unbounded waste is a bug."

The deferral is also the empirically honest move: T-030 staged the question —
"whether a feedback round improves outcomes is the empirical question the
first real run exists to answer" (T-030:107-108; its Landed section records
the question NOT answered, T-030:304-305) — and the one recorded real 2-round
run answers "no signal": round 1 eliminated nobody (2/2 survivors), so round 2
had nothing to recover (artifacts extracted this session from
`C:\swarm\verify\20261020171354\report.json`; the diffByte growth across
rounds is confounded by different briefs). Widening now would spend a full
planner+worker+review token pass per extra round with no stop condition beyond
the cap, and flip ~20 green shape pins for the least-differentiated M8 add.
The composer machinery, note, is already round-index-generic
(`src/rounds.ts:87-88` `finishedRound`, tags `round-N-survivor` at :150,
`ev-<id>` records at :144; `RoundRecord` N-capable at `src/types.ts:383`) —
the cap lives in the CLI (`src/cli.ts:218-219`) and the hand-unrolled runner
block (`src/runner.ts:209-257`), which is exactly why pinning the cap in a
dated decision, rather than reworking code, is the right-sized slice.

Consistent with the locked decisions: this *adds* a decision rather than
contradicting one (decisions.md:3-4); it binds any future widening to the
machine-gates rule (decisions.md:19-21 — composed evidence advises, gates
decide); and it follows the T-022 precedent end to end (docs-only, Category
docs, Value 3 / Risk 1, named manual checks, VERIFICATION.md deliberately not
extended).

## Acceptance criteria

- [ ] The change-set touches exactly four paths — `docs/decisions.md`,
      `docs/ROADMAP.md`, `docs/tickets/T-033-multigen-loops-deferred.md`,
      `docs/tickets/README.md` (index row) — and nothing under `src/`,
      `scripts/`, or VERIFICATION.md. Human-judgement item, named manual
      check: `git diff --stat` against the base reviewed in change-set review;
      any extra path fails it.
- [ ] The decisions entry carries its date, the 1..2 rule with its Gate 1.22
      leg-D pin anchor (`scripts/check-rounds.mjs:556`), the scope statement
      (both covered structures; both explicitly not-covered: T-032's probe,
      lineage-as-such), the empirical grounding with the no-signal statement
      and both honesty caveats (run id absent from repo docs; artifacts-only,
      no wrapper verdict), and all three re-entry conditions. Human-judgement
      item, named manual check: the entry is read against the What section in
      change-set review.
- [ ] The ROADMAP stage-8 row carries the per-item disposition (T-031 proposed,
      T-032 proposed, loops + lineage deferred with the dated pointer), and the
      deliberately-deferred line names the multi-generation item with the
      decisions.md 2026-10-20 pointer. Pinned by the same named manual check
      (diff read).
- [ ] `npm run verify` exits 0 in the same change-set — Gate 0 typecheck plus
      the fast tier, Gate 1.22 green UNCHANGED: its leg-D refusal face
      `--rounds 3 (beyond the cap)` (`scripts/check-rounds.mjs:556`) is the
      machine pin that the cap this decision records still holds. No behavioral
      claim is made by this criterion.

No new check is added: no gate can pin decision prose, and adding one would be
ceremony — docs/tickets/README.md:29-30 sends human-judgement items to a named
manual check instead (the T-022:131-133 reasoning verbatim in spirit: the
behavioral side is already pinned by the untouched, riding-green Gate 1.22).

## Verification

Gate 0 plus the fast tier via `npm run verify` — run for the trivial no-op
reason (no `src/` touched) and for the load-bearing one: Gate 1.22
(VERIFICATION.md:2238, `scripts/check-rounds.mjs`) must come out green and
byte-identical, its leg-D `--rounds 3` refusal face intact, proving the
recorded cap still holds. Plus the named manual change-set review above. No
VERIFICATION.md extension: AGENTS.md ground rule 6 scopes verification to
features, and this change-set adds no behavior (T-022 precedent). Gates 1 / 2 /
3 are untouched and remain green for the reasons already recorded there.

## References

- Spec: docs/spec/inference-refinery-v2.md §1:28-29 (run steps 8-9 — one
  generation, no loop-back), §20:1265-1281 (early stop; `:1267` waste rule,
  `:1273-1274` the two generation stop conditions), §34:2134-2141 (M8's five
  separate adds — second-generation briefs :2138 landed, bounded generation
  loops :2140 deferred here, candidate lineage :2137, adversarial probes
  :2139 → T-032)
- Code: src/cli.ts:212-223 (the cap), :256-261 (combination refusals) ·
  src/runner.ts:209-257 (hand-unrolled two-round block) · src/rounds.ts:87-88,
  :144, :150 (round-generic composer) · src/types.ts:381-421 (N-capable
  RoundRecord/RunReport) · scripts/check-rounds.mjs:554-565 (leg-D refusals)
- VERIFICATION.md: :2238 (Gate 1.22), :2251 (integer 1..2 pin), :2386 (leg-D
  `--rounds 3`), :2401-2403 (n ≤ 2 + the staged question), :2427-2433 (Gate 2
  two-round assertions), :2454-2462 (two-leg 35-min ceiling)
- Tickets: T-030 (done — owns the 1..2 loop and the staged empirical question,
  T-030:95, :107-108, :304-305; lineage carve :88-90) · T-031 (proposed —
  early stop; its :128-131 carve is re-entry (b)) · T-032 (proposed —
  adversarial probe; its :189-192 phase carve stays carved, in-loop structure
  remains deferred) · T-022 (done — the deferral-ticket precedent this follows
  in shape)
- Decisions: docs/decisions.md:3-4 (the dated-rewrite mechanism), :19-21
  (machine gates decide; evidence advises)
- Empirical record: `C:\swarm\verify\20261020171354\report.json` (outside the
  repo; rounds block and per-candidate verdicts extracted and cited under
  What — artifacts only, no wrapper verdict claimed)
