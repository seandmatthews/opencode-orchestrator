# T-017 — MachineWorker adapter: deterministic-command worker behind WorkerAdapter (spec §5.3, §34:2030-2033)

**Status:** done 2026-10-17
**Category:** adapters
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** — (independent of T-016 — disjoint files; one gate-numbering note under Verification)

## What

A second real WorkerAdapter: `src/worker/machine.ts` — `MachineWorker` (id `'machine'`) executes a brief by running a configured deterministic command (an argv list) directly in the leased worktree — no external agent harness, no model tokens, no shell. This is the spec's own vocabulary: the worker-adapter diagram's "MachineWorker — deterministic commands" (§4:186-187), machine workers executing deterministic tasks whose "outputs can promote or eliminate candidates according to configured gates" (§5.3:254-273), the five adapters behind the WorkerAdapter contract (§11:851-859), and Milestone 1's build list "Worker adapters: MachineWorker, OpenCodeWorker" (§34:2030-2033). After this ticket the pipeline's worker execution survives with zero harness subscription.

1. **`src/worker/machine.ts` (new)** — mirrors `src/worker/opencode.ts`'s proven shape (constructor-injected config → spawn → `onSpawn` once → `runChildWithTimeout` → result, src/worker/opencode.ts:27-70):
   - The constructor takes `command: string[]` (the argv). Spawn is list-form, never through a shell (AGENTS.md #4): `spawn(command[0], command.slice(1), { cwd: req.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })`. The command is never re-tokenized from a string — argv list-form starts at the spec (see 2).
   - cwd by mechanism: the spawn cwd IS the working directory. No `PWD`/`OLDPWD` pinning — VERIFICATION.md Known issue #1 is an OpenCode env-resolution quirk, not a spawn-semantics fact. The docblock states this contrast; the gate asserts the child's real cwd (AC3).
   - T-010 contract: calls `req.onSpawn(pid)` exactly once right after spawn when `child.pid` is defined, and returns the same pid as `WorkerResult.pid` (src/types.ts:26-34, 46-50).
   - The timed run goes through the harness-agnostic core `runChildWithTimeout` (src/worker/run-with-timeout.ts:35, pinned token-free by Gate 1.12 S4) — log draining, the verified process-tree kill at expiry, `cleanupFailures` passthrough (src/types.ts:52-58). The adapter keeps only the specifics, exactly the T-011 division.
   - `ok = !timedOut && exitCode === 0` — the same worker-ladder input as OpenCodeWorker. A second collector builds `responseTail` (stdout+stderr, ANSI-stripped, 12k-char tail) like src/worker/opencode.ts:49-58,66.
   - **Honesty about fields a machine worker cannot mean:** `req.prompt` (the composed brief, src/runner.ts:441) is logged to `logPath` as a provenance header and never interpreted or executed; `req.model` is ignored — the report/store keep recording the per-job/run model string verbatim (src/cli.ts:96, src/cli.ts:202; `CandidateReport.model` src/types.ts:233) for a candidate no model touched. Documented in the docblock, not smoothed over.
   - **Docblock reconciliations (required, so the seams do not blur):**
     - *Worker vs probe.* This adapter runs PRE-gates: its file effects ARE the candidate diff (captured engine-side, src/runner.ts:478-488) and its exit code drives `workerOk`/retry (src/runner.ts:468-473). A CommandProbe (src/probe.ts:1-6, T-015) runs POST-gates on the final attempt, produces an EvidenceBundle, and never enters a verdict nor produces a diff. §5.3's evidence-flavored tasks (tests, benchmarks, screenshots) stay probe-layer successors; MachineWorker is the §5.3 deterministic-command leg that produces candidate WORK.
     - *§11's fuller contract.* `capabilities()`/`cancel()` (§11:845-847) are deliberately NOT implemented: the seam stays `id` + `execute` (src/types.ts:65-68); termination is onSpawn/pid + T-011's verified kill (the T-011 carve).
2. **Per-job command field — `src/scheduler.ts` only** (the T-015 `probes` precedent; parse/dispatch/verdict logic untouched):
   - `JobSpec` gains `command?: string[]`; the strict allowed-field list (src/scheduler.ts:158) gains `'command'`; shape validation refuses anything but a non-empty array of non-empty strings.
   - Pairing rules, enforced by a pure validation helper beside `parseJobsSpec`, called from `main()` immediately after `loadJobsSpec` (src/cli.ts:230) — deliberately NOT inside `resolveJobs`, which runs after the checkout lock (src/cli.ts:290) and would break the zero-side-effects refusal pattern (src/cli.ts:227-229):
     - `command` on a job whose resolved worker (job field, else the `--worker` default) is not `'machine'` → refuse;
     - a job resolving to `'machine'` without `command` → refuse.
3. **Registry — `src/cli.ts` only:**
   - `createWorker` (src/cli.ts:212-222) gains the `'machine'` case, constructing `MachineWorker` from the job's command; the unknown-worker error becomes `unknown worker adapter '<id>' (available: opencode, machine)`.
   - `workerFor`'s cache (src/cli.ts:188-196) keys by adapter id + serialized command, so two machine jobs with identical commands share one instance and distinct commands get distinct instances (pinned behaviorally by Gate 1.17 S5's two-command job set).
   - **Run-level `--worker machine` is refused at parse time** (the `--max-attempts` refusal pattern, src/cli.ts:139-146): the planner and reviewer phases execute through the run-level worker (`opts.worker` — planner src/runner.ts:270, reviewer src/runner.ts:316, invoked at src/runner.ts:558 in BOTH modes whenever review is enabled), and no machine command exists for them. Machine selection is per-job, in `--jobs` mode — which also makes a fully token-free machine run reachable today: `--jobs` (planner already skipped) + per-job `machine` + `--no-review`.
   - Job shape:
     ```json
     { "id": "codemod", "phase": "work", "dependencies": [],
       "brief": "apply the codemod described in CODEMOD.md",
       "worker": "machine", "command": ["node", "scripts/codemod.mjs"],
       "gates": [{ "name": "build", "command": "node build.js" }] }
     ```
     The brief stays what it is today — recorded in the report/store/attempt-hash (src/types.ts:234) — prose for humans and evidence, never parsed as a command.

**Does NOT claim:** machine workers serving planner/reviewer roles (refused by construction this slice); any WorkerAdapter seam extension toward §11's `capabilities()`/`cancel()`; §5.3's evidence-collection tasks (benchmarks/screenshots/Godot — probe-layer successors per T-015's carve); §19 machine-job memoization (deliberately deferred, ROADMAP.md:22); HumanWorker/ZCodePrototypeWorker/CodexWorker (Codex is stage 5, ROADMAP.md:17); any change to `src/types.ts`, `src/runner.ts`, gates, workspace handling, or the report shape — the diff rides the existing seams end to end; zero new npm dependencies (decisions.md 2026-10-10: TypeScript on Node 22 — `node:child_process` only).

## Why

Milestone 1 is closed in ROADMAP except its two leftovers, and the artifact store is now ticketed (T-016, proposed) — the MachineWorker adapter is the other leftover, still unticketed: docs/ROADMAP.md:12 says "a MachineWorker adapter remain[s] unticketed". The gap is real and code-verified this session: `createWorker` (src/cli.ts:212-222) has exactly one case and throws `unknown worker adapter '<id>' (available: opencode)` otherwise; a grep for `machine` over `src/`, `scripts/`, `package.json` returns only machine-gate wording, zero machine-worker code.

The pain is operational: opencode is the only adapter, and its model failures are a documented transient shape (VERIFICATION.md Known issue #3 — a wrong default model fails after ~70s of retries; Known issue #1 — the env.PWD resolution trap). A machine worker sidesteps the entire class: deterministic candidates (codemods, formatters, generators, migrations) get the same worktree isolation, diff capture, gate ladder, and retry discipline with no model in the loop and no harness subscription — and machine output is exactly what §5.3 says may "promote or eliminate candidates according to configured gates": the verdict ladder is untouched (decisions.md 2026-10-10: gates decide survival; a machine candidate that changes nothing is a NO-OP, never a pass — AGENTS.md #7, pinned by Gate 1.10's existing default-mode assertions).

Decisions checked: decisions.md:11-15 ("Only harness bet long-term: OpenCode. Codex is fine for now, strictly as a future adapter") names no competing claim on this slot and the harness-agnostic locked decision requires adapters behind the seam rather than barring them. The configuration surface is a genuine spec gap — §6.4:351 uses `worker: WorkerSpec` and never defines it — resolved here by the T-015/T-013 choose-and-document precedent: the ticket chooses the validated `--jobs` `command: string[]` field over brief-as-command (which would force a homegrown argv tokenizer — precisely the string-splitting hazard AGENTS.md #4 exists for) and over a run-level flag (no per-job variation, no mixed machine/opencode DAGs).

Pre-change state, run this session: Gate 0 `npm run typecheck` → exit 0; full fast tier `npm run verify` → `=== verify (fast) complete: ALL GREEN ===`, exit 0; `node scripts/diag-pwd.mjs C:/swarm/demo-target` both forms → exit 0 (form 1 still exhibits Known issue #1 — the OpenCode-specific quirk this adapter is immune to). Gate 2 NOT run this session — reported as not run.

## Acceptance criteria

- [x] `MachineWorker.execute` runs a real file-mutating node command in the contracted cwd: `ok: true`, exit 0, and the change is visible to `git diff` in a scratch repo — pinned by **new Gate 1.17** S1 (direct-adapter, token-free).
- [x] T-010 spawn contract: `onSpawn` called exactly once and `WorkerResult.pid` equals that pid — pinned by Gate 1.17 S1 (today the contract is pinned only for fake adapters, by Gate 1.11; VERIFICATION.md:494ff).
- [x] Directory resolution: a child command printing `process.cwd()` yields exactly `req.cwd` with no env pinning — pinned by Gate 1.17 S1's assertion; the spawn-cwd-vs-env.PWD contrast with Known issue #1 is in the adapter docblock; **Gate 3 runs once at landing** (VERIFICATION.md:1107, "adding ... a worker adapter") with the reconciliation recorded in Landed.
- [x] A failing command (`node -e "process.exit(3)"`) returns `ok: false` with `exitCode: 3`, `timedOut: false` — no throw — pinned by Gate 1.17 S2. (The engine's worker-failed retry handling is unchanged and stays pinned by Gates 1.8/1.10's fake-adapter legs.)
- [x] A non-existent executable returns `ok: false`, `exitCode: null` (the spawn-error path, src/worker/run-with-timeout.ts:45) without throwing — pinned by Gate 1.17 S3.
- [x] A timed-out command fires the verified tree kill via `runChildWithTimeout` and `cleanupFailures` pass through onto `WorkerResult` (src/types.ts:52-58) — pinned by Gate 1.17 S4 (the Gate 1.12 S4 mechanics exercised against the real adapter, not a fake).
- [x] Token-free REAL-CLI `--jobs` end-to-end (the Gate 1.5 sandbox pattern, VERIFICATION.md:217-220): a fixture run with two `worker: "machine"` jobs carrying different `command`s (each gated on its own marker file) plus a no-op machine command — report shows both real jobs PASS with `diffBytes > 0` and the correct job-command pairing, and the no-op job eliminated as NO-OP, never a pass (AGENTS.md #7) — pinned by Gate 1.17 S5, wired into `scripts/verify.mjs` after the Gate 1.15 hook (scripts/verify.mjs:528) before the fast-tier finish.
- [x] Refusals, all exit 1 with zero side effects (no artifacts dir, no lock — cli.ts:227-229): `--worker machine` at run level (parse time); `command` on a non-machine job; a machine job without `command`; a malformed `command`; and the unknown-worker message now reading `available: opencode, machine` — pinned by Gate 1.17 S6.
- [x] No engine regression: `src/types.ts`, `src/runner.ts`, gates, workspace handling, and the report shape are untouched; default-mode and fake-adapter gates stay green — pinned by the unchanged Gates 1.10/1.11/1.12/1.15 within a full `npm run verify` ALL GREEN, and Gate 0 (`tsc --noEmit`) over the new file.
- [x] **Gate 2 runs once at landing** — "any adapter" is on its trigger list (VERIFICATION.md:1097-1098) even though this slice need not touch `src/runner.ts` (the T-007/T-009/T-010 owed-at-landing precedent) — recorded in Landed with its output.
- [x] Docs in the same change-set: VERIFICATION.md (new Gate 1.17 section; the worker-registry sentence; a Gate 3 note reconciling spawn-cwd resolution with Known issue #1), README (`--worker` row, README.md:104, and the per-job field list, README.md:117), ROADMAP.md:12 (the stage-1 cell's stale "remain unticketed" text — coordinate with T-016: whichever lands second corrects the cell for both leftovers).

## Landed

2026-10-17, lane branch `ticket/T-017-machine-worker-adapter`.

What changed:

- **`src/worker/machine.ts` (new)** — `MachineWorker` (id `'machine'`):
  constructor-injected `command: string[]` argv; list-form `spawn(command[0],
  command.slice(1), { cwd: req.cwd, stdio: ['ignore','pipe','pipe'],
  windowsHide: true })` — never a shell, never re-tokenized; no
  `PWD`/`OLDPWD` pinning (the docblock states the spawn-cwd-vs-env.PWD
  contrast with Known issue #1); `req.onSpawn(pid)` once right after spawn
  when `child.pid` is defined, same pid returned as `WorkerResult.pid`;
  the timed run through `runChildWithTimeout` (log draining, verified tree
  kill, `cleanupFailures` passthrough); `ok = !timedOut && exitCode === 0`;
  a second collector builds the ANSI-stripped 12k `responseTail` exactly
  like OpenCodeWorker. `req.prompt` is logged to `logPath` as a provenance
  header and never interpreted; `req.model` is ignored and recorded
  verbatim by the report/store. Docblock reconciliations: worker-vs-probe
  (PRE-gates work producer vs POST-gates evidence) and §11
  (`capabilities()`/`cancel()` deliberately not implemented).
- **`src/scheduler.ts`** — `JobSpec.command?: string[]`; `'command'` added
  to the strict allowed-field list; shape validation refuses anything but a
  non-empty array of non-empty strings (a spec without `command` still
  parses to byte-identical JSON — Gate 1.15's P2 pin stays green); new
  exported pure `commandPairingRefusal(jobs, defaultWorker)` beside
  `parseJobsSpec`: `command` on a job resolving to a non-machine worker →
  refuse; a job resolving to `machine` without `command` → refuse.
- **`src/cli.ts`** — `createWorker` gains the `'machine'` case (constructs
  `MachineWorker` from the job's command); the unknown-worker error now
  reads `unknown worker adapter '<id>' (available: opencode, machine)`;
  `workerFor`'s cache keys by adapter id + serialized command (identical
  commands share one instance, distinct commands distinct instances —
  pinned behaviorally by Gate 1.17 S5); `--worker machine` refused at
  parse time (the `--max-attempts` pattern — planner/reviewer run through
  the run-level worker and have no machine command); `commandPairingRefusal`
  called in `main()` immediately after `loadJobsSpec`, deliberately not
  inside `resolveJobs` (which runs after the checkout lock). Two
  implementation notes the ticket text left implied: (1) the per-job
  unknown-worker id is ALSO validated in `main()` before the lock, sharing
  the registry's `WORKER_ADAPTERS` list and message — required so the AC's
  "unknown-worker refusal with zero side effects" actually holds (the
  registry's own throw fires inside `resolveJobs`, post-lock, post-artifacts-dir);
  (2) the `--jobs`/`--worker` usage lines mention the new field and the
  per-job-only rule.
- **`scripts/check-machine-worker.mjs` (new Gate 1.17)** + the hook in
  `scripts/verify.mjs` after the Gate 1.16 hook, before the fast-tier
  finish — S1 direct-adapter happy path + spawn contract + directory
  resolution (bogus inherited `PWD` planted, child's real `process.cwd()`
  still `req.cwd`), S2 exit-3 command, S3 non-existent exe, S4 timeout +
  verified tree kill + `cleanupFailures` passthrough (runtime shape +
  source-level pin), S5 real-CLI token-free `--jobs` machine run (two
  marker-file codemod jobs + a no-op job gated by a vacuous passing gate),
  S6 six zero-side-effect refusals through the real CLI, P contract
  fixtures (parse + pure pairing helper). 32 assertions, zero model
  tokens, zero opencode involvement.
- **`VERIFICATION.md`** — new Gate 1.17 section (with the registry
  sentence), a Gate 3 note reconciling spawn-cwd resolution with Known
  issue #1, and Known issue #10 (a verified-dead tree once REPORTED a
  cleanup failure on a transient snapshot/kill hiccup in the first
  fast-tier pass of this lane — loud-by-design, evidence-only, not
  reproducible across four subsequent runs; recorded per AGENTS.md #9,
  not tribal memory).
- **`README.md`** — the `--worker` flag row (per-job-only rule for
  `machine`), the job-file field list (`command` added) plus a short
  machine-worker paragraph, and the Interfaces table's `WorkerAdapter`
  row now naming `MachineWorker` beside `OpenCodeWorker` (a stale
  "only implementation" row this landing would have left wrong; declared
  here rather than left silent).
- **`docs/ROADMAP.md`** — stage-1 cell corrected for BOTH Milestone-1
  leftovers (T-016 landed first without touching the cell; this ticket
  lands second and corrects it for both, per the coordination note).
- **`docs/tickets/`** — this ticket flipped to done with the boxes
  checked, index row updated, in the same change-set.

Measured gates (this lane, this change-set):

- Gate 0 `tsc --noEmit` → exit 0.
- Gate 1.17 new, `node node_modules/tsx/dist/cli.mjs
  scripts/check-machine-worker.mjs` → `check-machine-worker: ALL GREEN`,
  exit 0, 32 ok assertions.
- Full fast tier, `node scripts/verify.mjs fast` → exit 0,
  `verify (fast) complete: ALL GREEN`, 853 ok lines, every section (Gate
  0, 1, 0.5, 1.5 ×3, 1.6–1.17) green. First pass of this lane failed one
  Gate 1.12 S1 assertion (Known issue #10 above — a recorded cleanup
  failure on a tree that verified dead; no kill-tree code in this
  change-set); green on standalone re-run (lane and main checkout), on the
  main checkout's own full fast tier, and on this lane's fast-tier re-run.
- Gate 3 (owed once at landing — "adding a worker adapter"), both forms
  against `C:/swarm/demo-target`: form 1 (no override) exit 0 — opencode
  reports the directory it was spawned in, not the cwd arg (Known issue #1
  still exhibited, as documented); form 2 (PWD override) exit 0 — opencode
  reports the override target `C:\swarm\demo-target`. The machine-worker
  face of directory resolution is pinned behaviorally by Gate 1.17 S1
  (child's real cwd = `req.cwd` under a bogus inherited `PWD`), and the
  reconciliation now lives in VERIFICATION.md's Gate 3 section.
- Gate 2 **owed at landing** ("any adapter" is on the trigger list) and
  **not run by this lane** — the driving script runs the full e2e gate
  after this change-set lands (real model tokens); recorded there.

Deviations: the two implementation notes above (early per-job worker-id
validation so the AC's zero-side-effects refusal set holds; the README
Interfaces-table row); nothing else. Gate numbering: **1.17** claimed and
landed as planned — the next free integer after landed 1.15 and T-016's
landed 1.16.

## Verification

Gate 0; Gate 1 (existing suites untouched); **new Gate 1.17** (`scripts/check-machine-worker.mjs`, fast tier, token-free, added here and wired into `npm run verify` — the T-008 slice-owns-its-gate precedent, T-008:96); Gates 1.5/1.10/1.11/1.12/1.15 structurally unchanged and green inside the fast tier; **Gate 2 owed once at landing** (VERIFICATION.md:1097-1098 — "any adapter"); **Gate 3 owed once** (VERIFICATION.md:1107), documented per AC3.

Numbering: the new gate claims **1.17** — next free integer after the highest landed gate (1.15, VERIFICATION.md:977) and T-016's published claim on 1.16 (T-016:157-162); per the T-008 move, the final number is the next free integer at landing. If T-016 lands first, its Roadmap-cell correction covers both M1 leftovers; if this ticket lands first, it corrects the MachineWorker half and leaves T-016's half alone.

## References

docs/spec/inference-refinery-v2.md §4:186-188, §5.3:254-273, §11:843-859, §34:2030-2033 ·
docs/decisions.md:11-15 (harness-agnostic adapters), :19-21 (gates decide survival), :22-24 (mechanism over prompts), :6-10 (Node 22, zero new deps) ·
VERIFICATION.md Known issues #1, #3; Gate 2/3 trigger lists ·
docs/ROADMAP.md:12 (the named leftover), :17 (Codex stage 5), :22 (memoization deferred) ·
docs/tickets/T-015-probe-layer-first-slice.md (probe seam to reconcile against; `probes` field precedent) ·
docs/tickets/T-016-filesystem-artifact-store.md (the other M1 leftover; gate-number sequencing).
