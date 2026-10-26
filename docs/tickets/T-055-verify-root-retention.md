# T-055 — Verify-root evidence retention: the full tier stops destroying prior Gate 2 run evidence

**Status:** proposed
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

- [ ] **Red bar recorded first** (AGENTS #8), token-free: against the OLD
      behavior (extracted or reproduced), a verify root holding two fixture
      run dirs is wiped with nothing archived — asserted as the red bar.
- [ ] Green, retention: the same fixture through the new helper — both run
      dirs land under `verify-archive/`, the live root is empty, and the
      most recent ARCHIVE_KEEP_RUNS are kept while older archives are
      deleted — pinned by the new fast-tier check.
- [ ] Green, live assertion: the updated full-tier assertion passes with
      an archived-history root (its exactness unchanged for the live root)
      — pinned by the same check driving the assertion's predicate with
      fixtures.
- [ ] Non-timestamped entries (locks/, verify-red/, strays) are never
      moved or deleted by the helper — pinned by the same check.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6): the
      retention rule, the constant, the archive root, and a note that the
      T-049 incident (run `20261024021432`) motivated this — pinned by the
      full fast tier ALL GREEN.
- [ ] **Gate 2**: `scripts/verify.mjs` itself changed, but no `src/`
      engine surface — trigger analysis recorded at landing per the T-041
      precedent (if the analysis lands "owed" because the tier's own
      behavior changed, the next full run IS the evidence); **Gate 3 n/a.**

## Landed

## Verification

New fast-tier check (next free gate number at landing): wipe red bar,
archive/keep/delete green, live-assertion predicate, non-timestamped
safety. Gate 0, full fast tier ALL GREEN; Gate 2 trigger analysis recorded.

## References

scripts/verify.mjs:14, :1067, :1101, :1129-1131 (the reset, the run root,
the assertion) · VERIFICATION.md Known issue #6 (the 2026-10-24 incident —
run `20261024021432` wiped), the T-049 lane note · docs/tickets/T-049 (the
discovery), T-033 (the cite-the-artifacts convention's honesty entry) ·
docs/decisions.md (artifacts as the durable record).
