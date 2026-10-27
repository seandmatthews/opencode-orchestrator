# T-059 — Planner repo digest: a deterministic file-tree/manifest digest in the planner prompt (register R14)

**Status:** done 2026-10-27
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

- [x] Red bar recorded first (AGENTS #8), token-free: on main, the
      planner prompt for the demo fixture carries no tree/manifest
      bytes and no `planner-digest.txt` exists — asserted as the red.
      (Recorded: `C:\swarm\verify-red\T-059-red.log` — the demo-fixture
      probe's three T-059 assertions all fail on main, its RED-RECORD
      legs state the red's content positively; the same probe green on
      the lane at `C:\swarm\verify-red\T-059-green-probe.log`.)
- [x] Byte-deterministic: for a fixed repo + baseSha the digest composes
      byte-identically across two compositions in one check — pinned by
      a new fast-tier check this change-set adds (next free gate number
      at landing). (Gate 1.45 D1: two compositions byte-identical, and
      unchanged across working-tree mutations AND later commits — the
      digest reads the COMMIT, never the tree.)
- [x] Caps enforced and honest: a fixture repo exceeding the path cap
      produces a digest whose truncation line names the cut, total chars
      within the named constant — same check. (Gate 1.45 D3/D4: the
      path-cap face AND the char-cap face — a char-overflowing listing
      is re-cut below the path cap until the text fits, and the TRUNCATED
      line names the binding constant in both faces.)
- [x] Inertness pin (the T-056 pattern): with `--no-planner-context`,
      the composed planner prompt is byte-identical to main's for the
      same inputs — same check. (Gate 1.45 E2: byte-identical to a
      hard-coded main-form template, digest OFF and option ABSENT, no
      digest file, no report key, today's exact top-level key set.)
- [x] Evidence: `planner-digest.txt` written under the run artifacts dir
      and its sha256 in report.json; the digest bytes appear verbatim in
      the planner prompt — same check. (Gate 1.45 E1: file on disk,
      `report.plannerDigest.path`/`sha256` matching the bytes and the
      module recomposition, the FILE's bytes verbatim in the round-1
      prompt between GOAL and the output contract.)
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6) —
      pinned by the full fast tier ALL GREEN. (Gate 1.45 section added;
      lane fast tier — Gate 0 through Gate 1.45, `node scripts/verify.mjs
      fast` — exit 0 ALL GREEN, 2026-10-27.)
- [ ] **Gate 2 owed** (src/runner.ts's planner phase changed; the
      standing trigger fires): a real run with the digest ON produces
      parsed briefs, non-zero diffs, and every existing Gate 2 assertion
      green — the prompt change must not degrade the loop. **Gate 3
      n/a** (no adapter change). (Gate 2 additionally gained two
      strengthen-only digest assertions — `plannerDigest` present with
      the on-disk file and the recorded sha256 matching its bytes — so
      the real CLI-default run proves the digest ON path; run by the
      driving workflow, not in the lane.)

## Landed

2026-10-27. `src/planner-digest.ts` (new): `composePlannerDigest({repo,
baseSha})` — list-form git only (`git ls-tree -r --name-only <baseSha>` for
the tracked tree, forward-slash by git's own emission; `git show
<baseSha>:package.json` for the one recognized root manifest's
name/version identity line, read from the COMMIT's bytes), capped by two
documented exported constants (`MAX_DIGEST_PATHS` = 500, `MAX_DIGEST_CHARS`
= 12,000 — values chosen at implementation, no CLI knob) whose truncations
are loud: the tree-section header states listed-of-total and one TRUNCATED
line names the binding cap's constant and the not-shown count; the char cap
re-cuts below the path cap's cut until the composed text fits. The digest
names NO repo path (bytes, never access — Gate 1.20 S1's planner-prompt
posture holds, pinned again by D2) and throws on an unresolvable repo/base
(never a silent empty tree).

`src/runner.ts`: the digest is composed ONCE per run (repo + baseSha fixed
across rounds) before the planner phase, under the never-break-a-run
posture (a failure logs `planner digest failed (...)` and plans with
today's exact digest-less prompts — no file, no report field); round 1's
plannerPrompt call gets the digest as its `contextBlock` (the seam the
round-2 composed block already rides), round 2's gets digest + composed
survivor block joined by `\n\n` (digest first). The planner's scratch cwd,
'artifact-only' posture, and parse path are untouched. Evidence:
`planner-digest.txt` under the run artifacts dir + `RunReport.plannerDigest`
(`src/types.ts`, producer-only: `{path, sha256}` — one composition, two
consumers). **Seam decision, deliberate (the rounds/gateRetry pattern):**
`SkeletonOptions.plannerContext?: boolean` treats absent/false as today's
exact prompt bytes, so every existing direct-drive prompt/key-set face
(Gates 1.20/1.21/1.22/1.25's pinned bytes) is unchanged by construction —
zero edits to any existing check; the CLI resolves the run-level default
TRUE and always passes it (`--no-planner-context` opts out, the
--no-planner/--no-review idiom), so every real CLI run carries the digest
(the usage text documents the flag and its default).

`scripts/check-planner-digest.mjs` (new, Gate 1.45 in `scripts/verify.mjs`'s
fast tier): ten token-free legs — M (module contract), D1 (byte-determinism,
commit-pinned), D2 (content/provenance, exact manifest literal, no repo
path), D3/D4 (path-cap and char-cap honesty, exact TRUNCATED literals),
D5 (loud throw + the runner's catch posture), E1 (evidence + verbatim
prompt embedding through the real runner), E2 (opt-out and absent-seam
inertness against a hard-coded main-form template), E3 (both rounds, the
byte-precise `\n\n` join, digest-less rounds byte-identical to main's
forms), C1 (CLI --help/parse/source pins). Gate 2 gained two strengthen-only
assertions (the digest evidence on the real run). VERIFICATION.md carries
the Gate 1.45 section with the recorded red bar.

Red bar (AGENTS #8), recorded on main BEFORE the change: the probe at
`C:\swarm\verify-red\T-059-red.log` drives the real `runSkeleton` with a
fake planner against `C:\swarm\demo-target` — all three T-059 assertions
fail on main (no digest bytes in the round-1 prompt, no planner-digest.txt,
no report sha256); the same probe against the lane build passes all three
(`C:\swarm\verify-red\T-059-green-probe.log`). Lane fast tier measured ALL
GREEN (Gate 0 typecheck + the full Gate 1.x chain through Gate 1.45) on
Node v22.23.1, 2026-10-27. Gate 2 owed to the driving run (src/runner.ts's
planner phase changed — the standing trigger); Gate 3 n/a (no adapter
change).

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
