# T-063 — Probe construction-path validation: the capture-path contract enforced at the class boundary (register R18)

**Status:** done
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

- [x] Red bar recorded first (AGENTS #8), token-free: on main, a
      directly constructed screenshot scenario with an absolute capture
      path is NOT refused by the class (only the empty-string refusal
      exists) — asserted as the red.
- [x] Post-change, directly constructed scenarios with absolute and
      `..` capture paths are refused with the spec parser's vocabulary
      — pinned by a new fast-tier check (next free gate number at
      landing).
- [x] In-pipeline parity: the spec-driven path behaves byte-identically
      (the existing Gate 1.15 screenshot pins green, unchanged) —
      pinned by the existing suite.
- [x] Evidence-path ids: the chosen branch (validated or pinned
      invariant) is asserted by the same new check.
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6) —
      pinned by the full fast tier ALL GREEN.
- [x] **Gate 2 not owed** (probe internals; no report shape change, no
      runner/adapter/gate/workspace touch — record the trigger
      analysis at landing). **Gate 3 n/a.**

## Landed

2026-10-27, lane `ticket/T-063-probe-capture-path-validation` off main
a67d139. The diff is `src/probe.ts` + the new check + docs — parse-side
(`src/scheduler.ts`), runner, adapters, gates, workspace untouched.

**Red bar, recorded first, token-free, on the pristine lane (= main
a67d139)**, via a throwaway script (deleted from the change-set; output
verbatim in VERIFICATION.md's Gate 1.49 section): face 1 (the ticket's
named red) — an absolute capture path at `scripts/fixtures/tiny-1x1.png`
outside the workspace: `class refused the absolute capture path: false`,
the class reporting the out-of-workspace path as "inside the workspace"
in its missing-file error; face 2 (the live exfiltration vector the
ticket's What describes) — a five-level `..` chain at the same PNG:
`class refused: false`, `bundle success: true`,
`out-of-workspace PNG copied into run evidence: true` — `join()`
normalizes the `..` chain away, which is why the segment-lexical refusal
must fire BEFORE the join.

**Change 1 — `captureRefusal` (src/probe.ts) holds the parser's full
contract**: non-empty, `win32.isAbsolute` (drive-letter, rooted,
backslash, UNC), segment-lexical `..` over `/[\\/]/` — the parser's own
rules, vocabulary, and message shapes including the `(got …)` suffix
carrying the RAW value (missing renders `(got undefined)` on both
sides; the raw value, not a normalized `''`, reaches the class refusal).
Refusal fires before the capture command runs.

**Change 2 — the VALIDATE branch, chosen by the read**: neither
evidence-path id is provably engine-generated at the module boundary —
`candidateId` is the operator-supplied `--jobs` job id in-pipeline
(charset-checked one layer up by parseJobsSpec for spec-driven runs
only; engine-generated `c01..cNN` in default mode, where no probes
run), and `probeId` is the operator-supplied `ScenarioSpec.id` (same
one-layer-up check). `SPEC_ID_PATTERN` is imported from
`src/scheduler.ts` (never re-declared; scheduler's probe import is
type-only, so no runtime cycle) and enforced by `requireEvidenceSafeId`
before any id reaches `join()`: `probeEvidenceDir` (the run-folder
segment) and `evidenceBundlePath` + `probeArtifactName` (every evidence
file name — `.json`/`.log`/`.png`/`.results.json`/`.response.json`; all
five artifact writers route through them). A refusal is a thrown Error —
the runner's failedBundle path records it inside `run()`, the
evidence-write path logs and skips at `writeEvidenceBundle`; nothing is
ever written outside the artifacts dir. Docblocks updated to claim
exactly what the code holds (module docblock's class-boundary-contracts
bullet, `ScenarioSpec.id`, `EnvironmentSpec.candidateId`,
`probeEvidenceDir`/`evidenceBundlePath`/`writeEvidenceBundle`,
ScreenshotProbe's capture bullet).

**Gate numbers measured**: Gate 0 typecheck exit 0; new Gate 1.49
(`scripts/check-probe-boundary.mjs`, wired into `scripts/verify.mjs`)
ALL GREEN, 67 assertions — class-boundary refusals with the parser's
vocabulary + before-the-command-runs + the two red faces by name;
parse-side non-divergence (parse message = where-prefix + class rule,
for all 11 refusal inputs) + the valid-capture parse control;
evidence-id faces (helpers, `writeEvidenceBundle`, a bad-candidateId
environment, pipeline-shape acceptance, happy-path control). Gate 1.15
ALL GREEN unchanged — all 124 assertions, no flip, no extension
(parse-side byte-untouched; the class-side empty-refusal message keeps
the old text as a strict prefix). Full fast tier `node scripts/verify.mjs
fast`: **ALL GREEN** (run twice; both runs green).

**Gate 2 not owed — trigger analysis**: probe internals only; no report
shape change (no `CandidateReport`/`ProbeRunSummary`/`EvidenceBundle`
field touched), no runner/adapter/gate/workspace byte touched
(`src/runner.ts` unchanged — its `job.id` was always parse-validated),
and the in-pipeline spec path is byte-identical. Gate 3 n/a.

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
