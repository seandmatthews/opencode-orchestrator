# T-021 — §15.4 explicit long-path tests: pin the engine's path budget at Windows MAX_PATH depth

**Status:** done
**Category:** verification
**Value (1-5):** 3 · **Risk (1-5):** 1
**Depends on:** — (independent of proposed T-020; gate numbering coordinated below — this ticket claims Gate 1.19 unconditionally, leaving 1.18 to T-020, so either landing order merges without renumber)

## What

A new token-free fast-tier check, `scripts/check-long-paths.mjs`, hooked into
`scripts/verify.mjs` after the Gate 1.17 check (the `check-machine-worker.mjs`
hook point, `scripts/verify.mjs:551` — the slice-owns-its-gate precedent
T-003→T-019), pinned in VERIFICATION.md as **Gate 1.19**. Zero new
dependencies; no `src/` change.

The check builds, in a throwaway sandbox under `C:\swarm\verify-longpath`
(created and removed by the check itself — AGENTS.md #10), a deep fixture
repo and then drives the **real engine end-to-end** against it — a
token-free `--jobs` machine run, the Gate 1.17 S5 precedent
(`scripts/check-machine-worker.mjs:239-304`) — and derives every budget
assertion from the run's actual records. It deliberately builds none of the
engine's path composition itself: `src/cli.ts` exports nothing (`grep -n
"export" src/cli.ts` → zero hits, re-verified this round), so the three
values that decide path shape — the runId derivation (`src/cli.ts:304`,
inline in `runPipeline`), the run-root default (`src/cli.ts:107`, inline in
`parseArgs`), and the lease-id shape (`src/runner.ts:407`, inline) — can be
pinned only through the engine's real output.

1. **Deep fixture repo** — a `demo-target.mjs`-style throwaway repo (with
   baseline-passing build/test commands) whose tree holds a file at a
   measured, deterministic depth below the repo root: nested directories
   with bounded names, sized so that the deepest file's repo-root-relative
   path length puts the *composed* depth (below) inside a documented
   240–258-char band.
2. **Real token-free engine run** — a `--jobs` spec with one machine job
   (per-job `worker: "machine"` + list-form `command`; run-level `--worker
   machine` is refused by design, `src/cli.ts:142-143`) whose command
   appends one line to the deep file and whose gate command validates the
   deep file, both executing with the leased worktree as their working
   directory; invoked exactly as S5 invokes the real CLI
   (`scripts/check-machine-worker.mjs:259-268`):
   `tsx src/cli.ts --repo <fixture> --jobs <spec> --no-review --run-root
   <sandbox>\runs --db <sandbox>\refinery.db` (the planner is auto-skipped
   under `--jobs`, `src/cli.ts:312`; no model tokens). **No `--clean`** —
   disposal is its own assertion (4).
3. **Budget + depth assertions from real records** — the check then asserts,
   reading only what the run actually produced:
   - exactly one 14-digit run dir appeared under the sandbox run root (the
     S5 scan, `scripts/check-machine-worker.mjs:275-278`) — flips if the
     runId derivation changes;
   - the candidate's recorded `workspacePath` (`report.json`) /
     `worktreePath` (`dispatch.jsonl`, written at `src/runner.ts:428-436`)
     is `<runDir>\wt\<leaseId>` — the shallow two-level layout — flips if
     the lease-id shape (`src/runner.ts:407`) or the lease-path join
     (`src/workspace/worktree.ts:68`) changes;
   - the composed worktree prefix (run dir + `wt\` + lease id, all from the
     recorded path) measures ≤ 40 chars;
   - before disposal, the deepest composed file path (recorded
     `workspacePath` + the deep fixture-relative path) exists on disk and
     lands in the documented 240–258 band;
   - the run succeeded at that depth: `workerOk`, `diffBytes > 0`, the gate
     passed, and `diff.patch` contains the deep path and reads back
     byte-identical.
4. **Disposal at composed depth through the house path** — `tsx src/clean.ts
   --run <runId> --run-root <sandbox> --force` (`--force` is correct: the
   run captured the evidence before disposal — the Gate 2 posture,
   VERIFICATION.md:1424-1426); asserts the worktree and `swarm/*` branch are
   gone and the evidence files are intact — T-002's disposal loop exercised
   on a real deep run.

**Sensitivity, stated exactly.** Gate 1.19 flips automatically on: runId
derivation changes (`src/cli.ts:304`); lease-id shape or lease-path
composition changes (`src/runner.ts:407`, `src/workspace/worktree.ts:68`);
and any depth/shallowness regression the run's records expose. It does **not**
automatically flip on one named value: the **run-root default**
(`src/cli.ts:107`) — the check passes `--run-root` explicitly (the sandbox
discipline every fast-tier check follows: Gate 1.5's `C:\swarm\verify-clean`,
S5's sandboxed runs), and a changed default is invisible behind an explicit
flag. That case is pinned by the Gate 1.19 section's documented anchor plus
change-set review; the mechanism that would automate it (invoke the CLI
without `--run-root`, assert the run landed under `C:\swarm`, dispose through
`clean`) is named here and deliberately **not taken**: it would write real
run state into the live root during `npm run verify`, breaking the sandbox
discipline the rest of the fast tier keeps.

VERIFICATION.md gains the Gate 1.19 section **and** an honesty note: no
MAX_PATH/ENAMETOOLONG failure has ever been observed in this repo —
`grep -rn "MAX_PATH\|longpath\|long-path\|ENAMETOOLONG\|260"` over `src/`,
`scripts/`, VERIFICATION.md, `docs/tickets/` returns zero hits (re-ran this
session, exit 1 = no matches), and Known issues 1–10 contain none. The gate
pins a failure class prospectively, before field fan-out scales worktree
counts; it fixes no observed bug.

**Does NOT claim:**

- **No run-root relocation** — `C:\swarm` is locked (decisions.md:25-26,
  "Run root is `C:\swarm\`"); the gate tests and pins the existing root, it
  never moves it. "Short-path run roots" (§34:2059) is already satisfied by
  the root that exists in code; this ticket adds the missing pin.
- **No engine change** — if the check passes at HEAD, the change-set is one
  new script + a `verify.mjs` hook + VERIFICATION.md. If it fails at HEAD,
  the red bar is recorded in the ticket (AGENTS.md #8) and the fix becomes
  its own red-before/green-after change-set — not smuggled in here. (The
  reviewer-round alternative of exporting the composition constants from
  `src/cli.ts` was considered and rejected: the real-run derivation pins the
  same three values through behavior, and keeps `src/` untouched.)
- **No `core.longpaths`, no `\\?\` prefixing, no symlink semantics** — the
  check asserts default-Windows behavior; §15.4's "no dependence on POSIX
  symlink semantics" (:1097) is already satisfied by `git worktree add` and
  stays unperturbed.
- **No retention policies, no run-dir deletion** — the other half of M3's
  remainder (§34:2055), carved to its own successor ticket sequenced behind
  proposed T-020 (its lock-held / crashed-unreconciled run classification is
  the safe substrate, T-020:24-49; building selection rules now would
  duplicate an open ticket's scope). Inside that carve, §16.1's *graded
  evidence* expiry (§16:1125-1148; `WorkspaceLease.expiresAt`/
  `retentionClass` vs the narrowed `src/types.ts:70-75`) must first
  renegotiate T-002's evidence-never-deleted rule (`src/clean.ts:6-8`)
  through decisions.md's own mechanism (decisions.md:3-4) and reconcile with
  the store (`retention_class` omitted-not-predefined,
  `src/store/index.ts:63-65`; hash-at-ingest artifacts rows read a deleted
  evidence file as missing — Gate 1.16, VERIFICATION.md:1260). Not this
  change-set's business.
- **No §26.7 Retention/Disk View** — Milestone-7 UI, out of scope.

## Why

Spec §15.4 (`docs/spec/inference-refinery-v2.md:1088-1098`) lists six
path-handling constraints: short run IDs, short worktree roots, normalized
paths, shallow artifact names, **explicit long-path tests** (:1096), no
POSIX-symlink dependence. Five are implemented and anchored in code (14-digit
run ids `src/cli.ts:304`; root `C:\swarm` `src/cli.ts:107`; `normPath`
`src/workspace/worktree.ts:12`; flat artifactsDir evidence layout
`src/cli.ts:305`; list-form lease `src/workspace/worktree.ts:67-74`) — the
explicit test is the one §15.4 bullet with no artifact anywhere in the repo
(zero grep hits, command quoted above). §34's Milestone 3 build list names
"short-path run roots" (:2059), and proposed T-020 explicitly hands this
remainder over ("No §26.7 retention UI, no disposable clones, no short-path
run roots — the rest of §34 Milestone 3's build list", T-020:112-113), making
this the named successor, not a duplicate.

Because the shape-deciding values are unexported inline code, the gate pins
them behaviorally — through a real machine run whose records expose exactly
what the engine composed — rather than through a composition the check
reconstructs (a reconstruction stays green while the engine's inline values
drift; that flaw is why this ticket was returned in review round 1). The
S5 block of Gate 1.17 (`scripts/check-machine-worker.mjs:239-304`) proves a
real-CLI machine run is fast-tier-class cost and token-free.

Honest scoping (grounding-scout live check; the grep re-ran by me this
session): no MAX_PATH failure was ever recorded, and the engine's worst-case
prefix `C:\swarm\<14 digits>\wt\c01-a2\` is ≈34 chars of the 260 budget —
often shorter than a canonical checkout under `C:\Users\...`. The real depth
risk is the *target repo's own tree* composed under the worktree prefix —
exactly what the fixture exercises. Value is modest, prospective insurance:
the test is cheap and token-free, spec-mandated, and pins both the failure
class and the path budget before fan-out scales worktree counts. Retention
pressure, by contrast, is prospective only today (grounding-scout live check:
`C:\swarm` holds 4 run dirs at 20–60KB each, zero `wt/` entries) — which is
why this half tickets first and retention carves off.

## Acceptance criteria

- [x] **Gate 1.19** exists: `scripts/check-long-paths.mjs` hooked into
      `scripts/verify.mjs` after the Gate 1.17 check, token-free, sandbox
      under `C:\swarm\verify-longpath` created and removed by the check; a
      deep-file fixture repo, a real token-free `--jobs` machine run against
      it (the S5 invocation shape), then from the run's records: exactly one
      14-digit run dir, `workspacePath` == `<runDir>\wt\<leaseId>`,
      `workerOk` + `diffBytes > 0` + the deep-file gate passed at the
      composed depth, `diff.patch` containing the deep path; then
      `tsx src/clean.ts --run <runId> --run-root <sandbox> --force` removes
      the worktree + `swarm/*` branch with the evidence files intact; exit 0.
- [x] The composed-path budget is pinned by **Gate 1.19, measured from the
      run's real records**: composed worktree prefix ≤ 40 chars; deepest
      composed file path in a documented 240–258-char band (inside MAX_PATH
      260, deterministic). The gate's automatic flip-sensitivity is stated in
      VERIFICATION.md and is real: runId derivation (`src/cli.ts:304`),
      lease-id shape and lease-path composition (`src/runner.ts:407`,
      `src/workspace/worktree.ts:68`), and depth/shallowness regressions all
      flip it. The one non-automatic case — the run-root *default*
      (`src/cli.ts:107`), invisible behind the check's explicit `--run-root`
      — is pinned by the Gate 1.19 anchor + change-set review, with the
      not-taken automating mechanism (default-root run into live
      `C:\swarm`) and its rejection reason recorded in the ticket.
- [x] The five implemented §15.4 mechanisms are named with their code anchors
      in VERIFICATION.md's Gate 1.19 section, and the honesty note records
      the zero-hit grep (command quoted) — no observed-failure claim is made.
      Anchors stay compiling via **Gate 0**; note content pinned by
      change-set review.
- [x] No existing check weakened: Gate 0/0.5/1 and the full fast tier (Gates
      1.5–1.17) stay green — pinned by `npm run verify` ALL GREEN (the new
      gate adds one S5-class real machine run: seconds, token-free,
      timeout-bounded like S5's 120s).
- [x] **Gate 2 not triggered**: the change-set touches no `src/` file
      (trigger list, VERIFICATION.md:1428-1429); if implementation forces a
      `src/` touch, Gate 2 runs once at landing — pinned by change-set
      review, with what actually ran recorded in the landed notes.
- [x] Ticket status + index row move in the same change-set (AGENTS.md #6) —
      pinned by change-set review.

## Landed

2026-10-18, lane branch `ticket/T-021-long-path-tests`.

What changed:

- **`scripts/check-long-paths.mjs`** (new) — **Gate 1.19**, token-free, zero
  new dependencies, nothing imported from `src/` (the shape-deciding values
  are unexported inline code). One throwaway sandbox under
  `C:\swarm\verify-longpath`, created and removed by the check (AGENTS.md
  #10): a demo-target-style deep fixture repo (baseline-passing
  `node build.js` + `node test.js`; committed tree holding
  `d000/…/d030xxx/deep-leaf-marker-file-for-gate-019.txt` at a planned
  196-char repo-relative depth), then the REAL engine end-to-end — a
  `--jobs` machine run in the Gate 1.17 S5 invocation shape with NO
  `--clean` — then every assertion from the run's records: exactly one
  14-digit run dir; `workspacePath` == `<runDir>\wt\deep` exactly, with
  `dispatch.jsonl` agreeing (leaseId `wt/deep`, branch `swarm/wt-deep`, same
  worktreePath, completion `diffBytes` non-null and equal); the composed
  worktree budget ≤ 40; the deepest composed file on disk in the 240–258
  band; `workerOk` + `diffBytes > 0` + the deep-file gate passed;
  `diff.patch` carrying the deep path at the recorded byte length; then
  `tsx src/clean.ts --run <runId> --run-root <sandbox> --force` disposing
  worktree + `swarm/*` branch with `report.json`/`dispatch.jsonl`/
  `worker.log`/`diff.patch` hash-identical. 14 assertions, all green.
- **`scripts/verify.mjs`** — the Gate 1.19 hook, after the Gate 1.18 block
  (the fast tier ends 1.17 → 1.18 → 1.19; T-020 landed first and occupies
  the slot right after the Gate 1.17 check — this ticket's coordination note
  anticipated either landing order). No other line touched.
- **`VERIFICATION.md`** — the Gate 1.19 section: the five implemented §15.4
  mechanisms with their code anchors, the behavioral-pinning rationale, the
  budget definition, the exact flip-sensitivity statement (including the
  non-automatic run-root default case and the not-taken automating
  mechanism), and the honesty note. No existing gate text changed.
- **This ticket + `docs/tickets/README.md`** — status and index row moved in
  the same change-set.

Measured (lane, this change-set): standalone `node
scripts/check-long-paths.mjs` → exit 0, ALL GREEN — composed deep file 249
chars (band 240–258, inside MAX_PATH 260), production prefix
`C:\swarm\<14 digits>\wt\deep` 31 chars (≤ 40), recorded `workspacePath`
52 chars, deep repo-relative path 196 chars. Full fast tier
`node scripts/verify.mjs fast` (== `npm run verify`) → ALL GREEN, exit 0:
Gate 0 typecheck exit 0, Gate 1 fixture baseline green, Gate 0.5 parser
green, Gates 1.5–1.18 green — no existing check touched or weakened.
Gate 2 NOT triggered: the change-set touches no `src/` file (runner,
adapters, gates, workspace handling, report shape all untouched).
Gate 3 n/a (no adapter).

Deviations from the ticket text, recorded:

- **The ≤ 40 budget's measurement definition.** The ticket's "composed
  worktree prefix (run dir + `wt\` + lease id, all from the recorded path)
  measures ≤ 40 chars" cannot hold literally: the sandbox-recorded path is
  52 chars, because the check's run root (`C:\swarm\verify-longpath\runs`)
  is longer than the production root. The gate therefore asserts the budget
  on the production shape the records pin — `<runId>` + `\wt\` + lease id
  read off the recorded path, composed against the locked run-root default
  `C:\swarm` (decisions.md 2026-10-10) — measured 31; the exact-equality
  `workspacePath` assertion pins the recorded shape itself. VERIFICATION.md
  states this definition and the reason.
- **The honesty note's grep result.** The ticket recorded the five-token
  grep (including the bare `260` alternative) as returning zero hits. The
  re-run at HEAD found: zero hits under `src/`, and zero hits for the
  failure-class tokens (`MAX_PATH`/`longpath`/`long-path`/`ENAMETOOLONG`)
  anywhere outside the tickets' own prose — but the bare `260` matches
  incidental `2026…` timestamp literals (e.g. `scripts/check-gc.mjs`'s
  fixture run ids, one `--run` example in VERIFICATION.md) and `:260-`
  line-range references in other tickets. VERIFICATION.md quotes the command
  and records this true result; the substance (no MAX_PATH/ENAMETOOLONG
  failure ever observed, no pre-existing long-path artifact) is unchanged.

Review round 1 (2026-10-18): the driving fast tier went red once, exit 1,
inside Gate 1.17's `scripts/check-machine-worker.mjs` — a check this
change-set does not touch, executing before the Gate 1.19 hook — with
exactly one failed assertion, no crash, and no debris (the check's own
sandbox cleanup had run). Not reproducible: 13 green Gate 1.17 executions in
the same lane the same day (two full fast tiers, six standalone runs, three
under 8-way artificial CPU saturation), and the preserved log's stderr tail
is the exact noise green runs print (the tsx-wrapped CLI children leak their
stderr to the terminal even through execFileSync pipes, so that noise
identifies nothing). Recorded as VERIFICATION.md Known issue #11 (the #10
one-off class). No assertion touched anywhere in this round; no `src/` file
touched, so Gate 2 stays untriggered.

## Verification

**Gate 0** (`npm run typecheck`) — green at HEAD `d010172` before this
change (grounding-scout run this session). **Gate 1** (`npm run demo`)
sanity, token-free. **Gate 0.5** n/a (`src/parse.ts` untouched). The **new
Gate 1.19** runs via `npm run verify` after the Gate 1.17 check
(`scripts/verify.mjs:551` hook point), alongside Gates 1.5–1.17 which must
stay green — no existing gate can pin this: Gate 1.5 pins clean's disposal
semantics (VERIFICATION.md:36), Gate 1.17 pins the MachineWorker adapter
(VERIFICATION.md:1301), Gate 2 spends model tokens. **Gate 2 not triggered**
— no `src/runner.ts`, adapter, gate, workspace-handling, or report-shape
change (VERIFICATION.md:1428-1429); the escape clause is the AC above.
**Gate 3** n/a (no adapter change).
