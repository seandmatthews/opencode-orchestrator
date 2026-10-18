# T-019 — Screenshot artifact probe: capture-command → validated image EvidenceBundle (spec §34:2069, §12)

**Status:** done 2026-10-17
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** T-015 (done 2026-10-17 — the Probe seam + EvidenceBundle contract this extends). **T-016 (done 2026-10-17, as this ticket's ordering note anticipated) is an ordering note, not a build dependency**: `probe_runs`/`ARTIFACT_CREATED` persistence is T-016's claim (T-016:29-32) and it explicitly carves screenshot probes out as *consumers* of that substrate (T-016:82-84); `ProbeRunSummary` (src/types.ts:279-285) is type-agnostic, so a screenshot bundle persists through it unchanged whenever it lands — this ticket touches no store code. **T-018 (done 2026-10-17 — landed first) was a coordination note, not a dependency, and it resolved as written**: both tickets flip the same pin, scripts/check-probe.mjs:291-292; this ticket landed second and adjusted both the refusal message and the unknown-type example (T-018's `'screenshot'` example became `'godot'` — see Landed).

## What

Stage-4 remainder, the last generic probe of Milestone 4's start list with neither
ticket nor code (§34:2066-2069 — command, test, benchmark, screenshot: command+test
landed T-015, benchmark is ticketed T-018, screenshot is this ticket, which T-015:93
explicitly carved). The spec defines **no Screenshot Probe** — screenshots appear only
as capabilities of the Godot probe (§12.1:919) and Web probe (§12.1:931), and §6.8:479
names `screenshot` as an Artifact example — so the semantics below are
chosen-and-documented in the module docblock (the T-007/T-012/T-013/T-018 precedent).
It is the first probe whose evidence is **directly human-reviewable** (an image a
person opens from the run dir), and the base the Godot/Web/Blender probes build on
(§12.1:911-947).

1. **`src/probe.ts` — `ProbeType` gains `'screenshot'`** (today exactly
   `'command' | 'test'`, src/probe.ts:66; the docblock at :64-65 still calls
   screenshot a successor slice — it updates). **`EvidenceArtifactKind` gains
   `'screenshot'`** — the vocabulary growth the :68-71 docblock explicitly
   reserved until a producer exists; this probe is its first producer (`log`
   is produced by command/test, `report`'s first producer is T-018's).
   - `ScenarioSpec` gains `capture?: string` (src/probe.ts:76-84) with a docblock
     contract: **required, non-empty, workspace-relative path when
     `type: 'screenshot'`** — it names the file *inside the disposable workspace*
     that the capture command must have written by the time it exits; absolute
     paths and any `..` segment are refused (the evidence contract stays local to
     the worktree; the durable copy is the probe's job, not the command's).
     **Refused on every other probe type** (the T-018 `repeats` precedent: the
     field exists only where it means something).
   - **`ScreenshotProbe implements Probe`** (new class beside CommandProbe/
     TestProbe): runs the scenario's capture command **once** through the landed
     `executeProbeCommand` (src/probe.ts:295-351 — list-form `spawn`, AGENTS.md #4,
     one full `timeoutMs` budget, default `DEFAULT_PROBE_TIMEOUT_MS`, src/probe.ts:146,
     the T-011 verified tree kill at expiry, src/probe.ts:338-349 — **no second spawn
     path is forked**). The seam runs ONE command to completion/timeout: there is no
     target-lifecycle concept and no "capture at a given point" — **launch, timing,
     and readiness are encapsulated inside the operator's capture command** this
     slice (a command serving a URL then screenshotting, or an inbox-OS screen
     capture, are both just commands).
   - **Success semantics**: `success` = command exit 0 **AND** the `capture`-named
     file exists **AND** is at least a documented size floor (the ticket names the
     defensible minimum — 33 bytes, the smallest syntactically-possible PNG: 8-byte
     magic + one 25-byte IHDR chunk; the exact constant is fixed in the change-set
     and pinned by the gate) **AND** starts with the 8-byte PNG magic
     (`89 50 4e 47 0d 0a 1a 0a`) — **PNG-only this slice**, documented. A zero-byte,
     missing, truncated, or non-PNG image is `success: false`, **never a pass**
     (AGENTS.md #7 applied to image evidence — the T-015 posture, T-015:57-58).
     `EvidenceBundle.error` names the first failed face (spawn refused / timed out /
     exit N / capture file missing / below floor / bad magic).
   - **The durable copy is the point**: on success the image is **copied** to
     `<artifactsDir>/probes/<candidateId>/<probeId>.png` (the `logArtifact`
     pattern, src/probe.ts:369-380) and referenced as a kind-`'screenshot'`
     `EvidenceArtifactRef`. This is not cosmetic: the workspace is disposed
     immediately after the attempt loop (src/runner.ts:591-598), so an image left
     at its scenario-named path inside the worktree would be **destroyed** — the
     module docblock's durable-copy rule (src/probe.ts:88-93, decisions.md:25-26
     run root `C:\swarm\`) is exactly this.
   - **Measurements** (the landed `Measurement` type, src/probe.ts:123-128 — no
     contract change): `capture duration` (unit `'ms'`, the GateResult's
     `durationMs` — recorded whenever the command actually ran) and `image bytes`
     (unit `'bytes'`, recorded whenever the capture file exists — even on
     success:false faces; evidence about failures is evidence). Dimensions and any
     pixel-content assertion are carved (see Does NOT claim).
   - **`gateResults`: one `GateResult` entry** (the landed `toGateResult` shape,
     src/probe.ts:353-367; `cleanupFailures` on unproven kills — evidence only).
   - **No verdict input of any kind**: a `success:false` screenshot bundle changes
     nothing downstream — the ladder (src/runner.ts:544,
     `passedAllGates = gates.length > 0 && every passed && diffBytes > 0`) is
     untouched by construction; this ticket edits no runner code (decisions.md:19-21).
   - `createProbe` gains the screenshot branch (today binary, src/probe.ts:516-520);
     its docblock updates.
2. **`src/scheduler.ts` — one validation surface** (`parseJobsSpec`'s probes map,
   src/scheduler.ts:183-212): the type refusal at :192-194 becomes
   `type must be "command", "test", ... "screenshot"` (exact wording coordinated with
   T-018, see the flip below); the allowed probe-field list at :186 gains `capture`;
   shape validation: `capture` required non-empty relative path on `screenshot`
   (missing, empty, non-string, absolute, and `..`-segment — all refused naming the
   offense), **refused on `command`/`test`/`benchmark`** probes. The parsed spec
   carries `capture` only on screenshot probes.
3. **`scripts/check-probe.mjs` — Gate 1.15 extended in place** (no new gate number;
   no collision with T-016's claimed 1.16, T-016:157-162, or T-017's claimed 1.17,
   T-017:66-70):
   - **Two mandatory flips (AGENTS.md #8), recorded here as this change-set's only
     intentional invalidations of existing assertions:**
     (a) Gate 1.15's P2 leg **actively pins the type refusal message** today
     (scripts/check-probe.mjs:291-292, `type must be "command" or "test"`); this
     change-set invalidates it. The flip becomes positive coverage (a screenshot
     probe with `capture` parses and is preserved verbatim) **plus** refusal of a
     genuinely-unknown type with the updated message. **T-018 coordination**:
     T-018's flip uses `'screenshot'` as its unknown-type example (T-018:92) —
     whichever of the two tickets lands second adjusts **both** the message and
     that example to a type that is still unknown at its landing (e.g. `'godot'`).
     (b) Gate 1.15's P1 leg pins the artifact-kind refusal message
     (scripts/check-probe.mjs:247-250, `kind must be "log" or "report"`, pinning
     the validator check at src/probe.ts:170-172); the message gains
     `"screenshot"` and the leg gains positive coverage — a well-formed bundle
     carrying a kind-`'screenshot'` artifact **validates**. Net strictness
     increases in both flips (refusal loosened in one dimension, that dimension
     now positively exercised); no other existing assertion is weakened
     (the T-013 flip precedent).
   - New **P2** legs: `capture` validation (missing on screenshot; `''`; absolute;
     `..` segment; non-string; present on a `command`/`test` probe).
   - New **P3** direct-execution legs, token-free (the demo-fixture pattern,
     scripts/check-probe.mjs:310-347): the capture target is a **checked-in tiny
     valid PNG under `scripts/fixtures/`** (today holding only report-real.json) —
     each leg's capture command copies it to the scenario-named path (list-form,
     e.g. a `node -e` copy) so no capture technology is a dependency of any pin.
     Happy path: success true; the image artifact is kind `'screenshot'`, lives at
     `<artifactsDir>/probes/<candidateId>/<probeId>.png`, sizeBytes equals the
     source's, the PNG magic is re-verified **on the copied file**, both
     measurements are present, and the bundle passes `validateEvidenceBundle`.
     Failure faces, each `success: false` **never a pass**: capture command exits
     non-zero (exit-code evidence in the GateResult); writes a **zero-byte** file;
     exits 0 having written **nothing** (missing capture file); writes a
     **magic-less** file (error names the bad magic); non-existent exe (spawn
     error, no image artifact beyond the `.log`). Timeout face (the P4 sleeper
     pattern with its process-table assertions and sweep fallback,
     scripts/check-probe.mjs:414-438): exitCode null, durationMs ≥ timeoutMs, the
     spawned tree **verified dead on the real process table**, kill evidence on
     the GateResult entry — the tree kill is what reaps a launched server at
     timeout.
   - **P5** e2e: a `--jobs` drive carrying a screenshot probe asserts the
     `probes[]` ↔ `bundlePath` correspondence for it (bundle on disk,
     validator-clean, success agreeing with the summary), that the image artifact's
     path is under the artifacts dir **never inside the worktree** and exists on
     disk at report time (the durable copy is structural — it happens inside
     `run()`, before dispose at src/runner.ts:591-598), and that survival is
     untouched (a passing-gates/failing-screenshot job still **passes**), extending
     the existing drive (scripts/check-probe.mjs:441-521).
4. **Docs in the same change-set** (AGENTS.md #6): VERIFICATION.md's Gate 1.15
   section (the type list at VERIFICATION.md:1000; the carve list at :1054-1055
   drops screenshot — it moves from carved to pinned, with the new legs named);
   docs/ROADMAP.md:16's stage-4 row; README's `--jobs` probes doc
   (README.md:129-137 — the type list gains `"screenshot"` and `capture`).

**Does NOT claim:** **`probe_runs`/`ARTIFACT_CREATED` persistence** (T-016's claim,
T-016:29-32, :62-69 — the idea's "via T-016" half is already owned there; clean
handoff, no store work duplicated here); **probe-side target lifecycle** — launch
target, poll URL/readiness, mid-run capture at a given point, teardown (the
Web/Godot probes' §12.1:911-947 territory; today the capture command encapsulates
it and the one-command seam shape is unchanged); **image-content assertions** —
dimension parse, pixel comparison, contact sheets, video (§6.8:480-481); non-PNG
formats; any **measurement→verdict bridge** (T-018:124-128's carve stands; gates
decide survival, decisions.md:19-21); the §13:986-996 project-manifest `probes:`
block; run-level `--probe` CLI flags; and Sol-verifier/UI consumption (stage 5 and
7, docs/ROADMAP.md:17,:19 — until then the consumer is a human opening the PNG).

## Why

The spec puts `screenshot artifact probe` in Milestone 4's start list (§34:2069) and
every landed slice has re-carved it: T-015:93 ("Does NOT claim: ... screenshot-
artifact probe (§34:2068-2069)"), T-016:82-84, T-017:40 — and docs/ROADMAP.md:16
lists "benchmark/screenshot probes" as stage-4 remaining. The gap is real and
grep-verified (scout, this session): a grep for `screenshot` over `src/`,
`scripts/`, `package.json`, `README.md` returns exactly two hits, both docblock
placeholders — src/probe.ts:65 (the successor-slice docblock) and src/probe.ts:68
(the §12.1 vocabulary note). It is the only start-list item with neither ticket nor
code.

The substrate makes this a small additive slice and the hard parts are already
landed: the Probe seam and validated-then-written bundle emission
(src/probe.ts:103-111, :244-253), the list-form spawn + verified-tree-kill execution
core (src/probe.ts:277-286, :295-351), the artifacts-dir evidence writer
(src/probe.ts:369-380), a **type-agnostic pipeline** — `runProbes` iterates
`job.probes` with no type switch (src/runner.ts:617-646, driven at :554-556) and
`ProbeRunSummary` is type-agnostic (src/types.ts:279-285) — so the change-set needs
**zero edits to src/runner.ts and src/cli.ts**.

**Feasibility, run this session (scout + this writer):** a list-form `powershell.exe`
spawn using inbox .NET assemblies (System.Windows.Forms + System.Drawing
`CopyFromScreen`) captured this machine's 5120x1440 virtual screen to valid PNGs
(magic bytes verified; both temp files deleted) — a **zero-new-dependency** capture
path exists on this interactive-desktop box (decisions.md:6-10; no
puppeteer/playwright/screenshot-desktop). Headless/session-0 behavior is
**UNCONFIRMED** and window-specific (vs whole-screen) capture is untested — stated,
not smoothed: the probe records what the operator's command produced, so no capture
technology is a dependency of any pin; the gate's token-free legs use the
checked-in fixture PNG. `node` v22.23.1 exposes `zlib.crc32`/`deflateSync`
(checked via `node -p`, this session) if the implementer prefers synthesizing the
fixture at authoring time over checking one in.

**Honest tension (stated, not smoothed — the T-018:156-166 pattern):** the bundle is
consumerless machinery until T-016 lands, and the built-in consumers are far off
(Sol-class verifiers are stage 5, the UI is stage 7 — docs/ROADMAP.md:17,:19).
Today's payoff is human eyes on the PNG under `C:\swarm\<runId>\probes\` plus the
foundation the Godot/Web/Blender probes (§12.1:911-947) build on. Hence Value 3
standalone; sequenced after T-016 it trends 4, when screenshots become addressable
`probe_runs` rows with hashed artifacts. The spec defines no screenshot semantics at
all, so PNG-only + capture-field + size-floor + magic-check is the documented
choose-and-document move — and the gate, not the docblock alone, pins it.

Pre-change state, run this session at HEAD `04d5879` (clean tree; `git diff --stat
8d4e1e2..HEAD` shows only T-018's two ticket docs, so probe/scheduler/check-probe
code is byte-identical to the state T-018's scout measured): Gate 0
`npm run typecheck` → **exit 0**. Full fast tier `npm run verify` → **first run:
Gate 1.12 S4 flaked, 3 of 30 checks failed** (S4 kill-verification timing: the
tree-dead assertions passed but the verified-kill evidence lines lost a race);
direct re-run of `node node_modules/tsx/dist/cli.mjs scripts/check-kill-tree.mjs` →
**ALL GREEN, exit 0**; second full `npm run verify` → **exit 0, "verify (fast)
complete: ALL GREEN"** (764 `ok:` lines, including Gate 1.15 "check-probe: ALL
GREEN"). The S4 flake is recorded here for honesty (AGENTS.md #9) — if it
reproduces during implementation, it belongs in VERIFICATION.md's Known issues, not
tribal memory.

## Acceptance criteria

- [x] `ProbeType` includes `'screenshot'`; `ScreenshotProbe` exists behind the
      landed Probe seam with the documented contract above (required relative
      `capture` on screenshot and refused elsewhere; one `executeProbeCommand`
      execution with the full timeout budget and the T-011 verified tree kill;
      success = exit 0 AND file present AND ≥ the documented size floor AND PNG
      magic; the image **copied** under `<artifactsDir>/probes/<candidateId>/` as a
      kind-`'screenshot'` ref; zero-captured-images never a pass; **no target
      lifecycle, no threshold field, no verdict input**); zero model/harness
      knowledge in the module (decisions.md:11-15) — pinned by **Gate 0**
      (`tsc --noEmit`) plus the **Gate 1.15 P3** contract legs.
- [x] The parser accepts a screenshot probe with `capture` verbatim and refuses: a
      genuinely-unknown type with the updated message; missing/empty/non-string/
      absolute/`..`-segment `capture` on a screenshot probe; `capture` on a
      `command`/`test` probe — pinned by **Gate 1.15 P2** (contract fixtures over
      `parseJobsSpec`, token-free).
- [x] **Both flips are explicit in this change-set** — scripts/check-probe.mjs:291-292
      (coordinated with T-018: message + unknown-type example) and the :247-250
      artifact-kind message (gaining `"screenshot"` plus positive coverage) —
      recorded here as the change-set's only intentional invalidations of existing
      assertions; no other existing check is weakened — pinned by the full fast
      tier, **`npm run verify` ALL GREEN** with the flipped Gate 1.15.
- [x] Happy path, token-free: the capture command copies the checked-in fixture PNG
      (under `scripts/fixtures/`, added by this change-set, magic-valid, above the
      floor) to the scenario-named path → success true; a `'screenshot'`-kind image
      artifact at `<artifactsDir>/probes/<candidateId>/<probeId>.png` with
      sizeBytes equal to the source and the magic re-verified on the **copy**;
      `capture duration` + `image bytes` measurements present; the bundle passes
      `validateEvidenceBundle` — pinned by **Gate 1.15 P3**.
- [x] Failure faces, each `success: false` never a pass: non-zero exit; zero-byte
      capture file; missing capture file at exit 0; magic-less file (error names
      the face); non-existent exe (spawn error, no image artifact); a timing-out
      capture → exitCode null, durationMs ≥ timeoutMs, the spawned tree verified
      dead on the real process table, kill evidence on the GateResult entry —
      pinned by **Gate 1.15 P3** (timeout leg per the P4 process-table pattern,
      scripts/check-probe.mjs:414-438; AGENTS.md #7 applied to image evidence).
- [x] Evidence emission in a real pipeline: a `--jobs` run carrying a screenshot
      probe writes its bundle under `<artifactsDir>/probes/<candidateId>/`, the
      report's `probes[]` names its `bundlePath` and agrees with the bundle, the
      image artifact's path is under the artifacts dir **never inside the
      worktree** and the file exists on disk at report time, and survival is
      untouched by the screenshot outcome (a passing-gates/failing-screenshot job
      still passes) — pinned by **Gate 1.15 P5** (the fake-WorkerAdapter
      `runSkeleton` drive).
- [x] Zero runner/CLI/report-shape drift: no `src/runner.ts` or `src/cli.ts` edits
      (the pipeline is type-agnostic, src/runner.ts:554-556, :617-646);
      `CandidateReport.probes`/`ProbeRunSummary` shapes unchanged (src/types.ts:
      279-285); the verdict ladder byte-identical (src/runner.ts:544) — pinned by
      **Gate 0** plus the change-set file list (`git status --porcelain` /
      `git diff --stat`: exactly `src/probe.ts`, `src/scheduler.ts`,
      `scripts/check-probe.mjs`, the new `scripts/fixtures/` PNG,
      `VERIFICATION.md`, `docs/ROADMAP.md`, `README.md`, the ticket file + index).
- [x] No new npm dependencies (decisions.md:6-10); the capture command runs as a
      list-form spawn through `executeProbeCommand` (never `exec`, never a second
      spawn path) — pinned by **Gate 0** and the package.json/package-lock.json
      diff-free change-set.
- [x] Docs extended in the same change-set: VERIFICATION.md's Gate 1.15 section
      (type list :1000, carve list :1054-1055, new legs), docs/ROADMAP.md:16's
      stage-4 row, README's `--jobs` probes doc (README.md:129-137) — pinned by
      **`npm run verify` ALL GREEN** with the updated sections present.
- [x] **Gate 2 NOT owed — recorded, not silently skipped** (the T-018:223-228
      trigger-analysis precedent): the change-set touches no `src/runner.ts`, no
      adapter, no gate code, no workspace handling, and no report shape — none of
      VERIFICATION.md:1097-1098's triggers; Gate 2 is additionally a `--goal`-mode
      run that executes no probe code (VERIFICATION.md:1008-1010), so it could not
      pin any screenshot criterion anyway. **Gate 3 n/a** (no adapter touched).

## Verification

**Gate 0** (typecheck) throughout; **Gate 1.15 extended in place** — this ticket
claims **no new gate number** (no collision with T-016's claimed 1.16 or T-017's
claimed 1.17) and extends the probe gate's existing legs: P1 kind leg (the :247-250
flip), P2 parser legs (the :291-292 flip + `capture` validation), P3
direct-execution screenshot legs (happy/failure faces/timeout with the
process-table assertions), P5 e2e correspondence leg; the whole existing fast tier
stays green (`npm run verify`) — the two flipped assertions are named in the
criteria, nothing else weakened. Gate 1 (fixture regeneration) untouched and green
inside the tier. **Gate 2 not owed** per the recorded trigger analysis above;
**Gate 3 n/a** (no adapter).

## References

docs/spec/inference-refinery-v2.md §34:2066-2069 (Milestone 4 start list;
`screenshot artifact probe` at :2069), §12.1:911-947 (Godot/Web/Blender — the
successors this is the base of; screenshots as their capabilities at :919 and
:931), §12:879-967 (Probe seam + output contract), §6.8:479-481 (screenshot/
contact-sheet/video artifact examples) · docs/tickets/T-015-probe-layer-first-slice.md:93
(the carve this fills), :57-58 (AGENTS #7 applied to bundles) ·
docs/tickets/T-016-filesystem-artifact-store.md:29-32, :62-69, :82-84, :157-162
(`probe_runs`/`ARTIFACT_CREATED` ownership, the consumers carve, the Gate 1.16
claim) · docs/tickets/T-017-machine-worker-adapter.md:40 (re-carve), :66-70
(Gate 1.17 claim) · docs/tickets/T-018-benchmark-probe.md:92 (the unknown-type
example this ticket's landing must re-adjust), :124-128 (measurement→verdict
carve), :156-166 (honest-tension pattern), :223-228 (trigger-analysis pattern) ·
docs/decisions.md:6-10 (zero-new-deps), :11-15 (harness-agnostic seams), :19-21
(gates decide survival), :25-26 (run root C:\swarm) · docs/ROADMAP.md:16 (stage-4
remaining), :17,:19 (consumer stages) ·
src/probe.ts:64-71, :76-84, :88-93, :123-128, :146, :166-176, :244-253, :277-286,
:295-351, :338-349, :353-367, :369-380, :516-520 · src/scheduler.ts:186, :192-194 ·
src/runner.ts:544, :554-556, :591-598, :617-646 · src/types.ts:279-285 ·
scripts/check-probe.mjs:247-250, :291-292, :310-347, :414-438, :441-521 ·
VERIFICATION.md:977-1071 (Gate 1.15; type list :1000, carve :1054-1055),
:1008-1010 (Gate 2 exercises no probe code), :1097-1098 (Gate 2 triggers) ·
README.md:129-137 · scripts/fixtures/ (holds only report-real.json today — the
checked-in fixture PNG lands here in this change-set).

## Landed

2026-10-17, lane branch `ticket/T-019-screenshot-probe`.

What changed:

- **`src/probe.ts`** — `ProbeType` gains `'screenshot'`; `EvidenceArtifactKind`
  gains `'screenshot'` (this probe is the kind's first producer — the
  docblock's reserved vocabulary growth); `ScenarioSpec` gains `capture?:
  string` carrying the required-non-empty-workspace-relative contract in its
  docblock; the module docblock gains the screenshot-semantics block (the
  spec defines no Screenshot Probe — chosen and documented: PNG-only, the
  one-command seam with no target lifecycle, the size floor, the magic
  check, the durable-copy rule, measurement policy, no verdict input). New
  exported constants `MIN_PNG_BYTES = 33` (the smallest
  syntactically-possible PNG: 8-byte signature + one 25-byte IHDR chunk;
  checked BEFORE the signature, per the documented error-face order) and
  `PNG_MAGIC` (the 8-byte signature), both pinned by the gate. New
  `ScreenshotProbe implements Probe`: one `executeProbeCommand` execution
  (list-form spawn, full `timeoutMs` budget, the T-011 verified tree kill —
  no second spawn path); success = exit 0 AND the capture file exists AND is
  ≥ 33 bytes AND starts with the PNG magic; `error` names the FIRST failed
  face (spawn refused / timed out / exit N / capture file missing / below
  floor / bad magic); on success the image is COPIED to
  `<artifactsDir>/probes/<candidateId>/<probeId>.png` and referenced as a
  kind-`'screenshot'` artifact (the durable copy is structural — the
  workspace is disposed right after the attempt loop); measurements
  `capture duration` (ms, whenever the command actually ran — a spawn
  refusal produced no run) and `image bytes` (bytes, whenever the capture
  file exists, even on success:false faces); one GateResult entry; a
  directly constructed scenario without a valid `capture` is refused by the
  class itself (thrown, recorded through the runner's `failedBundle` path).
  The bundle validator's kind refusal now reads `kind must be "log",
  "report", or "screenshot"` (flip b). `createProbe` gains the screenshot
  branch (docblock updated).
- **`src/scheduler.ts`** — the `parseJobsSpec` probes map: `capture` joins
  the allowed probe-field list; the type refusal now reads `type must be
  "command", "test", "benchmark", or "screenshot"` (flip a); `capture`
  required non-empty workspace-relative on a screenshot probe (missing /
  empty / non-string / absolute — drive-letter, backslash, and UNC forms
  via `win32.isAbsolute` regardless of host OS — and `..`-segment all
  refused naming the offense) and refused on command/test/benchmark probes;
  the parsed spec carries `capture` only on screenshot probes.
- **`scripts/check-probe.mjs`** (Gate 1.15 extended in place — no new gate
  number, no collision with 1.16/1.17): BOTH flips executed as named in the
  criteria — (a) the :291-292 unknown-type example `'screenshot'` (T-018's
  landing) became `'godot'`, a type still unknown at this landing, with the
  updated message, plus positive coverage (a screenshot probe with
  `capture` parses and is preserved verbatim); (b) the artifact-kind pin
  gained `"screenshot"` plus positive coverage (a well-formed bundle
  carrying a kind-`'screenshot'` artifact validates). New P2 `capture`
  legs (missing/''/non-string/absolute ×3 forms/`..`-segment on screenshot;
  `capture` on command/test/benchmark). New P3 screenshot direct-execution
  legs, token-free, every capture target the checked-in fixture PNG
  (`scripts/fixtures/tiny-1x1.png`, added by this change-set — 67 bytes,
  chunks IHDR(13)/IDAT(10)/IEND(0), CRC-verified and magic-verified at
  authoring time, above the floor; each capture command copies it into the
  workspace list-form): the fixture itself pinned magic-valid + above
  floor; happy path (capture into a workspace-relative subdir → success
  true, one GateResult, both measurements, the kind-`'screenshot'` copy at
  `<artifactsDir>/probes/<candidateId>/<probeId>.png` with sizeBytes equal
  to the source and the magic re-verified ON THE COPY, validator-clean);
  failure faces non-zero exit / zero-byte / missing-at-exit-0 / magic-less
  (64 bytes) / spawn-refused / no-`capture`-class-refusal, each success
  false never a pass with the measurement policy pinned per face; the
  timeout face per the P4 sleeper pattern (error names the timeout,
  exitCode null, durationMs ≥ timeoutMs, capture duration still recorded,
  the spawned tree verified dead on the real process table, kill evidence
  on the GateResult). The P5 drive extended — a PASSING screenshot probe
  on job-a and a FAILING one (exit 7) on job-b, pinning the probes[] ↔
  bundlePath correspondence, validator-clean bundles, the image artifact at
  exactly `<artifactsDir>/probes/<candidateId>/<probeId>.png` — under the
  artifacts dir, NEVER inside the candidate worktree (pinned against the
  report's `workspacePath`) — existing on disk at report time with source
  size + re-verified magic, and survival untouched by the screenshot
  outcome. One stale label corrected in the same edit (no assertion
  weakened): the P5 leg "a passing job with only passing probes" had been
  inaccurate since T-018 gave job-b a failing benchmark; it now reads "a
  passing job's probes[] record each outcome while survival stays
  untouched" (length pin 2 → 3, the passing-first-probe and
  passedAllGates pins kept). 79 assertions, 0 FAIL, zero model tokens.
- **`scripts/fixtures/tiny-1x1.png`** — the checked-in fixture PNG (67
  bytes; `.gitattributes` already carried `*.png binary` and
  `scripts/fixtures/** -text`, untouched).
- **`VERIFICATION.md`** — Gate 1.15 section: four generic probes, the
  `--jobs` probes shape with `capture` (required workspace-relative on
  screenshot, refused elsewhere), the screenshot-semantics paragraph, the
  recorded T-019 flips paragraph (both flips named), all three legs
  extended with the screenshot pins, and the carve list updated —
  screenshot moves from carved to pinned; Godot/Web/Blender (target
  lifecycle, readiness, mid-run capture), non-PNG formats, dimensions /
  pixel-content assertions, and probe-side target lifecycle are recorded
  as carves so they are neither silently assumed nor silently owed.
- **`README.md`** — the `--jobs` probes doc: type list gains
  `"screenshot"`, `capture` documented (required, workspace-relative, no
  absolute paths / `..`), PNG-only with the 33-byte floor and magic check,
  the durable copy to `probes/<candidateId>/<probeId>.png`, capture-command
  owns launch/timing/readiness, and the recording-not-judging posture.
- **`docs/ROADMAP.md`** — stage-4 row: screenshot probe landed (T-019),
  Gate 1.15 extended; remaining: Godot/Web/Blender.
- **`docs/tickets/`** — this ticket flipped to done with the boxes
  checked, index row updated, in the same change-set.

Change-set exactly as pinned (`git status --porcelain`):
`src/probe.ts`, `src/scheduler.ts`, `scripts/check-probe.mjs`,
`scripts/fixtures/tiny-1x1.png` (new), `VERIFICATION.md`,
`docs/ROADMAP.md`, `README.md`, this ticket + the index. Zero edits to
`src/runner.ts`, `src/cli.ts`, `src/types.ts`, `package.json`, or
`package-lock.json` — no runner/CLI/report-shape drift
(`CandidateReport.probes`/`ProbeRunSummary` untouched, the verdict ladder
byte-identical), no new npm dependencies, the capture command through the
landed list-form `executeProbeCommand` (never `exec`, never a second spawn
path).

Gates measured this session (lane, node v22.23.1, Windows):

- **Gate 0** `npm run typecheck` → exit 0.
- **Gate 1.15** `node node_modules/tsx/dist/cli.mjs scripts/check-probe.mjs`
  → **ALL GREEN, exit 0**, 79 `ok:` assertions (two red-then-fixed bars
  recorded honestly during iteration: a silent capture command produced a
  0-byte `.log`, so the leg's `sizeBytes > 0` sub-assertion failed — fixed
  by making the gate's own capture command print one line, not by weakening
  the assertion; and `copyCapture` was block-scoped to the P3 braces so the
  P5 drive crashed with a ReferenceError — hoisted to module scope).
- **Fast tier** `node scripts/verify.mjs fast` (Gate 0 + Gate 1, including
  the flipped Gate 1.15) → **"verify (fast) complete: ALL GREEN"**, 888
  `ok:` lines, run twice back-to-back (no S4 kill-verification flake
  reproduced; the flake the pre-change-state paragraph recorded remains a
  one-session observation, not a Known issue).
- **Gate 2 NOT owed** per the recorded trigger analysis in the criteria
  (no `src/runner.ts`, no adapter, no gate code, no workspace handling, no
  report-shape change; Gate 2 is additionally a `--goal`-mode run that
  executes no probe code). **Gate 3 n/a** (no adapter touched). **Gate 2
  was not run** — not skipped silently.
