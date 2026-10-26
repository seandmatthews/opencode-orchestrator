# T-054 — Known issue #10's owed code change: a provably-dead tree stops being reported as a cleanup failure (the captured fifth observation's fix)

**Status:** done 2026-10-25
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 3
**Depends on:** —

## What

VERIFICATION.md Known issue #10 ("a verified-dead tree can still be REPORTED
as a cleanup failure on a transient snapshot/kill hiccup") records five
observations across T-011..T-052's lanes; its own threshold clause — "code
change MET on next recurrence, pending captured diagnosis" — is now due:
T-052's lane captured the previously-missing line AND the diagnosed leg
(commit `d5d1f8e`, the issue's fifth observation). This ticket lands the fix
that clause promises.

**The implementer MUST drive the mechanism from the recorded diagnosis**
(VERIFICATION.md Known issue #10, fifth observation + the T-052 lane's
captured line) — not from this ticket's paraphrase. The candidate surface in
`src/kill-tree.ts` (read 2026-10-25): `killTreeVerified` reports
`verified: false` on three legs — root already gone at the alive check
(:59-61), snapshot failure proceeding unverified (:73-80), and post-kill
survivors (:82-88) — and `killFailureLines` (:143-153) turns the first two
into loud `CLEANUP FAIL:` lines even when the OUTCOME is provably good (a
root that died in the expiry-to-kill race has no tree left for THIS kill to
leak; a snapshot failure followed by a clean post-kill re-verification
proves the kill worked). The invariants that must NOT move: genuine
survivors keep their per-pid lines; a truly unverifiable outcome stays loud
(fail-closed — the T-011 posture); `snapshotTree`'s throw-and-proceed
(:73-80 comment) never skips a kill; Known issue #8's dead-roots caveat is
untouched (a dead root never RELIES on taskkill reaping reparented
descendants — the fix may only stop REPORTING what post-hoc liveness
proves dead).

Shape (mechanism owned by the diagnosis): add the missing verification leg —
e.g. on `rootWasLive: false` and on snapshot-failure, one post-kill
liveness re-check that can UPGRADE the outcome to verified-when-proven-dead
(keeping the loud line only when something is actually alive or genuinely
unverifiable) — plus whatever narrower form the recorded leg demands.
Known issue #10's entry updated in the same change-set (the fifth
observation's disposition becomes "fixed by Gate <N>", the class retired or
narrowed to what remains loud).

## Why

Five observations is the issue's own threshold; the diagnosis is captured;
the flake class costs every timed-out leg a spurious `cleanupFailures`
entry that humans (and T-049's yield markers) must then hand-triage. The
honesty property is preserved exactly: the fix makes the report MORE
accurate (proven-dead is not a failure), never less loud.

## Acceptance criteria

- [x] **Red bar recorded first** (AGENTS #8), token-free: the diagnosed leg
      (driven via `killTreeVerified`/`killFailureLines` with the recorded
      shape — stubbed snapshot/liveness where needed, injected per the
      T-052 identity-probe precedent) produces a `CLEANUP FAIL:` line on
      main for an outcome the post-hoc check proves good — asserted as the
      red bar. *(Landed: `scripts/check-kill-verify-upgrade.mjs` final
      version vs main's engine at the lane — exit 1, 9 failures of 33, teed
      `C:\swarm\verify-red\T-054-redbar.log`; the R leg's REAL-failure drive
      printed `CLEANUP FAIL: pid 32420 tree kill could not be verified
      (descendant verification unavailable)` for a real planted tree the
      same leg proves dead on the real process table.)*
- [x] Green: the same leg post-change reports the verified-dead outcome
      with NO failure line (the success line or a silent-good result per
      the diagnosis) — pinned by the same check. *(Gate 1.40 ALL GREEN, 33
      assertions, two consecutive runs.)*
- [x] Never-weakened pins: genuine survivors still emit per-pid lines; a
      genuinely-unverifiable outcome (re-check also impossible) still emits
      its loud line — pinned by the same check, both legs. *(Legs C/F and
      B/D/R respectively.)*
- [x] Existing kill checks ride green unchanged (Gate 1.12's suite; any
      pin that asserted the OLD spurious line for the diagnosed shape is
      updated with the reasoning recorded — strengthened-or-equal, the
      T-044 precedent). *(Gate 1.12 ALL GREEN, 30 assertions, unchanged —
      and a grep over `scripts/` for "could not be verified" found NO pin
      asserting the old spurious line for the diagnosed shape, so no pin
      needed updating; the clause is satisfied vacuously.)*
- [x] Known issue #10's VERIFICATION.md entry updated in the same
      change-set (AGENTS #6): the fix, the gate number, the disposition of
      the five observations — pinned by the full fast tier ALL GREEN.
- [x] **Gate 2 owed** (`src/` kill/timeout core touched — the trigger
      list); trigger analysis recorded at landing. **Gate 3 n/a.**

## Landed

Lane `ticket/T-054-cleanup-flake-proven-dead`, 2026-10-25. One mechanism,
driven from the recorded diagnosis (the fifth observation: root live at
kill time, the snapshot/verification leg, the tree verifiably dead while
the log carried the unverified shape):

`src/kill-tree.ts` — the snapshot-failure leg no longer condemns the
outcome to `verified: false` by itself. On a snapshot throw: ONE immediate
pre-kill retry — when it lands, the full original verification (pre-kill
pid list, post-kill sweep) runs unchanged; when it also fails, the kill
STILL FIRES (never skipped — the T-011 invariant) and ONE post-kill
liveness re-check (`killUnverifiedThenRecheck`) gets the last word:
everything the re-check can still link to the root proven dead upgrades
the outcome to verified-when-proven-dead (`verified: true`, the success
line, no failure line); anything alive keeps its per-pid line; a re-check
that also cannot run keeps the exact pre-T-054 loud unverifiable shape
(fail-closed). The verification lenses are injectable per the T-052
identity-probe precedent: new exported `KillTreeDeps`
(`{snapshotTree?, isAlive?}`, defaulting to the real machinery), so every
call site (`src/gate/command.ts`, `src/worker/run-with-timeout.ts`,
`src/recover.ts`'s `killTree`, the probe layer) is unchanged. `reaped` on
the upgrade path honestly counts the re-check's OWN enumeration (the
pre-kill tree's size is unknowable when its snapshot failed); the upgrade's
bounded named weakness — a descendant no longer linked to the root could
evade the re-check sweep — is documented in the code and in
VERIFICATION.md, and is still strictly stronger than the unconditional
`verified: false` it replaced. `killFailureLines`'s contract is unchanged
byte-for-byte for every shape it already had; only the NEW verified-dead
class (the upgrade) maps to no line.

Scope decision recorded (the ticket's "whatever narrower form the recorded
leg demands" clause): the `rootWasLive: false` leg is NOT upgraded. The
recorded diagnosis names the snapshot/verification leg only; the dead-root
shape is pinned in two places this ticket must not move — Known issue #8's
entry ("a root already gone at kill time is the reported result
`{rootWasLive: false, verified: false}` — unverifiable, never silently
success") and Gate 1.12's S3 pin — and on Windows a dead root's descendants
may outlive it, so no post-hoc check this side of Known issue #8's open
question could prove that outcome good. The dead-root leg keeps its named
line byte-for-byte (pinned by Gate 1.40's leg B).

New fast-tier check `scripts/check-kill-verify-upgrade.mjs`, wired as
**Gate 1.40** (`scripts/verify.mjs`, after 1.39; VERIFICATION.md's Gate
1.40 section + Known issue #10's 2026-10-25 disposition written in the
same change-set). Legs: A the diagnosed transient leg (one snapshot
failure → bounded retry → verified-dead, full tree in `reaped`, no failure
line); B the pure reporting surface (verified-dead → no line + success
line; survivor/unverifiable/dead-root shapes keep their named lines
verbatim); C survivors keep per-pid lines through the NORMAL path; D
genuinely-unverifiable stays loud with bounded attempts and the kill never
skipped; E the post-kill re-check upgrade (fails twice pre-kill, the real
snapshot answers the re-check → verified-dead, no failure line); F the
re-check stays loud on a live process (forced-alive root — a kill that did
not take); R the REAL-failure leg (every WindowsPowerShell PATH segment
stripped, both preconditions asserted — the T-052 check's R6 mechanic —
real planted tree, real ENOENT snapshot, fail-closed end to end).

**Red bar** (AGENTS #8), recorded on main's engine at the lane before the
change (final check version): exit 1, 9 failures of 33, teed
`C:\swarm\verify-red\T-054-redbar.log`. Composition, the T-052 pattern:
the transient legs' pins failed because the injected seam cannot exist on
main (the stub argument is ignored and the REAL snapshot runs — A's
call-count, C's and F's survivor pins, D's shape/loudness/attempts pins,
E's call-count); and the leg R REAL-failure drive reproduced the fifth
observation's signature END TO END on main —
`CLEANUP FAIL: pid 32420 tree kill could not be verified (descendant
verification unavailable)` printed by a real PowerShell-unresolvable
snapshot failure around a real killed tree whose death the same leg's
real-process-table assertions prove (`R: the kill was never skipped —
whole tree dead on the real process table`, ok in the same run). No pin
asserting the OLD spurious line for the diagnosed shape existed anywhere
in `scripts/` (grep for "could not be verified": only the source's own
line), so the strengthened-or-equal clause needed no pin update.

**Gate numbers measured:** red bar as above; post-change Gate 1.40 ALL
GREEN (33 assertions) on two consecutive runs; Gate 1.12's suite ALL GREEN
unchanged (30 assertions — the dead-root S3 pin and the live-kill S5 pin
untouched); Gate 1.17 (the fifth observation's own check), Gate 1.31,
Gate 1.39, and Gate 1.15 each ALL GREEN standalone; full fast tier (Gate 0
+ Gates 1.5–1.40) ALL GREEN via `node scripts/verify.mjs fast` (exit 0,
teed `C:\swarm\verify-red\T-054-lane-fast.log`, Gate 1.40 riding the tier
at 33 assertions and Gate 1.12 at 30) in the same change-set.

**Gate 2 trigger analysis** (the T-041/T-052 precedent): TRIGGERED and
owed — `src/kill-tree.ts` is the kill/timeout core named by the trigger
list, and both its consumers (`src/gate/command.ts` gate-timeout kills,
`src/worker/run-with-timeout.ts` worker-timeout kills) sit on real-run
paths. Carried by the driving full tier (not run in the lane — model
tokens); what Gate 2 must show is unchanged from before this change-set:
a real run's timeout legs kill and verify exactly as pinned, with the one
behavioral difference that a transient snapshot hiccup on a real-run kill
now upgrades to verified-dead instead of recording a spurious
`cleanupFailures` entry (evidence-only; no verdict reads it). **Gate 3
n/a** (no adapter, no harness spawn changed).

## Verification

Gate 1.40 (VERIFICATION.md, `scripts/check-kill-verify-upgrade.mjs`): the
diagnosed-leg red bar and the proven-dead green (A), the pure reporting
pins in all four directions (B), the never-weakened legs — survivors on
the normal path (C), genuinely-unverifiable loud with the kill never
skipped (D), the re-check's upgrade (E) and its loud direction (F), and
the REAL-failure fail-closed drive (R). Gate 0 green; Gate 1.12's suite
green unchanged; full fast tier ALL GREEN; Gate 2 owed and recorded as
triggered (carried by the driving full tier); Gate 3 n/a.

## References

VERIFICATION.md Known issue #10 (the threshold clause + the fifth
observation — the driving diagnosis), #8/#9 (the caveats this must not
disturb) · src/kill-tree.ts:58-89, :143-153 (the reporting surface) ·
src/worker/run-with-timeout.ts + src/probe.ts (the consumers of
`cleanupFailures`), src/recover.ts (the identity-probe injection
precedent, T-052) · docs/tickets/T-011 (the loud-by-design posture this
refines), T-052 (the lane that captured the diagnosis) · commit `d5d1f8e`.
