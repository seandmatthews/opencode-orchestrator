# T-065 — The engine runs on Linux/WSL: platform-aware run root + per-platform kill/identity contracts

**Status:** done 2026-10-29 (Linux green bars) / 2026-10-31 (Windows re-verification + Linux FULL tier incl. real-model Gate 2, green)
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** —

## What

The engine is Windows-first by decision (decisions.md 2026-10-10), but
everything except two documented degradations — KI#9 (kill verification is
Windows-only) and T-052's creation-time identity probe — is already
platform-neutral. This change-set makes the token-free tier (the fast tier)
run green on Ubuntu 22.04.2 LTS under WSL2, from a fresh clone into the ext4
filesystem, without changing any Windows behavior, and pins the
per-platform contracts where they genuinely differ.

### Engine changes

1. **Platform-aware default run root** (`src/run-root.ts`, mirrored in
   `scripts/swarm-root.mjs` for the plain-node verify tier): `C:\swarm` on
   Windows (the documented default, unchanged), `$HOME/swarm` elsewhere, and
   `SWARM_RUN_ROOT` overriding both. Every engine CLI's `--run-root`/`--db`
   default and usage text resolves through it. Before this change the
   Windows-only literal was silently wrong on POSIX: a relative directory
   literally named `C:\swarm\...` inside the cwd (observed first-hand — the
   Gate 1 fixture generated into `./C:\swarm\demo-target` before the tier
   crashed).
2. **Recorded-evidence derivations read both separators**
   (`src/store/index.ts`): `artifactId`'s basename leg and `reportPathOf`'s
   directory walk parse `/` and `\`, and `reportPathOf` rejoins with the
   recorded path's OWN separator — a run recorded on Windows ingests
   byte-identically on POSIX, and Gate 1.6's pinned literals become
   platform-INDEPENDENT (the same script, the same literals, green on both
   platforms; no per-platform split of the store gate).
3. **The gate-timeout stdio wedge, fixed for real** (`src/gate/command.ts`):
   a timed-out gate's `exec` callback waits for `close` — which a surviving
   descendant holding the inherited stdio pipes can prevent FOREVER. On
   POSIX the root-only kill (KI#9) makes this shape ordinary: the shell
   dies, its grandchildren hold the pipes, and the gate verdict (and the
   whole run) hangs — observed first-hand as Gate 1.12 hanging the tier
   indefinitely. The fix ends the child's stdio after the timeout kill and
   on the already-exited wedge path, so the timeout verdict resolves with
   the output collected so far (runChildWithTimeout already had the T-046
   abandonment; CommandGate needed the same treatment). Windows: the tree
   kill already closed the pipes; destroy-on-killed is a harmless no-op
   there.
4. **The opencode binary is found on Linux** (`src/cli.ts`): the
   opencode-ai postinstall installs the platform binary as
   `bin/opencode.exe` on EVERY platform (its own targetBinary constant — on
   Linux that file is the ELF build, verified first-hand), while cli.ts
   looked for `bin/opencode` and refused to start ("opencode executable not
   found"). Resolution now prefers the unprefixed name where one exists and
   accepts the packaged `.exe` name elsewhere.
5. **Zombie-aware liveness in recovery's kill recording**
   (`src/recover.ts`): `reconcileKills` checked `isAlive` immediately after
   the tree kill; on POSIX the SIGKILL needs a moment (and its own parent's
   event-loop turn) to leave the process table, so the kill intermittently
   recorded as `kill-failed` — a race Windows' synchronous taskkill never
   shows. Two fixes: `isAlive` now reads `/proc/<pid>/stat` and treats the
   zombie/dead states (Z/X) as DEAD — a SIGKILLed-but-unreaped child is dead
   for every purpose here — and the kill-failed declaration waits behind a
   small bounded synchronous settle (the T-046 posture). Windows: unchanged
   semantics (no zombie state; the signal-0 answer is already exact).

### Check-side changes

5. **The fast tier's sandboxes follow the run-root resolver**: every
   hard-coded `C:/swarm/verify-*` sandbox root in `scripts/verify.mjs` and
   the `check-*.mjs` scripts now derives from `swarmRoot`. Fixture STRINGS
   that merely record windows-shaped paths (check-probe's capture-refusal
   fixtures, check-yield's synthetic repo path) are deliberately untouched —
   they are opaque recorded data, not paths anything resolves.
6. **The check scripts' `taskkill` sites route through
   `scripts/kill-tree.mjs`**: on Windows the verbatim list-form
   `taskkill /pid X /T /F`; elsewhere a best-effort root SIGKILL with no
   descendant verification — exactly `src/kill-tree.ts`'s posture (KI#9).
   The T-010 crash simulator's single-pid kill keeps its no-`/T` shape
   (`killPid`: the orphaned worker IS the scenario's evidence).
7. **Per-platform contract pins** where the gates asserted the Windows
   shape everywhere:
   - check-recovery R2/R3/R4: Windows — verified orphan kill, exit 0;
     POSIX — T-052 fails closed (`identity-unavailable`), the orphan
     SURVIVES, recover exits 1 with the skip recorded as a cleanup failure
     naming the pid (the engine already behaved this way — observed
     first-hand in a forced reconciliation's recovery.json; only the gate
     assumed Windows).
   - check-kill-tree S1/S4/S5: Windows — verified tree kill, no CLEANUP
     FAIL, whole tree dead; POSIX — root-only kill reported
     `verified: false`, the documented could-not-be-verified line, the
     root dead and its spawned descendants surviving as the KI#9 leak, the
     pre-kill CIM snapshot scoped to Windows (powershell.exe machinery).
   - check-probe P3/P4 timeout legs and the web tree-death pins: same
     shape — the verified tree kill on Windows; on POSIX the sweep reaps
     what the root-only kill leaves, and the pin is that nothing survives
     the leg.
   - check-machine-worker S4: the adapter's timeout kill, same
     per-platform shape.
   - check-prompt-transport C0: the 32,767 UTF-16 command-line ceiling is
     the Windows CreateProcess limit; on POSIX a 33,000-char argv element
     spawns fine (ARG_MAX) — pinned as such.
   - check-settle-deadline's exit criterion: on POSIX the systemic
     "this process drains" test is confounded by the harness's own stdio
     (a pending stdout write to a slow reader keeps the fd-1/2 Sockets
     ref'd; observed handle dump) and tsx's service child. The T-046
     criterion is measured DIRECTLY there: after a bounded settle, no live
     handle beyond the process's own stdio (fd > 2) survives. Windows
     keeps the watchdog (the drain there is not confounded; pinned since
     T-046).
   - check-dashboard's usage pin: the `--db` default is asserted against
     `defaultStoreDb()` (the resolved default), not the Windows literal.
   - check-clean-evidence P0: the evidence-geometry pins expect the lease
     path mapped in the platform's own separator shape (the recorded run's
     shape), not a hardcoded backslash form.
   - check-dashboard-write leg 3b: the overlapping decision pair starts its
     second child 150ms after the first — still genuinely overlapping (the
     documented lock contention the T-051 guard exists for), but a truly
     simultaneous pair on a fast box can starve BOTH writers into
     SQLITE_BUSY refusals, leaving no winner to test the corruption pins.
   - check-lock-ownership R6: the PATH strip (forcing the probe
     unavailability) splits on the platform's PATH separator — the ';'
     split on POSIX treated the whole colon-joined PATH as one segment and
     deleted it, leaving the child recover without git; and the generated
     driver's teardown kill routes through scripts/kill-tree.mjs (a raw
     taskkill left a survivor alive whose ChildProcess handle pinned the
     driver's event loop past ALL GREEN, into the outer 120s timeout).
8. **verify.mjs's forward→backslash argv munging is win32-only**
   (`asWinPaths`): the historical re-slashing of its forward-slash roots is
   a Windows convenience; on POSIX it corrupted every path it touched.
9. **Gate 1.51** (`scripts/check-run-root.mjs`) pins the resolver (unit
   legs) and one end-to-end leg through the real lock CLI (SWARM_RUN_ROOT
   honored with NO --run-root).

### The Gate 1.22 intermittent red, root-caused and ticketed

Gate 1.22's C(n=1) leg failed intermittently (~50%) on the fast WSL box
and never on Windows. Root cause found with an in-fixture probe: **two
runs started in the same wall-clock second share ONE artifacts dir**
(second-resolution run ids, no existence check — the one-round run landed
in the 2-round loop run's dir, its fake planner saw the loop's round-2
provenance marker, and the run grew a NO-OP candidate whose T-049 yield
block tripped the key-set pin). The check-side exposure is isolated in
this change-set (the one-round run now uses its own run root — the
isolation the fixture already intended for its branch namespaces); the
ENGINE hazard is filed as **T-066**, deliberately not fixed in this lane
(findings promote via tickets, never same-run).

## What deliberately did NOT change

- Windows behavior, byte for byte: same default paths, same literals, same
  kill invocations, same report shapes (the sweeper call sites' win32 leg
  is the verbatim taskkill line, moved behind one function; the store's
  pinned literals derive identically on Windows).
- README/decisions.md doc-wide path mentions: the uncommitted handoff-doc
  lane on the Windows checkout touches those files; its C:\swarm mentions
  update with that lane, not here. AGENTS.md's run-root line IS updated
  here.
- The same-second run-id collision: filed (T-066), not fixed (rule 11).

## Tier 2 — the full tier, real models, on Linux (2026-10-31)

The full tier was run on the same WSL box after all of the above landed:

1. **Manual skeleton run** (demo-target fixture, the fixture's own suggested
   goal, 2 candidates, build+test gates, default zai models): exit 0 — both
   candidates worker-ok with real 1.0 KiB diffs, both gates PASS, both
   survived; the WSL harness's existing `zai-coding-plan` auth (June's
   login) was still valid, so NO re-auth and NO credential transfer was
   needed. Disposed through `npm run clean` (4 removed, 0 refused, evidence
   kept).
2. **`npm run verify:full`** — Gates 0–1.51 plus the real-model Gate 2
   end-to-end: `=== verify (full) complete: ALL GREEN ===`, exit 0. The
   Gate 2 run (report kept at `$HOME/swarm/verify/20261031170503/`) was a
   real 2-round loop: c01 (302s, 3.8 KiB diff) and c02 (199s, 3.0 KiB)
   survived round 1, and both round-2 re-leases (c01-r2 41s / c02-r2 375s)
   survived with gates PASS and parsed reviews (4–6 observations each).
3. Manual `opencode run` smoke tests in WSL must pipe the prompt on stdin
   (T-042's transport) — an argv prompt hangs waiting on stdin.

## Acceptance criteria (all token-free)

- AC1 — the full fast tier (Gates 0–1.51) exits 0 on Ubuntu 22.04.2 LTS
  (WSL2, Node 22), fresh clone into the ext4 fs.
- AC2 — Gate 1.6's pinned store literals pass UNCHANGED on both platforms
  (Windows re-run before merge).
- AC3 — the Windows fast tier exits 0 with the change-set merged (the win32
  legs are byte-identical strings and calls).
- AC4 — Gate 1.51 pins the resolver contract and the env override through a
  real CLI.

## Verification

Red bars, recorded BEFORE each fix (AGENTS.md #8), all token-free, on the
pristine WSL clone (= origin/main 35f799f) and then per gate as the tier
advanced:

1. The first WSL run crashed at Gate 1: `demo-target.mjs` received the
   backslashed `C:\swarm\demo-target` argv and created a single directory
   of that literal name inside the repo, then the tier's next assertion
   died on `fatal: cannot change to 'C:/swarm/demo-target'`.
2. After the sandbox sweep, Gate 1.6 failed: 10 assertions — the store's
   `basename`/`dirname` legs could not parse recorded backslash paths on
   POSIX.
3. Gate 1.11 (recovery) failed: the crash simulator spawned a Windows-only
   `taskkill` binary (ENOENT), and the gate asserted the Windows kill
   shape everywhere.
4. Gate 1.12 (kill-tree) HUNG the tier indefinitely: the POSIX root-only
   kill left a descendant holding exec's stdio, and the close-gated
   callback never fired (the wedge fixed in engine change 3).
5. Gate 1.15 (probe) failed 5 assertions — the Windows verified-tree-kill
   pins on the timeout legs.
6. Gate 1.17 (machine-worker) failed 3 — the same class, plus the opencode
   bin refusal.
7. Gate 1.19 (long-paths) failed — its sandbox literal was the one
   backslash-form assignment the sweep's pattern did not match, and the
   composed-depth machine run refused over the resulting red base.
8. Gate 1.23 (dashboard) failed — the usage pin matched the Windows
   literal default.
9. Gate 1.28 (prompt-transport) failed — the C0 leg pinned the
   Windows-only command-line ceiling.
10. Gate 1.31 (settle-deadline) failed its exit criterion — the POSIX
    stdio-socket confound, handle-dump evidence captured.
11. Gate 1.22 (rounds) failed intermittently — root-caused to the
    same-second run-id collision (probe evidence; filed as T-066).
12. Gate 1.34 (clean-evidence) failed — the evidence-geometry pins
    hardcoded the Windows separator shape.
13. Gate 1.37 (dashboard-write) failed — the overlapping decision pair
    starved both writers into SQLITE_BUSY refusals (zero winners).
14. Gate 1.38 (lock-ownership) failed three legs — the kill-failed race
    (zombie answers kill(pid,0) alive), the driver's un-killed survivor
    pinning its event loop, and the R6 PATH strip deleting the whole POSIX
    PATH (git ENOENT in the child recover).

Green bars: the WSL fast tier — `npm run verify` (fast) on the change-set,
Ubuntu 22.04.2 LTS / WSL2 / Node v22.23.0, fresh clone into the ext4 fs:
`=== verify (fast) complete: ALL GREEN ===`, exit 0 (2026-10-31, after the
per-gate sequence above; every gate 0–1.51). The Windows fast tier on the
same change-set (worktree at the lane commit, Node 22, win32):
`=== verify (fast) complete: ALL GREEN ===`, exit 0, 2337 ok lines
(2026-10-31). The first Windows attempt hit the known one-off CIM transient
class (Gate 1.12 S4 reported an unverified outcome around a kill the real
table proved dead — KI#10's shape, no code implicated); the documented
remedy is the re-run, which came back green end to end. **And the Linux
FULL tier — `npm run verify:full`, Gates 0–1.51 plus the real-model Gate 2
end-to-end — completed `=== verify (full) complete: ALL GREEN ===`, exit 0
(2026-10-31; evidence above and at
`$HOME/swarm/verify/20261031170503/`).**

## Re-run requirements

Required whenever `src/run-root.ts`'s resolution changes, any engine CLI's
`--run-root`/`--db` defaulting changes, the store's recorded-path
derivations change, the gate-timeout stdio handling changes, or any of the
per-platform gate pins' underlying contracts change. The Windows tier
remains the primary tier; the Linux tier is re-verified whenever any of the
above touch shared code.
