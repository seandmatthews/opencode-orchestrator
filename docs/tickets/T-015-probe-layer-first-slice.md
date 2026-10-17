# T-015 — Probe layer first slice: Probe seam, EvidenceBundle contract, command + test probes (spec §12)

**Status:** proposed
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** T-009 (deterministic scheduler — landed 2026-10-16; the job model this wires into)

## What

The first slice of spec Milestone 4 (§34:2061-2072): the Probe seam and the structured
probe-output contract (§12.2), plus the two most generic probe types — **command probe**
and **test probe** — so candidate verification can grow beyond the operator's hand-typed
`--gate name=command` shell strings (src/cli.ts:148-154) into named, reusable,
evidence-emitting probes. Probes produce evidence artifacts; survival still belongs to
machine gates. Concretely:

1. **The seam + contract — new `src/probe.ts`**, beside Gate/WorkerAdapter in spirit
   (the T-012 pattern of a self-contained module with its own vocabulary):
   `Probe`, `ScenarioSpec`, `EnvironmentSpec`, `EvidenceBundle`, `Measurement`,
   `EvidenceArtifactRef`, a bundle validator, `CommandProbe`, `TestProbe`, and the
   evidence writer. The spec uses ScenarioSpec/EnvironmentSpec/Measurement/EvidenceBundle
   only as field types (§12:891-893, §12.2:956-963) and defines none of them — this
   ticket chooses and documents the vocabulary in a module docblock (the T-007:18-33 /
   T-012:21-30 / T-013:21-35 precedent). The three reconciliations it must state
   explicitly:
   - **ArtifactRef name collision.** §12.2's `artifacts: ArtifactRef[]` collides with the
     already-landed `ArtifactRef` of the context system (src/context.ts:158 —
     id/type/contentHash/sizeBytes/layer/estimatedTokens, a context-packet concept). The
     evidence vocabulary renames it **`EvidenceArtifactRef`** (`{name, path, kind,
     sizeBytes}` — a pointer at a file the probe captured under the run artifacts dir);
     src/probe.ts never imports from src/context.ts.
   - **WorkspaceLease divergence.** §16:1114-1123's lease (createdAt/expiresAt/
     retentionClass) is the worktree-GC slice's shape; the Probe input binds the repo's
     `WorkspaceLease` (src/types.ts:70-75: id/path/branch/baseSha). Documented, not
     relitigated.
   - **Command-vs-test split.** §12.1's single Command Probe description already covers
     tests; Milestone 4 names them separately with no definition. The chosen vocabulary:
     **command = exit-0 evidence probe** (records what happened — exit code, duration,
     output tail, full-output artifact — parses nothing); **test = parses a test-report
     format into structured measurements** (TAP, see below).
   - `EvidenceBundle.gateResults: GateResult[]` reuses the existing GateResult
     (src/types.ts:87-99): each command/test probe records its one execution as a
     GateResult entry — recorded evidence inside a bundle, never a verdict.
2. **Two implementations**, stdlib `child_process.spawn` **list-form, never `exec`**
   (AGENTS.md rule 4; stricter than CommandGate's operator-typed shell strings), with the
   T-011 verified tree-kill at timeout via src/kill-tree.ts — unproven kill outcomes land
   on the bundle's GateResult `cleanupFailures`, evidence only:
   - `CommandProbe` — success = exit 0. Measurements: none this slice (exit/duration
     live in the GateResult entry); the full combined output is written to
     `<artifactsDir>/probes/<candidateId>/<probeId>.log` and referenced as an
     EvidenceArtifactRef with sizeBytes.
   - `TestProbe` — runs a test command and requires **TAP** output (what `node --test`
     emits with zero new deps; zero-new-deps posture per decisions.md 2026-10-10).
     Success = exit 0 AND parseable TAP AND fail count 0. Measurements:
     `tests`/`pass`/`fail` (TAP 14 summary lines when present, counted `ok`/`not ok`
     lines otherwise). Exit 0 with unparseable output → success false: a probe that
     parsed nothing is never a pass (AGENTS.md rule 7 applied to bundles — an empty
     bundle is a recorded fact, never a success).
3. **Minimal wiring through the scheduler's job model** (builds on it, does not replace
   gates):
   - `--jobs` spec: per-job `probes` array,
     `{ "id", "type": "command"|"test", "command": {"exe", "args"}, "timeoutMs"? }`
     (default timeout 5 min, the CommandGate default). src/scheduler.ts:153's allowed
     job-field list — today exactly `[id, phase, dependencies, brief, model, worker,
     timeoutMs, gates]` — is extended with `probes`, shape-validated, unknown probe
     `type` refused with a clear message (the T-009 unknown-field posture). Probe ids
     unique per job.
   - `ResolvedJob` (src/runner.ts:40-50) gains additive optional `probes?: Probe[]`;
     src/cli.ts `resolveJobs` (:196-205) builds them beside the gates (:204).
   - `runJob`: probes run on the final completed attempt immediately after the gate loop
     (src/runner.ts:531-539), before review and workspace dispose, **regardless of gate
     outcomes** (evidence about failures is evidence). Each run emits
     `<artifactsDir>/probes/<candidateId>/<probeId>.json` — a validated EvidenceBundle
     under the run's artifacts dir (decisions.md 2026-10-10: run root C:\swarm\; never
     the worktree as the durable copy). A probe that throws records a success:false
     bundle with the error and never breaks the run.
   - `CandidateReport` (src/types.ts:229-261) gains additive optional
     `probes?: ProbeRunSummary[]` (`{probeId, scenarioId, success, durationMs,
     bundlePath}`) — absent when the job had no probes, so default-mode reports are
     unchanged.
   - **No new CLI flags this slice.** Probes attach via the `--jobs` spec; default
     `--goal` mode runs have no probes (today's behavior, unchanged).
4. **Survival semantics untouched by construction.** Probes ride beside the ladder as a
   parallel evidence seam — the honest reading, since `Gate.run(cwd)`
   (src/types.ts:105-108) carries no evidence-path context and making gates emit
   evidence would mean a Gate-seam change. The ladder expression
   (`passedAllGates = gates.length > 0 && every passed && diffBytes > 0`,
   src/runner.ts:539) is byte-identical; a probe result — including a failing one —
   never enters any verdict (decisions.md 2026-10-10: machine gates decide survival;
   models — and probes — advise/record. The T-011 cleanupFailures evidence-only
   precedent).

**Does NOT claim:** benchmark probe, screenshot-artifact probe (§34:2068-2069), Godot/
Web/Blender probes (§12.1:911-947), Static Diff probe (§12.1:949-951 — mostly exists as
worktree diff capture, src/workspace/worktree.ts), probe persistence (§27:1831
`probe_runs` / §28:1854 `ARTIFACT_CREATED` — both producerless, blocked on the unclaimed
filesystem artifact store §34:2028; store stays schema v4), the §13:986-996
project-manifest `probes:` block or any scenario/environment file format beyond job-spec
config, run-level `--probe` CLI flags, or probe evidence feeding the context system's
selectors (T-012's hand-built `type: 'probe'` fixtures, scripts/check-context.mjs:67-69,
are the ready consumer — a successor ticket's relationship).

## Why

The spec calls the evidence probe "one of the most valuable parts of V2"
(§12:881) and puts probe → evidence artifacts at the head of the preferred pipeline
(§3.3:95-107), but ROADMAP.md:16 shows stage 4 untouched; Milestone 4 was unblocked when
the scheduler landed (T-009, 2026-10-16), and the scheduler loop is now the only
execution path. Today the only verification mechanism is hand-typed `--gate` shell
strings built into `CommandGate`s (the sole Gate implementation,
src/gate/command.ts:19-77) — effective but unnamed, unreusable, and emitting no
structured evidence: `Gate.run(cwd)` returns a tail, and the store persists
name/passed/exitCode/durationMs/output_tail only (src/store/index.ts:79-87) — no
measurements, no artifacts, nothing an evaluation agent could later consume. This slice
lands the pinned contract and two working generic probes so that growth (benchmark,
screenshot, Godot) is additive per §12.1 rather than a redesign.

**Honest tension:** nothing consumes EvidenceBundles yet — no artifact store, no
`probe_runs` producer, no evaluation agents — and today's gates fully verify candidates,
so the immediate payoff is the contract plus two working probes (foundation value; the
shape-before-consumer posture T-006/T-012 took), not a closed loop. Because the slice
touches src/runner.ts and report shape, it owes one `npm run verify:full` at landing as
the no-regression obligation (the T-007/T-009 precedent; VERIFICATION.md's Gate 2
trigger) — but Gate 2 is a `--goal`-mode run (scripts/verify.mjs:520-529) and this slice
gives default mode no probes, so Gate 2 exercises no probe code; the real-pipeline pin
for evidence emission is the new fast-tier gate's token-free end-to-end `--jobs` drive
instead.

## Acceptance criteria

- [ ] The seam + contract exist as chosen-and-documented vocabulary: `src/probe.ts`
      defines Probe/ScenarioSpec/EnvironmentSpec/EvidenceBundle/Measurement/
      EvidenceArtifactRef with a docblock stating all three reconciliations (ArtifactRef
      rename vs src/context.ts:158; WorkspaceLease binding vs §16:1114-1123; the
      command-vs-test split). Pinned by Gate 0 (typecheck); the docblock is
      reviewer-visible and quoted in the ticket's Landed section.
- [ ] Malformed bundles refused: a bundle validator accepts a well-formed EvidenceBundle
      and refuses missing probeId/scenarioId, non-boolean success, non-array
      artifacts/measurements/gateResults — pinned by the new fast-tier gate's
      hand-built-fixture section (the Gate 0.5 check-parse pattern). Gate number = next
      free integer at landing (1.14 unless T-013 landed first claiming it, then 1.15 —
      the T-008 move), section added to VERIFICATION.md in the same change-set.
- [ ] CommandProbe real happy path, token-free: in a fresh demo-target fixture
      (scripts/demo-target.mjs — a working node repo with build.js/test.js, Gate 1),
      `CommandProbe{exe:"node",args:["build.js"]}` produces a bundle with success true,
      exitCode 0, exactly one GateResult entry, and a `.log` artifact written under the
      run's probes dir and referenced with sizeBytes > 0 — pinned by the new fast-tier
      gate (real probe executions, no model tokens).
- [ ] CommandProbe failure and spawn-refusal paths: a failing command → success false,
      non-zero exitCode, captured tail; a non-existent exe → success false with the
      spawn error recorded in the bundle, never success true (a probe that ran nothing
      is never a pass) — pinned by the same fast-tier gate.
- [ ] TestProbe TAP contract: all-pass TAP → success true with tests/pass/fail
      measurements (pass == tests); any `not ok` → success false, fail ≥ 1; exit 0 with
      unparseable output → success false (parsed-nothing is not a pass); timeout →
      verified tree kill, success false, unproven kill outcomes on the GateResult's
      cleanupFailures — pinned by the same fast-tier gate on temp TAP fixtures in the
      verify sandbox.
- [ ] Jobs-spec wiring: a `probes` array is accepted per job; a well-formed probe list
      validates; unknown probe `type` or a malformed entry is refused with a clear
      message; a spec without `probes` parses to output identical to today — pinned by
      the new fast-tier gate driving `parseJobsSpec` directly (token-free, no pipeline).
- [ ] Evidence emission in a real pipeline: a `--jobs` run carrying probes writes
      `<artifactsDir>/probes/<candidateId>/<probeId>.json` per executed probe (each a
      bundle that passes the validator) and the report's `CandidateReport.probes[]`
      names every bundlePath — pinned by the new fast-tier gate driving `runSkeleton`
      end-to-end in `--jobs` mode against a throwaway fixture repo with a **fake
      `WorkerAdapter`** and a fake passing gate (the Gate 1.8/1.10 pattern —
      scripts/check-scheduler.mjs:24, :47-151 already drives the runner this way,
      token-free), asserting the bundle files on disk, validator-clean contents, correct
      success values, and the probes[] ↔ bundlePath correspondence; a second scenario in
      the same drive runs a job whose gate FAILS and asserts its probes still ran and
      recorded (evidence about failures is evidence). The landing record quotes the
      gate's output in Landed. Gate 2 verify:full is NOT this criterion's pin — it is a
      `--goal`-mode run (scripts/verify.mjs:520-529) that exercises no probe code; it
      stays as the no-regression obligation (see Verification).
- [ ] Survival untouched: the src/runner.ts:539 ladder expression and
      `passedAllGates` semantics are byte-identical (quoted in Landed); probe results —
      including success:false bundles — never change a verdict or a gate PASS/FAIL
      (decisions.md 2026-10-10) — pinned behaviorally by the same fast-tier `--jobs`
      drive (a passing-gates/failing-probe job still passes, a failing-gates/
      passing-probe job still fails) and, at landing, by Gate 2's existing verdict
      assertions staying green (candidate outcomes unchanged from today — the
      no-regression face), plus Gate 0.
- [ ] No new npm dependencies; every probe subprocess is list-form `spawn` (never
      `exec`) with the T-011 verified tree-kill at timeout — pinned by Gate 0 and a
      package.json/package-lock.json diff-free change-set, confirmed in Landed.
- [ ] Docs extended in the same change-set: VERIFICATION.md gains the new gate section
      and a Gate 2 no-regression note for this slice; ROADMAP.md's stage 4 row
      notes the first slice at landing; README's `--jobs` documentation mentions the
      `probes` field — pinned by the full fast tier (`npm run verify`) ALL GREEN with
      the new section present.

## Verification

Gate 0 (typecheck) throughout; the **new fast-tier probe gate** added by this ticket,
with three legs: contract fixtures (validator refusals, `parseJobsSpec` wiring), direct
token-free CommandProbe/TestProbe executions against the demo fixture, and a token-free
end-to-end `--jobs` drive of `runSkeleton` with a fake `WorkerAdapter` asserting bundle
files and report probes[] (the Gate 1.8/1.10 pattern; gate number per the T-008
next-free-integer move, coordinated with T-013's proposed 1.14); the whole existing fast
tier stays green (`npm run verify` — no existing assertion weakened, T-013's claimed
Gate 1.14 slot notwithstanding); **one `npm run verify:full` at landing** (Gate 2) as
the no-regression obligation because the slice touches src/runner.ts, gate adjacency,
and report shape — VERIFICATION.md's Gate 2 trigger — per the T-007/T-009 precedent.
Gate 2 is a `--goal`-mode run and executes no probes; it pins that the pipeline without
probes behaves exactly as today — never probe emission itself, which the fast-tier
`--jobs` leg owns. A landing obligation, not a permanent tier extension. Not run and not
claimed here: Gate 3 (no adapter touched).

## References

docs/spec/inference-refinery-v2.md §12:879-967 (Probe interface, probe types,
EvidenceBundle), §3.3:95-107 (probe at the pipeline head), §13:986-996 (manifest probes
block — carved off), §16:1114-1123 (lease divergence), §27:1831 / §28:1854 (producerless
`probe_runs` / `ARTIFACT_CREATED` — carved off), §34:2061-2072 (Milestone 4, first
list); docs/ROADMAP.md:16 (stage 4); docs/decisions.md (2026-10-10: gates decide
survival; harness-agnostic seams; TypeScript/Node 22 zero-new-deps posture; run root
C:\swarm\); src/types.ts:70-108 (WorkspaceLease, GateResult, Gate),
src/gate/command.ts:19-77 (spawn/timeout precedent), src/runner.ts:40-50, 531-539
(ResolvedJob, gate loop, ladder), src/scheduler.ts:153 (allowed job fields),
src/cli.ts:148-154, 196-205, 281 (gate parsing + construction),
src/context.ts:158 (ArtifactRef collision), src/store/index.ts:79-87 (gate-only
persistence), scripts/verify.mjs:508-518 (fast-tier tail where the new gate slots in)
and :520-529 (Gate 2's `--goal`-only skeletonArgs — why it cannot pin probe emission),
scripts/check-context.mjs:61-76 (hand-built-fixture pattern),
scripts/check-scheduler.mjs:24, :47-151 (the token-free end-to-end fake-WorkerAdapter
`runSkeleton` drive — the pattern the new gate's `--jobs` leg reuses; VERIFICATION.md
documents it at :420-425), VERIFICATION.md Gate 2 (:786-813 — a `--goal`-mode run; the
no-regression obligation), scripts/demo-target.mjs (token-free probe target).
