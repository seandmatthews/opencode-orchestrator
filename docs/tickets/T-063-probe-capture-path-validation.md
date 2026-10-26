# T-063 — Probe construction-path validation: the capture-path contract enforced at the class boundary (register R18)

**Status:** proposed
**Category:** engine
**Value (1-5):** 2 · **Risk (1-5):** 1
**Depends on:** —

## What

`ScreenshotProbe`'s docblock claims it holds the capture-path contract
for directly constructed scenarios, but `captureRefusal`
(src/probe.ts:1344-1348) checks only non-empty string — the
workspace-relative / no-`..` refusals live solely in `parseJobsSpec`.
A hand-built scenario (not arriving through a parsed spec) can point
its capture path at any PNG-magic file reachable from the worktree and
have it copied into the run's evidence. In-pipeline specs are guarded;
the gap is the class boundary the docblock claims is guarded.

The change — the first branch of R18's two-part disposition:

1. `captureRefusal` gains the spec's own refusals: absolute paths and
   `..` segments (and the segment-lexical check the spec parser uses —
   same vocabulary, same message shapes; parse-side and class-side must
   not diverge).
2. Evidence-bundle path construction (run-folder paths built from probe
   and candidate ids) validates the ids it interpolates against the
   engine's id charset — or, where an id is provably engine-generated
   and never operator-supplied, the code says so in a comment and the
   check pins the invariant instead. The implementing change-set takes
   whichever branch the read shows true; the docblocks stop claiming
   contracts the code does not hold either way.

Non-goals: changing the in-pipeline spec path (byte-identical
behavior through `parseJobsSpec` — existing Gate 1.15 pins green,
strengthened-or-equal); new spec grammar; touching the other probe
classes beyond their own docblock truthfulness.

## Why

R18: defense-in-depth that is claimed but absent is worse than none —
a reader of the docblock audits one layer and trusts two. This is the
smallest honesty+hardening fix in the register: no behavior change for
any spec-driven run, one less silent gap for hand-built scenarios.

## Acceptance criteria

- [ ] Red bar recorded first (AGENTS #8), token-free: on main, a
      directly constructed screenshot scenario with an absolute capture
      path is NOT refused by the class (only the empty-string refusal
      exists) — asserted as the red.
- [ ] Post-change, directly constructed scenarios with absolute and
      `..` capture paths are refused with the spec parser's vocabulary
      — pinned by a new fast-tier check (next free gate number at
      landing).
- [ ] In-pipeline parity: the spec-driven path behaves byte-identically
      (the existing Gate 1.15 screenshot pins green, unchanged) —
      pinned by the existing suite.
- [ ] Evidence-path ids: the chosen branch (validated or pinned
      invariant) is asserted by the same new check.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) —
      pinned by the full fast tier ALL GREEN.
- [ ] **Gate 2 not owed** (probe internals; no report shape change, no
      runner/adapter/gate/workspace touch — record the trigger
      analysis at landing). **Gate 3 n/a.**

## Landed

## Verification

New fast-tier check: class-boundary refusals (absolute, `..`, empty),
spec-path parity, the id-invariant branch. Gate 0, full fast tier ALL
GREEN.

## References

src/probe.ts:1277 (the captureRefusal call site), :1344-1348 (the
non-empty-only check), the parseJobsSpec capture refusals (the source
of the vocabulary to mirror) ·
docs/adversarial-review-2026-10-23.md R18 (the disposition this
promotes) · docs/tickets/T-019 (the screenshot probe's contract
origin), T-015 (the Probe seam).
