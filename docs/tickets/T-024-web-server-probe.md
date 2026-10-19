# T-024 — Web/server probe: launch target → bounded readiness poll → HTTP status + body-snippet evidence → verified teardown (spec §12.1 territory, stage-4 breadth)

**Status:** done
**Category:** engine
**Value (1-5):** 4 · **Risk (1-5):** 2
**Depends on:** T-015 (done 2026-10-17 — the Probe seam + EvidenceBundle contract this extends). **T-016 (done 2026-10-17) is an ordering note, not a build dependency**: `probe_runs`/`ARTIFACT_CREATED` persistence landed type-agnostically (schema v5; the extended Gate 1.6 pins one `probe_runs` row per summary regardless of probe type, VERIFICATION.md:229-233), so a web bundle persists through it with zero store code — web is the consumer T-016:83-84 already named successor probe types to be. **T-018/T-019 (both done 2026-10-17) are precedent, not code dependencies**: this ticket inherits their Gate 1.15 flip discipline and extends the same pins; T-019's capture semantics are *not* called here (screenshot integration is carved, see Does NOT claim).

## What

Stage-4 breadth, the territory every landed probe slice carved and this ticket fills:
a fifth probe type whose target is a **long-running server**, not a
run-to-completion command. The spec defines **no server-lifecycle probe
anywhere** — §12.1:925-935's "Web Probe" is *browser automation* (load page,
interact, console/network errors, accessibility tree, viewport matrix,
performance metrics), and §12:879-967 defines only the seam + output contract —
so the launch/readiness/capture/teardown semantics below are
chosen-and-documented in the module docblock (the
T-007/T-012/T-013/T-018/T-019 precedent). This is the launch → readiness →
HTTP-evidence → teardown skeleton the Godot/Web/Blender probes
(§12.1:911-947) compose from once those apps are installed.

1. **`src/probe.ts` — `ProbeType` gains `'web'`** (today exactly
   `'command' | 'test' | 'benchmark' | 'screenshot'`, src/probe.ts:126; the
   docblock at :122-125 still calls Web a successor slice — it updates).
   `EvidenceArtifactKind` does **not** change — the response artifact reuses
   the landed `'report'` kind (src/probe.ts:134, T-018's results table its
   first producer); no new kind means Gate 1.15's P1 kind pin is untouched.
   - `ScenarioSpec` gains `url?: string` (src/probe.ts:139-164) with a
     docblock contract: **required, non-empty `http://` or `https://` URL when
     `type: 'web'`** — the address the probe polls for readiness and captures.
     **Refused on every other probe type** (the T-018 `repeats` / T-019
     `capture` precedent: the field exists only where it means something).
     The `url` is the one ScenarioSpec field that points outside the
     workspace (absolute by nature) — documented, and its operator-chosen
     port is machine-global (see Limitations).
   - **`WebProbe implements Probe`** (new class beside
     CommandProbe/TestProbe/BenchmarkProbe/ScreenshotProbe) — the one
     genuinely new mechanic, stated plainly: **a launch-without-awaiting-exit
     lifecycle beside the landed run-to-completion core.** `executeProbeCommand`
     (src/probe.ts:385-441) runs ONE command to completion under a single
     timeout budget, so a server target today can only be probed by a command
     that encapsulates launch+poll+capture+teardown itself. This ticket adds a
     `launchTarget` helper in that same block: list-form `spawn` (never exec,
     AGENTS.md #4), `windowsHide`, cwd = the workspace path, spawn refusal
     recorded-never-thrown — but it does **not** await exit; it returns the
     live child handle. Teardown is the already-landed T-011 verified tree
     kill (`killTreeVerified`, imported src/probe.ts:119 — machinery Gates
     1.11/1.12/1.15 already pin on real process tables).
   - **The lifecycle, one `timeoutMs` budget end to end** (default
     `DEFAULT_PROBE_TIMEOUT_MS`, src/probe.ts:226): launch the scenario
     command in the workspace → **bounded readiness poll** of `url` (stdlib
     global `fetch` — zero new dependencies, decisions.md:6-10; a documented
     poll-interval constant; deadline = `timeoutMs` from launch) → the first
     poll response that connects **is** the capture (status read + body read,
     body read capped by a documented constant; the body **snippet** further
     bounded by a documented constant — exact values fixed in the change-set
     and pinned by the gate, the T-019 `MIN_PNG_BYTES` precedent) →
     **teardown via `killTreeVerified` on EVERY path**: after a successful
     capture, after every failure face, and at deadline expiry; unproven kill
     outcomes land on the GateResult's `cleanupFailures` (evidence only);
     nothing-to-kill (spawn refusal, target already exited) is recorded
     honestly, never fabricated.
   - **Measurements** (the landed `Measurement` type, src/probe.ts:203-208 —
     its validator accepts any finite number, src/probe.ts:268-275, which is
     exactly why the body *content* is an artifact, never a measurement):
     `http status` (the captured status code), `body bytes` (unit `'bytes'`),
     `ready duration` (unit `'ms'` — launch to first successful response,
     recorded whenever readiness was reached, even on later failure faces;
     evidence about failures is evidence).
   - **Artifacts**: the standard `.log` (launch banner + poll attempts +
     capture outcome — the `logArtifact` pattern, src/probe.ts:464-474), plus
     **`<probeId>.response.json`**, kind `'report'`
     (`{url, status, contentType?, bodySnippet, bodyBytes}` — the kind's
     second producer; the bounded snippet keeps the bundle JSON bounded).
   - **Success semantics**: success = target launched AND `url` ready within
     the deadline AND the captured response is a **2xx** AND its body is
     **non-empty**. No assertion/threshold field of any kind — 2xx +
     non-empty body is the documented evidence shape (the probe records,
     never judges), and the `success` field is itself evidence only. Each
     failing face names itself in `EvidenceBundle.error` (target exited
     before readiness / readiness deadline expired, naming the last poll
     error e.g. connection refused / non-2xx status / empty body / spawn
     refused). A probe that captured **no response is `success: false`,
     never a pass** (AGENTS.md #7 applied to bundles — the T-015 posture,
     T-015:57-58).
   - **No verdict input of any kind**: a `success:false` web bundle changes
     nothing downstream — the ladder (src/runner.ts:544) is untouched by
     construction; this ticket edits no runner code (decisions.md:19-21).
   - `createProbe` gains the web branch (src/probe.ts:877-888); its docblock
     updates.
2. **`src/scheduler.ts` — one validation surface** (`parseJobsSpec`'s probes
   map, src/scheduler.ts:202-265): the type refusal at :211-212 becomes
   `type must be "command", "test", "benchmark", "screenshot", or "web"`;
   the allowed probe-field list at :205 gains `url`; shape validation: `url`
   required non-empty http(s) on a `web` probe (missing, empty, non-string,
   non-http(s) scheme — all refused naming the offense), **refused on
   command/test/benchmark/screenshot** probes (the `repeats`/`capture`
   precedent at :229-256). The parsed spec carries `url` only on web probes
   (the :257-264 pattern).
3. **`scripts/check-probe.mjs` — Gate 1.15 extended in place** (no new gate
   number; the T-018/T-019 precedent, VERIFICATION.md:1084-1107):
   - **The mandatory flip (AGENTS.md #8).** Gate 1.15's P2 leg actively pins
     the unknown-type refusal message (scripts/check-probe.mjs:376, example
     `'godot'`, flip-history comment block :339-375). Adding `'web'`
     invalidates that pin, so the flip happens **explicitly in this
     change-set, never silently**: the expected message becomes
     `type must be "command", "test", "benchmark", "screenshot", or "web"` —
     `'godot'` itself stays genuinely unknown and remains the example; only
     the expected message string changes. The flip gains positive coverage
     (a web probe with `url` parses and is preserved verbatim — the
     T-018/T-019 flip pattern). Recorded here as this change-set's only
     intentional invalidation of an existing assertion; no other existing
     check is weakened.
   - New **P2** legs: `url` validation (missing on web; `''`; non-string;
     `ftp://host/` non-http(s); `url` present on a
     command/test/benchmark/screenshot probe).
   - New **P3** direct-execution legs, token-free, against a
     **zero-dependency `node:http` fixture server generated in the sandbox
     per leg** (the sleeper/shotFx write-and-run pattern,
     scripts/check-probe.mjs:701-709 and :602-613; the same shape as
     scripts/demo-target.mjs:1-53 builds its throwaway target — write files,
     run them, no npm install; no server exists in that fixture today, this
     ticket's server is new):
     - *happy*: the server serves 200 with a known body → success true;
       `http status` 200; the body snippet equals the known body; the
       response artifact parses and carries it; validator-clean bundle;
       **the server tree verified dead on the real process table after
       `run()` returns** — teardown pinned on the success path (the P4
       process-table pattern).
     - *wrong status*: the server serves 500 → success false; the
       `http status` measurement still records 500.
     - *empty body*: the server serves 200 with a zero-byte body → success
       false.
     - *target exits early*: the launch command exits 3 without serving →
       success false naming the exit.
     - *never-ready*: a sleeper launch that binds nothing → deadline expiry →
       success false, error names the readiness timeout with the last poll
       error, **the spawned tree verified dead on the real process table**,
       kill evidence on the GateResult entry — the tree kill is what reaps a
       launched server.
     - every leg ends with a **sweep assertion: no fixture-server process
       left alive** (AGENTS.md #10; the P4 sweep fallback).
   - **P5** e2e: a `--jobs` drive carrying a web probe (inline `node -e`
     server, source as argv — token-free) asserts the `probes[]` ↔
     `bundlePath` correspondence (bundle on disk, validator-clean, success
     agreeing with the summary), the response artifact on disk under the
     artifacts dir **never inside the worktree** (the durable-copy rule,
     src/probe.ts:97-102 — the workspace is disposed at src/runner.ts:591-598),
     and survival untouched (a passing-gates/failing-web-probe job still
     passes), extending the existing drive.
4. **Docs in the same change-set** (AGENTS.md #6): VERIFICATION.md's Gate 1.15
   section (the probe type list at VERIFICATION.md:1052-1053; the carve list
   at :1228-1232 — Web moves from carved to pinned, with the new legs named;
   a recorded T-024 flip paragraph beside T-018's :1084-1090 and T-019's
   :1092-1107); docs/ROADMAP.md:16's stage-4 row (remaining: Godot/Blender +
   browser-automation Web proper); README's `--jobs` probes doc
   (README.md:138-160 — the type list gains `"web"` and `url`).

**Limitations documented, not hidden** (the scout's two design constraints):
(a) **machine-global ports** — `url` is operator-chosen and ports are
machine-global, so two concurrently-running probes pointed at the same port
collide; no ephemeral-port scheme exists this slice (carved). (b) the **body
snippet is bounded** in the bundle JSON — the validator accepts any finite
measurement value (src/probe.ts:268-275), so body content lives in the bounded
`'report'` artifact, never in a measurement.

**Does NOT claim:** **screenshot integration on the launched target** (the
ask's "and/or a screenshot" — composing T-019's capture/size-floor/magic/
durable-copy semantics onto a web probe's live server; the mechanics are
proven and it is the natural successor ticket, not part of this change-set);
**browser automation proper** (§12.1:925-935's full Web Probe — interaction,
console/network errors, accessibility tree, viewport matrix, performance
metrics — needs a browser dependency, i.e. puppeteer/playwright, and its own
decisions.md entry per the 2026-10-10 zero-new-deps posture); **Godot/Blender
probes** (§12.1:911-924, :937-947); **ephemeral-port allocation and
multi-URL/health-endpoint logic** (fixed operator-chosen `url` is the
documented limitation); any **measurement→verdict bridge** (T-018:124-128's
carve stands; gates decide survival, decisions.md:19-21); **`probe_runs`
store work** (T-016 landed it type-agnostically — zero store code here);
run-level `--probe` CLI flags and the §13:986-996 project-manifest `probes:`
block.

## Why

The gap is explicitly carved, repeatedly, by every landed probe slice:
VERIFICATION.md:1228-1232 — "Godot/Web/Blender probes (§12.1:911-947 — the
screenshot probe is their base; target lifecycle, readiness polling, and
mid-run capture stay carved)"; VERIFICATION.md:1250-1252 — T-019's carve:
"probe-side target lifecycle (the Web/Godot probes' §12.1 territory — today
the capture command encapsulates launch, timing, and readiness, and the
one-command seam shape is unchanged)"; T-019:143-151 carves the same
territory by name ("launch target, poll URL/readiness, mid-run capture at a
given point, teardown"), as do T-015:93-94, T-016:83-84, T-017:40, and
T-018:124-125. docs/ROADMAP.md:16 — stage 4 partial 2026-10-17, remaining:
Godot/Web/Blender. Milestone 4's start list (§34:2061-2072) is the four
generic probes then Godot — **Web is post-start-list stage-4 breadth**, and
the Web slice taken here is the one that needs no new dependency.

The concrete code gap, grep-verified (scout, this session): a grep for
`type: 'web'|'web'|WebProbe|ServerProbe|node:http|createServer|fetch(` over
`src/`, `scripts/check-probe.mjs`, and `package.json` returns zero hits. And
the gap is structural, not just missing: `executeProbeCommand`
(src/probe.ts:385-441) runs one command to completion with a single full
`timeoutMs` budget — the seam has no launch-without-awaiting-exit shape, so
a server target can only be probed today by a command that encapsulates the
whole lifecycle itself.

**Feasibility, run this session (scout + this writer):** node v22.23.1,
`typeof fetch` = `'function'`, `node:http` `createServer` = `'function'`
(checked via `node -e`, this session) — the zero-new-dependency posture
(decisions.md:6-10; the sole runtime dependency is `opencode-ai`,
package.json:22-24) is achievable with stdlib only. The fixture server
follows the demo-target pattern (scripts/demo-target.mjs:1-53) and slots
into the existing check-probe sandbox (`C:/swarm/verify-probe`,
scripts/check-probe.mjs:47, rebuilt :74-75).

**Honest tension, stated not smoothed (the T-018:156-166 pattern):** probes
never enter verdicts (decisions.md:19-21) and built-in consumers are stage 5
and 7 (docs/ROADMAP.md:17,:19) — today's payoff is structured server
evidence under `C:\swarm\<runId>\probes\` plus the lifecycle skeleton all
three remaining app-probe families compose from; hence Value 4, not 5. And
an **UNCONFIRMED**, recorded per AGENTS.md #9: no prototype server probe was
run while scouting — the launch/poll/teardown mechanics are grounded in the
landed `executeProbeCommand` + `killTreeVerified` code and Gate 1.15's green
timeout legs (which pin spawned trees verified dead on the real process
table), **not in an execution of new code**; the new P3 legs below are both
the red-before bar and the proof. The spec defines no server-lifecycle
semantics at all, so launch → bounded poll → 2xx + non-empty body → verified
teardown is the documented choose-and-document move — and the gate, not the
docblock alone, pins it.

Pre-change baseline, run this session at a clean tree (this writer):
`node node_modules/tsx/dist/cli.mjs scripts/check-probe.mjs` → **"check-probe:
ALL GREEN", exit 0** — the pins this ticket extends are green today.

## Acceptance criteria

- [x] `ProbeType` includes `'web'`; `WebProbe` exists behind the landed Probe
      seam with the documented contract above (list-form launch without
      awaiting exit; bounded readiness poll deadline-bound by the single
      `timeoutMs` budget; `http status`/`body bytes`/`ready duration`
      measurements recorded on failure faces too; the bounded-snippet
      `'report'`-kind response artifact; `killTreeVerified` teardown on EVERY
      path with unproven kills on `cleanupFailures`; no-response never a
      pass; **no threshold field, no verdict input**); zero model/harness
      knowledge in the module (decisions.md:11-15) — pinned by **Gate 0**
      (`tsc --noEmit`) plus the **Gate 1.15 P3** contract legs.
- [x] The parser accepts a web probe with `url` verbatim and refuses: a
      genuinely-unknown type with the updated message; missing/empty/
      non-string/non-http(s)-scheme `url` on a web probe; `url` on a
      command/test/benchmark/screenshot probe — pinned by **Gate 1.15 P2**
      (contract fixtures over `parseJobsSpec`, token-free).
- [x] **The scripts/check-probe.mjs:376 unknown-type message pin is
      explicitly flipped** (the message gains `"web"`; `'godot'` stays the
      example) in this change-set — recorded here as the change-set's only
      intentional invalidation of an existing assertion; no other existing
      check is weakened — pinned by the full fast tier, **`npm run verify`
      ALL GREEN** with the flipped Gate 1.15.
- [x] Happy path, token-free: the zero-dep `node:http` fixture server
      (generated in the sandbox, the demo-target pattern) → success true;
      `http status` 200; the body snippet equals the known body;
      `<probeId>.response.json` (kind `'report'`) on disk under
      `<artifactsDir>/probes/<candidateId>/` parsing to the captured values;
      the bundle passes `validateEvidenceBundle`; **the server tree verified
      dead on the real process table after `run()` returns** — pinned by
      **Gate 1.15 P3**.
- [x] Failure faces, each `success: false` never a pass: server 500 (the
      status measurement still records 500); empty 200 body; target exiting
      before readiness (exit named in `error`); never-ready sleeper →
      deadline expiry, `error` names the readiness timeout, the spawned tree
      verified dead on the real process table, kill evidence on the
      GateResult; every leg sweeps its fixture server (no process left
      alive) — pinned by **Gate 1.15 P3** (the P4 process-table pattern with
      sweep fallback; AGENTS.md #7 and #10).
- [x] Evidence emission in a real pipeline: a `--jobs` run carrying a web
      probe writes its bundle under `<artifactsDir>/probes/<candidateId>/`,
      the report's `probes[]` names its `bundlePath` and agrees with the
      bundle, the response artifact exists on disk at report time **never
      inside the worktree**, and survival is untouched by the web-probe
      outcome (a passing-gates/failing-web-probe job still passes) — pinned
      by **Gate 1.15 P5** (the fake-WorkerAdapter `runSkeleton` drive).
- [x] Zero runner/CLI/report-shape/store drift: no `src/runner.ts`,
      `src/cli.ts`, `src/types.ts`, or `src/store/` edits (the pipeline is
      type-agnostic, src/runner.ts:554-556, :617-646; `ProbeRunSummary`
      src/types.ts:279-285; the verdict ladder byte-identical,
      src/runner.ts:544; `probe_runs` rows persist type-agnostically through
      Gate 1.6's probes variant, VERIFICATION.md:229-233) — pinned by
      **Gate 0** plus the change-set file list (`git status --porcelain` /
      `git diff --stat`: exactly `src/probe.ts`, `src/scheduler.ts`,
      `scripts/check-probe.mjs`, `VERIFICATION.md`, `docs/ROADMAP.md`,
      `README.md`, the ticket file + the index).
- [x] No new npm dependencies (decisions.md:6-10); the launch is a list-form
      spawn through the new helper (never exec), the poll/capture on stdlib
      `fetch` — pinned by **Gate 0** and the package.json/package-lock.json
      diff-free change-set.
- [x] Docs extended in the same change-set: VERIFICATION.md's Gate 1.15
      section (type list :1052-1053, carve list :1228-1232, the recorded
      flip), docs/ROADMAP.md:16's stage-4 row, README's `--jobs` probes doc
      (README.md:138-160) — pinned by **`npm run verify` ALL GREEN** with
      the updated sections present.
- [x] **Gate 2 NOT owed — recorded, not silently skipped** (the T-018:223-228
      / T-019 trigger-analysis precedent, VERIFICATION.md:1016-1017): the
      change-set touches no `src/runner.ts`, no adapter, no gate code, no
      workspace handling, and no report shape — none of Gate 2's triggers;
      Gate 2 is additionally a `--goal`-mode run that executes no probe code
      (VERIFICATION.md:1109-1111), so it could not pin any web-probe
      criterion anyway. **Gate 3 n/a** (no adapter touched).

## Verification

**Gate 0** (typecheck) throughout; **Gate 1.15 extended in place** — this
ticket claims **no new gate number** (the T-018/T-019 precedent) and extends
the probe gate's existing legs: P2 parser legs (the :376 message flip +
`url` validation), P3 direct-execution web legs (happy/failure faces/
never-ready timeout with the process-table and sweep assertions), P5 e2e
correspondence leg; the whole existing fast tier stays green (`npm run
verify`) — the one flipped assertion is named in the criteria, nothing else
weakened. Gate 1 (fixture regeneration) untouched and green inside the tier.
**Gate 2 not owed** per the recorded trigger analysis above; **Gate 3 n/a**
(no adapter). Store gates untouched (Gate 1.6's probes variant already pins
`probe_runs` type-agnostically, VERIFICATION.md:229-233, and stays green
inside the tier).

## References

docs/spec/inference-refinery-v2.md §12.1:925-935 (Web Probe — browser
automation; no server-lifecycle probe defined anywhere in §12:879-967),
§12.1:911-947 (Godot/Web/Blender — the successors this is the base of),
§12:879-967 (Probe seam + output contract), §34:2061-2072 (Milestone 4 start
list — Web is post-start-list breadth) · VERIFICATION.md:1024-1082 (Gate
1.15; type list :1052-1053), :1084-1107 (the recorded T-018/T-019 flips this
ticket's flip extends), :1109-1111 (Gate 2 exercises no probe code), :1228-1232
(the carve list — Web moves from carved to pinned), :1250-1252 (T-019's
target-lifecycle carve), :229-233 (Gate 1.6's type-agnostic `probe_runs`
pins), :1016-1017 (the Gate 2 trigger-analysis wording) ·
docs/tickets/T-015-probe-layer-first-slice.md:93-94 (the carve), :57-58
(AGENTS #7 applied to bundles) · docs/tickets/T-016-filesystem-artifact-store.md:83-84
(consumers carve) · docs/tickets/T-017-machine-worker-adapter.md:40
(re-carve) · docs/tickets/T-018-benchmark-probe.md:124-125 (re-carve),
:156-166 (honest-tension pattern), :223-228 (trigger-analysis pattern) ·
docs/tickets/T-019-screenshot-probe.md:143-151 (the verbatim carve this
fills) · docs/decisions.md:6-10 (zero-new-deps), :11-15 (harness-agnostic
seams), :19-21 (gates decide survival), :25-26 (run root C:\swarm) ·
docs/ROADMAP.md:16 (stage-4 remaining: Godot/Web/Blender), :17,:19 (consumer
stages) · src/probe.ts:97-102, :119, :122-126, :134, :139-164, :203-208,
:226, :268-275, :365-441, :447-461, :464-474, :837-850, :877-888 ·
src/scheduler.ts:202-265 (probes map; fields :205, type refusal :211-212,
repeats/capture precedent :229-256) · src/runner.ts:544, :554-556, :591-598,
:617-646 · src/types.ts:279-285 · scripts/check-probe.mjs:47, :74-75,
:339-376 (the pin this ticket flips), :602-634, :701-752 (the sleeper/
process-table patterns) · scripts/demo-target.mjs:1-53 ·
scripts/fixtures/ (report-real.json, tiny-1x1.png — no server fixture exists;
this ticket generates its server in-sandbox) · package.json:22-24 (sole
runtime dep `opencode-ai`) · README.md:138-160 (the `--jobs` probes doc).

## Landed

2026-10-18, lane branch `ticket/T-024-web-server-probe`.

What changed:

- **`src/probe.ts`** — `ProbeType` gains `'web'` (the docblock that called
  Web a successor slice now names `web` landed and points Godot/Blender +
  browser-automation Web proper at the successors); `EvidenceArtifactKind`
  untouched — the response artifact reuses `'report'` (its second
  producer). The module docblock gains the web-semantics block (the spec
  defines no server-lifecycle probe anywhere — chosen and documented: the
  launch-without-awaiting-exit lifecycle, the bounded readiness poll, the
  first-connected-response capture, the every-path teardown, success =
  launched AND ready within the deadline AND 2xx AND non-empty body, the
  measurement/artifact policy, no verdict input, the two documented
  limitations). `ScenarioSpec` gains `url?: string` carrying the
  required-non-empty-http(s) contract in its docblock. New exported
  constants, exact values fixed here and pinned by the gate:
  `WEB_PROBE_POLL_INTERVAL_MS = 250`, `WEB_PROBE_MAX_BODY_BYTES =
  1024 * 1024` (1 MiB), `WEB_PROBE_SNIPPET_BYTES = 2048`. New
  `launchTarget` helper beside `executeProbeCommand` (the same block):
  list-form `spawn` (never exec, AGENTS.md #4), `windowsHide`, cwd = the
  workspace path, spawn refusal recorded on the returned handle via the
  'error' event — never thrown — and the live `ChildProcess` returned
  without awaiting exit; the caller owns teardown and never taskkills a
  just-exited pid (the `executeProbeCommand` boundary rule, pid reuse).
  Local helpers: `sleep`, `describePollError` (undici's `fetch failed`
  surface carries the real cause — e.g. `connect ECONNREFUSED` — on
  `error.cause`; the recorded last-poll-error includes it),
  `readBodyCapped` (chunks accumulated only to the cap, the stream
  cancelled past it, aborts not swallowed). New `responseArtifact` beside
  `resultsArtifact`: `<probeId>.response.json`, kind `'report'`, body
  `{probeId, scenarioId, url, status, contentType?, bodySnippet,
  bodyBytes}`. New `WebProbe implements Probe`: launch → bounded readiness
  poll of `url` (stdlib global `fetch`, zero new deps; one `timeoutMs`
  budget from launch, every attempt aborted at it via AbortController,
  `WEB_PROBE_POLL_INTERVAL_MS` between attempts; fail-fast the moment the
  target exits before readiness) → the first poll response that CONNECTS
  is the capture (status; body capped at `WEB_PROBE_MAX_BODY_BYTES`;
  snippet bounded at `WEB_PROBE_SNIPPET_BYTES`) → teardown via
  `killTreeVerified` on EVERY path while the target is live, unproven kill
  outcomes on the GateResult's `cleanupFailures`, nothing-to-kill (spawn
  refusal, already-exited target) recorded in the `.log` honestly, never
  fabricated. Success = launched AND ready within the deadline AND 2xx AND
  non-empty body; `error` names the first failed face; a probe that
  captured no response is success:false, never a pass. Measurements:
  `http status` (no unit — the captured status code), `body bytes`
  (bytes), `ready duration` (ms), recorded whenever readiness was reached
  even on later failure faces; none on capture-failed faces. One
  GateResult entry for the whole lifecycle (exitCode = the target's own
  exit when it exited before teardown, null otherwise; durationMs spans
  launch through teardown's conclusion; outputTail = the probe log's
  tail). A directly constructed scenario without a valid `url` is refused
  by the class itself (thrown, the ScreenshotProbe `captureRefusal`
  precedent — never a silent 5-minute poll of a malformed scenario).
  `createProbe` gains the web branch (docblock updated).
- **`src/scheduler.ts`** — the `parseJobsSpec` probes map: `url` joins the
  allowed probe-field list; the type refusal now reads `type must be
  "command", "test", "benchmark", "screenshot", or "web"` (the flip); `url`
  required non-empty http(s) on a web probe (missing / empty / non-string
  refused as `url must be a non-empty http(s) URL on a web probe`;
  `ftp://host/` and URL junk refused as `url must be an http:// or
  https:// URL` — `new URL` parse + protocol check, both naming the
  offense) and refused on command/test/benchmark/screenshot probes (`url
  is only valid on a web probe`); the parsed spec carries `url` only on
  web probes.
- **`scripts/check-probe.mjs`** (Gate 1.15 extended in place — no new gate
  number): THE FLIP executed as named in the criteria — the unknown-type
  message pin gained `"web"` and `'godot'` stays the genuinely-unknown
  example (only the message string changed), plus positive coverage (a web
  probe with `url` parses and is preserved verbatim). New P2 `url` legs
  (missing/''/non-number-string 8080/`ftp://host/`/junk on web; `url` on
  command/test/benchmark/screenshot). New P3 web legs, token-free, against
  zero-dependency `node:http` fixture servers generated in the sandbox per
  leg (the demo-target write-and-run pattern; each leg's server binds a
  free port a new `freePort()` helper picks — ports are machine-global,
  the documented limitation): happy (200 + known body → success true,
  `http status` 200, snippet equals the body, response artifact on disk
  parsing to {url, status, contentType, bodySnippet, bodyBytes},
  validator-clean, one GateResult passed with exitCode null, **server tree
  verified dead on the real process table after run() returns**); the
  bounds pinned exactly (`/big` 5000 chars → snippet exactly
  `WEB_PROBE_SNIPPET_BYTES`; `/huge` 1.5 MiB → bodyBytes exactly
  `WEB_PROBE_MAX_BODY_BYTES`, both still success true); wrong status (500
  → success false, the `http status` measurement STILL records 500, ready
  duration recorded, artifact records it); empty body (200 + zero-byte →
  success false, body bytes 0 recorded, artifact carries bodyBytes 0);
  target exits early (exit 3 without serving → success false naming the
  exit, zero measurements, no response artifact, exitCode 3 on the
  GateResult, `nothing to kill` in the log with NO `cleanupFailures`
  fabricated); never-ready (the P4 sleeper shape, binds nothing → deadline
  expiry, error names the readiness timeout with the last poll error
  ECONNREFUSED, exitCode null, durationMs ≥ timeoutMs, multiple poll
  attempts logged inside the one budget, **spawned tree parent+child
  verified dead on the real process table**, kill evidence on the
  GateResult); every leg sweeps its server (the P4 sweep fallback). The
  P5 drive extended: job-a gains a PASSING web probe and job-b a FAILING
  one (inline `node -e` servers, source as argv), pinning the probes[] ↔
  bundlePath correspondence, the response artifact on disk under the
  artifacts dir NEVER inside the worktree (pinned against the report's
  `workspacePath`), and a passing-gates/FAILING-web job still passes.
  101 assertions, 0 FAIL, zero model tokens. The existing per-job
  probes[] length/order pins were extended for the new drive members
  (job-a 4→5, job-b 3→4; the on-disk report.json probes length 4→5) —
  coverage added, nothing weakened, recorded in VERIFICATION.md's flip
  paragraph.
- **`VERIFICATION.md`** — Gate 1.15 section: the type list gains `"web"`
  and `url` (required non-empty http(s) on web, refused elsewhere; the web
  budget documented as WHOLE-LIFECYCLE vs the benchmark's PER-REPEAT), the
  T-024 web-semantics paragraph (launch/poll/capture/teardown contract,
  the three constants with their exact values, the every-path teardown
  rule, success semantics, measurements, artifacts, the machine-global
  port limitation), the recorded T-024 flip paragraph (beside T-018's and
  T-019's), all three legs extended with the web pins, and the carve list
  updated — Web (server-lifecycle) moves from carved to pinned;
  Godot/Blender app-specific lifecycle, browser-automation Web proper
  (§12.1:925-935), screenshot integration on a launched target,
  ephemeral-port allocation, and multi-URL/health-endpoint logic are
  recorded as carves so they are neither silently assumed nor silently
  owed; T-019's target-lifecycle carve sentence annotated with the T-024
  pin.
- **`README.md`** — the `--jobs` probes doc: the type list gains `"web"`
  and `url`; a web-probe paragraph (launches without awaiting exit, polls
  `url`, one whole-lifecycle budget, status + capped body bytes + ready
  duration, the bounded `response.json`, the always-verified teardown,
  2xx + non-empty success, the machine-global port caveat).
- **`docs/ROADMAP.md`** — stage-4 row: web/server probe landed (T-024),
  Gate 1.15 extended; remaining: Godot/Blender + browser-automation Web
  proper.
- **`docs/tickets/`** — this ticket flipped to done with the boxes
  checked, index row updated, in the same change-set.

Change-set exactly as pinned (`git status --porcelain`): `src/probe.ts`,
`src/scheduler.ts`, `scripts/check-probe.mjs`, `VERIFICATION.md`,
`docs/ROADMAP.md`, `README.md`, this ticket + the index. Zero edits to
`src/runner.ts`, `src/cli.ts`, `src/types.ts`, `src/store/`,
`package.json`, or `package-lock.json` — no runner/CLI/report-shape/store
drift (`ProbeRunSummary` untouched, the verdict ladder byte-identical,
`probe_runs` persisting type-agnostically through Gate 1.6's probes
variant), no new npm dependencies, the launch through the new list-form
`launchTarget` (never exec), the poll/capture on stdlib `fetch`.

Gates measured this session (lane, node v22.23.1, Windows):

- **Gate 0** `tsc --noEmit` → exit 0 (run at each step).
- Pre-change baseline (clean lane at 88a1f60, before any edit): Gate 1.15
  standalone → **ALL GREEN, exit 0, 79 `ok:` assertions**; full fast tier
  → **"verify (fast) complete: ALL GREEN"**.
- **Gate 1.15** `node node_modules/tsx/dist/cli.mjs
  scripts/check-probe.mjs` → **ALL GREEN, exit 0, 101 `ok:` assertions**
  (22 new: 3 P2, 19 P3/P5), run four times back-to-back during iteration —
  green on the first post-change execution, no red-then-fixed bars needed
  on any web leg.
- **Fast tier** `node scripts/verify.mjs fast` (Gate 0 + Gate 1 + 0.5 +
  1.5 + 1.6–1.20, including the flipped Gate 1.15) → **"verify (fast)
  complete: ALL GREEN"**, 1003 `ok:` lines, exit 0.
- **Gate 2 NOT owed** per the recorded trigger analysis in the criteria
  (no `src/runner.ts`, no adapter, no gate code, no workspace handling, no
  report-shape change; Gate 2 is additionally a `--goal`-mode run that
  executes no probe code). **Gate 3 n/a** (no adapter touched). **Gate 2
  was not run** — not skipped silently.
