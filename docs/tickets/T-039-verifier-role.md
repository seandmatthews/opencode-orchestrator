# T-039 — Verifier role: active pre-disposition verification — `--verifier-model`, an execute-capable read posture, findings that cite the commands they ran (spec §10.1, §6.6:426, §9.2; ratchet-boundary decisions entry in-ticket)

**Status:** done 2026-10-21
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 3
**Depends on:** — (T-023's `ExecutionPolicy` seam is the posture mechanism, done 2026-10-18; T-025's per-role adapter selection is the wiring template, done 2026-10-18; T-001's reviewer is the structural template for a parse-with-repair advisory role, done 2026-10-11). T-040 (proposed) adds this role's second call site — the pre-retry leg; T-041 (proposed) builds the cross-run promotion path for its findings. This ticket is valuable and shippable without either.

## What

A fourth model role beside planner/worker/reviewer. Where the reviewer (T-001) *reads* the diff post-gate on survivors, the verifier **actively tests**: it runs checks against the candidate's work itself and returns findings citing the commands it ran and the output it saw. Run-level flag **`--verifier-model <model>`** — absent ⇒ the role is skipped entirely and the report carries no block (the `probes`/`rounds` producer-only pattern, src/types.ts:304-311, :462-468). Optional `--verifier-worker` mirrors T-025's per-role harness selection; absent resolves to the run-level worker exactly as the planner/reviewer flags do (src/runner.ts:458-459).

Semantics:

1. **Placement.** In `runJob`, after the gate loop and probes, before review (src/runner.ts:802-833) — on the **final completed attempt, regardless of gate outcome** (the T-015 posture: evidence about failures is evidence, src/runner.ts:813-819). The diff is captured before the gates run (src/runner.ts:744-754), so the verifier's build/test artifacts cannot dirty diff evidence. Reviewer ordering unchanged; the verifier is not a reviewer replacement this slice (carve, below).
2. **Posture — probe first, then choose-and-document.** Step one of this ticket is a diagnostic (the `scripts/diag-pwd.mjs` precedent, ground rule 5): can the OpenCode agent behind `'worktree-read'` (src/types.ts:22-23 — the edit-tools-deny-listed plan-agent posture) **execute commands**? Two outcomes, both pre-declared:
   - Yes ⇒ the verifier rides `'worktree-read'` with a prompt directed to run checks.
   - No ⇒ a fourth `ExecutionPolicy` value joins the union (e.g. `'worktree-verify'`: execute-capable, mutation-deny-listed at the adapter — the T-013 choose-and-document precedent, documented in src/types.ts's docblock), translated inside `src/worker/opencode.ts` (the only OpenCode-aware file).
   Either way the boundaries are the standing ones: never `'worktree-write'` over anything but a lease, never the canonical checkout (ground rule 3), and an adapter that cannot honor the requested posture refuses the dispatch rather than downgrading (src/types.ts:14-16).
3. **Prompt** (the `builderPrompt`/`reviewerPrompt` template): the brief, the diff (char-capped at the `MAX_DIFF_CHARS` precedent, src/runner.ts:416), and the list of gates that **already ran** with names/commands/verdicts — then the novelty directive: these machine checks already ran; do not merely re-run the suite; run NEW checks — edge cases, timing, adversarial inputs — and cite every command you ran and its output.
4. **Output schema** — the reviewer's parse-with-repair pattern (src/runner.ts:560-575): `{"observations": [{"finding": "...", "severity": "info" | "concern" | "blocker-advisory", "evidence": "<commands run + output cited>"}]}`, 2..6 observations, one bounded repair attempt on invalid output, parse failure degrades gracefully (recorded `ok: false`, never verdict-affecting). Reuses the `ReviewObservation` shape (src/types.ts:256-261) under a **distinct** report block: optional `CandidateReport.verifier?` = `{ model, ok, attempts, observations, rawOutputPath }` (the `ReviewReport` field pattern, src/types.ts:266-272). Raw output always persisted (`verifier-raw.txt` in the candidate evidence dir, the `review-raw.txt` pattern).
5. **Never a verdict input.** `passedAllGates` stays `gates.every(...) && diffBytes > 0` (src/runner.ts:810); the verifier block is written after the ladder computes and no ladder line reads it. A blocker-advisory finding eliminates nothing, promotes nothing, reorders nothing — in this ticket. Its consumers are the human (report/dashboard) and, later, the retry seam (T-040) and the cross-run ratchet (T-041).
6. **The decisions.md entry lands in this change-set — the ratchet boundary:** verifier findings are advisory; **a model-authored check never decides survival in the run that produced it**; promotion into a gate set or fixture suite is human-owned and crosses runs (spec §32's finding → reproduction → machine probe → regression gate, :1939-1971). Written down before the role exists, because the role's entire legitimacy hangs on this line.

**Honest tension with the spec (stated, not smoothed).** Spec §10.1's deep verifier is "Read-only" (§10.1:769) and *receives* machine test outputs as inputs — the spec's division of labor has machine workers produce evidence and model verifiers interpret it. This ticket lets the verifier **generate machine outputs itself** (bounded, in-lease, recorded as observations-with-evidence). That is a documented extension, not a silent drift: it is consistent with §3.3's evidence-before-interpretation (the verifier gathers evidence before opining) and §14's mechanism-over-prompts (the posture is enforced at the adapter, whatever the prompt says) — but it does go beyond §10.1's input list, and the decisions entry says so and owns the reason: an agent that cannot run anything can only guess at runtime behavior, which is exactly the failure mode §3.3 bans. The required suite's results still come from the gates; the verifier's executions are *exploration*, never the required evidence.

**Does NOT claim / carved:** findings feeding anything in-run (T-040's seam); automatic finding→gate promotion (T-041, human-owned, cross-run); reviewer consolidation or replacement (a successor question once both roles have run history); the pre-retry verifier call site (T-040); per-job verifier config in `--jobs` specs (run-level flag, riding both modes like the reviewer does, src/runner.ts:527-534); session resumption; image inputs — spec §10.4's visual verifier stays carved (text/terminal evidence only this slice); §10.5's consensus challenger; any new npm dependency.

## Why

The pressure-testing this repo has today is passive, late, and dead-ends at the human. Gates run only the checks the operator anticipated and wrote into the gate string. Probes (T-015, T-032) run fixed scripted scenarios — no exploration. The reviewer — the only model that looks at the work — runs post-gate on **survivors only** (src/runner.ts:824), in a read-the-diff posture, and its `blocker-advisory` severity ("would block merge if a human agrees", src/runner.ts:438-440) has **no consumer**: nothing reads it back, nothing acts on it, report.json is the end of the line. The spec names the missing roles — §6.6:426's `adversary`, §10.1:769's deep verifier, §10.5's consensus challenger — and the mechanism that gives findings teeth (§32's ratchet), but no slice has landed any of it.

The gap this ticket closes is the **generator**: checks nobody wrote yet, run by an agent with the time and the lease to poke at the thing. Its output is not a verdict — it is *candidate checks and candidate bugs with evidence attached*, which is exactly the raw material the ratchet (T-041) promotes into permanent gates and the retry seam (T-040) feeds back into the worker. Without this role, T-040 has nothing to compose and T-041 has nothing to promote; with it, the advisory pipeline the spec describes (§9.2 observations → §32 ratchet) gets its first producer.

Cost, stated plainly: one more model call per candidate, on every candidate whose final attempt completed. That is the price of coverage of the unanticipated, and the flag keeps it opt-in until the value is demonstrated.

## Acceptance criteria

- [x] Flag-absent ⇒ no verifier block, report shape unchanged (the producer-only pattern) — pinned by **Gate 1.25** (new token-free check script, fake-WorkerAdapter drives, the Gate 1.24/T-038 script pattern; number = next free at implementation — kept at **1.25**, see Deviations 1; S1).
- [x] Verifier block present and populated on a drive with a fake verifier adapter: `model`/`ok`/`attempts`/`observations`/`rawOutputPath` fields correct; the raw output file exists in the candidate evidence dir — pinned by **Gate 1.25** (S2a; real-CLI machine-verifier end-to-end in S6).
- [x] Repair + degradation faces: invalid JSON triggers exactly one repair attempt; a twice-invalid output records `ok: false` with observations empty and changes nothing downstream — pinned by **Gate 1.25** (S5a/S5b, the reviewer-repair leg pattern).
- [x] **Verdict immunity, adversarial form**: with a verifier block carrying `blocker-advisory` findings present, a gate-passing candidate still passes, a gate-failing candidate still fails, and `passedAllGates` computes from `passed`/`diffBytes` alone — pinned by **Gate 1.25** (S4, one mixed drive).
- [x] Placement faces: the verifier runs on gate-FAILED candidates too (both outcome faces driven); its execution happens after diff capture (diff bytes equal before/after) — pinned by **Gate 1.25** (S2b order + S3's junk-writing fake, both outcomes in one drive).
- [x] Posture: the step-one probe's answer is recorded in this ticket's Landed section; the chosen policy is enforced at the adapter with refuse-not-downgrade; the verifier is never dispatched with the canonical checkout as cwd — pinned by **Gate 1.25** (engine side: S2a's worktree-read + cwd pins) + the adapter-side assertions of **Gate 3** — **n/a, recorded**: the probe answered EXECUTE-CAPABLE, so the verifier rides `'worktree-read'` unchanged and the adapter-side refuse-not-downgrade stands as Gate 1.20 S2 pinned it; the PWD probe re-run per ground rule 5 (quirk reproduced) is recorded in Landed and VERIFICATION.md's Gate 1.25 section.
- [x] The decisions.md entry (ratchet boundary; the §10.1 read-only tension and its resolution) is in the change-set and cited by VERIFICATION.md's new section — pinned by the change-set contents.
- [x] VERIFICATION.md extended in the same change-set (AGENTS.md #6): the new Gate 1.25 section, the probe record, the decisions citation — pinned by the full fast tier `npm run verify` ALL GREEN.
- [x] **Gate 2 owed** (real tokens): a real `--goal --verifier-model` run producing genuine findings on a real candidate — honestly reported (findings quality is the staged open question, recorded as open, the T-033 posture); `report.json` path recorded here and in VERIFICATION.md — **RUN 2026-10-21, `C:\swarm\20261021225243\report.json`**.
- [x] **Gate 3 owed-if-touched** (adapter posture/agent config): the diagnostic's result, the PWD probe output, and the adapter diff recorded; n/a only if the verifier rides `'worktree-read'` unchanged — **n/a, recorded** (no adapter diff exists; both probes re-run and recorded).

## Landed

2026-10-21. Lane `ticket/T-039-verifier-role` off main 7b9b6ca.

**What changed**

- `src/types.ts` — `VerifierReport` (the `ReviewReport` field pattern under
  a DISTINCT block: `model`/`ok`/`attempts`/`observations`/`rawOutputPath`,
  reusing `ReviewObservation`) and the optional `CandidateReport.verifier?`
  (the `probes`/`rounds` producer-only pattern); the
  `WorkerExecutionRequest.executionPolicy` docblock names the new dispatch
  site. NO new `ExecutionPolicy` value (probe, below).
- `src/runner.ts` — `verifierPrompt` (the brief + the captured diff
  char-capped at the `MAX_DIFF_CHARS` precedent + the gates that already ran
  with names/verdicts/**recorded commands** (`GateResult.command`) + the
  novelty directive + the JSON observations contract), `runVerifier` (the
  `runReview` parse-with-repair shape riding `parseReview` unchanged; raw
  output persisted at `verifier-raw.txt` with `verifier.log` beside it), the
  optional `verifierModel`/`verifierWorker` options (the T-025 seam pattern —
  absent ≡ null ≡ the role never dispatches, direct callers unchanged), and
  the call site in `runJob` after the gate loop and probes, before review, on
  the final completed attempt REGARDLESS of gate outcome. `passedAllGates`
  is untouched and no line reads the block back.
- `src/cli.ts` — `--verifier-model` (off unless given; no default model),
  `--verifier-worker` + `--verifier-command` (the T-025 per-role table gains
  the verifier row, so the pairing/validity refusals apply before repo
  validation, the lock, or any artifacts dir), a `verifier:` run-header line
  printed ONLY when the role is enabled (stdout is producer-only too), and
  the non-default-adapter construction through `createWorker`. The role
  rides both `--goal` and `--jobs` mode.
- `scripts/diag-execute.mjs` (new) — the step-one posture probe, the
  `diag-pwd.mjs` precedent.
- `scripts/check-verifier.mjs` (new) — **Gate 1.25**, 51 token-free
  assertions (S1 producer-only; S2a populated block + isolation + posture +
  prompt + raw persistence; S2b dispatch order; S3 both-outcome placement +
  diff immunity via a junk-writing fake; S4 adversarial verdict immunity;
  S5 repair/degradation; S6 real-CLI help/refusals + a token-free machine
  verifier e2e), wired into `scripts/verify.mjs`'s fast tier after Gate 1.23.
- `docs/decisions.md` — the **2026-10-21 ratchet-boundary entry** (findings
  advisory; a model-authored check never decides survival in the run that
  produced it; promotion human-owned and cross-run, spec §32; the §10.1
  read-only tension owned and resolved; T-022 untouched).
- `VERIFICATION.md` — the Gate 1.25 section (probe record, decisions
  citation, store-invisibility note, carves, Gate 2 record).

**Posture — the step-one probe, run and recorded.**
`node scripts/diag-execute.mjs C:/swarm/verify-verifier-probe/repo` (the
probe spawns the vendored opencode-ai 1.19.3 exactly as the adapter does —
list-form `run --agent plan -m zai-coding-plan/glm-5.3-flash <prompt>`,
PWD/OLDPWD pinned): **EXECUTE-CAPABLE** — the plan agent ran
`node -e "console.log('EXEC-PROBE-OK-7391', 6 * 7)"` and replied
`EXEC-PROBE-OK-7391 42`, and the target tree stayed clean. Therefore the
verifier rides **'worktree-read' unchanged**: no fourth policy value, no
adapter change, refuse-not-downgrade standing as Gate 1.20 S2 pinned it.
The PWD probe re-run per ground rule 5 (`node scripts/diag-pwd.mjs
C:/swarm/verify-verifier-probe/repo` with the shell's inherited PWD): the
quirk REPRODUCED — opencode resolved its project as the inherited `PWD`
value, not the spawn cwd — confirming the adapter's PWD/OLDPWD pinning is
load-bearing for the verifier dispatch too. Re-run `diag-execute.mjs`
before relying on the execute-capable answer after any harness upgrade.

**Gate numbers measured this change-set**

- Gate 0 (`npm run typecheck`): green.
- Gate 1.25 standalone: `node node_modules/tsx/dist/cli.mjs
  scripts/check-verifier.mjs` — ALL GREEN, 51 `ok:` assertions.
- Full fast tier: `node scripts/verify.mjs fast` — ALL GREEN (final
  pre-commit run; Gate 1.25 rides inside the tier; Gate 1 unaffected).
- Gate 2 (RUN, recorded): real `--goal --verifier-model` run against
  `C:/swarm/demo-target` — `--candidates 1 --no-planner --no-review
  --verifier-model zai-coding-plan/glm-5.3-flash`, gates build+test —
  **`C:\swarm\20261021225243\report.json`** (worktree disposed through
  `npm run clean -- --run 20261021225243 --force`; evidence kept). c01:
  worker ok 19s, diff 725 bytes, build PASS + test PASS ⇒ `passedAllGates`
  true with the verifier block present (verdict immunity on a real run).
  The verifier returned 6 findings (attempts 2 — one bounded repair on the
  real model, recovered), each citing its command and output: a genuine
  concern the gate string never covered (inverted bounds silently accepted,
  `clamp(5,10,0)` returns 0 with no `lo<=hi` guard in calc.js), a
  20,000-case fuzz (`mismatches: 0`), boundary/NaN/type-coercion probes,
  and a diff-vs-worktree consistency check. Findings quality stays the
  staged open question (the T-033 posture): one run, one candidate, small
  fixture — genuine and evidence-cited here; whether that holds across runs
  is what T-040/T-041 consume and stage.
- Gate 3: n/a, recorded (no adapter diff exists; both probes re-run and
  recorded above).

**Deviations**

1. Gate number kept at **1.25** (the ticket's own pinned text) rather than
   re-derived as "next free": T-038's lane (`ticket/T-038-gate-feedback-retry`,
   in flight at b15dfd1) claims Gate 1.24 in its ticket text, and the
   "number = next free at implementation" clause presupposed T-038 landing
   first. VERIFICATION.md carries the Gate 1.25 section after Gate 1.23
   with the 1.24 slot left for T-038.
2. `--verifier-command` added beyond the ticket's literal flag list: the
   ticket says `--verifier-worker` "mirrors T-025's per-role harness
   selection", and T-025's selection includes the machine-command pairing
   flag — the mirror is complete, and a machine verifier is what makes the
   role's token-free real-CLI end-to-end possible (Gate 1.25 S6).
3. No per-candidate `verifier.json` artifact: the reviewer writes
   `review.json`; this ticket names only the report block +
   `verifier-raw.txt` for the verifier, so none was added.
4. The run summary line is unchanged (no `verify:` segment): the verifier
   prints its own per-candidate progress line, and the report block is the
   pinned consumer face this slice.
5. The store is untouched: ingest never reads the `verifier` block (the
   `rounds`/`earlyStops` store-invisible precedent); a `verifier_json`
   column or artifact row is a successor-ticket question, not silently
   added.

## Verification

Gate 0 throughout. **Gate 1.25** — new token-free check script (fake adapters), wired into the fast tier. Gate 1 unaffected, green inside the tier. **Gate 2 owed** (runner + report shape + a real model role). **Gate 3 owed-if-touched** (adapter posture change ⇒ PWD probe + adapter faces; else n/a, recorded either way).

## References

docs/spec/inference-refinery-v2.md §10.1:767-781 (the deep verifier — read-only tension named above), §6.6:397-431 (roles as configuration; `adversary` :426), §9.2:719-747 (observations, never gates), §3.3:93-112 (evidence before interpretation), §3.6:144-148 (mechanism over prompts), §14.2:1020-1027 (workspace modes), §32:1939-1971 (the ratchet — where findings get cross-run teeth) · docs/decisions.md:19-22 (gates decide survival), 2026-10-18 (T-022 — the one-WorkspaceProvider posture this role works within) · docs/tickets/T-001 (reviewer — the structural template), T-015 (evidence-regardless-of-outcome posture), T-023 (ExecutionPolicy seam + refuse-not-downgrade), T-025 (per-role adapter selection), T-032 (adversarial probe — the scripted cousin of this role), T-040/T-041 (the proposed consumers) · src/runner.ts:416, :458-459, :527-534, :560-575, :744-754, :802-833, :810, :824 · src/types.ts:14-16, :18-25, :256-261, :266-272, :304-311, :462-468 · src/worker/opencode.ts (the only OpenCode-aware file — any posture translation lands here) · scripts/diag-pwd.mjs (the probe precedent).
