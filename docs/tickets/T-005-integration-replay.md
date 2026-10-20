# T-005 — Integration replay: re-verify a survivor's diff at current HEAD

**Status:** done 2026-10-11
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** T-004

## What

`npm run integrate -- --run <runId> --candidate cXX --gate "name=command" ...`: replay a
surviving candidate's captured `diff.patch` onto a fresh worktree of the target repo at
its **current HEAD**, re-run the operator-supplied gates there, and report the verdict.
First slice of spec §17 (§17.2 steps 1-4 and 6, minus the model jobs); merging stays a
human act (§17.4).

- **`src/integrate.ts` (new)** — standalone command mirroring `src/clean.ts`'s pattern
  (usage text, `parseArgs`, per-step console output, exit codes; list-form `git()`
  helper like `src/clean.ts:69-71`). Touches no pipeline file, no adapter, no report
  shape. Flow:
  1. Read `<runRoot>/<runId>/report.json` (`RunReport`, `src/types.ts:123-133`). The
     target repo is the report's `repo` field — no `--repo` flag, replay is defined only
     against the run's own target; missing report or repo field → refuse.
  2. Policy refusals (non-zero, before any worktree exists): candidate id not in the
     report; `passedAllGates !== true` (survivor-only — `passedAllGates` is what a gate
     verdict means, `src/runner.ts:275`); `diffPath` null or file missing; `diffBytes
     === 0`. A missing or empty diff is a refusal, **never a pass** (decisions.md
     2026-10-10: a zero-byte diff is a NO-OP verdict).
  3. Gate-name contract: the `--gate` names must exactly match the candidate's recorded
     `gates[].name` set — every supplied name known, every recorded name re-supplied.
     Gate *commands* are not in the report: `GateResult` carries only
     name/passed/exitCode/durationMs/outputTail (`src/types.ts:57-63`) and `RunReport`
     adds no commands (`src/types.ts:123-133`) — commands exist solely as run-time CLI
     flags (`src/cli.ts:102-108`, built into `CommandGate`s at `src/cli.ts:171`). So the
     operator re-passes the same flags, and the name set is the integrity check that the
     replay exercises the same gates the run survived. Mismatch → refuse before creating
     anything.
  4. Fresh integration worktree at current HEAD, list-form:
     `git worktree add --detach <runDir>/wt/int-<candidateId> HEAD`. Detached, so no
     branch is created and no ref moves (§17.4). Deliberately NOT
     `WorktreeProvider.lease` — it creates a `swarm/*` branch pinned to the run's
     baseSha (`src/workspace/worktree.ts:26-33`), both wrong for replay-at-current-HEAD.
  5. `git apply --check <diffPath>` then `git apply <diffPath>`, cwd = the integration
     worktree, diffPath a single argv element (list-form — AGENTS.md #4, the
     `src/clean.ts:9-11` precedent; Known issues #4 is proven on exactly this kind of
     path). On failure: loud refusal, non-zero exit, worktree left untouched — `git
     apply` is atomic (scout-probed this session in a throwaway repo: same-lines drift
     fails the whole patch — "patch does not apply" — and leaves
     `git status --porcelain` empty), so there is no partial state to clean up.
     Unrelated drift applies cleanly (scout-probed: same probe, modified + new files
     land). A diff touching a BINARY file can never replay: capture lacks `--binary`
     (`src/workspace/worktree.ts:76-85`), so `git apply` rejects the whole patch
     ("cannot apply binary patch ... without full index line" — scout-probed); the
     refusal message says so and points at the carved-off capture fix below.
  6. No-op guard: after a successful apply, `git status --porcelain` in the worktree
     must be non-empty; an apply that changes nothing is a NO-OP refusal, never a pass
     (AGENTS.md #7, decisions.md 2026-10-10).
  7. Re-run gates: one `CommandGate` per `--gate` flag, `run(cwd)` against the
     integration worktree (`src/gate/command.ts:21-39` — runs on any directory),
     sequentially, same default timeout as a run.
  8. Verdict + artifact: write `<runDir>/integrate/<candidateId>.json` — `{ runId,
     candidateId, appliedAt, targetHead, runBaseSha, applied, treeChanged, gates:
     GateResult[], passed, worktreePath }` — print a one-line console verdict. Exit 0
     iff applied + treeChanged + all re-run gates passed; non-zero otherwise, with the
     reason. Add-only: `report.json` and all run evidence untouched; the artifact lives
     under the run root (decisions.md 2026-10-10: run root is `C:\swarm\`).
  9. **Lock (T-004):** acquire the T-004 checkout lock on the target repo around steps
     4-8 and release in `finally`. Integrate is a THIRD code path that mutates a target
     repo's worktree state (after run leasing, `docs/tickets/T-004-cross-run-checkout-lock.md:76-84`,
     and clean disposal) — no locking mechanism invented here.
- **Disposal story (picking one side of the §16.1 tension):** the worktree is left in
  place after a successful integrate — for inspection — holding the replayed diff as
  uncommitted changes. It lives under `<runDir>/wt/`, so the existing `npm run clean`
  `wt/`-discovery (`src/clean.ts:155-160`) sweeps it **with `--force`**: after a
  successful apply it is dirty by construction (`src/clean.ts:193` computes dirty from
  `git status --porcelain`; `:199-203` refuses dirty without the flag) — the same
  reasoning Gate 2's disposal runs with (`scripts/verify.mjs:202-208`,
  VERIFICATION.md:82-83). Plain `clean` refusing it is correct behavior, not a gap:
  dirty-protection stays intact on this new worktree class, and no new disposal
  machinery is added. The
  deviation from §16.1's "integration: keep until human disposition" (spec :1144) is
  deliberate and recorded: what the human disposes over is the *evidence* —
  `integrate/<id>.json`, `diff.patch`, `report.json` — which survives cleanup by
  construction ("Commits, diffs, and evidence can survive after physical worktree
  removal", spec :1148), and the prepared tree is reproducible from that evidence by
  re-running this command. A worktree clean could never remove would re-create the
  exact manual-disposal pain T-002 retired.
- **`package.json`** — one script: `"integrate": "tsx src/integrate.ts"`. No new
  dependencies.
- **`scripts/verify.mjs`** — new Gate 1.5 integrate section (below), invoked list-form
  via tsx like the existing clean checks.
- **Docs in the same change-set:** VERIFICATION.md (Gate 1.5 integrate section),
  README (usage), AGENTS.md (run-it + layout), ticket status + index
  (docs/tickets/README.md:31).

**Does NOT claim:** zero model involvement anywhere — no adapter import, no harness
spawn, no reviewer call (decisions.md 2026-10-10: machine gates decide; models advise),
so Gate 3 is n/a. No change to `src/runner.ts`, `src/cli.ts`, `src/parse.ts` (Gate 0.5
n/a), `src/gate/command.ts` (consumed as-is), `src/workspace/worktree.ts`, or the
`RunReport`/`CandidateReport` shapes — therefore **Gate 2 is not owed**: nothing on
VERIFICATION.md:85-86's trigger list is touched. Carved off for later tickets: (1)
recording gate commands into `report.json` (report-shape change → owns its own Gate 2
run); (2) binary-safe diff capture (`git diff HEAD --binary` at
`src/workspace/worktree.ts:76-85` — pipeline behavior change, own red/green ticket; until
then integrate refuses binary stubs loudly, per the probed behavior above); (3) §17.2
steps 5/7/8 (integration-repair model job; Sol verification, spec Milestone 5; approval
queue, spec Milestone 7); (4) configurable §17.3 staleness policy — this slice always
replays at current HEAD, which is §17.3's hard rule anyway (`:1197`); (5) a
store-backed integrate (reads `report.json`/`diff.patch` files directly this slice;
T-003's slice forbids the pipeline reading the DB back,
`docs/tickets/T-003-durable-run-records.md:58-63` — a store-backed integrate is a
possible successor after T-003, not part of this one).

## Why

The design promise "survivors' `swarm/*` branches are disposable" is only safe if a
survivor can be reconstructed from its evidence alone — and disposal-by-design is real:
`src/clean.ts:6-8` (evidence kept, worktrees and branches never), and Gate 2 disposes
survivor worktrees `--force` after capture (`scripts/verify.mjs:206-208`). Yet
replay-from-evidence has no consumer: `diffPath` is write-only — written at
`src/runner.ts:261-264`, declared at `src/types.ts:114`, and nothing reads it back
(scout grep for `integrate|replay|git apply|cherry` across `src/`, `scripts/`,
`package.json`, README, AGENTS.md, VERIFICATION.md, docs/tickets/, docs/ROADMAP.md:
zero hits; corroborated by this ticket's own read of `src/runner.ts`, `src/cli.ts`,
`src/clean.ts`, `scripts/verify.mjs`). Replay-from-diff is also the only possible
mechanism: candidates never commit (`src/runner.ts:39`), so spec §17.1's "candidate
commit SHA(s)" (`:1168-1177`) do not exist — `(baseSha, diff.patch)` IS the candidate
identity. Spec basis: §17 "Integration Is Its Own Workflow" (`:1164`), §17.2
fresh-integration-worktree steps 1-6 (`:1179-1190`), §17.3 "integration replays against
current HEAD" (`:1192-1199`), §17.4 "V2 prepares integration candidates. Humans merge."
(`:1201-1203`), Phase 11 Integration Replay (`:1542-1546`). Honest ROADMAP note: there
is no integration row — the nearest is stage 6 / spec Milestone 6
(`docs/ROADMAP.md:17`); this ticket deliberately pulls a §17 slice forward because it
is small, token-free, and makes T-002's disposal safe rather than lossy.

## Acceptance criteria

- [x] Clean replay onto drifted HEAD: sandbox repo (Gate 1.5 throwaway pattern,
      `scripts/verify.mjs:62-143`) → recorded `report.json` + non-empty `diff.patch`
      (capture method identical to `src/workspace/worktree.ts:76-85`) → target main
      advanced with an unrelated commit → integrate exits 0,
      `<runDir>/integrate/<candidateId>.json` records every gate PASS with the
      post-drift HEAD as `targetHead`, the replayed worktree contains the change, and
      the canonical checkout is untouched (`git status --porcelain` empty, HEAD
      unchanged) — pinned by the **new Gate 1.5 integrate checks** added by this
      ticket. (Gate 1.5)
- [x] Conflict refusal: with same-lines drift, integrate exits non-zero naming the
      apply failure, and the integration worktree's `git status --porcelain` is empty
      (atomic — no partial state to clean) — pinned by the same Gate 1.5 checks.
      (Gate 1.5)
- [x] Evidence and policy refusals — candidate id not in the report,
      `passedAllGates === false`, `diff.patch` missing, `diffBytes === 0`, and a no-op
      apply (tree unchanged after apply) — each exit non-zero before or without
      producing a passing artifact; a missing or empty diff is NEVER a pass
      (AGENTS.md #7; decisions.md NO-OP rule) — pinned by the same Gate 1.5 checks.
      (Gate 1.5)
- [x] Gate-name contract: `--gate` names not exactly matching the candidate's recorded
      `gates[].name` set (extra, missing, or renamed) refuse non-zero before any
      worktree exists — pinned by the same Gate 1.5 checks. (Gate 1.5)
- [x] Prepares-only: after a successful replay the target has no new commits, no new
      branches, and unchanged refs; the integration worktree shows as detached in
      `git worktree list --porcelain` — pinned by the same Gate 1.5 checks (spec
      §17.4). (Gate 1.5)
- [x] Disposal, both faces: after a successful integrate, plain `npm run clean -- --run
      <id>` REFUSES the integration worktree and exits 1 — it holds the replayed diff as
      uncommitted changes (dirty check `src/clean.ts:193`, refusal `:199-203`, exit
      `:245`), so clean's dirty-protection is proven intact on this new worktree class;
      then `npm run clean -- --run <id> --force` removes the integration worktree via
      the existing `wt/`-discovery (`src/clean.ts:155-160`) while `integrate/<id>.json`,
      `diff.patch`, and `report.json` survive (`--force` is the repo's own disposal
      precedent: `scripts/verify.mjs:202-208`, VERIFICATION.md:82-83) — both pinned by
      the same Gate 1.5 checks running clean over the integrate sandbox. (Gate 1.5)
- [x] Zero new dependencies: `package.json` gains only the `integrate` script — pinned
      by Gate 0 green with no `npm install`. (Gate 0)
- [x] VERIFICATION.md gains the Gate 1.5 integrate section; README (usage) and
      AGENTS.md (run-it + layout) document `npm run integrate`; ticket status + index
      updated in the same change (docs/tickets/README.md:31) — pinned by change-set
      review (AGENTS.md #6, decisions.md 2026-10-10 process entry). (change-set review)

## Landed

2026-10-11, in one change-set, on top of the landed T-004 lock (its step 9 is
implemented as specified: the whole post-refusal flow runs under
acquireCheckoutLock, released in finally — and the gate proves no residual
lock files on any path). No deviations from the ticket's What.

- `src/integrate.ts` (new) — the full flow of steps 1-9: report read (target =
  the run's own repo field), survivor + evidence refusals, exact gate-name
  contract (both directions, with missing/extra named), detached worktree at
  current HEAD (never WorktreeProvider.lease), `git apply --check` then
  `git apply` list-form with the binary-patch refusal message, NO-OP guard on
  post-apply `git status --porcelain`, sequential CommandGate re-run,
  `<runDir>/integrate/<id>.json` verdict artifact, exit 0 iff applied +
  treeChanged + all gates passed. One implementation note worth keeping:
  process.exit() skips finally blocks, so the locked region returns codes and
  the release-then-exit happens above the finally — the gate's residual-lock
  assertion pins this on every path (it caught exactly this leak during
  development: an exit-inside-try left the conflict path's lock behind and the
  next scenario refused on it).
- `package.json` — only the `integrate` script added; zero new dependencies.
- `scripts/verify.mjs` — Gate 1.5 integrate checks: 30 assertions over the
  throwaway sandbox (AC#1 clean replay onto drifted HEAD incl. artifact fields
  and untouched canonical checkout; AC#2 conflict refusal with atomic empty
  worktree; AC#3 all five refusals incl. the hand-crafted identical-hunk no-op
  apply whose artifact records applied=true/treeChanged=false/passed=false;
  AC#4 extra/missing/renamed gate names refusing before any worktree exists;
  AC#5 prepares-only; AC#6 both disposal faces; sandbox fully disposed, no
  locks left). Diffs are captured exactly like src/workspace/worktree.ts
  (add -A --intent-to-add, diff HEAD).
- Docs: VERIFICATION.md Gate 1.5 'Integration replay' section, README usage +
  prepare-not-merge paragraph, AGENTS.md run-it + layout. Ticket + index in the
  same change.

Gates: Gate 0 green; Gate 1 green; `npm run verify` ALL GREEN (Gate 1.5
cleanup + lock + integrate + Gate 1.6). Gate 2 NOT run, as the ticket states:
no runner/adapter/gate/workspace/report-shape change is in this change-set.
Gate 0.5 n/a (`src/parse.ts` untouched); Gate 3 n/a (zero model involvement).

## Verification

Gate 0 (`npm run typecheck`) always; Gate 1 (`npm run demo`) sanity, token-free; the
**new Gate 1.5 integrate checks** via `npm run verify` — added by this ticket, which
then carries them permanently. **Gate 2 is not required and not run**: the slice touches
none of VERIFICATION.md:85-86's triggers (no `src/runner.ts`, no adapter, no gate code,
no workspace handling, no report-shape change) — stated here so it is neither silently
skipped nor silently owed; any successor that adds gate commands to `report.json` or
changes capture owns a Gate 2 run. Gate 0.5 n/a (`src/parse.ts` untouched); Gate 3 n/a
(no adapter — zero model involvement).
