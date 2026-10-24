# T-045 — Gate/diff overlap evidence: flag when a candidate diff touches files its gate commands execute

**Status:** done (landed 2026-10-23)
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 1
**Depends on:** —

## What

Gates are shell commands evaluated in the candidate worktree
(`src/gate/command.ts:38-40`) — for the canonical demo that is
`node build.js` / `node test.js`, files the worker can edit. A worker that
weakens the test script (deletes an assertion, wraps the suite in
try/catch) plus adds a trivial comment elsewhere produces a non-zero diff
that passes every gate. The tampering IS visible in the captured diff
(tracked files — verified 2026-10-23), but nothing machine-flags it: the
reviewer is advisory, the T-032 probe is evidence-only, the ratchet is
human-owned cross-run — and `integrate` then re-runs the SAME recorded gate
command on a replay tree that CONTAINS the tampering, faithfully
re-verifying the weakened evaluator. Spec §35 asks "Were evaluator jobs
prevented from modifying contestants?" — the live question is the inverse,
and today nothing even records it.

The change — a deterministic, evidence-only overlap signal (the
`cleanupFailures` pattern: produced beside the ladder, never read by it):

1. **Compute** — after the final attempt's diff capture, intersect the
   diff's changed paths (re-derive `git diff <base> --name-only` in the
   lease; rides T-044's semantics) with the path-shaped tokens of each
   gate's recorded command (`GateResult.command`, T-027 — split on
   whitespace and shell separators; keep tokens that resolve to files in
   the worktree or match changed paths; `npm test`/`make` style commands
   with no path tokens yield no overlap by construction).
2. **Record** — an additive, producer-only `CandidateReport` block, e.g.
   `gateCommandOverlap?: { gate: string; touched: string[] }[]`, present
   only when at least one gate overlaps; a loud console line at the gate
   step (`gate test: PASS — NOTE: diff touches files this gate executes:
   test.js`); the run summary line carries the marker.
3. **Surface at replay** — `integrate` reads the report and, when the
   candidate carries the block, prints + records it in the verdict JSON
   (the replay is exercising evaluator files the candidate changed — the
   operator should see that sentence before trusting a replay PASS).

Non-goals: transitive-load analysis (`node build.js` can `require`
anything — the flag is a heuristic and is documented as one); pristine-copy
gate execution (a design decision, not this slice); ANY verdict effect (no
ladder line reads the block — no decisions.md change needed).

## Why

"Gates decide survival" is sound only while the gates measure something the
candidate cannot have rewritten. This does not solve evaluator tampering —
it converts the cheapest version of it from invisible to recorded, using
machinery that already exists (recorded commands from T-027, changed paths
from the captured diff). It is the ratchet-friendly shape: today a human
reading report.json sees the flag; the day a promoted fixture check or a
stronger mechanism lands, the signal was already there, honestly named a
heuristic.

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free scratch-repo
      check: a lease whose diff modifies `test.js` while gate
      `test=node test.js` passes — today's report carries no trace; the
      check asserts the absence on main as the red bar.
- [ ] Green: the same scenario post-change — the report block names the
      gate and the touched path, the console line prints, the summary line
      carries the marker — pinned by the same check.
- [ ] Clean-negative: a diff touching only non-gate files produces NO
      block and byte-identical report shape to today (the optional-field
      producer-only pattern) — pinned by the same check.
- [ ] Verdict inertness pinned: a candidate with overlap still
      passes/fails exactly by its gates — the check asserts `passedAllGates`
      is unchanged by the block's presence.
- [ ] Integrate surfacing: a replay of an overlap-carrying survivor prints
      the note and records it in `<id>.json`; exit code still
      gate-determined — pinned by the check's replay leg.
- [ ] Multi-token commands: a gate like `lint=npx eslint src/` with a diff
      touching `src/a.js` flags; `build=npm run build` (no path tokens)
      never flags — pinned by the same check.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6), naming
      the heuristic's limits (transitive loads invisible) — pinned by the
      full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (report shape + runner/src change); trigger analysis
      recorded at landing. **Gate 3 n/a**.

## Landed

Landed 2026-10-23, lane `ticket/T-045-gate-diff-overlap-flag`.

**Code** — exactly the three changes the ticket names, no ride-alongs:

- `src/gate/overlap.ts` (new) — the deterministic computation:
  `commandTokens` (split on whitespace + the shell command separators
  `& ; | ( )`, strip one wrapping quote pair), `overlapTouched` (a token
  is path-shaped when it resolves to a file/directory in the worktree —
  absolute tokens inside the worktree fold to repo-relative — or exactly
  matches a changed path, the clause that keeps diff-DELETED files
  visible; a path-shaped token overlaps on equality or directory
  prefix), and `computeGateCommandOverlap` (one `{gate, touched}` entry
  per overlapping gate, in gate order; gates without a recorded command
  never overlap). Matching is Windows-forward (backslashes folded,
  case-insensitive — the normPath posture). Redirect operators are
  deliberately not separators: a glued `>out.txt` token drops out.
- `src/runner.ts` — after the final attempt's ladder line, gated on the
  diff having been captured: `computeGateCommandOverlap(attemptGates,
  opts.workspaces.changedPaths(lease), lease.path)`; when non-empty, the
  block lands on the candidate report and one loud NOTE line prints per
  overlapping gate (`[c01] gate test: PASS — NOTE: diff touches files
  this gate executes: test.js`, verdict-embedded, printed regardless of
  the gate's PASS/FAIL). A computation failure logs loudly and records
  nothing (the probes/verifier posture). No ladder line reads the block.
- `src/integrate.ts` — when the candidate carries the block, the replay
  prints the note BEFORE any gate output and records the block verbatim
  in the verdict JSON (`IntegrateVerdict.gateCommandOverlap`, on both
  verdict write paths); the exit code stays gate-determined.
- Plumbing: `src/types.ts` — `GateCommandOverlap` +
  `CandidateReport.gateCommandOverlap?` (producer-only: absent when
  nothing overlaps, so clean reports keep the exact pre-T-045 key set)
  and the `WorkspaceProvider.changedPaths` seam method;
  `src/workspace/worktree.ts` — `changedPaths` = `git diff <baseSha>
  --name-only -z` in the lease (T-044's pinned-base semantics, called
  after `diff()` so the intent-to-add posture matches); `src/cli.ts` —
  the RUN SUMMARY marker (`  gate-overlap:test(test.js)`).

**Checks** — new `scripts/check-gate-overlap.mjs` (Gate 1.32, 35
assertions, wired into `scripts/verify.mjs` fast tier): O1 the tampering
core (real CommandGates, real execution: weakened test.js passes every
gate, block + NOTE line + verdict unchanged) · O2 clean-negative (no
block, no note, pre-T-045 key set, no `gateCommandOverlap` bytes in the
serialized report) · O3 verdict inertness fail-direction (overlap on a
passing AND a failing gate, verdict FAIL by gates alone, NOTE prints for
both) · O4 multi-token (`npx eslint src/` directory-prefix flags,
`npm run build` never flags, `node gone.js` flags a deleted file, the
`changedPaths` seam pinned directly) · O5 the real CLI (machine worker,
`--jobs`: gate-step NOTE + RUN SUMMARY marker on stdout, block in
on-disk report.json, exit 0) · O6 integrate surfacing (overlap survivor
replay exit 0 + note + block in `<id>.json`; failing-gate replay exit 1
with note + block still recorded; clean survivor replay: no note, no
block key).

**Red bar (AGENTS #8), recorded before any engine change** — the lane at
main (33db211) running the landed check: 16 failures of 35, exit 1,
exactly the new-behavior faces (O1 ×3, O3 ×2, O4 ×4, O5 ×3, O6 ×4); the
19 green faces pin preserved semantics (verdict machinery, clean-negative
shape, gate-determined exits), and the ticket's premise was confirmed
empirically at main: the weakened evaluator passed every gate and the
tampering was visible in the captured diff with no machine trace. Green
post-change: 35/35, exit 0.

**Gates measured:** Gate 0 typecheck exit 0 · `node node_modules/tsx/dist/cli.mjs
scripts/check-gate-overlap.mjs` ALL GREEN (Gate 1.32) · full fast tier
`node scripts/verify.mjs fast` — `=== verify (fast) complete: ALL GREEN ===`,
exit 0 (Gate 0+1+0.5+1.5…1.32). **Gate 2 owed** (src/runner.ts +
report shape + src/cli.ts + src/integrate.ts + src/workspace/worktree.ts
changed — trigger list, Gate 2's section; the real e2e run rides the
computation on every candidate's final attempt, expected block-free for
source-only candidates, so the run's shape is unchanged — trigger
analysis in VERIFICATION.md Gate 1.32). **Gate 3 n/a** (no adapter
change). One existing check edited, strengthened not weakened:
`scripts/check-per-role-harness.mjs` (Gate 1.21) S3 — its real-CLI drive
is a TRUE overlap positive (the gate command
`node -e "require('fs').accessSync('marker-a.txt')"` names the very file
the worker's machine command changes), so the candidate legitimately
carries the block; the expected key set gains exactly the ticketed
`gateCommandOverlap` producer (the assertion's T-025 intent — no
adapter-id fields — unchanged), and a NEW assertion pins the block as
the true positive it is. Every other existing assertion unchanged and
green.

## Verification

New fast-tier check (next free gate number at landing): overlap red bar,
clean-negative, verdict inertness, integrate surfacing, multi-token cases.
Gate 0, full fast tier ALL GREEN; Gate 2 owed and recorded.

## References

src/gate/command.ts:30-40 (exec in the worktree) · src/types.ts:121-144
(`GateResult.command`, T-027 — the input this reads) · src/runner.ts:1030-1090
(diff capture then gate loop — the insertion point) · src/integrate.ts:147-169
(recorded-command contract — where the note surfaces) ·
docs/spec/inference-refinery-v2.md §35 (the acceptance question this
inverts) · docs/tickets/T-027 (recorded commands), T-032 (probe evidence
posture), T-041 (the ratchet this feeds) · 2026-10-23 adversarial review
finding F4.
