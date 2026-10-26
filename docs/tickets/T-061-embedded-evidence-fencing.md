# T-061 — Embedded-evidence fencing: fenced, capped, role-labeled blocks for model-bound evidence (register R5)

**Status:** proposed
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

- [ ] Red bar recorded first (AGENTS #8), token-free: on main, a
      fixture gate tail and a fixture observation containing
      instruction-shaped text ("ignore previous instructions…") ride
      both seams with no fence, no role label, no cap marker — asserted
      as the red.
- [ ] Fencing: the same fixtures post-change arrive fully inside
      labeled fences carrying the not-instructions line — pinned by a
      new fast-tier check (next free gate number at landing).
- [ ] Byte-fidelity inside the fence: the evidence bytes between the
      markers are byte-identical to the recorded evidence (no
      sanitization) — same check.
- [ ] Caps: over-length composer observations truncate with the marker;
      the retry brief's existing findings caps unchanged and green —
      same check.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) —
      pinned by the full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (src/runner.ts retry composition + src/rounds.ts
      composer changed; the standing trigger fires on runner touch):
      every existing Gate 2 assertion green — the fences ride
      retry/round-2 paths and must not disturb them. **Gate 3 n/a.**

## Landed

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
