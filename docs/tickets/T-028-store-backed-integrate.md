# T-028 — Store-backed integrate: verify-when-recorded diff evidence + store-recorded replay verdicts (closes T-005 carve #5)

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** T-016 (done — consumes its artifacts rows, `artifactId` handles, and the `verifyRunArtifacts` primitive), T-005 (done — extends its landed replay command; T-005:104-111 names this successor)

## What

Back `src/integrate.ts`'s integration replay with T-016's artifact store. Today the
diff is addressed purely by path convention — `existsSync(candidate.diffPath)` plus the
capture-time `diffBytes` number (`src/integrate.ts:151-153`) — and the raw path goes
straight to `git apply --check` / `git apply` (`:209`, `:221`), so a diff mutated after
the run replays silently. After this ticket the diff is addressed by its recorded
artifact handle, proven unmutated against the hash taken at ingest before anything
replays, and the replay's own verdict is recorded back through the store. One
change-set:

- **`src/store/index.ts` — one small exported derivation helper.** `diffArtifactId(c:
  CandidateReport): string | null`, placed next to `deriveArtifacts` (`:343-365`),
  returning `artifactId(c.id, finalAttemptNumber(c), c.diffPath)` when `diffPath`
  exists, else `null` — exactly the triple the ingest derivation pushes for the diff
  (`push(c.id, fin, c.diffPath)`, `:357`). `finalAttemptNumber` (`:325-328`,
  module-private) stays private; the helper is the export. Rationale: the handle must
  be computable from `report.json` alone (it is — `artifactId` is deterministic over
  `(candidateId, attemptNumber, path)`, `:260-271`, pre-T-007 reports giving the
  `j:<id>` scope, pinned literal `scripts/check-store.mjs:116-117`) and must never be
  able to drift from the ingested row's id, so the computation lives beside the
  derivation it mirrors.
- **`src/integrate.ts` — new `--db <path>` flag** (`parseArgs` `:60-88`, `Options`
  `:52-58`, usage `:31-50`), default `C:\swarm\refinery.db` (the T-006/T-008 defaults
  precedent: `src/cli.ts:155`, `src/approvals.ts:84`, `src/recover.ts:70`; decisions.md
  2026-10-10 run root `C:\swarm`). **Verify-when-recorded**, entirely inside the
  pre-lock policy-refusal block (`:143-158`, before `acquireCheckoutLock` at `:168`):
  compute `diffArtifactId(candidate)`; if the DB file exists at `--db`, call
  `verifyRunArtifacts(report.runId, opts.db)` (`src/store/index.ts:387-408` —
  read-only over both sides) and look up the row whose `artifactId` equals the handle:
  - `verified` → proceed (one log line naming the verified handle);
  - `mutated` → refuse non-zero: the diff on disk no longer matches the hash recorded
    at ingest, so the replay would re-verify evidence the run did not produce —
    §17.3:1199's "prior evidence is marked historical" is the honest frame, and the
    refusal message says the since-ingest scope out loud;
  - `missing` → refuse non-zero (the file existed at ingest, is gone now);
  - no row for the handle, or the row's hash is null (`unverified` — T-016 records
    NULL when the file was missing at ingest, `:284-308`; null is never readable as
    mutated), or no DB file at `--db` → fall back to today's behavior byte-for-byte.
    This keeps Gate 1.5's DB-less sandbox fixtures and every pre-T-016 run working
    unchanged. One deliberate addition this ticket makes (not in the carve list):
    a DB file that exists but cannot be opened refuses with a clear message rather
    than silently replaying unverified — a present-but-unreadable store means
    integrity evidence was expected from it, and silent fallback would hide that.
  - Every one of these refusals creates no worktree and takes no lock.
- **`src/store/index.ts` — one new writer, `recordIntegrateVerdict`.** Called from
  `writeVerdict`'s call sites (`src/integrate.ts:270-274` — note `writeVerdict` fires
  on the NO-OP refusal path `:227-238` as well as the normal path `:251-262`, so every
  replay verdict is recorded). It: upserts ONE `artifacts` row for the verdict file
  `integrate/<id>.json` under the producer triple `(candidateId, null, verdictPath)`
  (attempt NULL — the replay is not an attempt of the run's job; kind `'report'` by
  the path rule `:242-246`), with `size_bytes`/`content_hash` measured by the same
  `measureEvidenceFile` read (`:284-308`) after the file is written — hash-at-ingest,
  same as the run's own evidence; and inserts one `INTEGRATE_REPLAYED` event whose
  `at` stamps from the verdict's own `appliedAt` field (`src/integrate.ts:230`) —
  the **fourth documented wall-clock scoping case** in the store header (`:14-31`,
  after T-008 approvals and T-010 abandonment): a primary fact the replay produced
  that no report carries. §28:1844-1864 names no integration event, so this
  vocabulary extension is chosen and documented in the store header's vocabulary
  block (`:203-224`) per the T-008/T-009 precedent. Payload: candidateId, targetHead,
  applied, treeChanged, passed, worktreePath, verdictPath.
- **Never `gate_results`.** The replay's per-gate outcomes ride inside the hashed
  verdict JSON and the event payload — never as `gate_results` rows: the table's PK
  `(run_id, candidate_id, gate_name)` (`src/store/index.ts:101-110`) with
  `upsertGateResult`'s `ON CONFLICT … DO UPDATE` (`:1229-1235`) would OVERWRITE the
  run's own recorded verdicts — evidence mutated by a replay.
- **Best-effort, the run-ingest posture.** A failed store write logs loudly
  (`PERSISTENCE FAILED`-style, the `src/cli.ts:449-455` pattern) and does not change
  the replay's exit code or the on-disk verdict artifact — the exit code stays
  gate-determined exactly as today.
- **Replay semantics frozen byte-for-byte**: the detached worktree (`:184` and its
  rationale comment `:181-183` — deliberately not `WorktreeProvider.lease`, decisions.md
  2026-10-18), the gate NAME contract (`gateContract` `:115-123` — extended only by
  proposed T-027, not here), the NO-OP guard (`:224-240`, AGENTS.md #7), the binary
  refusal (`:212-216`, T-026's region), prepare-only §17.4 (`:1201-1203` — no commit,
  no branch, no ref move), and the checkout-lock flow (`:166-193`).

**Honesty boundaries stated, not smoothed (AGENTS.md #9):**
(1) hash-at-ingest proves unmutated-SINCE-INGEST, not since-capture — the capture-time
gap is a report-shape change that owns its own Gate 2 (T-016:57-60) and stays carved;
the refusal message and VERIFICATION.md say "since ingest". (2) The store header line
"persistence records verdicts; it never influences them" (`:12`) gains a scoping
paragraph in the established style: this ticket makes the store's first READ that
gates an action — a post-hoc human-facing replay refusal — while the run pipeline
still never reads the DB back. The refusal is machine evidence only: a sha256
equality check, zero model involvement (decisions.md 2026-10-10).

**Does NOT claim:** no `npm run recover` integration — T-016's own carve ("a later
recovery slice integrates it into `npm run recover`", VERIFICATION.md:1393-1395) stays
carved; integrate becomes `verifyRunArtifacts`'s first pipeline consumer, recover's
integration remains a separate successor. No report-shape change and no capture-time
hashes (T-016:57-60, own Gate 2). No replay verdicts through `gate_results`, ever. No
general-purpose `verifyRunArtifacts` CLI beyond this consumer. No replay-semantics,
gate-seam, adapter, or `src/parse.ts` change. Sibling sequencing: T-026 (proposed,
carve #2) also touches `src/integrate.ts` — its apply-refusal block (`:206-220`) plus
`src/workspace/worktree.ts` — a different region, no assertion overlap; T-027
(proposed, carve #1) touches the same file's docblock/usage (`:12-14`, `:39-41`) and
`gateContract` (`:115-123`) — this ticket edits the usage block too (adding `--db`),
so both rewrite adjacent doc text, and T-027 adds `command?` to `IntegrateVerdict.gates`
(`:133`) while this ticket leaves the `IntegrateVerdict` shape untouched (the store
writer hashes whatever the verdict file contains). Whoever lands second rebases; no
fixture either way changes the other's assertions. T-016 (done) is the dependency, not
a duplicate — nothing else consumes the read primitive from the pipeline today.

## Why

Integration replay is the repo's only post-hoc re-verification path (spec §17.3:1192-1199),
and its integrity check today is: the file exists, the capture-time `diffBytes` is
non-zero, and the gate NAME set matches (`src/integrate.ts:151-153`, `:155-158`). The
`diffBytes` is a number recorded when the diff was captured, not a live measurement, so
a diff mutated after the run — corrupted backup restore, partial cleanup, manual edit —
applies and replays silently, and the resulting verdict re-verifies evidence the run
never produced. VERIFICATION.md's integrate section (`:97-131`) pins the name-set
contract but has no integrity check on the diff bytes themselves.

The substrate to close this is landed and green: T-016's store records one `artifacts`
row per candidate diff with sha256-at-ingest measured before the DB opens
(`src/store/index.ts:357`, `:885-886`), derives deterministic handles computable from
`report.json` alone (`:260-271`), and exports the read-only re-verification primitive
`verifyRunArtifacts` (`:387-408`, spec §29:1877's "validate artifact files/hashes"
face) — whose only consumer today is Gate 1.16's `scripts/check-artifacts.mjs`
(VERIFICATION.md:1380-1419). T-005 explicitly carved this successor: "(5) a
store-backed integrate … a possible successor after T-003, not part of this one"
(`docs/tickets/T-005-integration-replay.md:104-111`); it is the third carved successor
to receive a ticket, after T-027 (carve #1) and T-026 (carve #2), and unlike those two
it pre-charges no Gate 2 (T-005:222-227 charges only the report-shape carve).

Scout-verified problem statement, re-confirmed by reading this session: a grep for
`hash|sha256|verifyRunArtifacts|artifact` over `src/integrate.ts` returns zero hits;
`parseArgs` (`:60-88`) has run/candidate/force-lock/run-root/gate/help only — no
`--db`. Ingest is post-run best-effort (`src/cli.ts:452`, log-and-continue `:449-455`),
so the DB can legitimately not exist for a given run — hence the fallback, not a
requirement. The detection half already works at HEAD: Gate 1.16 pins that a flipped
diff file reports `mutated` (VERIFICATION.md:1409-1419).

Value 4 because it closes a real integrity hole in the only re-verification path,
with machinery already landed; not 5 because nothing is blocked today — integrate
works and mutation is so far hypothetical. Risk 2 because only `src/integrate.ts` and
`src/store/index.ts` change, no pipeline/seam/report surface moves, and both known
hazards (`gate_results` overwrite of recorded verdicts; back-compat with DB-less
runs) have the concrete, precedented mitigations above.

## Acceptance criteria

- [ ] `--db` flag parses with default `C:\swarm\refinery.db` and is documented in the
      usage text — pinned by a **Gate 1.5** face (flag + help assertions in the
      integrate sandbox, `scripts/verify.mjs:261-436`). **Gate 0** green.
- [ ] Intact-store replay proceeds: a sandbox run ingested to a temp DB, diff
      untouched → `integrate --db <temp>` replays and exits 0 on passing gates, with
      a log line naming the verified handle — pinned by a new **Gate 1.5** face.
- [ ] Mutated diff refuses pre-lock: flip one byte of the diff after ingest →
      `integrate --db <temp>` exits non-zero from the policy-refusal block having
      created no integration worktree and taken no lock — pinned by a new **Gate 1.5**
      face asserting the refusal AND the sandbox repo's `git worktree list` unchanged
      and no lock files (the existing end-of-section pattern,
      `scripts/verify.mjs:430-436`). **Gate 1.16** already pins the detection half
      (`mutated` status, VERIFICATION.md:1409-1419) and stays green untouched.
- [ ] Diff deleted after ingest refuses (store status `missing`) with no worktree and
      no lock — new **Gate 1.5** face.
- [ ] Fallback is byte-for-byte today's behavior when nothing is recorded: no DB file
      at `--db`, no row for the handle, or a null-hash (`unverified`) row → replay
      proceeds exactly as before — pinned by (a) Gate 1.5's existing DB-less fixtures
      running unchanged (the back-compat pins, the T-027:44-46 pattern) and (b) a new
      face with a temp DB holding a null-hash row (file absent at ingest) whose replay
      exits 0.
- [ ] A DB that exists but cannot be opened refuses with a clear message (this
      ticket's stated choice, not silent fallback) — new **Gate 1.5** face.
- [ ] Every replay verdict is recorded through the store: after `writeVerdict` fires
      (both the normal and the NO-OP-refusal path), the store holds one `artifacts`
      row for `integrate/<id>.json` — kind `'report'`, producer triple
      `(candidateId, NULL, path)`, `size_bytes`/`content_hash` equal to the file's —
      and one `INTEGRATE_REPLAYED` event whose `at` equals the verdict's `appliedAt`
      — pinned by **Gate 1.6** extensions in `scripts/check-store.mjs` (row shape,
      event shape, hash-at-ingest of the verdict file, and re-record idempotency:
      same verdict twice → same row, events append-only).
- [ ] A replay never writes `gate_results`: the run's recorded verdict rows are
      value-identical before and after `recordIntegrateVerdict` — pinned by a
      **Gate 1.6** face (ingest a fixture run, record a verdict, compare the full
      `gate_results` content).
- [ ] `diffArtifactId` mirrors the ingest derivation exactly (no handle drift) —
      pinned by **Gate 1.6** exact-literal extensions for both scopes: a T-007-shaped
      report (attempt-scoped `j:<id>@a<n>`) and a pre-T-007 report (`j:<id>`,
      matching the existing pinned literals, `scripts/check-store.mjs:114-118`).
- [ ] A failed store write does not change the verdict: `--db` pointing at an
      unwritable path → the replay's exit code stays gate-determined, the on-disk
      `integrate/<id>.json` is intact, and the failure is logged loudly — new
      **Gate 1.5** face.
- [ ] No existing assertion weakened; the fast tier ALL GREEN with only the named
      extensions — pinned by `npm run verify` ALL GREEN, with Gate 1.16
      (`scripts/check-artifacts.mjs`) green and unchanged.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS.md #6): the integrate
      section (`:97-131`) documents the verify-when-recorded contract including the
      since-ingest honesty boundary; the Gate 1.5 and Gate 1.6 sections describe the
      new faces; the store-header scoping paragraph is noted where the T-016 case is
      described. Ticket status + index updated in the same change.

## Verification

Gate 0 (`npm run typecheck`) and Gate 1 (`npm run demo`) always; the fast tier
(`npm run verify`) carries the extended Gate 1.5 integrate faces and Gate 1.6 store
faces — all token-free. **Gate 2 not owed and not run**: the trigger list
(VERIFICATION.md:2052-2053 — `src/runner.ts`, adapters, gates, workspace handling,
report shape) is untouched; `src/integrate.ts` is none of those and no report shape
changes — the same analysis as T-005:222-227 and T-016:167-172. Gate 0.5 n/a
(`src/parse.ts` untouched); Gate 3 n/a (no adapter — zero model involvement).

Baseline this session, on clean main at d3e4d97: `npm run typecheck` → exit 0 (Gate
0); `node node_modules/tsx/dist/cli.mjs scripts/check-store.mjs` → exit 0 (Gate 1.6,
only Known issue #7's node:sqlite ExperimentalWarning); `node
node_modules/tsx/dist/cli.mjs scripts/check-artifacts.mjs` → exit 0 (Gate 1.16). Not
run this session: Gate 1 demo and the full fast tier; Gate 2 not owed per above.
