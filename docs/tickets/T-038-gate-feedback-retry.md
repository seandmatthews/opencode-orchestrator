# T-038 — Bounded gate-failure retry: `--gate-retry` — one feedback-informed attempt composed from the gates' own recorded output (spec §24:1462, §30:1893; decisions.md entry in-ticket)

**Status:** done 2026-10-22
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 3
**Depends on:** — (T-007's attempt ladder is the substrate, done 2026-10-16; T-027's recorded `GateResult.command` supplies half the feedback payload, done 2026-10-19; T-029's promptVersion gives per-attempt provenance for free, done 2026-10-20). T-040 (proposed) is the successor that adds verifier findings to the same composition seam; this ticket is valuable and shippable without it.

## What

A run-level boolean flag, **`--gate-retry`**, granting each candidate **exactly one** additional attempt when its worker *succeeded* but the machine gates rejected the change — with the retry brief composed mechanically from the gates' own recorded output. The bound is fixed at one; no numeric knob until a producer needs one (the `RetryPolicy` carve posture, src/types.ts:189-196).

**The decision this ticket moves.** Today the ladder treats a succeeded worker as final no matter what: "zero-byte diffs and failed gates are ladder verdicts, and re-rolling them would be model-shopping around a machine verdict" (src/runner.ts:727-739; the retry condition `if (failure && base.attempts.length < opts.maxAttempts)` at src/runner.ts:773 fires only for `worker-failed`/`error` legs). types.ts:167-178 locks the vocabulary: "`'no-op'/'no-gates'/'gates-failed'` are candidate verdicts on the ladder, never attempt failures." This ticket splits that ban along the line that makes it coherent — **blind vs informed**:

- A **blind** re-roll (same inputs, roll again) stays banned in every mode. Same brief, fresh dice: that is model-shopping.
- A **bounded feedback-informed** retry becomes available under the flag. The gate's own `outputTail` is *new information* the first attempt never had; the retry is a new input, not a re-roll of the old one. Spec sanction: §24:1462 — "A required-gate failure eliminates the candidate **unless a bounded repair policy applies**" — and §30:1893's "retry same worker once" (the policy T-007 generalized to mechanical legs only, src/types.ts:189-193).

**The decisions.md entry lands in this change-set, before the code**: a new dated entry rewriting the re-roll prohibition's scope inside the 2026-10-10 machine-gates decision (decisions.md:19-22). It records: blind re-rolls banned (unchanged); one feedback-informed gate retry permitted under the flag; the feedback is the gates' own recorded output — no model composes or adjudicates it; the same Gate objects re-run unchanged on the retry (a retry never weakens, skips, or substitutes a gate); both legs recorded; the final attempt's verdict stands. Cite §24:1462 and §30:1893.

Mechanics:

1. **The retryable leg.** All of: `result.ok` AND captured `diffBytes > 0` AND ≥1 gate failed AND the flag set AND no prior gate-retry for this candidate. Zero-byte diffs stay terminal — a NO-OP has no failure output to feed back (AGENTS.md #7), so "retrying" one is the blind re-roll by another name. `no-gates` stays terminal.
2. **The feedback brief** — composed once per retry, one composition two consumers (the T-029 posture): original brief + the failing attempt's captured diff (char-capped, the `MAX_DIFF_CHARS = 30_000` precedent, src/runner.ts:416) + per failing gate its **name, command (T-027's `GateResult.command`), and `outputTail`** (the 4000-byte tail, src/gate/command.ts:5, :58) + the worker's attempt summary where the harness produced one. Fixed framing: the change was applied, these machine gates rejected it, fix the failures — the gates re-run unchanged on the new attempt. **Composition is string assembly in `src/runner.ts`; no model call composes the brief** — the diagnostician here is a template, which is why this does not need a model-verdict carve-out.
3. **Dispatch.** Fresh session (spec §11.1's `resumableSession` stays unproduced), fresh lease `wt/<id>-a<n>` at the same `baseSha` — the T-007 ladder already provides everything: lease id (src/runner.ts:647), attempt-scoped evidence dir (src/runner.ts:649), per-attempt `promptVersion` (src/runner.ts:670-671), per-attempt `inputContextHash` (src/runner.ts:679 — attempt 2's hash *correctly* differs from attempt 1's, because its brief differs; the hash is doing its job).
4. **Shape changes (all producer-only, the `probes`/`rounds` pattern):**
   - types.ts `FailureReason` doc updated: `'gates-failed'` may now appear as a **non-final attempt's** failure reason under the flag (state `'failed'`). The **final attempt keeps today's semantics byte-for-byte** — state `'succeeded'` when the worker succeeded even if gates fail (src/runner.ts:792-794); the verdict lives in `passedAllGates` (src/runner.ts:810) and the elimination vocabulary is unchanged.
   - **Attempt-scoped gate evidence.** Today gates attach only to the candidate report — final attempt only (src/runner.ts:802-809). A pre-retry leg's `GateResult[]` would otherwise be lost: record it attempt-scoped (optional `Attempt.gateResults?`, present only when that attempt ran gates as a non-final leg) **and** persist the gate outputs as evidence files in that attempt's evidence dir. The store's attempts ingest must carry or tolerate the field — verified in-ticket; if the schema cannot, the report + files are the durable copy and the gap is named in the Landed notes, never silent.
   - Optional `CandidateReport.gateRetry?` block, present only when the flag fired: `{ fromAttempt, toAttempt, gates: string[], fingerprint }` — fingerprint = sha256 of the composed brief text (the T-030 `packetFingerprint` pattern, src/types.ts:386-409); the exact prompt bytes are already hashed per-attempt as `promptVersion` (T-029). The composed brief itself is written into the retry attempt's evidence dir. `CandidateReport.brief` stays the ORIGINAL brief — the composed retry brief is attempt-scoped evidence, never a replacement.
5. **Bounds.** `--max-attempts` unchanged (mechanical legs only). Total attempts per candidate ≤ `maxAttempts + 1`: a candidate that burned attempt 1 on a mechanical retry and failed gates on attempt 2 still gets its one gate-retry.
6. **Interactions.**
   - `--rounds 2` (T-030): the retry lives inside each round's ladder; `-rN` round ids and `-aN` attempt ids never collide; survivor definition unchanged (final attempt's `passedAllGates`, src/runner.ts:219).
   - `--jobs` mode (T-009): rides the same `runJob` — the flag applies per-job. Per-job gate-retry policy in the jobs spec is carved (the spec's `retryPolicy` stays `maxAttempts`-only this slice, src/types.ts:189-196).
   - `--no-planner`: the "original brief" is the raw goal; composition unchanged.
   - **T-010 recovery**: the run header line (src/runner.ts:149-160) is where recovery derives the retry bound after a crash — it gains an optional `gateRetry: true` field. A crash mid-retry is recorded-running like any attempt; **no new dispatch.jsonl line shapes**.
   - Reviewer (T-001): unchanged — final `passedAllGates` only (src/runner.ts:824).

**Does NOT claim / carved:** per-job gate-retry policy in `--jobs` specs; numeric retry knobs; retrying `no-op`/zero-byte, `no-gates`, or worker-failed legs under this flag (worker-failed stays T-007's); any model involvement in composing or adjudicating the feedback (no model call added by this ticket); gate modification between attempts; session resumption (§11.1:875); verifier findings in the brief (T-040); rounds beyond 2 (decisions.md 2026-10-20, T-033); reviewer or review-ordering changes.

## Why

The motivating failure mode is cheap to state: today a gate-failed candidate is eliminated **with its diagnostic value thrown away**. The failing gate knew exactly why the change was rejected — `outputTail` is sitting right there on the `GateResult` (src/gate/command.ts:58) — and the ladder discards it. Worst case, all N candidates fail the same gate the same way and the run yields **zero survivors**, at which point round 2 never even runs (it requires ≥1 round-1 survivor, src/runner.ts:226): the run's total product is N expensive proofs that the goal was hard. One informed retry per candidate is the cheapest possible counter, and the repo already runs this exact pattern twice for structured outputs — the planner and reviewer each get one bounded repair attempt fed their own invalid output (src/runner.ts:489-504, :560-575). This ticket extends the house pattern to the worker leg, where the payoff is largest.

The substrate is fully built: attempt ladder with fresh leases and per-attempt evidence (T-007), recorded gate commands (T-027), per-attempt prompt hashing (T-029), `outputTail` on every gate result since the first gate. Nothing here invents machinery; it re-aims it at one more failure leg.

**Honest tension (stated, not smoothed).** Feedback teaches the worker exactly what the gate measured, which sharpens gate-gaming incentives relative to a blind second attempt: the retry knows precisely which check to satisfy. The counters are structural and already standing: the bound is one; the same gates re-run unchanged (a gamed fix must survive them again); gates should test outcomes, not implementations; and the T-032 adversarial probe exists to catch candidates that pass narrow checks hollowly. The empirical question — does the feedback retry convert gate-failures into *genuine* survivals at a rate worth its tokens — is exactly what Gate 2's real run and the report's `gateRetry` blocks are staged to answer, and this ticket records that question as open rather than claiming it answered (the T-033 honesty posture).

## Acceptance criteria

- [x] The decisions.md entry (blind vs informed; bound one; same gates re-run; both legs recorded) is in the change-set and cited by VERIFICATION.md's new gate section — pinned by the change-set contents + the gate section's citation.
- [x] **Red bar recorded first** (AGENTS.md #8): today's behavior — a gate-failed candidate eliminated after exactly one attempt, no attempt 2, no `gateRetry` block — demonstrated and recorded in VERIFICATION.md before the flag's code landed.
- [x] With `--gate-retry`: a worker-succeeded, non-zero-diff, gate-failed candidate gets attempt 2; the composed brief provably contains every failing gate's name, command, and outputTail (the `gateRetry.fingerprint` pin); attempt 2's values populate the report as the final attempt; `attempts[]` shows both legs with attempt 1 `state: 'failed'`, `failure.reason: 'gates-failed'`; the composed brief file exists in the attempt evidence dir; `CandidateReport.brief` is unchanged from the original — pinned by **Gate 1.24** (new token-free check script, fake-WorkerAdapter `runSkeleton` drives, the check-probe pattern).
- [x] Immunity faces: zero-byte-diff candidate not retried even with the flag; `no-gates` not retried; worker-failed legs retry under `--max-attempts` exactly as before, never consuming the gate-retry — pinned by **Gate 1.24**.
- [x] Final-attempt shapes byte-identical: a candidate failing gates on both legs is eliminated with `passedAllGates: false` and no new elimination vocabulary; a flag-less run's report carries no `gateRetry` block and no attempt-scoped gate fields — pinned by **Gate 1.24**.
- [x] Attempt-scoped gate evidence survives: the pre-retry leg's `GateResult[]` is on the attempt record and as evidence files, and the store ingests a retried candidate without loss — pinned by **Gate 1.24** (report-side) + the store leg of the drive (ingest assertions).
- [x] Interactions: `--rounds 2` retries within each round's ladder (round-2 id `-rN` + attempt `-aN` no collision); `--jobs` mode retries per-job through the same `runJob`; `--no-planner` composes from the raw goal — pinned by **Gate 1.24** drives.
- [x] The run header line carries `gateRetry: true` when the flag is set, and recovery derives the retry bound from it — pinned by **Gate 1.24** (header-line assertion) with the recovery disposition named as a manual face if not mechanically driven.
- [x] VERIFICATION.md extended in the same change-set (AGENTS.md #6): the new Gate 1.24 section (every leg above), the recorded red bar, the decisions-entry citation — pinned by the full fast tier `npm run verify` ALL GREEN with the new section present.
- [x] **Gate 2 owed** (real tokens): the change touches `src/runner.ts` verdict-adjacent code and adds an optional report block — on the trigger list. **RUN AND RECORDED 2026-10-22** (hand-run post-review; two full-tier runs of this exact tree — run 1 `20261022152425` RED on a diagnosed worker no-op flake with every engine rule holding, run 2 `20261022155445` **ALL GREEN**; no candidate failed a gate in either run, so the flag never fired: the no-regression half is demonstrated and the conversion question stays OPEN, recorded verbatim in the Landed block below).
- [x] **Gate 3 n/a** (no adapter change; no new harness posture).

## Landed

2026-10-21, lane `ticket/T-038-gate-feedback-retry`. What actually changed:

- **docs/decisions.md** — new dated entry **2026-10-21** ("The re-roll
  prohibition is about blindness, not repetition"), rewriting the scope of
  the 2026-10-10 machine-gates decision along the blind-vs-informed line
  exactly as this ticket specified (blind re-rolls banned unchanged; one
  feedback-informed gate retry under the flag; the feedback is the gates'
  own recorded output, no model composes or adjudicates it; the same Gate
  objects re-run unchanged; both legs recorded; the final attempt's verdict
  stands; citing §24:1462 and §30:1893). The 2026-10-10 entry gained a
  forward pointer. Landed before the flag's code in the change-set.
- **src/types.ts** — `FailureReason` doc updated (`'gates-failed'` may now
  appear as a NON-final attempt's failure reason under the flag; the final
  attempt's semantics byte-for-byte unchanged); optional
  `Attempt.gateResults?: GateResult[]` (present only on a pre-retry leg
  that ran gates); new `GateRetryRecord` (`{fromAttempt, toAttempt, gates,
  fingerprint}`) and optional `CandidateReport.gateRetry?`.
- **src/runner.ts** — `SkeletonOptions.gateRetry?: boolean`; the run header
  line gains optional `gateRetry: true` (absent otherwise — flag-less
  headers byte-identical); `composeGateRetryBrief` (pure string assembly,
  no model call: original brief + captured diff capped at `MAX_DIFF_CHARS`
  + per failing gate name/command/`outputTail` + the worker's
  `responseTail` where produced; sha256 fingerprint of the exact text);
  `runJob` restructured — gates now run into an attempt-local array so a
  pre-retry leg's results attach to their own attempt while `base.gates`
  keeps meaning "the FINAL attempt's gates"; the retryable leg (all of:
  `result.ok`, captured `diffBytes > 0`, ≥1 of a non-empty gate set failed,
  flag set, retry unspent) composes the brief once (two consumers: the
  `retry-brief.txt` evidence file in the retry attempt's evidence dir and
  the attempt's prompt, whose `promptVersion` hashes the wrapped bytes),
  records `attempt.failure = {reason: 'gates-failed', ...}` +
  `attempt.gateResults` + `base.gateRetry`, and continues at the same
  `baseSha` with a fresh lease `wt/<id>-a<n>`. The bound is one per
  candidate regardless of `--max-attempts` (total ≤ maxAttempts + 1); the
  mechanical-retry condition is untouched.
- **src/cli.ts** — `--gate-retry` boolean flag (parse-time, no numeric
  knob), usage documented, passed through to `runSkeleton`; the
  `--max-attempts` usage sentence updated (its pinned
  `default: 1; values < 1 refused` fragment kept byte-identical — Gate 1.8
  S8 stays green).
- **src/recover.ts** — `RunHeader.gateRetry?`; the step-8 disposition
  derives the bound from it: `dispositionFor` gains
  `gateRetryRemaining` (an unconsumed retry adds exactly one attempt to the
  bound; `maxAttempts` keeps reporting the header's declared value), and
  the new `gateRetryConsumed` reads consumption from dispatch records only
  (an ok completion with a captured non-zero diff followed by another
  dispatch — a shape only the retry leg produces). The stale "a
  gates-failed leg cannot occur in-run" comment rewritten.
- **scripts/check-gate-retry.mjs** (new, **Gate 1.24**) and its fast-tier
  wiring in **scripts/verify.mjs** (after Gate 1.23); the full tier's
  skeleton args now carry `--gate-retry` (see the Gate 2 note in this
  ticket's Verification section and VERIFICATION.md's Gate 2 section).
- **VERIFICATION.md** — the new Gate 1.24 section (every leg, the red bar,
  the decisions-entry citation, the store-tolerance note) and the Gate 2
  section's T-038 paragraph.
- **docs/tickets/** — this file (status, boxes, Landed) and the index row
  in docs/tickets/README.md, same change.

Measured gate numbers (this lane, this tree):

- **Red bar (pre-change tree, before the flag's code):**
  `node node_modules/tsx/dist/cli.mjs scripts/check-gate-retry.mjs` →
  **9 FAIL(s)** — the flag ignored, one attempt, gates-failed elimination,
  no block — ending in
  `ENOENT ... c01\attempt-2\retry-brief.txt`. That ENOENT is thrown inside
  G1, so the crash aborts `main()` and the check's G2–G6 legs never execute
  in the red run (re-verified at review round 1: the committed script
  against main's src yields exactly the recorded 9 failures and the
  recorded ENOENT path, nothing after); the old bar is the pre-change
  `scripts/check-retry.mjs` (Gate 1.8) **ALL GREEN** in the same window
  (S6 = the old bar: "a succeeded worker whose gates fail is never
  re-rolled — exactly one attempt").
- **Gate 1.24 (post-change):** `check-gate-retry.mjs` **ALL GREEN — 53
  assertions printed, 0 failures** (55 static `t()` sites in the script;
  the 2 else-guards at the G5b/G5c run-dir checks print only on failure).
  Measured per leg: G1 core 21, G2 immunity 8, G3 shapes 5, G4
  interactions 6, G5 real-CLI + store 8, G6 recovery 5.
- **Full fast tier:** `node scripts/verify.mjs fast` → **exit 0, ALL
  GREEN, 107 s, 1454 `ok:` lines** (measured at review round 1 on this
  tree's code — the only later delta is the Landed prose itself; the
  tier's own Gate 1.24 section prints 54 `ok:` lines —
  the check's 53 plus verify.mjs's one `gate-retry self-check exit 0`
  wrapper line), all sections Gate 0 / 1 / 0.5 / 1.5 (cleanup + lock +
  integrate) / 1.6–1.24; Gates 1.8, 1.10, 1.11, and 1.22
  also re-run standalone green during iteration. One one-off red in the
  passing window, recorded in Known issue #10 with its captured assertion
  names: Gate 1.12's S4 logged `CLEANUP FAIL` lines for a tree the same
  scenario's process-table assertions verified dead (the class's third
  observation, different lane, zero shared change-set code); the immediate
  re-run of the identical tree was ALL GREEN — the ledger's response
  (re-run, not a code change).
- **Gate 0** typecheck exit 0 throughout.
- **Gate 2: OWED at review, NOT RUN by this lane — RECORDED 2026-10-22 (block below)**
  verify:full; real model tokens). The full tier now carries
  `--gate-retry`, so the driving gate's `npm run verify:full` is this
  ticket's real run; its `report.json` path and the honest
  conversion-or-not reading of its `gateRetry` blocks are to be recorded
  here and in VERIFICATION.md when it lands. If no candidate fails a gate
  on that run, the flag is inert and the run demonstrates the
  no-regression half only — recorded as such, per the criterion's own
  either-way clause. Pending-state evidence, verified 2026-10-21 at review
  round 2: the only run dir under `C:\swarm\verify` is `20261021053700`
  (05:37, pre-change-set — its dispatch.jsonl header carries no `gateRetry`
  field), and the driving workflow's T-038 tee
  (`C:\swarm\verify-red\T-038-lane-fast.log`, 17:12) holds the lane fast
  tier only — ALL GREEN, no Gate 2 output yet. :**RECORDED 2026-10-22** (hand-run by the finishing session after the lane's review block; two full-tier runs of this exact tree, both logs teed under `C:\swarmerify-red\`):
  - **Run 1 — `20261022152425`** (`C:\swarmerify61022152425eport.json`; log `T-038-hand-gate2-full.log`): RED — exactly one assertion failed, `c01-r2: diff non-empty (0 bytes)`. The engine held everywhere this ticket's rules bite: the no-op candidate was recorded `passedAllGates: false` (the NO-OP rule, AGENTS.md #7), the flag stayed INERT on it (a zero-byte diff is terminal — "retrying" one is the banned blind re-roll), and no candidate failed a gate, so no retry was ever eligible. Diagnosis: the known worker no-op flake class (worker exit 0, zero edits — the class AGENTS.md #7 exists for); nothing in the change-set implicated — the same tree's run 2 below and the T-030-era run `20261020171354` both had every candidate produce a diff. Recorded and re-run, never smoothed.
  - **Run 2 — `20261022155445`** (`C:\swarmerify61022155445eport.json`; log `T-038-hand-gate2-full-run2.log`): **ALL GREEN** — 4/4 candidates (c01, c02, c01-r2, c02-r2) worker-ok, non-zero diffs (3611 / 2583 / 3277 / 3420 bytes), every gate PASS, reviews recorded, the `rounds` block records two executed rounds with survivors [c01, c02] then [c01-r2, c02-r2], post-run disposal clean, no residual lock.
  - **Conversion reading (the block's own terms, answered verbatim):** in NEITHER run did any candidate fail a gate, so no `gateRetry` block fired — `gateRetry` is absent on all eight candidates across both runs. What these runs demonstrate is the no-regression half only: the flag's inertness on passing candidates (both runs) and zero-byte terminality under a live no-op (run 1) are now observed on real runs. Whether a feedback retry converts a real gate-failure into survival remains the staged OPEN question — this fixture's gates pass for any competent attempt, so a conversion demonstration needs a target whose gates actually reject a candidate (the decompilation round-trip gate is the natural first candidate).
- **Gate 3 n/a** (no adapter file touched).

Deviations from the ticket text (none substantive; recorded for honesty):

1. The composed brief file is written at the TOP of the retry leg's loop
   iteration, so it appears in that attempt's `outputArtifacts` BETWEEN
   `worker.log` and `diff.patch` (the ticket named no position; the file
   exists before the attempt runs, which the order reflects).
2. The recovery disposition WAS mechanically driven (the ticket allowed a
   manual face): Gate 1.24's G6 drives the real `recover` CLI over
   synthetic dispatch evidence, five faces (unconsumed/consumed/
   flag-absent/consumed-at-2/no-op precedence).
3. `JobDisposition.maxAttempts` keeps reporting the header's declared
   value (the derived bound is visible through the disposition itself) —
   the ticket named no reporting shape; keeping the field's meaning stable
   preserves Gate 1.11's R5 pins byte-for-byte.
4. The store gap named per the ticket's provision: attempt-scoped
   `GateResult[]` are NOT store columns (schema v5 unchanged) — the report
   field + evidence files are the durable copy, the leg's `gates-failed`
   failure persists via `failure_json`, and ingest's tolerance is pinned
   behaviorally (Gate 1.24 G5b + Gate 1.6 green).

Review round 1 corrections (same change-set, no assertion weakened):

- The Gate 1.24 count above was off by one (54 → **53**): the original
  figure had counted verify.mjs's own `gate-retry self-check exit 0`
  wrapper line alongside the check's printed assertions. Measured: 55
  static `t()` sites, 2 failure-only else-guards, 53 printed on a green
  run.
- VERIFICATION.md's red-bar paragraph claimed the immunity and flag-less
  faces were "green in the same run" as the red bar — an overstatement:
  the G1 ENOENT crash aborts `main()` before G2–G6 execute. Corrected
  there, and the pre-change red was re-verified from the committed script
  against main's src (exactly the recorded 9 failures and ENOENT path,
  nothing after).

## Verification

Gate 0 (typecheck) throughout. **Gate 1.24** — new token-free check script (fake-WorkerAdapter drives; no model calls), wired into the fast tier. Gate 1 unaffected, green inside the tier. **Gate 2 owed** (runner + report shape): one real `--goal --gate-retry` run, artifacts at `C:\swarm\`, honestly reported either way. **Gate 3 n/a.**

## References

docs/spec/inference-refinery-v2.md §24:1462 (the bounded-repair-policy clause), §30:1893-1901 (failure policies; "retry same worker once"), §11.1:875 (`resumableSession`, unproduced), §32:1939-1971 (the ratchet — cross-run teeth, T-041's home) · docs/decisions.md:19-22 (2026-10-10 machine gates decide survival — the entry this ticket extends), 2026-10-20 (T-033 rounds cap) · docs/tickets/T-007 (the attempt ladder), T-027 (`GateResult.command`), T-029 (`promptVersion`), T-030 (`packetFingerprint` pattern; the ≥1-survivor round gate), T-010 (run header / recovery bound), T-032 (adversarial probe — the gaming counter) · src/runner.ts:149-160, :166-168, :226, :416, :489-504, :560-575, :647, :649, :670-671, :679, :727-739, :744-754, :773, :792-794, :802-810, :824 · src/types.ts:167-196, :274-315, :386-409 · src/gate/command.ts:5, :58.
