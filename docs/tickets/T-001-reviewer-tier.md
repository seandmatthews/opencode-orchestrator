# T-001 — Reviewer tier: advisory post-gate review

**Status:** done 2026-10-11
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

## Landed

- `src/parse.ts`: `parseBriefs` moved out of the runner; new `parseReview` validates
  `{observations: [{finding, severity, evidence?}]}` with severity restricted to
  {info, concern, blocker-advisory}, prose-tolerant scan from the last `}`, findings
  trimmed, empty/badly-typed payloads rejected.
- `src/runner.ts`: `runReview` executes after gates for candidates with
  `passedAllGates === true` only; one bounded repair attempt on parse failure;
  persistent failure records `review.ok: false` without failing the run. Reviewer
  runs in the candidate worktree (post-worker, pre-dispose) with diff (capped at
  30k chars), brief, and gate results in the prompt.
- `src/cli.ts`: `--reviewer-model` (default `zai-coding-plan/glm-5.3`),
  `--no-review`; summary lines show observation counts.
- `scripts/check-parse.mjs`: 17 parser-contract checks (Gate 0.5, fast tier).
- `scripts/verify.mjs`: Gate 2 asserts review artifact exists and is well-formed for
  every passing candidate and absent for every failing one.

Measured (full tier 2026-10-11, run `C:\swarm\verify\20261011011337`): 2/2 candidates
reviewed on first attempts, 5 observations each — c01 all `info` (incl. a
near-antipodal NaN edge in the brief-mandated haversine and a coverage gap), c02 one
`concern` that caught the worker silently correcting a typo in the planner's brief
(`[5,7,8]` vs correct `[5,7,9]`) and flagged it for human blessing. Gates pass either
way; the human decides. That concern is the phase working as designed.

Deviations: the acceptance criterion pinning `--no-review` via a Gate 2 run without
reviewer traffic was demonstrated as a one-off manual run instead
(`--candidates 1 --no-review --clean`, run `C:\swarm\20261011011732`: header shows
`reviewer: (disabled)`, no review lines, no review artifacts) — a permanent second
full e2e in verify:full would double model spend every run for a three-line code path;
the flag → phase-skip remains covered by typecheck + the one-off record here.

## Verification

Gate 0, Gate 0.5, Gate 1, Gate 2 (extended with review assertions — ALL GREEN
2026-10-11), Gate 3 n/a (no new adapter; reviewer runs on the existing
`WorkerAdapter` in a read-only posture per VERIFICATION.md Known issues #6).

## References

docs/spec/inference-refinery-v2.md §9 (evaluation model), §3.2 (machine gates, agent
advice).
