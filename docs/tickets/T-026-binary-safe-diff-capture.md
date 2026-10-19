# T-026 — Binary-safe diff capture: `git diff HEAD --binary` end to end (closes T-005 carve #2)

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** T-005

## What

Flip diff capture to git's binary-safe form and make integration replay apply it
faithfully, so a candidate that touches a binary file (image, font, compiled asset)
leaves evidence that can actually be reconstructed. One change-set, four files plus
docs:

- **`src/workspace/worktree.ts:80`** — one argv element on the existing list-form
  call (AGENTS.md #4): `['diff', 'HEAD']` → `['diff', 'HEAD', '--binary']`. Nothing
  else in the provider moves: no new provider, no factory, no `--workspace` flag
  (decisions.md 2026-10-18: `WorktreeProvider` is the only `WorkspaceProvider`), and
  the `diff(lease): string` seam (`src/types.ts:113`) is unchanged — probe-verified
  this session (throwaway repo, git 2.51.2.windows.1) that `--binary` output is pure
  printable ASCII plus newlines: the binary hunks carry `GIT binary patch` + `literal`
  sections in git's base85 armor, and a byte census of the patch found the only
  non-printable bytes were `0a`. Still a string end to end.
- **`src/integrate.ts:211-216`** — rework the refusal branch under AGENTS.md #8
  red-before/green-after. Today an apply-check failure matching `/binary patch/i`
  refuses with "diff capture (git diff HEAD, no --binary) cannot record binaries …
  See the capture fix carved off in T-005" (`src/integrate.ts:212-215`). After the
  flip that message is dead logic for anything this engine captured; the branch is
  reworked into a content check on the patch itself, in the same place:
  a `diff.patch` containing the old lossy stub line (`Binary files <a> and <b>
  differ` — exactly what the pre-fix capture emitted, probe-verified) is a PRE-fix
  historical diff and still refuses non-zero, with the message updated to say the
  diff predates binary-safe capture and cannot be reconstructed (spec §17.3:1199:
  "prior evidence is marked historical" is the honest fate of pre-fix evidence).
  The `/binary patch/i` error-regex branch is removed: post-fix every binary hunk
  carries the full 40-hex index line git apply requires (probe-verified), so a
  genuinely drifted binary — pre-image no longer matches at current HEAD — fails
  `--check` with an ordinary "patch does not apply" and falls through to the
  existing ordinary refusal at `src/integrate.ts:217-219`, unchanged. Behavior
  contract: post-fix diff, clean target → applies byte-identically; post-fix diff,
  drifted binary → ordinary conflict refusal; pre-fix stub → historical-evidence
  refusal. All three non-zero paths leave the integration worktree untouched
  (atomic `git apply --check`, the T-005 precedent).
- **`scripts/verify.mjs:300-307`** — the Gate 1.5 sandbox's `captureDiff` mirror
  flips in the same change-set: comment (`:300`), `add -A --intent-to-add` (`:306`),
  `diff HEAD` → `diff HEAD --binary` (`:307`). The mirror exists so the sandbox
  captures "exactly like src/workspace/worktree.ts" — it must flip with the engine
  or the sandbox silently diverges. Gate 1.5 also gains the binary scenario (three
  assertions, below): green byte-identical replay, pre-fix stub refusal, and
  drifted-binary ordinary refusal. The sandbox baseline commit gains a small binary
  file (e.g. `asset.bin`) so a candidate edit produces a binary-hunk diff whose
  pre-image matches the run base.
- **`VERIFICATION.md:113-115`** — the Gate 1.5 section's "a diff touching a binary
  file can never replay (capture lacks `--binary`)" sentence rewritten in the same
  change-set (AGENTS.md #6) to document the binary-safe capture, the three-way
  behavior contract, and the new scenario. Errata in passing: T-005 (done) keeps
  its content as history, but its stale diff-capture citations — `:50-51` and
  `:138-139` cite `src/workspace/worktree.ts:38-39`, `:102-103` cites `:39` — are
  corrected to the function's current home, `worktree.ts:76-81` (line drift, no
  content change).

**Does NOT claim:** no adapter, no parse (`src/parse.ts` untouched → Gate 0.5 n/a),
no gate code, no report shape change, no seam change (`src/types.ts:113` is
untouched) → Gate 3 n/a. Reviewer prompts will now carry bounded base85 blobs —
the diff string rides into the advisory prompt truncated at `MAX_DIFF_CHARS = 30_000`
(`src/runner.ts:242`, `:261`) — a noted consequence only: advisory tier never
decides survival (decisions.md 2026-10-10), and prompt-size handling of binary blobs
is carved off for a later ticket. Evidence-size/retention policy for binary-heavy
diffs (spec §16.1 graded retention classes) stays the standing stage-3 leftover.
T-005's other carves are untouched: #1 gate commands in `report.json`, #3 §17.2
steps 5/7/8, #4 §17.3 configurable policy, #5 store-backed integrate. Note this
closes T-005's carve **#2**, not #1 (T-005:100-104).

## Why

`(baseSha, diff.patch)` IS the candidate identity (T-005:125-127) and the spec's
durable-evidence promise is "Commits, diffs, and evidence can survive after physical
worktree removal" (§16.1:1148), with `diff` a first-class artifact type carrying
`contentHash`/`sizeBytes` (§6.8:460-461, `:476`). Capture breaks that promise for
binaries today: `WorktreeProvider.diff()` runs plain `git diff HEAD`
(`src/workspace/worktree.ts:80`), which emits the lossy line `Binary files a/x and
b/x differ` — reproduced this session in a throwaway repo — so a binary-touching
candidate's diff.patch cannot reconstruct it, and `git apply --check` refuses with
"cannot apply binary patch to 'asset.bin' without full index line" (reproduced;
matches `src/integrate.ts:212`'s regex). Integrate is therefore not total over
candidate shapes: the first binary-touching candidate — likely the moment stage-4
Godot work (binary assets) produces candidates — has no replay path. The refusal is
loud, correct, and pointed, which is why this is a 4 and not a 5: nothing is losing
work silently today.

The carve is real and pre-charged: T-005:102-104 carves "binary-safe diff capture
(`git diff HEAD --binary` … pipeline behavior change, own red/green ticket)" off as
carve #2 with "until then integrate refuses binary stubs loudly", and T-005:225-227
pre-charges the Gate 2 obligation: "any successor that adds gate commands to
`report.json` or changes capture owns a Gate 2 run". Nothing pins today's refusal:
grep for `binary` over `scripts/verify.mjs` returns zero hits — the branch was
scout-probed at T-005:50-53 and never gated. The mechanism is probe-proven twice
this session (scout's probe in a disposed throwaway repo, re-verified in this
ticket's probe): with `--binary`, `apply --check` and `apply` both succeed and the
replayed binary is byte-identical (`cmp` clean). Blast radius is content-agnostic
everywhere else: the promotion ladder only needs `diffBytes > 0`
(`src/runner.ts:604`) and a `--binary` diff is non-zero-byte (decisions.md
2026-10-10 NO-OP rule untouched); the store sha256-hashes diff.patch at ingest
regardless of content (`src/store/index.ts:357`, hash-at-ingest at `:881`); recover
and cli summaries consume only `diffBytes` (`src/recover.ts:359`,
`src/cli.ts:463`); artifact ids digest the producer triple, not content
(VERIFICATION.md:222-226). Honest churn to accept: binary hunks' index lines change
shape — abbreviated `index e2d42a2..a834a6d` becomes the full 40-hex line git apply
requires for binary patches (probe-verified); text hunks keep the abbreviated form,
so the change is visible only in diffs that touch binaries. Also observed, pre-existing
and orthogonal: text-file replay drifts CRLF under the machine-global
`core.autocrlf=true` — every text replay behaves that way today; this ticket
changes nothing about it.

## Acceptance criteria

- [ ] Capture is binary-safe: a candidate worktree that edits a binary file yields a
      `diff.patch` containing `GIT binary patch` sections and never the lossy
      `Binary files … differ` stub — pinned by the new Gate 1.5 binary scenario,
      whose diff is captured through the flipped `captureDiff` mirror. (Gate 1.5)
- [ ] Binary replay is faithful: `integrate` on a binary-touching survivor exits 0,
      every gate PASS, and the replayed binary is byte-identical to the candidate's
      version (sha256 or `cmp` asserted in the sandbox), with the verdict artifact
      recording applied + treeChanged + passed — pinned by the same Gate 1.5
      scenario. (Gate 1.5)
- [ ] Red bar reproduced before the flip (AGENTS.md #8): with the pre-fix capture,
      the same sandbox scenario produces the lossy stub and `integrate` exits 1 with
      the apply refusal ("cannot apply binary patch … without full index line") —
      the exact behavior scout-probed at T-005:50-53 and never gated. Reproduced in
      the Gate 1.5 sandbox before `worktree.ts` and the mirror flip, and recorded
      with its output in this ticket's Landed; the landed gate keeps the green face
      (there is no permanent assertion of the old capture — it no longer exists).
      (Gate 1.5 sandbox, pre-flip run recorded here)
- [ ] Pre-fix historical diffs still refuse, honestly: a `diff.patch` containing the
      lossy stub line (`Binary files a/asset.bin and b/asset.bin differ`) refuses
      non-zero with the historical-evidence message (predates binary-safe capture;
      §17.3:1199), and the integration worktree's `git status --porcelain` is empty
      — pinned by a new Gate 1.5 assertion that hand-writes such a stub (exactly the
      pre-fix output shape). (Gate 1.5)
- [ ] Real binary conflicts fall through to the ordinary refusal: a post-fix binary
      patch whose pre-image no longer matches at current HEAD (same-file drift
      committed after the run base) exits non-zero through the ordinary apply-check
      refusal path (`src/integrate.ts:217-219`), worktree untouched (atomic) —
      pinned by a new Gate 1.5 drifted-binary assertion. (Gate 1.5)
- [ ] The mirror cannot silently diverge: `scripts/verify.mjs:300-307` flips in the
      same change-set, and the existing Gate 1.5 clean-replay, conflict, and
      policy-refusal scenarios stay green with the flipped mirror — proving
      text-only capture behavior is unchanged. (Gate 1.5 + change-set review)
- [ ] Text-only end-to-end behavior unchanged: Gate 1 (demo), Gate 1.6
      (hash-at-ingest over the new-format diff.patch — content-agnostic by
      construction), Gate 1.17 S5 (format-agnostic: "diff.patch captured its own
      marker-file change"), Gate 1.19 (diffBytes self-consistency) all green.
      Expected green by analysis — hash and diffBytes are content-agnostic and the
      ladder at `src/runner.ts:604` only needs `diffBytes > 0` — but run, not
      assumed. (Gates 1, 1.5, 1.6, 1.17, 1.19 via `npm run verify`)
- [ ] Gate 2 runs once at landing: workspace handling is on Gate 2's trigger list
      (VERIFICATION.md:2052-2053) and T-005:225-227 names capture changes
      explicitly. (Gate 2, `npm run verify:full`)
- [ ] Typecheck green with the one-argv change, list-form preserved (AGENTS.md #4);
      the `WorkspaceProvider` seam (`src/types.ts:109-116`) is untouched — pinned
      by Gate 0 plus change-set review.
- [ ] Docs in the same change-set (AGENTS.md #6, decisions.md 2026-10-10 process
      entry): VERIFICATION.md Gate 1.5 section rewritten (`:113-115` refusal
      sentence replaced; the binary scenario and three-way behavior contract
      documented); T-005's stale `worktree.ts:38-39`/`:39` citations corrected to
      `:76-81` (`:50-51`, `:102-103`, `:138-139`); ticket status + index updated in
      the same change. (change-set review)

## Verification

Gate 0 (`npm run typecheck`) and Gate 1 (`npm run demo`) always; the full fast tier
`npm run verify` — extended Gate 1.5 (new binary scenario: byte-identical replay,
stub refusal, drifted-binary refusal; existing scenarios re-prove the flip) plus
Gates 1.6, 1.17, 1.19 unchanged. **Gate 2 (`npm run verify:full`) is REQUIRED once
at landing** — workspace handling is on the trigger list (VERIFICATION.md:2052-2053;
T-005:225-227 names capture changes). Gate 0.5 n/a (`src/parse.ts` untouched);
Gate 3 n/a (no adapter touched).

## References

docs/spec/inference-refinery-v2.md §16.1:1148, §6.8:460-476, §17.2:1185 (step 3
"replay/cherry-pick/apply"), §17.3:1199; T-005:50-53, :100-104, :125-127, :225-227;
decisions.md 2026-10-10 (gates decide / NO-OP rule) and 2026-10-18
(WorktreeProvider only).
