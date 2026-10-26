# T-059 — Planner repo digest: a deterministic file-tree/manifest digest in the planner prompt (register R14)

**Status:** proposed
**Category:** engine
**Value (1-5):** 5 · **Risk (1-5):** 2
**Depends on:** —

## What

The planner is repo-blind: `plannerPrompt` (src/runner.ts:522) carries goal +
count (+ the round-2 context block) and the planner's cwd is a scratch dir
under the run artifacts dir — no repo path, no file tree. Briefs cannot
reference real modules or conventions; every hedged-path annotation the
T-050 premise guard fires on, and the 2026-10-23 premise-lie class itself,
trace to the specifier not being able to see the code it is specifying
against.

The change — the register's minimal context producer (R14's own
disposition: "a file-tree/manifest digest in the planner prompt is the
minimal version"; the full §7 ContextPacket wiring stays a successor):

1. A deterministic digest composed from the TARGET repo at the run's
   baseSha, via list-form git calls (the ground-rule-4 discipline):
   the tracked file tree (`git ls-tree -r --name-only <baseSha>`),
   forward-slash paths, plus one manifest identity line per recognized
   manifest file at the root (package.json: name/version — presence and
   identity, not full contents). The baseSha is stated in the digest
   header.
2. Capped by named constants (max path count, max total chars — values
   chosen at implementation). When a cap truncates, the digest says so
   and names the cut (the honesty rule the context system already
   follows: budgets spent are budgets stated).
3. Delivered through the existing `contextBlock` seam — `plannerPrompt`
   already accepts one (used today only by the round-2 composed block);
   the digest rides the same parameter. The planner's scratch cwd,
   capability posture (`--agent plan`, T-023), and parse path are
   untouched: the digest is prompt context, never a path the planner is
   granted access to.
4. Persisted as evidence: the digest bytes are written to
   `planner-digest.txt` in the run artifacts dir and its sha256 recorded
   in report.json.
5. `--no-planner-context` opts out (the `--no-planner`/`--no-review`
   idiom); default ON.

Non-goals: wiring the §7 ContextPlan/Packet machinery to the planner
(the successor this ticket unblocks, not this ticket); letting the
planner read the target repo (its cwd stays the scratch dir; the digest
is bytes, not access); touching worker prompts (T-060, which shares this
digest producer); touching `--jobs` briefs (operator-authored).

## Why

R14 is the top effectiveness gap: "fully specified" briefs are
aspirational when the specifier cannot see the code. The context system
(T-012/13/14) is fully built with no producer feeding the planner — the
`context_plan_json` null precedent (T-034/T-037). The digest is
deterministic, token-cheap relative to a model-authored context pass,
and attacks the recorded brief-failure classes at their source: a
planner that can see `calc.js` at the root does not hedge "adjust path
to actual layout, e.g. src/calc.js" (the recorded T-050 guard firing),
and cannot assert survivor-created files as base state (the recorded
2026-10-23 premise lie).

## Acceptance criteria

- [ ] Red bar recorded first (AGENTS #8), token-free: on main, the
      planner prompt for the demo fixture carries no tree/manifest
      bytes and no `planner-digest.txt` exists — asserted as the red.
- [ ] Byte-deterministic: for a fixed repo + baseSha the digest composes
      byte-identically across two compositions in one check — pinned by
      a new fast-tier check this change-set adds (next free gate number
      at landing).
- [ ] Caps enforced and honest: a fixture repo exceeding the path cap
      produces a digest whose truncation line names the cut, total chars
      within the named constant — same check.
- [ ] Inertness pin (the T-056 pattern): with `--no-planner-context`,
      the composed planner prompt is byte-identical to main's for the
      same inputs — same check.
- [ ] Evidence: `planner-digest.txt` written under the run artifacts dir
      and its sha256 in report.json; the digest bytes appear verbatim in
      the planner prompt — same check.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) —
      pinned by the full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (src/runner.ts's planner phase changed; the
      standing trigger fires): a real run with the digest ON produces
      parsed briefs, non-zero diffs, and every existing Gate 2 assertion
      green — the prompt change must not degrade the loop. **Gate 3
      n/a** (no adapter change).

## Landed

## Verification

New fast-tier check: determinism, cap/truncation honesty, opt-out
inertness, artifact + report persistence. Gate 0, full fast tier ALL
GREEN; Gate 2 owed and recorded at landing.

## References

src/runner.ts:522 (plannerPrompt's existing `contextBlock` seam),
:619 (the round-2 precedent for a block riding it) ·
docs/adversarial-review-2026-10-23.md R14 (the disposition this
promotes) · docs/tickets/T-012 (the context system this unblocks a
producer for), T-050 (the premise guard whose firings this aims
upstream-of), T-049 (the yield block that measures whether brief
quality moves) · src/workspace/worktree.ts (baseSha provenance).
