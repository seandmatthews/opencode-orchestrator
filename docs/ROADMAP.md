# ROADMAP

Status distilled from the V2 spec (`docs/spec/inference-refinery-v2.md`, §34 MVP
sequence). This file is the canonical status page; update it in the same change that
moves a milestone.

| Stage | Milestone | Status |
|---|---|---|
| 0 | Walking skeleton: planner→briefs→N worktree workers→gates→report | **done 2026-10-10** (verified: vague goal → 3 diverse briefs → 3 passing implementations) |
| 0.5 | Reviewer tier: planner-model reads surviving diffs, produces advisory observations (gates still decide) | done 2026-10-11 — T-001 |
| 0.5 | Run artifact cleanup automation (worktrees/branches; checkout lock deferred) | done 2026-10-10 — T-002; lock landed 2026-10-11 — T-004 |
| 1 | Durable local control plane: SQLite, job DAG, attempts, retries, approval gates, event log | **done 2026-10-16** — T-003 (SQLite + event log, 10-11), T-006 job DAG, T-007 attempts + bounded retries, T-008 approval gates, T-009 deterministic scheduler (spec Milestone 1's filesystem artifact store formalization and a MachineWorker adapter remain unticketed) |
| 1.5 | Integration replay: survivor's diff.patch re-verified at current HEAD (spec §17 slice; prepares only — humans merge) | done 2026-10-11 — T-005 (pulled forward from stage 6; token-free) |
| 2 | Context system: ContextPlan/ContextPacket, budgets, distillation, lineage | core landed 2026-10-16 — T-012 (ContextPlan/Packet, budgets, selectors, fingerprints, `context inspect`); remaining: shard distillation, source lineage |
| 3 | Windows reliability: worktree leases/GC, process-tree kill hardening, crash recovery | partial 2026-10-16 — T-010 startup reconciliation, T-011 process-tree kill; remaining: worktree leases/GC, retention policies, disposable clones, short-path run roots |
| 4 | Probe layer: command/test/benchmark/screenshot probes, then Godot | spec Milestone 4 |
| 5 | Codex/Sol worker adapter (read-only verifiers first) | spec Milestone 5 |
| 6 | First full R&D loop (small fan-out per spec Milestone 6) | spec Milestone 6 |
| 7 | UI (run dashboard, DAG, context inspector, approval queue) | spec Milestone 7 — last |
| 8 | Generations, adversarial probes, early stop | spec Milestone 8 |

Deliberately deferred: memoization (spec §19), multi-generation adversarial loops.

Local-model endgame (3090 / Qwen / local GLM) requires no roadmap item: it is a new
worker config on an OpenAI-compatible endpoint, not a subsystem.
