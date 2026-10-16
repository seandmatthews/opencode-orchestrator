# T-011 — In-run process-tree termination hardening (spec §15.3)

**Status:** done 2026-10-16
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** —

## What

Verified, non-silent process-tree termination on the two in-run kill paths that exist
today — gate-command timeouts and worker-harness timeouts — per spec §15.3's MVP
contract (record root PID, Windows tree termination, verify descendants disappear,
remaining descendants are cleanup failures; `docs/spec/inference-refinery-v2.md:1073-1086`).
The mechanism core already exists: `src/kill-tree.ts:8-22` is a list-form
`taskkill /pid X /T /F` (AGENTS.md #4-compliant) — but it is used only by the worker
timeout (`src/worker/opencode.ts:38-41`) and its failure mode is a silent catch
(`src/kill-tree.ts:12-14`). One mergeable change-set:

- **`src/kill-tree.ts` — the verified kill.** New exported
  `killTreeVerified(pid: number): KillTreeResult` with
  `KillTreeResult = { rootWasLive: boolean; verified: boolean; survivors: number[] }`:
  1. **Alive check first**: `process.kill(pid, 0)`. Root already gone ⇒
     `{ rootWasLive: false, verified: false, survivors: [] }` as a *reported result* —
     today's silent catch (`kill-tree.ts:12-14`) is removed. This is deliberate: the
     ticket does **not** rely on `taskkill /T /F` reaching descendants of an
     already-dead root (Windows reparenting — behavior unverified, see Why); both
     call sites below fire their kill while the root is alive by construction.
  2. **Snapshot the tree before killing**: one fixed-constant PowerShell CIM query
     (`Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId`)
     spawned list-form (`execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive',
     '-Command', <constant>], …)`) — a constant string, zero interpolation, so the
     list-form rule holds. Build the pid→ppid map, collect the root plus every
     descendant (BFS down ppid edges). Scope is descendants visible at snapshot time;
     the narrow snapshot-to-kill race is documented, and the later Job Objects helper
     is the race-free mechanism (spec §15.3:1084 "Later"; decisions.md 2026-10-10).
  3. **Kill**: the existing list-form `taskkill /pid <pid> /T /F` (`kill-tree.ts:11`)
     kept verbatim.
  4. **Verify**: `process.kill(pid, 0)` on the root and every snapshot pid. Still
     alive ⇒ collected into `survivors`, `verified: false`. False survivors are
     possible (pid reuse) and acceptable — the failure direction is loud, not silent.
  5. Non-win32 fallback stays best-effort SIGKILL of the root with `verified: false`
     and a comment + VERIFICATION.md Known-issues entry saying descendant
     verification is Windows-only today (Windows-first repo, decisions.md:27-30).
  The raw list-form taskkill stays as the internal primitive; the silent exported
  `killTree` has exactly one importer today (`src/worker/opencode.ts:5`, verified by
  read) and its call site converts — no other callers to migrate.

- **`src/gate/command.ts` — gates get tree-kill at all.** Today `CommandGate.run`
  uses `exec`'s built-in `timeout` option (`src/gate/command.ts:24-26`), which kills
  only the direct child (the shell) — the repo scout's live probe this session
  (node v22, Windows, exec + `{timeout}` against a grandparent→grandchild node tree)
  showed both grandparent and grandchild **alive** after the exec timeout, and both
  dead after a list-form `taskkill /T /F` — that probe is this ticket's recorded
  red bar. Change: capture `child.pid` from `exec` immediately; **drop the built-in
  `timeout` option**; run this class's own `setTimeout(timeoutMs)` that fires
  `killTreeVerified(child.pid)` while the shell child is alive; keep `windowsHide`,
  cwd, encoding, maxBuffer identical (`command.ts:26`); clear the timer on natural
  completion and guard double-resolve. FAIL semantics must stay exactly today's
  timeout shape: `passed: false`, `exitCode: null` (the exec-timeout error carries no
  numeric code — probe output), `durationMs ≥ timeoutMs`, `outputTail` as collected
  (`command.ts:28-36`). Survivors/verification-failures are recorded on
  `GateResult.cleanupFailures` (new optional field, below).

- **`src/worker/run-with-timeout.ts` (new) + `src/worker/opencode.ts` — the timeout
  path becomes verified, testably.** Extract the harness-agnostic core of
  `OpenCodeWorker.execute` into `runChildWithTimeout(child, {timeoutMs, logPath})`:
  waits for exit, at `timeoutMs` fires `killTreeVerified(child.pid)`, appends to the
  log `tree killed, verified: N processes reaped` on success (replacing today's
  unverified `(timed out, tree killed)` assertion, `opencode.ts:55`) and loud
  `CLEANUP FAIL: pid N survived taskkill /T /F` / `CLEANUP FAIL: root pid N already
  gone before kill; descendant verification impossible` lines otherwise, and returns
  `{ timedOut, exitCode, cleanupFailures }`. `opencode.ts` keeps only the harness
  specifics: bin path, `run -m <model>` args, and the PWD/OLDPWD pinning
  (`opencode.ts:32` — untouched, ground rule 5). The helper knows nothing about any
  harness, so Gate 1.12 can drive it with a node-spawned tree — token-free, no
  opencode binary. `WorkerResult.cleanupFailures` (new optional field) carries the
  result. Worker root-PID *recording* is **not** part of this ticket (see carve).

- **`src/types.ts` — three optional fields, one doc fix.** `GateResult`,
  `WorkerResult`, and `CandidateReport` each gain `cleanupFailures?: string[]`;
  `src/runner.ts` aggregates worker-side + gate-side failures onto the candidate's
  report entry (report.json's one place answering "did anything survive"). Fields are
  absent on every non-timeout path — happy-path reports are unchanged. The seam doc
  at `src/types.ts:17-18` ("the worker process tree is killed at expiry") is updated
  to state the verified semantics. The store is untouched: `gate_results` ingest
  selects explicit columns (`src/store/index.ts:180-182`), so the new optional fields
  simply do not persist — Gate 1.6 stays green. A cleanup failure never changes any
  verdict (`passed`, `passedAllGates`, `workerOk`, the verdict ladder): it is
  recorded evidence, consistent with gates-decide (decisions.md:19-21).

- **`scripts/check-kill-tree.mjs` + Gate 1.12 + VERIFICATION.md.** New fast-tier,
  token-free, deterministic gate claiming **Gate 1.12** — 1.7 (T-006:136-139),
  1.8 (T-007 via T-008:97), 1.9 (T-008:93-99), 1.10 (T-009:97), and 1.11
  (T-010:303-306) are claimed; per the T-008:96-99 precedent the number is the next
  free *at landing* — if ordering shifts, take the next actually-free number. Hook in
  `scripts/verify.mjs` after the last claimed gate, before the fast-tier finish at
  `scripts/verify.mjs:448`. Scenarios:
  - **S1** — `CommandGate` with a tiny timeout against a node command that spawns a
    grandchild: `passed: false`, `exitCode: null`, `durationMs ≥ timeout`, no
    cleanup failures, and every script-tracked pid asserted dead via
    `process.kill(pid, 0)`.
  - **S2** — normally-completing gate: GateResult identical to today's shape, no
    `cleanupFailures` key (happy-path regression pin).
  - **S3** — `killTreeVerified` on a nonexistent pid: returns
    `{rootWasLive: false, verified: false}` as a reported result, no throw, no
    silence (the removed-catch regression pin).
  - **S4** — `runChildWithTimeout` with a node tree and tiny timeout: `timedOut:
    true`, tree dead, log lines asserted, no opencode involved.
  - **S5** — snapshot-depth sanity: the pre-kill enumeration contains the planted
    grandchild pid.
  VERIFICATION.md gains the Gate 1.12 section plus Known-issues entries for the
  dead-root non-reliance and the POSIX verification limitation, in the same
  change-set (AGENTS.md #6). This mechanizes AGENTS.md #10 ("kill spawned dev
  processes") instead of leaving it a manual habit.

**Does NOT claim:**

- **Worker root-PID durable recording and all recovery-side kills** — T-010's
  explicit claim (`WorkerExecutionRequest.onSpawn`, `WorkerResult.pid`,
  `dispatch.jsonl`, the `recover` kill/verify machinery; T-010:44-57,100-114). This
  ticket captures pids in-hand at kill time only; nothing is recorded for crash
  recovery.
- **Windows Job Objects** — spec §15.3:1084 "Later"; decisions.md:6-10 keeps the
  Rust helper as the fallback *if* taskkill proves insufficient. The scout's live
  probe is the first "taskkill suffices (live-root tree)" data point.
- **`cancel(attemptId)`** (spec §11, `docs/spec/inference-refinery-v2.md:847`) — the
  `WorkerAdapter` seam (`src/types.ts:35-38`) stays execute-only.
- **Worktree leases/GC** — the rest of ROADMAP.md:15 stage 3.
- **Any happy-path change** — default runs (no timeouts) are behavior- and
  report-identical except the optional (absent) fields.

Coordination, not dependency: T-010 cites `killTree` (`src/kill-tree.ts:8-22`) and
edits the same `opencode.ts` timeout region; whoever lands second rebases. Neither
ticket depends on the other — this one needs no store, no DAG, no attempts table.

## Why

The gap is probe-proven, not hypothetical. Every timed-out gate run today orphans its
whole subtree on the operator machine: `src/gate/command.ts:24-26` relies on `exec`'s
built-in timeout, which kills only the direct shell child (scout's live probe this
session: grandparent pid and grandchild pid both `alive = true` after the exec
timeout; both `alive = false` after list-form `taskkill /T /F`) — exactly the
compiler/Godot/model-worker tree shape spec §15.3:1086 names. And nothing verifies
the kill that does exist: `src/kill-tree.ts:12-14` swallows every taskkill failure as
"already gone", `src/worker/opencode.ts:55` prints `(timed out, tree killed)` as an
unverified assertion, and `src/types.ts:17-18` documents the seam contract as if
proven. The blast radius reaches disposal hygiene: the scout's probe run 2 showed a
surviving orphan holding its cwd busy (`rm -rf` → "Device or resource busy" until it
exited) — an orphaned gate process inside a candidate worktree blocks
`git worktree remove`, poisoning the clean/Gate 1.5/Gate 2 hygiene the repo leans on.

It is also mandated and roadmap-named: spec §15.3
(`docs/spec/inference-refinery-v2.md:1073-1086`) lists the MVP contract verbatim,
Milestone 3 names "process-tree kill" a build item (`:2056`), §35 asks "Are spawned
process trees killable?" (`:2186`), and `docs/ROADMAP.md:15` maps stage 3 to
"Windows reliability: worktree leases/GC, process-tree kill hardening, crash
recovery" — this ticket is the "process-tree kill hardening" item, and unlike the
crash-recovery half (T-010, gated on T-006+T-007) it needs no dependency: the pain is
in-run today. Nothing existing pins any of it: no killTree/taskkill/orphan assertion
exists in any gate section of `scripts/verify.mjs` (Gates 1.5 ×3, 1.6 — scout grep,
consistent with the file's structure read this session).

Design posture, stated plainly: the ticket does not rely on the one behavior the
scout could not verify (whether `taskkill /T /F` on an already-dead root still
reaches reparented descendants) — kills fire while the root is alive, and
post-kill verification plus survivor recording catch whatever taskkill misses. Full
descendant enumeration is pinned because "verify descendants disappear" (§15.3:1079)
is unmeetable from the root's liveness alone — the root dying is precisely the case
where descendants survive.

## Acceptance criteria

- [x] `killTreeVerified(pid)` kills a live Windows process tree with list-form
      `taskkill /pid <pid> /T /F` and verifies the outcome: the root and every
      descendant captured in the pre-kill snapshot are dead afterwards
      (`process.kill(pid, 0)`), returning `{rootWasLive: true, verified: true,
      survivors: []}` for a planted 3-level node tree — pinned by **Gate 1.12**
      (S1, S5).
- [x] Failed or impossible kills are reported, never swallowed: a kill attempt on an
      already-gone pid returns `{rootWasLive: false, verified: false}` as a result
      (today's silent catch at `src/kill-tree.ts:12-14` is removed), and any
      post-kill survivor appears in `survivors` — pinned by **Gate 1.12** (S3).
- [x] A timed-out gate kills its whole tree: tiny-timeout `CommandGate` against a
      grandparent→grandchild node command leaves both spawned pids dead (asserted
      via `process.kill(pid, 0)` from pids the check itself spawned and tracked),
      with unchanged FAIL semantics (`passed: false`, `exitCode: null`,
      `durationMs ≥ timeoutMs`, `outputTail` preserved) and empty cleanup failures —
      pinned by **Gate 1.12** (S1). Red bar: the scout's live probe recorded in Why
      (exec's built-in timeout left grandparent AND grandchild alive).
- [x] A normally-completing gate is unchanged: same GateResult shape as today, no
      `cleanupFailures` key on any non-timeout path, `windowsHide`/cwd/encoding/
      maxBuffer untouched — pinned by **Gate 1.12** (S2) and **Gate 0**.
- [x] The worker timeout path is verified, not asserted: the extracted
      harness-agnostic `runChildWithTimeout` fires `killTreeVerified` at expiry,
      appends `tree killed, verified …` or loud `CLEANUP FAIL: …` lines to the log,
      and returns `cleanupFailures`; `OpenCodeWorker` keeps only bin/args/PWD-OLDPWD
      specifics — pinned by **Gate 1.12** (S4: node tree, `timedOut: true`, pids
      dead, log lines asserted — no opencode binary, no model tokens).
- [x] Cleanup failures are evidence in the report, nothing more: the three optional
      `cleanupFailures` fields exist, `src/runner.ts` aggregates them onto the
      candidate, the store schema and ingest are untouched, and no cleanup failure
      changes `passed`, `passedAllGates`, `workerOk`, or any verdict line
      (decisions.md:19-21) — pinned by **Gate 0**, **Gate 1.6 staying green**, and
      change-set review.
- [x] VERIFICATION.md carries the Gate 1.12 section (S1–S5, the dead-root
      non-reliance note, the POSIX limitation under Known issues) and the ticket
      status + index row move in the same change-set — pinned by change-set review
      (AGENTS.md #6; tickets README rules).
- [x] `npm run verify` is ALL GREEN including the new Gate 1.12 before landing
      (token-free fast tier).
- [ ] **Gate 2 once at landing** — gates, an adapter file, and report shape are all
      on the trigger list — and **Gate 3 once at landing** (adapter file touched),
      both recorded in `## Landed`, neither a permanent extension. Gate 3 ran in the
      lane (see Landed); Gate 2 is owned by the driving pipeline at landing — left
      open until its record lands (the T-010 pattern).

## Landed

2026-10-16, in one change-set on `ticket/T-011-process-tree-termination-hardening`
(lane base `0160806`, T-010 already landed — so the coordination note resolved
the expected way: the opencode timeout region this ticket rewrote was T-010's
`onSpawn`/`pid` region, kept verbatim inside the rewritten `execute`).

- `src/kill-tree.ts` — rewritten around the verified kill: `KillTreeResult`
  and `killTreeVerified(pid)` (alive check first — an already-gone root is
  the reported result `{rootWasLive: false, verified: false}`, the pre-T-011
  silent catch at `:12-14` is gone; non-win32 best-effort root SIGKILL with
  `verified: false`; Windows: pre-kill snapshot → verbatim list-form
  `taskkill /pid <pid> /T /F` → `process.kill(pid, 0)` sweep over the root
  plus every snapshot pid, survivors reported). `snapshotTree` — the
  fixed-constant CIM query spawned list-form
  (`powershell.exe -NoProfile -NonInteractive -Command <constant>`, zero
  interpolation), pid→ppid map + BFS down ppid edges — is exported so Gate
  1.12 S5 can pin the pre-kill enumeration. `killSuccessLine` /
  `killFailureLines` own the log-line vocabulary; a failed snapshot never
  skips the kill (it proceeds `verified: false`). The narrow
  snapshot-to-kill race and the pid-reuse false-survivor possibility are
  documented at the definitions; Job Objects stay "Later"
  (spec §15.3:1084, decisions.md 2026-10-10).
- `src/worker/run-with-timeout.ts` (new) — the harness-agnostic timed-run
  core `runChildWithTimeout(child, {timeoutMs, logPath})` →
  `{timedOut, exitCode, cleanupFailures}`: drains stdout/stderr into the log
  (the adapter's old collector), waits for exit, and at expiry fires
  `killTreeVerified(child.pid)`, appending `tree killed, verified: N
  processes reaped` on a clean verify and the loud `CLEANUP FAIL: …` lines
  otherwise — replacing the unverified `(timed out, tree killed)` assertion
  with evidence. Knows nothing about any harness (S4 drives it with a plain
  node tree).
- `src/worker/opencode.ts` — keeps only the harness specifics: bin path,
  `run -m <model>` args, and the PWD/OLDPWD pinning (`:32` untouched, ground
  rule 5). A second no-log collector rebuilds the response tail; the helper
  owns the log.
- `src/gate/command.ts` — gates get tree-kill at all: exec's built-in
  `timeout` option is dropped (the red bar: it killed only the shell child —
  grandparent AND grandchild stayed alive), the class owns a
  `setTimeout(timeoutMs)` that fires `killTreeVerified(child.pid)` while the
  shell child lives (the ChildProcess's own exit knowledge closes the
  natural-completion race), double-resolve is guarded, and timeout FAIL
  semantics are byte-identical (`passed: false`, `exitCode: null`,
  `durationMs ≥ timeoutMs`, `outputTail` as collected).
- `src/types.ts` — `GateResult`, `WorkerResult`, and `CandidateReport` each
  gain optional `cleanupFailures?: string[]`; the
  `WorkerExecutionRequest.timeoutMs` seam doc (`:17-18`) now states the
  verified semantics. Absent on every non-timeout path — happy-path reports
  unchanged.
- `src/runner.ts` — aggregates worker-side failures (every attempt) plus
  gate-side failures (prefixed `gate <name>: `) onto
  `CandidateReport.cleanupFailures`, the candidate's one place answering
  "did anything survive". Evidence only: no retry, ladder, or verdict input
  changed (decisions.md: gates decide survival). The store is untouched —
  `gate_results` ingest keeps its explicit column selects
  (src/store/index.ts:954), so the new fields simply do not persist.
- `scripts/check-kill-tree.mjs` (new) + the Gate 1.12 hook in
  `scripts/verify.mjs` after Gate 1.11, before the fast-tier finish —
  30 assertions across S1–S5 (S1 timed-out-gate tree kill with unchanged
  FAIL shape; S2 happy-path pin, passing and failing gates, plus the
  source-level pin that `windowsHide`/`cwd`/`encoding`/`maxBuffer` stay and
  the built-in `timeout` is gone; S3 removed-catch regression pin; S4
  `runChildWithTimeout` on a node tree, log lines asserted, no opencode;
  S5 snapshot depth + the planted 3-level verified kill). Plants real node
  trees, asserts on the real process table, sweeps its own spawns at the end
  (AGENTS.md #10 mechanized for itself).
- VERIFICATION.md — the Gate 1.12 section plus Known issues #8 (dead-root
  non-reliance) and #9 (POSIX verification limitation), in the same
  change-set. Ticket status + index row in the same change-set.

Deviations, stated rather than smoothed:

- The ticket's premise "the silent exported `killTree` has exactly one
  importer today (`src/worker/opencode.ts:5`)" was true when written but
  T-010 landed first: `src/recover.ts:33,530` now also imports `killTree`
  inside the recovery kill/verify machinery this ticket explicitly does NOT
  claim. Resolution: `killTree` stays exported as a one-line fire-and-forget
  wrapper over `killTreeVerified` — recover.ts is byte-identical (the carve
  holds; its own before/after liveness checks are unchanged) while the
  silent catch is gone from the file and the outcome is reported, never
  swallowed.
- `KillTreeResult` carries one field beyond the pinned shape: `reaped`
  (snapshot pids verified dead) — it is the `N` in the ticket's own
  `tree killed, verified: N processes reaped` log line, which the pinned
  three fields cannot produce.
- One extra `CLEANUP FAIL` line shape beyond the ticket's two named ones:
  `CLEANUP FAIL: pid N tree kill could not be verified (descendant
  verification unavailable)` for verified:false-with-no-survivors (the POSIX
  fallback, or a failed CIM snapshot). Leaving that case log-silent would
  recreate the exact failure mode this ticket removes.
- `snapshotTree` is exported (S5 must observe the pre-kill enumeration to
  pin the planted grandchild pid inside it), and S1 pins "no cleanup
  failures" as the key being absent — same convention as S2's happy-path
  key-absence pin.

Measured gates (Node v22.23.1, lane): Gate 0 `tsc --noEmit` → exit 0;
`node scripts/verify.mjs fast` → `verify (fast) complete: ALL GREEN`, exit 0,
including Gate 1.5 (cleanup), Gate 1.6 (store ingest, green with the new
optional fields), and the new Gate 1.12 —
`node node_modules/tsx/dist/cli.mjs scripts/check-kill-tree.mjs` →
`check-kill-tree (Gate 1.12): ALL GREEN (30 assertions)`, exit 0, run twice
standalone (stability) plus once in-tier. Gate 3 (adapter file touched), run
in the lane: `node scripts/diag-pwd.mjs C:\swarm\demo-target` → opencode
reports the spawned-in directory; with the same dir as the PWD override it
reports the override target — pass on both forms. Gate 2 not run here —
owned by the driving pipeline at landing (gates + adapter file + report
shape are all on the trigger list); the checkbox above stays open until its
record lands (the T-010 pattern).

## Verification

Gate 0 (`npm run typecheck`) always. Gate 1 (`npm run demo`) sanity, token-free.
Gate 0.5 n/a (`src/parse.ts` untouched). Gate 1.5 and Gate 1.6 must stay green —
1.6 because report shape changed but the store's explicit column selects did not;
both run in the fast tier. The **new Gate 1.12** (`scripts/check-kill-tree.mjs` +
new VERIFICATION.md section + hook in `scripts/verify.mjs` before the fast-tier
finish at `scripts/verify.mjs:448` — the T-003/T-005/T-006/T-007/T-008/T-009/T-010
slice-owns-its-gate precedent; no existing gate can pin this: Gate 1.5 pins
clean/lock/integrate, Gate 1.6 pins store ingest, Gate 2 spends model tokens and
cannot deterministically force a timeout, Gate 3 is directory-resolution only) runs
via `npm run verify` — run in the lane, see Landed. **Gate 3** ran in the lane,
recorded in Landed. **Gate 2 once**, at landing, owned by the driving pipeline
(recorded in Landed when it lands).

## References

spec §15.3 (`docs/spec/inference-refinery-v2.md:1073-1086`; Job Objects "Later"
`:1084`; process-tree examples `:1086`), §11 `cancel(attemptId)` (`:847`, carved),
§35 (`:2186`) · `docs/decisions.md` 2026-10-10 (Node 22 + Rust Job-Objects fallback
`:6-10`; gates decide `:19-21`; Windows-first hygiene `:27-30`) · `docs/ROADMAP.md:15`
(stage 3, "process-tree kill hardening") · VERIFICATION.md:200-213 (Gate 2/3
trigger lists) · T-010 — the recovery-side half this ticket carves around
(`docs/tickets/T-010-startup-reconciliation.md:44-57,100-114,303-306`) ·
T-002/Gate 1.5 — the disposal hygiene an orphaned gate process breaks.
