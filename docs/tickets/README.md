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
| T-016 | Filesystem artifact store: artifacts + probe_runs records, hash-at-ingest, re-verification | high | proposed |
| T-017 | MachineWorker adapter: deterministic-command worker behind WorkerAdapter (spec §5.3, §34) | high | proposed |
