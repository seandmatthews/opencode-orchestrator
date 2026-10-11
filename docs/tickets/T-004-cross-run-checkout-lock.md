# T-004 — Cross-run checkout lock: runs and cleanup serialize per target repo

**Status:** proposed
**Category:** ops
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** —

## What

A zero-dependency cross-process checkout lock so `npm run skeleton` and
`npm run clean` can never concurrently mutate one target repo's worktrees —
the lock T-002 marked optional and explicitly deferred
(`docs/tickets/T-002-run-artifact-cleanup.md:12-14`, `:68-73`).

- **`src/lock.ts` (new)** — acquire = `fs.openSync(path, 'wx')` exclusive create,
  Node stdlib only, `package.json` untouched. Probed on this machine this session:
  the second acquire of the same path rejects with `EEXIST` (node v22.23.1,
  matching the 2026-10-10 "TypeScript on Node 22" decision). Lock files live under
  `<run-root>\locks\` (default run root `C:\swarm`), filename derived from the
  normalized repo path — `norm()` semantics from `src/clean.ts:67` (lowercase,
  forward slashes) hashed via `node:crypto`, so `C:\swarm\demo-target` and
  `c:/swarm/demo-target` contend on one lock and any path is a safe filename.
  Locks are **never inside the target repo** (that would pollute the canonical
  checkout, AGENTS.md #3, and trip Gate 1's clean-fixture check), and `locks/` is
  structurally safe from `clean --all`, which sweeps only `/^\d{14}$/`
  directories (`src/clean.ts:249-252`). Contents: JSON `{ pid, startedAt, cmd,
  runId? }` — diagnosability only. **Try-once semantics:** an occupied lock
  refuses immediately; no waiting, no retry loop. Release = `unlinkSync` by the
  holder. `src/lock.ts` doubles as a CLI — `tsx src/lock.ts acquire <repo>`
  / `release <repo>` (exit 0 acquired/released, 1 refused; invoked list-form
  everywhere, AGENTS.md #4) — so scripts and humans can hold or clear a lock
  without duplicating the path derivation, and the Gate 1.5 extension below uses
  exactly this to hold a lock from the outside.
- **`src/cli.ts`** — acquire after repo validation (`src/cli.ts:136-139`) and
  before runId/artifactsDir creation (`:145-147`); hold for the run's whole
  duration; release in a `finally` on every path, including failures after
  acquisition (a bad `--base` fails at `src/cli.ts:149`, after the lock point).
  A refused run exits non-zero before spending planner tokens and before any
  worktree exists. This also closes the same-repo flavor of the same-second
  collision: today a second run interleaves `planner.log` appends and dies late
  on the branch collision; with the lock it refuses before
  `mkdirSync(artifactsDir)` (`src/cli.ts:147`).
- **`src/clean.ts`** — acquire **per target repo inside `cleanRunDir`**
  (`src/clean.ts:143`), covering both `--run` and `--all` (the repo is only known
  inside `cleanRunDir`, `:166-172`, and `--all` can span repos). Refusal = loud
  non-zero exit naming the holder pid, lock age, and lock file path; **nothing is
  removed** — the evidence-never-deleted rule (`src/clean.ts:6-8`) survives by
  construction.
- **New flag `--force-lock`** on both commands: take the lock from a
  suspected-stale holder explicitly. Distinct from clean's existing `--force`
  (discard uncommitted changes).
- **Stale-lock policy (v1):** never auto-reap, never guess liveness — any
  existing lock refuses with pid + age, and only `--force-lock` proceeds. This
  follows spec §15.2's crash-recovery philosophy ("no live process is silently
  reattached based on stale PID metadata",
  `docs/spec/inference-refinery-v2.md:1071`). A hard-killed run therefore leaves
  a lock that blocks until a human overrides — the refusal message must say
  exactly that and name the file.

**Does NOT claim:** no store-row variant — T-003's slice explicitly forbids the
pipeline reading the DB back (`docs/tickets/T-003-durable-run-records.md:58-63`),
so a store-row lock is a successor ticket after T-003 lands, not this one. No
change to `src/runner.ts`, `src/workspace/worktree.ts` lease logic,
`src/parse.ts`, or any adapter (`src/worker/opencode.ts` untouched — the engine
stays model/harness-agnostic; the lock knows repo paths, never model IDs). No
change to verdicts, gate results, `report.json` shape, or the exit code of any
run/clean that proceeds — the lock gates execution start only (machine gates
decide survival). No waiting/queueing semantics, no heartbeat/expiry/PID-liveness
reaping (stage-1 control plane, spec §34 Milestone 1, `:2017-2028`). The
same-second runId/artifactsDir collision across runs on *different* repos
(`src/cli.ts:145-147`) is untouched — a distinct defect for its own red/green
ticket.

## Why

Exactly two code paths mutate a target repo's worktree state and neither
acquires any lock: run-side leasing (`npm run skeleton` → `src/cli.ts:160-176` →
`src/runner.ts:61-64` → `src/workspace/worktree.ts:26-33`, `git worktree add -b
swarm/wt-XX`) and clean-side disposal (`src/clean.ts:143-227`, `git worktree
remove --force` at `:207` + `git branch -D` at `:134`). A repo-wide grep for
`lock` across `src/`, `scripts/`, `package.json`, `VERIFICATION.md` (run this
session) finds no locking mechanism — only the "checkout lock deferred" note at
`docs/ROADMAP.md:11`.

- **The destructive direction is unguarded by git** (probed this session in a
  throwaway repo): `git worktree remove --force` on a dirty, registered worktree
  exits 0 and the directory — uncommitted file included — is gone. So a
  `clean --run <id>` against a live run (clean takes no liveness precaution
  today) or any `--force` disposal (`scripts/verify.mjs:206-208`) destroys
  in-flight worktrees; clean's own dirty-refusal (`src/clean.ts:199-203`) is
  bypassed by the very flag disposal runs with.
- **Clean cannot tell a live run from a crashed one:** `report.json` is written
  once at the end (`src/runner.ts:89`), and clean's crash-recovery path
  (`readReport` fallback `src/clean.ts:82-88`, `wt/`-discovery `:155-160`) exists
  precisely to clean directories *without* a report. Without a lock, "still
  running" and "crashed mid-run" are indistinguishable to it.
- **Run-vs-run is safe only by accident:** both runs derive identical branch
  names from fixed candidate ids (`src/workspace/worktree.ts:11-13`,
  `src/cli.ts:168`), so the second lease dies loudly — `fatal: a branch named
  'swarm/wt-c01' already exists` (probed this session) — but only after planner
  tokens were spent. A repo lock refuses before any of that, at zero model cost.
- **The project's own record deferred this and names the payoff window:** T-002's
  What offered the lock as optional (`T-002:12-14`) and its Landed deviation
  deferred it because runs are single-session today (`T-002:68-73`). The race is
  real in the code and becomes live exactly when multi-session/stage-1 usage
  starts (spec §34 Milestone 1 scheduler `:2017-2028`; Milestone 3 worktree
  leases/GC `:2049-2059`). Spec §16 treats worktrees as leased resources
  (`:1109-1148`) but defines no cross-process lock, and §27's "SQLite is
  sufficient until actual contention proves otherwise" (`:1840`) argues for the
  cheap file-level guard now rather than waiting for the store.

## Acceptance criteria

- [ ] With a lock held on the sandbox repo (via `tsx src/lock.ts acquire`), `npm
      run clean -- --run <id>` refuses non-zero and removes nothing: `git
      worktree list` unchanged, `swarm/*` branches unchanged, evidence files
      intact, refusal naming the holder pid and lock age — pinned by the **new
      Gate 1.5 lock checks** (extension of the `scripts/verify.mjs:62-143`
      sandbox, added by this ticket). (Gate 1.5)
- [ ] With a lock held on the sandbox repo, `tsx src/cli.ts` refuses non-zero
      BEFORE any worktree or artifacts dir appears: `git worktree list` count
      unchanged and no 14-digit run dir under the sandbox run root — pinned by
      the same Gate 1.5 lock checks (token-free: the refusal precedes any model
      call). (Gate 1.5)
- [ ] Acquire + release round-trip: every run and clean that proceeds releases
      its lock — after success the lock file is gone; the existing Gate 1.5
      clean scenarios now also assert no residual lock file under
      `<run-root>\locks\`, with no existing assertion weakened — pinned by
      Gate 1.5. (Gate 1.5)
- [ ] Release-on-error: a failure after acquisition (bad `--base`, failing at
      `src/cli.ts:149` — after the lock point) exits non-zero and leaves no lock
      file behind — pinned by the Gate 1.5 lock checks. (Gate 1.5)
- [ ] `--all` locks per repo: a held lock on one run's target repo makes that
      run dir refuse while other run dirs still clean, and the final exit is
      non-zero — pinned by the Gate 1.5 lock checks with a two-run sandbox on
      two repos. (Gate 1.5)
- [ ] Stale-lock policy: a pre-existing lock file (simulating a crashed holder)
      refuses with pid + age + file path; nothing auto-reaps it; `--force-lock`
      takes it and the command proceeds — pinned by the Gate 1.5 lock checks
      plus the VERIFICATION.md policy statement (spec §15.2 philosophy,
      `:1071`). (Gate 1.5)
- [ ] No behavior change when uncontended: exit codes, stdout verdicts, and
      `report.json` of runs and cleans are unchanged — pinned by the full
      existing Gate 1.5 suite staying green, plus **one** `npm run verify:full`
      recorded in this ticket's Landed: `src/cli.ts` is the run entry point and
      Gate 2's disposal step already drives `src/clean.ts`
      (`scripts/verify.mjs:206-208`), so one real run exercises both lock sides
      end-to-end (T-003's no-behavior-change pattern; Gate 2 once, not a
      permanent extension). (Gate 1.5 + Gate 2, once)
- [ ] Zero new dependencies and correct placement: `fs.openSync(..., 'wx')`
      stdlib only, `package.json` untouched; lock files only ever under
      `<run-root>\locks\`, never inside the target repo — pinned by Gate 0
      typecheck green with no `npm install`, plus the Gate 1.5 lock checks
      asserting the lock file's path. (Gate 0 + Gate 1.5)
- [ ] VERIFICATION.md gains the lock behavior (Gate 1.5 section extension +
      stale-lock policy) and README/AGENTS.md document `--force-lock` and the
      lock CLI, all in the same change-set (AGENTS.md #6). (change-set review)

## Verification

Gate 0 (`npm run typecheck`) always; Gate 1 (`npm run demo`) sanity; Gate 1.5
via `npm run verify` — the fast tier carries the new lock checks added by this
ticket; **one** `npm run verify:full` (Gate 2) recorded in Landed as the
uncontended end-to-end proof (both lock sides exercised: run entry +
clean disposal). Gate 0.5 not required (`src/parse.ts` untouched); Gate 3 not
required (no adapter touched — `src/worker/opencode.ts` is unchanged).
