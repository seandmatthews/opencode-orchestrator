# T-027 — Recorded gate commands in report.json: `GateResult.command` end to end (closes T-005 carve #1)

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** T-005 (done — extends its landed name-set gate contract; T-005:100-102 carves exactly this)

## What

Record each gate's command alongside its `GateResult` in `report.json`, and make
integration replay compare-when-recorded, so a replay can prove it exercised the same
commands the run survived instead of trusting the name set alone. One change-set:

- **`src/types.ts:118-130`** — optional `command?: string` on `GateResult`, docblocked
  as: *present when the gate was a shell command (`CommandGate`, the only real
  producer); absent for non-shell gates and pre-existing reports.* Same optional-field
  pattern as `cleanupFailures` (T-011): evidence only, never a verdict. The `Gate`
  seam (`src/types.ts:136-139` — `name` + `run(cwd)`) is unchanged, and `RunReport` /
  `CandidateReport` gain no fields — the command rides inside `gates[]` (the report is
  repo-native; the spec defines no RunReport shape, `src/types.ts:354-366`).
- **`src/gate/command.ts:53-60`** — one line in the resolved object:
  `command: this.command` (the field is already a private constructor member,
  `src/gate/command.ts:22-28`). It lands on every resolve path — pass, fail, and
  timeout alike (a killed shell still ran a known command).
- **`src/runner.ts` — no change.** The existing report write
  (`src/runner.ts:224`, gates pushed at `:598`) records the field automatically. The
  elimination ladder keeps reading `passed` alone (`src/runner.ts:604`) — the recorded
  command is verdict-blind by construction, not by discipline.
- **`src/integrate.ts`** — (a) correct the now-false docblock and usage: ":12-14
  (`gate COMMANDS are not recorded in report.json`)" and ":39-41 (`commands are not
  recorded — the operator re-supplies them`)"; (b) extend `gateContract`
  (`:115-123`) to compare-when-recorded: the name-set check stays for every gate, and
  when a recorded result carries `command`, the re-supplied command must equal it
  exactly; a recorded result without `command` falls back to name-only — today's
  behavior, byte-for-byte; (c) the contract check stays in the pre-lock policy-refusal
  block (`:143-158`, before `acquireCheckoutLock` at `:168`), so a mismatch refuses
  non-zero with no worktree and no lock taken; (d) `IntegrateVerdict.gates`
  (`:133`) gains `command?: string` — the replay verdict artifact then records the
  re-supplied commands verbatim, because its entries are `CommandGate` results
  (`:242-259`).
- **Checks extended in the same change-set** (details under Acceptance criteria):
  Gate 1.5's integrate sandbox (`scripts/verify.mjs:261-`) gains the three contract
  faces — its `REPORT_GATES` fixtures (`:294-297`) already old-shape, serving as-is as
  the back-compat pins; Gate 1.17 S5 (`scripts/check-machine-worker.mjs:279-287`)
  asserts the on-disk report's gate entries carry the job spec's command end-to-end
  (`:251-252`); `validateGateResult` (`src/probe.ts:364-378`) gains "command, if
  present, is a non-empty string", pinned by Gate 1.15 fixture extensions in
  `scripts/check-probe.mjs`.
- **VERIFICATION.md in the same change-set** (AGENTS.md #6): the integrate section's
  "gate commands are not recorded in `report.json`, so the name set is the integrity
  check" (`:106-107`) rewritten to the compare-when-recorded contract; the Gate 1.5,
  1.15, and 1.17 sections describe the new faces; ticket status + index updated.

**Why recording a command is not a model judging anything** (decisions.md:19-21,
2026-10-10: machine gates decide survival; models advise): the verdict stays
exit-0-or-not, computed by the shell command, exactly as before — the recorded string
is a photograph of what the machine gate already was, in the same evidence class as
`cleanupFailures` and probe entries. Nothing in the ladder reads it
(`src/runner.ts:604` computes `passedAllGates` from `passed` and `diffBytes` alone),
the reviewer never sees it, and no verdict, promotion, or elimination input changes.
It is evidence completeness: a reader of `report.json` can know what produced each
verdict without trusting an operator's memory of flags, and integrate's refusal
compares evidence instead of assuming it.

**Does NOT claim:** no adapter, no harness knowledge — the command is CLI/config
data, never model knowledge (AGENTS.md #1), so Gate 3 is n/a; no `src/parse.ts`
(Gate 0.5 n/a); no `Gate` seam change (the runner still cannot know commands, which
is why the stamping lives in the producer); no store change — `upsertGateResult`
keeps its five fields (`src/store/index.ts:1223-1236`), so Gate 1.6 stays green
untouched, and a nullable `gate_results.command` column is carved for a successor
*only if a DB consumer emerges*; no replay mode that reuses recorded commands instead
of re-supplying `--gate` flags — that is a CLI-contract change of its own, and
re-supply-and-compare is deliberately the integrity mechanism (the operator confirms
the commands; the report is only allowed to refuse); no command recording in probe
EvidenceBundles — their `GateResult` entries are argv-form evidence of a different
shape (`src/probe.ts:623`, `:1288`) and stay legitimately command-less. Sibling
sequencing: T-026 (proposed, carve #2) also touches `src/integrate.ts` but a
different region — its apply-refusal block (`:206-220`) vs this ticket's
docblock/`gateContract` (`:12-14`, `:39-41`, `:115-123`) — and `src/workspace/
worktree.ts`; no assertion overlap, and neither changes the other's fixtures.

## Why

Integration replay at current HEAD is the repo's only post-hoc re-verification path
(spec §17.3:1192-1199; §9.1:700-714 — deterministic gates decide), and its integrity
check is the gate NAME set only: `GateResult` has no command field
(`src/types.ts:118-130`), `CommandGate` keeps its command private
(`src/gate/command.ts:22-28`), and commands exist solely as run-time CLI values —
parsed from `--gate` flags (`src/cli.ts:215-221`) and per-job specs
(`src/cli.ts:275`), then dropped into `CommandGate`s (`src/cli.ts:429`, `:275`). The
`Gate` seam (`src/types.ts:136-139`) means the runner (`src/runner.ts:596-604`)
cannot know them — the only uniform place a command can meet its verdict is inside
the producer's own `GateResult` (`--jobs` per-job gate sets rule out any run-level
recording). Consequence today: a wrong or mutated command re-supplied under the
right name replays silently, indistinguishable from replaying the run's own gate
(`src/integrate.ts:12-14`, `:115-123`; VERIFICATION.md:106-107; the T-005 contract,
`docs/tickets/T-005-integration-replay.md:29-36`).

This is T-005's explicitly carved successor #1: "recording gate commands into
`report.json` (report-shape change → owns its own Gate 2 run)"
(`T-005:100-102`), pre-charged at `:225-226` ("any successor that adds gate commands
to `report.json` … owns a Gate 2 run"). T-026 closes carve #2 and confirms #1
untouched (`T-026:70-72`).

Blast radius verified by reading the pins: the one exact gate-result key-set pin
(Gate 1.20 S1, `scripts/check-capabilities.mjs:195-199`) rides the fake `passGate`
(`:55-58`, a literal without `command`) and stays green untouched; Gate 1.12 S2 pins
fields, not key sets (`scripts/check-kill-tree.mjs:131-141`); Gate 1.17 S5 and Gate
1.19 assert name/passed only (`scripts/check-machine-worker.mjs:279-287`;
`scripts/check-long-paths.mjs:204-209`); the vendored fixture gates are command-less
(`scripts/fixtures/report-real.json:33-48`); the store reads five fields
(`src/store/index.ts:1223-1236`); probe-bundle entries are hand-built without
command and `validateGateResult` currently ignores unknown fields
(`src/probe.ts:364-378`), so a shape rule for `command` is additive strictness.

## Acceptance criteria

- [ ] `CommandGate` stamps `command` onto every `GateResult` it resolves — pinned
      end-to-end by the extended **Gate 1.17 S5** (real CLI, real `CommandGates`):
      the on-disk `report.json`'s gate entries for `codemod-a`/`codemod-b` carry
      `command` exactly equal to the job spec's commands
      (`scripts/check-machine-worker.mjs:251-252`). Gate 0 must also be green.
- [ ] Command mismatch refuses pre-worktree: a re-supplied command that differs from
      a recorded `command` exits non-zero from the pre-lock policy-refusal block,
      having created no integration worktree and taken no lock — pinned by a new
      **Gate 1.5** face asserting the refusal AND the sandbox repo's `git worktree
      list` / run `wt/` unchanged.
- [ ] Exact match replays: names AND commands equal → exit 0, gates PASS — pinned by
      a new **Gate 1.5** face whose fixture report carries the `CLI_GATES` commands.
- [ ] Old-shape reports replay name-only, exactly today's contract: a recorded gate
      without `command` replays on the name set alone — including a *different*
      command under a matching name — pinned by the existing **Gate 1.5** fixtures
      (`scripts/verify.mjs:294-297`) running unchanged, plus one new face asserting
      the different-command/same-name/old-shape case does NOT refuse. No weakening:
      the T-005 name-set contract stays for every report that lacks commands
      (T-005:29-36).
- [ ] The replay verdict records what ran: after a passing replay,
      `integrate/<id>.json` gate entries carry `command` equal to the re-supplied
      flags — pinned by a **Gate 1.5** face (rides the `CommandGate` stamp;
      `IntegrateVerdict.gates`, `src/integrate.ts:133`, gains `command?`).
- [ ] `validateGateResult` gains "command, if present, is a non-empty string"
      (refuse `''`, refuse non-string; absent accepted) — pinned by **Gate 1.15**
      fixture extensions in `scripts/check-probe.mjs`; the existing probe-bundle
      fixtures (command-less `GateResult` entries) stay green untouched.
- [ ] No existing assertion weakened; fast tier ALL GREEN with only the named
      extensions added — including the exact key-set pin (Gate 1.20 S1,
      `scripts/check-capabilities.mjs:195-199`) and Gate 1.6's exact-value store
      pins, both green with zero change. Pinned by `npm run verify` ALL GREEN.
- [ ] VERIFICATION.md extended in the same change-set (integrate section
      `:106-107` rewritten to compare-when-recorded; Gate 1.5/1.15/1.17 sections
      describe the new faces).
- [ ] **Gate 2 runs once at landing** and passes — gates and report shape are both
      on its trigger list (VERIFICATION.md:2052-2053), and the run is pre-charged by
      T-005:100-102/:225-226. One-time at landing, not a permanent extension.

## Verification

Gate 0 (`npm run typecheck`) and Gate 1 (`npm run demo`) always; the fast tier
(`npm run verify`) carries the extended Gate 1.5 integrate faces, Gate 1.15
`validateGateResult` rule, and Gate 1.17 S5 command assertion — all token-free.
**Gate 2 once at landing** (owed: gate code + report shape, VERIFICATION.md:2052-2053;
pre-charged by T-005:100-102/:225-226) — not a permanent extension. Gate 0.5 n/a
(`src/parse.ts` untouched); Gate 3 n/a (no adapter — zero model involvement).

Baseline this session: `npm run typecheck` → exit 0 on current main. Fast tier and
Gate 2 not run (Gate 2 spends model tokens; it is this ticket's landing obligation).
