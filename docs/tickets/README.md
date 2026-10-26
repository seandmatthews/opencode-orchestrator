# Tickets

One file per ticket: `T-NNN-slug.md`. Sequential two-digit numbers, never reused.
One ticket = one mergeable change-set. The durable record is the ticket file; there is
no separate tracker.

Format (matches the pigeon-simulator / dnd-campaign-generator convention):

```markdown
# T-NNN — Title

**Status:** proposed | doing | done | blocked | superseded (T-YYY)
**Category:** engine | adapters | verification | docs | ops
**Value (1-5):** n · **Risk (1-5):** n
**Depends on:** —

## What
## Why
## Acceptance criteria
- [ ] each criterion names the gate or check that pins it
## Landed
(added when done: what actually changed, deviations, measured gate numbers)
## Verification
(references into VERIFICATION.md gates)
```

Rules:

- Acceptance criteria are test-nameable. Human-judgement items say so explicitly and
  name the manual check.
- Status lives in the ticket **and** in the index below, updated in the same change.
- `done` tickets keep their file with a filled `## Landed` section. If a ticket is
  abandoned or superseded, say so in its status — history stays.
- Every feature change extends `VERIFICATION.md` in the same change-set.

## Index

| ID | Ticket | Priority | Status |
|---|---|---|---|
| T-001 | Reviewer tier: advisory post-gate review | high | done 2026-10-11 |
| T-002 | Run artifact cleanup automation | high | done 2026-10-10 |
| T-003 | Durable run records: SQLite store + event log | high | done 2026-10-11 |
| T-004 | Cross-run checkout lock: runs and cleanup serialize per target repo | medium | done 2026-10-11 |
| T-005 | Integration replay: re-verify a survivor's diff at current HEAD | medium | done 2026-10-11 |
| T-006 | Job DAG: phase/job tables, DAG validation, `dag` dump CLI | high | done 2026-10-16 |
| T-007 | Attempt records + bounded same-config retry | high | done 2026-10-16 |
| T-008 | Approval gates: durable records, `approvals` decide CLI, pending queue | high | done 2026-10-16 |
| T-009 | Deterministic scheduler core: minimal job spec, DAG-driven execution | high | done 2026-10-16 |
| T-010 | Startup reconciliation: abandoned attempts, process-tree sweep, retry disposition | high | done 2026-10-16 |
| T-011 | In-run process-tree termination hardening (spec §15.3) | high | done 2026-10-16 |
| T-012 | Context system core: ContextPlan/ContextPacket, budgets, selectors, fingerprints, `context inspect` CLI | high | done 2026-10-16 |
| T-013 | Shard distillation core: DistillationPlan semantics, distilled-claim records, §7.5 no-untraceable-chain refusal | high | done 2026-10-17 |
| T-014 | Packet-level source lineage: builder-input ref enforcement + claim-chain inspection | medium | done 2026-10-17 |
| T-015 | Probe layer first slice: Probe seam, EvidenceBundle contract, command + test probes | high | done 2026-10-17 |
| T-016 | Filesystem artifact store: artifacts + probe_runs records, hash-at-ingest, re-verification | high | done 2026-10-17 |
| T-017 | MachineWorker adapter: deterministic-command worker behind WorkerAdapter (spec §5.3, §34) | high | done 2026-10-17 |
| T-018 | Benchmark probe: repeated measured command → quantitative EvidenceBundle (per-run durations + min/median/p95) | medium | done 2026-10-17 |
| T-019 | Screenshot artifact probe: capture-command → validated image EvidenceBundle (spec §34:2069, §12) | medium | done 2026-10-17 |
| T-020 | Worktree lease GC: orphaned worktree + `swarm/*` branch reconciliation and disposal (spec §16, §34 M3) | high | done 2026-10-18 |
| T-021 | §15.4 explicit long-path tests: engine path-budget pin at MAX_PATH depth (spec §15.4, §34 M3) | medium | done 2026-10-18 |
| T-022 | Disposable clones deferred: WorktreeProvider stays the only WorkspaceProvider (spec §3.6, §14, §34 M3) | medium | done 2026-10-18 |
| T-023 | Planner/reviewer capability restriction: §14 execution policy at the WorkerAdapter seam (spec §3.6, §14, §34 M5) | high | done 2026-10-18 |
| T-024 | Web/server probe: launch target → bounded readiness poll → HTTP status + body-snippet evidence → verified teardown (spec §12.1, stage-4 breadth) | high | done 2026-10-18 |
| T-025 | Per-role harness selection for the advisory roles: `--planner-worker`/`--reviewer-worker` + their machine command flags (spec §6.6:397-415, §11.1:875) | medium | done 2026-10-18 |
| T-026 | Binary-safe diff capture: `git diff HEAD --binary` end to end (closes T-005 carve #2; spec §16.1:1148, §17.2:1185) | high | done 2026-10-19 |
| T-027 | Recorded gate commands in report.json: `GateResult.command` end to end (closes T-005 carve #1; spec §17.3:1192, §9.1:700) | high | done 2026-10-19 |
| T-028 | Store-backed integrate: verify-when-recorded diff evidence + store-recorded replay verdicts (closes T-005 carve #5; spec §17.3:1192, §29:1877) | high | done 2026-10-19 |
| T-029 | Worker prompt version: `Attempt.promptVersion` producer — hash-at-composition of the builder prompt (closes T-007's reserved null producer; spec §6.7:446, §18:1207) | medium | done 2026-10-20 |
| T-030 | Bounded R&D loop: survivor-evidence feedback rounds (`--rounds`) + the T-012-reserved packet→prompt composer (ROADMAP stage 6; spec §34 M6 composition, M8 feedback edge) | high | done 2026-10-20 |
| T-031 | Phase-level early stop: `EarlyStopPolicy.minSurvivors` on the `--jobs` spec — stop dispatching, never kill, record the stop (spec §20, §34 M8) | medium | done 2026-10-20 |
| T-032 | Adversarial probe: seeded fuzz cases fed over argv → crash/survival EvidenceBundle (spec §34:2139 M8, §24 Phase 9; fills T-030:95's carve) | high | done 2026-10-21 |
| T-033 | Multi-generation feedback loops deferred: `--rounds` stays 1..2 (ROADMAP stage 8; spec §20, §34 M8) | medium | done 2026-10-20 |
| T-034 | Run dashboard first slice: local read-only HTTP view over the recorded store — runs, gates, evidence pointers, DAG, approval queue + decide (spec §26.1/§26.2/§26.6, §34 M7; ROADMAP stage 7) | medium | done 2026-10-21 |
| T-035 | Job drill-down: per-job pages over the recorded store — job row, verdict, gate results, attempt history, probe runs (extends T-034's dashboard; spec §26.2, §34 M7; ROADMAP stage 7) | medium | done 2026-10-21 |
| T-036 | Commit identity: history rewritten to matthews.sean.d@gmail.com — filter-branch over main, repo-local config, saved workflows de-hardcoded (repo meta; no engine change) | low | done 2026-10-21 |
| T-037 | Run context page: per-run context evidence — attempts' `input_context_hash` + the report.json rounds block, producer-less §26.4 fields marked (extends T-034/T-035; spec §26.4; ROADMAP stage 7) | medium | done 2026-10-21 |
| T-038 | Bounded gate-failure retry: `--gate-retry` — one feedback-informed attempt composed from the gates' own recorded output; blind re-rolls stay banned; decisions entry in-ticket (spec §24:1462, §30:1893) | high | done 2026-10-22 |
| T-039 | Verifier role: active pre-disposition verification — `--verifier-model`, execute-capable read posture, findings cite the commands they ran, never verdicts; ratchet-boundary decisions entry in-ticket (spec §10.1, §6.6:426, §9.2) | high | done 2026-10-21 |
| T-040 | Verifier findings ride the retry brief: the pre-retry verifier call site + the composition seam joining T-038/T-039; gates stay the only verdict input (spec §24:1462, §9.2) | medium | done 2026-10-22 |
| T-041 | The ratchet: finding→gate promotion — human-owned, ticket-carried, never same-run; convention + one cross-run fixture proof (spec §32) | medium | done 2026-10-21 |
| T-042 | Prompt transport off argv: OpenCode adapter stops passing prompts as a command-line argument (Windows 32,767-char spawn ceiling kills large retry briefs) | high | done 2026-10-23 |
| T-043 | Baseline gate sanity: gates proven green on the untouched base before dispatch; `--allow-red-base` override (red-base runs refuse before any model tokens) | high | done 2026-10-23 |
| T-044 | Evidence-destruction guard: diff capture pins baseSha not HEAD + `swarm/*` branch deletion refuses non-base tips (a worker `git commit` no longer becomes a silent NO-OP + branch −D) | high | done 2026-10-23 |
| T-045 | Gate/diff overlap evidence: flag when a candidate diff touches files its gate commands execute (evaluator-tampering signal, never a verdict) | medium | done 2026-10-23 |
| T-046 | Post-kill settle deadline: bounded wait after the verified tree kill — loud abandonment instead of a wedged run + never-reaped lock (worker core + probe core) | high | done 2026-10-23 |
| T-047 | Ignored-path parity evidence: ignored-tree snapshot per attempt + integrate parity note (first slice of the .gitignore blindness; provisioning/detection carved) | medium | done 2026-10-23 |
| T-048 | Clean's dirty predicate: refuse on uncaptured changes, not on captured evidence (evidence-parity comparison against the stored diff.patch) | medium | done 2026-10-23 |
| T-049 | Yield instrumentation: a machine-derived per-run yield block + evidence-only derailment markers — the A2 measuring stick (adversarial review 2026-10-23 §4) | high | done 2026-10-24 |
| T-050 | Round-2 brief-premise guard: composer framing fix + mechanical brief annotation (the Known issue #6 2026-10-23 mechanism — briefs must not assume survivor-created files exist at base) | high | done 2026-10-24 |
| T-051 | Dashboard write surface: Host/Origin validation + the approvals double-decide race closed by a guarded UPDATE (register R3) | medium | done 2026-10-24 |
| T-052 | Lock release verifies ownership; recover's identity check fails closed — refuse-to-kill when identity cannot be established (register R4) | medium | done 2026-10-24 |
| T-053 | Log-write loss made loud: first-failure-per-path cleanup evidence through the T-011 channel (register R12) | low | done 2026-10-24 |
| T-054 | Known issue #10's owed code change: a provably-dead tree stops being reported as a cleanup failure — the captured fifth observation's fix | medium | done 2026-10-25 |
| T-055 | Verify-root evidence retention: verify:full archives prior Gate 2 run dirs instead of rmSync-ing them (the T-049 wiped-citation incident) | medium | done 2026-10-25 |
| T-056 | Brief-count honesty: no silent cyclic padding — an under/over-count planner reply is a parse failure into the existing fallback (register R9) | medium | done 2026-10-26 |
| T-057 | Duplicate gate names refused at parse time: the store's last-write-wins can no longer drop gate evidence (register R7a) | low | proposed |
| T-058 | Bounded output accumulation: capped tail buffers in both adapters + capped probe log aggregate — a chatty child can no longer OOM the orchestrator (register R11) | medium | proposed |
