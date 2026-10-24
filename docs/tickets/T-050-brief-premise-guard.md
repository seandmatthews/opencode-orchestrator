# T-050 — Round-2 brief-premise guard: composer framing fix + a mechanical brief-annotation guard (the Known issue #6 successor)

**Status:** done
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** —

## What

The T-043 lane's Gate 2 round-1 red (run `20261023204747`, recorded under
Known issue #6, 2026-10-23) exposed a composition defect with a clean
mechanism: the rounds composer renders survivor evidence into the round-2
planner prompt, and the round-2 planner then wrote a brief asserting
`vec3.js` exists — a file only round-1 c02's SURVIVOR DIFF creates, absent
from the shared base that round 2 re-leases at. The worker's read failed,
it exited 0 with zero edits, and the NO-OP ladder eliminated it — the
ladder behaved perfectly; the brief lied about the workspace. The framing
question was carved to "the T-030/T-031 successor" — this is it. Two
changes, both deterministic:

1. **Composer framing fix** (`src/rounds.ts`, `composeRoundPacket`): the
   rendered block's fixed framing gains explicit premise lines — survivor
   diffs are CHANGES against the same base, not base state; round 2
   re-leases at the SAME baseSha; files created by survivor diffs DO NOT
   exist in a round-2 worktree; every brief must be implementable at the
   base commit alone. Prompt text, never capability (the T-030 posture).
2. **The mechanical guard** (planner-mode briefs, rounds 1 AND 2 — the
   round-1 planner is repo-blind and can hallucinate paths just as easily;
   `--jobs` briefs are operator-owned and are NEVER touched): before the
   briefs become jobs, scan each for path-shaped tokens (the T-045
   `src/gate/overlap.ts` token-extraction precedent); for each token naming
   a file ABSENT at `baseSha` (`git cat-file -e` / ls-tree against the
   recorded base — no lease needed): if the path is in a round-1 survivor's
   changed paths (the T-045 `WorkspaceProvider.changedPaths` seam), append
   the fixed engine note naming it — "does NOT exist in your worktree; it
   was created by a round-1 candidate's diff — create it yourself if the
   change needs it"; otherwise the distinct fixed note — "does not exist at
   the base commit — verify the path". Bounded at a documented exported
   constant (the `MAX_RETRY_FINDINGS` pattern). The ANNOTATED brief is the
   dispatched brief (hashed into that attempt's `promptVersion` — one
   composition, two consumers, the T-029/T-038 precedent); the planner's
   UNANNOTATED brief is preserved verbatim in a per-candidate evidence file
   (`brief-premise.txt`, before/after) and `base.brief` keeps the
   planner's text (the retry-brief precedent: composed text is
   attempt-scoped evidence, never a replacement). Annotations never touch
   any verdict expression — they change what a worker is TOLD, which is a
   brief, not a gate.

## Why

This class killed a real Gate 2 leg and will keep killing round-2 legs
under `--rounds 2` — it is the cheapest known suppressor of the system's
no-op rate, and it is exactly the shape the engine already trusts:
mechanical string assembly from recorded evidence, bounded, evidence-first,
verdict-silent. The framing fix addresses the cause; the guard addresses
the symptom when the planner ignores the framing — together they close the
mechanism the T-043 diagnosis named, without touching the NO-OP ladder that
correctly eliminated the result.

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free: a fixture brief
      "extend vec3.js with …" where `vec3.js` exists only in a recorded
      survivor diff — on main the brief dispatches unannotated (no note, no
      evidence file); the check asserts the absence on main as the red bar.
- [ ] Green, survivor-created: the same input post-change — the dispatched
      brief carries the fixed note naming `vec3.js` with the
      survivor-created reason; `brief-premise.txt` records before/after;
      the dispatched attempt's `promptVersion` differs from the
      unannotated text's hash (one composition, two consumers) — pinned by
      the same check.
- [ ] Green, absent-at-base: a token absent at base and NOT in survivor
      evidence gets the distinct base-commit-absent note — pinned by the
      same check.
- [ ] Inertness: briefs whose tokens all exist at base dispatch
      byte-identical prompts to today (no annotation, no evidence file, no
      report field) — pinned by the same check.
- [ ] Composer framing: the rendered block contains the fixed premise
      lines verbatim; round-1 prompts (no block) are byte-identical to
      today — pinned by the existing T-030 rounds checks extended with the
      framing assertions.
- [ ] `--jobs` briefs never annotated — pinned by the same check.
- [ ] Bounded: a brief with more absent-at-base tokens than the constant
      annotates at most the constant's count (constant exported for the
      gate) — pinned by the same check.
- [ ] Verdict inertness: a candidate whose guard fired passes/fails
      exactly by its gates — `passedAllGates` unchanged by the annotation —
      pinned by the same check.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) — pinned
      by the full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (`src/` runner + rounds touched; the round-2 e2e leg
      is the real exercise of the guard); trigger analysis recorded at
      landing. **Gate 3 n/a.**

## Landed

2026-10-24. Exactly the ticket's two changes, no ride-alongs:

- **Composer framing fix** — `src/rounds.ts`: exported
  `ROUND_PREMISE_LINES` (4 fixed lines: survivor diffs are CHANGES
  against the same base, not base state; round 2 re-leases at the SAME
  base commit; survivor-created files DO NOT exist in a round-2 worktree;
  every brief must be implementable at the base commit alone), embedded
  by `renderRoundBlock` after the header, before the first survivor
  body. Framing, not record content — the packet and its fingerprint are
  byte-identical (pinned). Round-1 prompts untouched.
- **The mechanical guard** — new `src/premise.ts`
  (`annotateBriefPremise`, `briefPathTokens`, `MAX_PREMISE_NOTES = 5`,
  `PATH_TOKEN_EXTENSIONS`, the two fixed note messages), wired in
  `src/runner.ts`: planner-authored briefs only (rounds 1 AND 2;
  `--jobs`, planner-fallback raw-goal, and `--no-planner` briefs are
  operator-owned and never touched — pinned); tokens whose final
  dot-suffix is in the curated list are probed with list-form
  `git cat-file -e <baseSha>:<path>` against the target repo (no
  lease); absent paths get the survivor-created note when in the
  round-1 survivors' changed paths (the T-045 seam, recorded in-wave
  where the overlap block already derives them — one derivation, two
  consumers), the distinct base-commit-absent note otherwise; bounded
  at `MAX_PREMISE_NOTES`, first-mention order; the annotated brief
  dispatches on every attempt (`promptVersion` hashes it — one
  composition, two consumers), before/after evidence in
  `<candidateDir>/brief-premise.txt` riding the attempt's
  `outputArtifacts`, `CandidateReport.brief` keeps the planner's text;
  verdict expressions untouched (both directions pinned). An
  unresolvable base commit degrades loudly to unannotated dispatch
  (never-break-a-run).

**Red bar (AGENTS #8):** the lane at main (96a2a81, engine untouched)
running the new check: **13 failures of 38, exit 1**; post-change
**43/43 green**. **Gates measured:** Gate 0 green; full fast tier
(`node scripts/verify.mjs fast`) **ALL GREEN, exit 0** — including the
new **Gate 1.35** (`scripts/check-brief-premise.mjs`, 43 assertions)
and Gate 1.22's `check-rounds.mjs` extended with five framing assertions
(63 assertions ALL GREEN). **Gate 2 owed** (src/runner.ts + src/rounds.ts
touched; the round-2 e2e leg is the real exercise of the guard — trigger
analysis in VERIFICATION.md Gate 1.35); **Gate 3 n/a** (no adapter
change). VERIFICATION.md extended in the same change-set (Gate 1.35
section + the Known issue #6 2026-10-23 disposition follow-up naming
this ticket). Heuristic honestly recorded: extensionless names,
directory-only paths, out-of-list suffixes, and prose identifiers
(`Math.sqrt`, `console.log`) are honest misses; false positives are
impossible by construction.

**Gate 2 run (review round 1, run 20261024193003): 1 failure — the c02
NO-OP, model-behavior variance in Known issue #6's recorded
give-up-without-editing class (fourth instance; full diagnosis in
VERIFICATION.md).** The worker explored its own lease successfully
(every read green, zero denials in the whole 25-line `worker.log`) and
produced nothing — exit 0 in 562s, 0-byte diff, the ladder eliminating
it exactly as designed; c02's brief asserted nothing absent, so the
premise guard was correctly inert for it. Every other tier assertion —
both rounds, the sibling candidates, verifier, review, hygiene,
disposal — green on the same run. The T-050 real-run surfaces this gate
exists to exercise were confirmed from the run's kept artifacts: the
guard FIRED on c01's round-1 brief (the planner's own "e.g. src/calc.js"
hedge; `c01/brief-premise.txt` carries the before/after), the
ANNOTATED candidate survived (3,131 bytes, all gates — the note
verified a path instead of derailing a worker), the composed block
carried all four premise lines into the real round-2 planner prompt,
and that planner stated TRUE base facts unprompted (c01-r2 guard-inert,
surviving, 4,489 bytes). No code change, no weakened assertion; the
remedy is a re-run.

## Verification

New fast-tier check (next free gate number at landing): both annotation
kinds, inertness, framing lines, `--jobs` carve, bound, verdict inertness,
promptVersion split. Gate 0, full fast tier ALL GREEN; Gate 2 owed and
recorded.

## References

VERIFICATION.md Known issue #6 (2026-10-23 observation — the mechanism and
run `20261023204747`) · src/rounds.ts (`composeRoundPacket` — the framing
site), src/runner.ts:216-301 (the round-2 wave the guard precedes),
:804-854 (the mechanical-composition precedent) · src/gate/overlap.ts +
`WorkspaceProvider.changedPaths` (T-045 — the token-extraction and
changed-paths seams this reuses) · docs/tickets/T-030 (the composer), T-038
(composed-brief-as-evidence precedent), T-043 (the diagnosis), T-049 (the
yield instrument that will measure whether this moves the no-op rate) ·
docs/adversarial-review-2026-10-23.md §3 A2.
