# T-046 — Post-kill settle deadline: a bounded wait after the verified tree kill, loud abandonment instead of a wedged run

**Status:** done 2026-10-23
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

- [x] **Red bar recorded first** (AGENTS #8), token-free: a stub process
      that escapes the tree kill's reach while holding an inherited stdout
      pipe (e.g. spawns a detached long-sleep child sharing the pipe, then
      the root exits — the check script constructs the exact shape and
      documents it) driven through today's `runChildWithTimeout` with a
      short `timeoutMs` and an outer guard that marks the never-settling
      promise as RED — the check fails on main.
- [x] Green, abandonment: the same scenario post-change — the call settles
      within `timeoutMs + settle window + slack`, returns
      `timedOut: true`, carries the `CLEANUP FAIL: … abandoning the wait`
      line in `cleanupFailures`, and the parent process holds no open
      handle to the stub's pipe (asserted by the check's own exit) —
      pinned by the same check.
- [x] Green, no regression in the normal path: a child killed cleanly at
      expiry produces byte-identical results to today (kill success line,
      `exitCode: null`, no abandonment line) — pinned by the existing
      Gate 1.12 S4 checks riding green unchanged.
- [x] Probe core: the same red/green pair against `executeProbeCommand` —
      pinned by the same check (or a sibling script), token-free.
- [x] The settle window is a documented constant exported for the pinning
      gate (the `MAX_RETRY_FINDINGS` pattern), never a CLI knob — pinned
      by the check asserting the export.
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6) — pinned
      by the full fast tier ALL GREEN.
- [x] **Gate 2 owed** (`src/` changed); trigger analysis recorded at
      landing. **Gate 3 n/a**.

## Landed

2026-10-23, Gate 1.31 (`scripts/check-settle-deadline.mjs`, wired into
`scripts/verify.mjs`'s fast tier). What changed:

- `src/worker/run-with-timeout.ts` — `KILL_SETTLE_WINDOW_MS = 15_000`
  exported (documented constant, never a knob); `runChildWithTimeout`
  arms the settle window at expiry in EVERY branch (kill-fired or not —
  a child that already exited can still wedge the wait through a
  pipe-holding descendant, and that shape gets no kill at all); on
  overrun it resolves `{ timedOut: true, exitCode: null }` with the loud
  `CLEANUP FAIL: child did not settle 15s after verified tree kill —
  abandoning the wait (evidence follows in the log)` line in
  `cleanupFailures` and the log, destroys both stdio streams, and the
  run proceeds. Normal path byte-identical (Gate 1.12 S4 riding green,
  all 30 assertions). The window constant is 15s, not the ticket's
  illustrative "e.g. 60s": the verified kill completes synchronously
  before the window is armed and close delivery after a verified kill is
  sub-second, so 15s is a >10x margin while keeping the pinning gate's
  two abandonment faces at seconds each.
- `src/probe.ts` — `executeProbeCommand` gains the same settle window
  (importing the same constant — one source) and is now exported for the
  pin (the `snapshotTree` precedent); no other probe change.
- `src/kill-tree.ts` untouched, no core unification, no verdict
  semantics anywhere (the abandonment line is cleanup-failure evidence).

Measured gates: red bar at pristine main (4c99300) — 11 failures of 13,
exit 1 (worker core A1 forever-hang, outer guard at 26014ms); red bar at
the export-only intermediate (one word, no behavior change) — 15 failures
of 19, exit 1 (BOTH cores' never-settling faces red, guards at
26012/26088ms, both escapers alive); post-change Gate 1.31 ALL GREEN —
19 assertions, exit 0, both faces settling ~16s (1s + 15s window),
escapers demonstrably alive at abandonment, check process draining
naturally. Gate 0 typecheck exit 0; Gate 1.12 all 30 assertions green
riding unchanged; full fast tier ALL GREEN in the lane.

**Gate 2 owed** — trigger analysis: `src/worker/run-with-timeout.ts` is
the timed-run core under BOTH worker adapters (machine + opencode), and
`src/probe.ts` is the probe execution path — "any adapter / anything
that changes report shape" territory (the abandonment line flows through
`cleanupFailures` into `WorkerResult`/`GateResult`). The standard real
e2e run rides the new bounded wait inertly: no healthy leg reaches
expiry + window, so the run's shape is unchanged; a real-run
abandonment needs a real wedge and is not asserted (the no-regression
half is what Gate 2 pins). **Gate 3 n/a** — the adapter files themselves
are untouched.

## Verification

Gate 1.31 (`scripts/check-settle-deadline.mjs`): the escaping-child red
bar, the abandonment green (both cores), the exported constant + single
source + no-knob pins. Gate 0, Gate 1.12 riding green, full fast tier
ALL GREEN; Gate 2 owed and recorded above.

## References

src/worker/run-with-timeout.ts:35-77 (the wait shape) · src/probe.ts:586-636
(the probe core's identical shape), :1604-1620 (per-case full-timeout
amplifier) · src/kill-tree.ts (verification, untouched) · src/lock.ts:1-11
(the never-reap policy this de-wedges) · src/runner.ts:378-426
(`driveJobs` — the drain that never fires on a wedged attempt) ·
docs/tickets/T-011 (the kill hardening this extends, not changes) ·
2026-10-23 adversarial review finding F6.
