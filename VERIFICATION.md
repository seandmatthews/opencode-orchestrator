# VERIFICATION.md — gates and definition of done

**Status:** alive — extend this file in the same change-set as any feature it verifies.
A change is done when the gates it touches pass, its acceptance criteria each name the
check that pins them, and docs/tickets moved in the same change.

## Gate 0 — static (seconds)

```bash
npm run typecheck
```

Pass: exit 0. Required for every change, no exceptions.

## Gate 0.5 — structured-output parser contract (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-parse.mjs
```

Pins the JSON extraction rules for planner briefs and reviewer observations
(prose-tolerant scanning, cycling, rejection shapes) without spending model tokens.
Required whenever `src/parse.ts` changes.

## Gate 1 — fixture baseline (seconds)

```bash
npm run demo
```

Regenerates `C:\swarm\demo-target` from `scripts/demo-target.mjs` and runs its own
baseline `node build.js` + `node test.js`. Pass: exit 0, `build ok` + `tests ok`
printed, one commit on `main`. This is the harness the skeleton runs against; a broken
fixture invalidates every downstream gate.

## Gate 1.5 — run artifact cleanup (seconds, fast tier)

```bash
npm run clean -- --run <runId> [--force] [--run-root <path>]
npm run clean -- --all [--force] [--run-root <path>]
```

Disposes a run's git worktrees and `swarm/*` branches (T-002). Never deletes
evidence — `report.json`, `diff.patch`, logs survive. A worktree holding
uncommitted changes is refused (non-zero exit, per-item message) unless `--force`:
un-captured changes may be the only copy. `--all` cleans every run directory under
the run root except the newest (run directories are 14-digit timestamp names).
Worktrees come from the run's `report.json` plus anything else discovered under its
`wt/`; the target repo comes from the report's `repo` field, falling back to the
worktrees' own `.git` pointers (crash-mid-run recovery). All git subprocess calls
are list-form — this command exists partly to retire the Known issues #4 quoting
hazard.

The fast tier pins this against a throwaway sandbox repo: a recorded run cleans
with exit 0, leaving only `main` in `worktree list` and no `swarm/*` branches, with
`report.json` intact; a dirty worktree is refused while its clean sibling is still
disposed (per-item results), and disposed under `--force` (no report.json, so the
`wt/`-discovery path is exercised too); `--all` disposes the older run and leaves
the newest untouched.

## Gate 2 — harness end-to-end (minutes, spends model tokens)

```bash
npm run verify:full
```

Runs a real two-tier skeleton run (GLM-5.3 planner + flash workers, 2 candidates) on a
fresh fixture, then asserts on the artifacts:

- every candidate's worker exited 0,
- every diff is non-empty (`diffBytes > 0` — the NO-OP rule, AGENTS.md #7),
- every gate passed,
- the planner produced briefs (`planner.ok`, no fallback),
- every passing candidate was reviewed: `review.json` on disk, `review.ok`, observations
  well-formed with severity in {info, concern, blocker-advisory} (T-001),
- failing candidates were NOT reviewed — gates decide, review is advisory,
- the canonical repo is clean afterward (`git status --short` empty, only `main` in
  `worktree list`, no `swarm/*` branches left),
- no stray fixture files in this repo directory (the contamination check from the
  PWD-bug incident),
- the run's worktrees and branches are disposed through the clean command
  (`tsx src/clean.ts --run <runId> --run-root <verify root> --force`; `--force`
  is correct here — the run captured the evidence before disposal) (T-002).

Required when touching `src/runner.ts`, any adapter, gates, workspace handling, or
anything that changes report shape. Fast tier alone does not clear you here.

## Gate 3 — harness directory-resolution probe (adapter changes only)

```bash
node scripts/diag-pwd.mjs <any-git-dir>
node scripts/diag-pwd.mjs <any-git-dir> <same-dir-as-PWD-override>
```

Required when adding or changing a worker adapter, or after an opencode upgrade. Pass:
without override, the harness reports the directory it was spawned in; with the
override it reports the override target. A harness that reports something else does not
get trusted with worktrees — see Known issues #1.

## Known issues

1. **OpenCode resolves its project directory from `env.PWD`, not the process cwd**
   (verified on opencode-ai 1.18.35, Windows). Any spawn must set
   `PWD`/`OLDPWD` to the intended cwd — done in `src/worker/opencode.ts`. First run
   before the fix: all three workers edited the orchestrator repo while gates blessed
   untouched worktrees and everything reported PASS; only zero-byte diffs exposed it.
2. **`opencode run` has no directory flag** (`--help` confirmed) — cwd + env pinning is
   the only mechanism. `opencode run` also auto-attaches to a running server if one
   exists (`--attach` in help); kill stale opencode processes before measuring.
3. **`glm-5.3-highspeed` is not in the plan.** The default `build` agent resolves to it
   when no `-m` is given and fails after ~70s of retries with exit code 0 through a
   pipeline. Always pass `--model`/`-m` explicitly; never trust harness defaults.
4. **Git Bash mangles variables inside double-quoted backslash paths** (`wt\$c` became
   a literal `$`). Use forward-slash paths or explicit literals in shell commands.
   Post-run disposal no longer touches this hazard at all: it goes through
   `src/clean.ts`, whose git calls are list-form (T-002).
5. **CRLF warnings from git on fixture files are benign** (`.gitattributes` normalizes;
   the fixture regenerates from scratch each run).
6. **The planner's read-only-ness is prompt-reinforced only** — it runs with build-agent
   write tools in the target repo cwd. Mechanism-level capability restriction lands
   with the worker permission model (spec §14). Until then, planner output and the
   repo state after Gate 2 are the tripwire.

## Definition of done (per ticket)

- every acceptance criterion demonstrably true and naming its pinning gate,
- Gate 0 (+ Gate 1) green; Gate 2 run when the change touches the pipeline,
- ticket status flipped and index updated in the same change,
- VERIFICATION.md extended in the same change if the change adds behavior,
- no weakened assertions, no ride-along changes.
