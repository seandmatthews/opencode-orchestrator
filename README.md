# opencode-orchestrator

Inference Refinery, stage 0 — a walking skeleton for deterministic swarm orchestration:
fan out N headless worker agents across isolated git worktrees of one repo at one base
SHA, then decide survival with machine gates. Models advise; gates decide.

## Principles baked in from line one

- **Model/harness agnostic engine.** `src/worker/opencode.ts` is the only file that
  knows OpenCode exists. Everything else sees the `WorkerAdapter` interface. Codex, a
  local OpenAI-compatible endpoint, or any future harness is another adapter file.
- **No default models.** A worker always receives an explicit model ID. Harness defaults
  can silently point at models the credentials do not include.
- **The canonical checkout is never handed to a model.** Candidates work in throwaway
  git worktrees pinned to the same base SHA; diffs are comparable, evidence survives.
- **Machine gates decide survival.** A gate is a shell command: exit 0 passes. No model
  judgment participates in promotion or elimination at this stage.
- **Windows-first process semantics.** Worker processes are killed as trees
  (`taskkill /T /F`), timeouts are hard wall-clock limits.

## Two-tier models

The skeleton exercises the project's core tiering: a planner-tier model turns the
goal into N distinct briefs; worker-tier models implement one brief each.

| Tier | Default | Role |
|---|---|---|
| Planner | `zai-coding-plan/glm-5.3` | goal → N distinct, self-contained briefs (JSON array, one bounded repair attempt, falls back to the raw goal) |
| Worker | `zai-coding-plan/glm-5.3-flash` | implements its brief in an isolated worktree |

Both are pure CLI configuration (`--planner-model`, `--model`, `--no-planner`);
the engine never hard-codes a model. Planner raw output lands in
`planner-raw.txt`, per-candidate briefs in `report.json`.

## Interfaces (src/types.ts)

| Interface | Purpose | Stage-0 impl |
|---|---|---|
| `WorkerAdapter` | executes a prompt in a cwd, collects exit/log | `OpenCodeWorker` |
| `WorkspaceProvider` | leases isolated workspaces, captures diffs | `WorktreeProvider` (git worktrees) |
| `Gate` | deterministic pass/fail check | `CommandGate` (shell command) |

## Usage

```bash
npm install
npm run demo          # create C:\swarm\demo-target (baseline passes build+test)
npm run typecheck

npm run skeleton -- \
  --repo "C:\swarm\demo-target" \
  --goal "Make the calculator more capable for flight-sim style math." \
  --gate "build=node build.js" \
  --gate "test=node test.js" \
  --candidates 3
```

Artifacts land in `C:\swarm\<runId>\`: `report.json`, per-candidate `worker.log` and
`diff.patch`, and the candidate worktrees themselves (unless `--clean`).

Exit code is 0 whenever the run completes mechanically; `report.json` carries verdicts.

## Docs

- [AGENTS.md](AGENTS.md) — how to work in this repo; read this first
- [VERIFICATION.md](VERIFICATION.md) — gates, definition of done, known issues
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestone status and what is next
- [docs/decisions.md](docs/decisions.md) — locked decisions; cite, don't relitigate
- [docs/tickets/](docs/tickets/README.md) — the work queue and durable record
- [docs/spec/inference-refinery-v2.md](docs/spec/inference-refinery-v2.md) — the full V2 architecture spec this repo implements in slices
