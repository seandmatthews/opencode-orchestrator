# T-003 — Durable run records: SQLite store + event log

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** —

## What

First slice of the stage-1 durable control plane (spec §34 Milestone 1): persist each
finished run as durable records, with **zero behavior change to the pipeline**.

- **`src/store/`** — a new persistence module on Node's built-in `node:sqlite`
  (`DatabaseSync`), zero new npm dependencies — `package.json` stays as-is (only
  `opencode-ai` + dev tooling). Verified on this machine this session:
  `node --version` → v22.23.1 (matches the 2026-10-10 "TypeScript on Node 22"
  decision), and an in-memory probe (CREATE TABLE / INSERT / SELECT) printed
  `node:sqlite OK: [{"a":"x"}]` with only `ExperimentalWarning: SQLite is an
  experimental feature` on stderr. Schema v1 is exactly the four in-scope tables
  from spec §27's initial-table list:
  - `runs` — runId, repo, baseSha, goal, model, startedAt, finishedAt, planner
    summary (JSON; null when `--no-planner`), report.json path;
  - `candidates` — per candidate: workerId/model/brief as strings copied out of
    `CandidateReport` (`src/types.ts:103-121`), workerOk/workerTimedOut/
    workerDurationMs, diffBytes, passedAllGates, review JSON when present, error;
  - `gate_results` — one row per candidate gate: name, passed, exitCode,
    durationMs, outputTail (`GateResult`, `src/types.ts:57-63`);
  - `events` — append-only stream (spec §28): `seq INTEGER PRIMARY KEY
    AUTOINCREMENT`, runId, type, at, payload JSON.
  Model IDs appear only as strings the store copies out of `RunReport` fields —
  the store knows no harness (decisions.md: engine is model/harness-agnostic).
- **`ingest(report: RunReport, dbPath: string)`** — the only DB writer in this
  slice, and a pure function of the report: event `at` values derive from the
  report's own timestamps and durations (`startedAt`/`finishedAt`
  `src/types.ts:130-131`, per-candidate durations) — never `Date.now()` — so
  re-ingest is deterministic. Event vocabulary only from spec §28's list:
  `RUN_CREATED` (at startedAt), `GATE_FAILED`, `CANDIDATE_ELIMINATED` (candidates
  not passing all gates). Re-ingest semantics: `runs`/`candidates`/`gate_results`
  upsert by natural key; `events` appends and never rewrites prior rows.
- **One call site in `src/cli.ts`**, immediately after `runSkeleton` returns
  (`src/cli.ts:160-176`) — after all verdicts exist. **Failure policy:
  log-and-continue.** A failed DB write prints one loud persistence-failure line
  near the run summary (`src/cli.ts:179-193`) and never changes the run's exit
  code, stdout verdicts, or artifacts. Persistence records verdicts; it never
  influences them (decisions.md: machine gates decide survival).
- **CLI flag** `--db <path>`, default `C:\swarm\refinery.db` — a single cross-run
  DB under the run root (decisions.md: run root is `C:\swarm\`), structurally safe
  from cleanup: clean `--all` sweeps only directories matching `/^\d{14}$/`
  (`src/clean.ts:249-252`), never a bare file.
- **Fixture** `scripts/fixtures/report-real.json` — verbatim copy of a real
  recorded report, ingested by the new fast-tier gate. Source verified on disk
  this session: `C:\swarm\verify\20261011022419\report.json` (runId 20261011022419,
  2 candidates, planner ok, build+test PASS ×2, both reviewed; the second verified
  source, `C:\swarm\20261011011732\report.json` — 1 candidate, no review — is the
  backup). Vendoring keeps the gate hermetic: files under `C:\swarm\` are outside
  the repo and sweepable.

**Does NOT claim:** no change to `src/runner.ts`, adapters, gate behavior,
workspace handling, or the `RunReport` shape; no live in-run event emission (that
would touch the runner — a behavior change — and is carved off); no
`jobs`/`attempts`/`job_dependencies`/`approval_gates`/`phases` tables (later
slices, spec §27); no readback/query CLI; no migration machinery beyond schema v1;
nothing in the pipeline reads the DB back this slice.

## Why

The only durable record of a run today is `report.json`, written once at
`src/runner.ts:89`, plus per-candidate files (`worker.log` `src/runner.ts:250`,
`diff.patch` `src/runner.ts:262`, `review.json` `src/runner.ts:220`). There is no
store, no SQLite, no event log anywhere in `src/` (full directory read this
session), and `package.json:17-24` carries zero persistence dependencies —
cross-run questions are answerable only by hand-scanning JSON under
`C:\swarm\<runId>\`. Spec §4 places a STATE STORE ("SQLite initially,
runs/jobs/attempts", lines 176-181) in the control plane; §27 "Persistence Model"
(lines 1805-1840) names the initial tables, of which `runs`, `candidates`,
`gate_results`, `events` are this slice's scope; §28 "Event Log" (lines 1844-1864)
defines the append-only stream; §34 Milestone 1 "Durable Local Control Plane"
(lines 2017-2028) lists "SQLite state" and "event log" as its first build items —
`docs/ROADMAP.md:12` maps stage 1 to exactly that row. Every later stage-1
capability — job DAG, attempts/retries, approvals, recovery, dashboard — reads
this state, so it is the foundation slice, not a nicety.

**Known caveat to record (VERIFICATION.md Known issues, same change-set):**
`node:sqlite` is experimental on Node 22 — the probe emits
`ExperimentalWarning: SQLite is an experimental feature and might change at any
time` on stderr and the API may churn across Node minors. Named fallback:
`better-sqlite3` — a native dependency, which would need its own
`docs/decisions.md` entry against the 2026-10-10 "TypeScript on Node 22" decision.
This slice uses only DatabaseSync open/exec/prepare semantics.

## Acceptance criteria

- [ ] `ingest` persists the fixture report into `runs`/`candidates`/`gate_results`
      with row counts and field values exactly matching the report — pinned by a
      new fast-tier gate (new VERIFICATION.md section, modeled on Gate 1.5's
      throwaway-sandbox pattern, `scripts/verify.mjs:62-143`): fresh temp DB →
      ingest `scripts/fixtures/report-real.json` → assert exact row counts and
      field values. (New fast-tier gate: store ingest)
- [ ] `events` is append-only: a second ingest of the same report appends a new
      block of event rows and leaves every prior row (seq, type, at, payload)
      unchanged, while `runs`/`candidates`/`gate_results` are idempotent by
      natural key — pinned by the same gate, second ingest against the same temp
      DB. (New fast-tier gate: store ingest)
- [ ] `PRAGMA integrity_check` returns `ok` on the written DB — pinned by the same
      gate. (New fast-tier gate: store ingest)
- [ ] Persistence is read-only over evidence: after ingest the source report
      fixture is byte-identical and no artifact file is moved, modified, or
      deleted — pinned by the same gate (T-002 rule: evidence is never deleted,
      `src/clean.ts:6-8`). (New fast-tier gate: store ingest)
- [ ] A failed DB write is loud but non-fatal: with the DB path unopenable (e.g.
      an existing directory), the ingest path completes without throwing out of
      the run, exit code unchanged, one loud persistence-failure line printed —
      pinned by the same gate exercising the failure path. (New fast-tier gate:
      store ingest)
- [ ] No behavior change to the pipeline: exit code, stdout verdicts, and
      `report.json` content are unchanged with the hook in place — pinned by one
      `npm run verify:full` run recorded in this ticket's Landed section
      (`src/cli.ts` is the run entry point, so a real run is the honest
      no-behavior-change proof). Gate 2 is **not** permanently extended: the
      invariant is pinned by the fast-tier gate above, and spending model tokens
      on every verify for it buys nothing. (Gate 2, once)
- [ ] Clean semantics untouched — `npm run verify` (which includes Gate 1.5) stays
      ALL GREEN with the hook in place; the structural-safety argument (the DB is
      a bare file under the run root; clean sweeps only `/^\d{14}$/` directories,
      `src/clean.ts:249-252`) recorded in VERIFICATION.md. (Gate 1.5)
- [ ] VERIFICATION.md gains the new gate section and the node:sqlite experimental
      caveat in the same change-set (AGENTS.md #6). (Gate 0 + change-set review)

## Verification

Gate 0 (`npm run typecheck` — also proves `node:sqlite` typechecks against the
pinned `@types/node`), Gate 1 (`npm run demo`, sanity), Gate 1.5 via
`npm run verify` (clean still green), the **new fast-tier store-ingest gate**
(added by this ticket), and **one** `npm run verify:full` run as the
no-behavior-change proof (spends model tokens once; not a permanent Gate 2
extension). Gate 0.5 not required (`src/parse.ts` untouched); Gate 3 not required
(no adapter touched).
