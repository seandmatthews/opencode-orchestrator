# T-061 — Embedded-evidence fencing: fenced, capped, role-labeled blocks for model-bound evidence (register R5)

**Status:** done 2026-10-27
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** —

## What

Two bounded pipes carry adversary-influenced text into model-bound
prompts with no delimiting discipline:

- The `--gate-retry` brief embeds each failing gate's recorded
  `outputTail` raw (src/runner.ts:935-942: `OUTPUT (tail):` then the
  bytes). Gate output is target-repo-influenced — test names and
  assertion messages are attacker-writable content in the target repo.
- The round-2 composer renders reviewer observations verbatim into the
  planner prompt (src/rounds.ts:143-147: `- [severity] finding
  (evidence: …)` with no cap on finding/evidence length). Reviewer
  findings routinely quote worker-authored diffs and logs — a worker can
  launder instructions through the reviewer's trusted advisory voice.

Never verdict-affecting (gates decide; the composer excludes gate
tails, which shows the discipline exists one layer short) — but both
corrupt the planning tier.

The change — one delimiting discipline applied at every seam where
recorded evidence enters a model-bound prompt:

1. Fenced: explicit open/close markers (plain-text, no markdown
   dependence) around each embedded block.
2. Role-labeled: the fence names WHAT the block is ("recorded gate
   output", "recorded reviewer observations") and carries one fixed
   line stating that the block is recorded evidence, not instructions
   to follow.
3. Capped: per-block length caps at the existing scale — gate tails are
   already 4,000 bytes at capture (T-027); the composer's observation
   rendering gains a named per-finding + per-block cap with an explicit
   truncation marker (the retry brief's verifier-findings cap,
   `MAX_RETRY_FINDING_CHARS`, is the precedent to mirror).
4. Applied to BOTH named sites in this change-set; a docblock on each
   composition function states the discipline so the next seam copies
   it.

Non-goals: sanitizing or rewriting evidence content (bytes ride
byte-verbatim inside the fence — the T-029 fixture-faithfulness rule);
any verdict change; filtering what the reviewer may quote (its posture
is T-023's business, not the composer's).

## Why

R5: injected instructions inside target-repo content are one shell call
from exfiltration under the current trust posture (R1/A5, the decisions
still owed) — and even inside a fully trusted target, a worker whose
diff text re-appears inside "reviewer observations" speaks with borrowed
authority to the round-2 planner. The fence does not decide anything;
it makes the provenance legible to the model that reads it, at zero
token cost beyond the markers.

## Acceptance criteria

- [x] Red bar recorded first (AGENTS #8), token-free: on main, a
      fixture gate tail and a fixture observation containing
      instruction-shaped text ("ignore previous instructions…") ride
      both seams with no fence, no role label, no cap marker — asserted
      as the red.
- [x] Fencing: the same fixtures post-change arrive fully inside
      labeled fences carrying the not-instructions line — pinned by a
      new fast-tier check (next free gate number at landing).
- [x] Byte-fidelity inside the fence: the evidence bytes between the
      markers are byte-identical to the recorded evidence (no
      sanitization) — same check.
- [x] Caps: over-length composer observations truncate with the marker;
      the retry brief's existing findings caps unchanged and green —
      same check.
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6) —
      pinned by the full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (src/runner.ts retry composition + src/rounds.ts
      composer changed; the standing trigger fires on runner touch):
      every existing Gate 2 assertion green — the fences ride
      retry/round-2 paths and must not disturb them. **Gate 3 n/a.**

## Landed

2026-10-27. What changed, exactly:

- **`src/evidence-fence.ts` (new)** — the one delimiting discipline as a
  module: the fixed not-instructions line (`EVIDENCE_NOT_INSTRUCTIONS_LINE`,
  one literal at every seam), the two role labels
  (`RECORDED_GATE_OUTPUT_LABEL`, `RECORDED_REVIEWER_OBSERVATIONS_LABEL`),
  and `fenceRecordedEvidence(label, body)` composing open marker +
  not-instructions line + body + close marker. Pure string assembly,
  bytes never inspected or rewritten. The docblock states the
  four-part discipline in full so the next seam copies it.
- **`src/runner.ts`** — `composeGateRetryBrief`'s gates section: each
  failing gate's recorded `outputTail` now rides inside the
  `RECORDED GATE OUTPUT` fence (one fence per failing gate), bytes
  verbatim; the `GATE:`/`COMMAND:`/`OUTPUT (tail):` framing lines stay
  outside it, and the docblock states the discipline. The findings
  section's T-040 caps are untouched.
- **`src/rounds.ts`** — `survivorEvidenceText`'s review-observations
  section: the observation lines (pre-T-061 `- [severity] finding
  (evidence: …)` shape unchanged) ride inside the `RECORDED REVIEWER
  OBSERVATIONS` fence, under two new named exported caps —
  `MAX_OBSERVATION_CHARS` (2,000, per-finding, the
  `MAX_RETRY_FINDING_CHARS` mirror) and `MAX_OBSERVATION_BLOCK_CHARS`
  (12,000, one survivor's joined observation lines) — each cutting with
  an explicit exported truncation marker
  (`OBSERVATION_FINDING_TRUNCATION_MARKER` /
  `OBSERVATION_BLOCK_TRUNCATION_MARKER`, prefix cuts). The docblock
  states the discipline; engine-rendered gate-verdict lines stay
  outside the fence.
- **`scripts/check-evidence-fence.mjs` (new, Gate 1.47)** — 35
  assertions, legs M/R1/R2/C1/C2/F, wired into `scripts/verify.mjs`'s
  fast tier after Gate 1.46.

Gates measured in this lane: **Gate 0 green** (`npm run typecheck`,
exit 0); **red bar recorded first** — the Gate 1.47 check run on the
pre-change lane (= main, every src change stashed including the
untracked fence module) with the exact check bytes that now ride the
fast tier: 23 named failures, exit 1, verbatim at
`C:\swarm\verify-red\T-061-red.log` (the fence module import fails
behaviorally, the composer caps are undefined, and both seams ride their
instruction-shaped fixtures with no fence, no role label, no cap marker;
the F leg — the retry findings caps — was already green on main, the
stability half of its criterion); **Gate 1.47 green**
(`node node_modules/tsx/dist/cli.mjs scripts/check-evidence-fence.mjs`
— 35 assertions, exit 0); **full fast tier ALL GREEN**
(`node scripts/verify.mjs fast`, exit 0, two consecutive runs — every
gate section including the new 1.47 and the seam-adjacent 1.22/1.24/
1.27/1.35 unchanged and green). **Gate 2 owed** — not run in this lane
(real model tokens); the driving pipeline re-runs it on the merged tree.

## Verification

New fast-tier check: fence presence + role label at both seams,
byte-fidelity inside fences, cap behavior. Gate 0, full fast tier ALL
GREEN; Gate 2 owed and recorded at landing.

## References

src/runner.ts:893-950 (the retry brief's embedded gate tails and
already-capped verifier findings), src/rounds.ts:129-150
(survivorEvidenceText's uncapped observation rendering) ·
docs/adversarial-review-2026-10-23.md R5 (the disposition this
promotes) · docs/tickets/T-027 (the 4,000-byte outputTail origin),
T-038/T-040 (the retry seams), T-030 (the composer).
