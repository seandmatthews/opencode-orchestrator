# T-046 — Post-kill settle deadline: a bounded wait after the verified tree kill, loud abandonment instead of a wedged run

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 3
**Depends on:** —

## What

Both timed-run cores resolve only on the child's `'close'` event
(`src/worker/run-with-timeout.ts:43-46`; the probe core
`src/probe.ts:586-636`). At expiry they fire `killTreeVerified` — and if the
kill cannot finish the job (an ACL-protected or suspended root; a descendant
that escaped the `/T` tree; any survivor holding an inherited stdio pipe),
`'close'` never fires, the promise never settles, and **there is no
secondary deadline anywhere**. The attempt hangs, the run hangs
(`driveJobs` never drains), and because runs serialize per-repo through a
lock nothing ever reaps (`src/lock.ts`), the target repo is unusable until
a human kills processes by hand and `--force-lock`s. Kill failures are
honestly recorded as `cleanupFailures` — but only once the run moves on,
which it never does.

The wall-clock amplifier: the adversarial probe grants each of its ~20
corpus cases the full gate timeout (default 5 min), so one candidate whose
target sleeps on argv input costs ~100 minutes per probe with the lock held
the whole time — a cheap accidental (or deliberate) denial of service
exactly where the system is at its most autonomous.

The change — a settle deadline at both sites, the fail-closed-with-evidence
posture:

1. After the verified tree kill fires at expiry, start a bounded secondary
   window (a constant, e.g. 60s — no knob, the `MAX_RETRY_FINDINGS`
   precedent). If `'close'`/exit arrives inside it: today's behavior
   byte-for-byte (the kill lines, `timedOut`, `exitCode` semantics
   unchanged).
2. If it does not: resolve anyway — `timedOut: true`, `exitCode: null`, and
   a loud `CLEANUP FAIL: child did not settle <N>s after verified tree
   kill — abandoning the wait (evidence follows in the log)` line joining
   `cleanupFailures` (the existing T-011 vocabulary, which already flows to
   `GateResult`/`WorkerResult` and the candidate report). Destroy the
   stdio streams so no handle leaks keep the parent alive. The run proceeds;
   the abandonment is recorded evidence, never a verdict input.
3. Same change in the probe core (`executeProbeCommand`) — the wedge shape
   is identical there.

Non-goals: unifying the two cores (a refactor, not this slice); changing
kill verification itself (`kill-tree.ts` untouched); any verdict semantics.

## Why

Every other degradation in this engine is loud and bounded — parse failures
degrade, persistence failures log, kills record survivors. This is the one
path where an unlucky process converts "noisy cleanup failure" into
"machine wedged until a human arrives," and it is triggerable by candidate
behavior (a target that hangs on adversarial input) rather than mere bad
luck. The fix preserves every existing honesty property (the kill is still
verified and recorded; the abandonment is a NEW loud line, not a swallowed
one) while giving the orchestration layer what it lacks: a bound.

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free: a stub process
      that escapes the tree kill's reach while holding an inherited stdout
      pipe (e.g. spawns a detached long-sleep child sharing the pipe, then
      the root exits — the check script constructs the exact shape and
      documents it) driven through today's `runChildWithTimeout` with a
      short `timeoutMs` and an outer guard that marks the never-settling
      promise as RED — the check fails on main.
- [ ] Green, abandonment: the same scenario post-change — the call settles
      within `timeoutMs + settle window + slack`, returns
      `timedOut: true`, carries the `CLEANUP FAIL: … abandoning the wait`
      line in `cleanupFailures`, and the parent process holds no open
      handle to the stub's pipe (asserted by the check's own exit) —
      pinned by the same check.
- [ ] Green, no regression in the normal path: a child killed cleanly at
      expiry produces byte-identical results to today (kill success line,
      `exitCode: null`, no abandonment line) — pinned by the existing
      Gate 1.12 S4 checks riding green unchanged.
- [ ] Probe core: the same red/green pair against `executeProbeCommand` —
      pinned by the same check (or a sibling script), token-free.
- [ ] The settle window is a documented constant exported for the pinning
      gate (the `MAX_RETRY_FINDINGS` pattern), never a CLI knob — pinned
      by the check asserting the export.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) — pinned
      by the full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (`src/` changed); trigger analysis recorded at
      landing. **Gate 3 n/a**.

## Landed

## Verification

New fast-tier check (next free gate number at landing): the escaping-child
red bar, the abandonment green, the normal-path byte-identity, the probe
core pair, the exported constant. Gate 0, Gate 1.12 riding green, full fast
tier ALL GREEN; Gate 2 owed and recorded.

## References

src/worker/run-with-timeout.ts:35-77 (the wait shape) · src/probe.ts:586-636
(the probe core's identical shape), :1604-1620 (per-case full-timeout
amplifier) · src/kill-tree.ts (verification, untouched) · src/lock.ts:1-11
(the never-reap policy this de-wedges) · src/runner.ts:378-426
(`driveJobs` — the drain that never fires on a wedged attempt) ·
docs/tickets/T-011 (the kill hardening this extends, not changes) ·
2026-10-23 adversarial review finding F6.
