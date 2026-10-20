# T-029 — Worker prompt version: `Attempt.promptVersion` producer — hash-at-composition of the builder prompt (closes T-007's reserved null producer; spec §6.7:446, §18:1207)

**Status:** proposed
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** T-007 (whose reserved null this closes; T-003's store already carries the column)

## What

Make `Attempt.promptVersion` (src/types.ts:226, `string | null`, hardcoded `null` at
its only construction site, src/runner.ts:476) the **sha256 hex of the exact builder
prompt text sent to the adapter**, derived at composition time — never looked up
(there is no registry to look up; the §27 `prompt_versions` table is deliberately
not built here).

Change-set:

1. **src/runner.ts, `runJob` attempt loop** — hoist the prompt composition above
   the Attempt construction: today the Attempt is built at src/runner.ts:469-478 and
   the prompt is composed inline in the execute request at :496. New shape:
   `const prompt = builderPrompt(job.brief, lease.path)` first, then
   `promptVersion = createHash('sha256').update(prompt).digest('hex')` at that same
   composition point, then `attempt.promptVersion = promptVersion` (:476 stops being
   `null`). The **same variable** feeds both the hash and the `prompt:` field of the
   `worker.execute` call, so the hashed text and the sent text cannot drift — that is
   what "derived at composition time" means here, mechanically satisfied.
2. **Design decision — exact-text hash, not a workspace-normalized template hash.**
   The exact builder prompt embeds the lease path (`  ${workspacePath}`,
   src/runner.ts:118) whose runDir contains the timestamped runId, and retry attempts
   lease fresh paths (`wt/<id>-a<n>`, src/runner.ts:462) — so exact-text hashes are
   unique per attempt by construction and never equal across runs or across retry
   attempts. That is the point, not a defect: cross-attempt *input* comparability is
   already owned by `inputContextHash` (src/runner.ts:414-420 — sha256 over brief +
   model + the prompt with the workspace-path line EXCLUDED, identical across
   same-brief attempts, pinned by Gate 1.8). A second normalized hash would duplicate
   `inputContextHash` minus its brief+model inputs while stopping the one pin nothing
   else provides: the exact bytes the adapter received at send time. The two fields
   answer different questions — `inputContextHash`: "was this attempt asked the same
   thing as that one?"; `promptVersion`: "is this the hash of the exact text that
   produced this attempt's evidence?" Both stay audit provenance; neither ever
   touches a verdict (decisions.md 2026-10-10: machine gates decide survival; models
   advise).
3. **No store change** — `attempts.prompt_version` (src/store/index.ts:161, nullable)
   and the ingest upsert copy (`a.promptVersion ?? null`, src/store/index.ts:1105;
   ON CONFLICT update at :1092) already exist. The column lights up end-to-end with
   zero store edits.
4. **No adapter change** — adapters already receive `req.prompt` verbatim
   (src/worker/opencode.ts:45-49 passes it into argv and logs it elided as
   `<prompt: N chars>`; src/worker/machine.ts:55-59 logs it verbatim as a provenance
   header). Gate 3 stays n/a (ground rule 1: the engine stays model/harness-agnostic;
   versioning lives engine-side at the composition site).
5. **Doc coherence in the same change-set** — the Attempt doc comment
   (src/types.ts:212-213, today: "promptVersion is null until prompt versioning
   exists") and the VERIFICATION.md input-context-hash bullet
   (VERIFICATION.md:350-353, today ending "`promptVersion` is null on every
   attempt") become false and are updated; the composition-site comment documents the
   exact-text choice and the division of labor with `inputContextHash`.

What this ticket does NOT claim:

- **No planner/reviewer prompt versions** — carved to an explicit successor (see Why).
- **No §18 role@N registry, no §27 prompts/prompt_versions tables, no §26.8 Prompt
  Registry UI** — a bare content hash recorded per attempt is the whole slice.
- **No dispatch.jsonl change** — its four line shapes are pinned (Gate 1.11,
  VERIFICATION.md:553-570) and recovery never sees prompts, so abandoned-attempt
  rows keep their hardcoded NULL (src/store/index.ts:719-723, the T-010 recovery
  INSERT).
- **No context-system claim** — the §7.7 fingerprint's own `promptVersion` component
  stays producerless until a packet→prompt composer exists (T-012's documented
  reconciliation duty); Gate 1.13's null-component pins
  (scripts/check-context.mjs:270 and :304) are untouched.
- **No report-shape change** — `promptVersion` is already in report.json (as null);
  filling a value changes no key set anywhere.

## Why

Spec §6.7 defines `PromptArtifact` and requires "Every agent attempt records the
exact prompt version used" (docs/spec/inference-refinery-v2.md:434-446); §18 says
"Every role prompt is versioned" with role@N examples (:1205-1215); §3.5 is "Prompts
Are Product Assets" (:135-140); §6.5 types `Attempt.promptVersion` nullable (:388).
T-007 landed the field explicitly null, reserving exactly this: "null this slice —
§6.5 types it nullable; §6.7:446/§18:1207 have no producer until prompt versioning
exists" (docs/tickets/T-007-attempts-and-bounded-retries.md:37-39, and :176). T-012
narrowed the §7.7 fingerprint to components with producers, recording prompt version
as a null component and naming the reconciliation duty of "a later packet→prompt
composer" (docs/tickets/T-012-context-system-core.md:82-95). This ticket is the
worker-half successor those carves reserved.

The pain: the core audit trail (prompt → diff → gate verdicts) has its prompt leg
reconstructible but never pinned. For OpenCode workers the exact sent text exists
only transiently — the adapter logs it elided (`<prompt: N chars>`,
src/worker/opencode.ts:48) — and a post-hoc reconstruction from report.json (brief +
workspacePath) cannot prove it matches what was sent. Machine workers log the prompt
verbatim (src/worker/machine.ts:55-59) but nothing ties the logged text to the
attempt record. A send-time hash pins both with one mechanism, in the same posture
as T-011's `cleanupFailures` and T-015's probe evidence: recorded provenance that
never influences a verdict.

Why only the worker: the planner and reviewer roles have **no Attempt records** —
`PlannerReport.attempts` and `ReviewReport.attempts` are plain counts
(src/types.ts:234, :254) — so "recorded per attempt" for them means NEW per-execute-call
report fields (initial + repair: two prompts per role invocation, composition at
src/runner.ts:276/:308-317 and :350/:379-388). That flips Gate 1.20 S1's exact-key-set
pin ("no new report fields anywhere", VERIFICATION.md:1831-1833, pinned by
scripts/check-capabilities.mjs) and extends Gate 1.6's `planner_json`/`review_json`
round-trip pins (VERIFICATION.md:156-162) — a report-shape change on two more types
needing its own design pass. The reviewer prompt additionally embeds per-candidate
payload (diff + gate lines + workspace path, src/runner.ts:244-268), so its "version"
can never be stable across candidates — a within-run audit pin only. That is a
separate mergeable change-set; this ticket is one.

Value/Risk: 3/2 — closes a producer two landed tickets explicitly reserved and
hash-pins the worker prompt at send time; held below 4 because it changes no verdict
and unblocks no current consumer (§26.2 UI and §26.8 registry are later stages).
Risk is low: field, column, and store copy already exist; `promptVersion` is on no
verdict path; adapters untouched; the main technical risk was the design choice,
made and documented above.

## Acceptance criteria

- [ ] **Gate 1.8 S1 flip** (scripts/check-retry.mjs:165-166): the "promptVersion is
      null on every attempt" assertion is replaced by positive producer pins — every
      attempt's `promptVersion` is a 64-hex sha256 equal to an **independently
      recomputed** hash of the exact text the fake adapter received (the fake worker
      additionally records `req.prompt`; the check hashes that recording with
      `node:crypto` and never calls `builderPrompt` to build the expected value);
      and because the exact text embeds each attempt's lease path, attempt 1 and
      attempt 2 carry **different** `promptVersion` values while their
      `inputContextHash` stays **identical** (the existing :163-164 pin, unchanged) —
      pinning the normalization boundary between the two fields.
- [ ] **Gate 1.6 extension** (scripts/check-store.mjs): a new promptVersion-carrying
      attempt variant ingests into a fresh DB and asserts `attempts.prompt_version`
      equals the report value end-to-end (the upsert already copies it — today
      nothing exercises non-null). The existing hand-built retried-variant fixtures
      keep `promptVersion: null` (scripts/check-store.mjs:256, :266) and their
      producer-less nulls pin (:286-287, which also covers `process_identity`/
      `worker_session`, still producer-less) stay as-is.
- [ ] **Gate 1.13 stays green untouched** — scripts/check-context.mjs:270 (the four
      producerless §7.7 components recorded null, `promptVersion` among them) and
      :304 (`producers.promptVersion === null` in `context inspect --json`) pass
      unmodified; this ticket explicitly does not claim that component.
- [ ] **Recovery path unchanged** — abandoned-attempt rows keep `prompt_version`
      NULL (the recovery INSERT hardcodes it, src/store/index.ts:719-723);
      scripts/check-recovery.mjs pins no `prompt_version` (located by reading) and
      is not extended — the crash-evidence surface is stated out of scope, not
      quietly changed.
- [ ] **Doc coherence** — src/types.ts:212-213 (Attempt doc comment), the
      composition-site comment in src/runner.ts, and the VERIFICATION.md
      input-context-hash bullet (VERIFICATION.md:350-353) are updated in the same
      change-set; no existing check is weakened (ground rule 8).
- [ ] **Gate 1.20 S1 stays green untouched** — report.json key sets remain exact at
      every level (VERIFICATION.md:1831-1833): filling the already-typed
      `promptVersion` adds no key anywhere and scripts/check-capabilities.mjs passes
      unmodified.
- [ ] **Manual spot-check, explicit** — the Landed section records one real (or
      `verify:full`) run's report.json showing non-null `promptVersion` values on
      dispatched attempts, with retry attempts (if any) carrying distinct values; no
      fast-tier check can pin a real-model run, so this is a named manual check per
      the house rules.

## Verification

- Gate 0 (`npm run typecheck`) and the fast tier (`npm run verify` — Gate 0.5,
  including the flipped Gate 1.8 and the extended Gate 1.6) at every step.
- **Gate 2 once at landing** (`npm run verify:full`, ~3-5 min + tokens) —
  src/runner.ts and report shape are on its trigger list
  (VERIFICATION.md:2052-2054), and the change touches `runJob`'s attempt loop.
- Gate 3 n/a — no adapter file changes; adapters keep receiving `req.prompt`
  verbatim.

## References

docs/spec/inference-refinery-v2.md §6.7:434-446 (PromptArtifact; "Every agent attempt
records the exact prompt version used"), §18:1205-1215 (every role prompt versioned),
§3.5:135-140, §6.5:388 (nullable type), §27:1822 (`prompts`/`prompt_versions` tables —
deliberately not built), §26.8:1786-1799 (Prompt Registry UI — deliberately not
built). docs/tickets/T-007-attempts-and-bounded-retries.md:37-39, :176 (the
reservation this closes); docs/tickets/T-012-context-system-core.md:82-95 (§7.7
producerless components + packet→prompt-composer reconciliation duty — stands).
decisions.md 2026-10-10 (machine gates decide survival; the engine is
model/harness-agnostic — both honored by construction).
