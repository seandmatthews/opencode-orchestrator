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
(prose-tolerant scanning, exact-count, rejection shapes) without spending model
tokens. **Since T-056 the scans behind `parseBriefs` carry an EXACT-COUNT
clause, a deliberate documented behavior change:** a planner reply whose
valid-brief count is not exactly the requested count is a PARSE FAILURE — the
scan skips the mismatched slice (the all-or-nothing rule's exact-count clause),
the planner's bounded repair attempt runs, and a still-mismatched reply falls
back to the raw goal (`fallbackUsed: true`, the loud console line). The former
pad/truncate tail — cyclic repetition for a short reply, silent truncation for
a long one — silently laundered one brief into N "distinct" candidates at full
token cost with `ok: true` and no trace (adversarial review 2026-10-23, R9);
it is deleted. The inertness contract's scope is narrowed accordingly and
honestly: every EXACTLY-COUNT input — the overwhelming case — parses
byte-identically (pinned explicitly, both recorded fixtures included);
count-MISMATCHED inputs, which previously "parsed" into padded or truncated
output, now fail. The red bar was recorded on main before the change
(`parseBriefs('["a"]', 2)` → `["a","a"]`; `parseBriefs('["a","b","c"]', 2)` →
`["a","b"]`) and both green replacements are pinned — by this gate and by
Gate 1.42 (which also pins the fallback end to end). No exactly-N fixture
changed. Required whenever `src/parse.ts` changes.
Since T-029's review round 1 it also pins `parseBriefs`'s FIRST LAST-RESORT
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
content intact. Every EXACTLY-COUNT input that parsed before this change
parses byte-identically; no existing fixture changed. Required whenever
`src/parse.ts` changes.

Since the T-040 lane's review round 1 it also pins `parseBriefs`'s SECOND
LAST-RESORT repair, the objects-shape READ (run only when BOTH the plain scan
and the separator repair return null, so structurally inert while either
parses): the ROUND-2 planner of real run 20261022211937 (the driving Gate 2
red that landed it, teed at `C:\swarm\verify-red\T-040-gate2-full.log` —
`planner (round 2): no valid output, using raw goal in 115s (2 attempts)`)
answered the composed survivor-evidence prompt with a complete two-brief
array of `{"brief": "<text>"}` OBJECTS instead of an array of strings and
repeated the exact shape on its bounded repair attempt; the plain scan's
element filter dropped every object, the array scanned empty, both planner
attempts fell back to the raw goal, and Gate 2's two planner assertions went
red (the engine's fallback itself behaved exactly as designed — round 2
dispatched on raw-goal briefs and every candidate stayed green). The
recorded bytes are vendored byte-for-byte at
`scripts/fixtures/planner-r2-objects-raw.txt` (6543 bytes, the OpenCode
final frame included — the T-029 fixture-faithfulness rule) and the repair
READS the model's own labeled briefs out of them: a candidate `[..]` slice
parses only when its EVERY element is an object carrying its own non-empty
string `brief` (the all-or-nothing rule — one bad element sinks the slice;
nothing is fabricated or rewritten), with `scanBriefs`'s exact-count clause
verbatim (T-056 — the pad/truncate tail both scans carried is deleted).
Fixtures pin the recorded payload yielding exactly the
model's own two briefs (each output byte found in the recorded payload),
count-mismatch refusals in parity with the plain scan (the T-056 exact-count
clause — 1 object for count 2 and 3 objects for count 4 parse null), the never-fabricates refusals
(missing/non-string/empty `brief`, non-object elements, empty arrays — all
null), that a mixed object+string array still parses through the PLAIN path
unchanged (the resort never fires), that string content embedding the
objects pattern parses byte-identically through the plain path (the T-029
inertness pin, second instance), and that the recorded frame's trailing
OpenCode footer and in-brief brackets do not derail the scan. Every
EXACTLY-COUNT input that parsed before either repair parses byte-identically
by construction; no existing fixture changed. Required whenever `src/parse.ts`
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
evidence — `report.json`, `diff.patch`, logs survive. A worktree NOT covered by
captured evidence is refused (non-zero exit, per-item message) unless `--force`:
changes no stored `diff.patch` holds, or changes made after the capture, may be
the only un-captured copy — T-048's evidence-parity predicate (Gate 1.34;
before T-048 a plain porcelain read refused EVERY post-capture worktree, since
the capture's `git add -A --intent-to-add .` staging always reads dirty).
`--all` cleans every run directory under
the run root except the newest (run directories are 14-digit timestamp names).
Worktrees come from the run's `report.json` plus anything else discovered under its
`wt/`; the target repo comes from the report's `repo` field, falling back to the
worktrees' own `.git` pointers (crash-mid-run recovery). All git subprocess calls
are list-form — this command exists partly to retire the Known issues #4 quoting
hazard.

The fast tier pins this against a throwaway sandbox repo: a recorded run cleans
with exit 0, leaving only `main` in `worktree list` and no `swarm/*` branches, with
`report.json` intact; a changed worktree with no stored evidence is refused while
its clean sibling is still
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

**Release verifies ownership (T-052).** Programmatic
`releaseCheckoutLock` unlinks only a lock whose recorded `pid` is its own
process's: a `--force-lock` taker's replacement lock and any file it cannot
identify are skipped with a loud stderr line, never deleted — the takeover
sequence (A holds, B force-takes, A's finally-release) previously deleted
B's lock and broke mutual exclusion in exactly the scenario `--force-lock`
exists for. The CLI `release` verb stays the explicit human override and
drops any holder (`forceReleaseCheckoutLock`); acquisition semantics are
unchanged. Pinned by Gate 1.38 (takeover-intact, unreadable skip, CLI
override, and the normal-pair/force-pair release legs); every lock face
below rides green unchanged.

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
  disk. (Since T-060 every attempt also carries its `dispatched-prompt.txt`
  — the full orientation + brief text — beside `worker.log`, before
  `diff.patch`; a thrown attempt names its `worker.log` and that file. The
  array pins were updated to the new exact shapes in the T-060 change-set —
  still exact array equality, no member dropped.)
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

**Identity verification fails closed since T-052.** The verify-before-kill
faces above (dead / never-recorded / mismatched) are unchanged and riding
green, and the verified kill is unchanged. What changed: identity that
cannot be ESTABLISHED (creation-time probe unavailable — PowerShell
missing/blocked, a protected process, a non-Windows host — dispatch stamp
unreadable, or creation time unparseable) now REFUSES the kill as a new
`identity-unavailable` cleanup-failure class with the mandated loud record
(`identity could not be established (<reason>) — NOT killing pid <n>; kill
it manually if it is a leftover`); pre-T-052 every one of those classes
returned ok and killed on the alive check alone. **Accepted degradation,
stated here:** machines where PowerShell cannot run degrade to report-only
recovery (every recorded pid becomes that loud cleanup failure; nothing is
killed) — tree-killing an innocent reused pid is unrecoverable, a skipped
leftover is a human's one-line fix. The creation-time probe is injectable
(`CreationTimeProbe`, defaulting to the real spawn) and the kill decision
extracted (`reconcileKills`) so all three identity legs are deterministic;
pinned by Gate 1.38, including the end-to-end leg through this command
with PowerShell unresolvable. `src/recover.ts` also gained the
`src/lock.ts` run-directly entry guard (imports never execute a
reconciliation).

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
each with the FULL `timeoutMs` budget. EXPECTED-OUTCOME vocabulary (T-062,
register R16 — the inversion fix this gate's adversarial legs were rewired
onto; full semantics pinned by Gate 1.48): every case carries an
ENGINE-AUTHORED expectation, `'exit-0'` or `'reject'`, a pure function of the
engine-authored corpus (the exported `adversarialCaseExpectations` — never of
the target's behavior, never reclassified after watching the target run, and
never of the seed's random tail: the corpus prefix carries the authored
expectations, every generated case — soup and permutations alike — expects
exit-0). The corpus entries whose INPUT IS INVALID BY CONSTRUCTION — the
exact split, fixed at implementation and pinned by Gate 1.48: the empty-input
edge (index 0), the control-character case (index 1), and the three
malformed-JSON-looking strings (indices 9-11) — expect REJECTION; everything
else expects exit-0. Outcome classes: a case SURVIVES when it spawned
cleanly, exited 0, did not time out, and exit-0 was the expectation; it is
REJECTED-AS-EXPECTED when it spawned cleanly, exited non-zero within the
budget, and reject was the expectation (correct input validation — counts
toward survival, a PASSED case row); it is UNEXPECTED-EXIT-0 when it spawned
cleanly, exited 0, and reject was the expectation (the no-op handler that
never reads argv — an unmet expectation, exactly the previously
undetectable no-op R16 names); it CRASHES (crashed-exit / crashed-timeout)
when it ran, exit-0 was the expectation, and it exited non-zero or timed
out; a SPAWN-REFUSED case produced no run — none of the above (a target
cannot crash on an input it never received). A timeout or spawn refusal is
NEVER survival on either expectation — a reject-expected case that times
out records crashed-timeout, not rejection (the T-032 refusal vocabulary
unchanged, strengthened-or-equal). Honest boundary, stated in the ticket and
the module docblock: a clean non-zero exit is indistinguishable at the
process boundary from an unhandled throw on the same input — both record
rejected-as-expected; non-zero exit is non-zero exit. Success = the case
list non-empty AND every case spawned cleanly AND every case met its
expectation (`passed: outcome === 'survived' || outcome ===
'rejected-as-expected'` at the case-gate mapping); zero completed cases is
success:false, never a pass (AGENTS.md #7); `error` names the FIRST breaking
case with counts ("case 3/20 exited with code 1" / "case 5/20 timed out
after Nms" / "case 1/20 could not be spawned: ENOENT" / "case 1/20 exited 0
where rejection was expected (input invalid by construction)"). Measurements
recorded regardless of success — evidence about crashes is the point: one
`case-<i> duration` (ms) per case that actually ran, plus `cases-run`,
`cases-crashed`, `cases-rejected`, and `cases-unexpected-exit-0` counts
(unit `'cases'`) — cases-crashed keeps its T-032 meaning (crashed-exit +
crashed-timeout only; rejected-as-expected is counted honestly beside it,
never silently merged into survived or crashed). Artifacts: the combined
`.log` with `=== case <i> ===` separators plus `<probeId>.results.json`,
kind `'report'` (the kind's THIRD producer): `{probeId, scenarioId, seed,
cases: [{index, input, expectation, outcome, durationMs?}], casesRun,
casesCrashed, casesRejected, casesUnexpectedExit0}` with expectation ∈
exit-0 | reject and outcome ∈ survived | rejected-as-expected |
unexpected-exit-0 | crashed-exit | crashed-timeout | spawn-refused and every
input truncated to `ADVERSARIAL_PROBE_MAX_CASE_CHARS` = 8192 — cases
ride argv and Windows bounds a spawned command line (CreateProcess's ~32k
limit), so the constant bounds the probe's contribution with margin (the
operator's base `command` is expected to stay small — documented
limitation). gateResults: one entry per case, in case order, named
`'<probeId>#case-<i>'` (the `'<id>#run-<i>'` precedent) — the unmet-
expectation list is machine-readable from the failed rows. NO verdict input
of any kind: the
pipeline is type-agnostic (`runProbes` iterates `job.probes` with no type
switch; `probe_runs` ingest has no type knowledge; `ProbeRunSummary` is
type-agnostic), and a success:false adversarial bundle changes nothing
downstream — adversarial findings advise the human and the round-2 planner
(the T-030 composer renders probe summaries into round-2 evidence; since
T-062 it renders rejected-as-expected counts as validated input handling,
pinned by Gate 1.48's composer leg).

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

T-062's flips, recorded — this change-set's intentional invalidations of
existing assertions, both in the adversarial faces the ticket exists to
invert (register R16), both flipped explicitly and replaced with STRICTER
assertions: (a) the P3 "no-crash face — a robust target" pinned
`success: true` with every case row passed for a target that exits 0 on
every input without reading argv. That WAS the inversion — the no-op
handler was probe-success while a validating CLI recorded crashed-exit. The
face is now the NO-OP face: the same fixture asserts `success: false` with
exactly the five reject-expected cases recorded `unexpected-exit-0` (failed
rows, exit 0, error naming case 1 with the T-062 vocabulary) while every
exit-0-expected case still survives and passes. (b) The P3 crash face and
the P5 adversarial faces pinned first-error text and counts derived from the
raw weak-spot subset (`case N/20 exited with code 1`, cases-crashed = the
whole crash subset). The derivation is now expectation-aware — the fuzzee's
malformed-input exits are rejected-as-expected (passed rows), its
empty-string acceptance is unexpected-exit-0 (the new FIRST breaking case),
cases-crashed counts only the exit-0-expected crashes, and the faces
additionally pin per-case expectation fields, cases-rejected, and
cases-unexpected-exit-0. (c) Gate 1.44's P1 fixture (the chatty adversarial
target) ignored argv and exited 0 everywhere — the same no-op shape; its
`success: true` assertion is the T-058 claim (memory hygiene never flips a
verdict) and stays, so the fixture was made VALIDATING (exits 1 on the
invalid-by-construction inputs, derived from the recomputed expectations):
the claim is now proven through the rejection path too, with the
cases-rejected count pinned beside it. Net strictness increases in every
flipped face (the
derivation subsumes the old one and adds fields); the honest full green pair
(validating target → probe success) lives in Gate 1.48; no other existing
check was weakened.

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
exactly those that (a) have no worktree currently registered on them,
(b) are attributable to the terminal run via its dispatch records' `branch`
fields, its report candidates (`branchForLeaseId('wt/<id>')`, retry legs
`wt/<id>-a<n>` → `swarm/wt-<id>-a<n>` included), or its `wt/` entry names,
and (c) sit at the run's recorded `baseSha`. Branches attributable to no
terminal run are reported unowned and never deleted; branches on registered
worktrees are reported and never deleted. Since T-044 the old sweep's
"workers never commit — the diff is captured to `diff.patch` first, so a
`swarm/*` branch carries no unique evidence" premise is ENFORCED, not
assumed: a branch whose tip sits beyond the baseSha carries worker commits
— evidence — and the shared `removeBranch` refuses it with the loud
carries-commits-beyond-baseSha line (Gate 1.30; the report's `baseSha` is
the expected tip; a run with no recorded baseSha keeps the pre-T-044 sweep
behavior — crashed-reconciled runs carry no report.json).
`wt/int-*` integration-replay
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
  registered c04 + the held int-c06) and branches (c02, c04, ghost);
- **C** (T-044) — a finished run owning an attributable, unregistered
  branch whose tip sits beyond the report's `baseSha` (the committing
  worker, worktree already gone — the `--clean` leak shape): the sweep
  REFUSES it with the loud carries-commits-beyond-baseSha line naming tip
  and base, exit 1, and the branch — the only copy of the committed work —
  survives into the end-state census (c02, c04, c08, ghost). The A3/A4
  fixtures now record the sandbox's REAL baseSha in report.json (the guard
  consumes the field; the old `'0'.repeat(40)` placeholder was never read)
  — every existing gc assertion is unchanged and green.

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
  since T-062 a probe summary carrying `casesRejected` renders its
  rejected-as-expected cases as validated input handling in the line
  (`N input case(s) rejected as expected — validated input handling, not a
  failure`), never as "failed", and the annotation never launders a
  genuinely failed probe (pinned by Gate 1.48's composer leg) —
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
  plus `rounds` (and, since T-049, `yield` — the fixture intentionally
  carries a no-op round-2 candidate, exactly the yield block's producer;
  Gate 1.36 pins that block), the entries exactly the ticketed fields, the recorded
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
  passing-gate output); attempt 2's `promptVersion` equals the sha256 of
  the exact dispatched prompt — since T-060 the composed brief behind the
  engine's orientation block (`workerDispatchPrompt(briefText, lease2,
  orientationFor(...))`, recomputed in the check the same way; before
  T-060 the bare `builderPrompt(briefText, lease2)`), never the engine's
  composition path alone; attempt 2's
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
(T-040 — **landed since at this exact seam; see the update note below and
Gate 1.27**); rounds beyond 2
(decisions.md 2026-10-20, T-033); reviewer or review-ordering changes (the
reviewer still sees only final `passedAllGates` candidates and the ORIGINAL
brief). Gate 2 is OWED for this change-set (the runner's verdict-adjacent
code + an optional report block are on its trigger list): the full tier's
real run carries `--gate-retry` — see Gate 2's section. Gate 3 n/a (no
adapter change; no new harness posture).

**T-040 update (landed in its own change-set at this exact composition
seam):** the `gateRetry` block's shape is now exactly
`{fromAttempt, toAttempt, gates, fingerprint, findings}` — the `findings`
provenance (`{count, included, ok}`) records what the PRE-RETRY verification
of the retry-eligible leg contributed to the composed brief (G1's exact-shape
pin above was extended deliberately in that change-set, the T-031 flip
precedent: net strictness increases — the four T-038 fields stay pinned
exactly, and the fifth is positively exercised by Gate 1.27, including its
honest zero record `{count: 0, included: 0, ok: false}` on THIS gate's
verifier-less drives, which is what G1 now pins). The composed brief may now
carry a findings section AFTER the gates section under documented caps; on
this gate's drives (no verifier configured) every pinned brief remains
byte-identical to the T-038 gates-only composition — a property Gate 1.27
now pins positively (F0/F3). The fingerprint continues to hash the full
composed text, findings included by construction. Recovery, the store leg,
and the header line are untouched: `recover` reads the dispatch header only,
and ingest reads named fields only.
## Gate 1.25 — verifier role: active pre-disposition verification (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-verifier.mjs
```

Pins T-039 (spec §10.1, §6.6:426, §9.2): a fourth model role beside
planner/worker/reviewer. Where the reviewer (T-001) *reads* the diff
post-gate on survivors, the verifier **actively tests** — it runs new checks
against the candidate's work itself and returns findings citing the commands
it ran and the output it saw. Run-level flag `--verifier-model <model>`
(off unless given — no default model); optional `--verifier-worker`
mirroring T-025's per-role harness selection (its machine pairing flag
`--verifier-command` riding the same per-role table), absent resolving to
the run-level worker exactly as the planner/reviewer flags do. The role
rides BOTH modes like the reviewer (the placement is in `runJob`, after the
gate loop and probes, before review, on the final completed attempt
REGARDLESS of gate outcome — the T-015 posture: evidence about failures is
evidence). The diff is captured before the gates run, so the verifier's
executions cannot dirty diff evidence (pinned below with a junk-writing fake
verifier). **Never a verdict input**: `passedAllGates` stays
`gates.every(...) && diffBytes > 0`; a `blocker-advisory` finding eliminates
nothing, promotes nothing, reorders nothing — in this ticket its consumers
are the human (report.json) and, later, the retry seam (T-040) and the
cross-run ratchet (T-041). The whole boundary is the decisions.md entry
landed in this change-set (**2026-10-21 — the ratchet boundary**: findings
are advisory; a model-authored check never decides survival in the run that
produced it; promotion into a gate set or fixture suite is human-owned and
crosses runs, spec §32:1939-1956) — that entry also owns the §10.1
read-only tension and its resolution, and records that T-022 stands (the
verifier works inside the existing `WorktreeProvider` lease; no
disposable-clone provider).

**The step-one posture probe, run and recorded (ground rule 5 hygiene):**
`node scripts/diag-execute.mjs <dir>` (new, the `diag-pwd.mjs` precedent)
spawns the vendored harness exactly as the adapter does — list-form
`run --agent plan -m <model> <prompt>`, PWD/OLDPWD pinned — and asks it to
run one deterministic command and report its stdout. Answer against
opencode-ai 1.19.3 at C:\swarm\verify-verifier-probe\repo: **EXECUTE-CAPABLE**
— the plan agent ran `node -e "console.log('EXEC-PROBE-OK-7391', 6 * 7)"` and
replied `EXEC-PROBE-OK-7391 42`, and the target tree stayed clean (no
writes). Therefore the verifier rides **'worktree-read' unchanged**: no
fourth `ExecutionPolicy` value, no adapter change, refuse-not-downgrade
already pinned at the adapter by Gate 1.20 S2. The standing PWD probe was
re-run in the same session (`node scripts/diag-pwd.mjs
C:/swarm/verify-verifier-probe/repo` with the shell's inherited PWD): the
quirk REPRODUCED — opencode resolved its project as the inherited `PWD`
value, not the spawn cwd — so the adapter's PWD/OLDPWD pinning
(src/worker/opencode.ts) is load-bearing for the verifier dispatch too, and
the execute probe (which pins the same way) resolved and executed in the
contracted directory.

The check drives `runSkeleton` directly with **fake `WorkerAdapter` +
fake `Gate` objects** against throwaway fixture repos (one per scenario,
list-form git calls only), zero model tokens — the Gate 1.8/1.10/1.21
script pattern — plus real-CLI faces. It asserts:

- **S1 — flags absent ⇒ the producer-only pattern**: no verification-tier
  dispatch reaches any fake; no candidate carries a `verifier` block (in
  memory or on disk); report.json top-level and candidate keys are
  byte-shape-identical (the exact 14-key candidate shape, review present);
  no `verifier-raw.txt`/`verifier.log` exists anywhere in the evidence dir;
  candidates pass exactly as before.
- **S2a — block present and populated** (a fake verifier adapter serving a
  valid observations payload): exactly one verifier dispatch per candidate,
  through the verifier's OWN adapter and no other's (no cross-contamination,
  the Gate 1.21 S1 shape); every dispatch carries **'worktree-read' passed
  explicitly** (the probe's chosen posture) at **cwd = the candidate
  worktree lease** (which existed at dispatch time), **never the canonical
  checkout nor anything inside it** (the engine side of the posture pin);
  the prompt carries the brief (each candidate its own, matched by
  workspace cwd), the captured diff, the gates that already ran with
  names/verdicts/**recorded commands** (`GateResult.command`, T-027), the
  novelty directive (do not merely re-run the suite; run NEW checks; cite
  every command and its output), and the JSON observations contract; the
  report block is exactly `{model, ok, attempts, observations, rawOutputPath}`
  (the `ReviewReport` field pattern under a DISTINCT block, reusing the
  `ReviewObservation` shape), the on-disk candidate keys gain exactly
  `verifier`, and the raw output is persisted at `verifier-raw.txt` in the
  candidate evidence dir with `verifier.log` beside it; review is unchanged
  (survivor-only, same shape).
- **S2b — placement order** (one candidate, one shared recorder, the fake
  gate recording its own invocation): planner → worker → gate → verifier →
  reviewer — the verifier sits after the gate loop and before review.
- **S3 — placement faces, both outcomes, + diff immunity** (one mixed
  drive: c01's gate passes, c02's fails; the fake verifier writes a junk
  file into the workspace it is handed): the verifier runs on the
  gate-FAILED candidate too and its block sits on the eliminated candidate;
  the junk file appears in NO diff evidence and `diffBytes` equals the
  on-disk `diff.patch` captured before the verifier ran; review still fires
  on the survivor only (reviewer ordering unchanged; the verifier is not a
  reviewer replacement).
- **S4 — verdict immunity, adversarial form** (same drive, BOTH candidates
  carrying `blocker-advisory` findings): the gate-passing candidate still
  passes, the gate-failing candidate still fails with no error and
  `workerOk` intact, and `passedAllGates === (gates.length > 0 &&
  gates.every(passed) && diffBytes > 0)` holds per candidate — the ladder
  computes from `passed`/`diffBytes` alone.
- **S5 — repair + degradation** (the reviewer-repair leg pattern): invalid
  JSON triggers EXACTLY one repair attempt (the second dispatch embedding
  the first response; both sharing the restricted request and the same
  worktree cwd), which parses; a twice-invalid output records `ok: false`
  with observations empty, persists the second invalid response verbatim at
  `verifier-raw.txt`, and changes nothing downstream — the verdict is still
  the gates' and review still ran and parsed on the survivor.
- **S6 — CLI wiring, token-free**: `--help` documents `--verifier-model`,
  `--verifier-worker`, `--verifier-command`; the real-CLI refusals (unknown
  `--verifier-worker` id with the registry message verbatim;
  `--verifier-worker machine` without `--verifier-command`; a
  `--verifier-command` on an opencode-resolved verifier) exit 1 with zero
  side effects — no artifacts dir, no `locks/` (the Gate 1.21 S2 shape,
  each through the real CLI with a non-git `--repo`); and a real-CLI
  `--jobs` run whose worker AND verifier are machine adapters (the Gate
  1.21 S3 shape — the first token-free real run with a populated verifier
  block) end-to-ends the role: the candidate passes its gate with
  `passedAllGates` gate-decided, the block is parsed from the machine
  adapter's stdout with the model recorded verbatim, `verifier-raw.txt` and
  `verifier.log` carry the machine argv header (never an opencode argv),
  `--no-review` is respected, and the diff captured only the worker's
  change.

Store-invisible by the rounds precedent: ingest is untouched, the
`verifier` block rides report.json only (the store's per-candidate insert
selects its columns; no `verifier_json` column exists this slice), so Gate
1.6's row-count pins are unaffected. Not pinned here and carved by the
ticket: findings feeding anything in-run (T-040's seam); automatic
finding→gate promotion (T-041 — human-owned, cross-run, the decisions entry
above); reviewer consolidation/replacement; session resumption; image
inputs (spec §10.4's visual verifier — text/terminal evidence only this
slice); §10.5's consensus challenger; per-job verifier config in `--jobs`
specs; any new npm dependency. **Gate 2 — RUN, recorded** (runner + report
shape + a real model role): one real `--goal --verifier-model` run
(`--repo C:/swarm/demo-target --candidates 1 --no-planner --no-review
--verifier-model zai-coding-plan/glm-5.3-flash`, gates `build`/`test`),
2026-10-21 — artifacts at `C:\swarm\20261021225243\report.json` (worktree
disposed through `npm run clean --force` afterward; evidence kept): c01
worker ok 19s, diff 725 bytes, build PASS + test PASS ⇒ `passedAllGates`
true with the verifier block present (verdict immunity on a real run); the
verifier produced 6 findings (attempts 2 — one bounded repair on the real
model, recovered) each citing its command and output, including a concern
the gate string never covered (inverted bounds silently accepted:
`clamp(5,10,0)` returns 0, no `lo<=hi` guard), a 20,000-case fuzz
(`mismatches: 0`), boundary/NaN/type-coercion probes, and a
diff-vs-worktree consistency check. Findings quality stays the staged open
question (the T-033 posture): one run, one candidate, small fixture — the
findings are genuine and evidence-cited, and whether that holds across runs
is exactly what T-040/T-041 consume and stage. **Gate 3 n/a** (no adapter
change: the verifier rides 'worktree-read' unchanged; both probes re-run
and recorded above, per ground rule 5).

## The ratchet — finding→gate promotion (T-041: human-owned, ticket-carried, cross-run)

Spec §32:1939-1971 — every real failure the swarm discovers should convert into a
check that fires forever after, so the error rate ratchets down across runs instead
of oscillating. The convention (AGENTS.md ground rule #11; its boundary is the
decisions.md **2026-10-21 T-039 entry** — findings are advisory, a model-authored
check never decides survival in the run that produced it):

- **Never auto-promoted.** No engine code reads a findings block and edits a gate
  string, fixture, or spec — the promotion is a human change-set (ground rule 6's
  change-set discipline is the vehicle).
- **Never in the run that produced the finding.** The ratchet crosses runs:
  finding in run N → promotion change-set → gate in run N+1.
- **The promotion artifact is the ticket.** Its change-set carries the finding
  cited (run id, candidate, observation, artifact path), the reproduction, the new
  gate command or fixture test, and the re-run that eliminates on it. From then on
  the check is `gate X, command Y, exit Z` — mechanically reproducible forever
  (the T-027 recorded-command property, exercised cross-run).

**The first promotion, recorded (this change-set IS the promotion ticket, T-041):**

- **The finding:** run `20261021225243` (T-039's Gate 2 record,
  `C:\swarm\20261021225243\report.json`), candidate c01, verifier `concern` —
  "Inverted bounds are silently accepted: clamp(5,10,0) returns 0 instead of
  erroring or normalizing; there is no lo<=hi guard in calc.js:6" — with the
  command-and-output evidence cited in the observation (`swap_lo_hi 0`; calc.js
  line 6). The candidate's own diff is vendored byte-identical at
  `scripts/fixtures/t041-finding-diff.patch` (sha256 `9570099f…`, 725 bytes —
  the report's `diffBytes`).
- **Red bar (pre-promotion, run N):** `C:\swarm\20261021234438\report.json` —
  the finding's own diff replayed against the pre-promotion fixture (base
  `cfc196717a2f`) through a real CLI run (`--jobs` with `worker: "machine"` — the
  T-017 token-free end-to-end; no model authored or ran this candidate):
  build PASS + test PASS (exit 0 both, commands recorded) ⇒ `passedAllGates`
  true — the failure class the finding describes survives the old gates, which is
  exactly why the promotion was needed. Worktree disposed through
  `npm run clean -- --run 20261021234438 --force`; evidence kept.
- **The promotion (this change-set):** `scripts/demo-target.mjs` gains the guarded
  `clamp` (inverted bounds throw `RangeError`) and the test.js assertions pinning
  inverted bounds (`assert.throws(() => clamp(5, 10, 0), RangeError)` and
  `clamp(0, -5, -10)`) — a human-authored, ticket-carried edit, committed before
  run N+1 executed. Gate 1 stays green with the promoted check in place (the
  fixture's baseline passes its own gates — AGENTS.md #7 applies to the fixture
  too), pinned in the fast tier by Gate 1.26 S2.
- **Green bar (post-promotion, run N+1):** `C:\swarm\20261021234632\report.json` —
  the same failure class reintroduced against the promoted fixture (base
  `c1274b90d41b`): build PASS, **test FAIL exitCode 1** ⇒ `passedAllGates` false,
  no error — eliminated, the elimination evidence citing gate name `test`,
  command `node test.js`, exitCode 1 (the T-027 property, cross-run), the output
  tail naming the promoted assertion (`Missing expected exception (RangeError)`),
  and the 450-byte diff being exactly the guard stripped (a real regression,
  never a NO-OP). Worktree disposed through `npm run clean -- --run
  20261021234632 --force`; evidence kept.

Honesty notes, per ground rule 9: both proof runs' candidates are machine-worker
replays of the finding's class — token-free, driven through the real pipeline
entry; the report's model string is recorded verbatim for a candidate no model
touched (the documented MachineWorker posture, src/worker/machine.ts). The
MODEL-authored part of the chain is the finding itself, produced by the real
verifier in run 20261021225243 and quoted verbatim above; the promoted check was
authored by this change-set and already committed when run N+1 ran. A botched
first green drive (run `20261021234545` — the worker refused a CRLF-induced no-op
with exit 1, WORKER FAILED, zero-byte diff, per AGENTS.md #7) sits in the run
root uncited as evidence; the fixed worker is line-ending aware. The fast tier
re-proves the mechanism token-free (Gate 1.26 below) and never reads the recorded
runs back.

## Gate 1.26 — the ratchet: finding→gate promotion proof (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-ratchet.mjs
```

Pins T-041 (spec §32; the convention section above): the promotion mechanism,
re-provable forever, token-free. Both drives go through the REAL pipeline entry
(src/cli.ts) with `worker: "machine"` jobs (the T-017 token-free end-to-end, the
Gate 1.17 S5 pattern) under sandbox run roots and sandbox DBs — no live store, no
residue: the sandbox `C:\swarm\verify-ratchet` is removed at the end (AGENTS.md #10
mechanized). It asserts:

- the pre-promotion fixture, built from verbatim pre-promotion literals (the
  demo-target content before this promotion): baseline passes its own gates, and
  there is no clamp anywhere — the old-gates world;
- the promoted fixture, generated by the REAL promoted `scripts/demo-target.mjs`:
  generation exits 0 with build ok + tests ok (Gate 1's content, green with the
  promoted check in place); both promoted inverted-bounds assertions are in the
  generated test.js and the guard in the generated calc.js; and the finding's own
  diff NO LONGER APPLIES to it (`git apply --check` refuses — the fixture moved
  past the finding);
- the vendored finding (`scripts/fixtures/t041-finding-diff.patch`, the
  byte-identical diff of run 20261021225243 c01): carries the unguarded clamp body
  and no guard, and applies cleanly to the pre-promotion fixture (it is that
  era's candidate diff);
- **RED BAR**: the real-CLI drive against the pre-promotion fixture exits 0 (the
  run completes mechanically) and the candidate that breaks the (future) promoted
  check PASSES the old gates and survives — workerOk, diffBytes exactly 725 (the
  finding's own diff — never a NO-OP pass, AGENTS.md #7), passedAllGates true,
  both demo gates PASS with their commands recorded (T-027);
- **GREEN BAR**: the same-class drive against the promoted fixture exits 0 (an
  elimination is a verdict, not a crash), the candidate is eliminated with
  passedAllGates false and no error, and the elimination cites gate name +
  command + exitCode (`test` / `node test.js` / 1 — the T-027 property,
  cross-run), the failing output tail naming the promoted RangeError assertion,
  and the eliminated diff being the real guard regression (the `-  if (lo > hi) {`
  hunk — never a NO-OP);
- no residual lock files after either drive (released on every path).

Not pinned here and carved by the ticket: any engine promotion path (none exists —
zero `src/` changes; the decisions.md T-039 entry bans auto-promotion outright);
finding taxonomy, scoring, or promotion thresholds; the convention applied
retroactively over pre-ratchet findings; Codex/Sol as the promoting reviewer
(the human is the promoter this slice; §10.2/§10.6's advisory review of
promotions is future vocabulary); extending the demo fixture beyond the promoted
check. **Gate 2 not owed** — trigger analysis, per the T-018:223-228 precedent:
no `src/` change, no adapter, no report shape, no scheduler/store/dashboard
surface; the change-set is documentation + fixture + gate scripts, and Gate 1
re-runs green inside the tier against the promoted fixture. **Gate 3 n/a** (no
adapter touched).

## Gate 1.27 — verifier findings ride the retry brief (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-gate-retry-findings.mjs
```

Pins T-040 (spec §24:1462 + §9.2; the JOIN of T-038's composition seam and
T-039's verifier role, landed after both): T-038's retry brief answers "what
did the machines reject?" — a diagnosis of the CHECK, not of the code. This
change-set adds the complementary diagnosis: the retry-eligible leg is
itself VERIFIED (the pre-retry verifier call site in `runJob`, before
composition, same 'worktree-read' posture and same schema as T-039's
final-attempt call) and its findings ride the composed brief beside the gate
output — "the gates failed with these outputs, and the verifier found these
issues; fix both; the gates re-run unchanged." Boundaries, unchanged from
their landing tickets: the composition stays mechanical string assembly (no
model call composes or adjudicates it — decisions.md 2026-10-21); findings
shape what the retry TRIES, the re-run gates decide what SURVIVES
(decisions.md 2026-10-10); findings changing retry ELIGIBILITY is carved.
Bounded by construction: the gate-retry bound is one, so a candidate is
verified at most twice — once pre-retry, once on its final attempt per
T-039. The check drives `runSkeleton` directly with FAKE worker + verifier
adapters (the Gate 1.24/1.25 pattern) against throwaway fixture repos —
zero model tokens. It asserts:

- **F1 — the pre-retry call site + the both-sections brief** (a
  gates-failed→fixed drive with a fake verifier serving one blocker-advisory,
  one concern, one info finding): the shared dispatch-order recorder pins
  worker → gate loop → VERIFIER → retry worker → gate loop → final verifier
  — the pre-retry verification fires exactly when the T-038 leg is
  retry-eligible and BEFORE composition; exactly two verifier dispatches, the
  first at the FAILING attempt's lease (`wt/c01`), the second (T-039's own
  call, unchanged) at the retry lease (`wt/c01-a2`), both 'worktree-read' at
  existing worktrees; the pre-retry prompt carries the failure context (the
  gates that already ran with names/verdicts/recorded commands, the captured
  diff, the brief); the composed brief carries BOTH sections — every failing
  gate's name/command/outputTail AND each eligible finding WITH its evidence,
  the findings section AFTER the gates section — while the info finding never
  rides (only blocker-advisory and concern are eligible); the T-038 payload
  is intact (original brief, captured diff, worker summary, no passing-gate
  output); `gateRetry` is exactly
  `{fromAttempt, toAttempt, gates, fingerprint, findings: {count: 2, included: 2, ok: true}}`;
  the fingerprint covers the FULL composed text including the findings
  section (sha256 of the brief file bytes); the findings reached attempt 2's
  actual prompt (its `promptVersion` hashes the brief text containing them —
  one composition, two consumers); the two legs' verifier evidence files are
  DISTINCT and intact (pre-retry: `verifier-pre-retry.log`/
  `verifier-pre-retry-raw.txt` in the failing attempt's evidence dir — the
  planner round-tag pattern; final: `verifier.log`/`verifier-raw.txt` —
  neither clobbered); dispatch.jsonl keeps its line shapes; and the candidate
  SURVIVES on the re-run gates with blocker-advisory findings having ridden —
  the survive face of the immunity.
- **F2 — degradation faces; the retry never blocks**: a twice-invalid
  pre-retry output (each leg's `runVerifier` repairs independently — 4
  dispatches total with the final leg's own verification) composes a
  GATES-ONLY brief (no findings section, no verifier garbage in the worker's
  input), records the degradation `findings {count: 0, included: 0, ok:
  false}`, persists the raw output verbatim at the pre-retry path, and the
  retry STILL fires; the fingerprint still covers the exact gates-only text;
  a CRASHED verifier adapter on the pre-retry leg composes the same
  gates-only brief and the retry still fires (the leg stays `gates-failed`,
  never an error leg); on both faces the candidate's verdict is still the
  re-run gates'.
- **F3 — the zero-findings faces**: a verifier returning NO observations,
  or only `info` findings (the eligibility filter), composes the T-038
  gates-only brief (no findings section) with honest provenance
  `{count: 0, included: 0, ok: true}`; retry unchanged from T-038's
  behavior, fingerprint exact.
- **F4 — verdict immunity, the adversarial form** (T-038's immunity leg
  re-run with findings present): the elimination-face drive —
  blocker-advisory findings rode the retry brief AND the re-run gates failed
  again ⇒ eliminated with `passedAllGates: false`, no error, no new
  elimination vocabulary, and `passedAllGates === (gates.length > 0 &&
  gates.every(passed) && diffBytes > 0)` holds — findings are never a
  verdict input even when they rode the brief. (The survive face is F1's.)
- **F5 — caps hold under flood**: a fake verifier returning 12 long
  blocker-advisory findings produces `findings {count: 12, included: 5}` —
  the documented top-N, FIRST-N in the verifier's own order, not a sample —
  every embedded finding/evidence string char-capped at the documented
  constant, the brief within the documented bound, and the GATES section
  intact (every failing gate's name/command/outputTail present, original
  brief and diff too, fingerprint exact): the flood cannot drown the gate
  output, which stays the primary payload.
- **F0 — verifier absence**: a `--gate-retry` run with no verifier
  configured composes the T-038 gates-only brief with honest zero
  provenance `{count: 0, included: 0, ok: false}`, the retry fires, and no
  verifier evidence files exist anywhere — verifier absence never blocks
  the mechanical retry.

**The documented constants** (src/runner.ts, exported for this gate so code
and documentation cannot drift): `MAX_RETRY_FINDINGS = 5` (top-N) and
`MAX_RETRY_FINDING_CHARS = 2_000` (per finding/evidence string — the
`MAX_DIFF_CHARS` precedent narrowed to a per-string cap so one huge evidence
blob cannot crowd out the other findings). CLI config for them is carved
(the ticket): documented constants this slice.

**Red bar (AGENTS.md #8), recorded before the engine change landed:**
against the pre-change tree, this check ran RED with 8 reported failures —
7 assertion failures (`the engine exports the documented caps`,
the dispatch-order pin — no verifier entry between the gate loop and the
retry worker, `exactly two verifier dispatches`, the pre-retry prompt
context, the findings section, the `gateRetry` exact shape — no `findings`
key, the findings-in-attempt-2's-prompt pin) plus the crash that ended the
run: `ENOENT ... c01\verifier-pre-retry-raw.txt` — the engine composed the
T-038 gates-only brief with NO pre-retry verification (T-039's final-attempt
call the only verifier dispatch, printed after attempt 2's gates). The
F2–F0 legs never executed in that run (the ENOENT aborted `main()`); their
green is established on the post-change tree.

Not pinned here and carved by the ticket: findings changing retry
ELIGIBILITY (a candidate with zero findings retries exactly as one with six
— the leg definition stays T-038's); findings in the round-2 planner packet
(src/rounds.ts's composer renders probe summaries; verifier summaries there
is a composer extension = a successor's report-shape change with its own
Gate 2); severity thresholds or top-N as CLI config (documented constants
this slice); the final attempt's verifier being skipped when a pre-retry
verification already ran (each leg verified per its own ticket — bounded at
two, measured, revisited only with run-history evidence); per-job verifier
config in `--jobs` specs (the T-039 carve); review/`--jobs`-spec changes.
**Gate 2 — OWED and carried by the full tier (see Gate 2's section):** the
change-set touches the runner's verdict-adjacent composition and extends the
`gateRetry` report block, so the ticket's own-Gate-2 branch applies; the
full tier now passes `--verifier-model` so the driving run is a real
`--goal --gate-retry --verifier-model` run end-to-end. Gate 3 n/a (no
adapter change; the verifier's posture was settled by T-039).

## Gate 1.28 — prompt transport off argv (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-prompt-transport.mjs
```

Pins T-042: `src/worker/opencode.ts` — the only OpenCode-aware file — no
longer passes the composed prompt as a command-line argument. **The
ceiling:** Windows caps the whole spawned command line at 32,767 UTF-16
chars and Node's `spawn` throws `ENAMETOOLONG` SYNCHRONOUSLY above it
(`node:internal/child_process`), verified on this machine (2026-10-23
adversarial-review session, node 22.23.1, win32 10.0.26200; re-run as the
gate's C0 leg on every fast-tier run). Nothing on the old path bounded
prompt size: `composeGateRetryBrief` (src/runner.ts) composes brief +
30,000-char diff cap + 12,000-char worker summary (`RESPONSE_TAIL_CHARS`)
+ each failing gate's 4,000-char `outputTail` + up to 5 findings × 2,000 +
2,000 — ≈70K chars against a ~32.7K ceiling, so the T-038/T-040
feedback-retry failed at spawn exactly when the candidate had a real diff
and real gate failures, while `runJob`'s catch mislabeled the throw a
mechanical `error`. **The transport:** the prompt streams over STDIN
(`stdio[0]` 'ignore' → 'pipe'; `child.stdin.end(prompt)` — `end()` never
blocks, Node buffers what the child has not read; an EPIPE on an
undraining harness is swallowed by a mandatory error listener so a write
failure never masquerades as a worker verdict — the exit path owns the
outcome). **Step 0, probe before transport** (AGENTS #9, the
`diag-pwd.mjs`/`diag-execute.mjs` precedent): `scripts/diag-stdin.mjs`
spent one real token-cheap call establishing that the vendored opencode-ai
1.19.3 reads piped stdin as the message when no message positional is
given — observed 2026-10-23 against a throwaway git dir:
`argv ["run","-m","zai-coding-plan/glm-5.3-flash"]`, 70 chars fed to
stdin, stdout `STDIN-PROBE-OK-4177`, exit 0 → **STDIN-SUPPORTED**; the
ticket's `-f/--file` fallback (documented in `opencode run --help`) was
not needed and is not implemented. Side benefit, now pinned: no goal,
brief, or retry-diff bytes ride argv, so none are visible to local process
listings. The gate drives the REAL adapter with a stub binPath
(constructor-injected; binPath = the node executable, the stub injected
via `NODE_OPTIONS --require` — the check-capabilities S2 pin face,
extended: the stub reads ALL of fd 0 synchronously so its record exists
before node would fail to resolve the adapter's bare `run` entry arg, and
`process.exit(0)` in the preload makes it a faithful 'harness consumed the
prompt and succeeded' stand-in). Legs, zero model tokens:

- **C0 — the platform ceiling, the recorded red bar re-run verbatim**: a
  32,000-char argv element spawns fine (exit 0); 33,000 exceeds the
  ceiling and `spawnSync` reports `ENAMETOOLONG` with status null. The OS
  fact that motivated the ticket — green on the pre-change tree too.
- **T1 — the red-bar size** (>32,767): a 33,000-char prompt spawns, the
  child receives the FULL prompt verbatim (exact text + byte count),
  exits 0, `ok: true`; onSpawn fired once and `result.pid` equals it.
- **T2 — both policies take the new transport**: 40,000 chars through
  `'worktree-read'` (the plan agent): verbatim receipt; argv is EXACTLY
  `[exe, run, --agent, plan, -m, model]`; `PWD`/`OLDPWD` pinned to
  `req.cwd` (unchanged by the transport); `worker.log` records
  `$ opencode run --agent plan -m <model> <prompt: 40000 chars>`.
- **T3 — 100,000 chars**: verbatim receipt (byte count asserted), exit 0,
  `ok: true` — the ceiling class is removed, not trimmed to fit.
- **T4 — the composed-retry-brief ceiling** (≈70K): a prompt built to the
  T-038/T-040 composition recipe's documented sizes (30K diff + 12K
  summary + 2 gates × 4K tails + 5 findings × 2K + 2K + framing;
  `composeGateRetryBrief` is module-private, so the check composes the
  same-shaped text — 70,749 chars measured green) survives a real spawn
  with verbatim receipt.
- **T5 — byte-shape at normal size** (<1K): the model-facing bytes are the
  EXACT prompt text; `responseTail` collection unchanged (the stub's
  stdout marker rides the result); spawn contract intact;
  `worker.log` records `$ opencode run -m <model> <prompt: N chars>` —
  the `<prompt: N chars>` elision marker is byte-identical to the
  pre-T-042 format, so Gate 2's round-growth regex (planner.log vs
  planner-r2.log) reads it unchanged.
- Every adapter leg also asserts a per-leg canary token embedded in the
  prompt NEVER appears in the child's argv — no prompt bytes in argv.

**Red bar (AGENTS.md #8), recorded BEFORE the transport landed** — this
check run on the pre-change tree (lane `ticket/T-042-prompt-transport-stdin`
at f256184, adapter untouched): C0 green; **every adapter leg RED, exit 1,
6 reported failures** — T1/T2/T3/T4 each with `execute() rejected — spawn
ENAMETOOLONG` and no stub record (no child ever ran), T5 with the prompt
arriving in argv (canary present) and the stub's stdin empty, while the
unchanged faces (responseTail, spawn contract, PWD pinning, log-line
format) were green on the same run — the byte-shape baseline T-042 keeps.
Green after the change: 30 ok, `check-prompt-transport: ALL GREEN`, exit 0.

**Existing checks — updated, none weakened or deleted (AGENTS #8):** two
checks stub the OpenCode adapter and had to follow the transport, with
every assertion kept at least as strong. Gate 1.20's S2 stub-bin argv pin
(check-capabilities.mjs) previously asserted `prompt last` in argv; the
transport is this ticket's subject, so the pin now asserts the prompt
NEVER appears in argv with the model as the terminal element — a strictly
stronger assertion of the new contract. Its other S2 assertions are
unchanged (all four policy faces re-measured green: `--agent plan` exactly
where expected, PWD/OLDPWD pinning, and the spawn log line —
byte-identical output, since the new `args.join(' ')` equals the old
`args.slice(0, -1).join(' ')`). Gate 1.22's leg-C committed `run` stub
(check-rounds.mjs) read the prompt from `process.argv[4]`; it now reads
fd 0 to EOF — the same bytes the argv positional carried — with its
no-op-by-brief and GOAL-parsing logic and every assertion untouched (the
first fast-tier run after the adapter change caught this exactly: leg C's
NO-OP elimination went red because the stub's empty argv prompt always
wrote feature.txt; fixed by the stub's prompt acquisition alone).
`runChildWithTimeout` is untouched (Gate 1.12's own pins stand);
`MachineWorker` never passed the prompt through argv (prompt is
provenance-only, src/worker/machine.ts) — out of scope by the ticket's
own note.

Not pinned here and carved by the ticket: any prompt-size bound on the
composition side (the ceiling class is removed at the transport, not
trimmed at the composer — the caps keep their T-038/T-040 values);
`-f/--file` fallback transport (step 0 answered stdin-supported; the
fallback is documented in the ticket, unimplemented); non-Windows
platforms (the repo is Windows-first — decisions.md 2026-10-10 — and C0
pins the win32 ceiling); stdin-content negotiation beyond 'pipe + end'
(the harness consumes or errors; both are the exit path's business).
**Gate 2 — owed and carried by the full tier** (an adapter is on Gate 2's
trigger list): the driving run is the standard real 2-round
`--gate-retry --verifier-model` e2e, which now exercises the stdin
transport on every planner/worker/reviewer/verifier dispatch; whether a
real `--gate-retry` leg fires is read off the run's `gateRetry` blocks
(the T-038/T-040 precedent — no candidate failed a gate in any recorded
proof run, recorded honestly if it still does not). **Gate 3 — run once
at landing** (an adapter changed): both faces re-measured 2026-10-23 in
the lane — no override: the harness reports the inherited-PWD directory
(the Known issue #1 demonstration); override to an existing git dir: the
harness reports the override target — the quirk is intact and the
adapter's PWD/OLDPWD pinning remains load-bearing; the transport change
is invisible to the probe.

## Gate 1.29 — baseline gate sanity: red base refuses before dispatch (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-baseline-gate.mjs
```

Pins T-043: the run pipeline (`runPipeline`, src/cli.ts) proves the run's
gates green on the UNTOUCHED base before `runSkeleton` — zero planner/worker
tokens spent on a red base, under the checkout lock main() already holds.
The NO-OP rule's inverse (AGENTS.md #7): gates on an untouched tree prove
nothing ABOUT A WORKER, but they are the only thing that proves the BASE
itself is green — without them a gate FAIL is uninterpretable
(candidate-broke-it vs base-was-always-broken), which is exactly how the
T-042-era review's F9 class (dependency-blind runs over a broken base)
burned whole runs. The mechanics: after `baseSha` resolution, one worktree
is leased at the base SHA through the same `WorktreeProvider` under the
RESERVED lease id `wt/_baseline` (branch `swarm/wt--baseline`) — reserved by
charset, not by list: job ids are validated against SPEC_ID_PATTERN
`[a-z0-9][a-z0-9-]*` (src/scheduler.ts:39, candidate ids `c01..cNN` and
rounds' `-r2` suffixes included) and every job lease is `wt/<jobId>` (+
`-a<n>` on retries), so an underscore can never collide with a job-derived
lease; every DISTINCT gate the run will use (name+command dedup key) runs
sequentially there with the standard CommandGate default timeout — the
run-level set in default mode, the deduplicated union across jobs'
effective sets (`j.gates ?? opts.gates`) in `--jobs` mode; then the
worktree is removed AND the branch deleted on every path (a leftover
`swarm/wt--baseline` would make the NEXT run's baseline lease refuse, so
a disposal failure aborts the run loudly instead of poisoning the repo).
The evidence rides `<runDir>/baseline-check.json` on EVERY path — its own
artifact because the report.json shape is for completed runs and a refusal
never produces one: `{baseSha, lease, gates: GateResult[] (the T-027
command stamp included), outcome: green|red, overridden, checkedAt}`.
A red base throws the loud per-gate block (name, command, exitCode,
outputTail, and the override hint) — exit 1 through main's catch, the
lock released by its finally — unless `--allow-red-base` was given: the
one explicit human override (the `--force-lock` posture — a named
override, not a knob), under which the run proceeds, the block still
prints with a `BASELINE RED (OVERRIDDEN)` header, and the record carries
`overridden: true` so a report can never silently mean "passed gates over
a red base". A no-gates run records the vacuous check honestly (no lease,
empty gates, outcome green). Legs, zero model tokens (real CLI, `machine`
workers, fresh throwaway repo per face):

- **R0** — `--help` documents `--allow-red-base`.
- **R1 — the refusal**: red base (test.js exits 1 at the base commit) →
  exit 1, the loud block with gate name/command/exitCode/outputTail/override
  hint, baseline-check.json naming baseSha, the reserved lease, and every
  gate's name+command+exitCode; ZERO dispatch evidence in the run dir (no
  dispatch.jsonl, no report.json, no candidate evidence dir — the refusal
  precedes runSkeleton); the worktree disposed and `swarm/*` branch gone.
- **R2 — the deduplicated union**: two disjoint-gated jobs, one red, plus
  a shared name+command pair in both → 4 raw entries check as 3 distinct
  gates in first-seen order; the refusal names ONLY the red one; disposal
  held.
- **R3 — the override**: the same red base with `--allow-red-base` →
  exit 0, candidates dispatched (dispatch.jsonl + report.json), the red
  block printed with the OVERRIDDEN header, the record carrying outcome
  red + overridden true + every command, and the gates still deciding the
  candidate's verdict over the red base (eliminated, never silently
  passed).
- **R4 — green-base inertness**: green base → the run proceeds, the
  baseline leg visible and green on stdout, the record green with the
  reserved lease named, report.json keeps today's top-level key set (no
  baseline key — additive baseline-check.json aside; the same
  shape-identity posture Gate 1.21 S1b pins field-by-field), and no
  residual baseline worktree or `swarm/wt--baseline` branch.
- **R5 — the run-level set**: jobs without per-job gates default to the
  run-level `--gate` flags, and that is exactly what the baseline checks
  (the red run-level gate refuses).
- **R6 — vacuous**: a no-gates run records `{lease: null, gates: [],
  outcome: green}` and leases nothing.

**Red bar (AGENTS.md #8), recorded BEFORE the change landed** — pre-change
tree (the lane at 2106975 = main, engine untouched), a real CLI run against
a red-base fixture (machine-worker composition, the ticket-sanctioned
token-free choice; the trigger analysis: a red base is a property of the
run pipeline, not of any adapter, so the machine composition exercises the
real dispatch path without spending tokens): run `20261023201554` at
`C:\swarm\verify-red\T-043-redbar\runs\20261023201554` — exit 0, both
candidates dispatched (2 dispatch lines in dispatch.jsonl), both burned
their worker+gate cycles and were reported as bad candidates
(`build PASS, test FAIL => FAIL`), the honest report reading "2 bad
candidates" instead of "the base is red". Post-change the same fixture
refuses (R1's shape, smoke-verified at
`C:\swarm\verify-red\T-043-postchange` before the faces above were built).

**Existing checks — updated to follow the contract, none weakened
(AGENTS.md #8, the T-042 precedent):** five fast-tier fixtures drove real
CLI runs whose gates were RED on their own untouched bases — marker-file
gates that only pass after the worker runs (`accessSync('marker-a.txt')`
and kin) and the deep-file gate. Under the new contract those are
deliberate repair-a-red-base runs and would refuse; the fixtures follow by
committing base-state content that keeps their bases green, with the
worked diff still non-empty and every discriminating assertion at full
strength: Gate 1.17 S5 (check-machine-worker.mjs — base-state marker-a/b
files, content differing from what the workers write), Gate 1.25 S6
(check-verifier.mjs — base-state marker-a), Gate 1.21 S3
(check-per-role-harness.mjs — base-state marker-a), Gate 1.24 G5b/G5c
(check-gate-retry.mjs — marker.txt committed at base with a PASSING value
`fixed content v0` that still differs from every value the worker writes,
so attempt 1's broken marker still fails the gate, the retry still
converts, and the retry's captured diff is still non-empty), and Gate 1.19
(check-long-paths.mjs — the deep file's baseline content carries the
gate's marker line; the append still changes the file). All five re-measured
ALL GREEN after the follow; Gates 1.22/1.26/1.28's CLI drives were already
base-green (vacuous/demo gates) and are untouched.

Not pinned here and carved by the ticket: verdict changes (none — the
refusal precedes any verdict), report.json schema changes (none), gate
parallelization (the baseline runs sequentially by design), and new numeric
knobs (the gates run under their own standard timeout). **Gate 2 — owed
and carried by the full tier** (the run pipeline entry changed): the
standard real 2-round `--gate-retry --verifier-model` e2e now runs the
baseline leg (build+test green on the fresh demo fixture) before its
planner dispatch — additive stdout lines only, the fixture's own baseline
being what Gate 1 regenerates green every fast-tier run. **Gate 3 — n/a**
(no adapter touched).

## Gate 1.30 — evidence-destruction guard: diff pins baseSha, branch deletion refuses non-base tips (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-diff-basesha.mjs
```

Pins T-044 (the 2026-10-23 adversarial review's F5 — the leading instance
of "invariants that gate destruction are documented, not enforced"): the
old chain let one worker `git commit` (a natural LLM action; the builder
prompt's "do not create git commits" line is a prompt rule, and prompts
reinforce, never implement, policy — spec §3.6) silently destroy its own
evidence. `WorktreeProvider.diff`'s `git diff HEAD` reads EMPTY once HEAD
moves (tree === HEAD), the ladder records `diffBytes === 0` → the NO-OP
elimination (src/runner.ts:1201, src/store/index.ts:1433), the worktree
now reads CLEAN so disposal's dirty-refusal never fires, the worktree is
removed, and `removeBranch`'s `git branch -D` destroys the commit — the
only copy of the work, silently, with the candidate mislabeled a no-op.
Two mechanical changes make the "evidence is captured before disposal"
invariant true by mechanism instead of premise:

1. **Diff against the lease's recorded `baseSha`, not HEAD**
   (`src/workspace/worktree.ts`): `git diff <lease.baseSha> --binary`
   after the unchanged `git add -A --intent-to-add .` (the T-026
   untracked/binary posture rides as is). A committing worker's work then
   appears in the captured diff and NO-OP comes to mean its honest
   semantics — "no change relative to the pinned base". Structurally
   inert for every non-committing worker: each lease checks out at
   baseSha, so HEAD === baseSha until a commit moves it and the bytes are
   identical. The NO-OP ladder expression itself is untouched — its input
   becomes honest.
2. **The branch guard** (`removeBranch`, `src/disposal.ts`): gains the
   expected base (the report's `baseSha`, plumbed through
   `RunReportLike`/`readReport` and `disposeTargets` into both clean and
   gc — the shared T-020 internals) and REFUSES `git branch -D` when the
   branch tip != baseSha, with the loud line naming branch, tip, and base
   ("carries commits beyond baseSha — evidence; re-run with --force to
   discard"). Bypass = the existing `--force`, the dirty-refusal posture
   (clean's flag; gc deliberately never passes it — a gc refusal points at
   `npm run clean -- --run <id> --force`). A run with no recorded baseSha
   (no report.json — the `wt/`-discovery paths, gc's crashed-reconciled
   lane) keeps the pre-T-044 behavior.

Legs, zero model tokens (one scratch repo; the REAL `WorktreeProvider`,
`removeBranch`, and clean CLI — the check-probe/check-gate-retry import
pattern):

- **C1 — capture**: a simulated committing worker (edit + `git commit`
  inside the lease) — `diff()` returns the committed work (non-empty,
  containing the commit's change), so the ladder's `diffBytes > 0` sees
  real work and no NO-OP mislabel;
- **C2 — guard**: `removeBranch` refuses the commit-carrying branch
  (refused++, removed stays 0, branch survives) with the loud line naming
  branch, tip, base, and the `--force` bypass; `--force` still removes it;
- **C3 — true no-op preserved**: commit-then-revert (HEAD two commits
  beyond base, tree back at base content) captures an EMPTY diff and the
  ladder still records the NO-OP verdict for an all-pass gate set;
- **C4 — inertness**: on a non-committing worktree (tracked edit +
  untracked new file + binary edit) the new `git diff <baseSha>` capture
  is byte-identical to the old `git diff HEAD` form, compared on one
  identical tree;
- **C5 — clean plumbing**: a report-driven `npm run clean` (baseSha in
  report.json) refuses the commit-carrying branch (exit 1, the loud line
  naming branch + both SHAs, branch survives, the now-clean worktree
  still disposed, tallies exactly "1 refused, 0 failed") while the
  at-base sibling's branch is removed un-refused in the same pass;
  `--force` finishes the job (exit 0).

**Red bar (AGENTS.md #8), recorded BEFORE the change landed** — the lane
at main (7c36d6e, engine untouched) running this same check: 10 failures,
exit 1. C1's two capture assertions red (diff() EMPTY for the committing
worker — the NO-OP mislabel), C2's three guard assertions red
(removeBranch deleted the commit-carrying branch), C5's five clean
assertions red (clean exited 0 and shredded the branch — the destruction
chain end to end); C3/C4 were green pre-change (they pin preserved
semantics, not the fix). Post-change: all 20 assertions green, exit 0.

Riding the same guard: Gate 1.18's check gained pass C (gc's finished-lane
sweep refuses a commit-carrying branch — see its C bullet), and verify.mjs's
`captureDiff` mirror (the Gate 1.5 integrate fixtures) now diffs the
recorded base exactly like the engine — byte-identical for its
detached-at-HEAD makers, so every T-026 binary round-trip face rides green
unchanged.

Not pinned here and carved by the ticket: no verdict-semantics change (the
ladder expression is untouched), no decisions.md change (this enforces the
existing "evidence before disposal" rule rather than any new verdict
semantics), no dispatch-header baseSha plumbing (the guard reads the
REPORT's baseSha only), no in-run dispose change (the runner still never
deletes branches — the `--clean` leak stays gc's business). **Gate 2 —
owed** (`src/workspace/worktree.ts` — the diff seam every candidate's
evidence flows through — plus `src/disposal.ts`/`src/clean.ts`/`src/gc.ts`
changed; trigger list, Gate 2's section): the standard real e2e run's diff
capture and post-run clean ride the new path, byte-inert for
non-committing workers (C4), so the run's shape is unchanged. **Gate 3 —
n/a** (no adapter change).

## Gate 1.31 — post-kill settle deadline: bounded wait after the verified tree kill (~40s, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-settle-deadline.mjs
```

Pins T-046 (the 2026-10-23 adversarial review's F6 — the one degradation
path that converted "noisy cleanup failure" into "machine wedged until a
human arrives"): both timed-run cores resolved only on the child's close,
so a kill that could not finish the job (an ACL-protected or suspended
root; a descendant outside the `/T` tree; any survivor holding an
inherited stdio pipe) left the attempt's promise pending FOREVER —
`driveJobs` never drained, and because runs serialize per-repo through a
lock nothing reaps (src/lock.ts), the target repo was unusable until a
human killed processes by hand and `--force-lock`ed. The adversarial
probe's ~20-case × full-gate-timeout amplifier made one argv-hanging
target cost ~100 minutes with the lock held.

The change, identical in shape at both sites
(`src/worker/run-with-timeout.ts`, `src/probe.ts`'s
`executeProbeCommand` — now exported for this pin, the `snapshotTree`
precedent): expiry arms `KILL_SETTLE_WINDOW_MS` — an exported documented
constant (15s; the ticket's illustrative 60s shrunk: the verified kill
completes synchronously before the window is armed and close delivery
after a verified kill is sub-second, Gate 1.12 S4, so 15s is a >10x
margin while keeping this gate's two abandonment faces at seconds each),
NEVER a CLI knob (the `MAX_RETRY_FINDINGS` pattern). Close inside the
window: today's behavior byte-for-byte (pinned by Gate 1.12 S4 riding
green unchanged — kill success line, `exitCode: null`, no abandonment
line). Close never arriving: the wait is abandoned — `timedOut: true`,
`exitCode: null` (never a guess), the loud `CLEANUP FAIL: child did not
settle 15s after verified tree kill — abandoning the wait (evidence
follows in the log)` line joining `cleanupFailures` (the T-011
vocabulary, already flowing to GateResult/WorkerResult and the candidate
report), and the stdio streams destroyed so no parent-side pipe handle
outlives the run. The window is armed at expiry in EVERY branch
(kill-fired or not): a child that already exited can still wedge the
wait through a pipe-holding descendant, and that shape gets no kill at
all. Evidence, never a verdict: the run proceeds.

The check constructs the exact wedge shape (documented in its header): a
stub root spawns a DETACHED long-sleep child that inherits the root's
pipes, then exits — the escaper is outside any `/T` walk (no live root to
walk from) while holding the pipe's write end, so close can never fire.
Zero model tokens, real process tables, never a mock:

- **A1-A9 — the worker core** (`runChildWithTimeout`, the Gate 1.12 S4
  seam): settles inside `timeoutMs + window + slack` (the outer guard
  converts the pre-change forever-hang into the RED), `timedOut: true`,
  `exitCode: null`, the abandonment line in `cleanupFailures` AND the
  log, the log's `$ exit code: null (timed out)` line, the wait actually
  lasting the window (elapsed ≥ timeout + window − 500ms), the escaper
  demonstrably STILL ALIVE at abandonment (the wedge was real — it
  escaped the kill's reach), and both stdio streams destroyed (no parent
  handle).
- **B0-B6 — the probe core** (`executeProbeCommand`): the same red/green
  pair against the same stub.
- **C1-C3 — the constant**: exported positive integer ≥ 1s; the probe
  core imports it from the worker core (single source); `src/cli.ts`
  mentions no settle anything (never a knob).
- The check's own exit is the last assertion: after the sweep reaps the
  escapers (they are outside every kill's reach by design — only the
  check can reap them, AGENTS.md #10), an unref'd watchdog converts a
  leaked-handle hang into a red.

**Red bar (AGENTS.md #8), recorded BEFORE the change landed, two
states of the same check, token-free:** at pristine main (4c99300, lane
start): 11 failures of 13, exit 1 — the worker core's A1 RED with the
outer guard firing at 26014ms (the forever-hang), the escaper
demonstrably alive (A5 green: the wedge shape held), plus the
missing-export/constant faces (B0/C1/C2). At the export-only
intermediate (one word: `executeProbeCommand` exported, no behavior
change): 15 failures of 19, exit 1 — BOTH cores' never-settling faces
RED (A1 guard at 26012ms, B1 guard at 26088ms), both escapers alive.
Post-change: all 19 assertions green, exit 0, both faces settling at
~16s (1s timeout + 15s window), the check process draining naturally.

Not pinned here and carved by the ticket: no core unification (a
refactor, not this slice), no kill-verification change (`src/kill-tree.ts`
untouched), no verdict semantics (`passedAllGates` and the ladder are
untouched; the abandonment line is cleanup-failure evidence). Normal-path
byte-identity is Gate 1.12's own S4 riding green, not re-pinned here.
**Gate 2 — owed and carried by the full tier** (`src/worker/run-with-timeout.ts`
— the core under BOTH worker adapters' timed runs —
and `src/probe.ts` changed; trigger list, Gate 2's section): the standard
real e2e run's worker/probe legs ride the new bounded wait inertly (no
healthy leg reaches expiry + window), so the run's shape is unchanged; a
real-run abandonment is not asserted (it needs a real wedge) — the
no-regression half is what Gate 2 pins. **Gate 3 — n/a** (no adapter
change; the adapters' own files are untouched).

## Gate 1.32 — gate/diff overlap evidence: flag when a candidate diff touches files its gate commands execute (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-gate-overlap.mjs
```

Pins T-045 (the 2026-10-23 adversarial review's F4): gates are shell
commands evaluated in the candidate worktree (`src/gate/command.ts:38-40`)
— for the canonical demo `node build.js` / `node test.js`, files the
worker can edit. A worker that weakens the test script plus adds a trivial
change elsewhere produces a non-zero diff that passes every gate; the
tampering IS visible in the captured diff, but nothing machine-flagged it
(the reviewer is advisory, the T-032 probe evidence-only, the T-041
ratchet human-owned cross-run), and `integrate` then re-runs the SAME
recorded gate command on a replay tree that CONTAINS the tampering —
faithfully re-verifying the weakened evaluator. Spec §35 asks "Were
evaluator jobs prevented from modifying contestants?"; the live question
is the inverse, and until T-045 nothing even recorded it.

The change — a deterministic, evidence-only overlap signal (the
`cleanupFailures` pattern: produced beside the ladder, never read by it):

1. **Compute** (`src/gate/overlap.ts`, new; called from `src/runner.ts`
   after the final attempt's ladder line, gated on the diff having been
   captured): intersect the diff's changed paths — re-derived `git diff
   <baseSha> --name-only` in the lease through the new
   `WorkspaceProvider.changedPaths` seam (`src/workspace/worktree.ts`,
   riding T-044's pinned-base semantics, `-z`-separated) — with the
   path-shaped tokens of each gate's recorded command
   (`GateResult.command`, T-027): split on whitespace and the shell
   command separators `& ; | ( )`, strip one wrapping quote pair; a token
   is path-shaped when it resolves to a file/directory in the worktree
   (absolute tokens inside the worktree fold to repo-relative form) or
   exactly matches a changed path (a file the diff DELETED no longer
   resolves — the second clause keeps it visible); a path-shaped token
   overlaps a changed path on equality or directory prefix (`npx eslint
   src/` flags every change under `src/`). Matching is Windows-forward
   (backslashes folded, case-insensitive — the `normPath` posture).
   `npm test`/`make`-style commands with no path tokens yield no overlap
   by construction. The computation can never break a run: a failure logs
   loudly and records nothing (the probes/verifier posture).
2. **Record** — the additive, producer-only `CandidateReport.gateCommandOverlap?:
   { gate: string; touched: string[] }[]` (`GateCommandOverlap`,
   `src/types.ts`), present only when at least one gate overlaps, so
   clean reports keep the exact pre-T-045 key set; a loud console line at
   the gate step (`[c01] gate test: PASS — NOTE: diff touches files this
   gate executes: test.js`, verdict-embedded, printed per overlapping gate
   regardless of its PASS/FAIL); the RUN SUMMARY line carries the marker
   (`  gate-overlap:test(test.js)`, `src/cli.ts`).
3. **Surface at replay** (`src/integrate.ts`) — when the candidate
   carries the block, the replay prints the note BEFORE any gate output
   (the operator sees the sentence before trusting a replay PASS) and
   records the block verbatim in the verdict JSON
   (`IntegrateVerdict.gateCommandOverlap`, on both verdict write paths);
   the exit code stays gate-determined.

A HEURISTIC, honestly named one, and the check pins its limits as
documented: **transitive loads are invisible** (`node build.js` can
`require` anything the diff touched without any token naming it);
redirect targets written as separate tokens can over-flag (glued
`>out.txt` tokens drop out — redirect operators are deliberately not
separators); `npm test` flags only if a file literally named `test`
exists and changed. Non-goals carved by the ticket: transitive-load
analysis, pristine-copy gate execution, ANY verdict effect — no ladder
line reads the block (no decisions.md change needed; the 2026-10-10
machine-gates decision stands untouched).

Legs, zero model tokens (fake WorkerAdapter + REAL CommandGates against
scratch repos, the real CLI's machine worker, the real integrate CLI —
the check-gate-retry import pattern):

- **O1 — the tampering core (the red-bar face)**: a worker that weakens
  `test.js` (the file gate `test=node test.js` executes) plus adds a
  trivial change elsewhere — real gates, real execution: every gate
  PASSES on the weakened evaluator, the tampering is visible in the
  captured diff, and the report block names gate + touched path, the
  NOTE line prints, the non-overlapping gate gets no note, and
  `passedAllGates` is unchanged (pass direction);
- **O2 — clean-negative**: a diff touching only non-gate files produces
  NO block, NO note, and a candidate report whose key set is exactly the
  pre-T-045 list (the byte-identical producer-only shape);
- **O3 — verdict inertness (fail direction)**: overlap entries on BOTH a
  passing and a failing gate — the verdict follows the gates alone
  (FAIL), the block records both, the NOTE prints for each regardless of
  verdict;
- **O4 — multi-token commands + the seam**: `npx eslint src/` flags a
  change under `src/` (directory prefix); `npm run build` never flags
  (no path tokens); `node gone.js` flags a file the diff DELETED (the
  matches-changed-paths clause); `WorkspaceProvider.changedPaths` pinned
  directly on the drive's lease (edit + edit + deletion);
- **O5 — the real CLI** (machine worker, `--jobs`): the gate-step NOTE
  line and the RUN SUMMARY marker on stdout, the block in the on-disk
  report.json, exit 0 — today's verdict, plus the flag;
- **O6 — integrate surfacing**: an overlap-carrying survivor's replay
  exits 0 with the note printed and the block recorded verbatim in
  `<id>.json`; the same shape with a failing replay gate exits 1
  (gate-determined, the block forced nothing) with the note and block
  still recorded; a clean survivor's replay prints no note and records
  no block key.

**Red bar (AGENTS.md #8), recorded BEFORE the change landed** — the lane
at main (33db211, engine untouched) running this same check: 16 failures
of 35, exit 1 — exactly the new-behavior faces (O1's block/key/NOTE ×3,
O3's both-gates block + both NOTE lines ×2, O4's lint/npm/gone/seam ×4,
O5's NOTE/marker/on-disk block ×3, O6's note+block on both replay faces
×4). The 19 green faces pin preserved semantics (the verdict machinery,
the clean-negative shape, the gate-determined exits — the Gate 1.30
C3/C4 pattern), and the ticket's premise was confirmed empirically at
main: the weakened evaluator passed every gate and the tampering was
visible in the captured diff, with no machine trace. Post-change: all 35
assertions green, exit 0.

Riding the same signal: Gate 1.21's check (`check-per-role-harness.mjs`)
S3 — its real-CLI drive is itself a TRUE overlap positive (the gate
command `node -e "require('fs').accessSync('marker-a.txt')"` names the
very file the worker's machine command changes), so its candidate
legitimately carries the block; the drive's expected key set gained
exactly the ticketed `gateCommandOverlap` producer (the assertion's
T-025 intent — no adapter-id fields — unchanged) plus a NEW assertion
pinning the block as the true positive. Every other existing assertion
rode green unchanged.

Not pinned here and carved by the ticket: no verdict-semantics change
(the ladder expression is untouched), no decisions.md change, no
transitive-load analysis, no pristine-copy gate execution, no dispatch
evidence line (the block rides the report only). **Gate 2 — owed**
(`src/runner.ts` — the gate loop's verdict-adjacent code — plus
`src/types.ts` report shape, `src/cli.ts` summary, `src/integrate.ts`,
`src/workspace/worktree.ts` workspace handling; trigger list, Gate 2's
section): the standard real e2e run rides the computation on every
candidate's final attempt — a real run's candidates touch only source
files (not `build.js`/`test.js`), so no block is expected and the run's
shape is unchanged; whether a real candidate ever produces a block is
read off the run's reports, never asserted. **Gate 3 — n/a** (no adapter
change).

## Gate 1.33 — ignored-path parity evidence: ignored-tree snapshot per attempt + integrate parity note (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-ignored-paths.mjs
```

Pins T-047 (the 2026-10-23 adversarial review's F2, with the ticket's
recorded scratch-repo repro): `WorktreeProvider.diff` respects
`.gitignore` — a file written under `node_modules/`, `dist/`, or any
ignored path appears in NEITHER the captured `diff.patch` (the
`git add -A --intent-to-add .` + `git diff` capture never sees it) NOR
`git status`'s ordinary output — while the gates execute in the live
worktree where those files DO exist. Two consequences the engine
recorded nothing about: a worker (or derailing cheap model) can make
gates pass via changes in ignored paths — the promoted diff contains
none of it, so the run's survivor and the replayed artifact measure
different trees — and, legitimately, any gate that installs
dependencies creates a large ignored tree per worktree, so RUN gates
and REPLAY gates (a fresh worktree holding only HEAD + diff.patch)
execute in systematically different environments, with the replay's
failure recorded as an ordinary gate FAIL, indistinguishable from a bad
candidate.

The change — the mechanical first slice, VISIBILITY ONLY (the
`cleanupFailures`/`gateCommandOverlap` pattern: produced beside the
ladder, never read by it; no decisions.md change — the 2026-10-10
machine-gates decision stands untouched):

1. **Snapshot** (`src/runner.ts`, after the final attempt's gate loop so
   gate-installed trees are included — they are the parity-relevant
   set; before probes/review/dispose): `git status --porcelain
   --ignored` in the lease through the new `WorkspaceProvider.
   ignoredStatus` seam (`src/workspace/worktree.ts`; default untracked
   mode, so an ignored directory collapses to one `!! node_modules/`
   line), written verbatim to the attempt's evidence dir as
   `ignored-paths.txt` and recorded among the attempt's
   `outputArtifacts` (the diff.patch precedent) — ONLY when the `!!`
   set is non-empty. Summarized on the report as the additive,
   producer-only `CandidateReport.ignoredPaths?: IgnoredPathsSummary
   { count, entries }` (`src/types.ts`): count = the FULL pre-cap total
   of the porcelain `!!` set, entries = its first MAX_IGNORED_PATHS
   paths in porcelain order (repo-relative, forward slashes; the cap
   exported from `src/runner.ts`, the MAX_RETRY_FINDINGS pattern,
   asserted against the engine's own export so docs and code cannot
   drift). The cap bounds the report summary only — the evidence file
   keeps every `!!` line. A loud console line at the evidence step.
   The snapshot can never break a run (the probes/verifier posture): a
   failure logs loudly and records nothing.
2. **Integrate note** (`src/integrate.ts`): replaying a candidate whose
   report carries a non-empty summary prints the parity note BEFORE any
   gate output (the T-045 posture) — "the run environment held ignored
   trees the replay tree lacks: node_modules/, … — gate parity is not
   established" — and records the summary verbatim in the verdict JSON
   (`IntegrateVerdict.ignoredPaths`, both verdict write paths). The
   exit code stays gate-determined: a passing replay still exits 0, a
   failing gate still exits 1, the note neither vetoes nor forces.

**The carve, stated:** this ticket only stops the asymmetry from being
invisible. Dependency provisioning for worktrees (spec §13's manifest —
a real design decision with cost/supply-chain tradeoffs), pristine gate
environments, and tamper DETECTION for ignored paths (mtimes/hashes) are
carved non-goals needing a decision, not a slice. What the snapshot does
give the §13 question is its data: once runs record what ignored trees
their gates needed, the manifest decision has measurements instead of
guesses.

Legs, zero model tokens (fake WorkerAdapter + REAL CommandGates against
scratch repos, the real WorktreeProvider + runner, the real integrate
CLI — the check-gate-overlap import pattern):

- **F0 — the cap export**: `MAX_IGNORED_PATHS` is exported and equals
  50 (namespace import, so the pre-change red bar is behavioral, not a
  module-link crash);
- **I1 — the ignored-write core (the red-bar face)**: the ticket's
  2026-10-23 repro — a worker writes a tracked change PLUS files under
  `node_modules/` and `dist/`. The blindness premise is pinned as it
  lands (the captured diff contains NONE of the ignored writes while
  the files exist in the lease the gates executed in), then the new
  evidence: `ignored-paths.txt` holds the full porcelain snapshot, the
  report summary is exactly `{count: 2, entries: ["dist/",
  "node_modules/"]}` (porcelain order), the attempt records the file
  among its output artifacts, the console line prints, and
  `passedAllGates` is untouched (pass direction). The
  `ignoredStatus` seam contract pinned directly on the drive's lease
  (raw porcelain: `!!` entries + the tracked modification);
- **I2 — gate-installed trees (the placement pin)**: the worker writes
  NO ignored file; a real gate (`node install-fixture.js`, the
  npm-install shape) creates `node_modules/x/` itself — the snapshot
  records it, proving it runs AFTER the gate loop (a pre-gate snapshot
  would record nothing);
- **I3 — the cap pin**: 60 ignored entries record count 60, entries
  exactly the FIRST 50 in porcelain order (top-N, not a sample), the
  evidence file keeps all 60 `!!` lines, and the console line names the
  remainder (+10 more);
- **I4 — clean-negative**: a `.gitignore` exists but nothing ignored
  is on disk — NO block, NO snapshot file, NO console line, no
  `ignoredPaths` bytes anywhere in the serialized report, and the
  candidate report's key set exactly the pre-T-047 list
  (byte-identical shape, the producer-only pattern);
- **I5 — verdict inertness (fail direction)**: ignored paths present
  AND a failing gate — the verdict follows the gates alone (FAIL), the
  block still records the ignored set (evidence rides the verdict
  either way; ignored-path presence eliminated nothing, promoted
  nothing);
- **I6 — integrate parity note**: a summary-carrying survivor's replay
  exits 0 with the note printed (ignored trees named, "gate parity is
  not established") and the summary recorded verbatim in `<id>.json`;
  the same shape with a failing replay gate exits 1 (gate-determined,
  the note forced nothing) with note and block still recorded; a clean
  survivor's replay prints no note and records no key (the
  producer-only pattern at the replay surface); a capped summary's
  note names the remainder (+10 more).

**Red bar (AGENTS.md #8), recorded BEFORE the change landed** — the
lane at main (ce0d65f, engine untouched) running this same check: 20
failures of 41, exit 1 — exactly the new-behavior faces (F0; I1's
snapshot/summary/key/artifact/console/seam ×6; I2's block+file; I3's
count/entries/file/remainder; I5's block; I6's note+block on the pass,
fail, and capped faces ×6). The 21 green faces pin preserved semantics
(the blindness premise itself, the verdict machinery in both
directions, the clean-negative shape, the gate-determined replay
exits). Post-change: all 41 assertions green, exit 0.

Not pinned here and carved by the ticket: no verdict-semantics change
(the ladder expression is untouched — the block is produced after it
and nothing downstream reads it), no decisions.md change, no run
summary marker (the ticket names the integrate note, not a CLI marker),
no store schema change (the store ingests verdicts only; the block
rides the report artifact). **Gate 2 — owed** (`src/runner.ts` — the
gate loop's verdict-adjacent code — plus `src/types.ts` report shape
and `src/integrate.ts`; trigger list, Gate 2's section): the standard
real e2e run rides the snapshot on every candidate's final attempt —
the demo fixture carries no ignored trees (no `npm install`-style
gate), so no block is expected and the run's shape is unchanged;
whether a real candidate ever produces a block is read off the run's
reports, never asserted. **Run 20261024021432 (the driving Gate 2):
no candidate carried a block — the prediction held on a real run.**
That run's one failing assertion is the Known issue #6 worker-no-op
class (a c02-r2 path-transcription no-op), not this change-set — see
that entry's 2026-10-24 observation. **Gate 3 — n/a** (no adapter
change).

## Gate 1.34 — clean's evidence-parity predicate: refuse on un-captured changes, not on captured evidence (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-clean-evidence.mjs
```

Pins T-048 (the 2026-10-23 adversarial review's F3, with the ticket's
recorded scratch-repo repro): `disposeTargets` refused any worktree whose
`git status --porcelain` was non-empty — but `WorktreeProvider.diff` runs
`git add -A --intent-to-add .` on every attempt, so porcelain ALWAYS read
dirty for exactly the worktrees worth cleaning (the repro: post-capture
porcelain ` M build.js` / `A notes-new-file.md`). The refusal fired
precisely when evidence existed, `npm run clean` without `--force`
succeeded only for no-ops, the operator learned to always pass `--force`,
and the protection's real target — changes made AFTER capture — was
silently discarded too, because `--force` cannot tell the two apart.

The change (`src/disposal.ts`, the shared loop clean and gc both drive —
T-020): a worktree is removable without `--force` iff its CURRENT state
matches what the captured evidence holds. Mechanically: re-run the capture
form in the worktree (the same two list-form git calls
`src/workspace/worktree.ts` makes — `git add -A --intent-to-add .`, then
the diff), byte-compare against the run's stored final-attempt
`diff.patch` (`evidenceDiffPath` mirrors the runner's evidence geometry:
attempt 1 `<runDir>/<id>/diff.patch`, attempt n ≥ 2
`<runDir>/<id>/attempt-<n>/diff.patch`, exact by construction for every
runner-produced lease, report or no report):

- **equal (or both empty)** ⇒ captured ⇒ removable — the false-positive
  class dies: a fully-captured worktree cleans with plain `clean --run`;
- **empty re-capture** ⇒ the tree holds no non-ignored changes relative
  to its own HEAD — nothing un-captured exists (a committing worker's
  work lives on its branch, which the T-044 guard refuses);
- **stored patch missing/unreadable** ⇒ refuse — "worktree holds
  un-captured changes — stored diff.patch missing or unreadable;
  re-run with --force to discard" (the evidence-first posture);
- **different bytes** ⇒ refuse — "worktree differs from its captured
  evidence — post-capture changes; re-run with --force to discard".

`--force` semantics unchanged (the explicit human override, never
weakened); evidence is never deleted (unchanged); the ITA-staging side
effect is untouched (T-044/capture territory — this change only reads).
Two documented precisions, both load-bearing: the re-capture diff target
is the worktree's **HEAD**, byte-identical to the T-044 base-diff on
every tree the comparison governs (each lease checks out at baseSha, so
HEAD === baseSha until a commit moves it — Gate 1.30 C4's inertness pin),
while a base-relative diff on a non-lease worktree (an `int-*` replay
detached at a drifted HEAD) would measure the drift, not the tree, and
falsely refuse porcelain-clean replay trees Gate 1.5's sweep disposes
without `--force`; and the comparison is **byte-stable on CRLF-shaped
trees** (Known issue #5's class) because both passes run the identical
capture form under the identical git config — pinned empirically, no
tolerant comparison needed, none applied.

Legs, zero model tokens (real `WorktreeProvider` leases + captures, the
real `clean` CLI, scratch repos — the check-diff-basesha pattern):

- **P0** — the geometry export: `evidenceDiffPath` maps `wt/<id>` →
  `<runDir>/<id>/diff.patch`, `wt/<id>-a2` →
  `<runDir>/<id>/attempt-2/diff.patch`, off-`wt/` paths → null (namespace
  import, so the pre-change red bar is behavioral);
- **P1 — captured-green (the red-bar face)**: the 2026-10-23 repro —
  tracked edit + untracked new file + binary edit, fully captured by
  `diff()`, porcelain provably dirty — removed by PLAIN `clean --run`
  (exit 0, worktree + `swarm/*` branch gone, evidence kept);
- **P2 — protection intact, both legs**: the same setup plus a
  post-capture append REFUSED without `--force` (loud line names the
  reason), worktree + branch + evidence survive; `--force` still
  discards;
- **P3 — missing-evidence refusal**: a changed worktree whose run dir
  holds no stored `diff.patch` (the crashed-pre-capture shape) refused
  with the un-captured-changes line;
- **P4 — both-empty**: a no-op candidate (empty stored patch, tree at
  base) cleans without `--force`;
- **P5 — line-ending stability**: the whole captured-then-cleaned cycle
  on a repo with `core.autocrlf=true` (baseline and worker bytes
  CRLF-shaped on disk, asserted) — no false refusal;
- **P6 — retry-leg geometry**: the attempt-2 lease `wt/<id>-a2` finds
  its attempt-2 evidence and cleans green.

The gc lane (the same predicate riding shared `disposeTargets`, T-020)
is pinned by Gate 1.18's check extended with pass D, both legs: a
crashed-reconciled worktree whose changes were captured before the crash
is disposed by the no-`--force` gc pass (branch and all), and the same
shape plus a post-capture edit is refused per-item with the
evidence-parity line (worktree + branch + evidence survive, exit 1) —
alongside A5, whose changed no-evidence worktree now refuses with the
missing-evidence line (the pin updated to the new message; the refusal
itself is unchanged).

**Red bar (AGENTS.md #8), recorded BEFORE the change landed** — the lane
at main (5b48eb2, engine untouched) running this same check: 10 failures
of 25, exit 1 — P0 ×4 (no geometry export), P1 ×2 (the fully-captured
worktree REFUSED by plain clean, branch surviving — the repro), P2/P3's
message faces ×2 (the old line names no reason), P5 (the CRLF cycle
false-refused), P6 (the retry-leg captured worktree refused). The 15
green faces pin preserved semantics: the premises (post-capture
porcelain dirty, real captures, CRLF bytes on disk), refusals still
refusing, `--force` still discarding, the both-empty leg cleaning,
evidence never deleted. Post-change: all 25 assertions green, exit 0,
and Gate 1.18's extended check green with every pre-existing assertion
intact.

Not pinned here and carved by the ticket: `--force` semantics (never
changed), evidence disposal (never — unchanged), the ITA-staging side
effect itself (T-044/capture territory), tolerant line-ending
comparison (not needed — P5 pins byte-stability under identical config;
if a real-world drift class ever appears, it gets its own recorded repro
and documented tolerance, never a silent one). **Gate 2 not owed** —
trigger analysis, per the T-041 precedent: no `src/runner.ts`, no
adapter, no report shape, no scheduler/store/dashboard surface — the
change-set is disposal only (`src/disposal.ts` + the two commands'
comment/usage wording), and the full fast tier (Gates 0 through 1.34,
including Gate 1.5's clean/disposal scenarios and Gate 1.18's gc lane)
re-runs green against the new predicate. **Gate 3 n/a** (no adapter
change).

## Gate 1.35 — round-2 brief-premise guard: composer framing + mechanical brief annotation (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-brief-premise.mjs
```

Pins T-050 — the Known issue #6 successor (the 2026-10-23 mechanism, run
20261023204747): the rounds composer renders survivor evidence into the
round-2 planner prompt, and that planner wrote a brief asserting
`vec3.js` exists — a file only a round-1 SURVIVOR DIFF creates, absent
from the shared base round 2 re-leases at. The worker's read failed, it
exited 0 with zero edits, and the NO-OP ladder eliminated a candidate
whose brief lied about the workspace (the ladder behaved perfectly; the
brief was wrong). Two deterministic changes, both verdict-silent:

1. **Composer framing fix** (`src/rounds.ts`): the rendered block's fixed
   framing gains explicit premise lines (exported `ROUND_PREMISE_LINES`,
   pinned verbatim): survivor diffs are CHANGES against the same base, not
   base state; round 2 re-leases at the SAME baseSha; files created by
   survivor diffs DO NOT exist in a round-2 worktree; every brief must be
   implementable at the base commit alone. The lines are framing, not
   record content — no ArtifactRecord changes, so the packet and its
   fingerprint are byte-identical (pinned: no record content and no packet
   field carries them; legs B/C still recompute the fingerprint over the
   new block). Round-1 prompts (no block) are byte-identical to today —
   pinned in both this check and Gate 1.22's extended leg A/B.
2. **The mechanical guard** (`src/premise.ts`, wired in `src/runner.ts`):
   before PLANNER-AUTHORED briefs become jobs — rounds 1 AND 2 (the
   round-1 planner is repo-blind and can hallucinate paths just as
   easily) — each brief is scanned for path-shaped tokens (the T-045
   `commandTokens` extraction; a token is path-shaped when its final
   dot-suffix is in the curated `PATH_TOKEN_EXTENSIONS` list); each token
   naming a file ABSENT at `baseSha` (`git cat-file -e` against the
   recorded base, no lease needed) gets a fixed engine note APPENDED to
   the brief — the survivor-created reason when the path is in a round-1
   survivor's changed paths (the T-045 `WorkspaceProvider.changedPaths`
   seam, recorded per candidate in-run where the T-045 overlap block
   already derives them), the distinct base-commit-absent note otherwise.
   The ANNOTATED brief dispatches (hashed into that attempt's
   `promptVersion` — one composition, two consumers, the T-029/T-038
   precedent); the planner's UNANNOTATED brief is preserved verbatim in
   `brief-premise.txt` (before/after) riding the attempt's
   `outputArtifacts`, and `CandidateReport.brief` keeps the planner's
   text (the retry-brief precedent). Bounded at the exported
   `MAX_PREMISE_NOTES` (5, the MAX_RETRY_FINDINGS pattern), first-mention
   order. `--jobs` briefs are operator-owned and NEVER touched — and so
   are planner-fallback raw-goal briefs and `--no-planner` briefs (the
   goal is operator text; pinned). A HEURISTIC, honestly named one (the
   T-045 posture): extensionless names (`Dockerfile`), directory-only
   paths (`src/utils`), suffixes outside the list, and prose identifiers
   (`Math.sqrt`, `console.log` — also why 'log' is not in the list) are
   honest misses; false positives are impossible by construction (every
   flagged token is probed against the base tree first). Never-break-a-run
   posture: an unresolvable base commit throws, the runner logs once per
   brief and dispatches unannotated (today's exact behavior).

Legs (P1–P8 + F, 43 assertions, zero model tokens — fake WorkerAdapters +
the real WorktreeProvider + the real runner; module-direct legs for the
bound and determinism): P1 the Known-issue mechanism replayed — vec3.js
exists only in a recorded survivor diff, the round-2 brief says "extend
vec3.js …", and the dispatched prompt carries the fixed survivor-created
note, `brief-premise.txt` records before/after byte-identically to an
independent recomputation through the same changedPaths seam,
`promptVersion` equals the dispatched prompt's sha256 and DIFFERS from
the unannotated text's, `brief` keeps the planner's text; P2 the distinct
absent-at-base note for a path in no survivor evidence (never the
survivor reason, never another brief's note); P3 inertness — all-tokens-
at-base briefs dispatch byte-identical prompts (recomputed equality
against the exact dispatched composition: `workerDispatchPrompt` since
T-060, the bare `builderPrompt` before it — the comparison stayed
byte-exact, only the expected prefix grew), no evidence file, today's
exact candidate key set, no note bytes; P4 `--jobs` carve (byte-identical dispatch on an
absent-naming brief); P5 the bound (8 absent tokens → at most
MAX_PREMISE_NOTES notes, first-mention order); P6 verdict inertness both
directions (annotated + real change → passes exactly by gates; annotated
no-op → eliminated exactly by the diffBytes leg, evidence file still
written); P7 round-1 annotation plus the fallback/`--no-planner`
operator-owned carve; P8 module contract and determinism. F legs pin the
framing from a real 2-round drive. Gate 1.22's check (rounds) is extended
in the same change-set with five framing assertions (leg A: the lines
verbatim, inside the framing, absent from records and packet; leg B: the
round-2 planner prompt carries them, the round-1 prompt carries none) —
63 assertions ALL GREEN.

**Red bar (AGENTS.md #8), recorded BEFORE the change landed** — the lane
at main (96a2a81, engine untouched) running this same check: 13 failures
of 38, exit 1 — the guard legs (no note in the dispatched prompt, no
`brief-premise.txt`, no promptVersion split, no round-1 note, no evidence
file on the annotated no-op, module/constant missing) and the three
framing legs (no `ROUND_PREMISE_LINES` export, not in the block, not in
the framing position). The 25 green faces pin preserved semantics:
inertness, the `--jobs`/fallback/`--no-planner` carves, verdicts by
gates alone, `brief` keeping the planner's text, and the block-in-
round-2-prompt-only separation. Post-change: all 43 assertions green,
exit 0, and the full fast tier (Gates 0 through 1.35) ALL GREEN with
every pre-existing assertion intact.

**Gate 2 owed** — trigger analysis: the change-set touches `src/runner.ts`
(the brief→job path both rounds, the attempt dispatch brief, the
changed-paths threading) and `src/rounds.ts` (the composed block every
round-2 planner prompt embeds), and the round-2 e2e leg is the real
exercise of the guard — a real planner-authored round-2 brief over real
survivor evidence, annotated or honestly inert, observable in the
dispatched attempt's `promptVersion` and any `brief-premise.txt` under
the run dir. Whether a real run's round-2 planner actually names a
survivor-created file is model-behavior variance, recorded honestly
either way (the Known issue #6 disposition posture). **Gate 3 n/a** (no
adapter change).

**Gate 2 run (review round 1, run 20261024193003): 1 failure — the c02
NO-OP, Known issue #6's fourth worker-class observation (the
give-up-without-editing class; no premise lie, no containment event; the
full diagnosis is recorded there).** Everything the tier asserts about
the loop, the guard's siblings, the verifier, review, hygiene, and
disposal was green on the same run — and the T-050 real-run surfaces
this gate exists to exercise were confirmed from the run's kept
artifacts: the guard FIRED on c01's round-1 brief (`src/calc.js`
absent at the root-level base — the planner's own hedge), the
annotated candidate SURVIVED (the note verified a path instead of
derailing a worker), the composed block carried all four premise lines
into the real round-2 planner prompt, and that planner stated TRUE base
facts unprompted (c01-r2 guard-inert, surviving). No code change, no
weakened assertion — the red leg is model-behavior variance in a
recorded class; the remedy is a re-run.

## Gate 1.36 — yield instrumentation: derivation arithmetic, round sub-totals, derailment markers, verdict inertness (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-yield.mjs
```

Pins T-049 — the 2026-10-23 adversarial review's A2 instrument: the
mechanically derived, additive, producer-only `RunReport.yield` block
(`RunYield`, src/types.ts; derivation `deriveRunYield`, src/yield.ts),
produced by the runner after every other report block attaches. You
cannot manage what the honest report tells you only anecdotally: every
decision that matters next (which worker model, which prompt posture,
whether `--rounds 2` earns its tokens) needs per-run yield numbers, and
until T-049 the only way to get them was to re-derive them by hand.

**The metric definitions** (every count a pure derivation over data the
report already holds — the ladder vocabulary `FailureReason` and the
store's elimination classes, `eliminationReason` in src/store/index.ts:
error → worker-failed → no-op → no-gates → gates-failed):

- `candidates` — dispatched candidates, report order.
- `attemptsDispatched` — Σ per-candidate attempts (mechanical retries and
  the T-038 gate-retry leg included).
- `workerOkAttempts` — attempts whose worker leg succeeded: no failure
  record, or `failure.reason === 'gates-failed'` (the T-038 pre-retry
  leg — the worker succeeded; the gates, not the worker, rejected).
- `nonZeroDiffAttempts` — attempts with a machine-known non-zero captured
  diff. The report's only diff byte count (`diffBytes`) describes the
  FINAL attempt, so that attempt counts iff `diffBytes > 0`; a non-final
  attempt counts iff `failure.reason === 'gates-failed'` (the T-038
  firing condition requires a non-zero captured diff, decisions.md
  2026-10-21). A retried worker-failed leg's partial diff size is not
  report data and counts nowhere — an honest absence, never a zero.
- `gateFailedFinalAttempts` — the store's 'gates-failed' class, FINAL
  attempts only (workerOk, non-zero diff, gates ran, at least one
  rejected; a pre-retry gates-failed leg is not a final attempt).
- `noOpEliminations` — the store's 'no-op' class: workerOk with a
  zero-byte captured diff (AGENTS.md #7's machine-known NO-OP).
- `survivors` — `passedAllGates === true`.
- `noOpAttemptIds` — the FINAL attempt id of every no-op candidate.
- `perRound` (present only when the report carries a `rounds` block) —
  the same count set per round; membership by the runner's id
  convention (`<survivorId>-r2`, src/runner.ts), so a
  recorded-but-not-executed round carries zeros, never fabrications.

**The derailment marker, evidence-only.** For each no-op attempt, when
its `worker.log` (the attempt's own recorded artifact) contains the
harness's external_directory auto-reject line, the block records a
`derailmentMarkers` note citing the matched literal. The recorded line,
verbatim from the cited run evidence (run 20261024021432, the T-047
lane's driving Gate 2, its c02-r2 worker.log — the run's artifacts were
wiped from disk by a later Gate 2 run's root reset, so the literal is
cited from this file's own Known issue #6 2026-10-24 entry, which
recorded it at landing time, and byte-cross-checked against the same
harness frame on disk in run 20261010235146's c02/c03 worker.logs and
run 20261024203025's planner logs):

```
permission requested: external_directory (C:\swarm\verify\20261024021432\wt\c02\r2\*); auto-rejecting
```

The parenthesized path is per-run; the matched literal
(`DERAILMENT_MARKER`, src/yield.ts) is the line's stable
path-independent frame, a byte-exact substring of every recorded
instance, never a paraphrase and never a regex:

```
permission requested: external_directory
```

A HEURISTIC, honestly named one: a deterministic string match on
recorded bytes, labeled evidence — never a verdict input, never a
classification the ladder reads (decisions.md 2026-10-10: gates decide
survival). A no-op without the marker is still recorded
(`noOpAttemptIds`); the marker without the zero diff produces nothing;
a missing or unreadable worker.log degrades to no note and never throws.

**Producer-only.** The block is produced ONLY when the run recorded at
least one machine-known no-op elimination — a clean run's report shape
is byte-identical to pre-T-049 (pinned on a real `runSkeleton` drive:
no `yield` key, no bytes, exactly the pre-T-049 top-level key set). One
existing pin was extended in the same change-set, not weakened: Gate
1.22 leg B's exact top-level key set gains `yield`, because that
fixture intentionally carries a no-op round-2 candidate ("change
nothing") — exactly this block's producer (the T-030 precedent: that
ticket added `rounds` to the then-existing key pin the same way).

**Verdict inertness.** The block is derived after the ladder; no ladder
line, retry decision, or elimination path reads it. Pinned
behaviorally: candidates are byte-identical with and without the block
(every elimination-determining field: `workerOk`, `diffBytes`, gate
verdicts, `error`, `passedAllGates`), and a derivation failure in the
runner logs and records nothing — an instrument must never break the
run it measures.

Carved (later slices, the T-034 producer-only precedent): store columns,
dashboard tiles, and any cross-run aggregation. No decisions, no
thresholds, no early-stop wiring — A2 explicitly does NOT feed
verdicts. The report is this slice's durable copy. Red bar (AGENTS #8):
the landed check against main's engine at the lane — 11 failures, exit
1 (`C:\swarm\verify-red\T-049-redbar.log`); post-change the check is
ALL GREEN. Required whenever `src/yield.ts` or the yield block's
derivation changes.

## Gate 1.37 — dashboard write surface: Host/Origin request gate, decide race closed by construction, %zz → 400 (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-dashboard-write.mjs
```

Pins T-051 — the 2026-10-23 adversarial review's register R3, ticketed
`ticket-later` with this exact scope. The dashboard's only network-reachable
write (`POST /approvals/decide`, `src/dashboard.ts` — the approval-audit
record other subsystems treat as the human decision of record) gets three
mechanical changes, no behavior change for the legitimate operator:

- **The request gate** (top of `handle`, before any route and so before any
  DB open): Host must be `127.0.0.1[:port]` or `localhost[:port]`; Origin,
  when present, must be one of `http://127.0.0.1[:port]` /
  `http://localhost[:port]`. Anything else → 403 plus exactly ONE loud
  `console.error` line naming the rejected header and its value. This
  closes browser-form CSRF (browsers stamp cross-origin POSTs with an
  Origin header) and DNS rebinding (rebound requests carry an attacker
  Host). Pinned hostile legs: `Origin: http://evil.example` on the decide
  POST, `Host: evil.example` on a GET, an `https://` origin, the
  suffix spoofs `http://127.0.0.1.evil.example` and
  `localhost.evil.example`, and a Host-less HTTP/1.0 request over a raw
  socket (node:http auto-stamps Host, so that leg needs literal wire
  bytes) — all 403, each with its one loud line, and a sha256 over the DB
  file proving every refused request (403s and the 400 legs below) touched
  ZERO bytes: the gate refuses before any DB open.
- **Legitimate-request inertness**: `Host: localhost[:port]`, a matching
  Origin, and no Origin at all (the stdlib-fetch face every existing
  dashboard check drives) are served exactly as today — 200s, and a decide
  POST with `Origin: http://127.0.0.1:<port>` lands through the real
  `decideApproval` (row flipped, `decided_by`/note recorded, exactly one
  APPROVAL_GRANTED event). Every pre-existing dashboard face is additionally
  pinned by Gate 1.23 riding green unchanged in the same fast tier (its
  fetches send a loopback Host and no Origin).
- **The decide race, closed by construction** (`decideApproval`,
  `src/store/index.ts`): the approval_gates state read moved INSIDE the
  transaction and the UPDATE made conditional
  (`WHERE ... AND state = 'waiting_for_approval'`), refused with today's
  byte-identical double-decide message when `changes === 0`. Pinned three
  ways: a second SEQUENTIAL decide (no Origin — also the no-Origin POST
  inertness leg) refuses 409 with the exact pre-T-051 message and writes
  nothing; an OVERLAPPING two-process pair (both children spawned together
  by the check, one approving one rejecting the same row through the real
  store under tsx) lands EXACTLY ONE decide — the row carries the winner's
  decision and decider, exactly one APPROVAL_GRANTED/REJECTED event for the
  row, NEVER one APPROVED *and* one REJECTED (the pre-T-051 corruption
  shape); and a QUICK-SUCCESSION two-process pair (second decide ~1s behind
  the first, the CSRF-racing-a-human shape) refuses AT THE GUARD with the
  exact double-decide message. The overlapping pair's loser face is
  timing-dependent (the guard's message, or a SQLite `database is locked`
  at open/update/commit — every face refuses with nothing written), so it
  is logged, never asserted. **Honesty note, the ticket's own:** the TOCTOU
  has no deterministic single-process red — node:sqlite is synchronous, the
  interleaving needs two processes — so the race's red is the code-shape
  citation in the ticket (`:691-706` read-outside-BEGIN + unconditional
  UPDATE), never a claimed reproduced red; on the red-bar run the
  overlapping-pair legs failed only because the CSRF leg's landing (main
  served it, 200) had already decided the row — the cascade is itself the
  attack demonstrated.
- **Malformed percent-encoding → 400, not 500**: `decodeURIComponent` on
  path segments is guarded (`decodePathSegment`); `%zz` in each decoded
  segment (`/run/%zz`, `/run/<id>/job/%zz`, `/run/%zz/context`) returns a
  400 page naming the malformed segment — pre-T-051 the URIError fell to
  the outer catch's 500.

Red bar (AGENTS #8), recorded before the change on main's engine at the
lane with the final check version: 18 failures, exit 1, teed to
`C:\swarm\verify-red\T-051-redbar.log` — the cross-origin decide POST
landed (200, durably approving the row), the rebound Host was served
(200), the https/suffix origins reached the store (409), the Host-less
request was served (200), and all three `%zz` legs 500'd. Post-change the
check is ALL GREEN (observed green on three consecutive runs; which child
  wins the overlapping pair is timing's choice — the assertions read the
  winner off the outcome, never assume an order). Non-goals
carved by the ticket and unchanged: content-type checks, CSRF tokens
(Host/Origin cover the browser threat class), auth beyond localhost (the
T-034 trust-domain posture), and `requestApproval`'s outside-transaction
check (its race fails loudly on the PK, not silently — carved). Gate 2
trigger analysis (the T-041 precedent): NOT triggered — the change-set
touches `src/dashboard.ts` (a store consumer) and `src/store/index.ts`'s
`decideApproval` only; nothing on the trigger list (src/runner.ts,
adapters, gates, workspace handling, report shape) changed, the
T-006/T-008/T-034/T-035/T-037 standalone-consumer precedent. Gate 3 n/a
(no adapter; the dashboard spawns no harness). Required whenever the
dashboard request gate or the store's decide transaction changes.

## Gate 1.38 — lock release ownership + fail-closed recover identity (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-lock-ownership.mjs
```

Pins T-052 (register R4): the two fail-open seams in the mutual-exclusion
and recovery machinery, both now refusing when verification cannot run —
the engine's refusal vocabulary applied to its own post-crash machinery.

**Lock release verifies ownership (`src/lock.ts`).** Programmatic
`releaseCheckoutLock` (the `finally` release of every lock consumer:
run/clean/recover/integrate/gc) now reads the lock file and unlinks only
when its recorded `pid` is `process.pid`. A mismatch means a `--force-lock`
taker replaced our lock and our stale release must not delete the new
holder's — the takeover sequence (A holds, B force-takes, A finishes) broke
mutual exclusion in exactly the scenario `--force-lock` exists for (A was
suspected stale but wasn't). An unreadable or unparseable file is never
unlinked either (never delete what you cannot identify); both skips are
loud on stderr (`lock at <path> is held by pid <n> — force-taken; not
releasing` / the unreadable variant, which names the CLI override). A
missing file stays the pre-T-052 ENOENT-is-ok, and the acquisition side is
untouched (`--force-lock` semantics are a non-goal). The CLI `release` verb
is now `forceReleaseCheckoutLock` — the explicit human override,
`--force-lock`'s counterpart for release, dropping ANY holder (documented
in its usage text). The check pins: L1 a normal acquire/release pair still
releases silently (every existing Gate 1.5 lock face rides green
unchanged); L2 the takeover sequence ends with B's lock INTACT
byte-identical and the loud skip line naming path + foreign pid; L3 a
garbage lock file is never unlinked by programmatic release (loud skip);
L4 the CLI release drops a foreign-pid holder and an unreadable lock (the
override); L5 a force-taker's own release pairs with its acquire silently
(the `clean --force-lock` shape). Zero git, zero tokens — the lock path
derives from the repo path string, so no repo needs to exist.

**Recover's identity check fails closed (`src/recover.ts`).**
`identityMatches` returns ok ONLY on a verified match inside the dispatch
evidence window. The three pre-T-052 fail-open classes — creation time
unavailable (PowerShell missing/blocked/AV-interfered, a protected process,
a non-Windows host), dispatch stamp unreadable, creation time unparseable —
now REFUSE the kill: a distinct `identity-unavailable` cleanup-failure
class whose message is the ticket's mandated loud record
(`identity could not be established (<reason>) — NOT killing pid <n>; kill
it manually if it is a leftover`), landing in stdout and `recovery.json`,
exit non-zero. The rationale: on a machine where PowerShell cannot run,
EVERY kill used to degrade to alive-check-only, and Windows pid reuse
means a stale dispatch pid can name an unrelated live process that recover
would tree-kill — unrecoverable — while a skipped leftover is a human's
one-line fix. Mismatched-but-verifiable stays the existing
`identity-mismatch` refusal. The creation-time probe is injectable
(`CreationTimeProbe`, defaulting to the real PowerShell spawn) so the
unavailable path is deterministic to test; the kill decision is extracted
as `reconcileKills` (same signature position in `main`, behavior
unchanged) and `recover.ts` gained the `src/lock.ts` run-directly entry
guard so checks can import the seam without executing a reconciliation.
The check pins, against REAL live children on the real process table: R1
probe-null → no kill attempted, the loud record present in the failure and
stdout, child untouched; R2/R3 the stamp-unreadable and time-unparseable
sub-classes refuse the same way; R4 identity available and matching → the
kill proceeds exactly as today (real `taskkill /T /F` tree kill, child
dead, kill recorded with the window note); R5 identity available and
MISMATCHED → refused (existing behavior, now pinned); R6 end-to-end
through the real `recover` command with PowerShell unresolvable (every
`WindowsPowerShell` PATH segment stripped — the ticket's "PowerShell
missing" cause, forced deterministically; BOTH preconditions asserted so a
machine where unavailability cannot be forced fails the leg loudly rather
than running it vacuously) → exit 1, the loud record in stdout AND
`recovery.json` (reason `identity-unavailable`, zero kills), the orphan
STILL ALIVE, the checkout lock still released. R1-R5 run in a generated
driver subprocess so the check also ran cleanly against pre-T-052 code —
that property is what made the red bar a single check invocation.

**The accepted degradation, stated here and not discovered in an
incident:** machines where PowerShell cannot run (missing, blocked, or
AV-interfered) degrade to REPORT-ONLY recovery — every recorded pid
becomes an `identity-unavailable` cleanup failure naming the manual fix;
nothing is killed. Non-Windows hosts were already in this class
(`processCreatedAt` returns null off-win32) and pre-T-052 were fail-open
by the same code path. The identity legs riding green unchanged in Gate
1.11 (real kills, real mismatches through the real command) prove the
available-identity behavior is untouched.

**Red bar** (AGENTS #8), recorded on main's engine at the lane before the
change (final check version): `scripts/check-lock-ownership.mjs` exit 1,
9 failures, teed to `C:\swarm\verify-red\T-052-redbar.log` — (a) the
takeover sequence DELETED B's lock (A's release, then the garbage-lock
unlink, no loud lines); (b) with PowerShell unresolvable (both
preconditions green), the real `recover` command did NOT refuse: it
tree-killed the orphan it could not verify (exit not 1, orphan dead,
recovery.json carrying the kill, not the refusal). The injected-probe
seam itself could not exist on main (the driver died on the missing
export — recorded as the R1-R5 wrapper failure); the injection seam is
introduced BY this change-set, and its unavailable-path red is the R6
end-to-end leg above. Post-change the check is ALL GREEN (30 ok lines,
~3s).
Gate 2 trigger analysis (the T-041 precedent): NOT triggered — the
change-set touches `src/lock.ts` and `src/recover.ts` only (the lock +
recover seam); nothing on the trigger list (src/runner.ts, adapters,
gates, workspace handling, report shape) changed; a real run takes and
releases its own lock on every path exactly as before (L1/L5 pin the
pairing). Gate 3 n/a (no adapter; no harness spawn changed). Required
whenever the lock release semantics or recover's identity verification
changes.

## Gate 1.39 — log-write loss made loud: first-failure-per-path cleanup evidence (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-log-write-loss.mjs
```

Pins T-053 (register R12): every log write in the worker-run path used to
swallow its failures silently — `drain`/`appendLine`
(src/worker/run-with-timeout.ts) and both adapters' pre-run `appendLog`
(src/worker/opencode.ts, src/worker/machine.ts) — so a full disk, a locked
file, or an unwritable path yielded a silently-empty `worker.log` that a
human later read as "the worker produced nothing": indistinguishable from
the no-op derailment class and worse than useless as forensics (Known issue
#6's diagnosis method depends on worker.log). The change surfaces the loss
through the vocabulary that already exists (T-011's `cleanupFailures` →
the runner's aggregation → `CandidateReport.cleanupFailures`, so
dashboard/report/store surfaces come free):

- **First-failure-per-path recording** — one `LogWriteLoss` recorder per
  attempt, created by the adapter and shared with the core through
  `RunChildTimeoutOptions.logWriteLoss` (the core creates its own when
  driven directly). The FIRST failed append to a path pushes exactly one
  line — `LOG WRITE FAILED after <N> bytes at <path>: <err> — log evidence
  incomplete from this point` (N = the bytes that had actually landed,
  counted across every successful write, so a mid-run loss records the true
  evidence offset, not always zero); every subsequent failure for the same
  path adds nothing (no spam from a chatty child on a broken path).
- **The run never breaks** — the swallow stays (the posture is unchanged:
  this records, it does not throw); a candidate whose log could not be
  written still completes and is still verdicted by its gates alone. The
  healthy path is byte-identical: no line, no `cleanupFailures` key, the
  same log bytes (pinned below; Gates 1.12/1.17's own faces also ride green
  unchanged in the same tier).

The deterministic broken-log fixtures (both verified on this host):
`appendFileSync` onto a directory throws `EISDIR` (the always-broken path),
and the Windows read-only attribute (`chmodSync(path, 0o444)`) blocks
appends with `EPERM` (the mid-run loss — chunk 1 lands, the attribute goes
on, chunk 2 fails; deleting the file is NOT a fixture, `appendFileSync`
recreates a missing file and never throws ENOENT — discovered while writing
the check and recorded here so nobody re-derives it).

Token-free, no git, no opencode binary, no model IDs (the OpenCodeWorker is
driven with the node exe as a stub harness — `node run -m <model>` exits 1
immediately, exercising exactly the adapter's log seam):

- **A1 — the red-bar seam**: `runChildWithTimeout` (the Gate 1.12 S4 seam)
  with `logPath` = a directory: completes, exit 0, and `cleanupFailures`
  carries EXACTLY ONE line in the exact format naming the exact path, the
  landed byte count (0), and the error (EISDIR). On main this is the
  recorded silence: the drive completes with `[]` — zero trace of the loss.
- **A2 — no-spam**: a child writing 40 spaced chunks after the first
  failure still adds exactly ONE line.
- **A3 — healthy byte-identity**: with a writable log the bytes are exactly
  the child's stdout + the `$ exit code: 0` line, and `cleanupFailures` is
  the empty array (the pre-T-053 shape).
- **B1 — honest byte count**: chunk 1 lands through the core's drain (28
  bytes on disk), the log goes read-only between the stub's two writes (a
  polling handshake — deterministic, no sleep races), chunk 2 fails EPERM:
  exactly one line with N = 28 and the EPERM error (also pins the dedup
  across drain's failing write and the exit-line write).
- **C1/C2 — both adapters' pre-run line** (the Gate 1.17 stub precedent):
  MachineWorker and OpenCodeWorker with a directory as `logPath` each
  surface EXACTLY ONE line through `WorkerResult.cleanupFailures` — the
  pre-run argv/header write is the first failure for the path, and the
  core's later failures for the same path add nothing (one recorder spans
  adapter + core within the attempt). Verdict bits are pinned in BOTH
  directions exactly as today: C1 `ok: true` (exit 0), C2 `ok: false` /
  `exitCode: 1` — the loss changes no verdict bit either way.
- **C3 — producer-only field**: a healthy MachineWorker result carries NO
  `cleanupFailures` key at all, and the log bytes are exactly the pre-run
  header + child stdout + exit line.
- **D1-D3 — verdict inertness** (source pins, the Gate 1.12 S2 / 1.17 S4
  precedent): the ladder computes `passedAllGates` from
  `gates.every(passed)` + `diffBytes` alone; the runner's aggregation site
  pushes `result.cleanupFailures` into the evidence array only; and BOTH
  adapters route their pre-run write failures into the shared recorder.

One existing pin was extended in the same change-set, not weakened
(the Gate 1.36 key-set-extension precedent): Gate 1.17 S4's source pin of
the adapter's core call now asserts the literal
`runChildWithTimeout(child, { timeoutMs: req.timeoutMs, logPath:
req.logPath, logWriteLoss })` — the routing and the cleanupFailures spread
stay asserted verbatim; the literal tracks the call site.

**Red bar (AGENTS.md #8), recorded on main's engine at the lane with the
final check version** (tracked changes stashed, the check itself untracked
and so present): `scripts/check-log-write-loss.mjs` exit 1, 11 failures of
25, teed to `C:\swarm\verify-red\T-053-redbar.log` — the A1/A2/B1/C1/C2
drives all completed with ZERO recorded trace of the loss (`[]` /
undefined; B1's run even exit 0 with the log silently read-only), and the
D3 wiring pin was red (no recorder existed). The healthy-path legs (A3/C3)
and the verdict-inertness source pins (D1/D2) were green on main — exactly
the silence this ticket removes. Post-change the check is ALL GREEN
(35 assertions, ~4s). Gate 2 trigger analysis: **TRIGGERED and owed** —
the change-set touches `src/worker/run-with-timeout.ts` (the worker core
under both adapters' timed runs) and both adapter files, all on the
trigger list (Gate 2's section); the standard real e2e run's worker legs
ride the recorder inertly (no healthy leg ever fails a log write — A3/C3
pin that shape), so the run's shape is unchanged; a real-run
`LOG WRITE FAILED` is not asserted (it needs a genuinely broken log path
mid-run) — the no-regression half is what Gate 2 pins, carried by the full
tier. Gate 3 n/a per the ticket: the adapters' harness-directory-resolution
surfaces (bin path, argv shape, PWD/OLDPWD pinning, stdin transport) are
untouched — only the `appendLog` catch changed, and the diag-pwd probe's
answer is unaffected. Carved by the ticket: probe bundle/log writes (their
failures are already console-logged at the call site, separate slice) and
gate output capture (CommandGate buffers in memory; its `exec` callback
cannot lose bytes to a file). Required whenever the log-write-loss
recording or its channel changes.

## Gate 1.40 — verified-dead upgrade: a transient snapshot failure no longer reports a proven-dead tree as a cleanup failure (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-kill-verify-upgrade.mjs
```

Pins T-054 — Known issue #10's owed code change (the captured fifth
observation's fix): `src/kill-tree.ts`'s snapshot-failure leg no longer
condemns a possibly-good outcome to `verified: false` by itself. The
diagnosed shape (the fifth observation: root live at kill time, the CIM
snapshot's transient hiccup, the tree verifiably dead on the real process
table, the log carrying `CLEANUP FAIL: pid N tree kill could not be
verified (descendant verification unavailable)`) now gets two bounded
second chances, and the kill is never skipped by either: ONE immediate
pre-kill snapshot retry — when it lands, the full original verification
(pre-kill pid list, post-kill sweep) runs unchanged; otherwise the kill
fires and ONE post-kill liveness re-check gets the last word — everything
the re-check can still link to the root proven dead UPGRADES the outcome to
verified (with `reaped` honestly counting the re-check's own enumeration:
the pre-kill tree's size is unknowable when its snapshot failed, and a
descendant no longer linked to the root could evade the sweep — a bounded,
named weakness, still strictly stronger than the unconditional
`verified: false` it replaced); anything alive keeps its per-pid loud line;
a re-check that also cannot run keeps the exact pre-T-054 loud
unverifiable shape (fail-closed — the T-011 posture). Untouched invariants,
each pinned: genuine survivors keep their per-pid lines (the normal path
AND the re-check path); the dead-root leg keeps its named line byte-for-byte
(Known issue #8 — a dead root never relies on taskkill reaping reparented
descendants, and nothing about it is upgraded); `snapshotTree`'s
throw-and-proceed never skips a kill. The verification lenses
(`snapshotTree`, `isAlive`) are injectable per the T-052 identity-probe
precedent (`KillTreeDeps`, defaulting to the real machinery; every call
site unchanged).

The check plants real node process trees and asserts on the real process
table; the transient shapes are driven through the injected stubs, and the
genuinely-unverifiable shape is driven FOR REAL — every WindowsPowerShell
PATH segment stripped (both preconditions asserted, the T-052 check's R6
mechanic), so a machine where the unavailability cannot be forced fails the
leg loudly instead of running it vacuously:

- **A** — the diagnosed leg (snapshot fails once, transient): verified-dead
  with the full pre-kill tree counted in `reaped`, NO failure line, the
  success line carrying the count, exactly one bounded retry. Red bar
  (recorded in the ticket): on main's engine the injected stubs are inert
  (the seam is introduced by this change-set — the T-052 red-bar pattern)
  and this leg's call-count pin failed.
- **B** — the reporting surface, pure: a verified-dead outcome emits NO
  failure line and the success line carries the reaped count; survivor,
  unverifiable, and dead-root shapes keep their named lines verbatim.
- **C** — genuine survivors keep their per-pid lines through the NORMAL
  path (a forced-alive liveness stub on a really-killed tree).
- **D** — genuinely unverifiable (stub fails on every attempt): the loud
  line verbatim, bounded attempts (two pre-kill + one re-check), the kill
  never skipped — the tree really dead on the real table.
- **E** — the post-kill re-check leg (stub fails twice pre-kill, the real
  snapshot answers the re-check): upgraded to verified-when-proven-dead,
  NO failure line. Red bar (recorded in the ticket): same seam-absence
  failure on main.
- **F** — the re-check stays loud in the loud direction: a live process it
  finds (forced-alive root — a kill that did not take) keeps its per-pid
  line.
- **R** — the REAL-failure leg, no stubs: powershell.exe unresolvable, a
  real planted tree killed through the real code, outcome exactly the loud
  unverifiable shape, kill never skipped. On main's engine this leg
  REPRODUCED the fifth observation's signature end to end (the recorded
  red bar): `CLEANUP FAIL: pid N tree kill could not be verified
  (descendant verification unavailable)` printed next to the same leg's
  real-process-table proof that the tree was dead.

The check sweeps everything it planted best-effort at the end (AGENTS.md #10
mechanized for its own spawns) and its throwaway sandbox under `C:\swarm\`
is removed afterward. Required whenever `src/kill-tree.ts`'s verification
or reporting changes.

## Gate 1.41 — verify-root retention: the full tier archives prior Gate 2 run evidence instead of wiping it (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-verify-retention.mjs
```

Pins T-055. Pre-T-055, `scripts/verify.mjs` opened Gate 2 with
`rmSync(verifyRoot, { recursive: true, force: true })` (then-main,
scripts/verify.mjs:1077): every full-tier invocation permanently destroyed
every prior Gate 2 run dir under `C:\swarm\verify`, silently voiding the
repo's cite-the-artifacts convention behind its back. The recorded
incident: run **20261024021432** — cited by name in Known issue #6's
2026-10-24 observation — was wiped from disk by a later `verify:full`
before T-049 could read its worker.logs, and the auto-reject marker
literal had to be recovered from VERIFICATION.md's own text and
cross-checked against an unrelated older run (T-049's Landed records it).
That incident motivated this change.

The retention rule lives in the exported helper the tier's reset now
drives, `scripts/verify-retention.mjs` (plain ESM — `verify.mjs` runs
under plain node): before a Gate 2 run starts, every existing `^\d{14}$`
run DIRECTORY under the live root moves to
**`C:\swarm\verify-archive\<runId>\`** (a plain same-drive rename — bytes
never rewritten); the archive then keeps only the most recent
**`ARCHIVE_KEEP_RUNS` = 10** (the documented, exported constant) archived
runs and deletes older ones — bounded disk, evidence with a grace period
instead of none. Everything non-timestamped is never moved or deleted by
the helper: a timestamped FILE is a stray, not a run dir, and `locks/`
(T-004's checkout-lock home, `<run-root>\locks\<hash>.lock`, src/lock.ts:42)
now survives the reset where the old wipe destroyed it. The helper fails
loud (throws) rather than letting the tier proceed after a failed move —
continuing would destroy exactly the evidence it exists to retain. The
exactly-one-run-dir assertion follows the layout: it states **exactly one
run dir in the LIVE root** — archives live elsewhere — same predicate,
same exactness over actual run dirs (the T-044 strengthen-or-equal
precedent; the reasoning is recorded in the assertion's comment and the
ticket), and one edge got safer: a timestamped file no longer counts as a
run dir, matching the move rule. The assertion uses the helper's exported
`listRunDirs` — the exact code this gate pins.

The check is token-free and drives fixture run dirs only (sandbox
`C:\swarm\verify-retention`, removed afterward):

- **R** — the recorded red bar, reproduced (AGENTS.md #8): the pre-T-055
  reset (`rmSync(live, { recursive: true, force: true })`) against a
  fixture live root holding two run dirs wipes both with NOTHING
  archived — asserted as the destruction the green faces replace. This
  face runs identically pre/post change.
- **G** — retention through the helper: both fixture run dirs land under
  the archive root with their marker bytes byte-identical, the live root
  holds zero run dirs, the most recent ARCHIVE_KEEP_RUNS are kept while
  older archives are deleted (the default bound pinned exactly — eleven
  dirs in, exactly the single oldest out; the `keep` parameter pinned at
  2); the returned `{ moved, deleted }` lists are honest.
- **L** — the updated full-tier assertion's predicate (`listRunDirs`
  length, the exact code the Gate 2 assertion runs): passes with an
  archived-history root (one live run dir, twelve archived), and stays
  exact (0 → not one, 2 → not one).
- **S** — non-timestamped safety: `locks/`, `verify-red/`, a stray file,
  and a timestamped FILE are never moved or deleted by the helper (the
  file stays in the live root, never reaches the archive); the
  archive-side prune never touches a non-timestamped entry planted in the
  archive root; a nonexistent live root is a no-throw no-op.
- **H** — the check never touches the real `C:\swarm\verify` (its run-dir
  snapshot is identical before and after).

Red bar, recorded first (the lane at pre-helper main; log
`C:\swarm\verify-red\T-055-redbar.log`): 8 failures of 12 faces, exit 1 —
R green (the old behavior's destruction asserted as reproduced), every
helper-driven face G/L/S failing on the absent `scripts/verify-retention.mjs`
(the T-052 seam-absence pattern). Post-change: ALL GREEN, 29 assertions.

Required whenever `scripts/verify.mjs`'s full-tier reset, the archive
root, or `scripts/verify-retention.mjs` changes.

## Gate 1.42 — brief-count honesty: an under/over-count planner reply is a parse failure, not silent padding (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-brief-count.mjs
```

Pins T-056. `parseBriefs`'s scans (`src/parse.ts`) used to pad a SHORT
planner array by cyclic repetition and truncate a LONG one: a 1-brief reply
for N candidates dispatched the same brief N times at full token cost,
laundered as N "distinct" briefs with `planner.ok: true` and no trace in the
report — corrupting exactly the metric the yield block (Gate 1.36) counts
survivors by (the adversarial review 2026-10-23's R9: "N candidates
frequently buy ~1 independent sample"). The pad/truncate tail is deleted;
every scan now returns its parsed array ONLY when the valid-brief count is
EXACTLY the requested count (the all-or-nothing rule's exact-count clause —
a mismatched slice is skipped like any invalid slice). The consequence path
is the existing one: null → one bounded repair attempt → still null → the
raw-goal fallback with `fallbackUsed: true` and the loud console line — same
tokens, honest provenance. This is a deliberate, documented narrowing of
parse.ts's byte-identity inertness contract FOR THE COUNT-MISMATCH CASE ONLY
(stated plainly in Gate 0.5 above): exactly-count replies — the
overwhelming case — are untouched byte-for-byte. Non-goals kept: no
accepting k<count briefs as k candidates (the candidate contract), no
model-composed top-up (mechanical composition only), `--jobs` briefs never
parsed by parseBriefs.

The check is token-free, two legs (sandbox `C:\swarm\verify-brief-count`,
removed afterward):

- **A** — parser contract: the ticket's red-bar shapes parse null
  (`["a"]`@2, `["a","b","c"]`@2); a short array in prose never manufactures
  the missing briefs; the exact-count clause holds through the objects scan
  and through the separator-repair path (the recorded duplicated-quote
  shape — 2 briefs after repair — parses null for count 3, and still parses
  both briefs for count 2); exactly-N arrays return main's exact output,
  trim parity and the mixed-array filtered-count case included; and the
  Gate 0.5 recorded fixture `planner-r2-objects-raw.txt` parses to exactly
  its count — the model's own two briefs, asserted, not weakened.
- **B** — fallback e2e (the Gate 1.22 leg-B fake-adapter pattern):
  `runSkeleton` driven end-to-end with a stub planner whose reply is SHORT
  for 2 candidates — `planner.ok: false`, `fallbackUsed: true`, both
  attempts spent, the console line `planner: no valid output, using raw
  goal in Ns (2 attempts)`, every candidate riding the RAW GOAL (no worker
  prompt ever carries the padded brief), `planner-raw.txt` keeping the
  short reply's bytes verbatim, and the run still completing with
  gate-decided verdicts. Control face: an exactly-N reply dispatches its
  parsed briefs in order on one attempt with the plain success console
  line — the preserved case end to end.

Red bar, recorded FIRST against main (AGENTS.md #8; a read-only probe
importing main's `src/parse.ts` before this change-set existed):
`parseBriefs('["a"]', 2)` → `["a","a"]` (the pad asserted),
`parseBriefs('["a","b","c"]', 2)` → `["a","b"]` (the truncate asserted).
Intermediate red, post-parser-change: Gate 0.5's three padded pins red
(short cycles / long truncates / objects cycle-truncate), every exactly-N
and recorded-fixture pin green — exactly the intended blast radius. The
padded pins were REPLACED with the exact-count expectation, strengthened
not weakened (the T-044 precedent; reasoning recorded at the pins and in
Gate 0.5). Post-change: Gate 0.5 ALL GREEN, this gate ALL GREEN.

Required whenever `src/parse.ts`'s scans or the planner repair/fallback
path (`src/runner.ts`'s `runPlannerPhase`) changes.

## Gate 1.43 — duplicate gate names refused at parse time: the store's last-write-wins can no longer drop gate evidence (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-duplicate-gates.mjs
```

Pins T-057 (the adversarial review 2026-10-23's R7a). `gate_results` is
keyed `(run_id, candidate_id, gate_name)` with a last-write-wins upsert
(`src/store/index.ts`), and nothing refused duplicate gate names:
`parseJobsSpec` enforced unique probe ids but never gate names
(`src/scheduler.ts` — no `seen` set for gates), and the run-level `--gate`
flag accepted repeats unchecked (`src/cli.ts`). A spec or CLI invocation
with two gates named `build` recorded BOTH verdicts in report.json but only
the LAST one in the durable store — if the first failed and the second
passed, the store showed an all-pass gate table for an eliminated
candidate: evidence loss invisible to every later reader. The ladder itself
was never affected (it reads the in-memory array), which is exactly why the
report/store divergence went unnoticed. Both parse sites now refuse — the
same parser-refusal pattern the repo already uses for probe ids, job ids,
and flag pairing, zero side effects (before repo validation, the checkout
lock, or any artifacts dir):

- `parseJobsSpec`: per-job gate names are unique — the probe-id `seen` set
  verbatim, the refusal naming the job and the duplicated name.
- `parseArgs`: a repeated `--gate` name refuses at parse time naming the
  duplicate. Integrate's `gateContract` is untouched — it matches gates by
  name, so refusal upstream at the run CLI is the honest fix (integrate
  never consumed the run CLI's argv).

The store's upsert contract is unchanged; the engine can no longer PRODUCE
a same-named gate pair.

The check is token-free, three legs (sandbox `C:\swarm\verify-duplicate-gates`,
removed afterward): **A** — parser contract: the duplicate-`build` spec
refuses naming `job 'j1'` and `'build'`; uniqueness is PER JOB (two jobs may
each carry a `build` — the store keys rows per candidate too); unique-named
gates parse byte-identically to main's output (order and values verbatim);
distinct names sharing one command parse unchanged; the duplicate-probe-id
refusal is unmodified. **B** — CLI faces: repeated `--gate` names and the
duplicate-gate `--jobs` spec both refuse with exit 1 through the real CLI,
naming the offense, BEFORE repo validation (the `--repo` is deliberately
absent, so a parse-passing invocation would surface the repo error — the
red-bar contrast), with zero side effects (no artifacts dir, no lock under
the sandbox run root); control faces pin the preserved path — distinct
names (and a unique-named spec) parse past to the repo error. **C** — the
loss mechanism for the record: ingest of a build(fail)+build(pass) pair
upserts to ONE `gate_results` row carrying the LAST verdict.

Red bar, recorded FIRST against main (AGENTS.md #8; a read-only probe
importing main's `src/scheduler.ts` + `src/store/index.ts` and driving
main's CLI as a subprocess, before this change-set existed): the
duplicate-`build` spec PARSED (both gates returned); repeated
`--gate "a=…" --gate "a=…"` PARSED — the CLI failed later at repo
validation, not at parse; ingest of build(fail)+build(pass) left ONE row
`{"gate_name":"build","passed":1,"exit_code":0,"output_tail":"second
passed"}` — the first-failure evidence gone. Intentional shape (same
probe): no JSON fixture in the repo carries a gates array with duplicate
names, and no `--gate` literal in scripts/src/docs repeats a name (the
T-057 ticket file itself, which quotes the red-bar example, excluded,
stated there) — the full fast tier riding green doubles as the executed
half of that assertion (every check script's inline specs still parse).

Required whenever `src/scheduler.ts`'s gate parsing or `src/cli.ts`'s
`--gate` parsing changes.

## Gate 1.44 — bounded output accumulation: a chatty child can no longer OOM the orchestrator (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-bounded-output.mjs
```

Pins T-058 (the adversarial review 2026-10-23's R11, disposition
`ticket-later`). The response-tail collectors in BOTH adapters
(`collectText`, `src/worker/opencode.ts` + `src/worker/machine.ts`)
accumulated the child's ENTIRE stdout and stderr into one string each and
sliced the 12,000-char tail only AFTER full collection (`RESPONSE_TAIL_CHARS`)
— a chatty candidate-controlled child (a runaway loop, a build streaming
gigabytes) grew the orchestrator's heap without bound, and the OOM killed the
RUN — every lane's work, the lock held — not just the one candidate. The
probe core had the same failure class at smaller scale: per-case collection
was capped (16 MiB, unchanged) but the benchmark/adversarial/web probes
concatenated every case's capped output into one string and one
`writeFileSync` — up to ~320 MiB aggregated for the adversarial probe's ~20
cases. The change: each collector keeps only its final
`MAX_TAIL_BUFFER_CHARS` (64,000, exported from both adapters — comfortably
above `RESPONSE_TAIL_CHARS` = 12,000, which is the tail-window guarantee's
precondition), dropping from the FRONT; the full stream still reaches the log
file through `runChildWithTimeout`'s disk-side drain (unchanged — disk, not
heap), so no evidence is lost. The probe core bounds the aggregate twice:
`BoundedProbeLog` drops front parts past `MAX_PROBE_LOG_BYTES` (32 MiB,
exported from `src/probe.ts`) while accumulating, and `writeProbeLog`'s
write byte-caps the FILE the same way (tail-kept, on a UTF-8 lead byte). The
truncation is memory hygiene, never a verdict input: capping is
silent-by-design for the run (no new cleanupFailures noise on a capped
adapter drive), and LOUD in the bundle — one
`PROBE LOG TRUNCATED: kept the final <kept> of <total> bytes` line on the
FINAL GateResult's existing `cleanupFailures` (the T-053 log-write-loss
channel; no new bundle fields, schema-valid, `success` untouched).

The check is token-free, six legs (sandbox `C:\swarm\verify-bounded-output`,
removed afterward): **C** — the constants are exported at their documented
values from BOTH adapters and the probe core, ≥ the surfaced tail and the
per-case cap respectively, and no CLI knob exposes them (src/cli.ts never
names them — the `MAX_RETRY_FINDINGS` pattern). **S** — source pins: the
per-chunk front-trim in both adapters' `collectText`, `RESPONSE_TAIL_CHARS`
unchanged at 12,000, the probe core's front-dropping accumulator and the
UTF-8-safe write-time byte cap. **D1/D2** — tail byte-identity pinned
verbatim through the REAL adapter paths (the Gate 1.17 direct-drive and Gate
1.28 stub-binPath precedents): an under-cap drive's `responseTail` is the
whole out+err concat byte for byte; an over-cap drive (70,150 chars on
stdout, past the 64,000-char window, 122 chars on stderr) still surfaces the
stream's TRUE final 12,000 chars — the tail reaching from the tiny stderr
back into the front-trimmed stdout, which is exactly the window arithmetic
the cap must preserve. **D3/D4** — the recorded red bar's drive, green: a
stub child emitting ~660 MB across both streams (3.2M + 2.2M deterministic
122-char lines), driven through the REAL `MachineWorker`/`OpenCodeWorker`
`execute()` inside a node process constrained with `--max-old-space-size=64`,
completes under the constraint with `responseTail` byte-identical to the
true final 12,000 chars, zero `cleanupFailures`, and the log FILE still
carrying the whole ~660 MB (size + first-out / out-err-boundary / last-err
line checks — the file ends are read in windows, never whole). **P1** — the
adversarial probe driven in-process (the Gate 1.15 way) against a fixture
target emitting 17 MiB on EVERY case (more than the 16 MiB per-case cap,
delivered as a script file — the corpus feeds flag-like argv such as `-0`,
which a script path safely demotes to the script's own argv): it completes
with `success: true` (memory hygiene never flips a verdict — since T-062
through the rejection path: the target VALIDATES the corpus's
invalid-by-construction inputs, so its non-zero exits record
rejected-as-expected and the assertion also pins the cases-rejected count;
the pre-T-062 fixture ignored argv and exited 0 everywhere, which T-062's
authored expectations correctly stopped rewarding), the bundle is
schema-valid, the aggregate log artifact is ≤ `MAX_PROBE_LOG_BYTES`, the
truncation line rides the FINAL case entry only (kept within the cap, total
above it), and the per-case results artifact still rides the bundle. **P2** —
a healthy small command probe's log artifact is byte-identical to the
executed output (21 bytes) with no truncation line and no `cleanupFailures`.

Red bar, recorded FIRST against the unmodified sources (AGENTS.md #8), the
constrained machine drive: the ~660 MB two-stream drive through the real
`collectText` under `--max-old-space-size=64` THREW at the unbounded join —

```
RangeError: Invalid string length
    at <anonymous> (src\worker\machine.ts:91:22)   <- responseText = out + err
```

exit 1. Honest sizing note, measured on this machine's Node v22.23.1 (win32):
at the ticket's illustrative ~50 MB the same constrained drive on main
COMPLETED (exit 0, full 52 MB log, correct tail), because V8 clamps
`--max-old-space-size=64` up to a 112 MiB old-space floor
(`heap_size_limit` = 117,440,512 measured) and this V8 does not enforce that
limit against retained strings (480 MB of retained strings survived it;
retained objects DO trip it — exit 134, the classic heap OOM). The drive was
therefore scaled until main's red face reproduced through the criterion's
other arm: the accumulated `out + err` crossing V8's max string length
throws `RangeError: Invalid string length` — the same unbounded-accumulation
death, same instrument, same constraint flag, ~3x the illustrative size. The
post-change drive completes under the identical constraint.

Required whenever an adapter's response-tail collection (`collectText`,
`RESPONSE_TAIL_CHARS`, `MAX_TAIL_BUFFER_CHARS`) or the probe core's log
accumulation/write path (`BoundedProbeLog`, `writeProbeLog`/`logArtifact`,
`MAX_PROBE_LOG_BYTES`) changes.

## Gate 1.45 — planner repo digest: deterministic tree/manifest context in the planner prompt (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-planner-digest.mjs
```

Pins T-059 (the adversarial review 2026-10-23's R14, disposition
`ticket-later`): the planner is repo-blind — `plannerPrompt`
(`src/runner.ts`) carried goal + count only, and the planner's cwd is a
scratch dir under the run artifacts dir, so briefs could not reference real
modules or conventions (every hedged-path annotation the T-050 premise guard
fires on, and the 2026-10-23 premise-lie class itself, trace to the specifier
not seeing the code). The change — R14's own "minimal version" disposition:
a DETERMINISTIC digest of the TARGET repo at the run's baseSha
(`src/planner-digest.ts`, list-form git only: `git ls-tree -r --name-only
<baseSha>` for the tracked tree — forward-slash by git's own emission — plus
one manifest identity line per recognized root manifest, package.json's
name/version from the COMMIT's bytes, presence and identity, never full
contents) rides the planner prompt through the EXISTING `contextBlock` seam:
round 1's context block is the digest alone; round 2's is digest + the
composed survivor block with a fixed `\n\n` join. Bytes, never access: the
digest names no repo path (Gate 1.20 S1's planner-prompt posture holds), and
the planner's scratch cwd, capability posture (`--agent plan`, T-023), and
parse path are untouched. Caps are documented exported constants —
`MAX_DIGEST_PATHS` (500) and `MAX_DIGEST_CHARS` (12,000) — and truncation is
LOUD (the context system's budgets-spent-are-budgets-stated rule): the tree
section's header states listed-of-total and one `TRUNCATED` line names the
binding cap's constant and the not-shown count; the char cap re-cuts below
the path cap's cut until the composed text fits. Evidence: the digest bytes
land in `planner-digest.txt` under the run artifacts dir with their sha256
in `report.json` (`RunReport.plannerDigest`, producer-only) — one
composition, two consumers (prompt bytes and recorded hash cannot drift).
`--no-planner-context` opts out (default ON); a composition failure
degrades loudly to today's digest-less prompts, no file, no report field
(the premise-guard posture). **Seam note, deliberate and precedented:** the
`runSkeleton` option (`plannerContext?: boolean`) treats absent/false as
today's exact prompt bytes — the `rounds`/`gateRetry` seam pattern — so every
existing direct-drive prompt/key-set face (Gates 1.20/1.21/1.22/1.25's
pinned bytes) is unchanged by construction; the CLI resolves the run-level
default TRUE and always passes it, so every real CLI run carries the digest
(pinned: C1's source pins + the Gate 2 assertions below).

The check is token-free (fake adapters + the real runner, the Gate 1.35
pattern), ten legs: **M** — the module loads; both caps exported ≥ 1;
`RECOGNIZED_MANIFESTS` a non-empty string array. **D1** — byte-determinism:
two compositions byte-identical (text + sha256), and unchanged across
working-tree mutations AND later commits (the digest reads the COMMIT,
never the tree). **D2** — content/provenance: the header carries the
contract and `BASE COMMIT:` with baseSha verbatim; the package.json identity
line is an exact pinned literal from the commit's bytes; every tracked path
lists forward-slash in ls-tree order and exists at base (`cat-file -e`);
under the caps there is NO truncation line; NO repo path anywhere. **D3** —
path cap: a repo 61 paths over the constant lists exactly the cap, the
section header states listed-of-total, the `TRUNCATED` line names the cut
count and the path-cap constant, total chars within the char cap. **D4** —
char cap: a 401-path repo of ~91-char names (≈34K chars of paths) is re-cut
BELOW the path cap until the text fits, the `TRUNCATED` line names the
char-cap constant, and the capped digest is still byte-deterministic.
**D5** — loud failure: composing against a non-git dir throws (never a
silent empty tree); source pin that the runner wraps composition in
try/catch with a loud degradation log. **E1** — evidence + verbatim
embedding (digest ON): `planner-digest.txt` under the artifacts dir;
`report.plannerDigest` records exactly that path and the sha256 of the
on-disk bytes, equal to the module-recomposed digest; the round-1 planner
prompt carries the FILE's bytes verbatim between the GOAL line and the
output contract; the digest names the real tree (calc.js at root — the R14
premise fix). **E2** — opt-out inertness (the T-056 pattern): with the
digest OFF and with the option ABSENT, the captured prompt is byte-identical
to main's hard-coded no-block template (a template drift in `src/runner.ts`
fails the check), no digest file, no report key, today's exact top-level
key set. **E3** — both rounds: digest ON at `rounds: 2` — round 1 carries
the digest alone; round 2 carries digest + recomputed composed block with
the EXACT join; a digest-less rounds drive is byte-identical to main's
round-1 and round-2 forms. **C1** — CLI face: `--help` documents the flag;
the flag parses (a trailing `--rounds 3` refusal fires its own message,
never `unknown option`); source pins that the CLI defaults it true and
passes it through.

Red bar, recorded FIRST on main (AGENTS.md #8), token-free:
`C:\swarm\verify-red\T-059-red.log` — the demo-fixture probe drives the real
`runSkeleton` with a fake planner against `C:\swarm\demo-target`; all three
T-059 assertions fail on main (no digest bytes in the round-1 planner
prompt, no `planner-digest.txt`, no report sha256), and the probe's
RED-RECORD legs state the red's content positively: main's planner prompt
carries no tree/manifest bytes. The same probe against the lane build goes
green (`C:\swarm\verify-red\T-059-green-probe.log`).

Gate 2 carries the real-run face since T-059 (strengthen-only, no existing
assertion touched): the report's `plannerDigest` block must exist with the
evidence file on disk and the recorded sha256 must match the file's bytes —
the CLI-default-ON path proven on real model tokens (the verbatim
prompt-embedding half is pinned token-free by E1).

Required whenever the digest producer (`src/planner-digest.ts`), its caps,
the runner's contextBlock wiring for the planner (`runPlannerPhase`/
`plannerPrompt`), or the CLI flag changes.

## Gate 1.46 — worker orientation block: engine-composed lease path + base tree facts in the worker dispatch (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-worker-orientation.mjs
```

Pins T-060 (Known issue #6's four path/repo-confusion derailment classes;
the adversarial review 2026-10-23's A2 disposition): until now the engine
told the worker nothing about where it was beyond cwd + pinned env, and
every recorded derailment class — probing the canonical fixture instead of
the lease, the premise-lie read, mis-transcribing the lease's own path
(hyphen read as separator), explore-then-give-up — hinged on exactly the
two facts the block states. The change: an engine-composed ORIENTATION
BLOCK prepended to EVERY worker dispatch (`src/worker-orientation.ts`,
composed from the attempt's lease + the run's baseSha + T-059's digest
producer) — the candidate's absolute lease path VERBATIM on its own line
under a one-line scope statement (everything outside it is out of scope,
the canonical checkout included, copy-never-retype), the baseSha the lease
is pinned to, and the capped tracked-file tree. The T-050 annotation
seam's discipline: engine mechanics, never model judgment — the
planner-authored brief bytes in report.json are BYTE-UNCHANGED (only the
engine-composed wrapper grows; `CandidateReport.brief` untouched), the
premise guard is untouched and still inert for briefs whose paths all
exist at base, no verdict expression reads the block, and every candidate
in a run gets the same block shape (the only per-candidate bytes are the
lease path; no differential treatment the report cannot explain).
Prompt-side only — retrying no-ops stays banned, a zero-byte diff still
eliminates.

THE SAME BYTES, NO SECOND COMPOSITION PATH: the tree section is composed
by T-059's own `composeTreeSection`, exported since T-060 and refactored
out of `composePlannerDigest`'s inline form — the digest's composed bytes
are byte-identical to the pre-T-060 form (Gate 1.45's pinned literals
unchanged, re-run green in this change-set), the digest object now also
carries its post-cap `treePaths` (additive), and the orientation module
spawns nothing. The block's total size is capped by the documented
exported constant `MAX_ORIENTATION_CHARS` (8,000, below the digest's own
12,000 on purpose — the worker prompt stays token-cheap); when the tree
overflows it, paths drop from the END (git order preserved) until the
block fits and the in-section `TRUNCATED` line names the binding cap and
the honest not-shown count (the digest's own cap stays the named cut when
the orientation cap does not cut below it). Determinism: composition is
pure over its inputs — byte-identical across invocations for a fixed
lease + digest. The full dispatched prompt (orientation + brief) is
recorded per attempt as `dispatched-prompt.txt` in the attempt's evidence
dir, riding `outputArtifacts`; its exact text's sha256 IS the attempt's
`promptVersion` (the T-029 producer records the composition change — it
moves vs main's bare `builderPrompt` hash for the same inputs, pinned).
Evidence-only: no report field is added, so flag-less report shapes are
unchanged. The run's digest is composed ONCE per run for BOTH consumers
(planner contextBlock + every worker block); the planner-side evidence
(`planner-digest.txt`, `RunReport.plannerDigest`) stays tied to
`--no-planner-context` exactly as T-059 pinned it (Gate 1.45 E2 re-run
green), and a composition failure logs loudly once and degrades the whole
run to today's exact prompt bytes on both sides (the premise-guard
posture — the report never claims context any role did not receive).
`inputContextHash` deliberately keeps hashing the builder template: it
answers cross-attempt comparability, and the orientation block's
per-attempt variation is the lease path exactly like the excluded
workspace line; exact dispatched text is promptVersion's job.

Pinned-byte updates in the same change-set, strength preserved (each
still exact equality, no member or assertion dropped): Gates 1.8/1.24's
exact `outputArtifacts` arrays gained the per-attempt
`dispatched-prompt.txt`; Gate 1.24/1.27's attempt-2 `promptVersion`
recomputations moved to the `workerDispatchPrompt` composition; Gate
1.35's dispatched-prompt equalities likewise; Gate 1.45's check's worker
fake matches `includes('You are implementing')` instead of `startsWith`
(the worker prompt now begins with the orientation block; planner prompts
never carry the line — discriminator strength unchanged).

The check is token-free (fake adapters + the real runner, the Gate 1.45
pattern), 31 assertions across legs **M** (module loads; cap exported;
`workerDispatchPrompt` exported), **O1** (byte-determinism),
**O2** (framing literals hard-coded in the check — the lease path rides
byte-for-byte on its own indented line exactly once, the scope line names
the canonical-checkout carve verbatim, baseSha verbatim, fixed
start/end markers), **O3** (under the caps the block embeds the digest
producer's own tree-section bytes; the module spawns nothing — source
pin), **O4** (cap honesty: re-cut below the digest's own cut until the
block fits; `TRUNCATED` names the orientation constant with the honest
not-shown count; recomposition identical), **E1** (the drive face,
plannerContext FALSE — workers orient regardless of the planner flag:
the dispatched prompt is byte-exactly orientation + `'\n\n'` + the
UNCHANGED builder template; `promptVersion` equals the dispatched text's
sha256 and DIFFERS from main's bare-builder hash; the planner-authored
brief bytes in report.json ride verbatim; the planner prompt stays
byte-identical to main's no-context template and no digest file/report
field appears; `dispatched-prompt.txt` carries the exact dispatched
bytes; the premise guard stays inert; the two candidates' blocks differ
only by the lease path), and **E2** (plannerContext TRUE keeps every
T-059 face while the worker tree rides the same digest's bytes; a
`--jobs` drive's worker prompt carries the block too — every worker
dispatch, both modes).

Red bar (AGENTS.md #8), recorded BEFORE the change by running this check
on the pre-change lane (= main): 13 named failures, exit 1, verbatim at
`C:\swarm\verify-red\T-060-red.log` — the module import fails (M), the
module-direct legs fail by name (O1–O4), and the E1 drive records the
ticket's acceptance red: the dispatched worker prompt for a stubbed run
carries NO orientation block, no `dispatched-prompt.txt` exists, and
`promptVersion` equals main's bare-builder hash. All 31 assertions green
on the lane build; the full fast tier ALL GREEN in the same change-set.

**Gate 2 owed** (the standing trigger fires — the worker dispatch prompt
changed): every existing Gate 2 assertion must stay green on the driving
run, and the run's no-op/derailment picture is recorded in T-060's
Landed section as one honest data point (the T-050 precedent: measured
opportunistically, no same-run promotion, AGENTS.md #11). Gate 3 n/a (no
adapter change).

Required whenever the orientation producer (`src/worker-orientation.ts`),
its cap, the runner's worker-dispatch composition (`runJob`/
`workerDispatchPrompt`), or the shared tree-section composer changes.

## Gate 1.47 — embedded-evidence fencing: fenced, capped, role-labeled blocks for model-bound evidence (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-evidence-fence.mjs
```

Pins T-061 (the adversarial review 2026-10-23's R5 disposition): the two
seams where RECORDED evidence enters a model-bound prompt — the
--gate-retry brief's failing-gate output tails (`src/runner.ts`
`composeGateRetryBrief`; gate output is target-repo-influenced: test names
and assertion messages are attacker-writable content in the target repo)
and the round composer's reviewer observations (`src/rounds.ts`
`survivorEvidenceText`; reviewer findings routinely quote worker-authored
diffs and logs, so a worker can launder instructions through the
reviewer's trusted advisory voice) — now wrap that evidence in ONE shared
delimiting discipline, `src/evidence-fence.ts`: (1) FENCED, explicit
plain-text open/close markers (`=== BEGIN/END RECORDED GATE OUTPUT ===`,
`=== BEGIN/END RECORDED REVIEWER OBSERVATIONS ===` — no markdown
dependence); (2) ROLE-LABELED, the markers name what the block is; (3) a
fixed not-instructions line, one literal byte-identical at both seams;
(4) CAPPED at the existing scale with explicit truncation markers where a
composition-side cap newly applies. The evidence bytes ride VERBATIM
between the markers — never sanitized (the T-029 fixture-faithfulness
rule) and never filtered (what the reviewer may quote is its posture's
business, T-023 — the composer filters nothing). Never verdict-affecting
(prompt bytes only); the gate tail's own 4,000-byte capture cap (T-027,
`src/gate/command.ts`) stays the evidence's bound, and the retry brief's
T-040 findings caps (`MAX_RETRY_FINDINGS` 5 / `MAX_RETRY_FINDING_CHARS`
2,000) are UNCHANGED and re-pinned green by this gate's F leg. Both
composition functions carry docblocks stating the discipline so the next
seam copies it; the fence module's docblock states it in full.

The composer's observation rendering gains the named exported caps
`MAX_OBSERVATION_CHARS` (2,000 — the `MAX_RETRY_FINDING_CHARS` mirror,
per-finding on the rendered `- [severity] finding (evidence: …)` line,
whose pre-T-061 shape is unchanged) and `MAX_OBSERVATION_BLOCK_CHARS`
(12,000 — one survivor's joined observation lines, fencing excluded; the
reviewer contract's documented maximum of six observations at the full
per-finding cap, the same total the retry brief's findings section
bounds), both cutting with explicit exported markers (a prefix cut, never
a rewrite; under-cap bytes ride verbatim).

The check is token-free (fake adapters + the real runner and composer,
the Gate 1.24/1.27 pattern; hand-built composer fixtures, the Gate 1.22
leg-A pattern), 35 assertions across legs **M** (module contract: the
fence module loads and exports the discipline — the fixed
not-instructions line, both role labels, the fence composer; the composer
caps and both truncation markers exported; the retry findings caps
unchanged), **R1** (the retry-brief seam: a failing gate whose recorded
tail carries instruction-shaped text rides fully inside the labeled fence
with the not-instructions line, the bytes between the markers
byte-identical to the recorded tail — exact equality, newlines included;
gates-section framing unchanged; passing-gate output still rides nothing),
**R2** (one fence PER failing gate, each byte-faithful to its own tail,
framing lines outside), **C1** (the composer seam: instruction-shaped
observations ride inside their own fence in the packet's record content
AND the rendered block, byte-identical between the markers,
engine-rendered gate-verdict lines outside the fence, advisory/block
framing unchanged, determinism), **C2** (both caps: the exact expected
truncated line and truncated body, verbatim prefixes, an under-cap
sibling untouched, a per-block flood, determinism), and **F** (the retry
brief's findings caps unchanged and green under an over-length
blocker-advisory finding, provenance honest, retry firing).

Red bar (AGENTS.md #8), recorded BEFORE the change by running this check
on the pre-change lane (= main, every src change stashed including the
untracked fence module) with the exact check bytes that now ride the fast
tier: 23 named failures, exit 1, verbatim at
`C:\swarm\verify-red\T-061-red.log` — the fence module import fails (M,
dynamic so the red is behavioral, the check-worker-orientation pattern),
the composer caps are undefined, and both seams ride their
instruction-shaped fixtures with NO fence, NO role label, NO cap marker
(R1/R2/C1/C2); the F leg was already green on main (the T-040 caps it
pins are unchanged by this ticket — the stability half of its criterion).
All 35 assertions green on the lane build; the full fast tier ALL GREEN
(two consecutive runs) in the same change-set.

**Gate 2 owed** (`src/runner.ts` retry composition + `src/rounds.ts`
composer changed; the standing trigger fires on runner touch): every
existing Gate 2 assertion green — the fences ride retry/round-2 paths and
must not disturb them. Gate 3 n/a (no adapter change).

Required whenever the fence discipline (`src/evidence-fence.ts`), either
fenced seam's composition (`composeGateRetryBrief`,
`survivorEvidenceText`), or the observation caps change.

## Gate 1.48 — adversarial expected outcomes: correct input validation stops recording as a crash (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-adversarial-outcomes.mjs
```

Pins T-062 (the adversarial review 2026-10-23's R16 disposition): the
adversarial probe's survival rule was exit 0 alone, so a well-behaved CLI
that validates argv and exits 1 on the malformed corpus inputs recorded
`crashed-exit` / `success: false` while a no-op handler that never reads
argv survived all 20 — evidence semantics inverted against exactly the
candidates a robustness goal wants, then rendered as "failed" into the
round-2 planner prompt by the composer (register R16's bad-mouthing). The
fix, per-case ENGINE-AUTHORED expectations attached to the corpus:

- **the expectation seam**: `adversarialCaseExpectations(cases)`
  (`src/probe.ts`, exported, pure) derives per-case `'exit-0' | 'reject'`
  expectations. The implementation-fixed reject split — corpus entries
  whose input is invalid by construction: the empty-input edge (index 0),
  the control-character case (index 1), the three malformed-JSON-looking
  strings (indices 9-11; 1-based cases 1, 2, 10, 11, 12) — pinned by index
  by this gate. Expectations are a function of the ENGINE-AUTHORED corpus
  alone: never inferred from the target's behavior, never reclassified
  after watching the target run, never a function of the seed's random
  tail (every generated case — soup AND permutations — expects exit-0;
  different seeds derive the IDENTICAL expectation list; the function is
  total, uniformly exit-0 on non-corpus lists). Seed determinism untouched:
  same seed → byte-identical case list AND byte-identical expectation list
  across two runs (the Gate 1.15 seam, extended).
- **the outcome classes** (`src/probe.ts` AdversarialProbe): a clean
  non-zero exit within the budget on a reject-expected case records
  `rejected-as-expected` and counts toward survival (a PASSED case row);
  an exit 0 on a reject-expected case records `unexpected-exit-0` (the
  no-op handler — an unmet expectation, never survival); exit-0-expected
  cases keep survived / crashed-exit / crashed-timeout exactly as T-032
  defined them. Probe success = every case spawned AND every case met its
  expectation (`passed: outcome === 'survived' || outcome ===
  'rejected-as-expected'`). A timeout or spawn refusal stays NEVER survival
  on either expectation — a reject-expected case that times out records
  `crashed-timeout`, not rejection (the T-032 refusal vocabulary
  unchanged, strengthened-or-equal: this gate adds the pinned faces, Gate
  1.15's refusal faces stay green). The honest boundary, stated in the
  ticket, the module docblock, and here: a clean non-zero exit is
  indistinguishable at the process boundary from an unhandled throw on the
  same input — both record rejected-as-expected; non-zero exit is non-zero
  exit. NO loosening where exit 0 is the expectation: a seeded-soup case
  exiting non-zero STILL records crashed-exit and sinks probe success.
- **the recorded tables**: `<probeId>.results.json` case rows gain
  `expectation` beside `outcome`, and the table gains `casesRejected` /
  `casesUnexpectedExit0` beside the unchanged-meaning `casesRun` /
  `casesCrashed` (rejected cases are NOT merged into crashed or survived —
  counted honestly); the bundle's measurements gain `cases-rejected` and
  `cases-unexpected-exit-0` (unit `'cases'`).
- **the report + composer seam**: `ProbeRunSummary` gains an optional
  `casesRejected` (present only when the bundle carried a non-zero
  `cases-rejected` measurement — adversarial probes; the
  `CandidateReport.probes` optional-field pattern, so flag-less and
  non-adversarial reports are byte-identical), filled by the runner from
  the bundle's own measurements. `src/rounds.ts` renders it in the probe
  line — `N input case(s) rejected as expected — validated input handling,
  not a failure` — so round-2 evidence no longer marks validating
  candidates as failed. The annotation never launders a genuinely failed
  probe (a probe that also failed other cases still renders `failed`, with
  the rejection scope named); summaries without `casesRejected` render the
  exact pre-T-062 line shape.

The check is token-free (the Gate 1.15 direct-execution pattern: real
list-form spawns against generated fixture targets; hand-built composer
fixtures, the Gate 1.22 leg-A pattern), 15 assertions across legs **D**
(determinism + the exact authored split + seed-independence + totality),
**V** (the validating-fixture GREEN pair), **S** (soup-case strictness +
the no-op inversion face), **T** (reject-expected timeout →
crashed-timeout with the spawned tree verified dead; spawn refusal stays
never-survival), and **C** (composer honesty: annotation present and
`success` for the validating summary, never `failed`; a failed probe stays
`failed`; back-compat line shape).

Red bar (AGENTS.md #8), recorded BEFORE the change, token-free, on the
pristine lane worktree (= main): a throwaway script ran the AdversarialProbe
directly against the validating fixture (the same fixture the V leg
regenerates) and asserted main's recorded behavior — the 5 malformed-corpus
cases (indices 1, 2, 10, 11, 12) all `crashed-exit`, `success: false`,
`error: "case 1/20 exited with code 1"`, exactly those rows failed — exit 0,
output verbatim at `C:\swarm\verify-red\T-062-red.log`. The green
replacement (the same fixture recording `rejected-as-expected`, counting
toward survival, probe success true) is the V leg. Gate 1.15's adversarial
faces were rewired onto the same expectation-aware derivation in the same
change-set (the T-062 flips recorded above); all 124 Gate 1.15 assertions
green.

**Gate 2 owed** (probe record shape changes → report shape changes — the
optional `casesRejected` summary field; the standing trigger fires): every
existing Gate 2 assertion green. Gate 2 is a `--goal`-mode run that
exercises no probe code, so the field's absence keeps its report
byte-identical; the full-tier re-run recorded at landing. Gate 3 n/a.

Required whenever the adversarial expectation seam
(`adversarialCaseExpectations`, `ADVERSARIAL_EDGE_CORPUS`), the
AdversarialProbe outcome classes, `ProbeRunSummary.casesRejected`, or the
composer's probe-line rendering change.

## Gate 1.49 — probe capture-path + evidence-id validation at the class boundary (seconds, fast tier)

```bash
node node_modules/tsx/dist/cli.mjs scripts/check-probe-boundary.mjs
```

Pins T-063 (the adversarial review 2026-10-23's R18 disposition, first
branch): `ScreenshotProbe`'s docblock claimed the class held the
capture-path contract for directly constructed scenarios, but
`captureRefusal` checked only non-empty string — the workspace-relative /
no-`..` refusals lived solely in `parseJobsSpec`, so a hand-built scenario
(not arriving through a parsed spec) could point its capture path at any
PNG-magic file reachable from the worktree and have it copied into the
run's evidence. The two-part change:

- **`captureRefusal` now holds the spec's own refusals** — same rules
  (`win32.isAbsolute` regardless of host OS, so drive-letter,
  forward-slash-rooted, and UNC forms are refused deterministically;
  segment-lexical `..` check over `/[\\/]/`), same vocabulary, same
  message shapes including the `(got …)` suffix carrying the RAW value
  (a missing capture renders `(got undefined)` on both sides — the raw
  value, not a normalized `''`, reaches the class-side refusal for exactly
  this parity). The refusal fires BEFORE the capture command runs. The
  parse-side (`parseJobsSpec`, src/scheduler.ts) is byte-unchanged; this
  gate pins the non-divergence mechanically — for every refusal input both
  sides refuse and the parse message is exactly its where-prefix
  (`--jobs spec refused: job 'j1' probes[0] `) plus the class-side rule.
- **Evidence-path ids are validated against the engine's id charset** —
  the VALIDATE branch of the ticket's two-part disposition, chosen because
  the read showed neither id provably engine-generated at the module
  boundary: `EnvironmentSpec.candidateId` is the --jobs JOB id in-pipeline
  (operator-supplied, charset-checked one layer up by parseJobsSpec for
  spec-driven runs only; engine-generated `c01..cNN` in default mode,
  where no probes run), and the probeId is the `ScenarioSpec` id
  (operator-supplied, same one-layer-up check) — a directly constructed
  environment or scenario, the same hand-built path the capture contract
  covers, can carry either id as any string. `SPEC_ID_PATTERN`
  (`[a-z0-9][a-z0-9-]*`, src/scheduler.ts) is IMPORTED into src/probe.ts
  (never re-declared, so the checks cannot drift; no runtime cycle —
  scheduler.ts's probe import is type-only) and enforced by
  `requireEvidenceSafeId` before any id reaches `join()`: `join`
  normalizes `..` segments away, so an unchecked id could point the "run
  folder" (`<artifactsDir>/probes/<candidateId>`, `probeEvidenceDir`) or
  an evidence FILE name (`<probeId>.json/.log/.png/.results.json/
  .response.json`, `evidenceBundlePath` + `probeArtifactName` — every
  artifact writer in the module routes through these two helpers) outside
  the run's artifacts dir. A refusal is a thrown Error: inside a probe's
  `run()` the runner's failedBundle path records it (src/runner.ts
  runProbes), and at `writeEvidenceBundle` the runner's evidence-write
  path logs it and skips the summary — never a crash of the run, never a
  byte written outside the artifacts dir. In-pipeline ids are unaffected
  by construction (parse-side violators never reach a probe; the pipeline
  shapes `c01`, `job-a`, `shot-1`, `c01-r2` all pass the charset — pinned).

The check is token-free (the Gate 1.15 direct-execution pattern: real
list-form spawns, hand-built scenarios through `createProbe`, never
through `parseJobsSpec`), 67 assertions across three legs: **1** the
class-boundary capture refusals (empty/missing/non-string; four absolute
forms; four `..` forms — each refused with the parser's rule, the `(got …)`
shape, and BEFORE the capture command runs, read as a marker file's
absence in the workspace; the two recorded red-bar faces asserted by
name); **2** the parse-side parity — every refusal input refused by
`parseJobsSpec` with the message agreeing exactly (where-prefix + class
rule; non-divergence), plus the positive control (a valid capture parses
and is preserved verbatim); **3** the evidence-path id faces —
`probeEvidenceDir`/`evidenceBundlePath` refusing `..`/absolute
candidateIds and probeIds with the `evidence path <kind> … does not match
[a-z0-9][a-z0-9-]*` vocabulary, `writeEvidenceBundle` refusing a
charset-violating probeId with NOTHING written (a fresh artifacts dir
never comes to exist), a directly constructed environment with a `..`
candidateId refused inside `run()` with nothing written, the
pipeline-shape acceptance leg, and the happy-path control (a valid
relative subdirectory capture still runs to success:true with the durable
copy at `<artifactsDir>/probes/<candidateId>/<probeId>.png` — the guard
does not over-refuse; Gate 1.15's full screenshot suite runs green
unchanged beside this gate, pinning in-pipeline parity).

Red bar (AGENTS.md #8), recorded BEFORE the change, token-free, on the
pristine lane worktree (= main a67d139): a throwaway script (deleted from
the change-set; its output quoted here) directly constructed the two
scenarios against unchanged sources. Face 1 — the ticket's named red — an
absolute capture path at the checked-in tiny PNG outside the workspace:
`class refused the absolute capture path: false` (only the empty-string
refusal existed), the class honestly reporting the out-of-workspace path
as "inside the workspace" in its missing-file error. Face 2 — the live
exfiltration vector — a five-level `..` chain from a nested workspace at
the same PNG: `class refused: false`, `bundle success: true`, and
`out-of-workspace PNG copied into run evidence: true` (the file five
levels above the workspace passed every PNG check and was copied into the
run's evidence as a success:screenshot artifact — `join()` normalizes the
`..` chain away, which is exactly why the segment-lexical refusal is
required BEFORE the join). The green replacement — both faces refused
with the parser's vocabulary before the command runs — is leg 1's two
by-name assertions.

**Gate 2 not owed** (the trigger analysis, recorded at landing): probe
internals only — no report shape change (no `CandidateReport`/
`ProbeRunSummary`/`EvidenceBundle` field touched; a refusal is a thrown
Error on paths that previously produced a missing-file failure bundle or,
for in-pipeline ids that were always valid, no change at all), no
runner/adapter/gate/workspace touch (`src/runner.ts`, `src/worker/`,
`src/gate/`, `src/workspace/` byte-unchanged — the diff is
`src/probe.ts`, this check, this file, and the ticket docs), and the
in-pipeline spec path is byte-identical (parse-side untouched, Gate 1.15
green unchanged). Gate 3 n/a (no adapter touched).

Required whenever `ScreenshotProbe.captureRefusal`, the evidence-path
helpers (`probeEvidenceDir`, `evidenceBundlePath`, `probeArtifactName`,
`requireEvidenceSafeId`), or the parse-side capture/id refusals in
`parseJobsSpec` change — the two sides are pinned non-divergent, so a
change on either side must re-run this gate.

## Gate 2 — harness end-to-end (minutes, spends model tokens)

```bash
npm run verify:full
```

Since T-055 the tier's reset archives instead of wipes: before the run
starts, every existing `^\d{14}$` run dir under the live root moves to
`C:\swarm\verify-archive` (most recent `ARCHIVE_KEEP_RUNS` = 10 kept,
older deleted, nothing non-timestamped touched) — Gate 2 citations (the
repo's cite-the-artifacts posture) survive later full-tier runs. The rule,
the constant, the archive root, and the incident that motivated the change
(run 20261024021432 wiped from disk after Known issue #6's 2026-10-24
observation cited it — the T-049 incident) are pinned token-free by Gate
1.41.

Since T-056 the planner assertions here are also the real-token proof of
brief-count honesty: `parseBriefs` now fails a short/long planner reply into
the raw-goal fallback instead of silently padding/truncating it (Gate 1.42
pins the mechanics token-free), so a healthy run's green `planner.ok` /
`fallbackUsed: false` assertions prove the exact-count clause did not
disturb exactly-count replies on a real model; a future run whose planner
genuinely returns a mismatched count records the fallback honestly (and goes
red here) rather than laundering one brief into N candidates. Gate 2 owed at
T-056 landing (planner-phase behavior changed) — trigger analysis in the
ticket's Landed; the driving full run IS the evidence.

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
section. **And a real `--verifier-model` run since T-040** (the ticket's
Gate 2 shape — the change-set touches the runner's verdict-adjacent
composition seam and extends the `gateRetry` block): the full tier passes
`--verifier-model zai-coding-plan/glm-5.3-flash`, so every candidate carries
a T-039 verifier block on its final attempt, and every gate-failed
retry-eligible leg additionally carries the T-040 pre-retry verification
(bounded at two verifications per candidate; whether that fires on a given
real run is read off the `gateRetry` blocks' `findings` provenance, never
asserted — a passing run fires none). The verifier block is asserted
STRUCTURALLY in the tier's assertions below — present, model recorded
verbatim, honest ok flag (well-formed severity vocabulary when true, an
explicit `ok: false` on a real-run parse degradation — an honest pass, not a
red), raw output persisted on disk — never on content: findings advise, and
every verdict assertion stays gate-decided. :**Recorded 2026-10-22 (two full-tier runs of this exact tree, hand-run
post-review; logs `C:\swarmerify-red\T-038-hand-gate2-full{,-run2}.log`):**
run 1 (`20261022152425`) RED on exactly one assertion — candidate c01-r2
produced a zero-byte diff, and the engine's own rules held (NO-OP recorded
`passedAllGates: false`, the flag inert on a terminal zero-byte leg — a live
demonstration of both immunity faces); diagnosed as the known worker no-op
flake class, nothing in the change-set implicated. Run 2 (`20261022155445`)
**ALL GREEN** — 4/4 candidates with non-zero diffs, every gate PASS, both
rounds executed, disposal clean. No candidate failed a gate in either run,
so no `gateRetry` block fired: these runs demonstrate the no-regression half
only, and the conversion question stays recorded as open (the ticket's
Landed block holds the verbatim reading). Then
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
**70 min since T-054**; 50 min T-040–T-053; 35 min T-030–T-039) bounds CI; it
deliberately exceeds
the runner's OWN per-worker budget — `--timeout-min` default 15 (src/cli.ts),
at which the T-011 verified tree kill resolves a stalled worker into a FAILED
candidate verdict, plus the planner/gates/reviewer/verifier legs — so the
runner, not the verify harness, produces the verdict when a leg stalls, and
Gate 2 fails on its `workerOk` assertion with a truthful line. Since T-030
the run is a 2-round loop, and since T-040 the tier carries
`--verifier-model` (four real verifier dispatches per healthy run, observed
278–429s each with a bounded repair; reviews 76–150s): the healthy slow-day
skeleton path measured ~30+ min across the two wrapper kills recorded under
Known issue #12 — and ~55–60 min across the T-054 calibration (the fourth
kill: run 20261026020833 killed at the 50-min ceiling mid-round-2 with every
worker ok, every gate PASS, bounded repairs on four verifier legs and one
review leg, workers 675s/537s on the day). 35 min sat within noise of a
HEALTHY run and 50 min within its slow-day variance; one stalled leg (up to
15 min before its own budget reaps it into a runner verdict) would SIGTERM
an informative run — 70 gives the measured healthy slow-day path room plus
one such stall while still reaping a genuinely stuck run. At the
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
**Since T-054 the tracked driving workflow carries the note's number:**
`.zcode/workflows/ticket-implement.dwf.ts` runs the full tier at
`timeoutMs: 5100000` (85 min — the 70-min inner ceiling + the fast tier,
plus margin; the PAIRED-VALUE comment sits on the raise itself; 3600000/60
min T-040–T-053). The three kills that calibrated this lineage (the two
1500000ms wrapper kills, then the inner ceiling's own 50-min SIGTERM) came
from pre-edit loaded scripts and pre-raise ceilings — a lane's edit to the
tracked file takes effect only when the driving run is amended or re-created
from it, so the wrapper value and the inner ceiling are one paired decision.
The wrapper is repo content and lanes may raise it when their change-set
legitimately grows the tier — never shrink the tier's own assertions to fit
a wrapper.

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
     occurred. **2026-10-22 worker-class observation (run
     20261022215556's `worker.log`s, the T-040 lane's second driving Gate 2
     red): the same auto-reject containment, on the WORKER side, derailed
     BOTH `worktree-write` builders to a same-run NO-OP pair.** Each worker
     — given a properly leased, properly based worktree (the run's own
     verifier later read `wt\c01\calc.js`, 17 lines, and `test.js` with the
     T-041 ratchet checks, proving the lease was populated) — probed the
     CANONICAL fixture instead of its lease (`Read
     C:/swarm/demo-target/calc.js`, inferable from the goal text's
     "demo-target" plus the lease path's `C:\swarm\…` prefix), hit
     `permission requested: external_directory (C:\swarm\demo-target\*);
     auto-rejecting` on every such read, and exited 0 in 5.3s/7.4s with
     zero edits — the ladder's NO-OP verdicts (AGENTS.md #7) and the
     honestly-unexecuted round 2 were the machinery working, and all nine
     of the tier's assertion failures are that rule or its honest
     downstream. Same disposition as every observation in this class: the
     containment held, nothing leaked, no code change — the failing legs
     are model-behavior variance, and the remedy is a re-run (the T-038
     run-1 → run-2 precedent), not a weakening of the NO-OP rule or a
     relitigation of the blind-reroll ban (decisions.md 2026-10-21).
     **2026-10-23 worker-class observation, distinct mechanism (run
     20261023204747, the T-043 lane's driving Gate 2 red): a round-2 brief
     whose PREMISE does not hold at the shared base.** One worker (c02-r2)
     — properly leased, properly based, and reading its OWN lease this
     time (`worker.log`: `Read package.json`/`calc.js`/`build.js`/
     `test.js` at `wt\c02-r2\`) — was handed a planner-composed round-2
     brief describing the repo "with: vec3.js exposing
     add/sub/scale/dot/cross/…" (the T-030 composition feeding the
     round-2 planner round-1 survivor evidence); `vec3.js` exists only in
     round-1 c02's SURVIVOR DIFF (`c02/diff.patch` creates `b/vec3.js`),
     not at the base round 2 re-leases at — so `Read vec3.js` failed
     (`File not found: …wt\c02-r2\vec3.js`), the worker gave up WITHOUT
     editing, and exited 0 in 530s with zero edits. The ladder worked
     exactly as designed: 0-byte diff → NO-OP elimination
     (`passedAllGates: false`, no `--gate-retry` — a zero-byte diff has no
     failure output to feed back and is banned from retrying,
     decisions.md 2026-10-21), gates green on the untouched green base —
     and it was the tier's ONLY failing assertion (`c02-r2: diff
     non-empty`; `verify (full) complete: 1 failure(s)`), every other
     candidate, loop, and hygiene/disposal assertion green on the same
     run. Composition
     provenance: the false premise was authored by the round-2 planner
     model over the composed survivor packet — `src/rounds.ts` and
     `src/runner.ts` are untouched by the T-043 change-set (src/cli.ts
     only, whose baseline lease fully completes and disposes before
     `runSkeleton`), and the sibling round-2 candidate (c01-r2, same
     composition, 13,026-byte diff, survivor) demonstrates the loop
     itself ran. Same disposition as every observation in this class: no
     code change, nothing weakened — the remedy is a re-run. The recorded
     hazard for the rounds successor: a planner may present
     survivor-CREATED files as base state; whether the composed packet
     should carry an explicit "round 2 re-leases at the SAME base —
     survivor files are NOT present" framing is a T-030/T-031-successor
     question (the loop stays capped at 2 and its improvement-signal
     question stays open, decisions.md 2026-10-20).
     **2026-10-24 follow-up (T-050, landed): the successor question is
     answered YES, two ways** — the composed block's framing now carries
     the explicit premise lines verbatim (`ROUND_PREMISE_LINES`,
     src/rounds.ts), and a mechanical brief-annotation guard
     (src/premise.ts, Gate 1.35) scans every PLANNER-authored brief
     (rounds 1 and 2) for path tokens absent at baseSha, appending the
     survivor-created or base-commit-absent note to the dispatched brief
     (before/after evidence in `brief-premise.txt`; the report's `brief`
     and every verdict expression untouched). The NO-OP ladder is
     unchanged — it was right; the brief was wrong, and now the brief
     gets corrected. Whether this moves the round-2 no-op rate is T-049's
     yield instrument's question, not this change's.
     **2026-10-24 worker-class observation, third distinct mechanism (run
     20261024021432, the T-047 lane's driving Gate 2 red): the worker
     mis-transcribed its OWN lease path.** One worker (c02-r2) — properly
     leased, properly based — read `.`/`package.json`/`test.js`/`calc.js`
     fine through relative paths, then attempted ONE absolute read with
     the candidate id's hyphen transcribed as a path separator (`Read
     C:/swarm/verify/20261024021432/wt/c02/r2/build.js` — the lease is
     `wt\c02-r2`), hit `permission requested: external_directory
     (C:\swarm\verify\20261024021432\wt\c02\r2\*); auto-rejecting` (the
     containment working, again), and gave up WITHOUT editing — exit 0 in
     11s, zero edits, 0-byte captured diff (`diffPath` set: the capture
     succeeded on an untouched tree — a genuine no-op, never a capture
     failure; the dispatch completion line records `diffBytes: 0`
     faithfully). The ladder worked exactly as designed: NO-OP
     elimination (`passedAllGates: false`, no review), gates green on
     the untouched green base (the AGENTS.md #7 hazard — and the
     `diffBytes > 0` conjunct doing exactly what it exists for), round 2
     still executed with the sibling c01-r2 surviving (5,900-byte diff —
     same composition, same loop) — and it was the tier's ONLY failing
     assertion (`c02-r2: diff non-empty`; `verify (full) complete: 1
     failure(s)`), every other candidate, loop, verifier, and
     hygiene/disposal assertion green on the same run. Change-set
     provenance: the T-047 diff touches no worker, prompt, path, or
     adapter code (`src/types.ts` + `src/workspace/worktree.ts` +
     `src/runner.ts`'s post-gate snapshot + `src/integrate.ts`'s note —
     verdict-inert evidence surfaces, and the snapshot runs after the
     diff is already captured). Recorded for T-047's own real-run
     surface while we were there: NO candidate in the run carries an
     `ignoredPaths` block — the fixture leases held no ignored trees
     (the demo `.gitignore` names `node_modules/`; neither worker nor
     gate created one), the producer-only absence Gate 1.33 predicted
     for the real run, now confirmed on one. Same disposition as every
     observation in this class: the containment held, nothing leaked,
     no code change, nothing weakened — the remedy is a re-run.
     **2026-10-24 worker-class observation, fourth instance — the
     give-up-without-editing class with NO premise lie and NO containment
     event (run 20261024193003, the T-050 lane's driving Gate 2 red,
     review round 1).** One worker (c02) — properly leased, properly
     based, reading its OWN lease throughout (`worker.log`: Glob, then
     `Get-ChildItem` at `wt\c02`, then `Read package.json`/`test.js`/
     `calc.js`/`build.js`, every read successful — zero permission
     rejections, zero not-found errors in the entire 25-line log) —
     simply produced nothing after exploring: exit 0 in 562s, zero
     edits, 0-byte captured diff. The ladder worked exactly as designed:
     NO-OP elimination (`passedAllGates: false`, no review), gates green
     on the untouched green base, round 2 still executed on the sibling
     survivor — and it was the tier's ONLY failing assertion (`c02: diff
     non-empty`; `verify (full) complete: 1 failure(s)`), every other
     candidate, loop, verifier, review, and hygiene/disposal assertion
     green on the same run. Distinct from the 2026-10-23 premise-lie
     mechanism this lane's guard targets: c02's brief asserts nothing
     absent (every file it names exists at the root-level base), the
     guard was correctly INERT for it (no `brief-premise.txt`,
     byte-identical dispatch), and the worker failed at the
     explore-then-edit step, not at any read. T-050's own real-run
     surfaces, confirmed on this run from its kept artifacts: the guard
     FIRED on c01's round-1 brief (the planner hedged "adjust path to
     actual layout, e.g. src/calc.js or equivalent" — `src/calc.js` is
     absent at the root-level base; `c01/brief-premise.txt` records the
     before/after with the base-commit-absent note) and the ANNOTATED
     candidate survived (3,131-byte diff, all gates) — the note verified
     a path instead of derailing a worker (the pass-direction verdict
     inertness on real tokens); and the round-2 planner, seeded by the
     composed block carrying all four T-050 premise lines, stated TRUE
     base facts unprompted ("the calculator is a root-level calc.js with
     no src/ directory"), c01-r2 guard-inert and surviving (4,489
     bytes). Same disposition as every observation in this class: no
     code change, nothing weakened — the remedy is a re-run (the T-038
     run-1 → run-2 precedent); whether the guard moves the round-2
     no-op rate is T-049's yield instrument's question, and this run
     contributes one honest data point (guard fired once, that candidate
     survived; the no-op rode the guard-inert sibling).
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
   **2026-10-22 fourth observation (T-040 lane, mid-review fast tier) —
   recurred, and the captured-line duty was MISSED by the implementer
   side.** One fast-tier run aborted at Gate 1.12 (`kill-tree self-check
   failed: 1`) on a tree the T-040 change-set does not touch (its diff:
   src/runner.ts, src/types.ts, scripts/check-gate-retry-findings.mjs,
   scripts/check-gate-retry.mjs, scripts/verify.mjs, the tracked driving
   workflow, docs); the implementer's output capture (`tail -3`) dropped
   the check's own `FAIL: <name>` line — the same capture gap this ledger
   keeps hitting, now on the implementer side of the wrapper. Disposition
   per this issue's standing rule, a re-run not a code change: the
   immediate full-output re-run of the identical tree was ALL GREEN
   (teed: `C:\swarm\verify-red\T-040-lane-fast-rerun2.log`, exit 0, no
   FAIL lines). The 4th observation therefore does NOT deliver the
   diagnosis the threshold demands; the classification stays loud-by-design,
   benign, evidence-only, and the next recurrence must come with the line
   captured before any edit is considered.
   **2026-10-24 fifth observation (T-052 lane review round 1) — the
   captured line delivered, and the diagnosis names the leg.** One
   fast-tier run failed inside `scripts/check-machine-worker.mjs` (Gate
   1.17, S4 — the first capture of this class outside check-kill-tree):
   exit 1, exactly one assertion false —
   `FAIL: S4: the verified tree kill fired — the log carries "tree killed,
   verified:" and the drained child stdout`
   (`C:\swarm\verify-red\T-052-lane-fast.log:1919`, the review-side full
   log — the capture duty the 4th observation demanded, discharged by the
   review's own tee this time). The diagnosis: NOT an already-gone root —
   the root was live (the timeout fired; the `timedOut true` assertion
   passed) — but the snapshot/verification leg: the same scenario's
   `S4: the whole planted tree is dead on the real process table` PASSED,
   so the tree verifiably died while the log carried the unverified shape
   (a `CLEANUP FAIL` line, which the tolerant sibling assertion explicitly
   accepts), and the strict verified-line assertion failed on it — this
   issue's founding signature verbatim. The T-052 change-set shares no code
   path with the check (its diff: `src/lock.ts` + `src/recover.ts` +
   scripts/docs; every lock use in the check is a self-paired
   acquire/release in one process, and `src/recover.ts` is never imported
   by it). Disposition unchanged — a re-run, not a code change: the
   identical committed tree (5ea6529) re-ran the full fast tier ALL GREEN
   (1,948 ok lines, exit 0, teed
   `C:\swarm\verify-red\T-052-lane-fast-rerun.log`) plus five consecutive
   standalone Gate 1.17 runs (37 ok / 0 fail each). Five observations,
   seven days, five lanes, zero shared change-set code; the class stays
   loud-by-design, benign, evidence-only — the diagnosis is now on the
   ledger, and any future edit (a snapshot retry, say) is a ticket-owned
   change-set that must first weigh the loud-by-design principle against
   the observed rate.
   **2026-10-25 disposition (T-054, landed) — the threshold clause's
   promised fix: the diagnosed leg is FIXED by Gate 1.40; the class is
   narrowed to what remains loud.** The fifth observation's diagnosis
   (the snapshot/verification leg, NOT an already-gone root) drove the
   mechanism: a snapshot failure now gets one immediate pre-kill retry
   (when it lands, the full original verification runs unchanged) and —
   if that also fails — the kill still fires (never skipped) and ONE
   post-kill liveness re-check gets the last word: everything the
   re-check can still link to the root proven dead upgrades the outcome
   to verified (no failure line, the success line), anything alive keeps
   its per-pid line, and a re-check that also cannot run keeps the exact
   pre-T-054 loud unverifiable shape (fail-closed). Red-before/
   green-after, token-free: the red bar ran the final check against
   main's engine (`scripts/check-kill-verify-upgrade.mjs`, exit 1, 9
   failures of 33, teed `C:\swarm\verify-red\T-054-redbar.log`) — the
   transient legs' pins failed because the injection seam cannot exist on
   main (the T-052 red-bar pattern: the seam is introduced BY this
   change-set) — and the leg R REAL-failure drive reproduced this
   issue's signature end to end on main: `CLEANUP FAIL: pid N tree kill
   could not be verified (descendant verification unavailable)` printed
   by a real PowerShell-unresolvable snapshot failure around a real
   killed tree whose death the same leg proves on the real process
   table. Post-change Gate 1.40 ALL GREEN (33 assertions, two
   consecutive runs), Gate 1.12's suite riding green unchanged (30
   assertions — the dead-root S3 pin and the live-kill S5 pin untouched),
   and the fifth observation's own check (Gate 1.17) green standalone.
   Dispositions of the five observations: all five are retroactively
   classified as instances of this diagnosed leg (the transient CIM
   hiccup — the loud lines sat on trees that died, per each entry's
   process-table assertions); the response-at-the-time rule (re-run,
   never weaken) is unchanged and was correct under the then-standing
   no-diagnosis posture. What remains loud after the fix, by design: a
   genuinely-unverifiable outcome (every snapshot attempt including the
   re-check fails), genuine survivors (normal path and re-check path
   alike), the dead-root leg (Known issue #8 untouched — a dead root
   never relies on taskkill reaping reparented descendants), and the
   bounded named weakness of the upgrade path (the re-check can only
   vouch for what still links to the root; the pre-kill tree's size is
   unknowable when its snapshot failed). The honesty property moved the
   reported accuracy UP, never the loudness down: a proven-dead tree is
   no longer a failure; an unproven one still is.
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
   **2026-10-24 second observation (T-052 lane review round 1) — this time
   the name was captured.** Identical shape to the first: one fast-tier
   Gate 1.17 red, `check-machine-worker: 1 failure(s)`, the paste's visible
   tail byte-for-byte the noise every green run prints. The review-side
   full log preserved the line (see Known issue #10's 2026-10-24 entry for
   the diagnosis): the failing assertion was S4's strict verified-line leg,
   with the same scenario's real-process-table assertion green — the #10
   class, first landed in this check. Not reproduced on the identical
   committed tree: five standalone runs plus one full fast tier ALL GREEN
   (`C:\swarm\verify-red\T-052-lane-fast-rerun.log`). Observed twice
   (2026-10-18, 2026-10-24), different lanes, zero shared change-set code;
   the name-capture duty this issue opened with is discharged for this
   observation, and the classification stays loud-by-design, benign,
   evidence-only.
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
    **2026-10-22 second budget kill (T-040 review round 1) — this time the
    change-set itself legitimately grew the tier, and the remedy landed
    in-repo.** The driving wrapper killed `npm run verify:full` at its own
    1500000ms budget (25 min) while the run was HEALTHY — the teed log
    (`C:\swarm\verify-red\T-040-gate2-full.log`) shows the fast tier green,
    round 1 complete (planner 32s; workers 264s/283s; verifiers 429s/299s —
    each with one bounded repair; reviews 89s/76s), round 2's workers done
    (187s/51s), c02-r2's verifier done (284s), and c01-r2's verifier
    mid-repair at the kill: no report.json, because the T-040 change-set
    added `--verifier-model zai-coding-plan/glm-5.3-flash` to the full tier
    (its ticketed Gate 2 shape), and four real verifier dispatches put the
    honest path at ~30 min — above a wrapper calibrated before the tier
    carried a verifier. Debris (4 registered worktrees, 4 `swarm/*`
    branches, 1 stale lock) disposed through the house path (`npm run clean
    -- --run 20261022193232 --run-root C:\swarm\verify --force --force-lock`;
    8 removed, 0 refused, 0 failed; fixture verified pristine after: only
    `main` in `worktree list`, no `swarm/*` branches, clean status; evidence
    kept — dispatch.jsonl, planner logs, per-candidate diff/review/verifier
    files). Remedy, per this issue's own T-027 record ("raise
    `opts.timeoutMs` ... or narrow the work" — narrowing was refused there
    and stays refused): the TRACKED driving workflow
    (`.zcode/workflows/ticket-implement.dwf.ts`, repo content) raised its
    Gate 2 `timeoutMs` 1500000 → **2700000 (45 min)** in the T-040 lane,
    restoring the wrapper-budget invariant (wrapper above the inner 35-min
    ceiling plus the fast tier, with the measured verifier overhead on
    top). That T-027 record's closing claim — the budget "no lane
    change-set can set" — is hereby marked obsolete: the workflow file is
    tracked, and the T-040 lane set it under the reviewer's explicit
    mandate. The kill was the wrapper's own misconfiguration, not a red of
    any assertion: nothing in the change-set was implicated, and the lane's
    fast tier was and stays green.
    **2026-10-22 third budget kill (T-040 review round 2) — the SAME
    1500000ms signature, and the diagnosis this one settles: the budget is
    driven by the workflow's LOADED script, not the tracked file.** The
    round-2 rerun carried the lane's raised value in the tracked file
    (committed, `2700000` at the lane's
    `.zcode/workflows/ticket-implement.dwf.ts`) and was killed at
    1500000ms anyway (teed log `C:\swarm\verify-red\T-040-gate2-full.log`,
    3146 lines, again HEALTHY at the kill — round 1's verifiers 410s/278s
    and reviews 143s/150s complete, the round-2 planner in flight; slower
    model day than round 1). The main checkout's copy of the workflow —
    what a driving run loads before the lane merges — still read
    1500000ms. Debris (run `20261022201344`: 2 worktrees, 2 `swarm/*`
    branches, 1 stale lock) disposed through the house path (`npm run
    clean -- --run 20261022201344 --run-root C:\swarm\verify --force
    --force-lock`; 4 removed, 0 refused, 0 failed; fixture pristine;
    evidence kept). Consequence, recorded so the pairing is never
    half-applied: the lane now carries the PAIRED raise — the inner
    skeleton ceiling 35 → **50 min** (scripts/verify.mjs; the healthy
    slow-day path measured ~30+ min, within noise of 35, so one stalled
    leg would have been an inner SIGTERM) and the workflow's Gate 2
    `timeoutMs` 2700000 → **3600000 (60 min)** — and the driving run must
    be AMENDED or re-created from the updated file before its next Gate 2
    attempt, since no lane commit can change an already-loaded script.
    **2026-10-26 fourth kill (T-054 review round 1) — this time the INNER
    ceiling itself fired, and the run was again HEALTHY.** The driving
    Gate 2 died at the 50-min inner ceiling (`FAIL: skeleton run failed:
    SIGTERM`) on run 20261026020833 with every worker `ok=true,
    timedOut=false`, non-zero diffs (14148/7321/5746/7490 bytes), every
    gate PASS, and the run's own kill/verify machinery never fired (grep
    over all four worker.logs: zero `CLEANUP FAIL` lines); the kill landed
    mid-round-2 — the last worker completed at 44.7 min (c02-r2, 537s),
    c02-r2's verifier was inside its bounded repair, its review pending,
    c01-r2 fully through review — a healthy run needing roughly 55–60 min
    on a slow model day (workers 675s/537s, verifiers 686s/423s, bounded
    repairs on four verifier legs and one review leg, each repair a second
    full dispatch). Debris (4 worktrees, 4 swarm/* branches, 1 stale lock
    whose holder pid 14528 was verified dead first) disposed through the
    house path (`clean --run 20261026020833 --run-root C:\swarm\verify
    --force --force-lock` from the T-054 lane; 8 removed, 0 refused, 0
    failed; fixture verified pristine after; evidence kept). Remedy, per
    this issue's twice-recorded raise discipline — repo-side narrowing was
    refused at kill 2 and stays refused: the T-054 lane carries the PAIRED
    raise — the inner skeleton ceiling 50 → **70 min** (scripts/verify.mjs;
    the measured slow-day path gets room plus one stall) and the
    workflow's Gate 2 `timeoutMs` 3600000 → **5100000 (85 min)** — and the
    driving run must be AMENDED or re-created from the updated file before
    its next Gate 2 attempt, since no lane commit can change an
    already-loaded script. The change-set under review shares no code with
    the run's speed: its engine diff (src/kill-tree.ts) touches only
    timeout-kill verification paths, which never fired in this run.
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
