# T-053 — Log-write loss made loud: first-failure-per-path cleanup evidence (register R12)

**Status:** done 2026-10-24
**Category:** engine
**Value (1-5):** 2 · **Risk (1-5):** 2
**Depends on:** —

## What

"Logging must never break a run" is the right posture — but today it also
means a run can complete with a completely empty `worker.log` and nothing
anywhere in the record saying evidence was lost. Every log write in the
worker-run path swallows its failures silently: `drain`/`appendLine`
(`src/worker/run-with-timeout.ts:81-102`) and both adapters' `appendLog`
(`src/worker/opencode.ts:112-118`, `src/worker/machine.ts:120-126`) catch
all write errors with no recorded trace. A full disk, a locked file
(antivirus/indexer holding a handle), or an unwritable path yields a
silently-empty log that a human later reads as "the worker produced
nothing" — indistinguishable from the no-op derailment class, and worse
than useless as evidence.

The change — surface the loss through the vocabulary that already exists:

1. **First-failure-per-path recording**: each log-write site, on its FIRST
   failure for a given path within one attempt, pushes one line through
   the existing `cleanupFailures` channel —
   `LOG WRITE FAILED after <N> bytes at <path>: <err> — log evidence
   incomplete from this point` — subsequent failures for the same path add
   nothing (no spam from a chatty child on a broken path). The channel
   already flows to `WorkerResult.cleanupFailures` → the runner's
   aggregation → `CandidateReport.cleanupFailures` (T-011), so the
   dashboard/report/store surfaces come free.
2. **Run never breaks**: the swallow stays (the posture is unchanged —
   this records, it does not throw); a candidate whose log could not be
   written still completes and is still verdicted by its gates alone.

Scope: the worker-run core (`run-with-timeout`) and both adapters.
Deliberately carved: probe bundle/log writes (their write failures are
already console-logged at the call site, and the probe layer is a separate
slice), and gate output capture (CommandGate buffers in memory; its
`exec` callback cannot lose bytes to a file).

## Why

R12's disposition was `ticket-later`. Small, honest, and it removes a
silent ambiguity in exactly the evidence stream the new yield
instrumentation (T-049) and the Known issue #6 diagnosis method depend on
— worker.log is the primary derailment-forensics artifact, and a silently
empty one poisons every conclusion drawn from it.

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free: drive
      `runChildWithTimeout` with `logPath` pointing at a path that cannot
      be appended to (deterministic on Windows: a directory path —
      appendFileSync throws EISDIR) — on main the run completes with zero
      recorded trace of the loss; the check asserts the silence on main as
      the red bar.
- [ ] Green: the same drive post-change completes (never breaks) AND
      `cleanupFailures` carries exactly one line naming the path, the
      byte count at failure, and the error — pinned by the same check.
- [ ] No-spam pin: a child writing many chunks after the first failure
      adds exactly ONE line (first-failure-per-path) — pinned by the same
      check.
- [ ] Healthy path byte-identical: with a writable log, no
      `cleanupFailures` field appears and all existing Gate 1.12/1.17
      checks ride green unchanged — pinned by the same check plus the
      existing checks.
- [ ] Adapter surfaces: the pre-run `appendLog` argv-line failure in BOTH
      adapters surfaces through the same channel into
      `WorkerResult.cleanupFailures` — pinned by the same check (stub
      adapter drives, the Gate 1.17 precedent).
- [ ] Verdict inertness: a log-write-failed candidate's `ok`/`passedAllGates`
      are computed exactly as today — pinned by the same check.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) — pinned
      by the full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (`src/worker` core touched — the trigger list);
      trigger analysis recorded at landing. **Gate 3 n/a.**

## Landed

`src/worker/run-with-timeout.ts` gained the exported `LogWriteLoss`
recorder (`createLogWriteLoss`): one per attempt, first-failure-per-path,
counting landed bytes so the line — `LOG WRITE FAILED after <N> bytes at
<path>: <err> — log evidence incomplete from this point` — carries the true
evidence offset. `drain`/`appendLine` now record their write failures
through it (the swallow stays; nothing throws), and the lines merge into
the returned `cleanupFailures` ahead of the kill evidence. Both adapters
(`src/worker/opencode.ts`, `src/worker/machine.ts`) create the recorder,
route their pre-run `appendLog` failure through it, and pass it into the
core via the new optional `RunChildTimeoutOptions.logWriteLoss` — so a
broken log path yields exactly ONE line on `WorkerResult.cleanupFailures`
no matter how many writes fail. No engine code outside `src/worker/`
changed; the channel (T-011 aggregation at src/runner.ts:1138 →
`CandidateReport.cleanupFailures`) is untouched and nothing in any verdict
reads the line (the ladder at src/runner.ts:1323 stays
gates-every-passed + diffBytes).

Deviations from the ticket text: none in behavior — one fixture deviation
recorded in VERIFICATION.md's Gate 1.39 section: the mid-run-loss fixture
is the Windows read-only attribute (EPERM), not a deleted file, because
`appendFileSync` recreates a missing file and never throws ENOENT
(discovered while writing the check; the always-broken fixture is the
ticket's own EISDIR-on-a-directory, verified on this host). Gate numbers
measured: red bar (final check version vs main's engine at the lane)
`C:\swarm\verify-red\T-053-redbar.log` — exit 1, 11 failures of 25, all
five loss legs showing the silent `[]`/undefined face; post-change Gate
1.39 ALL GREEN, 35 assertions, ~4s; full fast tier ALL GREEN (Gate 0 +
Gates 1.5–1.39) in the same change-set. Gate 2: TRIGGERED and owed
(worker core + both adapters on the trigger list) — carried by the driving
full tier; Gate 3 n/a (no harness directory-resolution surface touched).

## Verification

Gate 1.39 (VERIFICATION.md, `scripts/check-log-write-loss.mjs`): EISDIR
red bar (A1), one-line green, no-spam (A2), honest landed-byte count
(B1), healthy-path byte-identity + empty-array shape (A3/C3), both
adapters' pre-run line with verdict bits pinned in both directions
(C1/C2), verdict inertness (behavioral C1/C2 + source pins D1-D3).
Gate 0 + full fast tier ALL GREEN; Gate 2 owed and recorded as triggered;
Gate 3 n/a.

## References

docs/adversarial-review-2026-10-23.md R12 (the disposition this promotes) ·
src/worker/run-with-timeout.ts:81-102 (drain/appendLine — the swallow
sites) · src/worker/opencode.ts:112-118, src/worker/machine.ts:120-126
(the adapters' appendLog) · src/types.ts (`WorkerResult.cleanupFailures`,
the T-011 channel this rides) · src/runner.ts:1014-1016 (the aggregation
site) · VERIFICATION.md Known issue #6 (the worker.log forensics this
protects) · docs/tickets/T-011 (the cleanupFailures vocabulary), T-049
(the consumer that most needs trustworthy worker.logs).
