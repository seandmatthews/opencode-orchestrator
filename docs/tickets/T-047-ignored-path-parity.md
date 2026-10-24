# T-047 — Ignored-path parity evidence: ignored-tree snapshot per attempt + integrate parity note

**Status:** done 2026-10-23
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 1
**Depends on:** T-044 (the snapshot rides the same diff-vs-baseSha capture point; land after or with it)

## What

`WorktreeProvider.diff` respects `.gitignore` — verified 2026-10-23 in a
scratch worktree: a file written under `node_modules/`, `dist/`, or any
ignored path appears in NEITHER the captured `diff.patch` (the `git add -A
--intent-to-add .` + `git diff` capture never sees it) NOR `git status`.
Meanwhile the gates execute in the live worktree where those files DO
exist. Two consequences the engine currently records nothing about:

- A worker (or derailing cheap model) can make gates pass via changes in
  ignored paths — the promoted diff contains none of it; the run's survivor
  and the replayed artifact measure different trees.
- Legitimately: any gate that installs dependencies (`npm install`-style)
  creates a large ignored tree per worktree, so RUN gates and REPLAY gates
  (a fresh worktree holding only HEAD + diff.patch) execute in
  systematically different environments — and the replay's failure, when it
  comes, is recorded as an ordinary gate FAIL, indistinguishable from a bad
  candidate.

The change — the mechanical first slice: make the asymmetry VISIBLE.

1. **Snapshot** — on the final attempt, after the gate loop (so
   gate-installed trees are included — they are the parity-relevant set),
   run `git status --porcelain --ignored` in the lease and write it to the
   attempt's evidence dir as `ignored-paths.txt`. Record a bounded summary
   on the report (additive, producer-only): `ignoredPaths?: { count: number;
   entries: string[] }` with entries capped at a documented constant (the
   `MAX_RETRY_FINDINGS` pattern, e.g. 50 lines of the porcelain `!!` set).
2. **Integrate note** — when replaying a candidate whose report carries a
   non-empty ignored-path summary, `integrate` prints and records in the
   verdict JSON a parity note: "the run environment held ignored trees the
   replay tree lacks: node_modules/, … — gate parity is not established."
   Exit code stays gate-determined (evidence, never a verdict — no
   decisions.md change).

Explicitly non-goal (carved, needs a decision, not a slice): dependency
provisioning for worktrees (spec §13's manifest — a real design decision
with cost/supply-chain tradeoffs); pristine gate environments; tamper
DETECTION for ignored paths (mtimes/hashes — a future discipline if the
threat becomes live). This ticket only stops the asymmetry from being
invisible.

## Why

Ignored-path blindness is the closest thing to a canonical gate-gaming
primitive in the current design — the cheapest way to make gates lie is to
change what they execute somewhere diff capture cannot see. Full prevention
is a design project; visibility is ~40 lines and converts both the attack
surface and the mundane dependency-reality into recorded evidence a human
(actually) reads. It also gives the dependency question its data: once runs
record what ignored trees their gates needed, the §13 manifest decision has
measurements instead of guesses.

## Acceptance criteria

- [x] **Red bar recorded first** (AGENTS #8), token-free scratch-repo
      check (the 2026-10-23 repro, re-run): a lease whose worker wrote into
      an ignored dir — today's report carries no trace of it; the check
      asserts the absence on main as the red bar.
- [x] Green: the same scenario post-change — `ignored-paths.txt` exists in
      the attempt evidence dir, and the report summary names the ignored
      entry with its count — pinned by the same check.
- [x] Cap pin: a fixture producing more ignored entries than the constant
      records exactly the constant's count and the cap is documented
      (exported for the gate, the `MAX_RETRY_FINDINGS` pattern) — pinned by
      the same check.
- [x] Clean-negative: a run with no ignored files produces NO block and a
      byte-identical report shape to today — pinned by the same check.
- [x] Integrate note: replaying a candidate with a non-empty summary
      prints the parity note and records it in `<id>.json`; exit code
      unchanged by the note (a passing replay still exits 0) — pinned by
      the check's replay leg.
- [x] Verdict inertness pinned: the snapshot and summary never enter any
      ladder expression (the check asserts `passedAllGates` is unaffected
      by ignored-path presence).
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6), stating
      the carve (visibility, not provisioning/detection) — pinned by the
      full fast tier ALL GREEN.
- [x] **Gate 2 owed** (report shape + runner/src change); trigger analysis
      recorded at landing. **Gate 3 n/a**.

## Landed

2026-10-23, Gate 1.33 (`scripts/check-ignored-paths.mjs`, wired into
`scripts/verify.mjs` fast tier).

- `WorkspaceProvider.ignoredStatus` seam (`src/types.ts`, implemented in
  `src/workspace/worktree.ts`): the lease's raw `git status --porcelain
  --ignored` output — ignored directories collapse to one `!! dir/` line
  (default untracked mode).
- `src/runner.ts`: `MAX_IGNORED_PATHS = 50` exported (the
  MAX_RETRY_FINDINGS pattern); after the final attempt's gate loop — so
  gate-installed trees are included, the parity-relevant set — the
  porcelain snapshot is written to the attempt's evidence dir as
  `ignored-paths.txt`, recorded among the attempt's `outputArtifacts`
  (the diff.patch precedent), and summarized as the additive,
  producer-only `CandidateReport.ignoredPaths {count, entries}`
  (`IgnoredPathsSummary`, `src/types.ts`): count = the full pre-cap
  `!!` total, entries = the first 50 in porcelain order. Producer-only:
  an empty `!!` set writes nothing and the report shape is
  byte-identical to pre-T-047. A loud console line; a snapshot failure
  logs and records nothing (never breaks a run).
- `src/integrate.ts`: replaying a candidate with a non-empty summary
  prints, before any gate output, "the run environment held ignored
  trees the replay tree lacks: node_modules/, … — gate parity is not
  established" (the "+N more" remainder when capped) and records the
  summary verbatim in the verdict JSON (`IntegrateVerdict.ignoredPaths`,
  both verdict write paths). Exit code stays gate-determined.
- Verdict inertness: the block is produced after the ladder line and no
  ladder expression reads it — pinned behaviorally in both directions
  (pass and fail) by Gate 1.33 legs I1/I4/I5.

Gates measured: red bar at the lane on main (ce0d65f, engine untouched)
running the landed check — 20 failures of 41, exit 1 (exactly the
new-behavior faces; the 21 green faces are the preserved semantics);
post-change `node node_modules/tsx/dist/cli.mjs
scripts/check-ignored-paths.mjs` — 41/41 green, exit 0; Gate 0
(`npm run typecheck`) exit 0; full fast tier (`node scripts/verify.mjs`
fast`) ALL GREEN. **Gate 2 — run by the driving script (run
20261024021432): 1 failing assertion, the Known issue #6 worker-no-op
class, not this change-set** — `c02-r2: diff non-empty (0 bytes)`: the
worker mis-transcribed its OWN lease path (`wt/c02-r2` → `wt/c02/r2`,
hyphen as separator), hit the `external_directory` auto-reject (the
containment working), and gave up with zero edits — exit 0 in 11s; the
ladder eliminated it as a NO-OP exactly per AGENTS #7 (`diffPath` set,
`diffBytes` 0 — a genuine no-op, never a capture failure), round 2
still executed with sibling c01-r2 surviving, and every other
assertion on the run was green (recorded as that entry's 2026-10-24
observation). T-047's own real-run surface on the same run: NO
candidate carried an `ignoredPaths` block — the fixture leases held no
ignored trees, the producer-only absence Gate 1.33 predicted, confirmed
on a real run. Disposition per the class precedent (T-038/T-040/T-043
lanes): documented in VERIFICATION.md Known issue #6, no assertion
weakened, no code change — the remedy is a re-run. **Gate 3 n/a** (no
adapter change). No ride-alongs: no CLI summary marker (the ticket
names the integrate note only), no store schema change (the store
ingests verdicts only), no decisions.md change.

## Verification

Gate 1.33 (`scripts/check-ignored-paths.mjs`, fast tier): ignored-write
red bar, snapshot green, gate-installed placement, cap, clean-negative,
integrate note, verdict inertness. Gate 0, full fast tier ALL GREEN;
Gate 2 run by the driving script — 1 failing assertion of the Known
issue #6 worker-no-op class (documented there, not this change-set; see
Landed), this change-set's real-run surface confirmed (no block on any
candidate); Gate 3 n/a.

## References

src/workspace/worktree.ts:76-85 (the capture seam and its .gitignore
blindness — verified 2026-10-23) · src/runner.ts:1076-1090 (the gate loop
the snapshot follows) · src/integrate.ts:296-351 (the replay the note
rides) · docs/spec/inference-refinery-v2.md §13 (the manifest decision this
feeds data to), §16.2 (disposable directories) · docs/tickets/T-026
(capture semantics this extends), T-044 (the shared capture point) ·
2026-10-23 adversarial review finding F2 (with the recorded scratch-repo
repro).
