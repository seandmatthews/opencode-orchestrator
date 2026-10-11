# T-001 — Reviewer tier: advisory post-gate review

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** —

## What

After gates decide survival, run one reviewer-tier job (default:
`zai-coding-plan/glm-5.3`) per passing candidate. Input: the candidate diff, gate
results, and the brief. Output: structured advisory observations (findings, never
verdicts) written to the run artifacts and included in `report.json`.

## Why

The planner tier currently produces briefs but nothing reads the results. Spec §9.2:
model evaluators produce evidence-citing observations; survival stays with gates. This
is the smallest honest slice of the evaluation model and the second half of the
two-tier thesis.

## Acceptance criteria

- [ ] Every passing candidate gets exactly one review artifact (`<id>/review.json`),
      containing observations with at least a `finding` string and a `severity` in
      {info, concern, blocker-advisory} — pinned by Gate 2 extension in
      `scripts/verify.mjs`.
- [ ] A candidate that fails gates is not reviewed (gates decide; review is advisory)
      — pinned by a Gate 2 assertion.
- [ ] Reviewer output that fails its shape check goes through one bounded repair
      attempt, then is recorded as `review.ok: false` without failing the run —
      pinned by a Gate 2 assertion using a forced-invalid run or unit-style fixture.
- [ ] `--no-review` skips the phase entirely — pinned by Gate 2 run without reviewer
      traffic in the log.
- [ ] VERIFICATION.md Gate 2 extended with the review assertions in the same
      change-set.

## Verification

Gate 0, Gate 1, Gate 2 (extended), no Gate 3 (no new adapter — reviewer runs on the
existing `WorkerAdapter` in a read-only posture per Known issues #6).

## References

docs/spec/inference-refinery-v2.md §9 (evaluation model), §3.2 (machine gates, agent
advice).
