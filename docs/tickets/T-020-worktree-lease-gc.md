# T-020 — Worktree lease GC: orphaned worktree + `swarm/*` branch reconciliation and disposal

**Status:** done
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** T-002 + T-004 + T-010 (all done — the disposal loop, the checkout lock, and the dispatch/recovery evidence GC classifies against)

## What

A standalone garbage-collection pass, `npm run gc` (new `src/gc.ts`; the
`src/clean.ts`/`src/recover.ts`/`src/integrate.ts` standalone-entry pattern —
package.json `gc: tsx src/gc.ts`, zero new dependencies), that walks the run
root, classifies every run directory against the evidence the engine already
produces, and disposes — through `src/clean.ts`'s existing lock-serialized,
dirty-refusing disposal loop — only what is provably orphaned. One mergeable
change-set.

CLI surface: `npm run gc -- [--run-root <path>] [--force-lock]` (`--run-root`
default `C:\swarm`, the clean/recover convention). Deliberately **no `--force`**:
GC never discards uncommitted changes — a dirty worktree is refused and
reported per-item, with a pointer at `npm run clean -- --run <id> --force`
(today's manual path for exactly that case).

- **Classification, per run directory** — every run dir is reported with its
  class:
  1. **live (lock held)** — acquiring the per-repo checkout lock
     (`acquireCheckoutLock`, `src/lock.ts`) is refused ⇒ the run may be live ⇒
     skip, report the holder pid/age/path, remove nothing. `--force-lock` is
     honored exactly as `clean` honors it (`src/clean.ts:159-168`) — the
     explicit human override for a suspected-stale holder, never an automatic
     reaper (VERIFICATION.md:78-82).
  2. **crashed-unreconciled** — no `report.json` and no `recovery.json` ⇒
     report "run `npm run recover` first", skip, remove nothing. Unreconciled
     debris may still have recorded-running workers whose trees only
     recovery's verify-before-kill may touch (T-010's posture; Gate 1.11's
     report-only pin stays intact — GC is a separate command, not a recover
     extension).
  3. **crashed-reconciled** — `recovery.json` present, no `report.json` ⇒
     worktrees + branches are disposable: targets from the dispatch records'
     `worktreePath`/`branch` fields (`dispatch.jsonl`, written at
     `src/runner.ts:428-436`), the `recovery.json` workspaces, and
     `wt/`-discovery (`registeredWorktrees`/`sniffRepo`,
     `src/workspace/worktree.ts:24-54`) — fed through clean's per-worktree
     disposal loop with its dirty-refusal, prune-fallback, and
     `removeBranch`-after-removal semantics (`src/clean.ts:181-237`).
  4. **finished** — `report.json` present ⇒ the run completed; its workspaces
     were disposed in-run (`src/runner.ts:591-598`) or are `clean`'s ordinary
     business ⇒ no worktree disposal here; eligible only for the branch sweep
     below.
- **Repo-side branch sweep (the `--clean` leak fix).** For each target repo
  touched (from `report.json`'s `repo` field, falling back to `sniffRepo` —
  the `src/clean.ts:146-152` pattern), list `swarm/*` branches (list-form
  `git branch --list 'swarm/*'`) and delete exactly those that (a) have no
  worktree currently registered on them (`registeredWorktrees`) and (b) are
  attributable to a **terminal** run — class 3 or 4 — via its dispatch
  records' `branch` fields, its report candidates
  (`branchForLeaseId('wt/<id>')`, retry legs included: `wt/<id>-a<n>` →
  `swarm/wt-<id>-a<n>`, VERIFICATION.md:324-325), or its `wt/` entry names.
  Branches attributable to no terminal run are reported as unowned and never
  deleted; branches on registered worktrees are never deleted. Workers never
  commit (the diff is captured to `diff.patch` first), so a `swarm/*` branch
  carries no unique evidence — only the base-SHA pointer the lease created
  (`src/workspace/worktree.ts:67-74`).
- **Never touched, by construction:** `wt/int-*` worktrees (integration-replay
  leftovers, dirty by construction, held until human disposition — spec §16.1
  `integration` retention class, VERIFICATION.md:119-123) are excluded from
  every target set and reported as held; all evidence files (`report.json`,
  `dispatch.jsonl`, `recovery.json`, `worker.log`, `diff.patch`,
  `integrate/<id>.json`) — GC disposes git worktrees and `swarm/*` branches
  only, the T-002 rule (`src/clean.ts:6-8`, VERIFICATION.md:44-47); a held
  lock; a live run's lease.
- **Locking and exit conventions:** the per-repo lock is taken inside the
  per-run pass and released in a `finally` on every path (the
  `src/clean.ts:157-177` pattern); every git subprocess is list-form
  (AGENTS.md #4). Exit 0 when the sweep completed — skipped-live and
  crashed-unreconciled runs are healthy classifications, not failures; exit 1
  when any disposal item was refused or failed (dirty worktree, git failure —
  clean's convention, `src/clean.ts:254-255`).
- **Shared-code extraction, not duplication:** `readReport`/`RunResult`/
  `removeBranch`/`disposeTargets` move out of `src/clean.ts` into one shared
  module imported by both `clean.ts` and `gc.ts` (the T-010 extract precedent
  that put `sniffRepo`/`registeredWorktrees` in `src/workspace/worktree.ts`).
  Clean's semantics are unchanged — Gate 1.5 must stay green. The module is
  deliberately **not** `src/workspace/worktree.ts`, and `src/runner.ts` is
  untouched, so the change-set stays off Gate 2's trigger list
  (VERIFICATION.md:1428-1429); if the landed change-set touches either file
  anyway, Gate 2 runs once at landing.

**Does NOT claim:**

- **No durable lease records** — no §27 `workspace_leases` table (absent from
  the store today; grep over `src/store/index.ts` finds no such table) and no
  §28 `WORKTREE_LEASE_CREATED`/`WORKTREE_GC_STARTED` writers. Carved: a lease
  record is retention machinery, not a GC prerequisite — `dispatch.jsonl`
  already carries the lease identity per attempt (`src/runner.ts:428-436`),
  and extending T-010's in-run-write posture (evidence artifact, never in-run
  DB writes) deserves its own decision.
- **No retention policies / `expiresAt`** (§16.1's graded classes) — GC
  implements one binary classification, debris-vs-live; the graded classes are
  the next stage-3 item.
- **No recover changes** — `recover` stays report-only (Gate 1.11's
  byte-identical pin, VERIFICATION.md:621-626); GC consumes recovery.json,
  never produces it, and never flips that pin.
- **No pipeline changes** — `src/runner.ts` and the WorktreeProvider are
  untouched; the `--clean` branch leak is fixed at GC time, not by making
  in-run `dispose` delete branches (that would change run-time behavior and
  trigger Gate 2).
- **No startup-automatic GC** — not wired into `npm run skeleton` or any
  startup path; it is an explicit command in the clean/recover family. T-004's
  never-auto-reap policy bounds how automatic a crashed-run GC can be anyway:
  a crashed run's stale lock blocks until a human overrides.
- **No §26.7 retention UI, no disposable clones, no short-path run roots** —
  the rest of §34 Milestone 3's build list.

## Why

Spec-mandated in three places, and the explicitly carved remainder of stage 3.
§16 (`docs/spec/inference-refinery-v2.md:1109-1148`) makes worktrees leased
resources (`WorkspaceLease` with `createdAt`/`expiresAt`/`retentionClass`,
:1113-1122) whose commits, diffs, and evidence "can survive after physical
worktree removal" (:1147); §34's Milestone 3 build list names "worktree
leases" and "GC" (`:2049-2059`); §29's recovery step 5 is "validate worktree
leases" (`:1876`) — and T-010's `recover` implements only marks/kills/inspect,
removing nothing. §27:1830 names the `workspace_leases` table and §28:1859-1860
the `WORKTREE_*` events — both reserved, neither implemented (the carve is
recorded in T-010:156-158 and VERIFICATION.md:648-650). `docs/ROADMAP.md:15`
lists stage 3 as "partial 2026-10-16 … remaining: worktree leases/GC, retention
policies, disposable clones, short-path run roots" — this ticket is the GC
half of the first item, with lease *records* carved (see Does NOT claim).

The pain is code-proven and reproduced. A lease is
`git worktree add -b swarm/wt-<id>` (`src/workspace/worktree.ts:67-74`); the
in-run dispose is ONLY `git worktree remove --force` (`:83-85`) — branch
deletion exists nowhere in `src/` outside clean's `removeBranch`
(`src/clean.ts:108-121`). Every `--clean` run (documented `src/cli.ts:66`)
nulls each candidate's `workspacePath` after in-run dispose
(`src/runner.ts:591-598`) and tidies the emptied `wt/` dir, so a post-run
`clean` finds no targets — null `workspacePath` is skipped
(`src/clean.ts:130-134`), `wt/` discovery finds nothing (`:135-140`) — and
prints "nothing to clean", exit 0 (`:141-144`). Scout-reproduced end-to-end
this session (throwaway sandbox `C:/swarm/verify-scout-lease`, removed
afterward): manual lease + `worktree remove --force` left `swarm/wt-c01`
behind; a `--clean`-shaped `report.json` (`candidates:[{id:'c01',
workspacePath:null}]` — the exact shape `src/runner.ts:591-598` produces) plus
`clean --run` printed "nothing to clean (no live worktree records in
report.json or wt/)", exited 0, and left the branch; `clean --all` skips it
too. So every `--clean` run permanently leaks its `swarm/wt-<id>` and
retry-leg `swarm/wt-<id>-a<n>` branches in the target repo — and a leaked
branch breaks the NEXT run against the same repo (`git worktree add -b
swarm/wt-c01` fails when the branch exists, `src/workspace/worktree.ts:70-73`),
the exact "leftover branches silently block reuse of candidate IDs" pain
T-002 recorded, now with a permanent producer. No gate notices: Gate 1.17 S5
drives a real `--clean` machine run (`scripts/check-machine-worker.mjs:242-299`)
and asserts no branch hygiene afterward; Gate 2's "no `swarm/*` branches left"
pin (VERIFICATION.md:1420-1421) never exercises `--clean` (Gate 2's
`skeletonArgs`, `scripts/verify.mjs:563-572`, carry no `--clean`).

Crash debris is the second orphan class: a hard kill reaches none of the three
dispose sites (`src/runner.ts:511-517`, `:576-583`, `:591-598`) and never
releases the checkout lock (release is in `main`'s `finally`,
`src/cli.ts:290-297`); T-010's `recover` then marks/kills/inspects but removes
nothing (VERIFICATION.md:621-626). After recovery, disposal is still per-run
manual `clean` — no single pass reconciles a machine's debris against its live
runs. Gate 1.11 correctly pins recover's report-only-ness, so GC must be a
separate command, not a recover extension.

Live-machine scoping, stated honestly (scout-run check this session):
`C:/swarm` currently holds 4 run dirs all with `report.json`, its single `wt/`
dir is empty, `locks/` is empty, and `demo-target` has 0 `swarm/*` branches —
the defect is construction-proven and history-proven, not currently observed
as live debris.

Posture: machine gates decide survival; models advise (decisions.md:19-21) —
GC records and disposes, never enters any verdict. Run root stays `C:\swarm`
(decisions.md:25-26); TypeScript/Node-22 zero-new-deps holds.

## Acceptance criteria

- [x] `npm run gc` walks the run root, reports every run dir's classification
      and per-item results, and disposes a crashed-reconciled run's orphaned
      worktree + branch through clean's disposal semantics (worktree removed,
      branch removed after) with exit 0 — pinned by **Gate 1.18** (throwaway
      sandbox repo + hand-leased worktree + dispatch/recovery-shaped evidence;
      token-free).
- [x] A dirty worktree in a crashed-reconciled run is refused, never
      force-deleted (GC takes no `--force`): reported per-item with the
      `clean --force` pointer, worktree + branch intact, exit 1 — pinned by
      **Gate 1.18**.
- [x] A crashed-unreconciled run (no `report.json`, no `recovery.json`) is
      reported "recover first" with nothing removed, exit 0 — pinned by
      **Gate 1.18**.
- [x] A held checkout lock skips the run as live, names the holder, and
      removes nothing (the T-004 never-auto-reap policy, VERIFICATION.md:78-82;
      `--force-lock` parity with clean documented in the command's help) —
      pinned by **Gate 1.18**.
- [x] The branch sweep deletes only `swarm/*` branches that have no registered
      worktree and are attributable to a terminal run (finished or
      crashed-reconciled, retry legs `swarm/wt-<id>-a<n>` included); unowned
      `swarm/*` branches are reported and never deleted; branches on
      registered worktrees are never deleted; every git call list-form —
      pinned by **Gate 1.18**.
- [x] The reproduced `--clean` leak is pinned red-before/green-after in the
      existing Gate 1.17 S5 sandbox (`scripts/check-machine-worker.mjs:242-299`):
      after the real `--clean` machine run, `swarm/*` branches ARE present
      (the recorded red bar — AGENTS.md #8), then `npm run gc` on that run
      root removes exactly them, leaving no `swarm/*` branches and only
      `main` in `worktree list` — pinned by the **extended Gate 1.17 S5**.
- [x] `wt/int-*` worktrees are never auto-disposed: a dirty `int-<candidate>`
      worktree survives a GC pass byte-identical and is reported
      held-for-human-disposition (spec §16.1 `integration` class) — pinned by
      **Gate 1.18**.
- [x] Evidence is never deleted: `report.json`, `dispatch.jsonl`,
      `recovery.json`, `worker.log`, `diff.patch` hash-identical across every
      Gate 1.18 scenario — pinned by **Gate 1.18**.
- [x] Clean, recover, and the store behave exactly as before: Gate 1.5
      (clean/lock/integrate semantics), Gate 1.11 (recover report-only), and
      Gates 1.6/1.16 (store) stay green in `npm run verify` — pinned by the
      fast tier.
- [x] Zero new dependencies; all git subprocesses list-form (AGENTS.md #4) —
      pinned by **Gate 0** plus change-set review.
- [x] VERIFICATION.md gains the Gate 1.18 section, the ticket status + index
      row move in the same change-set, and `docs/ROADMAP.md:15`'s stage-3 row
      is updated (GC done; durable lease records + retention policies remain)
      — pinned by change-set review (AGENTS.md #6).

## Landed

2026-10-18, lane branch `ticket/T-020-worktree-lease-gc`.

What changed:

- **`src/gc.ts`** (new) — `npm run gc -- [--run-root <path>] [--force-lock]`
  (`package.json` gained `"gc": "tsx src/gc.ts"`; zero new dependencies).
  Walks the run root (14-digit timestamp run directories, the `clean --all`
  convention — `locks/`, `refinery.db`, and fixture repos are structurally
  outside), classifies every run dir against the engine's evidence, and
  reports the class per dir: **live** (the per-repo checkout lock is refused
  — the run may be live; the never-guess T-004 policy: skip, print the
  holder pid/age/path, remove nothing; the lock is checked for every run dir
  with a determinable repo, making it the liveness probe ahead of evidence
  classification), **crashed-unreconciled** (no `report.json`, no
  `recovery.json` → "run `npm run recover` first", remove nothing),
  **crashed-reconciled** (`recovery.json` present, no `report.json` →
  targets from the dispatch records' `worktreePath`/`branch` fields, the
  `recovery.json` workspaces, and `wt/`-discovery, deduped, fed through
  clean's disposal loop with `force=false`; `wt/int-*` paths excluded and
  reported held), **finished** (`report.json` present → no worktree
  disposal, branch sweep only). Repo discovery: report `repo` → dispatch
  header `repo` → `sniffRepo` over the wt/ entries, dispatch paths, and
  recovery paths (the clean/recover pattern). Branch sweep (the `--clean`
  leak fix): list-form `git branch --list 'swarm/*'`; deletes exactly the
  branches with no registered worktree AND attributable to the terminal run
  (dispatch `branch` fields, report candidates `branchForLeaseId('wt/<id>')`
  with retry legs `wt/<id>-a<n>`, `wt/` entry names); unowned branches and
  registered-worktree branches are reported and never deleted. Per-repo lock
  taken inside the per-run pass, released in `finally` on every path;
  `--force-lock` is clean's documented override; NO `--force` exists — a
  dirty worktree is refused per-item and gc prints the
  `npm run clean -- --run <id> --force` pointer, which demonstrably works.
  Exit 0 when the sweep completed (live/unreconciled skips are healthy),
  1 on any refused/failed disposal item (clean's convention).
- **`src/disposal.ts`** (new) — the shared disposal internals extracted
  verbatim from `src/clean.ts`: `readReport`/`RunReportLike`/`RunResult`/
  `removeBranch`/`disposeTargets` (dirty-refusal, prune fallback,
  branch-after-removal — the T-002 semantics, unchanged). Deliberately NOT
  `src/workspace/worktree.ts` (that file is the WorkspaceProvider seam;
  decisions.md 2026-10-18 keeps it the only one).
- **`src/clean.ts`** — imports the extracted internals; no behavioral change
  (Gate 1.5 green).
- **`scripts/check-gc.mjs`** (new) — **Gate 1.18**: one sandbox repo, a run
  root holding one run dir per classification, driven through the real CLI.
  30 assertions, all green: A1 crashed-reconciled disposal (worktree then
  branch, order pinned on the output), A2 recover-first with nothing
  removed, A3 the `--clean` leak shape (`swarm/wt-c03a`, `swarm/wt-c03b`,
  retry-leg `swarm/wt-c03b-a2` deleted; unowned `swarm/wt-ghost` kept), A4
  registered-worktree branch kept, A5 dirty refusal + working `clean
  --force` pointer + exit 1, A6 dirty `wt/int-c06` byte-identical and held
  while sibling orphan c06b is disposed, E evidence hash-identical + no
  residual locks, B held-lock live classification naming holder pid + lock
  path with exit 0 and `--force-lock` parity (proceeds, disposes, releases),
  plus the end-state pin (exactly main + c02 + c04 + int-c06 and branches
  c02/c04/ghost remain), and `--help` documenting the surface.
- **`scripts/check-machine-worker.mjs`** — Gate 1.17 S5 extended in place
  with the red-before/green-after pin of the reproduced `--clean` leak (4
  new assertions): after the real `--clean` machine run the three
  `swarm/wt-*` branches ARE present (the recorded red bar), then `gc` on
  that run root removes exactly them (no `swarm/*` branches left, only
  `main` in `worktree list`, `report.json` intact).
- **`scripts/verify.mjs`** — Gate 1.18 hooked after Gate 1.17 in the fast
  tier.
- **Docs** — VERIFICATION.md gained the Gate 1.18 section; the ROADMAP
  stage-3 row moved; this ticket and the index row flipped in the same
  change-set.

Carved, exactly the ticket's Does-NOT-claim list: no §27 `workspace_leases`
table and no §28 `WORKTREE_*` events, no retention policies/`expiresAt`, no
recover changes (recover stays report-only; GC consumes recovery.json, never
produces it), no pipeline changes (`src/runner.ts` and the WorktreeProvider
untouched — the leak is fixed at GC time, not by making in-run dispose
delete branches), no startup-automatic GC, no §26.7 retention UI / clones /
short-path run roots.

Measured gates (this lane): `npm run typecheck` exit 0; `npm run demo` green
(build ok + tests ok); `node scripts/verify.mjs fast` → **"verify (fast)
complete: ALL GREEN"** — Gate 0, Gate 1, Gate 0.5, and Gates
1.5/1.6/1.7/1.8/1.9/1.10/1.11/1.12/1.13/1.14/1.15/1.16/1.17 (extended S5)/
1.18 (new) all green, run twice end-to-end in the lane (and Gate 1.17/Gate
1.18 standalone green before that). Gate 2 NOT triggered and not run: no
pipeline file touched (no `src/runner.ts`, adapter, gate, or
workspace-handling change, no report-shape change — the shared disposal
module is a `clean.ts` extraction; trigger list, VERIFICATION.md Gate 2).
Gate 3 n/a.

## Verification

Gate 0 (`npm run typecheck`) always — green at HEAD `55302c0` before this
change (scout-run this session). Gate 1 (`npm run demo`) sanity, token-free.
Gate 0.5 n/a (`src/parse.ts` untouched). The **new Gate 1.18**
(`scripts/check-gc.mjs` + hook in `scripts/verify.mjs` after Gate 1.17 — the
slice-owns-its-gate precedent T-003→T-019; no existing gate can pin GC: Gate
1.5 pins clean's own semantics, Gate 1.11 pins recover's report-only-ness,
Gate 2 spends model tokens) runs via `npm run verify`, alongside Gates
1.5/1.6/…/1.17 which must stay green. **Gate 1.17 is extended in place** (the
S5 red-bar + gc assertions above). **Gate 2 not triggered** — no
`src/runner.ts`, adapter, gate, or workspace-lease change and no report-shape
change (trigger list, VERIFICATION.md:1428-1429); the shared disposal module
is a `clean.ts` extraction. If the landed change-set touches
`src/workspace/worktree.ts` or `src/runner.ts`, Gate 2 runs once at landing.
Gate 3 n/a (no adapter change).
