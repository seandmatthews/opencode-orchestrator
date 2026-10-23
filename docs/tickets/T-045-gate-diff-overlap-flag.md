# T-045 — Gate/diff overlap evidence: flag when a candidate diff touches files its gate commands execute

**Status:** proposed
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
