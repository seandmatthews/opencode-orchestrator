# T-057 — Duplicate gate names refused at parse time: the store's last-write-wins can no longer drop gate evidence (register R7a)

**Status:** done 2026-10-26
**Category:** engine
**Value (1-5):** 2 · **Risk (1-5):** 1
**Depends on:** —

## What

`gate_results` is keyed `(run_id, candidate_id, gate_name)` with an upsert
(`src/store/index.ts:122-131`, :1357-1370), and NOTHING refuses duplicate
gate names: `parseJobsSpec` enforces unique probe ids but never gate names
(`src/scheduler.ts:236-245` — no `seen` set, unlike probes at :249-257),
and the run-level `--gate` flag accepts repeats unchecked
(`src/cli.ts:291-296`). A spec or CLI invocation with two gates named
`build` records both in report.json but the store keeps only the LAST —
if the first failed and the second passed, the durable record shows an
all-pass gate table for an eliminated candidate: evidence loss via
last-write-wins, invisible to the dashboard and to every later reader.
The ladder itself is unaffected (it reads the in-memory array), which is
exactly why the divergence between report and store went unnoticed.

The change — refusal at both parse sites, the zero-side-effects pattern
(refusal before the checkout lock, repo validation, or any artifacts dir):

1. `parseJobsSpec`: per-job gate names must be unique — a `seen` set, the
   probe-id precedent verbatim, refusing with the message naming the job
   and the duplicated name.
2. `parseArgs`: repeated `--gate` names refuse at parse time, naming the
   duplicate. (Integrate's `gateContract` already matches gates by name —
   duplicates were already unrepresentable there; refusal upstream is the
   honest fix.)

Intentional-shape check the implementer must record: no existing fixture,
spec, or check in the repo uses duplicate gate names (assert during the
red-bar leg — if one does, this ticket's premise is wrong and the lane
stops for review rather than "fixing" the fixture).

## Why

The cheapest class of silent evidence loss in the store, closed by the
same parser-refusal pattern the repo already uses for probe ids, worker
ids, and flag pairing. R7's disposition listed this sub-item as the
parser-refusal piece of the store-gaps ticket-later; it is small enough to
land on its own.

## Acceptance criteria

- [x] **Red bar recorded first** (AGENTS #8), token-free: a `--jobs` spec
      with two gates named `build` on one job PARSES on main (asserted as
      the red bar); repeated `--gate "a=…" --gate "a=…"` parses on main
      too. Ingest divergence shown once for the record: the same-named
      pair upserts to one `gate_results` row (the loss, demonstrated).
- [x] Green, spec: the same spec post-change refuses at parse time with
      the job name + duplicated gate name, zero side effects (no artifacts
      dir, no lock) — pinned by the new fast-tier check.
- [x] Green, CLI: repeated `--gate` names refuse at parse time — pinned
      by the same check.
- [x] Distinct names unaffected: every existing spec/check fixture
      (unique-named gates) parses byte-identically — pinned by the full
      fast tier riding green unchanged.
- [x] The intentional-shape check's result (no fixture used duplicates)
      recorded in the ticket's Landed.
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6) — pinned
      by the full fast tier ALL GREEN.
- [x] **Gate 2 not owed** (parser refusals + docs only — no runner,
      adapter, or report-shape change; trigger analysis recorded per the
      T-041 precedent). **Gate 3 n/a.**

## Landed

2026-10-26, Gate 1.43 (`scripts/check-duplicate-gates.mjs`, wired into
`scripts/verify.mjs` fast tier after Gate 1.42).

- `src/scheduler.ts` (`parseJobsSpec`): per-job gate names are unique — a
  `seenGates` set inside the gates map, the probe-id precedent verbatim
  (`seenProbes` one block below), refusing with
  ``job '<id>' has duplicate gate name '<name>' — gate names must be
  unique per job``. The parser's doc comment lists the new refusal among
  its strict-parse contract.
- `src/cli.ts` (`parseArgs`, the `--gate` case): a repeated `--gate` name
  refuses at parse time — ``duplicate --gate name '<name>' — gate names
  must be unique per run (the store keeps one verdict per name; every
  verdict but the last would be silently dropped)`` — before repo
  validation, the checkout lock, or any artifacts dir (the
  --max-attempts zero-side-effects parse-refusal pattern). The usage text
  for `--gate` states "repeatable with UNIQUE names" (the
  --rounds/--worker-machine documentation precedent). Nothing else in the
  CLI changed: `distinctGatesFor`'s name+command dedup is untouched and
  remains meaningful in --jobs mode (two jobs may each carry a `build`
  with different commands — per-job uniqueness, the store keys rows per
  candidate).
- Intentional-shape check (asserted during the red-bar leg, per the
  ticket's What): NO fixture, spec, or check in the repo used duplicate
  gate names — the premise held. Two scans + the executed half: (a) every
  `.json` file in the repo (excl. node_modules/package-lock) walked for
  any `gates` array with a repeated name — none; the only gates-carrying
  fixture is `scripts/fixtures/report-real.json` (c01/c02: build+test,
  unique). (b) every literal `--gate NAME=` in scripts/, src/, docs/,
  README.md, AGENTS.md scanned per line — no repeated name (multi-flag
  sites are one-line: verify.mjs CLI_GATES check-a/check-b,
  check-baseline-gate.mjs build/test, README/AGENTS build/test); the
  T-057 ticket file itself was excluded — it quotes the red-bar example.
  (c) the full fast tier riding green executes every check script's
  inline specs through the new refusal — all still parse.
- `scripts/check-duplicate-gates.mjs` (new, Gate 1.43, 18 assertions):
  leg A — the duplicate-`build` spec refuses at parse time naming
  ``job 'j1'`` and `'build'`; uniqueness is PER JOB (two jobs each
  carrying a `build` parse unchanged); unique-named gates parse
  byte-identically to main's output; distinct names sharing one command
  parse unchanged; the duplicate-probe-id refusal is unmodified. Leg B —
  the CLI faces: repeated `--gate` names and the duplicate-gate `--jobs`
  spec both refuse exit 1 through the real CLI, naming the offense,
  BEFORE repo validation (deliberately-absent `--repo` — a parse-pass
  would surface the repo error, the recorded red-bar contrast), zero
  side effects (no artifacts dir, no lock under the sandbox run root);
  control faces pin the preserved path (distinct names / unique spec
  parse past to the repo error). Leg C — the loss mechanism once for the
  record: ingest of build(fail)+build(pass) upserts to ONE
  `gate_results` row carrying the LAST verdict (the store is unchanged;
  the engine can no longer produce such a report).
- VERIFICATION.md: new Gate 1.43 section (the loss site, both refusal
  sites, the three legs, the recorded red bar, the intentional-shape
  scan, required-when).
- Non-goals kept: no store schema/upsert change (refusal upstream, the
  ticket's stated shape); integrate.ts untouched (gateContract matches
  by name — duplicates already unrepresentable there; the run CLI refusal
  is the honest fix); no decisions.md change; no ride-alongs.

Gates measured: red bar recorded FIRST on main (a read-only probe
importing main's `src/scheduler.ts` + `src/store/index.ts` and driving
main's CLI as a subprocess, before this change-set existed):
the duplicate-`build` spec PARSED (both gates returned:
`[{"name":"build","command":"node build.js"},{"name":"build","command":"node
test.js"}]`); repeated `--gate "a=…" --gate "a=…"` PARSED — the CLI failed
later, at repo validation (`--repo '…' is not a git repository with at
least one commit`), not at parse; ingest of build(fail)+build(pass) left
ONE row `{"gate_name":"build","passed":1,"exit_code":0,"output_tail":"second
passed"}` — the first-failure evidence gone. Post-change:
`node node_modules/tsx/dist/cli.mjs scripts/check-duplicate-gates.mjs`
ALL GREEN (18 assertions); full fast tier `node scripts/verify.mjs fast`
ALL GREEN, exit 0 — Gate 0, Gate 1, Gate 0.5, Gates 1.5–1.43 green in the
same pass.

Gate 2 trigger analysis (the ticket's criterion): the standing trigger
("Required when touching `src/runner.ts`, any adapter, gates, workspace
handling, or anything that changes report shape") does NOT fire — no
runner, adapter, gate-execution, workspace, or report-shape code changed;
the change is two parse-time refusals (both sites run before any side
effect) plus docs. The refusal paths are pinned token-free by Gate 1.43's
CLI faces (real subprocess, exit codes, messages, side-effect absences),
and every previously-parsing invocation with unique gate names is pinned
byte-identical by the same check plus the full fast tier. **Gate 2 not
owed. Gate 3 n/a** (no adapter change).

## Verification

New fast-tier check Gate 1.43: both red bars (recorded on main),
the ingest-divergence demonstration, both refusals green (spec + CLI),
zero-side-effects assertions, control faces for the preserved path.
Gate 0, full fast tier ALL GREEN; Gate 2 not owed (trigger analysis in
Landed); Gate 3 n/a.

## References

src/store/index.ts:122-131, :1357-1370 (the key + upsert — the loss site) ·
src/scheduler.ts:236-257 (gates without the seen set; probes with it — the
precedent) · src/cli.ts:291-296 (the run-level repeat), :314-316 (the
parse-refusal pattern) · src/integrate.ts:147-169 (name-keyed contract —
duplicates already unrepresentable) · docs/adversarial-review-2026-10-23.md
R7 (the parent disposition; this ticket closes sub-item (a)).
