# T-050 — Round-2 brief-premise guard: composer framing fix + a mechanical brief-annotation guard (the Known issue #6 successor)

**Status:** proposed
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
