# T-040 — Verifier findings ride the retry brief: the T-038/T-039 composition seam (spec §24:1462 + §9.2; joins the two proposed lanes)

**Status:** proposed
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

- [ ] The pre-retry verifier call site fires exactly when the T-038 leg is retry-eligible, before composition; a verifier parse failure on that leg composes a gates-only brief and the retry still fires — pinned by **Gate 1.26** (token-free fake-adapter drives; next free gate number at implementation).
- [ ] The composed brief contains both sections — every failing gate's name/command/outputTail AND the included findings with their evidence — capped by the documented constants; the `gateRetry` block records `findings.count`/`included` and the fingerprint covers the full composed text — pinned by **Gate 1.26**.
- [ ] The zero-findings face: a verifier returning no observations composes a gates-only brief, retry unchanged from T-038's behavior — pinned by **Gate 1.26**.
- [ ] **Verdict immunity with findings present**: a candidate whose pre-retry verification returned `blocker-advisory` findings survives iff the re-run gates pass, and is eliminated iff they fail — findings are never a verdict input even when they rode the retry brief — pinned by **Gate 1.26** (the adversarial form of T-038's immunity leg).
- [ ] Caps hold under flood: a fake verifier returning dozens of long findings produces a brief within the documented bounds, gates section intact — pinned by **Gate 1.26**.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS.md #6): the Gate 1.26 section; the T-038 section updated to name the composition extension — pinned by the full fast tier `npm run verify` ALL GREEN.
- [ ] **Gate 2 owed** if sequenced as its own change-set (runner + composition): a real `--goal --gate-retry --verifier-model` run end-to-end; **or**, if T-038/T-039/T-040 land as one change-set lane, this criterion merges into that lane's single Gate 2 run — decided and recorded at implementation, never silently dropped.

## Landed

(added when done: what actually changed, deviations, measured gate numbers)

## Verification

Gate 0 throughout. **Gate 1.26** — token-free fake-adapter drives, wired into the fast tier. **Gate 2** per the sequencing note above (own run, or merged into the joined lane's run — recorded either way). **Gate 3 n/a** (no adapter change; the verifier's posture was settled by T-039).

## References

docs/spec/inference-refinery-v2.md §24:1462 (the bounded repair policy this extends), §9.2:719-747 (observations inform, never decide), §32:1939-1971 (the ratchet — the slower, cross-run consumer this complements) · docs/tickets/T-038 (the seam this extends; its immunity legs), T-039 (the producer), T-030 (the fingerprint pattern; the composer carve at src/rounds.ts:126-131) · src/runner.ts:416, :813-819 · src/types.ts:386-409.
