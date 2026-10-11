# ROADMAP

Status distilled from the V2 spec (`docs/spec/inference-refinery-v2.md`, §34 MVP
sequence). This file is the canonical status page; update it in the same change that
moves a milestone.

| Stage | Milestone | Status |
|---|---|---|
| 0 | Walking skeleton: planner→briefs→N worktree workers→gates→report | **done 2026-10-10** (verified: vague goal → 3 diverse briefs → 3 passing implementations) |
| 0.5 | Reviewer tier: planner-model reads surviving diffs, produces advisory observations (gates still decide) | done 2026-10-11 — T-001 |
| 0.5 | Run artifact cleanup automation (worktrees/branches; checkout lock deferred) | done 2026-10-10 — T-002; lock landed 2026-10-11 — T-004 |
| 1 | Durable local control plane: SQLite, job DAG, attempts, retries, approval gates, event log | first slice landed 2026-10-11 (SQLite state + event log — T-003); remaining: job DAG, attempts, retries, approvals, scheduler |
| 1.5 | Integration replay: survivor's diff.patch re-verified at current HEAD (spec §17 slice; prepares only — humans merge) | done 2026-10-11 — T-005 (pulled forward from stage 6; token-free) |
| 2 | Context system: ContextPlan/ContextPacket, budgets, distillation, lineage | spec Milestone 2 — required before large fan-in |
| 3 | Windows reliability: worktree leases/GC, process-tree kill hardening, crash recovery | spec Milestone 3 |
| 4 | Probe layer: command/test/benchmark/screenshot probes, then Godot | spec Milestone 4 |
| 5 | Codex/Sol worker adapter (read-only verifiers first) | spec Milestone 5 |
| 6 | First full R&D loop (small fan-out per spec Milestone 6) | spec Milestone 6 |
| 7 | UI (run dashboard, DAG, context inspector, approval queue) | spec Milestone 7 — last |
| 8 | Generations, adversarial probes, early stop | spec Milestone 8 |

Deliberately deferred: memoization (spec §19), multi-generation adversarial loops.

Local-model endgame (3090 / Qwen / local GLM) requires no roadmap item: it is a new
worker config on an OpenAI-compatible endpoint, not a subsystem.
