# T-055 — Verify-root evidence retention: the full tier stops destroying prior Gate 2 run evidence

**Status:** done 2026-10-25
**Category:** verification
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** —

## What

`scripts/verify.mjs:1067` opens the full tier with
`rmSync(verifyRoot, { recursive: true, force: true })` where
`verifyRoot = 'C:/swarm/verify'` (:14) — every Gate 2 run writes its run
dir under that root (:1101 passes it as `--run-root`), so **each full-tier
invocation permanently destroys every prior Gate 2 run's evidence**. The
damage is recorded: T-049's lane cited run `C:\swarm\20261024021432` in
Known issue #6's 2026-10-24 observation, and a later `verify:full` wiped it
from disk before T-049 landed — the marker literal had to be recovered from
VERIFICATION.md's own text and cross-checked against an unrelated older
run. The repo's honesty convention is cite-the-artifacts
(decisions.md, T-033's entry); the full tier currently un-cites them
behind the repo's back.

The change — retain by moving, bound the growth:

1. **Archive instead of wipe**: the reset moves each existing `^\d{14}$`
   run dir under `C:/swarm/verify` into `C:/swarm/verify-archive/<runId>/`
   (a plain move; same drive) before the new run starts, keeping the most
   recent ARCHIVE_KEEP_RUNS (a documented, exported constant, e.g. 10)
   archived runs and deleting older ones — bounded disk, evidence with a
   grace period instead of none.
2. **The exactly-one-run-dir assertion follows the layout**
   (`scripts/verify.mjs:1129-1131`): the assertion becomes "exactly one run
   dir in the LIVE root" (archives live elsewhere) — strength preserved,
   target moved; the diff records the reasoning (the T-044
   strengthen-or-equal precedent).
3. **The check drives the helper token-free**: the move/keep/delete logic
   lives in an exported helper (or a small module) so the fast tier can pin
   it with fixture run dirs — no model tokens needed to prove retention.

Non-goals: retention policy for `C:\swarm\<runId>` evidence at large (the
ROADMAP stage-3 graded-classes item); changing what Gate 2 itself does;
archiving anything other than timestamped run dirs (locks/, verify-red/
untouched).

## Why

Every ticket since T-038 cites Gate 2 run dirs as its red/green evidence;
the full tier silently voids those citations on each run. The T-049
incident is the recorded proof the convention breaks today. This is the
cheapest fix that keeps the reset's purpose (a clean live root per full
run) while making citations survive.

## Acceptance criteria

- [x] **Red bar recorded first** (AGENTS #8), token-free: against the OLD
      behavior (extracted or reproduced), a verify root holding two fixture
      run dirs is wiped with nothing archived — asserted as the red bar.
- [x] Green, retention: the same fixture through the new helper — both run
      dirs land under `verify-archive/`, the live root is empty, and the
      most recent ARCHIVE_KEEP_RUNS are kept while older archives are
      deleted — pinned by the new fast-tier check.
- [x] Green, live assertion: the updated full-tier assertion passes with
      an archived-history root (its exactness unchanged for the live root)
      — pinned by the same check driving the assertion's predicate with
      fixtures.
- [x] Non-timestamped entries (locks/, verify-red/, strays) are never
      moved or deleted by the helper — pinned by the same check.
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6): the
      retention rule, the constant, the archive root, and a note that the
      T-049 incident (run `20261024021432`) motivated this — pinned by the
      full fast tier ALL GREEN.
- [x] **Gate 2**: `scripts/verify.mjs` itself changed, but no `src/`
      engine surface — trigger analysis recorded at landing per the T-041
      precedent (if the analysis lands "owed" because the tier's own
      behavior changed, the next full run IS the evidence); **Gate 3 n/a.**

## Landed

2026-10-25, Gate 1.41 (`scripts/check-verify-retention.mjs`, wired into
`scripts/verify.mjs` fast tier after Gate 1.40).

- The retention helper `scripts/verify-retention.mjs` (plain ESM —
  `scripts/verify.mjs` runs under plain node): `ARCHIVE_KEEP_RUNS = 10`
  (the documented, exported constant), `isRunDirName` / `listRunDirs`
  (sorted `^\d{14}$` DIRECTORIES — a timestamped file is a stray, never a
  run dir; a nonexistent root lists empty), `pruneArchive(archiveRoot,
  keep)` (deletes all but the most recent `keep` archived run dirs,
  non-timestamped entries untouched), `archiveExistingRuns(verifyRoot,
  archiveRoot, keep = ARCHIVE_KEEP_RUNS)` (plain same-drive rename of
  every live run dir into `verify-archive/<runId>/` — bytes never
  rewritten; a same-named archived dir, possible only from a previously
  failed/partial move, is replaced by the live copy; fails LOUD rather
  than letting the tier proceed after a failed move — continuing would
  destroy exactly the evidence it exists to retain; returns honest
  `{ moved, deleted }` sorted name lists).
- `scripts/verify.mjs`: the Gate 2 reset `rmSync(verifyRoot, { recursive:
  true, force: true })` (pre-T-055 main, scripts/verify.mjs:1077 — the
  ticket's `:1067` was authored against a slightly older revision) is
  replaced by `archiveExistingRuns('C:/swarm/verify',
  'C:/swarm/verify-archive')`, printing the moved/pruned run-dir names;
  the exactly-one-run-dir assertion now targets the live root explicitly
  through the shared `listRunDirs` (exactly one run dir in
  `C:/swarm/verify` — archives live under `C:/swarm/verify-archive`),
  predicate unchanged over actual run dirs, one edge safer (a timestamped
  file no longer counts as a run dir, matching the move rule) — strength
  preserved, target moved, the T-044 strengthen-or-equal reasoning
  recorded in the assertion's comment; new fast-tier section Gate 1.41
  drives the check.
- Nothing in `src/` changed: no engine surface, no report shape, no
  adapters, no gates. One side-benefit recorded as observation, in scope
  of the non-timestamped safety rule: the old wipe also destroyed
  `<run-root>\locks\` (src/lock.ts:42 pins the checkout lock there) —
  locks now survive the reset.
- VERIFICATION.md: new Gate 1.41 section (the retention rule, the
  constant, the archive root, the live-assertion statement, the R/G/L/S/H
  faces, the recorded red bar) + a Gate 2 section note at the point of
  use; the T-049 incident (run 20261024021432, wiped from disk after
  Known issue #6's 2026-10-24 observation cited it, recovered from
  VERIFICATION.md's own text per T-049's Landed) recorded as the
  motivation.
- Non-goals kept: no retention policy for `C:\swarm\<runId>` evidence at
  large, no change to what Gate 2's run itself does, nothing archived but
  timestamped run dirs. No decisions.md change, no ride-alongs.

Gates measured: red bar recorded FIRST against the pre-helper lane tree
(log `C:\swarm\verify-red\T-055-redbar.log`): R1–R3 green — a fixture live
root holding two run dirs wiped with NOTHING archived, the ticket's red
bar asserted as reproduced — and 8 helper-driven faces failing on the
absent `scripts/verify-retention.mjs`, **8 failure(s) of 12, exit 1**
(the T-052 seam-absence pattern; the recorded red log is byte-reproducible
from the committed check by hiding the helper). Post-change:
`node node_modules/tsx/dist/cli.mjs scripts/check-verify-retention.mjs`
**ALL GREEN (29 assertions), exit 0**; full fast tier
(`node scripts/verify.mjs fast`) **ALL GREEN, exit 0** — Gate 0 green,
Gates 1.5–1.41 green in the same pass.

Gate 2 trigger analysis (the ticket's criterion, the T-041 precedent):
the standing trigger (VERIFICATION.md, Gate 2: "Required when touching
`src/runner.ts`, any adapter, gates, workspace handling, or anything that
changes report shape") does NOT fire — no `src/` surface is touched. But
the tier's own behavior changed, and the one thing a token-free check
cannot prove is the wiring end to end on a real run: **Gate 2 owed; the
next full run IS the evidence** (the ticket's own clause). Its Gate 2
log will carry the new `prior Gate 2 run dirs archived ...` line (the
reset exercised for real, with run 20261026032716 — the live root's
occupant at landing — moving into the new archive root), and the run's
own artifacts become the first retained Gate 2 evidence. **Gate 3 n/a**
(no adapter change).

## Verification

Gate 1.41 (`scripts/check-verify-retention.mjs`, fast tier): the wipe red
bar reproduced against the OLD behavior (R), archive/keep/delete green
through the helper (G — the default ARCHIVE_KEEP_RUNS bound exact, the
`keep` parameter pinned), the full-tier live-assertion predicate driven
with fixtures (L — passes with an archived-history root, exactness
unchanged), non-timestamped safety (S — locks/, verify-red/, strays, a
timestamped file, the archive-side prune, a nonexistent root), and check
isolation from the real verify root (H). Gate 0, full fast tier ALL
GREEN; Gate 2 trigger analysis recorded in Landed (owed — the next full
run IS the evidence); Gate 3 n/a.

## References

scripts/verify.mjs:14, :1067, :1101, :1129-1131 (the reset, the run root,
the assertion) · VERIFICATION.md Known issue #6 (the 2026-10-24 incident —
run `20261024021432` wiped), the T-049 lane note · docs/tickets/T-049 (the
discovery), T-033 (the cite-the-artifacts convention's honesty entry) ·
docs/decisions.md (artifacts as the durable record).
