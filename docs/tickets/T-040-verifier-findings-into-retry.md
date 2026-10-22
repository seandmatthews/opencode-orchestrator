# T-040 — Verifier findings ride the retry brief: the T-038/T-039 composition seam (spec §24:1462 + §9.2; joins the two proposed lanes)

**Status:** done 2026-10-22
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** T-038 (proposed — the `--gate-retry` composition seam and the `gateRetry` report block) and T-039 (proposed — the verifier role and its observations schema). Neither lane depends on the other; this ticket is their join.

## What

Extends T-038's feedback-brief composition with a verifier-findings section, and adds the verifier's **second call site**: a gate-failed, retry-eligible attempt is verified **before** the retry brief is composed, so attempt 2 is told both what the machines rejected and what an active verifier found — "the gates failed with these outputs, and the verifier found these issues; fix both; the gates re-run unchanged."

1. **The pre-retry call site.** In the retryable-leg branch of `runJob` (T-038's new code, beside the T-015 posture of src/runner.ts:813-819): after the gates fail and *before* composition, run the verifier (T-039's role, same posture, same schema) against the failing attempt's lease. Bounded by construction: with the gate-retry bound fixed at one, a candidate is verified at most twice — once pre-retry, once on its final attempt per T-039.
2. **The composition extension.** The feedback brief (T-038's mechanical string assembly — still **no model call composes it**) gains a findings section after the gates section: `blocker-advisory` and `concern` observations, each as `finding` + `evidence`, char-capped by a documented constant (the `MAX_DIFF_CHARS` precedent, src/runner.ts:416) and top-N bounded by a documented constant — a flood of findings must not drown the gate output, which stays the primary payload. Findings arrive from the parsed, schema-valid verifier output only; a verifier parse failure on the pre-retry leg composes a gates-only brief and records the degradation — **the retry still fires** (verifier absence never blocks the mechanical retry).
3. **Provenance.** The `gateRetry` block (T-038) gains `findings: { count, included }` beside the existing fingerprint; the fingerprint continues to hash the full composed text, so it covers the findings section by construction (T-030's `packetFingerprint` pattern, src/types.ts:386-409). The composed brief file in the attempt evidence dir is the durable copy of exactly what attempt 2 was told.
4. **The discipline stays where T-038 put it.** Findings shape what the retry *tries*; the re-run gates decide what *survives*. This ticket adds zero new verdict inputs — the pinning check is T-038's immunity assertion re-run with findings present, which is the adversarial version of it.

**Does NOT claim / carved:** findings changing retry *eligibility* (a candidate with zero findings retries exactly as one with six — eligibility stays T-038's leg definition); findings in the round-2 planner packet (T-030's composer renders probe summaries, src/rounds.ts:126-131; verifier summaries there is a composer extension = a successor's report-shape change with its own Gate 2); severity thresholds or top-N as CLI config (documented constants this slice); the final attempt's verifier being skipped when a pre-retry verification already ran (each leg verified per its own ticket — bounded at two, measured, revisited only with run-history evidence); review/`--jobs`-spec changes.

## Why

T-038's retry brief answers "what did the machines reject?" — but the gate outputTail is a diagnosis of the *check*, not of the *code*. The verifier's findings are the complementary diagnosis: an agent actually ran the thing and can say "it also breaks under X" with the command that proved it. Feeding both into attempt 2 is the difference between a worker that fixes the failing test and a worker that fixes the *defect* the failing test pointed at. This is the user-facing point of the whole verifier lane: pressure findings must reach the agent that can act on them *while acting is still possible* — before elimination, not after.

This ticket is also the cheapest possible consumer for T-039's output: without it, verifier findings wait for a human to read report.json (today's reviewer dead-end) or for T-041's cross-run promotion (a slower loop by design). With it, the advisory pipeline has an in-run consumer that never touches a verdict — the shape the spec draws in §9.2 (observations inform) and §24 Phase 4 (the bounded repair policy), with the survival decision unchanged.

## Acceptance criteria

- [x] The pre-retry verifier call site fires exactly when the T-038 leg is retry-eligible, before composition; a verifier parse failure on that leg composes a gates-only brief and the retry still fires — pinned by **Gate 1.27** (token-free fake-adapter drives; the ticket's "Gate 1.26" placeholder was written before T-041 took that number — 1.27 is the next free gate number at implementation, per this line's own clause).
- [x] The composed brief contains both sections — every failing gate's name/command/outputTail AND the included findings with their evidence — capped by the documented constants; the `gateRetry` block records `findings.count`/`included` and the fingerprint covers the full composed text — pinned by **Gate 1.27** (F1).
- [x] The zero-findings face: a verifier returning no observations composes a gates-only brief, retry unchanged from T-038's behavior — pinned by **Gate 1.27** (F3, plus the info-only eligibility filter).
- [x] **Verdict immunity with findings present**: a candidate whose pre-retry verification returned `blocker-advisory` findings survives iff the re-run gates pass, and is eliminated iff they fail — findings are never a verdict input even when they rode the retry brief — pinned by **Gate 1.27** (F1 survive face + F4 elimination face, the adversarial form of T-038's immunity leg).
- [x] Caps hold under flood: a fake verifier returning dozens of long findings produces a brief within the documented bounds, gates section intact — pinned by **Gate 1.27** (F5: 12 long findings ⇒ count 12, included 5, per-string caps, gates section intact).
- [x] VERIFICATION.md extended in the same change-set (AGENTS.md #6): the Gate 1.27 section; the T-038 (Gate 1.24) section updated to name the composition extension — pinned by the full fast tier `node scripts/verify.mjs fast` ALL GREEN (exit 0, this lane).
- [x] **Gate 2 owed**, decided and recorded at implementation: T-038/T-039 landed as their own change-sets (commits b15dfd1, f73f7e4), so this ticket IS its own change-set — Gate 2 is NOT merged away. The full tier's Gate 2 invocation now passes `--verifier-model zai-coding-plan/glm-5.3-flash` (this change-set), making the driving `npm run verify:full` run exactly the ticketed shape — a real `--goal --gate-retry --verifier-model` run end-to-end — with structural per-candidate verifier assertions added; the driving workflow runs it after this commit (the implementer does not spend the tokens; the division of labor is the driving script's). Whether the real run produces a genuine findings-riding conversion is read off the run's `gateRetry.findings` provenance and recorded by the driver either way (the T-038 posture: both outcomes are honest).

## Landed

2026-10-22, lane `ticket/T-040-verifier-findings-into-retry`. What actually changed:

- **src/runner.ts** — the pre-retry verifier call site in `runJob`'s T-038
  retry branch: after the machine gates reject the change and BEFORE
  composition, the retry-eligible leg is verified against its own failing
  lease — the same `runVerifier`, same 'worktree-read' posture, same
  observations schema, and the same failure context the T-039 final-attempt
  call gets (the gates that already ran with names/verdicts/recorded
  commands, the captured diff, the brief). Bounded by construction at two
  verifications per candidate (the gate-retry bound is one). The call is
  guarded: a parse failure after the bounded repair, OR the adapter
  throwing, composes a gates-only brief and the retry still fires (the leg
  stays `gates-failed`, never an error leg); the degradation is recorded in
  `gateRetry.findings.ok = false`. The pre-retry leg's verifier evidence is
  kept distinct from the final leg's (`verifier-pre-retry.log` /
  `verifier-pre-retry-raw.txt` in the failing attempt's evidence dir —
  `runVerifier`'s ctx gained an optional `evidenceTag`, absent on the
  T-039 call, whose paths are unchanged), so neither leg's raw output can
  overwrite the other's. `composeGateRetryBrief` gained the findings
  section, AFTER the gates section, rendered only when ≥ 1 eligible finding
  exists (zero ⇒ byte-identical T-038 gates-only composition): eligible =
  `blocker-advisory` + `concern` (`info` never rides), each as a
  FINDING(severity)/EVIDENCE pair, top-N bounded by the now-documented,
  exported constant `MAX_RETRY_FINDINGS = 5` (first-N in the verifier's own
  order) and per-string char-capped by `MAX_RETRY_FINDING_CHARS = 2_000`
  (the MAX_DIFF_CHARS precedent narrowed to a per-string cap so one huge
  evidence blob cannot crowd out the other findings); the gate output stays
  the primary payload. The returned fingerprint continues to hash the full
  composed text — findings included by construction. `gateRetry` gained
  `findings: {count, included, ok}`: count = eligible findings returned
  pre-cap; included = embedded post-caps; ok = parsed schema-valid verifier
  output existed at all. Retry eligibility untouched; no verdict line reads
  findings; dispatch.jsonl line shapes unchanged.
- **src/types.ts** — `GateRetryRecord.findings` (required on the block,
  doc-commented; the block only ever exists when the flag fired).
- **scripts/check-gate-retry-findings.mjs** — NEW, the pinning gate: see
  Gate 1.27 below (the ticket's "Gate 1.26" placeholder predates T-041
  taking that number; 1.27 is the next free number at implementation, per
  the criterion's own clause). F1 call site + both-sections brief +
  provenance + distinct leg evidence + immunity survive face; F2
  parse-failure degradation (gates-only brief, retry fires, honest
  `{0, 0, false}`, raw output persisted verbatim, fingerprint exact) and
  F2b verifier-crash degradation (same faces, the leg stays `gates-failed`);
  F3 zero-findings and info-only-eligibility faces (gates-only,
  `{0, 0, true}`); F4 the immunity elimination face (findings rode, gates
  failed again ⇒ eliminated, no error, no new vocabulary,
  `passedAllGates === (gates.length > 0 && gates.every(passed) && diffBytes
  > 0)`); F5 flood (12 long findings ⇒ count 12, included 5, first-N
  order, per-string caps, brief within the documented bound, gates section
  intact); F0 verifier absence (`{0, 0, false}`, T-038 behavior verbatim,
  no verifier evidence files).
  **Red bar (AGENTS.md #8), recorded BEFORE the engine change:** against
  the pre-change tree the check ran RED — 8 reported failures: 7 assertion
  failures (the exported-caps pin; the dispatch-order pin — no verifier
  entry between the gate loop and the retry worker; two verifier dispatches;
  the pre-retry prompt context; the findings section; the gateRetry exact
  shape — no `findings` key; findings-in-attempt-2's-prompt) plus the
  run-ending `ENOENT ... c01\verifier-pre-retry-raw.txt`. F2–F0's green is
  established on the post-change tree (the ENOENT aborted `main()` in the
  red run).
- **scripts/check-gate-retry.mjs** (Gate 1.24) — G1's exact-shape pin
  extended to the new 5-key block; its drive configures no verifier, so it
  pins the honest zero record `{count: 0, included: 0, ok: false}`. The
  T-031 flip precedent: net strictness increases — the four T-038 fields
  stay pinned exactly, the fifth is positively exercised by Gate 1.27. No
  other assertion in the gate touched; the whole check ALL GREEN.
- **scripts/verify.mjs** — fast tier: Gate 1.27 wired after Gate 1.26. Full
  tier: the Gate 2 invocation now passes `--verifier-model
  zai-coding-plan/glm-5.3-flash` (making the driving full-tier run the
  ticketed Gate 2 shape — see the recorded sequencing decision on the last
  acceptance criterion), with STRUCTURAL per-candidate assertions added
  (verifier block present with the model verbatim; honest ok flag —
  well-formed severity vocabulary when true, explicit false on a real-run
  parse degradation, itself an honest pass; raw output persisted on disk).
  No assertion weakened: every existing Gate 2 assertion is untouched and
  stays gate-decided.
- **VERIFICATION.md** — the Gate 1.27 section (constants, faces, red bar,
  carves, the Gate-2-owed analysis); the Gate 1.24 section's T-040 update
  note (the new block shape, the deliberate G1 pin extension, the
  store/recovery untouched note); the Gate 2 section documents the verifier
  leg and its structural assertions. All in this change-set (AGENTS.md #6).
- **docs/tickets/README.md** — the T-040 index row → done 2026-10-22 (this
  change).

Deviations from the ticket text, owned:

- **Gate number:** the criteria said Gate 1.26; T-041 took it. Landed as
  **Gate 1.27** (the criteria's own "next free gate number at
  implementation" clause).
- **`findings` is `{count, included, ok}`**, not the ticket's literal
  `{count, included}`: the third field is the ticket's own "records the
  degradation" requirement made machine-readable — `ok: false` distinguishes
  a parse failure / crashed verifier / no verifier configured from a genuine
  zero-findings verification (`{0, 0, true}`), which Gate 1.27's F2 and F3
  faces pin separately. A report reader can now tell WHY no findings rode.
- **The pre-retry call is additionally guarded against the adapter
  THROWING** (the ticket names parse failure only): a crash composes the
  same gates-only brief, records the same degradation, and the retry still
  fires — "verifier absence never blocks the mechanical retry" extended to
  verifier breakage, so a model-tool crash can never consume the
  machine-eligible retry. Pinned by Gate 1.27 F2b.

Gates measured on this lane (all run by the implementer unless noted):
Gate 0 `tsc --noEmit` exit 0 after the engine change;
`check-gate-retry-findings` RED (8 reported failures, output captured
above) pre-change → **ALL GREEN** post-change; `check-gate-retry`
(Gate 1.24) **ALL GREEN**; `check-verifier` (Gate 1.25) **ALL GREEN**;
full fast tier `node scripts/verify.mjs fast` **ALL GREEN** (exit 0, all
gates 0–1.27, Gate 1.27 wired in). **Gate 2 owed — carried by the driving
full-tier run** (`npm run verify:full`, now carrying `--verifier-model`),
which the driving workflow executes after this commit; the implementer did
not run it (model tokens are the driver's budget — the ask's division of
labor). **Gate 3 n/a** (no adapter file touched).

**Review round 1 (2026-10-22), addressed in this change-set:** the
driving Gate 2 came back RED — `WorkflowError: world.run 'node' timed out
after 1500000ms`, exit -1 — and the teed log
(`C:\swarm\verify-red\T-040-gate2-full.log`) shows the run was HEALTHY at
the kill: fast tier green, round 1 complete (planner 32s; workers
264s/283s; verifiers 429s/299s, each with one bounded repair; reviews
89s/76s), round 2's workers done (187s/51s), c02-r2's verifier done
(284s), c01-r2's verifier mid-repair. Diagnosis: this change-set's
`--verifier-model` addition (the ticketed Gate 2 shape) put the honest
path at ~30 min — above a wrapper budget calibrated before the tier
carried a verifier, violating the repo's own wrapper-budget invariant
(VERIFICATION.md Gate 2: the wrapper must sit ABOVE the inner 35-min
ceiling plus the fast tier). No assertion red; nothing in the change-set
implicated. Fixes, both in this change-set per the reviewer's mandate
("raise opts.timeoutMs or narrow the work"; narrowing is refused by
Known issue #12's own T-027 record): (1) the tracked driving workflow
(`.zcode/workflows/ticket-implement.dwf.ts`) raised its Gate 2
`timeoutMs` 1500000 → **2700000 (45 min)** with the calibration
commented; (2) the killed run's debris (4 worktrees, 4 `swarm/*`
branches, 1 stale lock) disposed through the house path (`npm run clean
-- --run 20261022193232 --run-root C:\swarm\verify --force --force-lock`;
8 removed, 0 refused, 0 failed; fixture verified pristine after: only
`main` in `worktree list`, no `swarm/*` branches, clean status; evidence
kept). VERIFICATION.md records the calibration (Gate 2 wrapper note +
a dated Known issue #12 follow-up marking T-027's "no lane change-set
can set it" obsolete — the workflow file is tracked). The lane fast tier
was re-run green after these edits.

**Review round 2 (2026-10-22), addressed in this change-set:** Gate 2
came back with the SAME `1500000ms` timeout signature — and this second
kill settles the diagnosis the first one left open: the budget is driven
by the workflow's **loaded script**, not the tracked file. The lane
carried the raised value in the tracked file (round 1's commit) and the
rerun was killed at 1500000ms anyway; the main checkout's copy — what a
driving run loads before the lane merges — still reads 1500000. The teed
log (3146 lines) again shows a HEALTHY run at the kill (round 1's
verifiers 410s/278s, reviews 143s/150s complete; round-2 planner in
flight; a slower model day than round 1). Fixes in this change-set:
(1) the killed run's debris (run `20261022201344`) disposed through the
house path (`npm run clean -- --run 20261022201344 --run-root
C:\swarm\verify --force --force-lock`; 4 removed, 0 refused, 0 failed;
fixture pristine; evidence kept); (2) the raise is now PAIRED across both
sides of the invariant, calibrated by the two kills' timing data — the
inner skeleton ceiling 35 → **50 min** (scripts/verify.mjs: the healthy
slow-day path measured ~30+ min, within noise of 35, so one stalled leg
— up to 15 min before its own budget reaps it into a runner verdict —
would have been an uninformative inner SIGTERM, the exact Known issue
#12 misconfiguration at the inner level) and the tracked workflow's
Gate 2 `timeoutMs` 2700000 → **3600000 (60 min)**, with the
PAIRED-VALUE comment on the raise and the pairing documented in
VERIFICATION.md's Gate 2 section and Known issue #12's dated follow-up.
**The remaining blocker is outside the lane's reach, escalated:** no
lane commit can change an already-loaded workflow script — the driving
run must be amended (or re-created from the updated tracked file) so its
Gate 2 `world.run` carries `timeoutMs: 3600000` before the next attempt.
The lane fast tier was re-run green after these edits.

**Re-verification round (2026-10-22, a later implementer session on the
same lane):** the lane worktree directory had been cleared between
sessions while the branch survived (tip `8a1526a`, clean, unmerged); this
session re-attached a fresh worktree to the existing branch — the
change-set was NOT redone — audited the full diff against the ticket
(faithful; the three owned deviations above stand), and re-measured the
gates on the identical tree: Gate 0 `tsc --noEmit` exit 0; Gate 1.27
standalone **ALL GREEN, 35 `ok:` assertions** (teed
`C:\swarm\verify-red\T-040-reverify-gate127.log`); Gate 1.24 standalone
**ALL GREEN** (its extended 5-key shape pin green against a verifier-less
drive); full fast tier `node scripts/verify.mjs fast` **exit 0, ALL
GREEN, 1564 `ok:` lines** (full output teed
`C:\swarm\verify-red\T-040-reverify-fast-full.log`; all sections Gate 0
through 1.27; the two check sandboxes removed afterward; the lane tree
clean after `npm install` — package-lock.json untouched). The standing
pre-Gate-2 condition is restated for whoever drives the full tier: the
loaded workflow script must carry the amended `timeoutMs: 3600000`
(Known issue #12's third-kill record) BEFORE the next `verify:full`
attempt — the inner ceiling on this tree is 50 min and the measured
healthy path ~30+ min, so the pre-edit 25-min loaded wrapper kills a
healthy run uninformatically. Gate 2 remains owed and carried by that
driving run; Gate 3 n/a (no adapter file touched).

**Review round 4 (2026-10-22 — the second driving Gate 2 red: the recorded
worker NO-OP class, diagnosed from the kept evidence; disposition: re-run,
not a code change):** Gate 2 (run `20261022215556`, teed
`C:\swarm\verify-red\T-040-gate2-full.log`) came back RED, exit 1, on 9
assertions — and every one of them is the NO-OP rule (AGENTS.md #7) or its
honest downstream. **Diagnosis, from the run's kept evidence (not
inferred):** BOTH round-1 workers exited 0 in 5.3s/7.4s with zero-byte
diffs (`report.json`: workerOk true, diffBytes 0, one attempt each;
`passedAllGates false` on both). The `worker.log`s capture the mechanism:
each builder probed the CANONICAL fixture instead of its lease —
`permission requested: external_directory (C:\swarm\demo-target\*);
auto-rejecting` on every such read, `Read C:/swarm/demo-target/calc.js
failed … The user rejected permission` — a path inferable from the goal
text's "demo-target" plus the lease path's `C:\swarm\…` prefix — and both
sessions derailed to exit-0-with-no-edits. The leases themselves were
properly based and populated: c01's verifier, running in the SAME worktree
afterward, read `wt\c01\calc.js` (17 lines, add/clamp only) and `test.js`
(14 lines with the T-041 ratchet RangeError checks) and its first
blocker-advisory finding states verbatim "The brief's CHANGES section was
not implemented at all" — the verifier did exactly its job on a real
no-op, and c02's parse failure was recorded honestly (`ok: false`, the
structural assertion added in this change-set passing on a real
degradation). The engine held everywhere: NO-OP verdicts, review correctly
skipped on non-survivors, the `rounds` block honestly recording
`{"round":2,"executed":false}` (zero survivors), hygiene and disposal
green. **Nothing in this change-set executes on the failing path:** no
gate failed (the fixture baseline passes its own gates on an untouched
tree), so the T-040 pre-retry verifier and composition never ran; the
worker dispatch/prompt/lease path is untouched by the lane's diff. **Class
citations:** the auto-reject mechanism behaving as designed is Known issue
#6's recorded residual (planner-class observation 2026-10-20; the
worker-class observation is now recorded there with this run's captures);
the zero-byte worker red is T-038's Gate 2 run-1 record verbatim (run
`20261022152425` → re-run `20261022155445` ALL GREEN). **Disposition
(AGENTS.md #9, the standing class discipline):** a re-run, not a code
change — any change that made this run shape pass would have to weaken
the NO-OP rule (AGENTS.md #7) or relitigate the blind-reroll ban
(decisions.md 2026-10-21: a zero-byte leg has no failure output to feed
back; "retrying" one is the banned blind re-roll), and no assertion was
weakened or touched. Gate 2's re-run is carried by the driving pipeline
(its budget, its wrapper), as across every prior round; the healthy-run
rate of this class across recorded runs (T-038 run 2, T-040 round 1: 4/4
and 4/4 workers productive) says the next run's expected shape is the
round-1 run's.

**Review round 3 (2026-10-22, after the re-verification round — the driving
Gate 2 red, addressed per the T-029 precedent):** Gate 2 (run
`20261022211937`, teed `C:\swarm\verify-red\T-040-gate2-full.log`) came
back RED, exit 1, on EXACTLY two assertions — `planner produced briefs
(attempts=2)` and `one round-2 brief per round-2 candidate` — with every
other assertion green: all four candidates worker-ok with non-zero diffs,
every gate PASS, a well-formed verifier block on every candidate (this
ticket's feature observed working on a real run), reviews parsed, two
executed rounds, hygiene and disposal green. **Diagnosis (from the run's
kept evidence):** the ROUND-2 planner answered the composed
survivor-evidence prompt with a complete two-brief array of
`{"brief": "<text>"}` OBJECTS instead of an array of strings
(`planner-r2-raw.txt`, 6543 bytes) and repeated the exact shape on its
bounded repair attempt; `parseBriefs`' element filter dropped every
object, the array scanned empty, and both planner attempts fell back to
the raw goal (`planner (round 2): no valid output, using raw goal in 115s
(2 attempts)`) — the engine's fallback behaving exactly as designed,
nothing else implicated (round 1's planner also slipped — the separator
class — and RECOVERED through repair 1). **Fix (AGENTS.md #8, the T-029
precedent verbatim — a driving Gate 2 red on a planner slip lands its
documented last-resort repair in the red lane):** `src/parse.ts` gains a
SECOND last-resort repair — a third scan that READS a `[..]` slice parsing
to an array whose EVERY element is an object carrying its own non-empty
string `brief` (all-or-nothing: one bad element sinks the slice; the
model's own labeled briefs are read out, never fabricated or rewritten),
with the plain scan's pad/truncate semantics verbatim, structurally inert
while either existing scan parses — so every input that parsed before
parses byte-identically BY CONSTRUCTION and no assertion anywhere was
weakened (Gate 2's two planner assertions are untouched). The recorded
bytes are vendored byte-for-byte at
`scripts/fixtures/planner-r2-objects-raw.txt` (OpenCode final frame
included, the T-029 fixture-faithfulness rule). **Red bar measured before
the engine change:** `check-parse.mjs` with the new pins ran RED — 4
failures, 23 ok (teed `C:\swarm\verify-red\T-040-parse-red2.log`) — the
four being exactly the extraction pins; the red run itself caught one of
the new pins contradicting existing behavior (a mixed object+string array
parses through the PLAIN path's string filter today, the existing
`non-string elements filtered` pin) and the pin was corrected to pin the
actual plain-path semantics before the engine changed. **Green bar:**
`check-parse.mjs` ALL GREEN, 27 ok (T-040-parse-green.log); Gate 0 exit 0;
full fast tier exit 0, ALL GREEN, 1571 ok lines
(`C:\swarm\verify-red\T-040-parse-fix-fast.log`). VERIFICATION.md's Gate
0.5 section documents both repairs and the new fixture. **Gate 2 re-run is
carried by the driving pipeline** (its budget, its wrapper): the recorded
failure shape now parses (proven on the recorded bytes), a strings reply
parses as before, and the honest residual exposure — a third, unrecorded
planner shape — stays a graceful raw-goal fallback, recorded as open (the
T-033 posture).

## Verification

Gate 0 throughout. **Gate 1.27** — token-free fake-adapter drives, wired
into the fast tier (renumbered from this ticket's Gate 1.26 placeholder;
T-041 took 1.26). **Gate 2** per the sequencing decision recorded on the
last acceptance criterion: this is its own change-set, so Gate 2 is the
driving full-tier run, now shaped (`--verifier-model`) to be exactly the
ticketed run. **Gate 3 n/a** (no adapter change; the verifier's posture
was settled by T-039).

## References

docs/spec/inference-refinery-v2.md §24:1462 (the bounded repair policy this extends), §9.2:719-747 (observations inform, never decide), §32:1939-1971 (the ratchet — the slower, cross-run consumer this complements) · docs/tickets/T-038 (the seam this extends; its immunity legs), T-039 (the producer), T-030 (the fingerprint pattern; the composer carve at src/rounds.ts:126-131) · src/runner.ts:416, :813-819 · src/types.ts:386-409.
