# opencode-orchestrator

Inference Refinery runs several AI coding agents on the same task, in
parallel, and uses automated checks to decide which attempt to keep.

It works like this. A planner model turns your goal into a few short work
assignments ("briefs"). Each worker model carries out one brief on its own
copy of the repository — a git worktree, created from the same starting
commit. Each parallel attempt is called a *candidate*. When the workers
finish, the same shell commands — the "gates", for example `node build.js` —
run against every candidate. A gate passes when its command exits 0. Only
candidates whose gates pass are kept, and no model opinion is involved in
that decision.

The engine implements the V2 architecture spec piece by piece
([docs/spec/inference-refinery-v2.md](docs/spec/inference-refinery-v2.md)).
Stages 0–2 are done, stage 3 is partial, stage 4 has started;
[docs/ROADMAP.md](docs/ROADMAP.md) tracks what is done and what is next.

## Principles

- **Not tied to one AI tool.** Only `src/worker/opencode.ts` knows OpenCode
  exists; everything else talks to a `WorkerAdapter` interface. Supporting
  another tool — Codex, a local model server — means adding one adapter file.
- **Automated checks decide; models advise.** A gate is a shell command:
  exit 0 passes. The reviewer model and the probes (below) only write down
  what they saw; none of it can change which candidates pass.
- **Your repository is never given to a model directly.** Every candidate
  works in a throwaway git worktree pinned to the same starting commit, so
  the diffs can be compared against each other and the real checkout stays
  untouched.
- **Model IDs are always explicit.** The engine never lets a tool fall back
  to its own default model — OpenCode's default is not in our plan and fails
  after about 70 seconds of retries.
- **Built for Windows first.** Commands are handed to the operating system as
  argument lists, never assembled into a shell string; a stalled worker is
  stopped together with the child processes it started; timeouts are hard
  limits — when the time is up, the worker is stopped.

## Model roles

Three roles across two tiers of model. Every role is a flag you can set; the
table shows the defaults.

| Role | Default model | What it does |
|---|---|---|
| Planner | `zai-coding-plan/glm-5.3` | turns the goal into N distinct briefs (a JSON array; one repair attempt if the JSON is bad; falls back to the raw goal) |
| Worker | `zai-coding-plan/glm-5.3-flash` | carries out one brief in its own worktree |
| Reviewer | `zai-coding-plan/glm-5.3` | reads each passing candidate's diff afterward and writes notes to `review.json` (notes only — they cannot change the outcome) |

Flags: `--planner-model`, `--model`, `--reviewer-model`, `--no-planner`,
`--no-review`. The planner's raw output is saved to `planner-raw.txt`, and
the brief each candidate received is recorded in `report.json`.

## Usage

```bash
npm install
npm run demo          # create C:\swarm\demo-target (a sample repo whose build and tests pass)
npm run typecheck

npm run skeleton -- \
  --repo "C:\swarm\demo-target" \
  --goal "Make the calculator more capable for flight-sim style math." \
  --gate "build=node build.js" \
  --gate "test=node test.js" \
  --candidates 3

npm run clean -- --run <runId>    # delete a run's worktrees and swarm/* branches
npm run clean -- --all            # same, for every run except the newest

npm run integrate -- --run <runId> --candidate c01 \
  --gate "build=node build.js" --gate "test=node test.js"
```

Each run writes its files to `C:\swarm\<runId>\`: `report.json`, a
`worker.log` and `diff.patch` per candidate, and the candidate worktrees
themselves (unless `--clean`). The command exits 0 whenever the run itself
completes without crashing — even if every candidate failed its gates;
`report.json` tells you which candidates passed.

Every run is also recorded in one shared SQLite database (default
`C:\swarm\refinery.db`, override with `--db`): the runs, their candidates,
every gate result, and a running log of events (`node:sqlite`, no extra
dependencies). The database only records what happened; it never decides
anything. If a database write fails, the run prints one warning line and
continues.

### Run flags

| Flag | Meaning |
|---|---|
| `--repo <path>` | The target git repository (required) |
| `--goal "<text>"` | What the candidates should build (required without `--jobs`) |
| `--jobs <spec.json>` | Run from a job file you write, instead of planner briefs (below) |
| `--gate "name=command"` | A gate: a named shell command; repeat for several gates |
| `--candidates <n>` | How many candidates to run (default 3) |
| `--concurrency <n>` | How many candidates run at once (default: all of them) |
| `--base <ref>` | The starting commit for every candidate: a branch name or SHA (default HEAD) |
| `--model <id>` | The worker-tier model ID |
| `--timeout-min <n>` | Per-worker time limit in minutes (default 15) |
| `--max-attempts <n>` | Retry a candidate whose worker crashed or timed out, up to n attempts (default 1) |
| `--clean` | Delete candidate worktrees after their logs and diffs are saved |
| `--worker <id>` | Which worker adapter to use (default `opencode`; `machine` is per-job only — see Job files) |
| `--db <path>` | The SQLite database for run records |
| `--run-root <path>` | Where runs are stored (default `C:\swarm`) |
| `--force-lock` | Take the checkout lock even if another process still appears to hold it |
| `--opencode-bin <path>` | Path to the opencode executable, if it is not on PATH |

Planner and reviewer flags are in the table above.

### Job files

`--jobs <spec.json>` replaces the planner with a job file you write yourself
(`phases` + `jobs`; see `src/scheduler.ts`). The engine runs the jobs in
dependency order, at most `--concurrency` at a time, one candidate per job.
Each job can set its own `model`/`worker`/`command`/`timeoutMs`/`gates`;
anything it leaves out falls back to the run-level flags. The planner is not
used, and `--candidates` is ignored. If the job file is invalid, the run
stops immediately with an error, before it touches the repository or creates
any files.

A job with `"worker": "machine"` runs no AI model at all: it executes the
job's `command` — an argument list like `["node", "scripts/codemod.mjs"]`,
spawned directly in the candidate's worktree with no shell — and whatever
files it changes become that candidate's diff, judged by the same gates as
any other candidate. A machine job must carry a `command`, and `command` is
only valid on machine jobs; `--worker machine` at run level is refused,
because the planner and reviewer have no command to run. The brief stays
prose for humans and evidence — it is recorded, never executed.

If a worker crashes, times out, or throws an error, the engine retries it as
a fresh attempt in a fresh worktree, up to `--max-attempts` per candidate.
Candidates that finished but failed are not retried: if the worker changed
nothing, or the gates failed, running it again would just produce the same
result.

Each job may also carry a `probes` array: named commands
(`{"id", "type": "command"|"test", "command": {"exe", "args"}, "timeoutMs"?}`)
that run on the final attempt no matter how the gates went, and write a JSON
record of what happened to `probes/<candidateId>/<probeId>.json` in the run
folder. A `command` probe records the exit code, how long it took, and the
last part of the output — it parses nothing. A `test` probe parses TAP (the
test-output format `node --test` prints) into counts of tests passed and
failed. A probe's result, even a failing one, never affects whether a
candidate passes; probes only record.

## Integrating, cleaning, and the checkout lock

`npm run integrate` double-checks a passing candidate against your repository
as it is now. It takes the candidate's saved diff and starting commit,
applies the diff to a fresh temporary worktree of the repository at its
current HEAD, and re-runs the same gates there. The outcome is written to
`<runId>/integrate/<candidate>.json`. This prepares the work for merging; a
human performs the actual merge. The temporary worktree is kept so you can
inspect it: plain `clean` refuses to delete it (it holds uncommitted
changes), while `clean --force` will delete it.

`npm run clean` deletes a run's worktrees and `swarm/*` branches. It never
deletes the recorded files — `report.json`, `diff.patch`, logs. A worktree
with uncommitted changes is refused unless `--force`, because unsaved changes
in it might be the only copy of that work.

Only one run or clean may work on a given repository at a time. A lock file
per repository enforces this (`src/lock.ts`): a second run or clean refuses
before doing anything, and its error names the process holding the lock, how
long it has held it, and where the lock file lives (under `<run-root>\locks\`).
Nothing ever removes a lock on its own. If a crashed run left one behind,
take it deliberately with `--force-lock`, or hold and release it by hand:

```bash
node node_modules/tsx/dist/cli.mjs src/lock.ts acquire "C:\swarm\demo-target"
node node_modules/tsx/dist/cli.mjs src/lock.ts release "C:\swarm\demo-target"
```

## Inspection and recovery tools

These read the database or a run's files. None of them changes what a run
decided.

- `npm run dag -- --run <runId> [--json]` — print a run's job plan: its
  phases, its jobs, and which jobs had to wait for which (the dependency
  graph). Opens the database read-only and never creates one.
- `npm run approvals -- request|list|decide ...` — record human decisions
  about a finished run's passing candidates (`--decision approved|rejected`).
  Approvals are written only by these commands. A candidate that failed its
  gates cannot be approved, and a recorded decision cannot be changed.
- `npm run recover -- --run <runId>` — clean up after a run that was
  interrupted partway through: mark the attempts that were still running as
  abandoned, stop the recorded worker processes (after checking each one
  really belongs to the run), inspect the leftover worktrees, and write
  `<runDir>/recovery.json`. Recovery never re-runs anything.
- `npm run context -- --plan <path> --packet <path> [--json]` — inspect a
  context packet (the bundle of background material assembled for a worker)
  against its plan: how the token budget was spent, which files were included
  or left out and why, where each summarized section came from, and the
  packet's fingerprint (recomputed and verified during inspection).
  Read-only; the input files are unchanged afterward.

## Interfaces

| Interface | File | What it does | Implementation |
|---|---|---|---|
| `WorkerAdapter` | `src/types.ts` | runs a prompt in a working directory and collects the exit code and log | `OpenCodeWorker`, `MachineWorker` |
| `WorkspaceProvider` | `src/types.ts` | provides an isolated working copy per candidate and captures its diff | `WorktreeProvider` (git worktrees) |
| `Gate` | `src/types.ts` | a pass/fail check: a shell command whose exit code decides | `CommandGate` |
| `Probe` | `src/probe.ts` | runs a command or test and records what happened | `CommandProbe`, `TestProbe` (TAP) |

## Docs

- [AGENTS.md](AGENTS.md) — how to work in this repo; read this first
- [VERIFICATION.md](VERIFICATION.md) — the checks this project runs, what counts as done, and known problems
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestone status and what is next
- [docs/decisions.md](docs/decisions.md) — decisions that are settled; cite them, don't relitigate them
- [docs/tickets/](docs/tickets/README.md) — the work queue and the record of past work
- [docs/spec/inference-refinery-v2.md](docs/spec/inference-refinery-v2.md) — the full V2 architecture spec this repo implements piece by piece
