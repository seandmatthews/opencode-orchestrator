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

## Why this exists

An AI coding agent alone in a session grades its own homework: it reports
that it is done, and finding out whether that is true means reading the code
yourself. Inference Refinery moves that judgment out of the model. Every
candidate is measured by the same mechanical checks — shell commands whose
exit codes decide — so a confident claim carries no more weight than a
failing check allows it to.

It is also an economy. Decomposing a goal into well-specified briefs takes a
strong model; carrying out a well-specified brief is mostly careful work,
which a cheap model can do. So the strong model is paid for once, at
planning time, and several cheap workers attempt the briefs in parallel.
Some attempts fail — that is expected and harmless, because a failed attempt
costs little and is simply deleted, while the attempt that survives has
already proven itself against the gates.

The engine is not a sketch: it implements the V2 architecture spec piece by
piece ([docs/spec/inference-refinery-v2.md](docs/spec/inference-refinery-v2.md)).
Stages 0–2 are done; stages 3, 4, 6, and 8 are each partly done — crash
recovery, the probe layer, a bounded two-round research loop, adversarial
probes, and early stop all work; a second worker harness (stage 5) and a UI
(stage 7) have not been started.
[docs/ROADMAP.md](docs/ROADMAP.md) tracks exactly what is done and what is
next.

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
`--no-review`. Each advisory role can also ride its own worker adapter:
`--planner-worker`/`--reviewer-worker` select it (default: the `--worker`
value), and a role resolved to `machine` carries its own deterministic
command (`--planner-command`/`--reviewer-command`, a JSON argv list) — a
machine reviewer, for example, turns `--jobs` runs into fully token-free
runs with a real advisory review. In `--jobs` mode the reviewer selection
applies; the planner flags are accepted but ignored (the planner is skipped
there, like `--planner-model`). The planner's raw output is saved to
`planner-raw.txt`, and the brief each candidate received is recorded in
`report.json`.

## Usage

### Prerequisites

- **Node.js and npm** — developed on Node 22. The run database uses the
  built-in `node:sqlite` module, so there is nothing extra to install.
- **Git**, on `PATH` — candidates work in git worktrees, so the target
  repository must be a git repository.
- **The OpenCode harness comes with `npm install`** — it is the
  `opencode-ai` package, and the engine runs it straight from `node_modules`
  (`--opencode-bin` overrides the path). There is no separate install step.
- **Sign in once, with your own account.** The engine never handles
  credentials: the OpenCode binary reads its own authenticated session, so
  sign in once before the first run (`npx opencode auth login`). The default
  model IDs (`zai-coding-plan/glm-5.3` for the planner and reviewer,
  `zai-coding-plan/glm-5.3-flash` for workers) are Z.ai coding-plan IDs — on
  a different provider, pass your own IDs with `--planner-model` /
  `--model` / `--reviewer-model`.
- **Windows first** — built and tested on Windows; defaults like the
  `C:\swarm` run root assume it. Other platforms are untested.

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
| `--worker <id>` | Which worker adapter to use (default `opencode`; `machine` is per-job only — see Job files). Also the default adapter for the planner and reviewer roles |
| `--planner-worker <id>` | Adapter for the planner role (default: the `--worker` value; `machine` requires `--planner-command`) |
| `--reviewer-worker <id>` | Adapter for the reviewer role (default: the `--worker` value; `machine` requires `--reviewer-command`). Applies in both `--goal` and `--jobs` mode |
| `--planner-command <json>` | The machine command for a planner resolved to `machine` — a JSON argv list like `["node", "scripts/task.js"]`. Accepted but ignored in `--jobs` mode |
| `--reviewer-command <json>` | The machine command for a reviewer resolved to `machine` — a JSON argv list |
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
only valid on machine jobs; `--worker machine` at run level is still refused
(the worker tier has no run-level command), but the advisory roles select
`machine` through their own flags — `--reviewer-worker machine
--reviewer-command '["node", "review.js"]'` gives any run a deterministic,
token-free advisory review. The brief stays
prose for humans and evidence — it is recorded, never executed.

If a worker crashes, times out, or throws an error, the engine retries it as
a fresh attempt in a fresh worktree, up to `--max-attempts` per candidate.
Candidates that finished but failed are not retried: if the worker changed
nothing, or the gates failed, running it again would just produce the same
result.

Each job may also carry a `probes` array: named commands
(`{"id", "type": "command"|"test"|"benchmark"|"screenshot"|"web"|"adversarial", "command": {"exe", "args"}, "timeoutMs"?, "repeats"?, "capture"?, "url"?, "seed"?}`)
that run on the final attempt no matter how the gates went, and write a JSON
record of what happened to `probes/<candidateId>/<probeId>.json` in the run
folder. A `command` probe records the exit code, how long it took, and the
last part of the output — it parses nothing. A `test` probe parses TAP (the
test-output format `node --test` prints) into counts of tests passed and
failed. A `benchmark` probe runs its command `repeats` times (required,
a positive integer) and records each run's duration in milliseconds plus
`min`/`median`/`p95` summaries (nearest-rank — no interpolation), writing a
machine-readable `probes/<candidateId>/<probeId>.results.json` table beside
the record; `timeoutMs` is a per-repeat budget. A `screenshot` probe runs
its capture command once and requires it to have written a PNG (the
8-byte magic, at least 33 bytes) at the `capture` path (required,
workspace-relative — no absolute paths, no `..`) inside the candidate's
workspace; the image is then copied to
`probes/<candidateId>/<probeId>.png` in the run folder, where it survives
worktree disposal and a human can open it. Launch, timing, and readiness
are the capture command's job — the probe runs one command and records what
it produced. A `web` probe launches its command as a long-running server
(it does not wait for the command to exit), then polls `url` — required,
an `http://` or `https://` address — until the first response connects or
the timeout expires (one budget from launch; `timeoutMs` is the whole
launch → poll → capture → teardown budget). That first response is the
capture: the probe records its HTTP status, how many body bytes it read
(capped at 1 MiB), and how long readiness took, and writes a bounded
record (status plus a 2048-byte body snippet) to
`probes/<candidateId>/<probeId>.response.json`. The launched process tree
is always torn down with a verified kill — after a capture, after a
failure, and at the deadline; nothing is left running. The probe succeeds
only when the server launched, answered within the deadline with a 2xx
status, and sent a non-empty body. The port in `url` is machine-global and
chosen by you: two probes pointed at the same port at the same time
collide. An `adversarial` probe actively tries to break the candidate:
from its `seed` (required, a positive integer — an unseeded fuzz run is
not replayable and is refused) it deterministically generates a fixed list
of 20 replayable input cases — a fixed edge-case corpus (the empty input,
control characters, non-ASCII text, numeric edges such as `NaN` and
`Infinity`, malformed-JSON-looking strings) plus seeded random soup — and
feeds each case to the command as its last argument, one at a time, each
with its own full `timeoutMs` budget. It records which cases the target
survived (clean spawn, exit 0) and which it crashed on (non-zero exit or
timeout), one duration per case that ran plus `cases-run`/`cases-crashed`
counts, and a machine-readable
`probes/<candidateId>/<probeId>.results.json` table (the seed and every
case's input and outcome) beside the record — same seed, byte-identical
case list, on every platform, so a recorded crash list is a reproducible
bug report anyone can recompute from the seed. A case that could not
spawn at all is recorded as neither survived nor crashed. Generated cases
are capped at 8192 characters because they ride the command line and
Windows bounds its length — keep the command itself short. The probe
succeeds only when every case spawned and every case survived; a crash is
evidence, not a failure of the run. A probe carries no
threshold of any kind: it records performance, never judges it. A probe's
result, even a failing one, never affects whether a
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
- [docs/adversarial-review-2026-10-23.md](docs/adversarial-review-2026-10-23.md) — the 2026-10-23 adversarial review: top findings in T-042..T-048, everything else recorded here with dispositions
- [docs/spec/inference-refinery-v2.md](docs/spec/inference-refinery-v2.md) — the full V2 architecture spec this repo implements piece by piece
