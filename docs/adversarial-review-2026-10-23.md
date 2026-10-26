# Adversarial review — 2026-10-23 — findings register

The 2026-10-23 full adversarial review (core-path read + a spec/tickets mining
pass + a peripheral-subsystem review pass) produced findings in two tiers:

- **Ticketed same day:** the top findings are T-042..T-048 (see
  [docs/tickets/README.md](tickets/README.md)): prompt-over-argv ceiling,
  baseline gate sanity, worker-commit evidence destruction, gate/diff overlap
  flag, post-kill settle deadline, ignored-path parity evidence, clean's
  dirty predicate.
- **This file:** everything else, so no finding lives only in session memory.
  Each entry carries a provenance mark and a suggested disposition.
  Dispositions: `decision` (needs a dated decisions.md entry or a direction
  choice), `ticket-later` (promote when its turn comes), `fold` (ride an
  existing ticket), `monitor` (no action; re-check on recurrence), `by-design`
  (accepted, documented here as accepted).

Provenance marks: **[verified]** reproduced by experiment this session ·
**[code-read]** read directly in source this session · **[subagent]** reported
by the peripheral-subsystem review pass (probe/store/dashboard/recover/rounds/
gc/machine-worker); patterns spot-checked, not every line re-verified by the
lead — re-verify before acting on any single item.

Per ground rule #11 (the T-041 ratchet): nothing here gates anything by
existing. An item earns teeth only by promotion into a ticket-owned
change-set; when that happens, update its line here to name the ticket.

---

## 1. Trust model & containment

### R1 — Containment is directory-scoping, not command-scoping; the environment is fully inherited `decision` · [code-read]

Workers, gates, and the execute-capable verifier run arbitrary code with the
full parent environment (`env: { ...process.env, PWD, OLDPWD }`,
`src/worker/opencode.ts:57`), no network restriction, no secret scrubbing —
spec §14.4's provisions are unimplemented. The spec's own carve (§14 governs
execution capability, not output content; T-023/Known issue #6 admits a bash
escape "remains possible in principle") means injected instructions inside
target-repo content are one shell call from exfiltration. With
operator-chosen target repos this is acceptable-by-design; pointed at
untrusted corpora (the decompilation aspiration) it is RCE-by-design.
**Disposition: write the trust model down (decisions.md): trusted target
repo + trusted operator machine + trusted model endpoint, and gate any
untrusted-corpus work on §14's mechanisms actually existing.**

### R2 — Target-repo-tracked secrets flow through every artifact `decision` · [code-read]

Worktrees are full checkouts: any secret tracked in the target repo is
present in every worktree, quotable in every diff, printable in every log,
and carried into report.json/the store/the dashboard. §14.4 covers
orchestrator secrets, not target-tracked ones. **Disposition: fold a sentence
into R1's trust-model entry.**

### R3 — Dashboard approvals write surface: CSRF / DNS-rebinding + a double-decide race `ticketed T-051` · [subagent]

`POST /approvals/decide` (`src/dashboard.ts:927-968`) has no Origin/Host
validation, no CSRF token — any webpage the operator visits can flip a
pending approval; DNS-rebinding defeats the 127.0.0.1 bind since Host is
never checked. Related: `decideApproval` reads row state before `BEGIN` and
updates unconditionally (`src/store/index.ts:691-706`) — two concurrent
decides both observe `waiting_for_approval` and leave one APPROVED and one
REJECTED event, last-write-wins on the row: precisely the rewritable audit
record the refusal promises can't happen. Cosmetic sibling: malformed
percent-encoding yields a 500, not a 400. XSS was checked and is clean.
**Disposition: small ticket — Host/Origin check, decide inside one
transaction with a guarded UPDATE.**

### R4 — Lock release never verifies ownership; recover's identity check fails open `ticketed T-052` · [code-read + subagent]

`releaseCheckoutLock` unlinks whatever occupies the path
(`src/lock.ts:121-127`): after a `--force-lock` takeover, the previous
holder's own `finally` deletes the NEW holder's lock — mutual exclusion
breaks in exactly the scenario `--force-lock` exists for. Sibling:
`recover`'s `identityMatches` returns ok whenever creation-time lookup is
unavailable (`src/recover.ts:258-273` — PowerShell missing/blocked/AV),
so on such a machine a reused pid can name an unrelated live process that
recover then tree-kills. **Disposition: ticket — release verifies holder pid
before unlinking; identity-unavailable degrades to refuse-to-kill (gc's
refusal direction).**

### R5 — Second-order prompt-injection channels into planner and worker prompts `ticketed T-061` · [code-read + subagent]

Two bounded but unaudited pipes carry adversary-influenced text into
prompts: (a) the round composer renders reviewer findings — which routinely
quote worker-authored diffs/logs — verbatim into the round-2 planner prompt
(`src/rounds.ts:109-133`), so a worker can launder instructions through the
reviewer's trusted voice; (b) the retry brief embeds each failing gate's
4,000-char `outputTail` (test names, assertion messages — target-repo
influenced) into the worker prompt (`src/runner.ts:827-835`). Not
verdict-affecting; corrupts the planning tier. **Disposition: ticket — a
delimiting discipline (fenced, length-capped, role-labeled blocks) for
model-bound embedded evidence; the composer already excludes gate tails,
which shows the discipline exists one layer short.**

## 2. Engine semantics

### R6 — `passedAllGates` ignores `workerOk`: a timed-out worker can be a survivor `decision` · [code-read]

A worker killed at the deadline whose partial edit passes gates records
`passedAllGates: true` (`src/runner.ts:1201`) while the summary prints
`WORKER FAILED` (`src/cli.ts:580`) and `integrate` accepts it
(`src/integrate.ts:196` checks only `passedAllGates`). Arguably defensible
("the diff and gates are the evidence"); the three consumers currently
disagree with each other, which is not. **Disposition: dated decisions.md
entry either way, then align the summary/integrate text.**

### R7 — Store evidence gaps `partially ticketed (R7a → T-057)` · [subagent]

(a) Duplicate gate names within one job: `gate_results` keys on
`(run_id, candidate_id, gate_name)` with upsert, and `parseJobsSpec`
enforces unique probe ids but not gate names — two gates named `build`
leave only the last in the store (an all-pass table for an eliminated
candidate is possible). (b) Attempt-scoped gate results and verifier blocks
exist only in report.json (the T-038/T-039 recorded caveats). (c) Re-ingest
is idempotent on rows but append-only on events — re-ingesting grows
`events` without bound. (d) A recover rerun after a crash between
abandonment-commit and recovery.json hits a PK conflict and reports
`dbFailed` noise. **Disposition: ticket(s) — (a) is a parser refusal plus a
check; (b)–(d) as measured.**

### R8 — The no-gates warning lies `ticketed T-064 (the T-043 fold vehicle landed without it; line still present, verified 2026-10-26)` · [code-read]

`src/cli.ts:488-489` warns "every candidate passes vacuously" with no gates,
but the ladder requires `gates.length > 0` (`src/runner.ts:1201`) — everyone
FAILS. **Disposition: fold into the next cli-touching ticket (T-043 is the
likely vehicle).**

### R9 — Brief padding: N candidates on one sample `ticketed T-056` · [code-read]

`parseBriefs` pads short planner arrays by cyclic repetition
(`src/parse.ts:58-59`) and truncates over-long ones silently; "distinct"
briefs are prompt-only. A 1-brief reply for 4 candidates buys the same
sample four times at full token cost. **Disposition: ticket — refuse (or
loudly record) when the parsed count ≠ requested count.**

### R10 — Boundary race misrecords a natural exit as a timeout `fold` · [subagent]

`timedOut = true` is set before the just-exited check in both timed-run
cores; a clean exit-0 at the deadline is recorded `timedOut: true`,
exit null, `ok: false`. Fail-closed but wrong. **Disposition: fold into
T-046 (same two sites).**

### R11 — Unbounded in-memory output accumulation `ticketed T-058` · [code-read + subagent]

`collectText` in both adapters accumulates the entire stdout+stderr with no
cap (tail sliced only after full collection) beside the file drain — a
chatty candidate-controlled command OOMs the orchestrator itself. The probe
core caps each case at 16 MiB but concatenates ~20 cases into one
`writeFileSync` (≈320 MiB string build + sync write, per probe per
candidate). **Disposition: ticket — cap accumulation at the
`RESPONSE_TAIL_CHARS` scale; cap the probe's aggregate log write.**

### R12 — Silent evidence loss when log writes fail `ticketed T-053` · [code-read + subagent]

`appendLog`/`drain`/`appendLine` swallow all write failures with no
`cleanupFailures` entry — a run can pass with a completely empty worker.log
and nothing in the record saying evidence was lost. **Disposition: ticket —
one recorded cleanup-failure line on first write failure (the existing
vocabulary).**

## 3. Operational & effectiveness

### R13 — Dependency provisioning: no story, and the demo fixture hides it `decision` · [code-read]

Nothing in `src/` installs or provisions dependencies; gates must work on a
bare worktree checkout. The fixture is dependency-free by construction
(`scripts/demo-target.mjs`). The first real JS repo either fails gates
instantly (which T-043 will at least name loudly) or needs
`npm install`-per-worktree-per-attempt (minutes × candidates × attempts,
network flakiness, per-candidate supply-chain exposure). Spec §13's manifest
and §16.2's disposable-dirs are unimplemented. T-047 deliberately carves
this. **Disposition: the §13 manifest design decision — T-047's
ignored-path evidence should feed it measurements.**

### R14 — The planner is repo-blind `ticketed T-059` · [code-read]

`plannerPrompt` carries goal + count (+ round-2 block) and the planner's cwd
is a scratch dir — no repo path, no file tree (`src/runner.ts:428-451,
526-535`). Briefs cannot reference real modules or conventions; "fully
specified" is aspirational when the specifier cannot see the code. The §7
context system is built but has no producer wired to the planner
(the T-034/T-037 `context_plan_json` null precedent). **Disposition:
ticket when a context producer lands — a file-tree/manifest digest in the
planner prompt is the minimal version.**

### R15 — Small operational edges `monitor` · [code-read]

- `runId` is second-resolution; two runs against different repos (locks are
  per-repo) in the same second share one artifacts dir.
- Gates run through `exec` → cmd.exe on Windows, `/bin/sh` elsewhere: the
  same `--gate` string is shell-dialect-dependent.
- Default gate timeout is 5 minutes; any install-running gate dies there
  (ties into R13).
- Prompts ride in argv and are visible in process listings — **resolved as
  a side effect of T-042's no-prompt-bytes-in-argv acceptance criterion**;
  listed so the residual is tracked to its fix.

### R16 — Adversarial-probe semantics misread correct validation as failure `ticketed T-062` · [subagent]

Survival = spawned cleanly + exit 0 (`src/probe.ts:1622-1628`): a target
that never reads argv survives all 20 cases (undetectable no-op handler),
while a well-behaved CLI that validates input and exits 1 on `'{"a":'` is
recorded `crashed-exit`/`success:false` — and `rounds.ts:129` renders that
as "failed" into the round-2 planner prompt, systematically bad-mouthing
the candidates that validate. Never a verdict; corrupts planning evidence.
**Disposition: ticket — expected-outcome mapping per corpus case (reject vs
crash), or at minimum stop rendering exit-1-on-bad-input as failure.**

### R17 — TAP fallback counts spoofable lines `monitor` · [subagent]

`parseTapSummary` (`src/probe.ts:869-894`) counts every `ok`-shaped stdout
line and any `# pass N` line — target stdout can inflate recorded
measurements. Exit code stays the honest part. **Disposition: monitor;
measurement pollution only.**

### R18 — Probe-layer defense-in-depth is claimed but absent at two seams `ticketed T-063` · [subagent]

`ScreenshotProbe`'s docblock says it holds the capture-path contract for
directly constructed scenarios; `captureRefusal` only checks non-empty
string (no absolute-path/`..` refusal — those live only in
`parseJobsSpec`), so a hand-built scenario can read/copy an arbitrary
PNG-magic file out of the worktree. Same class: evidence bundle paths are
built from unvalidated probe/candidate ids. In-pipeline specs are guarded.
**Disposition: ticket — move/duplicate the refusal into the probe classes,
or fix the docblocks to stop claiming the contract.**

## 4. The assumption audit (strategic)

These are properties of the design's bets, not defects in code; recorded so
they are consciously chosen rather than drifted into.

### A1 — The gate-content bet is the central risk `decision`

Every guarantee reduces to "the operator wrote a shell command that
mechanically detects goal-completion." For goals where that check can be
written, the specification work is already done (the planner re-derives it
worse — see R14); for goals where it cannot, gates degenerate to
build + regression = baseline preservation, which a comment-plus-trivial
diff satisfies. The probe/verifier/ratchet are the honest partial answers —
advisory and cross-run. Direction worth deciding: **gate authoring as the
product surface** (assisted drafting of a goal-checking gate before the
run; seeded hidden-test corpora for domains like decompilation where
round-tripping is mechanical).

### A2 — Worker derailment is the binding constraint; the engine adapts nothing per-run `ticketed T-049/T-050 + T-060` (instrument + the 2026-10-23 premise-mismatch mechanism's guard + the worker orientation block attacking the path-confusion classes prompt-side)

The recorded failure classes say so (Known issue #6's NO-OP pairs; the
T-040 saga's two 5-second exit-0 legs; the budget-kill ledger in #12).
Every attempt dispatches a byte-identical prompt (retry legs aside); no
per-model derailment signal is measured or fed back across runs. The
spec's economics premise (§1, "millions of tokens is the search
algorithm") only bites when legs produce diffs at a reasonable rate.
**Disposition: instrument yield-per-run (survivors/tokens,
non-no-op-attempt rate) before scaling anything.**

### A3 — Single-box serialization caps throughput `by-design`

Per-repo checkout lock = one run at a time per target; gates are local
CPU-bound and contend across concurrent candidates (timing-sensitive gates
flake under load, nothing isolates them); Windows Defender/indexer churn on
worktree add/remove adds latency. Not a bug at Stage 0's scale; the ceiling
to remember before interpreting "more candidates" as free parallelism.

### A4 — Survivors are alternatives, never parts `by-design`

Composition is deferred (T-033) and R9's identical-brief padding plus
planner fallback mean N candidates frequently buy ~1 independent sample.
The recorded 2-round run showed "NOTHING" as its improvement signal —
until the T-033 re-entry conditions fire, `--rounds 2` is a token
multiplier, not a search widening. Track against T-033's staged question.

### A5 — The trust model is unwritten `decision`

Merges with R1/R2: the system assumes a trusted target repo, a trusted
operator machine, and a trusted model endpoint, and this is fine and true
today — but two stated ambitions (untrusted decompilation corpora;
per-role external harnesses) each break one assumption. One decisions.md
entry covers R1, R2, and this.

---

## Verified clean (do not re-litigate without new evidence)

The verdict ladder reads only `passed` and `diffBytes` — no model opinion,
parse failure, or swallowed error flips a verdict (checked across runner,
store ingest, integrate, rounds). All SQL parameterized. All engine
subprocess spawns list-form. Dashboard HTML escaping (XSS-clean).
`src/context.ts`/`context-inspect.ts` fail-closed with strict parsing.
Binary-safe diff capture/replay round-trips. Parse-repair additions
structurally inert on previously-parsing input. The ratchet boundary
(no model-authored check gates its own run) holds by construction.
