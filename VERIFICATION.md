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
Since T-029's review round 1 it also pins `parseBriefs`'s LAST-RESORT separator
repair: when no `[..]` slice parses, the scan retries once over text with the
observed LLM slip repaired — a duplicated closing quote at an element boundary
(`"," "` where `", "` was meant; recorded verbatim from real run
20261020053845's `planner-raw.txt`, the driving Gate 2 red that landed it: a
complete two-brief array whose single malformed separator made both planner
attempts fall back to the raw goal). Fixtures pin the repaired parse of
exactly that recorded shape (inner brackets + the captured OpenCode final
frame included), that the repair never fabricates briefs from hopeless input,
and that it is INERT whenever the plain scan parses — valid input whose string
content contains the slip's byte pattern parses through the plain path with
content intact. Every input that parsed before this change parses
byte-identically; no existing fixture changed. Required whenever `src/parse.ts`
changes.

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

### Checkout lock (T-004)

```bash
node node_modules/tsx/dist/cli.mjs src/lock.ts acquire <repo> [--run-root <path>] [--run-id <id>] [--force-lock]
node node_modules/tsx/dist/cli.mjs src/lock.ts release <repo> [--run-root <path>]
```

`src/lock.ts` is a zero-dependency cross-process checkout lock (`fs.openSync(wx)`)
so runs and clean can never concurrently mutate one target repo's worktrees.
Lock files live under `<run-root>\locks\<sha256(norm(repo))>.lock` — normalized
repo paths (`c:/x` and `C:\X` contend on one lock), never inside the target repo,
and `locks/` is structurally safe from `clean --all`'s `/^\d{14}$/` sweep.
`npm run skeleton` takes the lock after repo validation and releases it in a
`finally` on every path — a refusal happens before planner tokens are spent and
before the artifacts dir exists. `npm run clean` takes it per target repo inside
the per-run disposal (so `--all` locks each run's own repo in turn).

**Stale-lock policy: never auto-reap, never guess liveness.** Any existing lock
refuses with the holder pid, its age, and the lock file path; only the explicit
`--force-lock` flag takes it from a suspected-stale holder. A hard-killed run
therefore leaves a lock that blocks until a human overrides — by design (spec
§15.2: no live process is silently reattached based on stale PID metadata).

The fast tier pins: a held lock makes clean refuse non-zero removing nothing
(worktrees, branches, and evidence intact; refusal names pid + age + path); a
held lock makes a run refuse non-zero before any worktree or artifacts dir
exists (token-free); every proceeding clean releases its lock (no residual
`.lock` under `<run-root>\locks\`, asserted after the original clean scenarios
too); a failure after acquisition (bad `--base`) still releases; `--all` locks
per repo (a held lock on one run's repo refuses that run while another repo's
run still cleans, final exit 1); the stale policy above, including that
`--force-lock` proceeds and releases afterward. Uncontended behavior (exit
codes, stdout, `report.json`) was proven unchanged once by a real
`npm run verify:full` recorded in T-004's Landed section — not a permanent
Gate 2 extension.

### Integration replay (T-005)

```bash
npm run integrate -- --run <runId> --candidate cXX --gate "name=command" [...]
```

Replays a surviving candidate's captured `diff.patch` onto a fresh detached
worktree of the target repo at its **current HEAD** and re-runs the
operator-supplied gates there (spec §17.2 steps 1-4 and 6; no model
involvement anywhere). The replay contract is **compare-when-recorded**
(T-027): the `--gate` name set must exactly match the gates the candidate
passed in the run, and when a recorded gate result carries its `command`
(`GateResult.command` — stamped by `CommandGate` on every resolve, pass, fail,
and timeout alike; absent for non-shell gates and pre-existing reports), the
re-supplied command must equal it exactly, so a replay proves it exercised
the same commands the run survived instead of trusting the name set alone. A
report that predates command recording replays on the name set alone — the
T-005 contract, byte-for-byte.

The diff evidence itself is store-backed since T-028 (**verify-when-recorded**):
`--db <path>` (default `C:\swarm\refinery.db` — the T-006/T-008 defaults
precedent) addresses the diff by its recorded artifact handle
(`diffArtifactId` in `src/store/index.ts` — the exact id the T-016 ingest
derivation pushes, computed beside it so the handle cannot drift from the
ingested row; pinned by Gate 1.6 literals in both scopes). When the store
holds a `content_hash` for that handle, the diff on disk is re-verified
against the hash taken at ingest before anything replays: `verified`
proceeds (one log line naming the handle, "unmutated since ingest");
`mutated` refuses — the file changed SINCE INGEST, so replaying it would
re-verify evidence the run did not produce (spec §17.3: prior evidence is
marked historical), and the refusal says the since-ingest scope out loud.
**Honesty boundary:** hash-at-ingest proves unmutated-SINCE-INGEST, not
since-capture — the capture-time gap is a report-shape change that owns its
own Gate 2 and stays carved (T-016:57-60). `missing` refuses (the diff
existed at ingest and is gone from disk). A store that exists but cannot be
opened refuses with a clear message rather than silently replaying
unverified — a present-but-unreadable store means integrity evidence was
expected from it, and silent fallback would hide that. Every one of these
refusals comes from the pre-lock policy-refusal block: no integration
worktree, no lock. Fallback, byte-for-byte today's path-convention
behavior: no DB file at `--db` (ingest is post-run best-effort — the store
can legitimately not know a run), no row for the handle, or a null-hash row
(`unverified` — T-016 records NULL when the file was already missing at
ingest; null is never readable as mutated). This is the store's first READ
that gates an action — a scoping paragraph in the store module header
records it: a post-hoc, human-facing replay refusal, machine evidence only
(a sha256 equality check, zero model involvement, decisions.md 2026-10-10),
while the run pipeline itself still never reads the DB back.

Policy refusals (non-zero, nothing created):
non-survivor candidate, missing/empty diff (a NO-OP is never a
pass), unknown candidate id, gate-name mismatch, gate-command mismatch
against a recorded command (refused from the pre-lock policy-refusal block —
no integration worktree, no lock taken), a diff mutated since ingest and a
diff deleted since ingest, and a present-but-unopenable store (all three
T-028, the same pre-lock block), already-present integration
worktree. `git apply --check` then `git apply` (atomic — a rejecting patch
leaves the tree untouched); an apply that lands but changes nothing is a NO-OP
refusal. Capture is binary-safe (T-026): `WorktreeProvider.diff` runs
`git diff HEAD --binary` (`src/workspace/worktree.ts:76-85`), so a
binary-touching candidate's `diff.patch` carries `GIT binary patch` sections —
git's base85 armor, printable ASCII + newlines only, still a string end to end
— whose full 40-hex index lines are exactly what `git apply` requires. The
three-way behavior contract, each refusal leaving the integration worktree
untouched (the historical check reads the patch before any apply): a post-fix
binary diff onto a clean target replays byte-identically; a `diff.patch`
carrying the lossy pre-fix stub line (`Binary files … differ` — exactly what
pre-T-026 capture emitted) is historical evidence that cannot be reconstructed
and refuses non-zero naming that (spec §17.3: prior evidence is marked
historical); a genuinely drifted binary — the pre-image blob no longer
matches at current HEAD — fails `apply --check` with an ordinary "patch does
not apply" and is refused through the ordinary conflict path. The
verdict artifact `<runDir>/integrate/<id>.json` records
applied/treeChanged/gates/passed — its gate entries carrying the re-supplied
commands verbatim (`gates[].command`, T-027, riding the `CommandGate` stamp);
exit 0 iff applied + treeChanged + all gates
passed. Every replay verdict is recorded through the store (T-028):
`recordIntegrateVerdict` upserts ONE `artifacts` row for the verdict file
under the producer triple `(candidateId, NULL, verdictPath)` — attempt NULL,
because the replay is not an attempt of the run's job; kind `'report'` by
the path rule — with `size_bytes`/`content_hash` measured by the same
`measureEvidenceFile` read the run's own evidence gets, after the file is
written (hash-at-ingest of the replay's own evidence), and appends one
`INTEGRATE_REPLAYED` event stamped from the verdict's own `appliedAt` (the
store header's fourth documented wall-clock scoping case; the event is a
documented §28 vocabulary extension there, per the T-008/T-009 precedent —
§28 names no integration event). Never `gate_results`: the table's PK
`(run_id, candidate_id, gate_name)` with its upsert would OVERWRITE the
run's own recorded verdicts — evidence mutated by a replay — so the
per-gate outcomes ride inside the hashed verdict file and the event payload
only. Recording is best-effort, the run-ingest posture: a failed store
write logs `PERSISTENCE FAILED` loudly and never changes the exit code
(stays gate-determined) or the on-disk verdict artifact; no DB file at
`--db` skips the record — nothing creates a `refinery.db` as a side
effect. The default `--db` (`C:\swarm\refinery.db`) is the operator's
store: outside the fast tier, an `integrate` run on a machine where that
file exists verifies against it and records the replay verdict into it —
that is the designed post-hoc behavior for a run the operator ingested.
The FAST TIER never touches it: every Gate 1.5 face runs `integrate`
through one spawn helper that injects `--db` at a deliberately-absent
sandbox path unless the face passes its own temp store, so no
fast-tier invocation reads or writes any real store (the T-028 review
round 1 fix — before it, the DB-less faces consulted the default path and
each success-path replay recorded its fixture verdict into the live
store, observed as 5 artifacts rows + 20 `INTEGRATE_REPLAYED` events for
2099-* run ids pointing at verify-integrate paths the sandbox deletes;
the polluted rows were removed and the fix proven by a full fast-tier run
leaving the live store byte-identical). Replay never commits, never
branches, never moves a ref (§17.4).

The replayed worktree is left in place for inspection, dirty by construction:
plain `clean` refuses it (dirty-protection proven intact on this worktree
class) and `clean --force` disposes it via the existing `wt/`-discovery, while
`integrate/<id>.json`, `diff.patch`, and `report.json` survive. The whole flow
runs under the T-004 checkout lock, released on every path.

The fast tier pins all of it against a throwaway sandbox (diffs captured
exactly like `src/workspace/worktree.ts`): clean replay onto drifted HEAD
(exit 0, post-drift `targetHead`, change present, canonical checkout and HEAD
untouched, no new branches, detached worktree), conflict refusal with an empty
worktree, every policy refusal, gate-name contract (extra/missing/renamed)
refusing before any worktree exists, both disposal faces, and no residual
lock files afterward. Binary-safe capture and replay (T-026): the sandbox
baseline commits a small binary file (`asset.bin`), a candidate edit to it is
captured through the flipped captureDiff mirror, and its diff.patch contains
`GIT binary patch` sections and never the lossy stub; the replay exits 0 with
the binary byte-identical (sha256 asserted) and the verdict recording applied
+ treeChanged + passed; a hand-written pre-fix stub (exactly the pre-T-026
capture's output shape) refuses as historical evidence with an empty
worktree; a post-fix patch whose pre-image drifted refuses through the
ordinary apply-check path, worktree untouched; and the binary replay worktree
goes through both disposal faces with its evidence surviving. Recorded gate
commands (T-027), three faces plus the back-compat pins: a report whose
recorded gates carry commands refuses a differing re-supplied command with
exit 1 from the pre-lock policy-refusal block — no integration worktree, the
sandbox repo's `worktree list` untouched, and no lock ever taken (the
sandbox's `locks/` directory never appears); an exact names-and-commands
match replays with exit 0 and the verdict recording the re-supplied commands
verbatim; an old-shape report (no recorded command) replays name-only
including a different command under a matching name — and the existing
command-less `REPORT_GATES` fixtures run unchanged as the back-compat pins
(the T-005 name-set contract stays for every report that lacks commands).
Store-backed replay (T-028), a help/flag pin plus six faces: the usage
documents `--db` with its `C:\swarm\refinery.db` default (the flag itself
is exercised by every face); a fixture run ingested into a temp DB (through
the real store, via a generated tsx helper — the sandbox is removed at the
top of the section) replays exit 0 with the verified handle logged
(`j:<id>/diff.patch-<digest>`, "unmutated since ingest"); a diff flipped
after ingest refuses exit 1 from the pre-lock block — no integration
worktree, the sandbox repo's `worktree list` untouched, no lock files, no
verdict artifact, the refusal naming the since-ingest scope; a diff deleted
after ingest refuses as store status `missing` (the store check precedes
the on-disk existence check, so the refusal names the recorded evidence);
a junk file at `--db` (present but unopenable) refuses with a clear message
rather than replaying unverified, again with no worktree and no lock; a
temp DB holding a NULL-hash row (the diff absent at ingest, the file
appearing later) falls back to today's replay — exit 0, never claiming
store verification — the DB-less fixtures above running unchanged as the
back-compat pins; and `--db` at an unwritable store (the DB ingested, then
made read-only) replays with the exit still gate-determined, the on-disk
verdict intact, and the failure logged `PERSISTENCE FAILED`. Each passing
replay disposes its own dirty worktree through `clean --force` (the T-027
pattern) so the section's tidy sweeps stay green. Store isolation (the
review round 1 fix): every face without its own store — the T-027 faces,
AC#1-#6, and the T-026 binary faces — runs with `--db` at a
deliberately-absent sandbox path injected by the section's spawn helper,
so the no-DB-file fallback branch is what the back-compat claim pins and
no fast-tier invocation ever consults the default `C:\swarm\refinery.db`.

## Gate 1.6 — store ingest (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-store.mjs
```

Pins the durable run records (T-003), the derived job DAG (T-006), the
attempt records (T-007), the recorded schedule (T-009), the filesystem
artifact store (T-016), the store-backed integrate pieces (T-028), the
promptVersion end-to-end copy (T-029), the verdict-neutral additive
rounds block (T-030), and the store-invisible additive `earlyStops` block
(T-031):
`src/store/index.ts` ingests a finished `RunReport`
into SQLite (`node:sqlite`, schema v5: `runs`, `candidates`, `gate_results`,
`events`, T-006's `phases`/`jobs`/`job_dependencies`, T-007's `attempts`,
T-008's `approval_gates` — which ingest never writes; Gate 1.9 owns it — and
T-016's `artifacts`/`probe_runs`)
— zero npm dependencies. All tables are `CREATE TABLE IF NOT EXISTS`, so an
existing v1/v2/v3/v4 `refinery.db` gains the newer tables on its next use — no
migration machinery, no backfill: old runs gain DAG/attempt/artifact rows only
when re-ingested, which appends a fresh event block by design.
One call site in `src/cli.ts` immediately after `runSkeleton` returns, behind
`--db <path>` (default `C:\swarm\refinery.db`). Failure policy is
log-and-continue: a failed DB write prints one loud `PERSISTENCE FAILED` line
and never changes the run's exit code, stdout verdicts, or artifacts —
persistence records verdicts, it never influences them.

The gate ingests the vendored real report (`scripts/fixtures/report-real.json`,
a verbatim copy of run 20261011022419) into a fresh temp DB and asserts:

- exact row counts and field values across `runs`/`candidates`/`gate_results`,
  including `planner_json`/`review_json` round-trips,
- the fixture predates attempts and yields zero `attempts` rows (pre-T-007
  reports ingest unchanged),
- the derived job DAG (T-006) matches the report's real fan-out: exactly one
  `phases` row (`phase_id = 'main'`, `dependencies_json` `[]`, §6.3 policy
  columns null), one `jobs` row per candidate (`job_id` = the candidate id,
  `worker_id`/`model`/`brief` copied verbatim, empty dependencies, every §6.4
  policy column null), and zero `job_dependencies` rows — the flat derivation
  is the fallback for schedule-less reports; a report carrying a schedule
  block derives its REAL structure instead (the T-009 bullet below),
- the pure validators (`unknownDependencyRefusal`, `cycleRefusal`, exported
  from the store module, no I/O) accept the derived flat DAG and refuse
  hand-built synthetic inputs — a 3-cycle and a self-dependency (the refusal
  names every job on the cycle) and an unknown-dependency reference (the
  refusal names the offender and the missing id) — Gate 0.5's hand-built-input
  pattern: no pipeline, no model tokens,
- `events` semantics: an all-pass report emits exactly `RUN_CREATED` at the
  report's own `startedAt`; a modified report with a failed gate and an
  eliminated candidate emits `GATE_FAILED` + `CANDIDATE_ELIMINATED` with `at`
  derived from `startedAt` + the candidate's worker duration (never
  `Date.now()`, so re-ingest is deterministic),
- the attempts table (T-007), on a hand-built retried-candidate variant of
  the fixture (the elim-variant pattern): one row per recorded attempt keyed
  `(run_id, job_id, attempt_number)` with
  state/started_at/ended_at/input_context_hash/output_artifacts_json/
  failure_json copied from the report record, `prompt_version`/
  `process_identity_json`/`worker_session_id` null (no producer this slice —
  stated, not smoothed), a candidate still carrying the pre-T-007 shape (no
  `attempts` array) yielding zero rows, exactly one derived `ATTEMPT_STARTED`
  per attempt with `at` taken from the attempt's own `startedAt` and a
  payload naming job/attempt id/number,
- the `prompt_version` column end-to-end (T-029), on a hand-built
  promptVersion-carrying variant of the fixture (the elim-variant pattern):
  two attempts with DISTINCT 64-hex `promptVersion` values ingest with
  `attempts.prompt_version` equal to the report value per attempt number —
  the upsert copy, until now exercised only as null; the retried/probes
  fixtures above keep their producer-less nulls pinned
  (`process_identity_json`/`worker_session_id` still producer-less),
- the additive `rounds` block (T-030), on a hand-built 2-round variant of
  the fixture (the elim-variant pattern): ingest accepts the
  rounds-carrying report and keeps persisting VERDICTS only — candidates
  rows from both rounds (the round-2 ids `<survivorId>-r2` never collide
  with round-1 rows), gate_results from both rounds, and the SAME report
  minus the block ingesting to identical runs/candidates/gate_results rows
  (the block is invisible to the store — never read, never a verdict); no
  new table materializes for it (the census stays the 11 schema-v5
  tables), and re-ingest stays idempotent over state rows,
- the additive `earlyStops` block (T-031), on a hand-built
  earlyStops-carrying variant of the fixture (the rounds-variant pattern:
  foundation concludes early — c01 dispatched and passing, c02
  declared-then-suppressed with `dispatchIndex: null` and NO candidate row
  — app stays blocked behind it, and the block carries one met:true
  record): ingest accepts the block and keeps persisting VERDICTS only —
  `early_stop_json`/`approval_gate_json` stay null on every phases row
  (the T-009 null pin above does NOT flip; the record lives in the report
  block, the column's producer is a later ticket), never-dispatched jobs
  derive job rows with empty worker/model/brief (nothing fabricated), the
  `concluded-early` status derives NO `PHASE_COMPLETED` event (the
  unchanged `p.status !== 'completed'` filter), no new table materializes,
  the SAME report minus the block ingests to identical
  runs/candidates/phases/jobs/gate_results rows, and re-ingest stays
  idempotent,
- re-ingest of the same report leaves `runs`/`candidates`/`gate_results` —
  the DAG tables (`phases`/`jobs` upsert by natural key, `job_dependencies`
  re-derived delete+insert) — and the `attempts` rows (upsert by natural
  key) idempotent, while `events` appends a fresh deterministic block and
  never rewrites prior rows,
- the schedule block (T-009), on a hand-built DAG variant of the fixture
  (the elim-variant pattern: two real phases `foundation` → `app` with the
  expanded edge `c02 -> c01`, c02's gates failed): two `phases` rows with
  the real ids, declared dependencies, and the `completion` policy (its
  first producer; `early_stop_json`/`approval_gate_json` stay null), job
  rows carrying their real phase and expanded edges with worker/model/brief
  joined from the candidate reports, exactly one real `job_dependencies`
  edge, and the derived schedule events after the per-candidate block in
  schedule order — `JOB_READY` (§28:1852) per dispatched job with `at` = the
  max of its dependencies' finish stamps (run `startedAt` for
  dependency-free jobs), `JOB_SUCCEEDED`/`JOB_FAILED` (the documented §28
  vocabulary extensions — §28 names no job-terminal events) at each job's
  own finish stamp, `PHASE_COMPLETED` only for the phase that reached
  terminal success on every job — every `at` a pure function of the report
  (never `Date.now()`); re-ingest leaves the DAG rows idempotent while
  events append a fresh deterministic block,
- the artifact store (T-016, schema v5): the table census — a fresh ingest
  materializes exactly 11 tables (the prior 9 + `artifacts` + `probe_runs`;
  internal `sqlite_*` tables excluded) — and the columns are exactly the
  producer-narrowed sets (`media_type`/`lineage`/`metadata`/
  `retention_class` omitted, not pre-defined; `probe_runs`
  field-for-field the `ProbeRunSummary` shape); on the main fixture (which
  predates attempts and probes) exactly 6 `artifacts` rows derive —
  `report.json` recovered via the existing reportPathOf heuristic, the
  planner raw output, and per candidate the diff + review raw output —
  paths verbatim, candidate-scoped rows carrying `job_id` with null
  `attempt_number`, zero `probe_runs` rows; the `artifact_id` scheme is
  pinned twice over — fixed-input literals over the exported function
  (`run/…`, `j:<id>/…`, `j:<id>@a<n>/…` scopes over a sha256 digest of the
  producer triple) and the report.json row's full literal id — stable
  across re-ingest; on a hand-built retried variant the attempt-scoped
  rows carry their own attempt numbers while `diffPath`/review attribute
  the FINAL attempt (so one path named by both is two producer rows, and
  inside one producer triple it is ONE deduplicated row); a probes variant
  (the elim-variant pattern, sandbox-local bundle files) derives one
  `probe_runs` row per summary plus a matching probe-bundle `artifacts` row
  (`attempt_number` = the final attempt) and no row for bundle-internal
  `.log` files — the bundle is the addressable unit,
- the store-backed integrate pieces (T-028): `diffArtifactId` pinned by
  exact literals in BOTH scopes (the pre-T-007 `j:<id>` and the T-007
  `j:<id>@a<n>`, over the same fixed inputs as the pinned `artifactId`
  scheme literals) and matched against the actually-ingested diff rows on
  the fixture (pre-T-007 scope) and the retried variant (the FINAL
  attempt's row) — no handle drift from the ingest derivation is possible;
  `recordIntegrateVerdict` upserts exactly ONE `artifacts` row for
  `integrate/<id>.json` — kind `'report'` by the path rule, producer triple
  `(candidateId, NULL, path)`, `artifact_id` the deterministic derivation —
  whose `size_bytes`/`content_hash` equal the written verdict file
  (hash-at-ingest of the replay's own evidence), appends exactly one
  `INTEGRATE_REPLAYED` event at the verdict's own `appliedAt` (never
  `Date.now()`) with the payload naming
  candidateId/targetHead/applied/treeChanged/passed/worktreePath/
  verdictPath, leaves `gate_results` value-identical before and after
  (a replay NEVER writes gate_results — the PK upsert would overwrite the
  run's own recorded verdicts) and the run's own artifacts rows untouched
  (the verdict row the only addition), leaves all prior event rows
  unchanged with exactly one event appended, is idempotent on re-record
  (the same verdict twice → the same ONE row, events append-only), and
  `PRAGMA integrity_check` returns `ok`;
- hash-at-ingest (the documented third scoping case in the store module
  header — ingest is deterministic as a function of *(report, the evidence
  files it names)*, reads evidence, never writes it, the wall clock never
  enters a stamp), pinned ONLY on a controlled sandbox variant (the main
  fixture's real run-dir files may or may not exist on a given machine, so
  its rows are pinned on paths/kinds/ids but never hash values):
  `size_bytes`/`content_hash` equal the byte length/sha256 of controlled
  file content; a report-named path with no file on disk records NULL for
  both — never fabricated; every controlled evidence file is byte-identical
  after ingestion and re-ingest recomputes identical rows
  (the store header gained two more entries beside it in T-028, noted here
  where the T-016 case is described: the FOURTH wall-clock scoping case —
  the integrate replay's `INTEGRATE_REPLAYED` event and verdict row,
  wall-clock stamped from the verdict's own `appliedAt`, a primary fact the
  replay produced that no report carries — and the scoping paragraph for
  the store's first READ that gates an action, integrate's
  verify-when-recorded refusal: post-hoc, human-facing, machine sha256
  evidence only, zero model involvement, while the run pipeline still never
  reads the DB back — pinned behaviorally by the extended Gate 1.5 faces
  above),
- `ARTIFACT_CREATED` events (§28:1854): exactly one per artifacts row,
  appended after every existing derived block (per-candidate, schedule) in
  derivation order, payloads naming artifactId/path/kind/jobId/
  attemptNumber, every `at` a pure function of the report's stamps —
  run-level artifacts at `finishedAt`, candidate-scoped ones at the shared
  job finish-stamp derivation (the retried variant pins `at` at the final
  attempt's own `endedAt`; the sandbox variant pins that `endedAt` wins
  over the ladder derivation) — never `Date.now()`; re-ingest leaves ALL
  state rows idempotent (runs/candidates/gate_results/phases/jobs/
  attempts/artifacts/probe_runs) while `events` appends a fresh
  deterministic block,
- `PRAGMA integrity_check` returns `ok`,
- the source fixture is byte-identical after ingestion (persistence is
  read-only over evidence — T-002 rule),
- ingest into an unopenable DB path (existing directory, or missing parent
  directory) throws — the loud, non-fatal failure the CLI catches.

Structural safety from cleanup: the DB is a bare file under the run root
(`C:\swarm\refinery.db`); clean `--all` sweeps only directories matching
`/^\d{14}$/` (`src/clean.ts:249-252`), never a bare file, so the store is
outside every cleanup path (Gate 1.5 stays green with the hook in place).

Not pinned here and not permanently required: pipeline no-behavior-change
(exit code, stdout verdicts, `report.json` content) was proven once by a real
`npm run verify:full` run recorded in T-003's Landed section. Gate 2 is not
extended for the store — spending model tokens on every verify buys nothing.

## Gate 1.7 — dag dump CLI (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-dag.mjs
```

Pins the read-only job-DAG dump (T-006): `npm run dag -- --run <runId>
[--db <path>] [--json]` (`src/dag.ts`, the clean/integrate standalone-entry
pattern) prints a run's recorded DAG — its phases, jobs, and dependency
edges; `--json` emits the same structure as JSON (what a future
scheduler/dashboard would consume). This is the repo's first DB readback:
post-hoc inspection of what ingest already recorded, feeding no verdict
(decisions.md: machine gates decide survival). `--db` defaults to
`C:\swarm\refinery.db` — same literal as `src/cli.ts` (decisions.md: run root
is `C:\swarm\`).

The gate ingests the vendored fixture into a fresh temp DB and asserts:

- `--run <runId>` exits 0 and prints the phases, jobs, and edges sections;
  `--json` exits 0 and parses to exactly the derived structure — one `main`
  phase with no dependencies, one job per candidate (`jobId` = candidate id,
  `workerId`/`model`/`brief` verbatim, empty dependencies), zero edges,
- refusals exit non-zero with nothing on stdout (the T-005 refusal pattern):
  an unknown runId (message names it), a missing DB file — and the dump must
  not create an empty `refinery.db` as a side effect (asserted absent
  afterward) — and a missing `--run` (message names the requirement),
- the dump never writes: the DB file is byte-identical (sha256 before/after
  both dumps), and a write against a `readOnly`-opened handle throws —
  pinning the open option itself against node:sqlite churn (Known issues #7).

## Gate 1.8 — attempts + bounded same-config retry (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-retry.mjs
```

Pins the T-007 runner semantics: per-job Attempt records in the report plus a
bounded same-config retry (`--max-attempts`, default 1), with the
`CandidateReport.attempts` array added (report-shape change). The check
drives `runSkeleton` directly with a **fake `WorkerAdapter`** (the seam at
`src/types.ts` makes this trivial — the engine stays harness-agnostic) and
fake `Gate` objects against throwaway fixture repos (one per scenario, so
`swarm/*` branch namespaces cannot collide; list-form git calls only), zero
model tokens. It asserts:

- **fail-once-then-succeed × `maxAttempts` 2** → exactly two attempts;
  attempt 1 `failed` with a `FailureRecord` (reason `worker-failed`, exit
  code, not timed out), attempt 2 `succeeded` with no failure record; the
  final candidate's verdict is identical in shape to today's (worker ok,
  gates pass, `diffBytes > 0`, no error) and its `workspacePath` is the final
  attempt's worktree; the worker executed exactly twice; the on-disk
  `report.json` carries the attempts arrays (the store ingests the artifact).
- **fresh workspace per attempt (spec §15.1)**: attempt 1 leases `wt/<id>`
  (branch `swarm/wt-c01`), attempt 2 leases `wt/<id>-a2` (branch
  `swarm/wt-c01-a2`) at the same `baseSha` (both worktrees' `rev-parse HEAD`
  equals the run base); attempt 2's diff contains only its own change —
  nothing adopted from attempt 1's worktree or branch; one branch per
  attempt, each leased by exactly one worktree, no collisions.
- **attempt-scoped evidence**: attempt 1's `worker.log`/`diff.patch` survive
  at today's paths (`<id>/worker.log` is not overwritten — its content is
  still attempt 1's), attempts ≥ 2 write under `<id>/attempt-<n>/`, and each
  attempt's `outputArtifacts` names its own paths with the files existing on
  disk (a thrown attempt names just its `worker.log`).
- **the bound eliminates**: an always-failing worker yields exactly
  `maxAttempts` attempts and the candidate's final verdict is the same
  elimination the ladder produces today (worker failed, no gates pass).
- **default is today's behavior**: with `maxAttempts` 1 (the CLI default) a
  succeeding candidate records exactly one `succeeded` attempt with today's
  lease id (`wt/c01`), branch (`swarm/wt-c01`), and evidence paths
  (`<id>/worker.log`, `<id>/diff.patch`), and no attempt-scoped directory; a
  failing one records exactly one attempt and is eliminated as before —
  the only report difference is the added `attempts` array of length 1.
- **retry fires only on the mechanical legs**: a worker that succeeds with a
  zero-byte diff, or succeeds and fails gates, is eliminated exactly as
  today and never re-rolled (no-op-then-pass and gates-fail-then-pass fake
  workers produce exactly one attempt each, with the attempt `succeeded` and
  no failure record); a thrown attempt (ladder leg `error`) IS retried —
  attempt 1's `FailureRecord` carries reason `error`, the message, exit code
  null, `timedOut` false — and the retried candidate passes.
- **input-context hash**: the same brief+model hashes identically across
  attempts (64-hex sha256 over brief + model + the composed prompt with the
  workspace-path line excluded — the §7.7 fingerprint narrowed to what has a
  producer); since T-029 `promptVersion` carries its own positive producer
  pin on the same scenario: every attempt's `promptVersion` is the 64-hex
  sha256 of the exact prompt text the adapter received, recomputed in the
  check from the fake worker's `req.prompt` recording (never `builderPrompt`)
  — and because the exact text embeds each attempt's lease path, retry
  attempts carry DISTINCT `promptVersion` values while their
  `inputContextHash` stays identical (the normalization boundary: the two
  fields answer different questions — same-input vs exact-sent-text).
- **CLI**: `--help` documents `--max-attempts <n>` (default 1, values < 1
  refused); `--max-attempts 0` (and a non-integer) refuse with exit 1
  naming the flag, before the checkout lock is taken or any artifacts dir
  exists (the run root stays empty, no `locks/` directory).

Not pinned here: a real harness retry (Gate 2 exercises real workers with
default `maxAttempts` 1 — no behavior change), §15.2/§29 startup
reconciliation (`abandoned` has no producer until the reconciliation slice),
§30's other failure policies, and the full §7.7 fingerprint (Milestone-2
context system).

## Gate 1.9 — approval gates (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-approvals.mjs
```

Pins the durable approval records (T-008): the `approval_gates` table (schema
v4) in the T-003 store, written only by `requestApproval`/`decideApproval`
through the standalone `npm run approvals` CLI (`src/approvals.ts`, the
clean/integrate/dag standalone pattern) — `request` records
`waiting_for_approval` for a finished run's survivors, `decide` records
`approved`/`rejected` on one pending row, `list` is the pending-approval
queue (spec §26.6's Milestone-7 UI, token-free precursor, exactly as the
`dag` dump is §26.2's). Zero behavior change to the pipeline: plain ingest is
approval-blind and nothing automated consumes a decision this slice — the
value delivered is the durable decision record and the queue; the successor
ticket that wires approval state into `integrate` extends T-005's refusal
contract and owns its own Gate 2 run.

**Wall-clock scoping of the determinism rule — documented, not discovered:**
ingest's stamps stay pure functions of the report (never `Date.now()`), but
approval requests and decisions are primary human facts no report carries, so
their rows (`requested_at`/`decided_at`) and events are legitimately
wall-clock stamped, written only by operator action through the CLI. The
determinism rule continues to govern everything report-derived (`ingest` is
untouched). The gate pins both halves: approval stamps parse as ISO-8601 and
differ from the report's own stamps, while `RUN_CREATED` stays at the
report's `startedAt`.

The check ingests the vendored fixture into fresh temp DBs (plus its
elim-variant, where c02's build gate fails and only c01 survives) and drives
ingest and the CLI as separate subprocess invocations — each subcommand sees
the state the previous process persisted, proving state lives in the DB, not
in any process. That is the exercisable form of "survives orchestrator
restart" today; the paused-execution form is carved until the scheduler or
crash-recovery slices exist (T-007's carve stands). It asserts:

- plain ingest is approval-blind: zero `approval_gates` rows and no
  `APPROVAL_*` events — approval state exists only through explicit operator
  action,
- `request` records the queue: exactly one row per surviving candidate keyed
  `(run_id, phase_id, job_id)` with `phase_id` from T-006's derived phase and
  `job_id` = candidate id, state `waiting_for_approval`, `requested_at`
  wall-clock, `requested_by` recorded (`--by` or the OS username default) —
  plus exactly one `APPROVAL_REQUESTED` event per row, `at` the row's own
  stamp, payload naming phase/job/requester; `--job` narrows to one; jobs
  already carrying an approval row are skipped, never rewritten
  (additive-only); survivors only — the elim-variant run records nothing for
  the eliminated candidate,
- `decide --decision approved|rejected` flips the row with
  `decided_at`/`decided_by` recorded and appends exactly one
  `APPROVAL_GRANTED` / `APPROVAL_REJECTED` event — `APPROVAL_REJECTED` is
  the slice's documented vocabulary extension (spec §28 names no rejection
  event),
- rejection corrupts nothing: after a reject, `runs`, `candidates`, and
  `gate_results` rows are value-identical to before (full-table comparisons),
  every prior event row (seq, type, at, payload) is unchanged with exactly
  one row appended, and `PRAGMA integrity_check` returns `ok`,
- the queue view: `list` exits 0 and prints pending rows; decided rows drop
  out of the default queue; the empty queue prints `no pending approvals`;
  `--json` emits the same structure as JSON,
- read-only views never write: the DB file is byte-identical (sha256
  before/after `list` and `list --json`; readOnly open), and a write against
  a readOnly-opened handle throws — the Known issues #7 node:sqlite churn
  guard, same as Gate 1.7,
- refusals exit non-zero with nothing on stdout and no DB side effects:
  missing DB file for all three subcommands (no subcommand ever creates a
  `refinery.db` — asserted absent afterward), unknown runId on request and
  decide (`list --run` is a filter — an unknown run simply has an empty
  queue, stated rather than smoothed over), request/decide for an eliminated
  candidate (the refusal names the rule: an approval must not resurrect one
  — decisions.md 2026-10-10, gates decide survival), decide on an unknown
  job or a survivor with no recorded request, double-decide (the refusal
  names the row's current state — the audit record is not rewritable),
  unknown `--decision` value, missing flags, unknown subcommand — and the
  refusals wrote nothing (row/event counts re-checked after),
- process death: request, decide, and list run as separate processes and each
  sees the state the previous one persisted.

Not pinned here and carved by the ticket: the `'cancelled'` state and
`APPROVAL_CANCELLED` event (no producer until an abort/cancel slice), §24's
other outcomes (`return to generation`, `pin candidate for later`), §26.6's
UI (the CLI `list` is the precursor), approval-gate enforcement anywhere in
the pipeline (`npm run integrate` does not gate on approval state), and
in-run pause/resume.

## Gate 1.10 — deterministic scheduler (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-scheduler.mjs
```

Pins the T-009 scheduler: the minimal `--jobs` spec (the §6.3/§6.4 subset —
only fields with a producer; `completion` accepts only `"all"`; job ids are
`[a-z0-9][a-z0-9-]*` so derived lease/branch names stay collision-free),
`src/scheduler.ts`'s pure ready-queue function, the DAG-driven runner loop
in `src/runner.ts` under the existing concurrency cap, the T-007 retry rule
verbatim with attempt-scoped `wt/<jobId>-a<n>` leases, phase completion
`all`, lazy leasing at the run's `baseSha`, and the recorded
`RunReport.schedule` block — plus, since T-031, the phase-level early stop:
the `EarlyStopPolicy` spec field, the pure `earlyStopMet` decision, the
stop's dispatch-only semantics in the runner loop, the `concluded-early`
phase status, and the additive `earlyStops` report block. No existing gate
can pin scheduler behavior —
the fast tier never runs the pipeline and Gate 2 spends model tokens and
cannot assert determinism — so this gate drives the exported pure function
directly and the runner end-to-end with a **fake `WorkerAdapter`** (the
`src/types.ts` seam; the Gate 1.8 pattern) against throwaway fixture repos
(one per scenario, list-form git calls only), zero model tokens. It asserts:

- the ready-queue function is pure and dependency-safe on synthetic DAGs
  (chain, diamond, independent, mixed): only jobs whose every dependency has
  reached terminal SUCCESS are returned — a terminal-FAILED dependency
  blocks its dependents for good while independents stay ready — tie-broken
  by ascending job id, bounded by the cap minus in-flight, with identical
  inputs giving identical output and no input mutated; the determinism
  contract is the ready order (never wall-clock, never insertion order,
  never model opinion), documented in `src/scheduler.ts`,
- `parseJobsSpec`: phase dependencies expand to job edges (every job of a
  phase depends on every job of each phase it depends on), defaults apply
  (`completion: "all"`, empty dependencies), optional per-job
  `model`/`worker`/`timeoutMs`/`gates` are preserved, and every refusal
  names its offense: unknown fields (including `approvalGate` and the §6.4
  policy fields — `earlyStop` is a known field since T-031, pinned
  positively below), non-`all` completion, empty job set, duplicate ids, id
  charset violations, unknown phase references, job-less phases, unknown
  dependencies (T-006's validator message), and a cycle — job-level or
  surfacing through expanded phase edges — whose refusal names the cycle
  (T-006's `cycleRefusal`),
- determinism end-to-end: two runs over the same `--jobs` spec with the same
  fake-worker outcomes produce identical recorded schedule blocks (per-job
  `dispatchIndex` equal across the reports), under a cap-1 two-phase DAG and
  a wide-cap chain; concurrent completion interleaving is not deterministic
  and is not claimed to be,
- the concurrency cap is never exceeded: the fake adapter counts in-flight
  executions; on five dependency-free jobs under cap 2 the observed maximum
  is 2 (parallelism observed, never exceeded) with every job executed
  exactly once,
- dependent jobs dispatch only after their dependencies reach terminal
  success — across phases via expanded phase edges (the fake adapter records
  the worker call order; the recorded `dispatchIndex` and expanded edges
  agree with it),
- the T-007 retry rule verbatim in `--jobs` mode: fail-once-then-succeed
  requeues the job as a fresh attempt in `wt/<jobId>-a<n>` at the same
  `baseSha` (exactly two attempts, one dispatch, one branch per attempt, no
  collisions); an always-failing worker hits the `maxAttempts` bound and the
  job records terminal failure; a succeeded-but-no-op or gates-failed leg is
  never re-rolled (exactly one attempt, job failed); a thrown leg IS
  retried,
- phase completion `all`: a failed job fails its phase, the dependent
  phase's job is never dispatched — recorded as not-dispatched
  (`dispatchIndex: null`, no candidate report, no branch/worktree ever
  created), never fabricated as terminal — and the independent phase still
  runs to completion (`completed`),
- phase-level early stop (T-031, spec §20:1265-1281, spec §34 M8):
  `earlyStop: { minSurvivors: <positive integer> }` parses and is preserved
  on PhaseSpec, while a non-object `earlyStop`, a missing/non-integer/`< 1`
  `minSurvivors`, and any unknown sub-field refuse naming the offense
  (`approvalGate` stays refused; the flip is recorded below); the pure
  `earlyStopMet` is pinned by direct-call faces — identical terminal maps
  give identical decisions, no input mutated, terminal failures never count
  as survivors; end-to-end with the fake adapter, `minSurvivors: k` with
  `k < N` and cap < N means: after the k-th success the remaining ready
  jobs are never dispatched (`dispatchIndex: null`, no candidate report, no
  lease/branch/worktree ever created), every ALREADY-dispatched job runs to
  completion exactly once (executions == dispatches — the stop never
  kills), and each in-flight survivor carries its full verdict ladder
  (gates ran, candidate report written); dependents of a concluded-early
  phase stay never-dispatched while an independent phase still completes;
  the phase status is `concluded-early` exactly when the declared policy is
  MET and ≥ 1 job was never dispatched (precedence
  failed > concluded-early > completed > blocked: a met policy with zero
  never-dispatched jobs leaves `completed`; failure keeps `failed`; a
  declared-but-unfired policy changes no status — a starved phase stays
  `blocked`); a suppressed job never consumes another phase's dispatch
  capacity — with a suppressed-but-ready job sorting AHEAD of it under cap
  1 (suppressed `a2` before independent `z1`), the independent phase's job
  still dispatches and its phase records `completed`, never a false
  `blocked` (review round 1 red, recorded in T-031's Landed: the pre-fix
  filter sat AFTER the ready call's cap slice and could strand another
  phase's ready work for the rest of the run — red-before/green-after per
  AGENTS.md #8); and the additive `earlyStops` report block — present only
  when a phase DECLARED a policy (default mode AND policy-less `--jobs`
  reports carry no block, in memory or on disk), one record per declaring
  phase in spec order with
  `{ phaseId, condition: 'minSurvivors', threshold, met, survivorIds,
  neverDispatchedIds }`, `met: true` entries agreeing exactly with the
  schedule block's `dispatchIndex: null` entries for that phase, and
  `met: false` entries recording a declared-but-unfired policy (survivorIds
  = all terminal-succeeded, neverDispatchedIds = the starved jobs),
- default mode is today's behavior: without `--jobs`, candidate ids in
  order, one dispatch per candidate, today's lease ids/branches and evidence
  paths (`wt/<id>`, `swarm/wt-<id>`, `<id>/worker.log`, `<id>/diff.patch`),
  the runner's stdout attempt/gate lines unchanged, and **no `schedule`
  block** in the report (in memory or on disk); the degenerate one-phase
  spec is synthesized and driven through the same loop, and the legacy
  fan-out is deleted,
- spec refusals exit 1 and write nothing, before the checkout lock, repo
  validation, or any artifacts dir exists (the T-007 CLI-refusal pattern):
  each bad spec is refused through the real CLI with a non-git `--repo`, so
  the jobs refusal winning over the repo error proves the ordering, and the
  run root stays empty (no artifacts dir, no `locks/` directory) across all
  refusal cases; `--help` documents `--jobs <path>`.

T-031's flip, recorded — this change-set's only intentional invalidations
of existing assertions: Gate 1.10's G2 leg actively pinned `earlyStop` as
refused ("approvalGate and earlyStop are refused until their successor
tickets land"), and the S7 fixture table carried the
`['phase earlyStop', …, "unknown field 'earlyStop'"]` entry. The early-stop
policy now exists (this IS the successor ticket T-009:127-129 and
T-030:83-86 carved for), so both were flipped explicitly in T-031's
change-set: the refusal face became approvalGate-only PLUS the new
earlyStop positive/negative coverage (the parse face preserving
`{ minSurvivors }` verbatim plus the strict shape refusals), and the
fixture-table entry was replaced by the five earlyStop refusal cases
(non-object, missing/non-integer/zero `minSurvivors`, unknown sub-field).
Net strictness increases (a refusal loosened in one dimension, that
dimension now positively exercised — the T-018/T-019 precedent); no other
existing check was weakened. VERIFICATION.md's own Gate 1.10 prose (the
unknown-fields bullet and the carve paragraph below) updated in the same
change.

Not pinned here and carved by the ticket: completion policies beyond `all`
(quorum, all-machine-gates, at-least-n — no requeue/elimination semantics
defined), `approvalGate` in the spec (still refused as an unknown field —
its own M8 successor has not landed), run-level and generation-loop stop
conditions (spec §20's token/wall-clock ceilings and
consecutive-generations-no-new-survivor — T-031 ships exactly ONE
condition, the phase-level `minSurvivors`; the rounds structure is the
generation-loop extension point), no `--stop`/`--min-survivors` CLI flag
(in default `--goal` mode nothing could bind: the synthesized degenerate
spec carries no policy and `--concurrency` defaults to the candidate count,
so the whole wave dispatches in the loop's first iteration — the lever
exists only where dispatch is staggered), `phases.early_stop_json`'s
producer (the record rides the report block — the rounds store-invisible
precedent; the column's producer is a later ticket), in-run approval pause
and restart reconciliation
(§29, the T-007/T-008 carves stand), live in-run event emission (ingest
stays post-hoc and derived), and any adapter change (`src/worker/opencode.ts`
untouched; Gate 3 n/a). The real-harness face of the rewritten loop is
pinned once at landing by a real `npm run verify:full` (recorded in T-009's
Landed section) — not a permanent Gate 2 extension.

## Gate 1.11 — startup reconciliation (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-recovery.mjs
```

Pins T-010: the in-run evidence producer recovery consumes, and the
standalone `npm run recover -- --run <runId> [--db <path>] [--run-root
<path>] [--force-lock]` (src/recover.ts, the clean/integrate standalone
pattern) that reconciles a run the orchestrator died in — marks + kills +
inspection + disposition, and it NEVER reruns anything (no lease, no worker,
no scheduling; recovery.json has no consumer this slice — the resume
scheduler is its own successor ticket).

The evidence producer is `<runDir>/dispatch.jsonl` (written by runSkeleton,
src/runner.ts): a `run` header line
(`{type:'run', runId, repo, baseSha, goal, model, maxAttempts, startedAt}`),
one `dispatch` line per attempt
(`{type:'dispatch', jobId, attempt, leaseId, branch, worktreePath,
startedAt}`), one `pid` line per attempt as soon as the adapter knows its
root pid (`{type:'pid', jobId, attempt, pid, at}` — engine-supplied
`WorkerExecutionRequest.onSpawn`, called by an adapter once, right after
spawn), and one `completion` line per adapter-resolved attempt
(`{type:'completion', jobId, attempt, ok, timedOut, exitCode, diffBytes,
endedAt}` — a thrown attempt gets none, so recovery conservatively treats it
as recorded-running and can still kill its recorded pid; `diffBytes` is null
when the capture failed, so absent evidence is never readable as the
machine-answered zero-byte NO-OP verdict). Best-effort
appends that can never break a run (the adapter's appendLog posture); part
of the run's evidence set, never deleted, structurally ignored by `clean`.
`WorkerResult.pid` carries the same pid for the completion record. The store
is post-hoc only, so a hard-killed run leaves partial evidence instead of
zero DB rows.

**Wall-clock scoping of the determinism rule — documented, not discovered
(the T-008 precedent):** abandonment stamps are primary recovery facts no
report carries — the report was never written, the run died — so the
attempts rows and `ATTEMPT_ABANDONED` events written by
`recordAbandonedAttempts` (the second DB writer, src/store/index.ts) are
legitimately wall-clock stamped (`started_at` from the dispatch evidence,
the abandonment stamp from the moment of recovery). The determinism rule
continues to govern everything report-derived: `ingest` is untouched and
stays a pure function of the report (Gate 1.6 stays green).

The check drives the runner with a **fake `WorkerAdapter`** (the
src/types.ts seam; the Gate 1.8/1.10 pattern) whose real child is a spawned
node sleeper, and builds the kill-mid-run scenario for real: a subprocess
"orchestrator" (tsx + runSkeleton, holding the T-004 checkout lock the way
src/cli.ts does) is killed **by pid only** (`taskkill /F`, no `/T`),
leaving a real orphaned worker (spawned detached, since node binds
non-detached children to the parent's lifetime on Windows), a stale lock,
and zero DB rows — exactly the spec §15.2 shape. All process assertions run
against the real process table, never a mock. It asserts:

- **evidence**: every run writes dispatch.jsonl with the four line shapes
  above (pid recorded through onSpawn before any hang, dispatch before pid
  before completion, completion carrying the captured diffBytes); a
  completed run's exit code, stdout verdict lines, and report.json are
  unchanged (the T-009 default-mode assertions stay green in Gate 1.10);
- **the lock refusal**: the crashed run is refused by `recover` without
  `--force-lock` — exit 1 naming the holder pid and lock path, and nothing
  written (no recovery.json, no DB file, the orphan still alive);
- **the kill, verified**: with `--force-lock`, recover proceeds, releases
  the lock on every path (no residual `.lock` files — including a
  `recovery.json` write failure, which is recorded and exits non-zero after
  the release), and the recorded
  orphan is identity-verified live (creation time inside the dispatch
  evidence window — Windows reuses pids; §15.2:1071 applies symmetrically to
  killing) and then actually dead;
- **durable abandonment marks**: the un-completed attempt becomes exactly
  one `attempts` row (state `abandoned`, failure reason `abandoned`,
  `process_identity` = `{pid, startedAt, leaseId, branch}` from the dispatch
  record, `started_at` from the dispatch stamp) plus exactly one
  `ATTEMPT_ABANDONED` event; the completed attempt of the same killed run is
  NOT fabricated into the store; `runs`/`candidates` stay empty;
  `PRAGMA integrity_check` returns `ok`;
- **verify-before-kill never blindly kills** (§15.3:1080): a recorded-but-
  dead pid (`pid-not-alive`), a dispatch with no recorded pid
  (`no-pid-recorded`), and a live pid outside the evidence window
  (`identity-mismatch` — by construction: a backdated dispatch record naming
  the live gate process) are each reported as cleanup failures with no kill
  attempt, the command exits non-zero, the marks still land, and the lock
  file's (dead) orchestrator pid is never consulted;
- **workspace inspection is report-only**: every worktree under `wt/` (plus
  the dispatch records' paths, with the no-report.json fallback) is listed
  with branch and dirty state, and worktrees, branches, logs, diffs, and
  dispatch.jsonl are byte-identical afterwards — no disposal happened (Gate
  1.5 pins clean's own semantics);
- **retry disposition from dispatch records only**: completion `ok` +
  `diffBytes` exactly 0 ⇒ terminal `no-op` (a machine verdict is never
  re-rolled); `ok` + `diffBytes` null (a failed capture) is NOT a verdict
  and falls through to retryable;
  attempts used ≥ the dispatch header's maxAttempts ⇒ terminal
  `bound-exhausted`; everything else (never completed, `!ok`, timedOut, or
  completed with a diff but no durably recorded verdict) ⇒ `retryable` while
  the bound allows — pinned across the real kill-mid-run scenario at
  maxAttempts 1 and 2, and synthetic evidence;
- **refusals exit non-zero and write nothing**: missing `--run`, unknown
  run dir, a finished run (report.json present), an already-reconciled run
  (recovery.json present — a second recover names it, and appends no
  events);
- **a pre-T-010 crash** (no dispatch.jsonl) reconciles inspection-only:
  exit 0, workspaces listed, nothing marked, no DB created, and the report
  records the note;
- **recovery never reruns**: no new worktree, no new branch, dispatch.jsonl
  byte-identical, and recovery.json is the only new artifact.

Not pinned here and carved by the ticket: resume scheduling / rerunning
(the "run continues correctly after restart" half of §35 — recovery.json has
no consumer until the successor ticket), §29 steps 6/8 (artifact/hash
validation, waiting-approvals preservation — needs T-008's records), the §27
`workspace_leases` table and §16 lease GC, adoption of process or worktree
state (any future rerun is a fresh lease), and Windows Job Objects (§15.3
"Later" — `killTree`'s `taskkill /T /F` stays). Gate 2 runs once at landing
(`src/runner.ts` is on the trigger list), recorded in T-010's Landed section
— not a permanent extension. Gate 3 runs once at landing (adapter change:
`onSpawn` + `WorkerResult.pid`).

## Gate 1.12 — process-tree termination hardening (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-kill-tree.mjs
```

Pins T-011 (spec §15.3's MVP contract: Windows tree termination, verify
descendants disappear, remaining descendants are cleanup failures):
`src/kill-tree.ts`'s `killTreeVerified(pid)` — alive check first (an
already-gone root is a *reported result* `{rootWasLive: false, verified:
false}`, never a swallowed error — the pre-T-011 silent catch is removed), a
fixed-constant PowerShell CIM snapshot of the pid→ppid map taken BEFORE the
kill (list-form `powershell.exe -NoProfile -NonInteractive -Command
<constant>` — zero interpolation, so the list-form rule holds trivially), the
verbatim list-form `taskkill /pid <pid> /T /F`, then a post-kill
`process.kill(pid, 0)` sweep over the root plus every snapshot pid. Scope is
descendants visible at snapshot time: the narrow snapshot-to-kill race is
documented, false survivors via pid reuse are acceptable — the failure
direction is loud, not silent — and the race-free mechanism stays Windows Job
Objects "Later" (spec §15.3:1084, decisions.md 2026-10-10).

Two consumers changed shape, both pinned here:

- `src/gate/command.ts` owns its timeout: exec's built-in `timeout` option is
  gone (it killed only the direct shell child and orphaned the subtree — the
  recorded red bar: grandparent AND grandchild alive after an exec timeout).
  At expiry `killTreeVerified(child.pid)` fires while the shell child lives;
  unproven kill outcomes land on the new `GateResult.cleanupFailures`.
  Timeout FAIL semantics are byte-identical to the exec-timeout shape:
  `passed: false`, `exitCode: null` (a killed shell carries no meaningful
  numeric code), `durationMs ≥ timeoutMs`, `outputTail` as collected.
- `src/worker/run-with-timeout.ts` (new) is the harness-agnostic core of a
  timed worker run — drain to the log, wait for exit, verified tree kill at
  expiry, the outcome appended to the log (never asserted):
  `tree killed, verified: N processes reaped` on success, loud
  `CLEANUP FAIL: pid N survived taskkill /T /F` /
  `CLEANUP FAIL: root pid N already gone before kill; descendant verification
  impossible` lines otherwise, returning `{timedOut, exitCode,
  cleanupFailures}`. `OpenCodeWorker` keeps only the harness specifics (bin
  path, `run -m <model>` args, the PWD/OLDPWD pinning — untouched, ground
  rule 5). The runner aggregates worker-side + gate-side failures onto the
  candidate's report entry (`CandidateReport.cleanupFailures` — report.json's
  one place answering "did anything survive"); the fields are absent on every
  non-timeout path, the store's explicit column selects are untouched, and a
  cleanup failure never changes any verdict (decisions.md: gates decide
  survival).

The check plants real node process trees and asserts on the real process
table — `process.kill(pid, 0)` — never a mock; zero model tokens, no git, no
opencode binary:

- **S1** — tiny-timeout `CommandGate` against a grandchild-spawning node
  command: `passed: false`, `exitCode: null`, `durationMs ≥ timeoutMs`, no
  cleanup failures, and every script-tracked pid dead (the red-bar shape:
  both pids the check spawned and tracked).
- **S2** — normally-completing gates (passing AND failing) are unchanged:
  today's GateResult shape, no `cleanupFailures` key on any non-timeout path;
  source-level pin that the exec options stay
  `windowsHide`/`cwd`/`encoding`/`maxBuffer` and the built-in `timeout`
  option is gone.
- **S3** — `killTreeVerified` on an already-gone pid returns
  `{rootWasLive: false, verified: false, survivors: []}` as a reported
  result — no throw, no silence (the removed-catch regression pin).
- **S4** — `runChildWithTimeout` on a node tree with a tiny timeout:
  `timedOut: true`, the whole tree dead, the log carries
  `tree killed, verified: N processes reaped` plus the drained child stdout,
  and no `CLEANUP FAIL` — driven with no opencode involvement.
- **S5** — snapshot-depth sanity: the pre-kill enumeration of a planted
  3-level tree contains mid and leaf, and the verified kill returns
  `{rootWasLive: true, verified: true, survivors: []}` with all three pids
  dead.

The check sweeps everything it planted best-effort at the end (AGENTS.md #10
mechanized for its own spawns) and its throwaway sandbox under `C:\swarm\`
is removed afterward.

## Gate 1.13 — context system core (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-context.mjs
```

Pins T-012 (the first Milestone-2 slice, spec §34:2035-2047 minus shard
distillation and source lineage — T-013 has since landed the
distillation-contract half in `src/context.ts` and flipped this gate's two
time-boxed assertions, noted below, and T-014 has since landed the
source-lineage half and corrected this gate's T-013-added strict
round-trip fixture at preserved assertion strength, noted in Gate 1.14):
the pure context module (`src/context.ts`
— no I/O, no model knowledge, zero npm dependencies, `node:crypto` sha256
only) and the read-only inspector CLI (`npm run context -- --plan <path>
--packet <path> [--json] [--run-root <path>]`, `src/context-inspect.ts` —
the clean/integrate/dag standalone pattern). **Zero behavior change to the
pipeline**: nothing in `src/runner.ts`, the `RunReport`, the adapters, or
the gate code produces or consumes a packet after this slice, so context
selection can never influence promotion or elimination (decisions.md:
gates decide survival) — honored by construction. No existing gate can pin
any context criterion — the fast tier never runs the pipeline and Gate 2
spends model tokens and cannot assert on synthetic packets (the
T-007/T-009 argument) — so this gate drives the pure functions directly
and the CLI as a list-form subprocess over **hand-built plan + artifact
fixtures** (the Gate 0.5 `check-parse.mjs` pattern: no artifact store
exists to produce inputs, §34:2028 is the unclaimed Milestone-1 build
item). It asserts:

- **ContextPlan parsing** (`parseContextPlan`, refusals as `ContextRefusal`
  naming the offense, before anything is built): a valid plan parses;
  unknown plan fields, `maxInputTokens ≤ 0`, a selector outside the
  §7.6:593-605 vocabulary, a query naming no known selector field, and bad
  enum values (`gateStatus`/`layer`/`orderBy`/`limit`/`sourceReferencePolicy`)
  are each refused; parse normalization is key-order independent (same
  planHash). **Time-box expired by T-013:** the retired sentence — "a
  present `distillation` block (refused, never silently ignored, until the
  §7.3-7.5 slice defines builder semantics)" — named this ticket as its
  expiry. Its two time-boxed assertions were replaced in the same
  change-set by strictly stronger coverage (no assertion weakened, removed
  without replacement): a valid block parses with all fields intact while
  an unknown sub-field inside the block is still refused naming it, and —
  at the CLI — a plan carrying a valid block inspects exit 0 while an
  invalid block still exits non-zero with no body. All other assertions
  untouched and green, including the Layer-3 pass-through/budget fixtures,
  which ride plans without a block.
- **Determinism**: two builds from identical plan + artifact inputs give
  byte-identical packet JSON and the same fingerprint; input array order
  never matters (base canon is id-ascending).
- **Layer 1** is always present and never trimmed (§7.2:516-518): a plan
  whose mandatory layer alone exceeds `maxInputTokens` is refused as
  unsatisfiable; exactly filling the cap is satisfiable, with everything
  else excluded-by-budget.
- **Budget + manifest**: Layer 2 primary rules apply in plan order with the
  documented ordering (`timestamp-desc` newest-first with id-ascending
  tie-break; default id-ascending; `limit` after ordering); Layer 3
  distilled pass-through; Layer 4 supporting fills the budget remainder —
  an inclusion that would overflow the cap is skipped (the scan continues,
  so a later smaller candidate may still fit) and lands `excluded-by-budget`;
  plan `exclusions` remove before any selection (a poison artifact matching
  a primary rule never enters a layer, recorded `excluded-by-plan`); every
  input artifact appears in the manifest exactly once with reason
  `excluded-by-plan`/`excluded-by-budget` — nothing silent (§7.2:544).
- **Selectors**: each deterministic §7.6:593-605 kind (type, candidate,
  phase, producer role, machine gate status, lineage membership, timestamp,
  explicit ID, tag) returns exactly the matching artifacts on hand-built
  sets; conjunctions require every named field; absent attributes never
  match; timestamps compare lexicographically (pinned on
  `2026-9-16` vs `2026-10-01`, which sort opposite to their chronological
  order — no Date parsing, no wall clock). There is no semantic selector
  and no hook for one.
- **Layer 3**: a sourceRefs carrier is Layer-3 class even when a rule names
  its type (never visible to L2/L4 selection), passes its §7.4:567-576
  source refs through onto the packet entry, and is excluded-by-budget when
  it cannot fit.
- **Fingerprint (§7.7 narrowed)**: sha256 over the canonical JSON of
  `{ model, planHash, selected }` (selected ids/hashes in packet order) —
  identical inputs → identical hash; changing one selected artifact's
  contentHash, the selection set, the model string, or any plan field
  (planHash — even with identical inclusions) yields a different hash; a
  different `jobId` yields the identical hash (jobId is recorded, never
  fingerprinted); the four producerless components
  (`promptVersion`/`roleVersion`/`reasoningConfiguration`/
  `projectManifestVersion`) are recorded null.
- **Inspector happy path**: exit 0 rendering the §26.4:1748-1756 fields —
  token budget (cap + per-layer ledger + total), per-layer included
  artifacts, excluded artifacts with reasons, L3 source chains, context
  fingerprint with `no-producer` components, the job id; `--json` emits the
  same structure as JSON; relative `--plan`/`--packet` paths resolve
  against `--run-root` (default `C:\swarm`, decisions.md run root).
- **Inspector refusals** exit non-zero and print no body: missing
  `--plan`/`--packet`, missing files, unparseable JSON, plan parse refusals
  surfaced through the CLI, a packet whose recorded ledger is inconsistent
  with recomputation (per-layer or total, or recorded cap ≠ plan's
  `maxInputTokens`), a recorded total over cap, a fingerprint whose
  components diverge from the packet's included entries, a plan-hash
  mismatch on recompute, a fingerprint-hash mismatch on recompute, and
  shape violations (non-array layer; a Layer-3 entry without `sourceRefs`).
- **The inspector never writes**: plan and packet files are byte-identical
  (sha256 before/after) across successful and refused inspects.

Not pinned here and carved by the ticket: packet→prompt composition —
**consumed by T-030**: `src/rounds.ts` (the bounded R&D loop's composer) is
the packet's first pipeline consumer, owing and delivering exactly what this
carve named (its change-set's Gate 2 run is mandated — see Gate 2's section —
and the fingerprint reconciliation with T-007's `input_context_hash` is
documented in src/rounds.ts's header and pinned by Gate 1.22); the
`context_plans`/`context_packets` store tables (§27:1826-1827 — needs
T-006's landed store plus a pipeline producer; T-030's composer is in-run
evidence, not a store producer — the tables stay reserved, T-016:78-80), the
§7.3-7.5 pipeline
distiller stage (the record/contract level — `DistillationPlan`
semantics, distilled-claim records, the §7.5 rule-1 validator, and since
T-014 the packet-level lineage enforcement and multi-hop chain resolution
of §7.5 rules 2-3 — is pinned by Gate 1.14; the pipeline stage that
produces and consumes them is carved and owns its own Gate 2 run), the
artifact store itself, the full §7.7 fingerprint
(the four producerless components stay null), and the §26.4 UI (the CLI
is the token-free precursor, as the dag dump is §26.2's). Gate 2 is not
required and not run: the slice touches none of Gate 2's triggers — it
adds `src/context.ts`, `src/context-inspect.ts`, and
`scripts/check-context.mjs` plus one package.json script, and changes no
pipeline file. Gate 3 n/a (no adapter; the model enters only as the
fingerprint's CLI/config string).

## Gate 1.14 — shard distillation core + packet source lineage (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-distillation.mjs
```

Pins T-013 (the second contract-level slice of Milestone 2, spec
§34:2035-2047): the shard-distillation contract T-012 reserved —
`DistillationPlan` (§7.1:507, the type the spec uses but never defines;
chosen here and documented), `parseDistillationReport` (§23.2:1358-1381,
the enforcement point §7.5 rule 1 has at the record level), the builder's
plan-level untraceable-chain refusal, and planHash coverage of the block.
**Zero behavior change to the pipeline** — nothing in `src/runner.ts`,
`src/scheduler.ts`, the adapters, the gate code, or the store produces or
consumes a distilled claim after this slice; a distiller is advisory
compression, honored by construction (decisions.md: gates decide survival,
models advise — the T-012 posture). Like Gate 1.13, it drives the pure
functions directly plus the inspector CLI as a list-form subprocess over
**hand-built fixtures** (no artifact store exists to produce inputs,
§34:2028). Zero model tokens. It asserts:

- **`DistillationPlan` parsing**: a valid block parses with
  `expectedArtifactIds` intact — through `parseContextPlan` and the
  exported `parseDistillationPlan` sub-parse alike; non-object blocks,
  unknown sub-fields (refuse-don't-ignore, the T-009 unknown-field
  posture), a non-array or empty `expectedArtifactIds`, non-string/empty
  entries, and duplicate entries are each refused naming the offense.
- **`parseDistillationReport`**: the §23.2:1358-1381 example — adapted to
  the pinned §7.4:565-578 prefixed-ref form, which reconciles the
  documented spec divergence (§23.2:1371-1377's bare `id#anchor` is
  refused) — parses with camelCase normalization
  (`sourceArtifacts`/`claims[].sourceRefs`/`disagreementRefs`);
  `claims: []` is valid (a distiller that found nothing worth claiming
  still produces the record — documented choice); `disagreement_refs` is
  optional but validated and resolved exactly like `source_refs`; anchors
  are opaque and never resolved (no store, §34:2028 — format +
  declared-input-set resolution only). Every refusal names its offense,
  and claim-level ones name the claim id: unknown fields at either level,
  a missing/non-string/empty claim id, duplicate claim ids, an empty
  `statement`, missing/empty `source_refs`, malformed refs (anything not
  exactly `artifact:<id>#<anchor>` — a missing or doubled `#`, an empty id
  or anchor, a non-string entry — and the bare `id#anchor` spelling
  explicitly), empty/non-string `source_artifacts`, and any
  `source_refs`/`disagreement_refs` entry whose `<id>` is not in the
  report's declared `source_artifacts`.
- **Builder integration**: with a `distillation` block present, an
  undeclared Layer-3-class record is refused naming its id — both when it
  would fit and when it would be `excluded-by-budget` (the declaration
  check precedes the budget test, so budget-luck never hides a provenance
  violation; the counterfactual is pinned: the same record under the same
  tight cap rides `excluded-by-budget` when no block is present); a
  declared entry is admitted with ledger and manifest identical to the
  blockless build; declared-but-absent is not a refusal (the builder
  refuses what arrived untraceable, not what didn't arrive); a
  Layer-3-class record captured by Layer 1 is still a declaration-check
  target — every Layer-3-class record the builder sees.
- **Blockless plans ride unchanged**: a plan without the block builds
  byte-identically to the pre-change fixture output — pinned as a
  byte-for-byte snapshot (plans carrying `distillation` were refused
  outright before this slice, so every previously-valid plan input is
  untouched — the T-012:94-100 narrowed-hash stability argument, verbatim).
- **planHash sensitivity**: a plan carrying the block hashes differently
  from the same plan without it; different `expectedArtifactIds` hash
  differently; the block changes the fingerprint through the planHash even
  with identical inclusions.
- **CLI round-trip**: a plan carrying a valid block, with a packet built
  from that parsed plan, inspects exit 0 (the CLI parses via
  `parseContextPlan` and recomputes `planHashOf` — no CLI change needed);
  a plan carrying an invalid block exits non-zero with no body.

**Packet source lineage (T-014 — the third and final contract-level slice
of Milestone 2, extending this gate in place, completing the build list of
spec §34:2035-2047):** the builder-input lineage enforcement, per-ref
resolution recording, and claim-chain inspection that T-013 explicitly
carved (its pre-authorized follow-up). Opt-in, keyed to the
`distillation` block — **a locked decision, documented in
`src/context.ts`'s module header**: a blockless plan has no declared-input
contract to enforce against (`expectedArtifactIds` is the block's own
field), tightening would flip previously-valid inputs (Gate 1.13's
blockless fixtures ride dead-ref pass-through by design), and no pipeline
builds strict packets yet, so default-on buys nothing today; a future
change-set may tighten and must do so by explicitly flipping those gate
fixtures — a decision to be made, not an omission. A blockless plan builds
byte-identically to its pre-T-014 output and carries no resolution field.
The gate asserts:

- **builder ref enforcement** (strict mode only): a Layer-3-class record
  whose `sourceRefs` carry a malformed entry — the bare §23.2:1371-1377
  `id#anchor` spelling, a missing anchor, a doubled `#` — or a ref whose
  `<id>` is not in the build's input set (the canon of input artifact ids,
  every disposition, not just inclusions) is refused naming the record id
  and the dead/malformed ref, both when the record would fit and when it
  would be `excluded-by-budget` (the checks sit in the Layer-3 pass-through
  scan before the budget test inside `include`, mirroring T-013's
  declaration-before-budget order; the counterfactual is pinned: the same
  dead-ref record at the same tight cap rides `excluded-by-budget`
  unchecked without the block); a declared Layer-3-class record captured by
  Layer 1 is still a check target — every Layer-3-class record the builder
  sees; plan-excluded records never reach the scan and are recorded
  `excluded-by-plan` (the builder refuses what arrived untraceable, not
  what didn't arrive); anchors are not resolved (no store, §34:2028); the
  format predicate is T-013's single `parseSourceRef`, exported and
  reused — never a second divergent copy;
- **per-ref resolution recording**: a resolving strict build is admitted,
  and each included Layer-3 entry carries `sourceRefResolutions` — the
  `{ ref, disposition }` shape, one per `sourceRefs` entry, the field name
  chosen at implementation and pinned here — with all three dispositions
  exercised (`included`; a ref naming an `excluded-by-plan` input
  recording exactly that; a ref naming an `excluded-by-budget` input
  likewise, agreeing with the manifest); two Layer-3 records citing each
  other build fine, and so does self-citation (resolution is against the
  input id set, so cycles build; termination is the render's duty); the
  field rides the entry, never the fingerprint (`selected` stays
  `{id, contentHash}` in packet order, recomputed hash equals the recorded
  hash), and two strict builds from identical inputs stay byte-identical;
- **claim-chain rendering** (the inspector; no new CLI flags): a new
  `source chains (lineage):` text section and a new `--json`
  `lineageChains` field render, per distilled entry, every sourceRef with
  its status — `included (layer N)` / `excluded-by-plan` /
  `excluded-by-budget` — expanded transitively through included Layer-3
  entries of the packet, depth-labeled and cycle-safe (a visited-set
  renders a revisit, self-reference included, as the terminated marker
  `↺ <id>`); the existing one-hop `sources:` line and the `--json`
  `sourceChains` shape are untouched (Gate 1.13 pins both); statuses come
  from the recorded `sourceRefResolutions` in strict mode and are computed
  at render time against the manifest in blockless mode, where a dead ref
  renders `unresolved` and does NOT refuse — the blockless builder
  verbatim-copies refs and never promised resolution (the keying that
  keeps Gate 1.13's `research-003`-refs fixtures green untouched);
- **strict-keyed inspector refusals** (exit non-zero, no body, naming the
  offense; blockless stays exit-0): when the plan carries the block, a
  Layer-3 entry missing `sourceRefResolutions`, a recorded ref that is
  malformed (the shared `parseSourceRef`), absent from the entry's
  `sourceRefs`, or dead against the manifest (an id in neither the
  manifest nor the packet layers — tamper evidence, since a strict build
  refuses dead refs and can never record one), or a recorded disposition
  disagreeing with the manifest is each refused; the read-only sha256
  proof covers the strict and blockless inspects alike (plan and packet
  byte-identical after every successful and refused inspect).

T-014 also corrected T-013's landed strict-mode fixtures whose refs did
not resolve into their input sets (the ticket's provision, AGENTS.md #8):
`dist-a` in the distillation fixtures now cites `artifact:note-b#obs-1`
(ref value only — ids, hashes, sizes, contents untouched; the byte-for-byte
blockless snapshot was re-pinned on exactly its `sourceRefs` line, whose
planHash/fingerprint lines are ref-blind and byte-identical to the T-013
pin), and Gate 1.13's T-013-added strict round-trip fixture rides a
dedicated `distilled-strict` artifact citing included Layer-1 inputs,
sized to the same 25 tokens its assertions pin — zero assertion text
changed anywhere; every blockless fixture (including `research-003`'s
dead-ref pass-through) is untouched.

Not pinned here and carved by the ticket: the pipeline distiller stage
(§7.3:546-563 — jobs still cannot receive artifacts: `inputArtifacts`/
`contextPlan`/`role` remain refused job-spec fields, `src/scheduler.ts:153`,
and dependencies gate dispatch order only, `src/runner.ts:173-189`), real
anchor resolution (§7.4:565-578 — still unimplemented; T-016's artifact
store makes artifact rows and content hashes exist and checkable, but
resolves no anchors), the `artifact_lineage`/`context_plans`/
`context_packets` store tables (§27:1825-1827 — still no pipeline
producer; `artifacts`/`probe_runs` landed with T-016, pinned by the
extended Gate 1.6 and Gate 1.16),
§7.5 rule 4 ("show source chain" is Milestone-7 UI — the inspector's
lineage render stays the token-free precursor), and any advisory-ness
change. Gate 2 is not required and not run: neither slice touches any of
Gate 2's triggers — no `src/runner.ts`, no adapter, no gate code, no
workspace handling, no report-shape change (everything lives in
`src/context.ts`, `src/context-inspect.ts`, `scripts/check-context.mjs`,
`scripts/check-distillation.mjs`, the hook block in `scripts/verify.mjs`,
and docs). Gate 3 n/a (no adapter; the model enters only as a CLI/config
string).

## Gate 1.15 — probe layer first slice (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-probe.mjs
```

Pins T-015 (the first slice of Milestone 4, spec §34:2061-2072): the Probe
seam and the structured probe-output contract (§12.2) in `src/probe.ts`, the
generic probes — `CommandProbe` (exit-0 evidence probe; parses nothing),
`TestProbe` (parses TAP into tests/pass/fail measurements), and, since
T-018, `BenchmarkProbe` (the first Measurement producer: a repeated measured
command recording quantitative durations), and, since T-019,
`ScreenshotProbe` (the first directly human-reviewable evidence: a capture
command whose PNG is copied under the run artifacts dir), and, since T-024,
`WebProbe` (the first launch-without-awaiting-exit lifecycle: a long-running
server target launched, readiness-polled, HTTP-captured, and
verified-torn-down under one timeout budget), and, since T-032,
`AdversarialProbe` (the first probe whose evidence is about generated
inputs: `ADVERSARIAL_PROBE_CASE_COUNT` seeded, replayable fuzz cases fed
over argv, each case's crash/survival recorded — a crash list recomputable
from the seed alone) — the bundle
validator, the
evidence writer, and the minimal `--jobs` wiring. The seam
module's docblock chooses and documents the vocabulary the spec uses but
never defines (`ScenarioSpec`/`EnvironmentSpec`/`Measurement`/
`EvidenceBundle`) and states the three reconciliations: the
`EvidenceArtifactRef` rename vs the context system's landed `ArtifactRef`
(src/context.ts — probe.ts never imports context.ts), the `WorkspaceLease`
binding vs §16:1114-1123's lease shape, and the command-vs-test split.
Probes produce evidence; survival still belongs to machine gates
(decisions.md 2026-10-10) — by construction the verdict ladder
(`src/runner.ts`, `passedAllGates = gates.length > 0 && every passed &&
diffBytes > 0`) is byte-identical and a probe result, including a
success:false bundle, never enters any verdict. No new CLI flags: probes
attach via the `--jobs` spec's per-job `probes` array
(`{id, type: "command"|"test"|"benchmark"|"screenshot"|"web"|"adversarial", command: {exe,
args}, timeoutMs?, repeats?, capture?, url?, seed?}` — `repeats` is required positive
integer ≥ 1 on a benchmark
probe and refused on command/test/screenshot/web/adversarial probes, the field existing only where it
means something; `capture` is required non-empty workspace-relative on a
screenshot probe (absolute paths and `..` segments refused — the evidence
contract stays local to the disposable workspace; the durable copy is the
probe's job) and refused on command/test/benchmark/web/adversarial probes; `url` is
required non-empty http(s) on a web probe and refused on
command/test/benchmark/screenshot/adversarial probes (T-024 — the one probe field
pointing outside the workspace, its operator-chosen port machine-global);
`seed` is required positive integer ≥ 1 on an adversarial probe and refused
on command/test/benchmark/screenshot/web probes (T-032 — a fuzz run with no
seed is not replayable, so it is not an adversarial probe);
ids match
the job-id charset because they name evidence files; default timeout 5 min,
the CommandGate default, a PER-REPEAT budget on a benchmark, a
WHOLE-LIFECYCLE budget (launch → readiness poll → capture → teardown) on a
web probe, and a PER-CASE budget on an adversarial (total wall time bounded
by case count × timeoutMs)); default
`--goal` mode has none, so default-mode
reports are unchanged. Zero new npm dependencies; every probe subprocess is
list-form `spawn` (never `exec`) with the T-011 verified tree kill at
timeout — unproven kill outcomes land on the bundle's GateResult
`cleanupFailures`, evidence only. T-019's screenshot semantics (the spec
defines no Screenshot Probe; §6.8:479 names `screenshot` only as an
artifact example): PNG-only this slice, success = the capture command
exited 0 AND the `capture` file exists in the workspace AND is ≥ 33 bytes
(`MIN_PNG_BYTES` — the smallest syntactically-possible PNG: 8-byte
signature + one 25-byte IHDR chunk) AND starts with the 8-byte PNG
signature; a zero-byte, missing, truncated, or non-PNG capture is
success:false, never a pass (AGENTS.md #7 applied to image evidence); on
success the image is COPIED to
`<artifactsDir>/probes/<candidateId>/<probeId>.png` and referenced as a
kind-`'screenshot'` artifact (the workspace is disposed right after the
attempt loop — the durable copy is structural); measurements `capture
duration` (ms, whenever the command actually ran) and `image bytes`
(bytes, whenever the capture file exists — even on failure faces); no
target lifecycle — launch, timing, and readiness are encapsulated inside
the operator's capture command; dimensions and pixel-content assertions are
successor slices. T-024's web/server semantics (the spec defines NO
server-lifecycle probe anywhere — §12.1:925-935's "Web Probe" is browser
automation): the scenario carries `url`, a required non-empty http(s) URL —
the address the probe polls for readiness and captures, and the one
ScenarioSpec field pointing outside the workspace (absolute by nature; its
operator-chosen port is machine-global — two concurrently-running probes
aimed at one port collide; no ephemeral-port scheme this slice). The
lifecycle is launch WITHOUT awaiting exit beside the run-to-completion
`executeProbeCommand` core: `launchTarget` spawns the scenario command in
the workspace (list-form, `windowsHide`, refusal recorded never thrown) and
returns the live child; a bounded readiness poll (stdlib global `fetch`,
zero new dependencies; `WEB_PROBE_POLL_INTERVAL_MS` = 250 between attempts;
each attempt aborted at the deadline) runs until the first poll response
that CONNECTS — that response IS the capture (status read; body read capped
at `WEB_PROBE_MAX_BODY_BYTES` = 1 MiB, the bytes actually read recorded;
the artifact's `bodySnippet` further bounded at `WEB_PROBE_SNIPPET_BYTES` =
2048 bytes of the UTF-8-decoded read) — or a face ends the poll first:
spawn refusal, the target exiting before readiness (fail-fast, the exit
named), or deadline expiry (the last poll error named, e.g. connection
refused). Teardown is the T-011 `killTreeVerified` on EVERY path while the
target is live — after the capture, after every failure face, at deadline
expiry; unproven kill outcomes land on the GateResult `cleanupFailures`
(evidence only); nothing-to-kill (spawn refusal, target already exited) is
recorded honestly, never fabricated, and a just-exited pid is never
taskkilled (the `executeProbeCommand` boundary rule — pid reuse). Success =
target launched AND `url` ready within the deadline AND the captured
response is 2xx AND its body non-empty; `error` names the first failed face
(spawn refused / target exited before readiness / readiness deadline
expired / non-2xx status / empty body); a probe that captured no response
is success:false, never a pass (AGENTS.md #7 applied to bundles). No
threshold/assertion field of any kind — 2xx + non-empty body is the
documented evidence shape; the probe records, never judges; a success:false
web bundle changes nothing downstream. Measurements (recorded whenever
their face applies): `http status` (the captured status code), `body bytes`
(bytes — what the capped read actually read), `ready duration` (ms — launch
to the first connected response, recorded whenever readiness was reached,
even on later failure faces). Artifacts: the standard `.log` (launch banner
+ poll attempts + child output + capture/teardown outcome) plus
`<probeId>.response.json`, kind `'report'` (the kind's second producer:
`{url, status, contentType?, bodySnippet, bodyBytes}` — the bounded snippet
keeps the file bounded whatever the served body was). T-032's adversarial
semantics (the spec names "adversarial probes" in Milestone-8's add list,
§34:2139, and nowhere defines them — chosen and documented in the
`src/probe.ts` module docblock): the scenario carries `seed`, a required
positive integer ≥ 1 — the input of the exported, pure
`generateAdversarialCases`, which expands it into a byte-identical,
replayable case list of exactly `ADVERSARIAL_PROBE_CASE_COUNT` = 20 cases.
JS has no stdlib seeded PRNG and the zero-new-deps posture (decisions.md
2026-10-10) forbids `seedrandom`, so the module chooses and documents one:
mulberry32, a ~6-line 32-bit integer-math PRNG, driving a documented
case-mix recipe — the seed-independent `ADVERSARIAL_EDGE_CORPUS` (the empty
string; control characters; non-ASCII; numeric edges such as
`'NaN'`/`'Infinity'`/`'1e308'`/`'-0'`; malformed-JSON-looking strings) in
corpus order, then PRNG-driven ASCII-soup strings and corpus permutations
(seeded Fisher-Yates shuffles, first two entries joined with a space) up to
the count. Each case runs SEQUENTIALLY through the unchanged
`executeProbeCommand` core, appended to the scenario command's args (the
core has no stdin — argv-feeding changes nothing shared; stdin is carved),
each with the FULL `timeoutMs` budget. Crash/survival vocabulary: a case
SURVIVES when the target spawned cleanly, exited 0, and did not time out; it
CRASHES when it ran and exited non-zero or timed out; a SPAWN-REFUSED case
produced no run — neither survived nor crashed (a target cannot crash on an
input it never received). Success = the case list non-empty AND every case
spawned cleanly AND every case survived; zero completed cases is
success:false, never a pass (AGENTS.md #7); `error` names the FIRST breaking
case with counts ("case 3/20 exited with code 1" / "case 5/20 timed out
after Nms" / "case 1/20 could not be spawned: ENOENT"). Measurements
recorded regardless of success — evidence about crashes is the point: one
`case-<i> duration` (ms) per case that actually ran, plus `cases-run` and
`cases-crashed` counts (unit `'cases'`). Artifacts: the combined `.log` with
`=== case <i> ===` separators plus `<probeId>.results.json`, kind
`'report'` (the kind's THIRD producer): `{probeId, scenarioId, seed, cases:
[{index, input, outcome, durationMs?}], casesRun, casesCrashed}` with
outcome ∈ survived | crashed-exit | crashed-timeout | spawn-refused and
every input truncated to `ADVERSARIAL_PROBE_MAX_CASE_CHARS` = 8192 — cases
ride argv and Windows bounds a spawned command line (CreateProcess's ~32k
limit), so the constant bounds the probe's contribution with margin (the
operator's base `command` is expected to stay small — documented
limitation). gateResults: one entry per case, in case order, named
`'<probeId>#case-<i>'` (the `'<id>#run-<i>'` precedent) — the crash list is
machine-readable from the failed rows. NO verdict input of any kind: the
pipeline is type-agnostic (`runProbes` iterates `job.probes` with no type
switch; `probe_runs` ingest has no type knowledge; `ProbeRunSummary` is
type-agnostic), and a success:false adversarial bundle changes nothing
downstream — adversarial findings advise the human and the round-2 planner
(the T-030 composer already renders probe summaries into round-2 evidence
with zero composer edits).

T-018's flip, recorded: Gate 1.15's P2 leg previously ACTIVELY PINNED
`type: 'benchmark'` as refused (`type must be "command" or "test"`). The
benchmark probe now exists, so that one assertion was flipped explicitly in
T-018's change-set — the refusal became positive coverage (a benchmark
probe with `repeats` parses and is preserved verbatim) plus refusal of a
genuinely-unknown type with the updated message (net strictness increases,
the T-013 precedent); no other existing check was weakened.

T-019's flips, recorded — this change-set's only intentional invalidations
of existing assertions: (a) Gate 1.15's P2 leg used `type: 'screenshot'` as
its genuinely-unknown example (`type must be "command", "test", or
"benchmark"` — the message T-018's landing left behind). The screenshot
probe now exists, and T-018 having landed first, this second landing
adjusted BOTH the message and the unknown-type example (the ticket's
coordination note): the example became a type still unknown at this landing
(`'godot'`), and the flip gained positive coverage (a screenshot probe with
`capture` parses and is preserved verbatim). (b) Gate 1.15's P1 leg
actively pinned the artifact-kind refusal (`kind must be "log" or
"report"`): the message gained `"screenshot"` and the leg gained positive
coverage (a well-formed bundle carrying a kind-`'screenshot'` artifact
validates — the ScreenshotProbe is that kind's first producer). Net
strictness increases in both flips (refusal loosened in one dimension, that
dimension now positively exercised, the T-013 precedent); no other existing
check was weakened.

T-024's flip, recorded — this change-set's only intentional invalidation of
an existing assertion: Gate 1.15's P2 leg actively pinned the unknown-type
refusal message (`type must be "command", "test", "benchmark", or
"screenshot"` — the message T-019's landing left behind, with `'godot'` as
the unknown-type example since T-019). The web probe now exists, so that one
assertion was flipped explicitly in T-024's change-set: the expected message
became `type must be "command", "test", "benchmark", "screenshot", or "web"`
and `'godot'` stays genuinely unknown and remains the example (only the
message string changed), and the flip gained positive coverage (a web probe
with `url` parses and is preserved verbatim). Net strictness increases (the
T-013 flip precedent); no other existing check was weakened. The P5 drive's
existing per-job probes[] length/order pins were EXTENDED (job-a 4→5
probes, job-b 3→4) to carry the new web probes — coverage added, nothing
weakened (the T-019 label-correction precedent for drive-extending edits).

T-032's flip, recorded — this change-set's only intentional invalidation of
an existing assertion: Gate 1.15's P2 leg actively pinned the unknown-type
refusal message (`type must be "command", "test", "benchmark", "screenshot",
or "web"` — the message T-024's landing left behind, with `'godot'` as the
unknown-type example since T-019). The adversarial probe now exists, so that
one assertion was flipped explicitly in T-032's change-set: the expected
message became `type must be "command", "test", "benchmark", "screenshot",
"web", or "adversarial"` and `'godot'` stays genuinely unknown and remains
the example (only the message string changed — exactly T-024's flip shape),
and the flip gained positive coverage (an adversarial probe with `seed`
parses and is preserved verbatim). Net strictness increases (the T-013 flip
precedent); no other existing check was weakened. The P5 drive's existing
per-job probes[] length/order pins were EXTENDED (job-a 5→6 probes, with the
adversarial probe the FAILING one — a passing-gates/failing-adversarial job
still passes) to carry the new adversarial probe — coverage added, nothing
weakened (the T-024 extension precedent).

No existing gate can pin any probe criterion — Gate 2 is a `--goal`-mode run
that exercises no probe code (probe emission rides `--jobs` runs), so this
gate has three legs, all token-free:

- **contract fixtures** (the Gate 0.5 hand-built-input pattern): the
  validator accepts a well-formed EvidenceBundle and refuses missing
  probeId/scenarioId, non-boolean success, non-array
  artifacts/measurements/gateResults, malformed entries (artifact kind,
  measurement value, gateResult passed/exitCode/durationMs), and non-object
  bundles, each naming the offense; since T-019 the kind refusal reads
  `kind must be "log", "report", or "screenshot"` and a well-formed bundle
  carrying a kind-`'screenshot'` artifact validates (the T-019 P1 flip);
  since T-027 `validateGateResult` also enforces **command, if present, is a
  non-empty string** — a GateResult `command` of `''` and a non-string
  `command` are each refused naming the offense, a well-formed command
  validates and is preserved verbatim, and command-less entries stay valid
  untouched (every probe-bundle `GateResult` fixture is command-less — those
  entries are argv-form evidence of a different shape and remain
  legitimately so);
  `parseJobsSpec` accepts a well-formed
  `probes` array verbatim — since T-018 including a benchmark probe with
  `repeats`, since T-019 a screenshot probe with `capture`, since T-024
  a web probe with `url`, and since T-032 an adversarial probe with
  `seed`, each
  preserved verbatim — parses a probe-less spec to output
  byte-identical JSON to today, and refuses a genuinely-unknown probe type
  with the updated message (`type must be "command", "test", "benchmark",
  "screenshot", "web", or "adversarial"` since T-032's flip; the unknown-type example is a
  type still unknown at the
  landing — `'godot'` since T-019, still unknown at the T-024 and T-032
  landings),
  malformed entries
  (non-object, probes non-array, missing exe, non-string args, bad
  timeoutMs), duplicate probe ids per job, probe-id charset violations,
  unknown fields inside a probe or its command (the T-009 posture),
  T-018's `repeats` shape rule: missing/zero/negative/non-integer/
  non-number on a benchmark probe all refused naming the offense, and
  `repeats` on a command/test probe refused, and T-019's `capture` shape
  rule: missing/empty/non-string/absolute (drive-letter, backslash, and UNC
  forms)/`..`-segment on a screenshot probe all refused naming the offense,
  and `capture` on a command/test/benchmark probe refused, and T-024's
  `url` shape rule: missing/empty/non-string/non-http(s)-scheme
  (`ftp://host/`, URL junk) on a web probe all refused naming the offense,
  and `url` on a command/test/benchmark/screenshot probe refused, and
  T-032's `seed` shape rule: missing/0/-1/1.5/non-number (`'seven'`) on an
  adversarial probe all refused naming the offense, and `seed` on a
  command/test/benchmark/screenshot/web probe refused;
- **direct token-free executions**: on a fresh demo-target fixture
  (scripts/demo-target.mjs, Gate 1's own generator) `CommandProbe{node
  build.js}` yields success true, exitCode 0, exactly one GateResult entry,
  and a `.log` artifact at
  `<artifactsDir>/probes/<candidateId>/<probeId>.log` referenced with
  sizeBytes > 0; a failing command yields success false, non-zero exitCode,
  captured tail; a non-existent exe yields success false with the spawn
  error recorded in the bundle (and in the GateResult tail), never success
  true. On temp TAP fixtures in the verify sandbox, `TestProbe` pins:
  all-pass TAP (real `node --test`) → success true with tests/pass/fail
  measurements (pass == tests); counted `ok`/`not ok` lines when no summary
  lines are present; any `not ok` → success false, fail ≥ 1 even at exit 0;
  TAP 14 summary numbers on a failing `node --test`; exit 0 with
  unparseable output → success false (parsed-nothing is never a pass,
  AGENTS.md #7 applied to bundles); timeout → success false, exitCode null,
  durationMs ≥ timeoutMs, the whole spawned tree (parent + spawned child)
  verified dead on the real process table, and kill evidence on the
  GateResult — a verified kill leaves `cleanupFailures` absent, an unproven
  one records loud `CLEANUP FAIL` lines. T-018's `BenchmarkProbe` pins, on
  the same fixtures: `BenchmarkProbe{node build.js, repeats: 5}` → success
  true with EXACTLY 5 `run-<i> duration` measurements plus min/median/p95
  (every measurement unit ms); min ≤ median ≤ p95; one GateResult entry per
  repeat, in run order, self-named `<probeId>#run-<i>`, each equal to its
  run duration; the summaries EXACTLY equal the nearest-rank recomputation
  over the recorded durations (`sorted[ceil(q·n)−1]`, no interpolation,
  recomputed in the check); a `'report'`-kind results artifact
  `<probeId>.results.json` beside the bundle (sizeBytes > 0) that parses and
  carries the durations + summaries; the bundle passes
  `validateEvidenceBundle`; the combined `.log` carries the
  `=== run <i> ===` separators. Failure faces: a non-zero-exiting command
  (repeats 3) → success false, `error` names the first failing run with
  counts, all 3 durations still recorded; a non-existent exe → success
  false with ZERO run-*/summary measurements, never a pass; timeout
  (the P4 sleeper pattern) → success false, `error` names the timing-out
  run, the repeat exitCode null with durationMs ≥ timeoutMs and its
  duration still recorded, the spawned tree verified dead on the real
  process table, kill evidence on that repeat's GateResult entry.
  T-019's `ScreenshotProbe` pins, against temp screenshot fixtures in the
  verify sandbox whose capture commands only copy the checked-in tiny valid
  PNG (`scripts/fixtures/tiny-1x1.png` — magic-verified at authoring time,
  above the floor — into the workspace, list-form, so no capture technology
  is a dependency of any pin): the fixture itself is pinned magic-valid and
  above `MIN_PNG_BYTES`; the happy path (capture into a workspace-relative
  subdirectory) → success true, one GateResult entry (exit 0, passed),
  both measurements (`capture duration` unit ms, `image bytes` unit bytes
  equal to the source size), the image a kind-`'screenshot'` artifact named
  `<probeId>.png` at
  `<artifactsDir>/probes/<candidateId>/<probeId>.png` with sizeBytes equal
  to the source and the PNG magic re-verified ON THE COPY, and the bundle
  passes `validateEvidenceBundle`. Failure faces, each success:false never
  a pass: a non-zero-exiting capture → `error` names the exit, capture
  duration still recorded, no image bytes, no screenshot artifact; a
  zero-byte capture → `error` names the size floor, `image bytes` 0
  recorded (evidence about failures is evidence); exit 0 having written
  nothing → `error` names the missing capture file, no image bytes
  recorded; a magic-less capture (64 bytes, clearing the floor) → `error`
  names the bad magic, `image bytes` recorded; a non-existent exe →
  success false with the spawn error recorded, NO `capture duration` (the
  command never ran), no artifact beyond the `.log`; a directly constructed
  screenshot scenario without `capture` is refused by the class itself,
  never silently run; timeout (the P4 sleeper pattern) → success false,
  `error` names the timeout, exitCode null, durationMs ≥ timeoutMs, the
  capture duration still recorded, the whole spawned tree verified dead on
  the real process table, kill evidence on the GateResult entry;
  T-024's `WebProbe` pins, on zero-dependency `node:http` fixture servers
  generated in the verify sandbox per leg (write-and-run, the demo-target
  pattern — no server exists in any checked-in fixture; each leg's server
  binds a free port the check picks, ports being machine-global — the
  documented limitation): the happy path (a 200 server with a known body)
  → success true; `http status` 200; `ready duration` (ms) + `body bytes`
  recorded; the body snippet equals the known body;
  `<probeId>.response.json` (kind `'report'`) on disk under
  `<artifactsDir>/probes/<candidateId>/` parsing to the captured values
  (url, status, contentType, snippet, bytes); the bundle passes
  `validateEvidenceBundle`; the bounds pinned exactly — a 5000-char body
  records a snippet of exactly `WEB_PROBE_SNIPPET_BYTES` characters and a
  1.5 MiB body records exactly `WEB_PROBE_MAX_BODY_BYTES` bytes read (both
  still success true — the bounds bound the evidence, never judge it);
  **the server tree verified dead on the real process table after `run()`
  returns** — teardown pinned on the success path. Failure faces, each
  success:false never a pass: a 500 server → `error` names the non-2xx
  status and the `http status` measurement still records 500 (readiness was
  reached — `ready duration` recorded too; the response artifact records
  the 500); a 200 with a zero-byte body → `error` names the empty body,
  body bytes 0 recorded; a launch that exits 3 without serving → `error`
  names the exit, zero measurements, no response artifact, exitCode 3 on
  the GateResult, nothing-to-kill recorded in the log with NO
  `cleanupFailures` fabricated; a never-ready sleeper that binds nothing →
  deadline expiry, `error` names the readiness timeout with the last poll
  error (ECONNREFUSED), exitCode null, durationMs ≥ timeoutMs, multiple
  poll attempts logged inside the one budget, **the spawned tree (parent +
  child) verified dead on the real process table** — the tree kill is what
  reaps a launched server — kill evidence on the GateResult entry; every
  leg sweeps its fixture server (no process left alive, the P4 sweep
  fallback). T-032's `AdversarialProbe` pins, on a generated known-weak-spot
  fuzzee fixture in the verify sandbox (the T-024 write-and-run pattern —
  zero-dep scripts generated per leg, no checked-in fixture; the fuzzee
  exits non-zero exactly on inputs failing `Number.isFinite(Number(arg))`,
  the same weak-spot class as the real demo target's `add()`:
  scripts/demo-target.mjs:15-35, and this check derives the expected crash
  subset INDEPENDENTLY from the recomputed case list, never from the
  bundle): determinism/replayability, token-free — the exported
  `generateAdversarialCases` invoked twice with the same seed returns
  byte-identical lists of exactly `ADVERSARIAL_PROBE_CASE_COUNT`; over
  several seeds every generated case's length is ≤
  `ADVERSARIAL_PROBE_MAX_CASE_CHARS`; the probe's recorded per-case table
  inputs match the independently recomputed list case-for-case (every
  recorded input bounded); two same-seed probe runs against the same
  fixture agree case-for-case on outcome (a replayable crash list). The
  crash face: the weak-spot fixture crashes on the known subset → success
  false, `error` names the FIRST breaking case with counts, exactly that
  subset recorded as failed `'<id>#case-<i>'` rows (every other row
  passed), `cases-crashed` equals the subset size, `cases-run` the full
  count, one `case-<i> duration` per ran case, and the `'report'`-kind
  results artifact `<id>.results.json` on disk parsing to
  `{probeId, scenarioId, seed, cases[], casesRun, casesCrashed}` whose
  per-case outcomes match the independently-derived subset. The no-crash
  face: a robust fixture → success true, `cases-crashed` 0, every
  `'<id>#case-<i>'` row passed, the bundle validator-clean. The
  spawn-refusal / zero-completed face: a non-existent exe → success false,
  zero `case-<i>` duration measurements, `cases-run` 0, every row
  spawn-refused, `error` naming case 1, never a pass (AGENTS.md #7). The
  timeout face (the P4 sleeper pattern with its process-table assertions):
  a generated target sleeping past `timeoutMs` on exactly one case → that
  case's GateResult exitCode null, durationMs ≥ timeoutMs, its duration
  still recorded, `cases-crashed` 1, the spawned tree verified dead on the
  real process table, kill evidence on that case's entry; a directly
  constructed adversarial scenario without `seed` is refused by the class
  itself, never silently run.
- **evidence emission in a real pipeline** (the Gate 1.8/1.10 pattern —
  `runSkeleton` driven end-to-end with a fake `WorkerAdapter` and fake
  gates against throwaway fixture repos): a `--jobs` run carrying probes
  writes `<artifactsDir>/probes/<candidateId>/<probeId>.json` per executed
  probe, each a validator-clean bundle; `CandidateReport.probes[]` names
  every bundlePath with the on-disk path, probeId, scenarioId, and success
  agreeing with the bundle, and the same arrays ride `report.json` on disk;
  a job whose gate FAILS still runs and records its probes (evidence about
  failures is evidence); survival is untouched — a passing-gates/
  failing-probe job still passes, a failing-gates/passing-probe job still
  fails, and since T-018 a passing-gates/FAILING-benchmark job still passes
  (the benchmark probe rides the same correspondence pin: bundle on disk,
  validator-clean, durations + summaries + a real on-disk 'report' artifact,
  success agreeing with the summary); since T-019 a `--jobs` drive carrying
  screenshot probes pins: the screenshot bundle on disk, validator-clean,
  with one GateResult entry and its success agreeing with the summary; the
  image artifact a kind-`'screenshot'` copy at exactly
  `<artifactsDir>/probes/<candidateId>/<probeId>.png` — under the artifacts
  dir, NEVER inside the candidate worktree (pinned against the report's
  `workspacePath`) — that exists on disk at report time with sizeBytes
  equal to the source and the PNG magic re-verified; and a passing-gates/
  FAILING-screenshot job still passes (the screenshot outcome never enters
  a verdict); since T-024 a `--jobs` drive carrying web probes (inline
  `node -e` servers, source as argv) pins: the web bundle on disk,
  validator-clean, its success agreeing with the summary, the `http status`
  measurement on the captured 200; the response artifact on disk under the
  artifacts dir — NEVER inside the candidate worktree (pinned against the
  report's `workspacePath`) — parsing to the captured body snippet; and a
  passing-gates/FAILING-web job still passes (the web outcome never enters
  a verdict); since T-032 a `--jobs` drive carrying an adversarial probe
  (the fixture repo's own weak-spot fuzzee, seed 7, FAILING by
  construction) pins: the adversarial bundle on disk, validator-clean
  (success false), its summary agreeing (a passing-gates/FAILING-adversarial
  job still passes — the adversarial outcome never enters a verdict), one
  `'<id>#case-<i>'` GateResult row per case, `error` naming the FIRST
  breaking case, the `cases-run`/`cases-crashed` counts matching the
  independently recomputed seed-7 list, and the on-disk `'report'` results
  artifact under the artifacts dir — NEVER inside the candidate worktree
  (pinned against the report's `workspacePath`) — parsing to
  `{probeId, scenarioId, seed, cases[], casesRun, casesCrashed}` with every
  recorded input bounded by `ADVERSARIAL_PROBE_MAX_CASE_CHARS` and matching
  the recomputed list case-for-case; default mode records no `probes`
  field and no `probes/` dir.

Not pinned here and carved by the ticket(s): Godot/Blender probes
(§12.1:911-924, :937-947 — the T-024 web/server probe is their lifecycle
base; app-specific launch/readiness/capture for those tools stays carved
until the apps are installed) and browser-automation Web proper
(§12.1:925-935 — interaction, console/network errors, accessibility tree,
viewport matrix, performance metrics — needs a browser dependency and its
own decisions.md entry; T-024's `web` probe is the server-lifecycle slice,
not §12.1's Web Probe), screenshot integration on a launched web target
(composing T-019's capture onto a live server — the natural successor
ticket), Static
Diff probe (§12.1:949-951 — mostly exists as worktree diff capture),
probe persistence (§27:1831 `probe_runs` / §28:1854 `ARTIFACT_CREATED` —
landed since by T-016, schema v5: the extended Gate 1.6 pins the rows and
the derived events, Gate 1.16 the tamper evidence), the §13:986-996
project-manifest `probes:` block and any scenario/environment file format
beyond job-spec
config, run-level `--probe` CLI flags, probe evidence feeding the context
system's selectors (T-012's hand-built `type: 'probe'` fixtures are the
ready consumer — a successor ticket's relationship), and probes on a
thrown final attempt (no completed workspace pass to probe — recorded as
absent, never fabricated). T-018 additionally carves: any
measurement→verdict bridge (perf bars as gates that read bundles — a
Gate-seam question: `Gate.run(cwd)` carries no evidence-path context, and
decisions.md 2026-10-10 keeps verdicts gate-only), statistical
sophistication (warmup runs, outlier rejection, cross-candidate
comparison — each owns its ticket), and benchmark `probe_runs` consumption
(the rows persist through T-016's store untouched — `ProbeRunSummary` is
type-agnostic). T-019 additionally carves: non-PNG image formats, image
dimensions and any pixel-content assertion (§6.8:480-481 — contact sheets,
video), and probe-side target lifecycle (the Web/Godot probes' §12.1
territory — today the capture command encapsulates launch, timing, and
readiness, and the one-command seam shape is unchanged; the
server-lifecycle half is pinned for `web` probes since T-024 — the carve
stands for the screenshot/Godot/Blender territory). T-024 additionally
carves: ephemeral-port allocation (`url` is operator-chosen and ports are
machine-global — concurrent probes aimed at one port collide), multi-URL/
health-endpoint logic, and web `probe_runs` consumption beyond T-016's
type-agnostic persistence (the rows persist untouched). Gate 2 runs once at landing as the
no-regression obligation (`src/runner.ts` and report shape are on its
trigger list; the slice gives default mode no probes, so Gate 2 pins that
the pipeline without probes behaves exactly as today, never probe
emission — that is this gate's `--jobs` leg), recorded in T-015's Landed
section — not a permanent Gate 2 extension. Gate 3 n/a (no adapter
touched).

## Gate 1.16 — artifact store persistence + tamper evidence (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-artifacts.mjs
```

Pins the T-016 re-verification primitive — `verifyRunArtifacts(runId,
dbPath)` in `src/store/index.ts`, spec §29:1877's "validate artifact
files/hashes" face: re-hash a run's recorded `artifacts` rows against the
files on disk. The store hashes at ingest (the documented third scoping
case in the store module header: ingest is deterministic as a function of
*(report, the evidence files it names)* — it reads evidence, never writes
it, and the wall clock never enters a stamp), so this primitive is what
makes the recorded hashes *checkable*. Since T-028 `npm run integrate` is
the primitive's first pipeline consumer — its verify-when-recorded pre-lock
check, pinned by the Gate 1.5 faces above — while `verifyRunArtifacts`
itself and every pin in this section are untouched. Deliberately no CLI
this slice — a later recovery slice integrates it into `npm run recover`
(the T-016 carve; the T-006/T-008 defaults precedent applies if one ever
lands).

No existing gate pins tamper evidence — Gate 1.15 pins bundle writing, not
store persistence, and Gate 2 spends model tokens — so this gate builds a
sandbox run with controlled evidence files (one report-named path
deliberately never written), ingests it, and asserts:

- hash-at-ingest measured the controlled content: every existing file's
  `size_bytes`/`content_hash` equal its byte length and sha256; a
  report-named path with no file on disk records NULL for both — never
  fabricated (AGENTS.md #7); a path named by two report fields (`diffPath`
  and the final attempt's `outputArtifacts`) yields ONE deduplicated row;
  the `probe_runs` row matches the report summary field-for-field with a
  matching probe-bundle artifacts row;
- re-verification of intact files reports every row `verified` (except the
  null-hash row), results ordered by `artifact_id`;
- flipping one file's bytes is detected as `mutated`, with no other row's
  status disturbed;
- deleting one file reports `missing`;
- a null-hash row reports `unverified` — never `mutated`, not `missing` —
  and stays `unverified` even once its file appears on disk (nothing
  recorded, nothing claimed);
- verification is read-only over both sides: the DB file is byte-identical
  across repeated verifications (sha256) and evidence files are only ever
  read; an unknown run verifies to an empty result, never a throw.

## Gate 1.17 — MachineWorker adapter (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-machine-worker.mjs
```

Pins T-017 (spec §4:186-187, §5.3:254-273, §11:851-859, §34:2030-2033):
`src/worker/machine.ts` — `MachineWorker` (id `'machine'`), the second real
`WorkerAdapter`: it executes a brief by running one configured deterministic
command (an argv list) directly in the leased worktree — no external agent
harness, no model tokens, no shell. The adapter mirrors the OpenCodeWorker's
proven shape (constructor-injected config → list-form spawn → `onSpawn` once
→ `runChildWithTimeout` → result) and keeps only the specifics: the argv.
The docblock carries the required reconciliations: worker-vs-probe (this
adapter runs PRE-gates, its file effects ARE the candidate diff, its exit
code drives `workerOk`/retry; a CommandProbe runs POST-gates, produces an
EvidenceBundle, and never enters a verdict nor produces a diff), §11's
fuller contract (`capabilities()`/`cancel()` deliberately not implemented —
the seam stays `id` + `execute`; termination is onSpawn/pid + T-011's
verified kill), and the honesty fields (`req.prompt` logged to `logPath` as
a provenance header, never interpreted or executed; `req.model` ignored —
the report/store keep recording the configured model string verbatim for a
candidate no model touched). The registry sentence (src/cli.ts): the
`--worker`/`--jobs` worker id vocabulary is `opencode` and `machine` —
`createWorker` constructs `MachineWorker` from the job's `command`; the
per-job cache keys by adapter id + serialized command (two machine jobs with
identical commands share one instance, distinct commands get distinct
instances); the unknown-worker error reads
`unknown worker adapter '<id>' (available: opencode, machine)`; and
run-level `--worker machine` is refused at parse time (no run-level machine
command for the worker tier — since T-025 the planner and reviewer roles
select their own adapter through `--planner-worker`/`--reviewer-worker` with
their own `--planner-command`/`--reviewer-command` sources, so the refusal's
"no machine command" fact is about the worker tier alone; the refusal
message and Gate 1.17 S6's pin of it are unchanged). Before T-025 a fully
token-free run needed `--no-review`; since T-025 `--jobs` + per-job
`machine` + `--reviewer-worker machine --reviewer-command` reaches one with
a real advisory review (Gate 1.21 S3).
Zero new npm dependencies (`node:child_process` only, decisions.md
2026-10-10). The gate's legs, all token-free:

- **S1 — direct adapter, real work, spawn contract, directory resolution**:
  a file-mutating node command run in a scratch git repo returns `ok: true`,
  exit 0, the change visible to `git diff`; `onSpawn` fired exactly once and
  `WorkerResult.pid` equals that pid (the T-010 contract, previously pinned
  only for fake adapters by Gate 1.11); a child printing `process.cwd()`
  yields exactly `req.cwd` — asserted with a bogus inherited `PWD` in the
  environment, pinning the spawn-cwd-vs-env.PWD contrast with Known issue
  #1 (the adapter pins no env; the docblock states why); the log carries
  the argv header and the brief as a provenance header.
- **S2 — a failing command** (`node -e "process.exit(3)"`): `ok: false`,
  `exitCode: 3`, `timedOut: false`, no throw; the spawn contract holds.
- **S3 — a non-existent executable**: `ok: false`, `exitCode: null` (the
  spawn-error path, src/worker/run-with-timeout.ts:45) without throwing;
  no pid ever existed (`onSpawn` never called, `pid: null`).
- **S4 — timeout**: the verified tree kill fires via `runChildWithTimeout`
  (the Gate 1.12 S4 mechanics against the real adapter, not a fake):
  `timedOut: true`, the log carries the `tree killed, verified:` line and
  the drained child stdout, the whole planted tree (parent + spawned child)
  verified dead on the real process table, and `cleanupFailures` pass
  through onto `WorkerResult` (a verified kill leaves the key absent, an
  unproven one records loud `CLEANUP FAIL` lines) — plus a source-level pin
  (the Gate 1.12 S2 precedent) that the adapter routes through
  `runChildWithTimeout` and spreads its `cleanupFailures`. The kill exit
  code is whatever the killed child reports; only `ok`/`timedOut` are the
  contract.
- **S5 — token-free REAL-CLI `--jobs` end-to-end** (the Gate 1.5 sandbox
  pattern): a fixture run with two `worker: "machine"` jobs carrying
  different `command`s (each gated on its own marker file) plus a no-op
  machine command (gated by a vacuous passing gate) — both real jobs PASS
  with `diffBytes > 0` and the correct job-command pairing (each
  `worker.log` carries exactly its own argv, no cross-contamination; each
  `diff.patch` captured its own marker-file change), and the no-op job is
  eliminated as NO-OP, never a pass (AGENTS.md #7) even with its gate
  passing — the ladder's `diffBytes > 0` leg pinned against the real
  adapter. Since T-027 the S5 assertions also pin the recorded gate commands
  end-to-end: the on-disk `report.json`'s gate entries for
  `codemod-a`/`codemod-b` carry `command` exactly equal to the job spec's
  gate commands (`GateResult.command` — the only uniform place a command can
  meet its verdict is inside the producer's own `GateResult`).
- **S6 — refusals, all exit 1 with zero side effects** (no artifacts dir,
  no `locks/`, asserted after each — each through the real CLI with a
  non-git `--repo`, so the refusals precede repo validation): `--worker
  machine` at run level (parse time); `command` on a non-machine job; a
  machine job without `command`; a malformed `command` (a shell string; an
  empty-string argv entry); and an unknown per-job worker id, whose refusal
  reads `unknown worker adapter 'bogus' (available: opencode, machine)`
  before the checkout lock (the registry's own message, checked early so
  the refusal writes nothing).
- **P — contract fixtures** (the Gate 0.5 hand-built-input pattern):
  `parseJobsSpec` accepts a machine job's `command` verbatim, parses a
  command-less spec to output byte-identical to today (the Gate 1.15 P2
  argument), and refuses malformed shapes (a string, an empty array, a
  non-string entry, an empty-string entry) naming the job; the pure
  `commandPairingRefusal` helper (src/scheduler.ts, beside `parseJobsSpec`)
  passes well-paired sets, refuses both mispairings naming the job, and
  resolves the worker through the run-level default argument.

Not pinned here and carved by the ticket: machine workers serving
planner/reviewer roles — carved by T-017, landed since by T-025 (per-role
selection flags, Gate 1.21); any
WorkerAdapter seam extension toward §11's `capabilities()`/`cancel()`;
§5.3's evidence-collection tasks (benchmarks/screenshots/Godot — probe-layer
successors per T-015's carve, T-018/T-019 ticketed); §19 machine-job
memoization (deliberately deferred, ROADMAP.md); HumanWorker/
ZCodePrototypeWorker/CodexWorker (Codex is stage 5). No engine regression:
`src/types.ts`, `src/runner.ts`, gates, workspace handling, and the report
shape are untouched — the diff rides the existing seams end to end, and the
unchanged Gates 1.10/1.11/1.12/1.15 stay green inside the fast tier. Gate 2
runs once at landing ("any adapter" is on its trigger list) — recorded in
T-017's Landed section, not a permanent extension. Gate 3 runs once at
landing (an adapter was added) — see its section's T-017 note.

## Gate 1.18 — worktree lease GC (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-gc.mjs
```

Pins T-020 (spec §16's leased-worktrees posture, §34 Milestone 3's GC build
item, the dispose half of §29 recovery's "validate worktree leases"): the
standalone `npm run gc -- [--run-root <path>] [--force-lock]` (`src/gc.ts`,
the clean/integrate/recover standalone-entry pattern) walks the run root —
14-digit timestamp run directories, the `clean --all` convention —
classifies every run dir against the evidence the engine already produces,
and disposes, through `src/clean.ts`'s lock-serialized, dirty-refusing
disposal loop, only what is provably orphaned. The disposal internals
(`readReport`/`RunResult`/`removeBranch`/`disposeTargets`) moved verbatim
out of `src/clean.ts` into `src/disposal.ts` (the T-010 extract precedent
that put `sniffRepo`/`registeredWorktrees` in `src/workspace/worktree.ts`)
so both commands drive one semantics; clean's behavior is unchanged (Gate
1.5 stays green) and the module is deliberately NOT
`src/workspace/worktree.ts` (that file is the WorkspaceProvider seam —
decisions.md 2026-10-18 keeps it the only one). Deliberately **no
`--force`**: GC never discards uncommitted changes — a dirty worktree is
refused per-item, with a pointer at `npm run clean -- --run <id> --force`
(today's manual path for exactly that case). Every git subprocess is
list-form (AGENTS.md #4); zero new dependencies.

Classification, per run directory — every run dir is reported with its
class:

- **live (lock held)** — acquiring the per-repo checkout lock
  (`acquireCheckoutLock`, `src/lock.ts`) is refused ⇒ the run may be live ⇒
  skip, print the holder pid/age/path, remove nothing (the T-004
  never-auto-reap policy; `--force-lock` is the explicit human override,
  honored exactly as clean honors it and documented in the command's help —
  nothing ever reaps a lock automatically);
- **crashed-unreconciled** — no `report.json` and no `recovery.json` ⇒
  reported "run `npm run recover` first", skip, remove nothing;
- **crashed-reconciled** — `recovery.json` present, no `report.json` ⇒
  worktrees + branches are disposable: targets from the dispatch records'
  `worktreePath`/`branch` fields, the `recovery.json` workspaces, and
  `wt/`-discovery, deduped by path and fed through clean's per-worktree
  disposal loop with its dirty-refusal, prune fallback, and
  branch-removal-AFTER-worktree-removal order (`src/disposal.ts`,
  unchanged);
- **finished** — `report.json` present ⇒ no worktree disposal (its
  workspaces were disposed in-run or are clean's ordinary business);
  eligible only for the branch sweep.

The repo-side branch sweep (the `--clean` leak fix: the in-run dispose is
ONLY `git worktree remove --force`, so every `--clean` run permanently
leaks its `swarm/wt-<id>` and retry-leg `swarm/wt-<id>-a<n>` branches —
scout-reproduced end-to-end, recorded in T-020's Why). For each terminal
run's repo (class 3 or 4; from the report's `repo` field, falling back to
the dispatch header's, then `sniffRepo` — the clean/recover pattern), list
`swarm/*` branches (list-form `git branch --list 'swarm/*'`) and delete
exactly those that (a) have no worktree currently registered on them and
(b) are attributable to the terminal run via its dispatch records' `branch`
fields, its report candidates (`branchForLeaseId('wt/<id>')`, retry legs
`wt/<id>-a<n>` → `swarm/wt-<id>-a<n>` included), or its `wt/` entry names.
Branches attributable to no terminal run are reported unowned and never
deleted; branches on registered worktrees are reported and never deleted
(workers never commit — the diff is captured to `diff.patch` first — so a
`swarm/*` branch carries no unique evidence). `wt/int-*` integration-replay
worktrees (spec §16.1 `integration` retention class, dirty by construction)
are excluded from every target set and reported held for human disposition.
Evidence files (`report.json`, `dispatch.jsonl`, `recovery.json`,
`worker.log`, `diff.patch`, `integrate/<id>.json`) are never deleted. The
per-repo lock is taken inside the per-run pass and released in a `finally`
on every path (the `src/clean.ts` pattern); exit 0 when the sweep completed
— skipped-live and crashed-unreconciled runs are healthy classifications,
not failures; exit 1 when any disposal item was refused or failed (clean's
convention).

The check builds one sandbox repo whose run root holds one run dir per
classification plus focused passes, all through the real CLI, token-free:

- **A1** — a crashed-reconciled run's clean orphan worktree is removed and
  its `swarm/wt-c01` branch removed after it (clean's order, pinned on the
  output lines);
- **A2** — a crashed-unreconciled run (dispatch.jsonl + worktree + branch,
  no `recovery.json`) is reported recover-first with the worktree, branch,
  and dispatch evidence intact — nothing removed;
- **A3** — the reproduced `--clean` leak shape (`workspacePath: null`
  candidates, exactly what the in-run dispose produces): the leaked
  `swarm/wt-c03a`, `swarm/wt-c03b`, and retry-leg `swarm/wt-c03b-a2` are
  deleted while the unowned `swarm/wt-ghost` is reported and kept;
- **A4** — a finished run whose worktree is still registered loses
  nothing: the sweep reports "branch held by a registered worktree —
  kept";
- **A5** — a dirty worktree in a crashed-reconciled run is refused (GC
  takes no `--force`), reported per-item with the
  `npm run clean -- --run <id> --force` pointer, worktree + branch intact
  — the pass exits 1, and the pointer's advice actually works (`clean
  --run 20260101000005 --force` disposes it, exit 0);
- **A6** — a dirty `wt/int-c06` worktree survives the pass byte-identical
  (whole-tree hash) and reported held while its crashed-reconciled
  sibling's orphan IS disposed;
- **E** — every evidence file (`report.json`/`dispatch.jsonl`/
  `recovery.json`/`worker.log`/`diff.patch`) is hash-identical across the
  whole pass, and no residual `.lock` files remain (the lock released in
  `finally` on every path);
- **B** — a held checkout lock classifies every run live, names the holder
  pid and lock path, removes nothing, exit 0 (healthy); the documented
  `--force-lock` override proceeds and disposes (parity with clean) and
  releases the lock afterward; the end state keeps exactly the
  deliberately-kept worktrees (main + the unreconciled c02 + the
  registered c04 + the held int-c06) and branches (c02, c04, ghost).

The reproduced leak is additionally pinned red-before/green-after inside
the existing Gate 1.17 S5 sandbox (`scripts/check-machine-worker.mjs`):
after the real `--clean` machine run the three `swarm/wt-*` branches ARE
present (the recorded red bar — AGENTS.md #8), then `gc` on that run root
removes exactly them, leaving no `swarm/*` branches and only `main` in
`worktree list`, with the run's `report.json` intact.

Not pinned here and carved by the ticket: no §27 `workspace_leases` table
and no §28 `WORKTREE_*` events — a lease record is retention machinery,
not a GC prerequisite (`dispatch.jsonl` already carries the lease identity
per attempt; the carve is recorded in T-010's Landed section and this
file's Gate 1.11 carve note), no retention policies / `expiresAt` (§16.1's
graded classes — GC implements one binary classification, debris-vs-live;
the graded classes are the next stage-3 item), no recover changes
(`recover` stays report-only — Gate 1.11's byte-identical pin stays intact;
GC consumes recovery.json, never produces it, and never flips that pin),
no pipeline changes (`src/runner.ts` and the WorktreeProvider untouched —
the `--clean` leak is fixed at GC time, not by making in-run dispose
delete branches, which would change run-time behavior), no
startup-automatic GC (an explicit command in the clean/recover family;
T-004's never-auto-reap policy bounds how automatic a crashed-run GC can
be — a crashed run's stale lock blocks until a human overrides), and no
§26.7 retention UI / disposable clones / short-path run roots (decisions.md
2026-10-18 for clones). Gate 2 is not triggered: the change-set touches no
pipeline file — the shared disposal module is a `clean.ts` extraction,
`src/runner.ts`, `src/workspace/worktree.ts`, the adapters, the gates, and
the report shape are untouched (trigger list, Gate 2's section). If a
landed change-set touches `src/workspace/worktree.ts` or `src/runner.ts`
anyway, Gate 2 runs once at landing. Gate 3 n/a (no adapter change).

## Gate 1.19 — §15.4 explicit long-path budget (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-long-paths.mjs
```

Pins T-021 (spec §15.4's six path-handling constraints, :1088-1098). Five are
implemented and anchored in code — 14-digit run ids (`src/cli.ts:304`), the
`C:\swarm` run-root default (`src/cli.ts:107`), `normPath` path normalization
(`src/workspace/worktree.ts:12`), the flat artifactsDir evidence layout
(`src/cli.ts:305`), and the list-form worktree lease
(`src/workspace/worktree.ts:67-74`) — and the sixth, the **explicit long-path
test** (:1096), is this gate: it had no artifact anywhere in the repo before
it (the honesty note below). The shape-deciding values are unexported inline
code (`grep -n "export" src/cli.ts` → zero hits), so the gate pins them
behaviorally, never through a composition the check reconstructs: it builds a
deep fixture repo in a throwaway sandbox under `C:\swarm\verify-longpath`
(created and removed by the check itself — AGENTS.md #10), drives the REAL
engine end-to-end with a token-free `--jobs` machine run (the Gate 1.17 S5
shape: per-job `worker: "machine"` + list-form command; run-level
`--worker machine` is refused by design, `src/cli.ts:142-143`; the planner
auto-skips under `--jobs`, `src/cli.ts:312`; timeout-bounded like S5's 120s;
NO `--clean` — disposal is its own assertion), then derives every assertion
from the run's actual records.

The fixture: a demo-target-style repo (baseline-passing `node build.js` +
`node test.js`, run by the check before the engine touches anything) whose
committed tree holds one file at a measured, deterministic depth — nested
bounded-name directories sized so the deepest composed path (below) lands in
a documented **240–258-char band**, inside MAX_PATH 260 (no `core.longpaths`,
no `\\?\` prefixing, no symlink semantics — default-Windows behavior; §15.4's
no-POSIX-symlink bullet stays satisfied by `git worktree add`). One machine
job appends one line to that file and its gate validates the file, both
executing with the leased worktree as their working directory (the fixture
helper `tools/longpath.mjs` carries the deep path as a generated constant, so
no command string ships ~200 chars of tree through a shell). The check then
asserts, reading only what the run produced:

- exactly one 14-digit run dir under the sandbox run root (the Gate 1.17 S5
  scan) — flips if the runId derivation changes (`src/cli.ts:304`);
- the recorded `workspacePath` (`report.json`) equals `<runDir>\wt\<jobId>`
  EXACTLY, and the `dispatch.jsonl` dispatch record (`src/runner.ts:428-436`)
  carries the same `worktreePath` with `leaseId` `wt/<jobId>` and branch
  `swarm/wt-<jobId>`, the completion record `ok` with the captured
  `diffBytes` — flips if the lease-id shape (`src/runner.ts:407`) or the
  lease-path join (`src/workspace/worktree.ts:68`) changes;
- the composed worktree budget: the engine's own composition read off the
  recorded path (`<runId>` + `\wt\` + lease id) composed against the locked
  run-root default `C:\swarm` (decisions.md 2026-10-10) measures **≤ 40
  chars** — the production prefix the MAX_PATH budget cares about (the
  engine's worst case today is `C:\swarm\<14 digits>\wt\<id>-a2\` ≈ 34
  chars). The literal recorded path is NOT asserted against 40: the sandbox
  run root (`C:\swarm\verify-longpath\runs`) is necessarily longer, so that
  measure would size the check's own sandbox choice, not the engine's budget;
- before disposal, the deepest composed file path (recorded `workspacePath` +
  the fixture-relative deep path) EXISTS on disk carrying the appended line,
  and lands in the documented 240–258 band (measured 249 at landing);
- the run succeeded at that depth: `workerOk`, `diffBytes > 0`, the deep-file
  gate passed, and `diff.patch` contains the deep path with its byte length
  equal to the recorded `diffBytes`;
- disposal through the house path: `tsx src/clean.ts --run <runId> --run-root
  <sandbox> --force` (`--force` is correct: the run captured the evidence
  before disposal — the Gate 2 posture) exits 0 and removes the worktree and
  the `swarm/*` branch (only `main` in `worktree list`) with `report.json`,
  `dispatch.jsonl`, `worker.log`, and `diff.patch` hash-identical to before —
  T-002's disposal loop exercised on a real deep run.

**Flip-sensitivity, stated exactly.** Gate 1.19 flips automatically on:
runId derivation changes (`src/cli.ts:304`); lease-id shape or lease-path
composition changes (`src/runner.ts:407`, `src/workspace/worktree.ts:68`);
and any depth/shallowness regression the run's records expose. It does NOT
automatically flip on the run-root default (`src/cli.ts:107`) — the check
passes `--run-root` explicitly (the sandbox discipline every fast-tier check
follows: Gate 1.5's `C:\swarm\verify-clean`, S5's sandboxed runs), so a
changed default is invisible behind the flag; that case is pinned by this
section's anchor plus change-set review. The mechanism that would automate it
(invoke the CLI without `--run-root` and assert the run landed under
`C:\swarm`, then dispose through `clean`) is named in T-021 and deliberately
NOT taken: it would write real run state into the live root during
`npm run verify`, breaking the sandbox discipline the rest of the fast tier
keeps.

**Honesty note.** No MAX_PATH/ENAMETOOLONG failure has ever been observed in
this repo; the gate pins a failure class prospectively, before field fan-out
scales worktree counts — it fixes no observed bug. Recorded at landing
(re-run of the ticket's grep, `grep -rn
"MAX_PATH\|longpath\|long-path\|ENAMETOOLONG\|260"` over `src/`, `scripts/`,
VERIFICATION.md, `docs/tickets/`): zero hits under `src/`, and zero hits for
the failure-class tokens (`MAX_PATH`/`longpath`/`long-path`/`ENAMETOOLONG`)
anywhere outside the tickets' own prose; the bare `260` alternative matched
only incidental `2026…` timestamp literals (e.g. the fixture run ids in
`scripts/check-gc.mjs`, one `--run` example in this file) and `:260-`
line-range references in other tickets — never a path-length discussion. The
ticket's "zero hits" phrasing held for `src/` and for the failure-class
names, not for the bare `260` alternative; the substance (no observed
failure, no pre-existing long-path artifact) is unchanged.

## Gate 1.20 — role capability restriction (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-capabilities.mjs
```

Pins T-023 (spec §3.6:144 "Do not edit files is not a security boundary" ·
§14.1:1014 "A write-capable model worker never receives the canonical
checkout as its writable workspace" · §14.3:1039 "The implementation can
vary. The contract does not."): mechanism-level capability restriction for
the two advisory roles at the `WorkerAdapter` seam, closing Known issue #6
(the repo's oldest recorded honesty debt — the planner ran with build-agent
write tools in the target repo cwd). Three parts, one change-set:

- **The seam** (src/types.ts): `WorkerExecutionRequest.executionPolicy?: ExecutionPolicy`
  — the spec §14 vocabulary narrowed to the three postures with a producer
  (`'artifact-only'` / `'worktree-read'` / `'worktree-write'`; the spec
  never defines `PermissionPolicy`, §6.6:409 names it without a type — the
  T-013 choose-and-document precedent). Absent ≡ `'worktree-write'`, so
  existing adapters (`MachineWorker`, T-017) and every fake adapter in the
  existing checks compile and behave unchanged. The runner passes it
  EXPLICITLY on all three dispatch sites — the check pins what was sent,
  never what was defaulted.
- **The runner** (src/runner.ts): the planner dispatches from
  `<artifactsDir>/planner-scratch/` — created before the phase, removed
  best-effort after (its contents are never evidence; planner evidence
  stays `planner.log` + `planner-raw.txt`), policy `'artifact-only'` on
  both execute calls (initial + bounded repair share `baseReq`); the
  reviewer dispatches with policy `'worktree-read'` at the candidate
  worktree lease — a disposable workspace whose diff and gate evidence was
  already captured before review runs — with the prompt's "Do not modify
  any files" line kept as reinforcement; the worker dispatch carries
  `'worktree-write'` at the leased worktree, behavior unchanged. No verdict
  surface changes: the ladder, gates, probes, and the report shape are
  untouched — a restricted role's harness-level failure degrades through
  the existing planner raw-goal fallback and reviewer parse-fail paths,
  never into a candidate verdict (decisions.md: capability restriction is a
  spawn-time mechanism, not a gate result).
- **The adapter** (src/worker/opencode.ts — the only OpenCode-aware file,
  decisions.md 2026-10-10): a non-`'worktree-write'` policy adds `--agent
  plan` to the `run` argv — the OpenCode built-in plan agent, verified
  first-hand against the vendored opencode-ai **1.19.3**
  (`node_modules/opencode-ai/package.json`): `run --help` shows `--agent
  <string>`; `opencode debug agent plan` reports *"Plan mode. Disallows all
  edit tools."* with permission rules `edit * → deny` (narrow plan-file
  allows). The spawn log line reflects the actual argv, so `worker.log` /
  `planner.log` / `reviewer.log` record the restriction. `PWD`/`OLDPWD`
  pinning is untouched on every path (ground rule 5). The agent name is
  adapter-internal harness vocabulary; no new CLI flag (T-023 carve).

No existing gate can pin any of this — the fast tier never runs the planner
or reviewer, and Gate 2 spends model tokens — so the gate has two legs, all
token-free:

- **S1 — request capture** (the Gate 1.8/1.10 fake-adapter pattern, the
  check-retry shape: `runSkeleton` driven end-to-end with a fake
  `WorkerAdapter` + fake gates against throwaway fixture repos): planner
  requests carry `'artifact-only'` with a cwd that existed at dispatch
  time, sits under the run artifacts dir (`<artifactsDir>/planner-scratch`),
  and is neither the target repo nor inside it — and the planner prompt
  names no repo path (the restriction removes an accidental capability,
  not a used one); the scratch dir is gone after the phase; the bounded
  planner repair attempt (S1b) shares the same restricted request shape
  and cwd; reviewer requests carry `'worktree-read'` with cwd = the
  candidate workspace path; worker requests carry `'worktree-write'` with
  cwd = the worktree; candidates pass exactly as before and
  `report.json`'s key shape is unchanged (top-level, planner, candidate,
  review, attempt, and gate-result key sets all exact — no new report
  fields anywhere).
- **S2 — stub-bin argv pin** (constructor-injected `binPath`,
  src/worker/opencode.ts:25; the Gate 1.12 S2 pin face): `OpenCodeWorker`
  pointed at a stub executable that records its real argv and
  `env.PWD`/`env.OLDPWD` (the node executable itself with the recorder
  injected via `NODE_OPTIONS=--require`, so the recorder sees exactly the
  argv the adapter built — node resolves the entry-module argument to an
  absolute path before a preload runs, so the pin is on its basename):
  `'artifact-only'` and `'worktree-read'` → argv contains `--agent plan`;
  `'worktree-write'` and absent → it never appears; `PWD`/`OLDPWD` equal
  `req.cwd` in all four cases; the spawn log line reflects the actual argv
  (`$ opencode run --agent plan -m …` exactly for the restricted postures).

Not pinned here and carved by the ticket: no `WorkspaceProvider`
implementation, factory, or `--workspace` flag — T-022's single-provider
rule stands, and T-023 does not trigger its re-entry condition (a): the
reviewer's workspace stays the existing worktree lease, the planner's
scratch dir is plain `fs.mkdir` (not a provider), and the stage-5 read-only
verifier roles that would consume
`{ type: "disposable-clone-readonly" }` (spec §34 M5:2082-2094) remain
re-entry (a)'s owners. Also carved: §14.4 secrets/network allowlisting;
§6.6 RoleSpec / §11.1 `capabilities()` compile-time refusal machinery
(T-017's carve stands); `--jobs` spec `workspace`/`permissions`/`role`
fields stay refused (src/scheduler.ts); OS-ACL/container isolation
(§14.3's other mechanisms); worker-tier tool restriction (builders keep
full tools — §14.1:1014 is satisfied by worktrees); brief-output content
sanitization (a different threat class — §14 governs execution capability,
not output content); custom-agent config hardening beyond the built-in
plan agent, and any restricted-agent CLI flag. The restricted postures'
residuals are recorded in Known issue #6's rewrite, below.

**T-025 extension of these pins, and the stale premise reconciled.** T-023's
premise — "MachineWorker never receives a non-default policy: planner/reviewer
cannot dispatch through it" (T-023's What §1) — was true of T-023's own
change-set and is superseded since T-025: a machine advisory role is reachable
(`--planner-worker`/`--reviewer-worker machine` + the role's command flag), so
a machine advisory dispatch CAN now carry a non-default policy. The S1 pins
here are per-site (what each dispatch site sends) and survive per-role adapters
unchanged; Gate 1.21's S1 extends them to the per-role world (each role's
dispatches carry the same policy and cwd posture through that role's own
adapter). The §14.3:1039 honor-or-refuse interaction this poses for
`MachineWorker` is settled in Gate 1.21's section, below.

## Gate 1.21 — per-role harness selection (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-per-role-harness.mjs
```

Pins T-025 (spec §6.6:397-415 — "Roles are configuration, not classes" — with
`RoleSpec.defaultWorker: WorkerSpec` :407; §11.1:875): the two advisory roles
get their own adapter selection. Four new CLI flags (src/cli.ts):
`--planner-worker <id>`/`--reviewer-worker <id>` — a `WORKER_ADAPTERS` registry
id, defaulting to the `--worker` value, so absent flags leave all three roles
on the run-level adapter with byte-identical default-mode stdout and report —
and `--planner-command <json>`/`--reviewer-command <json>` — the machine
command source for the advisory roles, a JSON argv string parsed and
shape-validated at parse time (non-array, non-string or empty entries refused,
mirroring the scheduler's `command` shape rules, src/scheduler.ts). A command
flag is **required iff that role resolves to `'machine'`** and **refused on a
role resolving to `'opencode'`** (the T-017 pairing rule at role level).
Validation sits early in `main()` — before the `--jobs` spec read, repo
validation, the checkout lock, or any artifacts dir (the T-007/T-017
zero-side-effects refusal pattern): unknown per-role id (the registry message
verbatim), role → machine without its command, command on a non-machine role.
Construction stays in `runPipeline`: a non-default role builds its adapter
through the same `createWorker(id, opts, command)`; a default role passes
nothing. `SkeletonOptions` (src/runner.ts) gains optional
`plannerWorker`/`reviewerWorker`, resolved as `opts.plannerWorker ??
opts.worker` / `opts.reviewerWorker ?? opts.worker` — direct `runSkeleton`
callers (the Gate 1.8/1.10 checks) compile and behave unchanged. The planner
phase uses the resolved planner adapter on both execute calls (initial +
bounded repair share `baseReq`); `runReview` uses the resolved reviewer
adapter on both calls. Composition: the reviewer selection applies in BOTH
modes (review runs post-gates in both); the planner flags are
accepted-but-ignored in `--jobs` mode (the planner is skipped there — the
`--planner-model` precedent), documented in usage/README. **The worker leg is
untouched**: the synthesized jobs' `worker: opts.worker`, the dispatch, and
`--jobs` per-job worker resolution stay exactly as they were. The run header's
`workers:` line names non-default roles (`planner=machine reviewer=machine`);
with no new flags it is byte-identical. No report shape change and no
adapter-id fields on `PlannerReport`/`ReviewReport` — which adapter served a
role is evidenced by the per-role log argv headers
(src/worker/opencode.ts, src/worker/machine.ts) and by this gate's S1
dispatch capture, so the vendored Gate 1.6 fixtures stay green unchanged.

The standing run-level `--worker machine` parse-time refusal is **not
flipped** — no run-level machine command for the worker tier. Gate 1.17 S6
stays green with its message pinned verbatim (S2, below); nothing an existing
gate pins changes, so no T-018/T-019 flip discipline is owed.

No existing gate can pin per-role dispatch — the fast tier never runs the
pipeline and Gate 2 spends model tokens (the recorded T-007/T-009 argument) —
so this gate has three legs, all token-free:

- **S1 — fake-adapter dispatch capture** (the Gate 1.8/1.10 pattern:
  `runSkeleton` driven with fake `WorkerAdapter`s + fake gates against
  throwaway fixture repos, one per scenario). Flags absent ⇒ the single fake
  serves every planner, reviewer, and worker dispatch (its recorded traffic
  is exactly the three classes, nothing elsewhere) and the report is
  today's. `plannerWorker`/`reviewerWorker` present ⇒ planner initial + the
  bounded repair attempt hit the planner fake and only it; reviewer initial +
  repair hit the reviewer fake and only it (both candidates, repair keyed on
  the runner's repair prompt); worker dispatches keep hitting the run-level
  fake; no cross-contamination. This leg also **extends the Gate 1.20 S1
  pins to per-role adapters**: planner dispatches through the planner fake
  still carry `'artifact-only'` at a dispatch-time-existing scratch cwd under
  `<artifactsDir>/planner-scratch` (neither the repo nor inside it), reviewer
  dispatches through the reviewer fake still carry `'worktree-read'` at the
  candidate workspaces, worker dispatches still carry `'worktree-write'` at
  the worktrees; `report.json` key sets exact at every level (no new fields).
- **S2 — real-CLI refusals, exit 1, zero side effects** (no artifacts dir,
  no `locks/` after each — the Gate 1.17 S6 harness shape, each through the
  real CLI with a non-git `--repo` so the refusal provably precedes repo
  validation): unknown `--planner-worker`/`--reviewer-worker` id (the
  registry message verbatim); a role resolving to machine without its
  command flag (both roles); a command flag on a role resolving to opencode
  (default-resolved and explicitly); malformed command JSON (not JSON, a
  JSON string, an empty array, a non-string entry, an empty-string entry);
  and the unchanged `--worker machine` refusal re-pinned **verbatim** (the
  proof the standing contract was not flipped).
- **S3 — token-free machine-reviewer end-to-end**: a real-CLI `--jobs` run —
  one machine worker job (marker-file gate) plus `--reviewer-worker machine
  --reviewer-command` whose command echoes a valid observations object, and
  the planner flags accepted alongside: the candidate PASSes its real gate
  (`workerOk`, `diffBytes > 0`, `passedAllGates`), review fires post-gates
  through the reviewer's own machine adapter, `review.json` carries the
  parsed observations with the configured reviewer model string recorded
  verbatim though no model ran (the machine.ts honesty fields), and
  `reviewer.log` carries the machine argv header — never an opencode argv.
  The planner flags are accepted-but-ignored (no `planner.log`, no planner
  block in the report), and the worker leg's evidence is untouched (the
  candidate `worker.log` carries exactly its own machine argv, never a role
  command). The first token-free run with a non-empty advisory review —
  before T-025 a token-free run needed `--no-review` (T-017).

**Machine-advisory honesty, recorded here (docs only — no adapter file
changes, the ticket's carve).** A machine advisory role's output is
`parseBriefs`/`parseReview`ed advisory evidence — briefs and observations,
never verdicts (decisions.md 2026-10-10: gates decide survival; the ladder is
byte-identical) — distinct from a CommandProbe's post-gates `EvidenceBundle`
(the worker-vs-probe seam drawn in src/worker/machine.ts). The §14.3:1039
honor-or-refuse interaction T-023's seam poses for a machine advisory
dispatch is settled as follows: the dispatch carries the role's non-default
policy (`'artifact-only'` planner / `'worktree-read'` reviewer), and
`MachineWorker` neither translates nor refuses it — it has no model harness
and no tool layer, so there is no restriction mechanism to silently downgrade
(the no-silent-downgrade contract targets adapters that WOULD run a
restriction-capable harness at an unrestricted posture). What the policy
means for a machine advisory dispatch is engine-side and stands unchanged:
the `'artifact-only'` cwd (the planner scratch dir — no repo checkout as
cwd) and the `'worktree-read'` cwd (the disposable candidate worktree, whose
diff and gate evidence were captured before review runs) are the runner's
choices, exactly as for the OpenCode adapter; containment for an
unrestricted machine command is the same capture-before-review ordering +
disposable-workspace + content-parsed-advisory-output containment Known
issue #6 records for the plan agent's `bash: true` residual. This is a
documented contract settlement, deliberately not a behavior hidden in an
adapter file; a successor ticket that prefers the strict spawn-time refusal
instead must flip S3 (and S2's pairing rules) explicitly — the T-018/T-019
discipline.

Not pinned here and carved by the ticket: the worker-tier half — run-level
`--worker machine` WITH a run-level machine command (the flip that must
explicitly invalidate Gate 1.17 S6 per the T-018/T-019 discipline, and which
changes `--goal` worker semantics: token-free goal-mode runs, the NO-OP
ladder against machine output); §6.6 full `RoleSpec` machinery (prompt refs,
`PermissionPolicy`, `WorkspacePolicy`); §11.1 `capabilities()`/compile-time
role-vs-capability refusal (T-017's and T-023's carves stand); any change to
`src/worker/opencode.ts`, `src/worker/machine.ts`, the `WorkerAdapter` seam,
`src/parse.ts`, `src/scheduler.ts`, gates, or workspace handling (T-022's
single-WorkspaceProvider rule untouched); model/role semantics (planner/
reviewer models remain pure CLI configuration); zero new npm dependencies.
A machine planner under `--goal` mode rides the same flags and the same S1
dispatch pins (the flags are symmetric), but its end-to-end face is not
separately pinned — the delivered capability pinned end-to-end is the
machine REVIEWER (S3), the one that makes a fully token-free run with a real
advisory review reachable. Gate 2 runs once at landing (`src/runner.ts` is
on the trigger list), recorded in T-025's Landed section — not a permanent
extension. Gate 3 n/a (no adapter file is added or changed; the PWD/OLDPWD
pinning is untouched — the T-009 precedent for runner/cli-only changes).

## Gate 1.22 — bounded R&D loop (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-rounds.mjs
```

Pins T-030 — the bounded R&D loop (ROADMAP stage 6's loop demonstrably
running end to end; spec §34 M6's composition of landed parts with M8's
feedback edge worn early, bounded n=2) and the T-012-reserved packet→prompt
composer at its smallest (the reservation `src/context.ts:101-104`,
discharged):

- **the `--rounds <n>` CLI flag** (src/cli.ts): default 1 = today's
  single-pass behavior byte-for-byte; integer 1..2 (capped at 2 this
  slice); values `< 1`, non-integers, `> 2`, and `--rounds 2` combined
  with `--jobs` (no planner exists in DAG mode) or `--no-planner` refuse
  at parse time — before repo validation, the checkout lock, or any
  artifacts dir exists (the T-007 zero-side-effects refusal pattern; the
  whole argv is read first, so flag order never matters);
- **the round composer** (`src/rounds.ts`): pure, deterministic, zero model
  knowledge, zero I/O. For each gate survivor of the finished round it
  builds ONE `'survivor-evidence'` ArtifactRecord whose content is a
  deterministic rendering of the brief, `diffBytes`, the per-gate results
  including the recorded `GateResult.command` (evidence only, never a
  verdict), the advisory review observations, and the probe summaries —
  fed through the existing `buildContextPacket` under a plan whose
  `distillation` block declares EVERY record the builder sees (the T-014
  contract armed). The records carry NO `sourceRefs` — primary evidence,
  not distilled claims: the composer produces NO DistillationReport
  (there is no distiller role; `parseDistillationReport` stays the
  reserved enforcement point for that successor, T-013:44-46), and every
  record rides Layer 1 (a mandatory type query — survivor evidence is
  never budget-trimmed out of the packet). The packet renders into a
  fixed-framing text block (header naming the finished round and the
  packet fingerprint, entries in packet order, footer);
- **the round loop** (`runSkeleton`, src/runner.ts): round 1 is today's
  mechanics verbatim. When n=2 and round 1 produced ≥ 1 survivor, the
  block is written under the run artifacts dir
  (`round-2-context-block.txt`) and round 2 re-enters `runPlannerPhase`
  UNCHANGED — same artifact-only scratch-dir posture; the block rides the
  prompt as an optional section (`plannerPrompt`'s output without it is
  byte-identical to the pre-T-030 text) — prompt text, never capability;
  `parseBriefs` parses round-2 briefs exactly as round-1's, and the
  candidate wave repeats through the same scheduler loop on fresh state.
  Round-2 candidates lease fresh worktrees pinned to the SAME `baseSha`
  (survivor diffs are planning evidence, never stacked patches —
  candidate lineage is M8) with deterministic distinct ids `<survivorId>-r2`
  (SPEC_ID_PATTERN-safe), so branches, store rows, and report entries
  never collide across rounds. One runId, one checkout lock held across
  both rounds; `dispatch.jsonl` keeps its line shapes — round 2 is just
  more dispatch lines after the one run header. Round-2 planner evidence
  writes `planner-r2.log`/`planner-r2-raw.txt` (round 1's stays at
  today's paths); the report's `planner` block is the last executed
  planner phase's (round 2's when the loop ran — the briefs the final
  wave rode). Round 2 is recorded not-executed — never fabricated — when
  there is no round-1 survivor or no planner phase to feed (--jobs,
  --no-planner; the CLI refuses both combinations, direct callers get the
  record);
- **the report shape** — additive `rounds` block (the
  `CandidateReport.probes` pattern), present only when `--rounds 2`;
  absent otherwise, so default-mode report.json is unchanged. Per round:
  `round`, `executed`, `survivorIds`; a composed round (round ≥ 2 that
  executed) additionally carries `packetFingerprint` and
  `renderedBlockPath` (round evidence lives under `C:\swarm\<runId>\`
  per decisions.md 2026-10-10 run-root);
- **the fingerprint reconciliation** (the `src/context.ts:101-104` duty,
  discharged and documented in src/rounds.ts's header): the packet
  fingerprint (§7.7 narrowed — sha256 over canonical JSON of
  `{ model, planHash, selected }`) and T-007's `input_context_hash`
  (sha256 over brief + model + the composed builder prompt with the
  workspace-path line excluded) are two DISJOINT provenance hashes that
  answer different questions and never derive from each other — the
  packet fingerprint hashes the context a planner sees (workspace-free);
  `input_context_hash` hashes one worker attempt's composed input modulo
  its lease path (packet-free). On a rounds-carrying run both are
  recorded side by side — `RoundRecord.packetFingerprint` beside every
  attempt's `inputContextHash` — neither subsuming the other, neither
  ever a verdict input (decisions.md 2026-10-10: machine gates decide
  survival).

No existing gate exercises two rounds, so this fast-tier loop check is not
optional. Four legs, all token-free:

- **A — composer fixtures** (the Gate 0.5/1.13 hand-built-input pattern):
  determinism — two compositions from identical inputs give byte-identical
  rendered blocks and packets (stable key order, no wall clock), and the
  permuted candidates array composes identically (the id-ascending canon);
  exactly one record per gate survivor (the eliminated never becomes
  evidence) carrying brief/diffBytes/per-gate results with the recorded
  command/review observations/probe summaries; the plan mandatory-typed,
  artifact-ref, its `expectedArtifactIds` declaring every record; no
  record carries `sourceRefs`; the packet's fingerprint the §7.7-narrowed
  shape (64-hex, the four producerless components null); the rendered
  block fixed-framing; the `<id>-r2` scheme charset-safe per
  `SPEC_ID_PATTERN`; source pins (the Gate 1.12 S2 precedent) — the
  composer never imports `parseDistillationReport`, documents the
  `input_context_hash` relationship at source level, and the context
  module header records the discharge.
- **B — fake-adapter capture** (the Gate 1.21 S1 pattern: `runSkeleton`
  with fake adapters + fake gates against a throwaway fixture repo):
  the planner fake served exactly two dispatches — round 1's prompt
  without the block, round 2's prompt carrying the EXACT recomputed
  rendered block as a verbatim substring, naming survivor ids, briefs,
  gate results with commands, and review observations (round 1's prompt
  carries none); the report on disk has exactly today's top-level keys
  plus `rounds`, the entries exactly the ticketed fields, the recorded
  fingerprint equal to the independently recomputed composition's, and
  the block file byte-identical to the recomputation; candidates are
  both waves in order; round-2 worktrees exist at the same baseSha;
  `dispatch.jsonl` carries ONE run header with round 2 as more dispatch
  lines on `swarm/wt-<id>-r2` branches; **gates decide every round** —
  a round-2 zero-byte diff is a NO-OP elimination regardless of what the
  planner saw (its vacuous gate PASSED and the diffBytes leg still
  eliminated it, never reviewed — AGENTS.md #7; no review observation or
  probe value participates in any verdict); round-2 attempts keep their
  T-007 `inputContextHash` values beside the packet fingerprint; and an
  n=1 flag-absent drive carries NO rounds block and today's exact key
  sets.
- **C — token-free REAL-CLI 2-round loop** (the Gate 1.17 S5 / Gate 1.21
  S3 machine-worker pattern): a real CLI run with `--rounds 2` and
  `--planner-worker machine --planner-command <json>` +
  `--reviewer-worker machine --reviewer-command <json>`; the opencode
  worker tier exercised token-free through the existing `--opencode-bin`
  override pointed at node with the stub committed AS the repo-root file
  `run` — the adapter spawns `<bin> run -m <model> <prompt>` in the
  leased worktree and node resolves the entry `run` against its cwd, so
  the fixture repo's own stub executes in every candidate worktree (no
  adapter file touched; the engine stays harness-agnostic). Asserts: exit
  0 with the NO-OP elimination as a verdict (mechanical completion); the
  rounds block exactly ticketed; the recorded fingerprint equal to the
  full re-derivation from the run's own round-1 candidates and the block
  on disk byte-identical to the recomposition; the captured round-2
  `planner-r2.log` (the machine adapter logs `req.prompt` verbatim as a
  provenance header) carrying round-1 survivor ids, gate results with
  commands, review observations, and the packet fingerprint — while
  round 1's `planner.log` carries no block; the store accepted the
  rounds-carrying report (no `PERSISTENCE FAILED`); an n=1 real-CLI
  `--rounds 1` run (a separate sandbox repo, so the two runs' `swarm/*`
  branch namespaces cannot collide) with NO rounds block and today's
  exact keys; and the n=2 disposal face — before disposal both rounds'
  branches exist side by side (`swarm/wt-c01`…`swarm/wt-c02-r2`), then
  `clean --run <id> --force` exits 0 disposing EVERY round's worktrees
  and `swarm/*` branches (only `main` remains in `worktree list`), with
  the evidence kept (report.json, dispatch.jsonl, every round's
  diff.patch — the no-op's empty diff.patch included — and the block).
- **D — CLI refusals** (exit 1, zero side effects, each through the real
  CLI with a non-git `--repo` so the refusal provably precedes repo
  validation, no artifacts dir and no `locks/` after each):
  `--rounds 0`, `--rounds 3`, `--rounds 1.5`, `--rounds abc`,
  `--rounds 2` with `--jobs`, `--rounds 2` with `--no-planner`; and
  `--help` documents `--rounds` with its default and bounds.

Not pinned here and carved by the ticket: no Sol verifier per surviving
candidate (spec §34:2111 — the Codex adapter, stage 5); no
researcher/distiller/synthesizer roles (the job model has builder jobs
only; read-only researchers are decisions.md 2026-10-18 clone re-entry
condition (a) — this slice avoids the clone question entirely: the only
model round added is the planner's, riding the existing artifact-only
posture); no early stop, no in-run approval pause (M8 vocabulary with no
producer); no candidate lineage/generation records and no
`context_plans`/`context_packets`/`artifact_lineage` store tables (the
store keeps persisting verdicts only — the Gate 1.6 extension above); no
new WorkerAdapter or harness code and no execution-policy change
(decisions.md 2026-10-10 — both honored by construction); n ≤ 2; no
memoization; and no claim that a feedback round
IMPROVES outcomes — that is the empirical question the first real run
exists to answer, recorded in T-030's Landed section. (The "no adversarial
probes" carve this paragraph carried at T-030's landing dropped in T-032's
change-set: adversarial probes exist since T-032 — evidence-only, never a
verdict input, no loop — pinned by Gate 1.15's T-032 legs above, exactly
the move T-030:95's carve anticipated.) Gate 2 is mandated
for this change-set (`src/runner.ts` and report shape are on its trigger
list): `verify:full` runs a real 2-round loop — see Gate 2's section; the
run itself is the driving run, recorded in T-030's Landed section. Gate 3
n/a (no adapter change, no new harness to probe).

## Gate 1.23 — run dashboard (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-dashboard.mjs
```

Pins T-034 (the first Milestone-7 slice, spec §26.1:1686-1701 run overview,
§26.2:1703-1715 DAG view, §26.6:1770-1772 approval queue; ROADMAP stage 7)
and — since T-035 — the per-job drill-down over the recorded store (spec
§26.2:1703-1715's node-click drill-down, its store-backed text/table
no-JS slice) and — since T-037 — the per-run context page (spec §26.4's
honest consumer slice): the standalone `npm run dashboard -- [--port <port>] [--db <path>]`
(`src/dashboard.ts`, the clean/integrate/dag/approvals standalone-entry
pattern) serving a localhost-only, read-only HTML view over the schema-v5
store. **Zero new npm dependencies** — plain `node:http` serving plus
`node:sqlite` reads; `package.json` gains exactly the one `dashboard` script
and nothing else. No engine code is touched: the dashboard is a consumer of
recorded state, it knows no harness, spawns no models, spawns no processes,
and touches no repository (decisions.md 2026-10-10: gates decide survival —
the pages render recorded verdicts and produce none). All read routes open
the DB `{ readOnly: true }` (the src/dag.ts:69-98 pattern); `--db` defaults
to the `C:\swarm\refinery.db` literal shared by src/cli.ts/src/dag.ts/
src/approvals.ts; a missing DB file refuses startup with a clear message and
never creates a refinery.db as a side effect (the T-006/T-008 refusal
pattern); binds 127.0.0.1 only, no auth (operator-local tooling, the same
trust domain as the CLI precursors). The gate ingests the vendored fixture
(`scripts/fixtures/report-real.json` → run 20261011022419) into fresh temp
DBs (the Gate 1.6/1.9 pattern) and drives the server over stdlib `fetch` on
an ephemeral localhost port (the T-024 WebProbe client precedent) —
token-free. It asserts:

- **the CLI faces**: `--help` documents `--port` and `--db` with its
  `C:\swarm\refinery.db` default, and (T-035) the drill-down route
  `/run/<id>/job/<jobId>`, and (T-037) the context route
  `/run/<id>/context`; a missing DB file refuses with exit
  non-zero naming the path, nothing on stdout, and no DB file created;
  `--port` with a non-integer or an out-of-range value refuses naming the
  flag; an explicit `--port` is honored; the server's bound address is
  `127.0.0.1`;
- **`GET /`** renders the ingested fixture run with its repo/base_sha/
  goal/model/started_at/finished_at equal to the `runs` row, its
  survivor/eliminated counts equal to the `candidates.passed_all_gates`
  rows, and the honesty label on the page itself: ingested post-hoc state,
  never live (the store has no run-status column; ingest is post-hoc and
  derived, so the pages show only ingested runs' derived verdicts);
- **`GET /run/<id>`** renders every candidate id with its
  `passed_all_gates` verdict, every `gate_results` row (gate name, pass/
  FAIL, exit code, duration — equal to the temp DB's rows), every
  `artifacts` evidence pointer (path / size_bytes / content_hash, with
  NULL rendered as "missing", never fabricated — AGENTS.md #7), the
  `probe_runs` rows (bundle_path; pinned on a hand-built probes variant of
  the fixture — the elim-variant pattern, sandbox-local bundle file), and
  the run's recorded DAG from `phases`/`jobs`/`job_dependencies`, whose
  section EQUALS src/dag.ts's own read of the same DB — cross-checked
  against `npm run dag -- --json` (the Gate 1.7 surface) over the flat
  fixture AND the hand-built schedule variant (two real phases
  foundation → app with the expanded edge c02 -> c01, the check-store
  construction); every DAG job id is (T-035) a plain `<a href>` link to
  its drill-down page (zero client-side JS — the expected markup carries
  the anchor); an unknown run id renders 404 carrying
  `no recorded run '<id>'`;
- **`GET /run/<id>/job/<jobId>`** (T-035) — every value a direct SELECT on
  the same temp DB, opened `readOnly`; nothing recomputed, nothing from
  report.json, no verdict produced. Pinned per face:
  the **jobs row** (phase, worker, model, brief, expanded dependencies —
  equal to the DB row) on the flat fixture AND the hand-built schedule
  variant (the gate keeps exercising it: no scheduled `--jobs` run has
  ever been ingested — every `phases` row in the live
  `C:\swarm\refinery.db` is the flat 'main' derivation, queried at T-035
  authoring), where the row carries the REAL phase id and expanded
  dependencies;
  the **verdict** — the `candidates.passed_all_gates` row (`job_id` IS the
  candidate id in the derived DAG), rendered survivor/eliminated equal to
  the machine verdict, including the eliminated face on the elim variant
  (its failed gate renders FAIL with the recorded exit code);
  the job's **`gate_results` rows** (gate name, pass/FAIL, exit code,
  duration, output tail — equal to the DB rows, a NULL exit code rendering
  "missing", never fabricated);
  the job's **full `attempts` history** on a hand-built retried variant
  (the check-store retried construction: two attempts, attempt 2 mirroring
  the real final values, c02 keeping the pre-T-007 zero-row shape) — one
  row per attempt with state/started_at/ended_at/input_context_hash equal
  to the DB row, `prompt_version` rendering verbatim where recorded
  (64-hex on attempt 2) and "missing" where null (attempt 1), the
  producer-less columns (`process_identity_json`/`worker_session_id`)
  rendering "missing", and `output_artifacts_json`/`failure_json` as
  recorded (verbatim JSON, HTML-escaped);
  the job's **`probe_runs` rows** (probe, scenario, outcome, duration,
  bundle_path, equal to the DB row) — pinned only on the hand-built
  probes variant: the live store currently holds 0 `probe_runs` rows
  (stated, not smoothed);
  the flat fixture (which predates attempts and probes) renders
  "(none recorded)" rows — zero rows, nothing fabricated;
  the **never-dispatched face**: a job recorded with empty
  worker/model/brief and NO candidate row (the T-009/T-031 derivation, on
  a hand-built variant adding a `dispatchIndex: null` job) renders
  never-dispatched — no verdict, no gates, no attempts, no probe runs
  rendered, nothing fabricated (AGENTS.md #7) — while its dispatched
  siblings keep rendering their full pages; and an id with **no `jobs` row
  at all** (unknown job, or unknown run) renders 404 carrying
  `no recorded job '<jobId>' in run '<runId>'`. Two standing pins ride the
  same fetch log: **zero client-side JS** — every page the gate drives
  (drill-downs included) is swept for `<script>` tags, zero allowed — and
  **POSTing a drill-down route is refused 405** with the DB byte-identical
  after (the route is a read; `POST /approvals/decide` stays the ONLY
  write); and (T-037) the run page links `/run/<id>/context` with a plain
  `<a href>` and the drill-down's attempts section links it too (pinned on
  the retried variant, the only fixture with attempts);
- **`GET /run/<id>/context`** (T-037) — spec §26.4's honest consumer slice,
  same surface and patterns as the drill-down: 200 for a recorded run,
  non-GET refused 405, an unknown run 404 carrying
  `no recorded run '<id>'`. Three faces, nothing fabricated (AGENTS.md #7):
  the **store-backed face** — the run's `attempts` rows (`job_id`,
  `attempt_number`, `state`, `started_at`, `input_context_hash`) EQUAL to
  direct read-only SELECTs on the same DB, grouped per job with each job
  linked to its existing drill-down; pinned on the retried variant (2 rows,
  both `c01`, c02 — the pre-T-007 shape — rendering NO job group), while
  the flat fixture (which predates attempts) renders "(none recorded)";
  the **report-backed face**, pinned against hand-built rounds-report
  variants (ingest binds `runs.report_path` from the `reportPathOf`
  heuristic — `planner.rawOutputPath` → `<dir>/report.json` — so a variant
  whose report FILE is written at the derived path exercises the
  report-present face): the report's `rounds` block rendered equal to the
  recorded rounds — round 1 executed with its survivorIds and no packet
  fields ("missing", not fabricated); round 2 executed with the
  `packetFingerprint` VERBATIM (never recomputed) and the
  `renderedBlockPath` as verbatim pointer text, asserted present as a
  `<td>` cell and never inside an `<a href>` (§26.5 stays carved — the
  block content is never served or linked); an `executed: false` round
  record (the runner's no-survivor/no-planner shape) renders "not
  executed", never fabricated as executed; the section carries the honesty
  label `report.json read via runs.report_path — not store rows` on every
  face, and a variant whose `report_path` points at a nonexistent file —
  the live state of most ingested runs — renders exactly that
  (`report file missing at <path>`) with the store-backed face still
  standing (label, "(none recorded)", both hash labels, all markers);
  the **producer-less §26.4 face** — every spec §26.4 field (token budget,
  mandatory/selected/distilled/excluded artifacts, source chain, plan/
  packet records) rendered as an explicit `no producer` marker (all seven
  asserted on every context page the gate drives), never fabricated
  structure; and the two hash kinds render under DISTINCT labels,
  `attempts.input_context_hash` as the worker-attempt input hash (packet-
  free) and `rounds[].packetFingerprint` as the composed context packet
  fingerprint (attempt-free) — both labels asserted on every context page,
  the disjointness per the src/rounds.ts header, never one kind of value;
- **`GET /approvals`** renders exactly `listPendingApprovals`'s rows —
  every pending row's run/phase/job/state/requested_at/requested_by equal
  to a direct store call on the same temp DB (seeded via the real
  `requestApproval`, two pending rows on the schedule variant), with the
  row count asserted (no extras), and an empty queue saying so;
- **`POST /approvals/decide`** — the dashboard's ONLY write, operator-
  driven, through the store's `decideApproval` called verbatim (the T-008
  wall-clock scoping case): approve flips the row with
  `decided_at`/`decided_by`/note recorded and appends exactly one
  `APPROVAL_GRANTED` event at the row stamp (payload naming phase/job/
  decider); reject appends exactly one `APPROVAL_REJECTED` (the documented
  vocabulary extension) with `decided_by` defaulting to the OS username;
  each decided row drops out of the rendered queue and the empty queue
  says so; the decides touch nothing outside the approval rows and their
  two events (candidates/gate_results value-identical). Every store
  refusal surfaces as an HTTP 4xx CARRYING THE REFUSAL MESSAGE with
  nothing written — unknown run (404), unknown job (404), non-survivor
  (409, on the elim variant of the schedule fixture: the resurrect rule
  named), double-decide (409, the audit record named), unknown decision
  (400, the vocabulary named), missing form field (400) — row/event
  snapshots identical before and after the refusal block;
- **read-only proof, not assertion** (AGENTS.md #9): the DB file's sha256
  is byte-identical across ALL GET routes (/, /run/<id>,
  /run/<id>/job/<jobId>, /run/<id>/context — T-037: the report.json read
  touches no DB bytes —, the drill-down and context 404 faces, the refused
  drill-down and context POSTs,
  /approvals, the run 404
  face, / again — on the main fixture, the schedule variant, the retried
  variant, the never-dispatched variant, the probes variant, and the three
  T-037 rounds-report variants alike);
  the decide POST is expected to mutate and is not in the byte-identity
  set; and a write against a `readOnly`-opened handle throws — the Known
  issues #7 node:sqlite churn guard, same as Gates 1.7/1.9;
- **importing starts no server**: the module is imported dynamically under
  a wrapped `console.log`, and no startup banner appears — a module-level
  `main()` (observed once at authoring, red, and fixed with the entry-
  module guard before landing) would have bound the DEFAULT store path
  `C:\swarm\refinery.db` inside the check's own process, the exact
  consult-the-live-store accident the T-028 review round 1 fixed for
  integrate's fast-tier faces;
- **the dependency pin**: `package.json`'s `dependencies`/
  `devDependencies` blocks equal their recorded values (`opencode-ai`
  plus the three dev tools) and `scripts.dashboard` is exactly
  `tsx src/dashboard.ts` — zero new npm dependencies, flipping this pin
  requires its own decisions entry (the node:sqlite fallback posture
  below).

Not pinned here and carved by the ticket: §26.4's FULL context-inspector
page — the producer carve STANDS, and T-037 landed exactly the consumer
slice the carve predicted: `GET /run/<id>/context` renders the only
producer-backed per-run context data there is (the store's
`attempts.input_context_hash` rows and the report.json `rounds` block,
read via `runs.report_path` and honestly labeled as not store rows), with
every still-producer-less §26.4 field (token budget, mandatory/selected/
distilled/excluded artifacts, source chain, plan/packet records) rendered
as an explicit no-producer marker. Still BLOCKED ON A PRODUCER, not merely
unpaged: nothing persists
ContextPlan/Packet into the store (the ingest upsert binds
`jobs.context_plan_json` literal null among the §6.4 policy columns; the
only plan/packet JSON writer anywhere is the gate sandbox; no
`context_plans`/`context_packets`/`artifact_lineage` table exists), so the
page has nothing store-backed to render for them and renders markers
instead of fabricated structure; persisting it is an
engine/report-shape change owning its own Gate 2, and the full §26.4 page
is that producer ticket's consumer successor (T-012:149's CLI-precursor
carve stands for this sharper reason); §26.5 artifact viewer serving
contents (pointers only — T-037's `renderedBlockPath` is a verbatim
pointer, never served or linked; per-job artifact filtering also stays
carved —
the run page keeps its full artifacts table); §26.3 candidate comparison;
§26.7 retention/disk view (T-021:124's carve stands); §26.8 prompt
registry (T-029's carve stands); §26.2's interactive graph JS (the
drill-down links are plain `<a href>`); live status/auto-refresh (no
producer — ingest stays post-hoc and derived); §26.1's producerless
fields (token usage, disk usage, worktree count); dispatch order and
phase/job-status rendering (they live only in report.json's schedule
block — a later ticket may render them, honestly labeled as report.json
reads via `runs.report_path`); §34:2131's Sol screenshot-based UI
verification (needs the stage-5 Codex/Sol adapter, ROADMAP.md:17,
unlanded); auth or binding beyond 127.0.0.1; any engine/store write beyond
the existing `decideApproval`. The dashboard rides the store's engine —
`node:sqlite` is experimental on Node 22 (Known issue #7, benign
stderr warning); the named fallback (`better-sqlite3`) would be a new
dependency and its own decisions entry, deliberately not this slice.
Gate 2 is not triggered: the change-set touches nothing on the trigger
list (src/runner.ts, adapters, gates, workspace handling, report shape)
— the T-006/T-008/T-012 standalone-consumer precedent, extended to
T-035's consumer-only drill-down and T-037's consumer-only context page
(a report.json READ through the store's recorded `report_path` handle,
no report-shape change; the moment persistence is wanted instead of
rendering, that is the producer ticket and it owns its own Gate 2 run).
Gate 3 n/a (no adapter; the dashboard
spawns no harness, so there is nothing to PWD-probe).

## Gate 1.24 — bounded gate-failure retry (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-gate-retry.mjs
```

Pins T-038 (spec §24:1462's "unless a bounded repair policy applies",
§30:1893's "retry same worker once"; **decisions.md 2026-10-21** — the entry
this change-set lands, which rewrites the re-roll prohibition's scope inside
the 2026-10-10 machine-gates decision along the blind-vs-informed line:
blind re-rolls banned unchanged; ONE feedback-informed gate retry permitted
under the flag; the feedback is the gates' own recorded output — no model
composes or adjudicates it; the same Gate objects re-run unchanged on the
retry; both legs recorded; the final attempt's verdict stands): the
run-level `--gate-retry` flag (src/cli.ts, a plain boolean — no numeric
knob, the `RetryPolicy` carve posture) grants each candidate exactly one
additional attempt when its worker succeeded, the captured diff is
non-zero, and at least one machine gate failed. The retryable leg's failure
record is `reason: 'gates-failed'` (state `'failed'`) with its
`GateResult[]` attached attempt-scoped (`Attempt.gateResults`, present ONLY
on a non-final leg that ran gates) and persisted as evidence files; the
composed brief — original brief + the captured diff (char-capped at
`MAX_DIFF_CHARS` = 30 000, the reviewer-prompt precedent) + per failing
gate its name, recorded command (`GateResult.command`, T-027), and
`outputTail` (the 4000-byte tail) + the worker's attempt summary — is
written to the retry attempt's evidence dir (`retry-brief.txt`), hashed as
`gateRetry.fingerprint` (sha256 of the exact text, the T-030
`packetFingerprint` pattern), and wrapped VERBATIM into the retry attempt's
builder prompt (that attempt's `promptVersion` hashes the wrapped bytes —
one composition, two consumers). `CandidateReport.brief` stays the ORIGINAL
brief. The bound is one per candidate regardless of `--max-attempts`
(total attempts ≤ maxAttempts + 1: a candidate that burned attempt 1
mechanically and failed gates on attempt 2 still gets its one gate-retry —
the mechanical condition `attempts.length < maxAttempts` is untouched). The
run header carries `gateRetry: true` when the flag is set (absent
otherwise, so a flag-less header is byte-identical) and recovery derives
the retry bound from it. The check drives `runSkeleton` directly with a
fake `WorkerAdapter` + fake gates (the Gate 1.8 pattern) against throwaway
fixture repos, the real CLI with a token-free `machine` worker (the Gate
1.17 S5 pattern, `--db` at a sandbox store), and the real `recover` CLI
over synthetic dispatch evidence (the Gate 1.11 R5 pattern) — zero model
tokens. It asserts:

- **G1 — the flag fires exactly one feedback-informed retry** (the
  fake-adapter core drive, `plannerModel: null` — the `--no-planner`
  composition shape, where the original brief is the goal): a
  worker-succeeded, non-zero-diff, gate-failed candidate gets attempt 2;
  exactly two attempts, two worker executions; attempt 1 `state: 'failed'`
  with `failure.reason: 'gates-failed'` (exit 1, not timed out) and
  `attempt.gateResults` carrying all three gate results in job order
  (failing ones false); the SAME gate objects re-ran unchanged (execution
  order `build, lint, always-pass` twice — a retry never weakens, skips, or
  substitutes a gate); attempt 2 `state: 'succeeded'`, no failure record,
  NO attempt-scoped gateResults; attempt 2's values populate the report as
  the final attempt (worker ok, gates pass, diff non-empty,
  `workspacePath` = `wt/c01-a2`); `gateRetry` is exactly
  `{fromAttempt: 1, toAttempt: 2, gates: ['build', 'lint'], fingerprint}`
  (64-hex); the composed brief file exists in the retry attempt's evidence
  dir and sha256-hashes EXACTLY to the recorded fingerprint (the
  content pin: the brief provably contains every failing gate's name,
  command, and outputTail — asserted on the file text — plus the original
  brief, the captured diff, and the worker summary; it contains NO
  passing-gate output); attempt 2's `promptVersion` equals
  `sha256(builderPrompt(briefText, lease2))` recomputed in the check
  (never the engine's composition path alone); attempt 2's
  `inputContextHash` DIFFERS from attempt 1's (the brief differs — the
  hash is doing its job), both 64-hex; each attempt's `outputArtifacts`
  names its own paths including the brief file, all existing on disk;
  attempt 1's `diff.patch` captured the pre-retry leg's work;
  dispatch.jsonl keeps its line shapes (one run header with
  `gateRetry: true`, two dispatch lines on fresh leases `wt/c01` /
  `wt/c01-a2`, two ok completions with captured diffs — no new line
  shapes).
- **G2 — immunity faces** (flag set): a zero-byte-diff candidate is never
  retried (one attempt, the no-op elimination, no block, no attempt
  gateResults); a no-gates candidate is never retried (one attempt,
  terminal); worker-failed legs retry under `--max-attempts` exactly as
  before and never consume the gate-retry (fail-fail under maxAttempts 2 +
  the flag = exactly two `worker-failed` attempts, no block); the
  mechanical-then-gate-retry ladder (maxAttempts 2, worker fails once then
  fails gates then fixes) runs THREE attempts = maxAttempts + 1 with leg
  reasons `worker-failed`, `gates-failed` (attempt gateResults present),
  `succeeded`, and the `gateRetry` block naming the a2 → a3 leg; a FAILED
  diff capture is terminal (no captured diff = no feedback payload —
  exactly today's elimination).
- **G3 — final-attempt shapes byte-identical; flag-less runs unchanged**:
  gates failing on BOTH legs = exactly two attempts, the retry consumed, no
  attempt 3, the final attempt `succeeded` with failing candidate gates,
  eliminated with `passedAllGates: false`, `error` undefined — no new
  elimination vocabulary; a FLAG-LESS drive of the same scenario is
  today's behavior verbatim — one attempt, eliminated, NO `gateRetry`
  block, NO attempt-scoped gate fields, and a run header carrying NO
  `gateRetry` key (Gate 1.8's S6 pin — "gates-fail-then-pass is never
  re-rolled" — is the flag-less posture and stays green byte-for-byte; no
  existing assertion was weakened).
- **G4 — interactions**: `--rounds 2` (the shared-fake planner drive): the
  retry lives inside round 1's ladder (c01-a1 gates-failed → c01-a2
  survives), round 2 runs on the survivor (c01-r2), round ids and attempt
  ids never collide (`c01-a1`/`c01-a2` vs `c01-r2-a1`), one branch per leg
  across rounds (`swarm/wt-c01`, `swarm/wt-c01-a2`, `swarm/wt-c01-r2`), the
  rounds block records both rounds executed with the right survivorIds, and
  the retry brief file sits in the round-1 retry attempt's evidence dir;
  `--jobs` mode retries per-job through the same `runJob` (a scheduled
  two-job drive: the gate-failed job retries and survives with its block,
  the straight-through job records one attempt and no block).
- **G5 — the real CLI** (token-free `machine` worker end to end, the
  fixture's committed gate script deciding, the machine command's
  cwd-discriminating marker standing in for the converting fix):
  `--help` documents `--gate-retry`; a `--jobs --gate-retry --no-review`
  run exits 0 with the report on disk carrying both attempts (attempt 1
  `gates-failed` with attempt gateResults), the `gateRetry` block, the
  composed brief file hashing to the recorded fingerprint, and the
  dispatch.jsonl header carrying `gateRetry: true` (the header-line
  assertion through the real CLI); **the store leg** — the run ingested
  into a sandbox DB without loss: two `attempts` rows (`failed` with the
  gates-failed `failure_json`, then `succeeded`), one `gate_results` row
  (the FINAL attempt's), one `passed_all_gates` candidate row, and no
  `PERSISTENCE FAILED`; a flag-less real-CLI run of the same spec in a
  separate fixture repo is today's behavior (one attempt, eliminated, no
  block).
- **G6 — recovery derives the retry bound from the header** (synthetic
  dispatch.jsonl + the real `recover` CLI, the Gate 1.11 R5 pattern): with
  `gateRetry: true` and the retry UNCONSUMED, `attemptsUsed 1` of a
  declared `maxAttempts 1` is `retryable` (the bound is one attempt
  taller); with the retry CONSUMED — an ok completion with a captured
  non-zero diff followed by another dispatch, a shape only the retry leg
  can produce (a mechanical retry never re-rolls an ok completion) — the
  bound is `maxAttempts` again and 2 attempts is terminal
  `bound-exhausted` (the consumed leg's own crash reads recorded-running
  like any attempt); a header WITHOUT `gateRetry` keeps today's bound
  verbatim (1 of 1 is terminal — unchanged); consumed at maxAttempts 2 →
  2 of 2 terminal (no second retry owed); and the no-op verdict keeps
  precedence under the flag (ok + diffBytes 0 is terminal no-op, never
  re-rolled).

**The store's tolerance, named (the ticket's verified-in-ticket duty):**
the schema-v5 `attempts` table has no gate-results column, and this
change-set adds none; a pre-retry leg's `GateResult[]` rides the report
(`Attempt.gateResults`) and the attempt's evidence files as the durable
copy, while the leg's `gates-failed` FailureRecord persists through the
existing `failure_json` column. Ingest reads named fields only, so the
additive field is tolerated structurally — pinned behaviorally by G5b's
store leg (a retried candidate ingested without loss) and by Gate 1.6
staying green (its fixtures carry no gateRetry blocks, and the hand-built
retried variant is unchanged). The gap — attempt-scoped gate results are
not queryable store columns — is recorded here, never silent; a successor
that wants them queryable owns the schema change.

**Red bar (AGENTS.md #8), recorded before the flag's code landed:** against
the pre-change tree, this check ran with the flag's drives RED — the engine
ignored the unknown option and ran today's ladder exactly: 9 assertion
failures (`exactly two attempts recorded`, `attempt 1 failed with reason
gates-failed`, the attempt-scoped gate results, the gates-re-ran-unchanged
count, attempt 2's final-values faces, the `gateRetry` block shape, the
composed-brief faces) ending in
`ENOENT ... c01\attempt-2\retry-brief.txt` — no attempt 2, no block, no
brief. That ENOENT is thrown inside G1, so the crash aborts `main()` and
the check's G2–G6 legs NEVER EXECUTE in the red run — the immunity and
flag-less faces are not observed green there; their green is established on
the POST-change tree (G2, G3b, G5c above), and on the pre-change tree by
the old bar: `check-retry.mjs` (Gate 1.8) ALL GREEN in the same window,
whose S6 pins the pre-change posture verbatim ("a succeeded worker whose
gates fail is never re-rolled — exactly one attempt").

Not pinned here and carved by the ticket: per-job gate-retry policy in
`--jobs` specs (the spec's `retryPolicy` stays `maxAttempts`-only,
src/types.ts); numeric retry knobs; retrying `no-op`/zero-byte, `no-gates`,
or worker-failed legs under this flag (worker-failed stays T-007's); any
model involvement in composing or adjudicating the feedback (no model call
added — the diagnostician is a template, which is why no model-verdict
carve-out is needed); gate modification between attempts; session
resumption (§11.1:875, `resumableSession` stays unproduced — a fresh
session per attempt as today); verifier findings in the retry brief
(T-040, the successor at the same composition seam); rounds beyond 2
(decisions.md 2026-10-20, T-033); reviewer or review-ordering changes (the
reviewer still sees only final `passedAllGates` candidates and the ORIGINAL
brief). Gate 2 is OWED for this change-set (the runner's verdict-adjacent
code + an optional report block are on its trigger list): the full tier's
real run carries `--gate-retry` — see Gate 2's section. Gate 3 n/a (no
adapter change; no new harness posture).

## Gate 2 — harness end-to-end (minutes, spends model tokens)

```bash
npm run verify:full
```

Runs a real two-tier skeleton run (GLM-5.3 planner + flash workers, 2
candidates per round) on a fresh fixture — **a real 2-round run since T-030**
(the ticket's mandate: this change-set touches `src/runner.ts` and report
shape, and the loop must demonstrably run on real model tokens; the
single-pass default stays pinned token-free by Gates 1.10/1.21/1.22) —
**and a real `--gate-retry` run since T-038** (the ticket's mandate: the
change-set touches the runner's verdict-adjacent code and adds an optional
report block; Gate 1.24 pins the flag's mechanics token-free). The flag is
INERT on any candidate whose gates pass first try — it fires only on a
worker-succeeded, non-zero-diff, gate-FAILED candidate, exactly once per
candidate — so it cannot weaken any assertion below: a retried candidate
still must pass every gate to survive, and the unchanged ladder still
decides. Worst-case runtime grows by one worker leg per gate-failed
candidate, inside the ceiling below. Whether a given real run produces a
genuine gate-failure → feedback retry → survival — or the retry fails to
convert — is the staged empirical question T-038 records as open, not
answered; both outcomes are honest Gate 2 outcomes, read off the run's
`gateRetry` blocks and verdicts and recorded in the ticket's Landed
section. **Recording pending at this change-set's landing:** the driving
run had not executed when T-038 was reviewed (verified 2026-10-21 — no run
dir under `C:\swarm\verify` carries the flag's dispatch header yet); the
ticket's Landed section holds the recording block its `report.json` path
and `gateRetry` outcome fill. Then
asserts on the artifacts:

- every candidate's worker exited 0 (both rounds' candidates),
- every diff is non-empty (`diffBytes > 0` — the NO-OP rule, AGENTS.md #7),
- every gate passed,
- the planner produced briefs (`planner.ok`, no fallback),
- the T-030 loop assertions: the `rounds` block records two EXECUTED
  rounds; round 1 produced survivors (a real 2-round run — otherwise there
  is nothing to pin); the composed round-2 packet fingerprint is recorded
  (64-hex); the rendered context block exists under the run artifacts dir
  and carries every round-1 survivor id; round 2 dispatched one
  `<survivorId>-r2` candidate per survivor; the report's planner block
  (the final wave's) has one brief per round-2 candidate; and the round-2
  planner INPUT demonstrably grew by the composed block — the adapter's
  argv log lines carry `<prompt: N chars>`, and round 2's N exceeds
  round 1's. (That the grown input carries the survivor evidence verbatim
  is pinned token-free by Gate 1.22(b)/(c), where the machine planner
  logs `req.prompt` itself; the real run pins the artifacts and the
  growth.) Gates decided both rounds via the unchanged per-candidate
  assertions below — every verdict from gates + diffBytes alone,
- every passing candidate was reviewed: `review.json` on disk, `review.ok`, observations
  well-formed with severity in {info, concern, blocker-advisory} (T-001),
- failing candidates were NOT reviewed — gates decide, review is advisory,
- the canonical repo is clean afterward (`git status --short` empty, only `main` in
  `worktree list`, no `swarm/*` branches left — both rounds' branches
  disposed through the clean command),
- no stray fixture files in this repo directory (the contamination check from the
  PWD-bug incident),
- the run's worktrees and branches are disposed through the clean command
  (`tsx src/clean.ts --run <runId> --run-root <verify root> --force`; `--force`
  is correct here — the run captured the evidence before disposal) (T-002).

The skeleton run's outer ceiling (scripts/verify.mjs, `execFileSync` timeout
**35 min**, T-030) bounds CI; it deliberately exceeds the runner's OWN
per-worker budget — `--timeout-min` default 15 (src/cli.ts), at which the
T-011 verified tree kill resolves a stalled worker into a FAILED candidate
verdict, plus the planner/gates/reviewer legs — so the runner, not
the verify harness, produces the verdict when a worker stalls, and Gate 2
fails on its `workerOk` assertion with a truthful line. Since T-030 the run
is a 2-round loop, so the runner's worst legitimate path is TWO such legs
(planner + 15-min worker + gates/review, twice — a stall in each round) ⇒
~34 min; 35 gives margin while still reaping a genuinely stuck run. At the
previous 8-minute ceiling one silent worker SIGTERM'd the whole run before the runner
could finish — an uninformative red that also skips report writing and
disposal, leaving stale worktree metadata, `swarm/*` branches, and a stale
checkout lock behind (observed once, 2026-10-19 — Known issue #12). The
historical single-pass happy path is 3–5 minutes; the loop adds a second
planner+worker+review pass over the same fixture. Wrapper-budget note for
whoever drives this gate: the ceiling raise is the same discipline as the
T-027 wrapper raise — a driving wrapper must sit ABOVE this inner ceiling
plus the fast tier, or it preempting the runner's stall path is its own
misconfiguration (Known issue #12's remedy paragraph applies verbatim).

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

T-017 reconciliation (spawn-cwd vs env.PWD): the probe exists because
OpenCode resolves its project directory from `env.PWD` (Known issue #1).
`MachineWorker` (src/worker/machine.ts) is immune by mechanism, not by
pinning: a plainly spawned child resolves its working directory from its
spawn cwd and merely inherits `env.PWD` without consulting it — the adapter
sets no env, and Gate 1.17 S1 asserts the child's real `process.cwd()`
equals `req.cwd` even with a bogus `PWD` planted in the inherited
environment. The probe below therefore exercises the OpenCode harness face;
the machine-worker face is pinned behaviorally by Gate 1.17 S1 (recorded at
landing in T-017's Landed section).

## Known issues

1. **OpenCode resolves its project directory from `env.PWD`, not the process cwd**
   (verified on opencode-ai 1.18.35, Windows). Any spawn must set
   `PWD`/`OLDPWD` to the intended cwd — done in `src/worker/opencode.ts`. First run
   before the fix: all three workers edited the orchestrator repo while gates blessed
   untouched worktrees and everything reported PASS; only zero-byte diffs exposed it.
2. **`opencode run` had no directory flag — refreshed for 1.19.3 (T-023).**
   The original claim (`--help` confirmed on 1.18.35) was "no directory
   flag — cwd + env pinning is the only mechanism". The vendored harness
   drifted to **1.19.3** and its `run --help` now shows `--dir` ("directory
   to run in, path on remote server if attaching" — re-verified first-hand,
   2026-10-18), so cwd + env pinning is no longer the *only* mechanism; it
   remains the one in use (ground rule 5 — `PWD`/`OLDPWD` pinning in
   src/worker/opencode.ts, Gate 1.20 S2), and the Gate 3 re-run against
   1.19.3 (required by the T-023 adapter change) is where a `--dir` switch
   would be evaluated, if ever. `opencode run` also auto-attaches to a
   running server if one exists (`--attach` in help); kill stale opencode
   processes before measuring.
3. **`glm-5.3-highspeed` is not in the plan.** The default `build` agent resolves to it
   when no `-m` is given and fails after ~70s of retries with exit code 0 through a
   pipeline. Always pass `--model`/`-m` explicitly; never trust harness defaults.
4. **Git Bash mangles variables inside double-quoted backslash paths** (`wt\$c` became
   a literal `$`). Use forward-slash paths or explicit literals in shell commands.
   Post-run disposal no longer touches this hazard at all: it goes through
   `src/clean.ts`, whose git calls are list-form (T-002).
5. **CRLF warnings from git on fixture files are benign** (`.gitattributes` normalizes;
   the fixture regenerates from scratch each run).
6. **Advisory-role capability restriction is mechanism-level now (T-023) —
   with recorded residuals.** The planner dispatches `'artifact-only'` from
   a disposable scratch dir under the run artifacts dir (never the target
   repo) and the reviewer dispatches `'worktree-read'` at the candidate
   worktree; the OpenCode adapter translates both to its built-in plan
   agent (`--agent plan`, "Plan mode. Disallows all edit tools.", `edit *
   → deny` — verified first-hand on 1.19.3). Supersedes this issue's
   original "prompt-reinforced only" posture (and T-001's prompt-only
   reviewer "for now", T-001:73); the prompt lines stay as
   defense-in-depth (decisions.md 2026-10-10). Honest residuals, observed
   in the same 1.19.3 dump:
   - The plan agent's tool list still includes `bash: true` —
     shell-mediated writes are NOT denied by the permission layer. The
     planner's scratch cwd is therefore load-bearing, not decorative: a
     bash `cd`/absolute-path escape remains possible in principle, bounded
     by the prompt naming no repo path and briefs being content-parsed
     engine-side. For the reviewer the same residual is contained by
     ordering: diff and gate evidence are captured before review runs,
     into evidence files, and the worktree is disposable
     (src/runner.ts: diff capture → gates → review → dispose).
   - Whether a headless non-TTY `opencode run` auto-denies `ask`-action
     permissions (the plan agent's `external_directory → ask`) —
     **observed first-hand 2026-10-20** (run 20261020053845's
     `planner.log`, the driving Gate 2 red): `permission requested:
     external_directory (C:\swarm\verify\20261020053845\*); auto-rejecting`
     — headless runs auto-reject, the containment works as designed. The
     recorded residual: the plan agent, dropped into the EMPTY planner
     scratch dir, burned attempt 1 exploring it (Glob 0 matches, then
     `Get-ChildItem` reaching outside → two auto-rejections → tool errors)
     and produced no JSON at all; the designed bounded repair attempt then
     produced a complete array whose one duplicated separator quote still
     failed to parse (fixed by Gate 0.5's last-resort separator repair, this
     change-set). Earlier 2026-10-19 observation (Known issue #12's run):
     BOTH restricted postures ran headless with `--agent plan` to
     completion — the planner's briefs parsed and the reviewer's
     observations parsed (`review.json` `ok: true`) — no permission stall
     occurred.
   - Output-content threats (e.g. a planner brief containing a hostile
     path) are a *different* threat class — §14 governs execution
     capability, not output content; sanitization is carved (T-023).
7. **`node:sqlite` is experimental on Node 22** — first use emits
   `ExperimentalWarning: SQLite is an experimental feature and might change at any
   time` on stderr (benign), and the API may churn across Node minors. Named
   fallback: `better-sqlite3` — a native dependency that would need its own
   docs/decisions.md entry against the 2026-10-10 "TypeScript on Node 22" decision.
   `src/store/index.ts` uses only DatabaseSync open/exec/prepare semantics.
   Gate 1's stderr therefore contains this warning; it is not a failure.
8. **Dead roots are never relied upon to reap descendants (T-011).** Whether
   `taskkill /T /F` reaches the descendants of an already-dead root (Windows
   reparenting) is unverified, and `killTreeVerified` does not depend on it:
   a root already gone at kill time is the reported result
   `{rootWasLive: false, verified: false}` — unverifiable, never silently
   success. Both in-run call sites (gate timeout, worker timeout) fire their
   kill while the root is alive by construction; recovery (T-010)
   verify-before-kills the pids it records.
9. **Descendant verification is Windows-only today (T-011).** Off-Windows,
   `killTreeVerified` is a best-effort root SIGKILL reported as
   `verified: false` (Windows-first repo, decisions.md 2026-10-10), so every
   POSIX timeout logs a `CLEANUP FAIL ... could not be verified` line by
   design. The Rust Windows Job-Objects helper remains the named fallback if
   `taskkill /T /F` ever proves insufficient (decisions.md 2026-10-10), and
   is the race-free successor to the pre-kill CIM snapshot's narrow
   snapshot-to-kill race (spec §15.3:1084 "Later").
10. **A verified-dead tree can still be REPORTED as a cleanup failure on a
   transient snapshot/kill hiccup (observed once, 2026-10-17, T-017 lane
   fast tier).** Gate 1.12 S1's `no cleanup failures on a verified kill`
   failed inside one full fast-tier pass while the same scenario's tracked
   gate-child and grandchild pids verified dead on the real process table
   seconds later — i.e. a `CLEANUP FAIL` line was recorded for a tree that
   did die. The failure direction is loud by design (T-011: an unproven
   kill must never read as verified), the line is evidence-only and never a
   verdict, and the stronger process-table assertions stayed green. Not
   reproducible: lane and main-checkout standalone runs green, main-checkout
   full fast tier green, lane fast-tier re-run green (no kill-tree code in
   that change-set). Benign until observed recurring; the exact triggering
   line (snapshot failure vs already-gone root vs survivor) is not captured
   by the check's output and was not diagnosed post-hoc.
   **2026-10-20 second observation (T-028 review round 2) — same class,
   still not reproducible.** The driving workflow's fast tier aborted at
   Gate 1.12 with verify.mjs's wrapper line `FAIL: kill-tree self-check
   failed: 1` (the per-gate wrapper `finish()`es on a failed gate, so
   Gates 1.13–1.21 did not run in that pass — aborting loudly is the
   tier's design; the response is a re-run, not a code change). The
   check's own per-assertion `FAIL: <name>` line was again not captured
   reviewer-side (lost in the tier's stderr noise — the Known issue #11
   capture gap). The T-028 change-set touches no kill-tree file
   (`git log` over scripts/check-kill-tree.mjs, src/kill-tree.ts,
   src/gate/command.ts, src/worker/run-with-timeout.ts: last touch is
   T-027's 6abd977, pre-dating the lane), and the red did not reproduce:
   lane standalone check-kill-tree ×4 and the lane full fast tier all
   ALL GREEN (30 assertions each) the same hour. Now observed twice —
   three days apart, different lanes, zero shared change-set code — so
   the threshold for "recurring" is close: a third observation must come
   with the check's captured `FAIL: <name>` line before any code change
   is considered, and the honest classification until then is a
   loud-by-design one-off, benign, evidence-only.
   **2026-10-21 third observation (T-038 lane, final-tree fast tier) —
   the threshold's captured line arrived; classification unchanged.**
   The T-038 lane's fast tier aborted at Gate 1.12 with three failing
   assertions, this time CAPTURED (the tier ran to the check's own summary
   and the names are on record): `FAIL: S4: no cleanup failures on a
   verified kill`, `FAIL: S4: log carries the verified kill line`,
   `FAIL: S4: log carries no CLEANUP FAIL` — while the SAME scenario's
   process-table assertions stayed green (`whole tree dead (root, mid,
   leaf)`, `all three pids dead`): the recorded `CLEANUP FAIL` lines sat
   on a tree that verifiably died, the exact signature this issue was
   opened with. The T-038 change-set touches no kill-tree file (its diff:
   src/types.ts, src/runner.ts, src/cli.ts, src/recover.ts,
   scripts/check-gate-retry.mjs, scripts/verify.mjs, docs). The response
   was a re-run, not a code change: the immediate re-run of the identical
   tree was ALL GREEN (exit 0, 108 s). Three observations, six days,
   different lanes, zero shared change-set code — and the class has now
   delivered its captured line, so the condition this ledger set for
   considering a code change is MET on the next recurrence: the next
   observation should carry a diagnosis of the triggering line (the
   snapshot/kill window vs an already-gone root) before any edit, and
   until that diagnosis the classification stays loud-by-design,
   benign, evidence-only.
11. **A one-off Gate 1.17 red with a single failed assertion, not
   reproducible (observed once, 2026-10-18, T-021 lane review round 1).**
   One fast-tier run failed inside `scripts/check-machine-worker.mjs` — exit
   1, `check-machine-worker: 1 failure(s)` — while the check passed in every
   other execution around it: 13 green Gate 1.17 executions in the same lane
   the same day (two full `node scripts/verify.mjs fast` runs, six
   standalone runs, three of them under 8-way artificial CPU saturation).
   The check's own end-of-`main()` sandbox cleanup had run (no
   `C:\swarm\verify-machine` debris), so `main()` completed and exactly one
   assertion was false; the failing assertion's name was not preserved in
   the reviewer-side log. The stderr tail that log does contain — worktree
   prep lines, SQLite experimental warnings, and the six S6 refusal
   messages — is byte-for-byte the noise every run prints, green runs
   included: the tsx-wrapped CLI children leak their stderr to the terminal
   even through `execFileSync` pipes, so that noise identifies nothing. The
   change-set under review touched none of the check's inputs (no `src/`
   file, no check file; the Gate 1.19 hook runs after 1.17 and its sandbox
   is self-removed). Same class as Known issue #10: a loud-by-design one-off
   in a fast-tier check; benign until observed recurring — and the failing
   assertion's name must be captured before any code change is considered.
12. **A one-off Gate 2 worker stall, fatal at the old outer ceiling
    (observed once, 2026-10-19, T-023 review round 1).** In the landing
    `verify:full` attempt, candidate c01's worker — the UNCHANGED
    worktree-write path; its logged argv carries no `--agent`
    (`$ opencode run -m zai-coding-plan/glm-5.3-flash <prompt: 3013
    chars>`, run 20261019010147's `dispatch.jsonl` + `c01/worker.log`)
    — went silent after three file reads (Glob, Get-ChildItem, Read
    calc.js/test.js) and never completed. The runner's own 15-minute
    worker timeout never got to fire: verify.mjs's then-8-minute outer
    ceiling SIGTERM'd the whole skeleton run first (`FAIL: skeleton run
    failed: SIGTERM`). A SIGTERM death skips report writing and
    disposal — the killed run left both worktrees registered on the
    fixture, both `swarm/wt-*` branches, and a stale checkout lock,
    disposed through the house path (`npm run clean -- --run
    20261019010147 --run-root C:\swarm\verify --force --force-lock`;
    4 removed, 0 refused, 0 failed; fixture verified pristine after:
    only `main` in `worktree list`, no `swarm/*` branches, clean
    status; evidence kept). The same run clears T-023's own paths of
    suspicion: the restricted planner (`--agent plan`) produced parsed
    distinct briefs in ~50s and the restricted reviewer parsed its
    observations — the red is not attributable to the capability
    restriction. The outer ceiling now exceeds the runner's per-worker
    budget (see Gate 2's section), so a recurring stall resolves into
    the runner's FAILED candidate verdict and Gate 2 fails on its
    `workerOk` assertion — the designed, legible failure — instead of
    an uninformative SIGTERM. Not re-run by the lane (model tokens);
    the next driving Gate 2 is the next observation. Same class as
    Known issues #10/#11: loud-by-design one-offs; benign until observed
    recurring.
    **2026-10-20 follow-up (T-027 review round 1) — the next observation
    arrived, and the failure came from the other direction: not a stall.**
    The driving workflow's gate wrapper killed `npm run verify:full` at its
    own hard 900000ms budget (`WorkflowError: world.run 'node' timed out
    after 900000ms`) while the skeleton run was ~1-2 min from finishing —
    run 20261020032701's dispatch evidence: BOTH workers completed ok (c02
    in 4.5 min, c01 in 11.2 min alive throughout — the runner's per-worker
    budget never fired because nothing stalled), c02 fully reviewed
    (review.json written), c01's reviewer just started (`reviewer.log`
    269 bytes) when the wrapper fired; no report.json yet. The fast tier
    measured 1m33s the same day, so the landing gate legitimately needed
    ~18 min against a 15-min wrapper on a slow-model day — below the
    wrapper's cap sits this file's own 20-min inner ceiling, whose designed
    stall path (~17 min skeleton + ~1.5 min fast tier) the wrapper can
    therefore preempt. Repo-side "narrow the work" levers all weaken Gate
    2 (fewer candidates, skipping review, a tighter `--timeout-min` that
    converts a slow success into a red, slimming the full tier) and were
    refused; the remedy is the driving wrapper's budget — raise
    `opts.timeoutMs` to cover the inner ceiling plus the fast tier — which
    no lane change-set can set. The killed run's debris (two registered
    worktrees, two `swarm/*` branches, one stale lock whose holder pid was
    verified dead first) was disposed through the house path (`clean --run
    20261020032701 --run-root C:\swarm\verify --force --force-lock`;
    4 removed, 0 refused, 0 failed; fixture verified pristine after: only
    `main` in `worktree list`, no `swarm/*` branches, clean status;
    evidence kept — dispatch.jsonl, both diff.patch, worker/reviewer logs,
    c02's review.json).
13. **The first auto-revert: a post-merge fast-tier red that never
    reproduced, with the red output lost (observed once, 2026-10-21,
    T-032 lane, driving run `dwfrun-b35d1c1a`).** T-032 (adversarial
    probe) merged as `d530fb0` with its lane fast tier green; the driving
    workflow's post-merge fast tier on main went RED and the designed
    auto-revert fired for the first time in the project's history
    (`e73d9a2`), restoring main green and keeping the lane. The red's
    failing gate and output were NOT captured: the driving script sliced
    tails into its journal only and wrote no gate output to disk — the
    same capture gap Known issue #11 named for the reviewer side, hit
    where it costs a landing. Classification therefore UNKNOWN (any gate
    could have failed); it must not be counted toward Known issue #10's
    Gate 1.12 threshold because no gate name was captured. Disposition:
    the exact merged tree `d530fb0` re-run detached at main's own path
    came back ALL GREEN the same day (`node scripts/verify.mjs fast`);
    the content was re-landed by reverting the revert, and its post-merge
    fast tier ran ALL GREEN with full output captured
    (`C:\swarm\verify-red\T-032-reland-post-merge-fast.log`) — two green
    runs of the content, zero reproduced reds. Remedy landed in the same
    window, outside any ticket: the driving workflow now tees EVERY gate
    run's full output to `C:\swarm\verify-red\` (post-chore, lane fast,
    Gate 2, post-merge), so the next red of any class arrives with its
    bar attached and #10's captured-line threshold becomes enforceable
    instead of aspirational.
    **2026-10-21 follow-up (T-035 review round 1) — the tee remedy itself
    landed broken and never ran a single gate.** The tee wrapper's `node -e`
    script carried `\n` inside the workflow file's double-quoted string
    (`.zcode/workflows/ticket-implement.dwf.ts`, b4866f5); the
    workflow-script layer consumed the escape, so `node -e` received a RAW
    newline inside its single-quoted literal — a compile-time SyntaxError
    (`Expected ',', got 'string literal'`) that killed EVERY wrapped gate
    run exit 1 before spawnSync, with no output file written. First
    surfaced as T-035's lane fast-tier red in review round 1 (the tier
    itself never ran in that pass — nothing in the T-035 change-set was
    implicated). Reproduced first-hand from the b4866f5 tree, then fixed by
    double-escaping (`\\n`, so the `-e` script receives backslash-n and
    parses its own newline): the fixed wrapper ran the lane fast tier end
    to end — exit 0, full output teed
    (`C:\swarm\verify-red\T-035-review1-wrapper-proof.log`, 177 KB, Gate 0
    through ALL GREEN) — and the wrapper correctly tees a red child's
    output and propagates its exit code too (observed on an intermediate
    mis-argued run). Both bars are attached here, so the remedy now does
    what its paragraph claims.

## Definition of done (per ticket)

- every acceptance criterion demonstrably true and naming its pinning gate,
- Gate 0 (+ Gate 1) green; Gate 2 run when the change touches the pipeline,
- ticket status flipped and index updated in the same change,
- VERIFICATION.md extended in the same change if the change adds behavior,
- no weakened assertions, no ride-along changes.
