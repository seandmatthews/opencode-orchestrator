# T-052 — Lock release verifies ownership; recover's identity check fails closed (register R4)

**Status:** done 2026-10-24
**Category:** ops
**Value (1-5):** 3 · **Risk (1-5):** 3
**Depends on:** —

## What

Two fail-open seams in the mutual-exclusion and recovery machinery (register
R4). Both fixes point the same direction as the engine's own refusal
vocabulary: when verification cannot run, refuse — never proceed on an
unverified premise.

1. **Lock release without ownership verification** (`src/lock.ts:121-127`).
   `releaseCheckoutLock` unlinks whatever occupies the path. Sequence: A
   holds; B force-acquires (`--force-lock` unlinks A's file, writes B's,
   :90-96); A finishes and its `finally` release deletes **B's** lock —
   mutual exclusion breaks in exactly the scenario `--force-lock` exists
   for (A was suspected stale but wasn't). Fix: before unlinking, read the
   file and compare its recorded `pid` to `process.pid`; on mismatch, skip
   with a loud line ("lock at `<path>` is held by pid `<n>` — force-taken;
   not releasing") and on an unreadable file, skip loudly too (never delete
   what you cannot identify). Missing file stays today's ENOENT-is-ok. The
   lock CLI's `release` verb stays the explicit human override (its usage
   text says so — it runs in its own process and never matches the holder;
   it is the `--force-lock` counterpart for release, not a bug).
2. **Recover's identity check fails open** (`src/recover.ts:258-273`).
   `identityMatches` returns `{ ok: true }` whenever the process creation
   time is UNAVAILABLE — PowerShell missing/blocked/AV-interfered (the 15s
   timeout catch at :229-234), a protected process, a non-Windows host —
   and also when the dispatch stamp is unreadable or the creation time
   unparseable. On a machine where PowerShell is broken, EVERY kill
   degrades to alive-check-only, and Windows pid reuse means a stale
   dispatch pid can name an unrelated live process that recover then
   tree-kills (:562). Fix: identity-unavailable → refuse-to-kill that pid,
   with a loud record ("identity could not be established (`<reason>`) —
   NOT killing pid `<n>`; kill it manually if it is a leftover") — the
   conservative posture, because tree-killing an innocent reused pid is
   unrecoverable while a skipped leftover is a human's one-line fix. The
   creation-time probe becomes injectable for the check (defaulting to the
   real spawn) so the unavailable-path is deterministic to test. The
   tradeoff is accepted and documented: machines where PowerShell cannot
   run degrade to report-only recovery — stated in VERIFICATION.md, not
   discovered in an incident.

Non-goals: changing `--force-lock` acquisition semantics; the
never-auto-reap policy (unchanged — this makes the policy hold under
takeover, not weakens it); Job Objects (the standing deferral).

## Why

R4's disposition was `ticket-later` with this scope. Both seams are
fail-open in the one subsystem whose entire job is to be trustworthy when
everything else is on fire (post-crash), and both violate the rule the rest
of the engine already lives by — mechanism over premise. The ownership fix
is a few lines; the recover fix is a posture change with a documented,
accepted degradation.

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free: (a) the takeover
      sequence — A acquires, B force-acquires, A releases — on main A's
      release DELETES B's lock (the bug asserted as the red bar); (b) the
      identity-unavailable path — with an injected probe answering
      unavailable, today's `identityMatches` returns ok (asserted red).
- [ ] Green, ownership: the same sequence post-change ends with B's lock
      INTACT, A's release skipping with the loud line; a normal
      acquire/release pair still releases (every existing Gate 1.5 lock
      check rides green unchanged) — pinned by the same check.
- [ ] Green, unreadable-lock skip: a lock file with garbage contents is
      never unlinked by programmatic release (loud skip) — pinned by the
      same check.
- [ ] Green, CLI override: `tsx src/lock.ts release <repo>` still drops any
      holder (the documented human override) — pinned by the same check.
- [ ] Green, fail-closed recover: identity-unavailable → no kill attempted
      for that pid, the loud record present; identity-available-and-matching
      → kill proceeds exactly as today; identity-available-and-MISMATCHED →
      refused (existing behavior, now pinned) — pinned by the same check
      (or its recovery-check extension).
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6), carrying
      the accepted degradation (PowerShell-broken machines = report-only
      recovery) — pinned by the full fast tier ALL GREEN.
- [ ] **Gate 2**: no runner/adapter/report-shape change (lock + recover
      seam only) — trigger analysis recorded at landing per the T-041
      precedent; **Gate 3 n/a.**

## Landed

Lane `ticket/T-052-lock-ownership-recover-failclosed`, 2026-10-24. Two
changes, exactly the ticket's scope:

1. **Lock release verifies ownership** — `src/lock.ts`:
   `releaseCheckoutLock` reads the lock file before unlinking and releases
   only a lock whose recorded `pid` is `process.pid`. A foreign pid (a
   `--force-lock` taker's replacement) skips loudly (`lock at <path> is
   held by pid <n> — force-taken; not releasing`); an unreadable or
   unparseable file skips loudly too (never delete what you cannot
   identify — the line names the CLI override); a missing file stays the
   pre-T-052 ENOENT-is-ok. New `forceReleaseCheckoutLock` is the CLI
   `release` verb's primitive — the explicit human override, dropping ANY
   holder, with the usage text extended to say so. Acquisition
   (`--force-lock` semantics) untouched, per the non-goals.
2. **Recover's identity check fails closed** — `src/recover.ts`:
   `identityMatches` (now exported, probe-injectable) returns
   `{ ok: false, unavailable: true }` for every identity-unavailable
   class — probe null (PowerShell missing/blocked/AV-interfered, a
   protected process, a non-Windows host), dispatch stamp unreadable,
   creation time unparseable — instead of the pre-T-052 ok-with-
   alive-check-only. The kill decision is extracted as `reconcileKills`
   (same position in `main`, behavior for the available classes
   unchanged) and records the new `identity-unavailable` cleanup-failure
   class with the mandated loud message (`identity could not be
   established (<reason>) — NOT killing pid <n>; kill it manually if it
   is a leftover`) in stdout and recovery.json. The creation-time probe is
   the `CreationTimeProbe` seam, defaulting to the real PowerShell spawn.
   `recover.ts` also gained the `src/lock.ts` run-directly entry guard so
   checks import the seam without executing a reconciliation. The
   accepted degradation — PowerShell-broken machines degrade to
   report-only recovery — is stated in VERIFICATION.md (Gate 1.38 + the
   Gate 1.11 note), not left for an incident to discover.

**Red bar** (AGENTS #8), recorded on main's engine at the lane before the
change (final check version): `scripts/check-lock-ownership.mjs` exit 1,
9 failures, teed to `C:\swarm\verify-red\T-052-redbar.log` — (a) the
takeover sequence: A acquired, B force-acquired, A's release DELETED B's
lock (both L2 legs failed), and the garbage lock was unlinked (L3) — no
loud lines existed; (b) with PowerShell unresolvable (both R6
preconditions green — resolves normally on the full PATH, ENOENT with
every `WindowsPowerShell` PATH segment stripped), the real `recover`
command did not refuse: it tree-killed the pid it could not verify (exit
was not 1, the orphan was dead, recovery.json recorded the kill) — the
fail-open posture demonstrated end to end. The injected-probe seam itself
cannot exist on main (the R1-R5 driver died on the missing export,
recorded as that wrapper leg's failure); the seam is introduced BY this
change-set, and its unavailable-path red is the R6 leg above.

**Gate 2 trigger analysis** (the T-041 precedent): NOT triggered — the
change-set touches `src/lock.ts` and `src/recover.ts` only (the lock +
recover seam); nothing on the trigger list (src/runner.ts, adapters,
gates, workspace handling, report shape) changed; a real run takes and
releases its own lock on every path exactly as before (Gate 1.38's L1/L5
pin the acquire/release and force-acquire/release pairings). **Gate 3
n/a** (no adapter; no harness spawn changed).

## Verification

New fast-tier check `scripts/check-lock-ownership.mjs` wired as **Gate
1.38** (`scripts/verify.mjs`; VERIFICATION.md's Gate 1.38 section plus the
Gate 1.5 lock-ownership note and the Gate 1.11 fail-closed note written in
the same change-set). Lock legs: normal acquire/release pair releases
silently; the takeover sequence (A acquires, B CLI-force-acquires, A's
programmatic release) ends with B's lock intact byte-identical plus the
loud skip line; a garbage lock is never unlinked by programmatic release;
the CLI `release` verb drops a foreign-pid holder and an unreadable lock;
a force-taker's own release pairs silently. Recover identity legs, against
real live children on the real process table: probe-null, stamp-
unreadable, and time-unparseable each refuse with the loud record in the
cleanup failure and stdout, the child untouched; identity-available-and-
matching kills exactly as today (real tree kill, child dead); MISMATCHED
refused as `identity-mismatch` (existing behavior, pinned); and
end-to-end through the real `recover` command with PowerShell
unresolvable (both PATH preconditions asserted, so a machine where the
unavailability cannot be forced fails the leg loudly instead of running
it vacuously) — exit 1, the loud record in stdout AND recovery.json, the
orphan still alive, the checkout lock still released. Gate 0 green; the
new check ALL GREEN (30 ok lines, ~3s, two consecutive runs); full fast
tier ALL GREEN via `node scripts/verify.mjs fast` — Gate 1.5's lock
checks and Gate 1.11's recovery checks riding green unchanged; Gate 1.12
(kill-tree) and Gate 1.18 (gc, the other lock consumer) standalone green.
Gate 2 trigger analysis recorded above (not triggered); Gate 3 n/a.

## References

docs/adversarial-review-2026-10-23.md R4 (the disposition this promotes) ·
src/lock.ts:82-127 (acquire/release — the takeover shape) ·
src/recover.ts:229-273, :562 (the probe, the fail-open check, the kill
site) · VERIFICATION.md Known issue #8-#10 (the dead-roots/recovery
context) · docs/tickets/T-004 (the lock's never-reap policy this
protects), T-010 (recovery's verify-before-kill promise this makes true).
