# AGENTS.md — start here

Inference Refinery is a deterministic swarm-orchestration layer: a smart planner-tier
model decomposes a goal into briefs, cheap worker-tier models implement one brief each
in isolated git worktrees, and machine gates — never model judgment — decide which
candidates survive. Stage 0 (this repo) is the walking skeleton for that loop.

**Reads with:** `docs/spec/inference-refinery-v2.md` (the full architecture spec — this
repo implements it in slices) · `VERIFICATION.md` (how work is proven done) ·
`docs/ROADMAP.md` (where we are) · `docs/decisions.md` (locked decisions, do not relitigate) · `docs/tickets/` (what to do next).

## Run it

```bash
npm install
npm run typecheck        # Gate 0 — must be green before anything else
npm run demo             # Gate 1 — regenerate + baseline-check the demo fixture
npm run verify           # fast tier (typecheck + fixture)
npm run verify:full      # full tier: real e2e run, 2 candidates, ~3-5 min, model tokens
npm run skeleton -- --repo C:\swarm\demo-target --goal "..." --gate "build=node build.js"
npm run clean -- --run <runId>   # dispose a run's worktrees + swarm/* branches (evidence kept)
npm run integrate -- --run <runId> --candidate c01 --gate "build=node build.js"   # replay a survivor's diff at current HEAD
node node_modules/tsx/dist/cli.mjs src/lock.ts acquire <repo>   # hold the checkout lock by hand (release to drop)
```

Runs write artifacts under the run root — `C:\swarm` on Windows, `$HOME/swarm`
elsewhere, `SWARM_RUN_ROOT` overrides both (`<run-root>\<runId>\report.json`,
per-candidate `worker.log` and `diff.patch`, worktrees under `wt/` unless
`--clean`). Post-run disposal goes
through `npm run clean`, never hand-rolled shell loops. Runs and clean serialize per
target repo through the checkout lock (`src/lock.ts`); a refused lock names its
holder, and only `--force-lock` takes one from a suspected-stale holder — nothing
ever reaps a lock automatically.

## Ground rules (non-negotiable)

1. **The engine stays model/harness-agnostic.** Model IDs appear only as CLI/config
   values. Only `src/worker/opencode.ts` may know OpenCode exists. A new harness is a
   new adapter file behind `WorkerAdapter`, nothing else.
2. **Gates decide survival; models advise.** A gate is a shell command: exit 0 passes.
   No model opinion participates in promotion or elimination.
3. **The canonical checkout is never handed to a model.** Candidates work in worktrees
   pinned to one base SHA. `--repo` points at the *target*, never at this repo.
4. **Subprocess calls are list-form, never through a shell.** Windows paths with spaces
   and `&` shred string-joined commands (this bit us on day one, repeatedly).
5. **Pin `PWD`/`OLDPWD` to the contracted cwd when spawning model harnesses.** OpenCode
   resolves its project directory from `env.PWD`, not the process cwd — an unpinned
   spawn silently operates on the wrong repository while everything reports PASS.
   Before trusting a new harness adapter, probe its directory resolution
   (`node scripts/diag-pwd.mjs <dir>`).
6. **Every feature extends `VERIFICATION.md` in the same change-set.** A feature with no
   way to re-verify it later is not done.
7. **A zero-byte diff is a NO-OP, never a pass.** Gates that run against an untouched
   tree prove nothing about the worker.
8. **Red-before/green-after for bug fixes.** Reproduce, record the failing bar, fix,
   record the passing bar. Never weaken an existing check to make it pass.
9. **Honesty:** never present a check you did not run as evidence. Report failures with
   their output. Known-broken or known-benign tooling belongs in VERIFICATION.md's
   Known issues, not in tribal memory.
10. **Kill spawned dev processes when work concludes** (opencode sessions, verify runs,
    fixtures left running). Stale processes poison the next session's measurements.
11. **Findings promote via tickets — human-owned, never same-run, never auto-promoted.**
    A verifier finding (or any real failure) becomes a permanent gate only through a
    ticket-owned change-set that adds the check to the gate set or fixture suite
    (spec §32's ratchet). No engine code reads a findings block and edits a gate,
    fixture, or spec; a model-authored check never decides survival in the run that
    produced it (decisions.md, the T-039 entry). The ratchet crosses runs: finding in
    run N → promotion change-set → gate in run N+1.

## Layout

```
AGENTS.md               this file — cross-cutting rules only
VERIFICATION.md         gates, definition of done, known issues
README.md               public face: principles, interfaces, usage, docs index
docs/
  spec/                 the V2 architecture spec (copied from the authoring copy in Downloads)
  decisions.md          locked decisions with dates — cite, don't relitigate
  ROADMAP.md            milestone status and what is next
  tickets/              one file per ticket; the durable record of work
src/
  types.ts              the seams: WorkerAdapter / WorkspaceProvider / Gate
  worker/opencode.ts    the only OpenCode-aware file
  workspace/worktree.ts git worktree leases + diff capture
  gate/command.ts       shell-command gates
  runner.ts             planner phase + candidate fan-out + report
  cli.ts                flag parsing, worker registry, run header/summary
  clean.ts              run artifact disposal: worktrees + swarm/* branches, evidence kept
  integrate.ts          integration replay: survivor's diff.patch onto current HEAD, gates re-run
  lock.ts               cross-process checkout lock + its acquire/release CLI
  store/                durable run records: SQLite (runs/candidates/gate_results/events)
scripts/
  demo-target.mjs       generates the throwaway fixture repo (baseline passes build+test)
  diag-pwd.mjs          harness directory-resolution probe
  verify.mjs            verification tiers (see VERIFICATION.md)
```

## Two-tier model configuration

Three roles across two tiers; every role is CLI configuration, never engine code.

| Role | Default model | Job |
|---|---|---|
| Planner | `zai-coding-plan/glm-5.3` | goal → N distinct, fully-specified briefs |
| Worker | `zai-coding-plan/glm-5.3-flash` | implements one brief in an isolated worktree |
| Reviewer | `zai-coding-plan/glm-5.3` | advisory post-gate review of passing candidates (findings, never verdicts) |

All passed explicitly (`--planner-model`, `--model`, `--reviewer-model`;
`--no-planner` / `--no-review` to skip). Never trust harness defaults:
OpenCode's default (`glm-5.3-highspeed`) is not in the plan and fails after
~70s of retries.

## Tickets and commits

Work happens through tickets in `docs/tickets/` — one ticket per change-set, acceptance
criteria that name their pinning check, status updated in the ticket and the index in
the same change. Commit style: `feat(scope): description (T-XXX)`; merges of ticket
lanes: `merge: scope — title (T-XXX)`. Never commit straight to `main` from an agent
run; work in a worktree and merge under the lock once the pipeline exists (T-002).
