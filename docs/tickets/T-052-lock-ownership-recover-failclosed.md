# T-052 — Lock release verifies ownership; recover's identity check fails closed (register R4)

**Status:** proposed
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

## Verification

New fast-tier check (next free gate number at landing): takeover red bar +
intact-lock green, unreadable skip, CLI override, the three recover
identity legs. Gate 0, full fast tier ALL GREEN (Gate 1.5's lock checks and
the recovery checks riding green unchanged); Gate 2 trigger analysis
recorded.

## References

docs/adversarial-review-2026-10-23.md R4 (the disposition this promotes) ·
src/lock.ts:82-127 (acquire/release — the takeover shape) ·
src/recover.ts:229-273, :562 (the probe, the fail-open check, the kill
site) · VERIFICATION.md Known issue #8-#10 (the dead-roots/recovery
context) · docs/tickets/T-004 (the lock's never-reap policy this
protects), T-010 (recovery's verify-before-kill promise this makes true).
