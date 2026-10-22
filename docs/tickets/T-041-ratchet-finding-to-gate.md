# T-041 — The ratchet: finding→gate promotion, human-owned, across runs — the convention + one cross-run fixture proof (spec §32)

**Status:** done 2026-10-21
**Category:** verification
**Value (1-5):** 3 · **Risk (1-5):** 1
**Depends on:** T-039 (proposed — needs a real verifier finding to promote; the documentation half can start before T-039 lands). T-038/T-040 are composition notes, not dependencies.

## What

The durable half of the verifier lane: the documented path by which a model-found finding becomes a **permanent, mechanical gate** — and one end-to-end proof that the path works, on the demo fixture, across two runs.

1. **The convention, documented (AGENTS.md cross-cutting rule + VERIFICATION.md section).** A verifier finding (or any real failure) becomes a gate **only** via a ticket-owned, human-promoted change to the project's gate set or fixture suite. The rules, each traceable to an existing locked position:
   - **Never auto-promoted.** No engine code reads a verifier block and edits a gate string, fixture, or spec — the promotion is a human change-set (AGENTS.md #6's change-set discipline is the vehicle).
   - **Never in the run that produced the finding.** A model-authored check does not decide survival in the same run that authored it — that would be the model judging with extra steps, and it is unrepeatable and gameable by construction (the boundary decisions.md records with T-039). The ratchet crosses runs: finding in run N → promotion change-set → gate in run N+1.
   - **The promotion artifact is the ticket.** Its change-set carries: the finding cited (run id, candidate, observation), the reproduction, the new gate command or fixture test, and the re-run that eliminates on it. From then on the check is `gate X, command Y, exit Z` — mechanically reproducible forever (T-027's photograph property, exercised cross-run).
2. **The proof, end to end on the demo fixture.** Take a real finding from a T-039-era verifier run against the demo target (whose known weak-spot classes are already mapped — the `add()` mixed-type/overflow class, scripts/demo-target.mjs:15-35, the T-032 fixture precedent), promote it — extend the fixture's test suite or the demo gate string — and re-run:
   - **Red bar (pre-promotion):** a candidate that breaks the promoted check but passes the *old* gates **survives** run N — recorded first (AGENTS.md #8).
   - **Green bar (post-promotion):** the same class of candidate is **eliminated** in run N+1 on the promoted gate, and the report's elimination row cites the gate name, command, and exit code.
   - Both runs' artifacts referenced by path (`C:\swarm\...`), per the honesty convention (decisions.md, T-033's entry — cite artifacts, never unrun checks).

**Does NOT claim / carved:** any engine code (zero `src/` changes — this ticket is documentation + fixture + gates); auto-promotion, finding-taxonomy scoring, or promotion thresholds; Codex/Sol as the promoting reviewer (the human is the promoter this slice; §10.2/§10.6's advisory review of promotions is future vocabulary); extending the demo fixture beyond the promoted check; making the convention retroactive over pre-ratchet findings.

## Why

T-039 gives the swarm a pressure-tester; T-040 lets findings steer retries. But neither gives findings **permanent teeth** — the property that makes model-sourced knowledge compound instead of evaporating with each run's report. Spec §32 names the mechanism ("finding → reproduction → machine probe or test → regression artifact → project quality suite") and its purpose ("Inference should leave the repository harder to break than it was before", §32:1971): every real failure the swarm discovers should convert into a check that fires forever after, so the system's error rate ratchets down across runs rather than oscillating.

The boundary — human-owned promotion, never same-run — is not friction to engineer away later; it is the load-bearing wall. It is what keeps every elimination in every report reproducible as a command and an exit code even as the volume of model-generated code scales, and it is the reason this ticket is Risk 1 despite sitting at the center of the plan's most sensitive principle: it *strengthens* the locked decision by adding machine checks, and its only model-facing act is bounded to proposing.

Deliberately small: mostly documentation plus one fixture proof. It is the kind of ticket that should exist early precisely because it is cheap — the convention needs to be in force before the first operator is tempted to shortcut it.

## Acceptance criteria

- [x] The convention is documented in AGENTS.md (a cross-cutting rule: findings promote via tickets, human-owned, never same-run, never auto-promoted) and in VERIFICATION.md's ratchet section, citing T-039's decisions entry — pinned by the change-set contents and the fast tier riding green.
- [x] A real T-039-era finding is cited (run id, candidate, observation, artifact path) in the promotion ticket — pinned by the change-set contents; a finding that cannot be reproduced is recorded as not-promoted, never promoted on trust (AGENTS.md #9).
- [x] **Red bar recorded first**: pre-promotion, a candidate breaking the promoted check passes the old gates and survives — its run's `report.json` recorded as the red evidence.
- [x] Post-promotion, the same class of candidate is eliminated on the promoted gate, and the elimination evidence cites `gate name + command + exitCode` (the T-027 property, cross-run) — pinned by the recorded `report.json` paths of both runs, referenced from VERIFICATION.md.
- [x] Gate 1 (fixture regeneration + baseline) stays green with the promoted check in place — the fixture's baseline still passes its own gates (AGENTS.md #7's NO-OP rule applies to the fixture too).
- [x] VERIFICATION.md extended in the same change-set (AGENTS.md #6): the ratchet section (convention, the two runs' evidence, the promotion ticket reference) — pinned by the full fast tier ALL GREEN.
- [x] **Gate 2 not owed** (no `src/` change, no adapter, no report shape — nothing on the trigger list); recorded per the trigger-analysis precedent (T-018:223-228). **Gate 3 n/a.**

## Landed

2026-10-21. Lane `ticket/T-041-ratchet-finding-to-gate` off main 2bcfe3c.

**What changed**

- `AGENTS.md` — ground rule **#11** (the convention, cross-cutting): findings
  promote via tickets, human-owned, never same-run, never auto-promoted; the
  ratchet crosses runs. Rules #1-#10 keep their numbers (existing citations
  unaffected).
- `VERIFICATION.md` — the **ratchet section** (the convention, citing the
  decisions.md 2026-10-21 T-039 entry; the finding; both recorded runs; the
  honesty notes) + the **Gate 1.26** section (the fast-tier check).
- `scripts/demo-target.mjs` — **the promotion**: `calc.js` gains `clamp` WITH
  the `lo > hi` guard (inverted bounds throw `RangeError`), `test.js` gains the
  promoted inverted-bounds assertions
  (`assert.throws(() => clamp(5, 10, 0), RangeError)` and
  `clamp(0, -5, -10)`) plus the happy-path clamp assertions from the
  T-039-era brief (5,0,10 / -1,0,10 / 11,0,10); the fixture's baseline commit
  message updated. Human-authored, ticket-carried — the ratchet's vehicle.
- `scripts/fixtures/t041-finding-diff.patch` (new) — the finding's own diff,
  vendored byte-identical from run `20261021225243` candidate c01
  (sha256 `9570099f…`, 725 bytes = the report's `diffBytes`).
- `scripts/fixtures/t041-worker-red.mjs` / `t041-worker-green.mjs` (new) — the
  proof drives' machine workers: apply the vendored finding verbatim / strip
  the promoted guard (both refuse a no-op; the green one is line-ending aware).
- `scripts/check-ratchet.mjs` (new) — **Gate 1.26**, 21 token-free assertions
  wired into `scripts/verify.mjs`'s fast tier after Gate 1.25 (1.24 stays
  reserved for the T-038 lane — the T-039 deviation-1 precedent).

**The finding (real, model-authored, cited)**

Run `20261021225243` (T-039's Gate 2 record,
`C:\swarm\20261021225243\report.json`), candidate c01, verifier `concern`:
"Inverted bounds are silently accepted: clamp(5,10,0) returns 0 instead of
erroring or normalizing; there is no lo<=hi guard in calc.js:6. Brief did not
require validation, but callers who swap lo/hi get surprising results" —
evidence cited in the observation (`swap_lo_hi 0`; calc.js line 6). T-039
landed before this ticket started (done 2026-10-21), so the dependency is met.

**The two runs (this ticket's substance), red first per AGENTS #8**

- **RED, pre-promotion (run N): `C:\swarm\20261021234438\report.json`.** The
  pre-promotion fixture regenerated (base `cfc196717a2f`, no clamp anywhere),
  then a REAL CLI run — `npm run skeleton -- --repo C:\swarm\demo-target
  --jobs <red spec> --no-review`, the job's `worker: "machine"` applying the
  vendored finding verbatim: build PASS + test PASS (exit 0 both) ⇒
  `passedAllGates` true, diff 725 bytes (the finding's own diff — never a
  NO-OP). The class the finding describes survives the old gates. Worktree
  disposed via `npm run clean -- --run 20261021234438 --force`; evidence kept.
- **The promotion** (above), committed before run N+1 executed.
- **GREEN, post-promotion (run N+1): `C:\swarm\20261021234632\report.json`.**
  The promoted fixture regenerated (base `c1274b90d41b`, baseline green — the
  finding's diff no longer applies to it), then the same-class drive (the
  guard stripped): build PASS, **test FAIL exitCode 1** ⇒ `passedAllGates`
  false, no error — eliminated, the gate row citing name `test`, command
  `node test.js`, exitCode 1, the tail naming the promoted assertion
  (`Missing expected exception (RangeError)`), diff 450 bytes = exactly the
  guard stripped. Worktree disposed via `npm run clean -- --run
  20261021234632 --force`; evidence kept.

**Honesty notes (AGENTS #9).** Both proof candidates are machine-worker
replays of the finding's class — token-free, through the real pipeline entry
(the T-017 `worker: "machine"` end-to-end); the reports record the model
string verbatim for candidates no model touched (the documented MachineWorker
posture). The model-authored part of the chain is the finding itself; the
promoted check is this human change-set. A botched first green drive (run
`20261021234545` — the worker hit CRLF worktree endings, refused a no-op with
exit 1, WORKER FAILED) is left in the run root uncited; the fixed worker is
line-ending aware. The recorded runs' jobs specs carried lane-absolute worker
paths (documented here, recorded in each `worker.log`); the committed Gate
1.26 regenerates equivalent specs from committed content, so the proof does
not depend on this lane's paths.

**Gate numbers measured this change-set**

- Gate 1.26 standalone (`node node_modules/tsx/dist/cli.mjs
  scripts/check-ratchet.mjs`): ALL GREEN, 21 `ok:` assertions.
- Full fast tier (`node scripts/verify.mjs fast`): ALL GREEN — Gate 0 green;
  Gate 1 green with the promoted check in the fixture (AC #5); Gates
  0.5/1.5/1.6-1.23/1.25 green; Gate 1.26 riding in-tier.
- **Gate 2 not owed** — trigger analysis per the T-018:223-228 precedent: no
  `src/` change, no adapter, no report shape, no scheduler/store/dashboard
  surface; the change-set is documentation + fixture + gate scripts.
  **Gate 3 n/a** (no adapter touched).

**Deviations**

1. Gate number **1.26** (the ticket names none): 1.24 is claimed by the
   in-flight T-038 lane, 1.25 is T-039 — next free, recorded in verify.mjs.
2. The promoted contract picks **throw-on-inverted-bounds** (`RangeError`)
   from the finding's "erroring or normalizing" alternatives — the human
   choice this promotion change-set owns.
3. The happy-path clamp assertions ride with the promoted ones (the
   T-039-era brief's three assertions verbatim) — the promoted check's suite
   pins the function's contract, not just its new guard; nothing else in the
   fixture was touched (the carve holds: no extension beyond the promoted
   check).
4. The proof runs are token-free machine-worker drives, not model runs — the
   ticket never demands model runs for them and AC #7 records Gate 2 not
   owed; the finding itself IS model-authored, and the red candidate is the
   finding's own diff. Stated here rather than implied.

## Verification

Gate 0 throughout (if any script changes). Gate 1 re-run green with the promoted check in the fixture. Full fast tier ALL GREEN. **Gate 2 not owed** (trigger analysis recorded); **Gate 3 n/a**. The two real runs (red pre-promotion, green post-promotion) are this ticket's substance — their artifact paths are the evidence, recorded in VERIFICATION.md.

## References

docs/spec/inference-refinery-v2.md §32:1939-1971 (the Quality Ratchet — this ticket's spec home; the promotion flow :1941-1953; the ratchet purpose :1971), §9.2 (observations inform), §24 Phase 5 (:1466-1484 — evaluators as the finding source at swarm scale) · docs/decisions.md:19-22 (gates decide survival — the wall this ticket reinforces), the T-039 entry (the never-same-run boundary, landed with T-039) · docs/tickets/T-027 (the recorded-command property, cross-run), T-032 (the demo-fixture weak-spot precedent, scripts/demo-target.mjs:15-35), T-033 (the honesty convention for citing run artifacts), T-039 (the finding producer) · scripts/demo-target.mjs:15-35 · VERIFICATION.md (Gate 1, the trigger-analysis precedent at the T-018 citation).
