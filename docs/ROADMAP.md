# ROADMAP

Status distilled from the V2 spec (`docs/spec/inference-refinery-v2.md`, §34 MVP
sequence). This file is the canonical status page; update it in the same change that
moves a milestone.

| Stage | Milestone | Status |
|---|---|---|
| 0 | Walking skeleton: planner→briefs→N worktree workers→gates→report | **done 2026-10-10** (verified: vague goal → 3 diverse briefs → 3 passing implementations) |
| 0.5 | Reviewer tier: planner-model reads surviving diffs, produces advisory observations (gates still decide) | done 2026-10-11 — T-001 |
| 0.5 | Run artifact cleanup automation (worktrees/branches; checkout lock deferred) | done 2026-10-10 — T-002; lock landed 2026-10-11 — T-004 |
| 1 | Durable local control plane: SQLite, job DAG, attempts, retries, approval gates, event log | **done 2026-10-17** — T-003 (SQLite + event log, 10-11), T-006 job DAG, T-007 attempts + bounded retries, T-008 approval gates, T-009 deterministic scheduler; Milestone 1's two leftovers closed: T-016 filesystem artifact store (artifact store + `probe_runs`, hash-at-ingest, re-verification) and T-017 MachineWorker adapter (deterministic-command worker behind WorkerAdapter) |
| 1.5 | Integration replay: survivor's diff.patch re-verified at current HEAD (spec §17 slice; prepares only — humans merge) | done 2026-10-11 — T-005 (pulled forward from stage 6; token-free) |
| 2 | Context system: ContextPlan/ContextPacket, budgets, distillation, lineage | **done 2026-10-17** — T-012 core (ContextPlan/Packet, budgets, selectors, fingerprints, `context inspect`), T-013 shard distillation, T-014 packet-level source lineage |
| 3 | Windows reliability: worktree leases/GC, process-tree kill hardening, crash recovery | partial 2026-10-18 — T-010 startup reconciliation, T-011 process-tree kill, T-020 worktree lease GC (`npm run gc`: orphan classification over dispatch/recovery evidence + the `--clean` `swarm/*` branch-sweep fix; durable lease records carved — dispatch.jsonl carries the lease identity); remaining: retention policies (§16.1 graded classes), short-path run roots |
| 4 | Probe layer: command/test/benchmark/screenshot/web probes, then Godot | partial 2026-10-18 — T-015 first slice (Probe seam, EvidenceBundle contract, command + test probes, `--jobs` `probes` wiring, Gate 1.15), T-018 benchmark probe (per-run durations + nearest-rank min/median/p95, `report` results artifact, Gate 1.15 extended), T-019 screenshot probe (capture-command → validated PNG under the run artifacts dir, `screenshot` artifact kind, Gate 1.15 extended), T-024 web/server probe (launch → bounded readiness poll → HTTP status + body-snippet capture → verified teardown, `report` response artifact, Gate 1.15 extended); remaining: Godot/Blender + browser-automation Web proper (§12.1) |
| 5 | Codex/Sol worker adapter (read-only verifiers first) | spec Milestone 5 |
| 6 | First full R&D loop (small fan-out per spec Milestone 6) | partial 2026-10-20 — T-030: the bounded R&D loop demonstrably running end to end (`--rounds 2`: round-1 gate survivors composed by the T-012-reserved packet→prompt composer (`src/rounds.ts`) into the round-2 planner prompt; fresh `<survivorId>-r2` candidate wave at the same base SHA; additive `rounds` report block; gates decide every round) — M6-shaped composition of parts that all exist with the M8 feedback edge worn early, bounded to n=2; remaining for literal M6/M8: researcher/distiller/synthesizer roles (stage 5's read-only workspaces), the Sol verifier per survivor (Codex adapter), candidate lineage/generations, run-/generation-level stop conditions (the phase-level early stop landed, T-031), in-run approval pause |
| 7 | UI (run dashboard, DAG, context inspector, approval queue) | spec Milestone 7 — last |
| 8 | Generations, adversarial probes, early stop | partial 2026-10-21 — early stop → T-031 (done 2026-10-20: phase-level `EarlyStopPolicy.minSurvivors` only; run-/generation-level conditions carved to successors); adversarial probes → T-032 (done 2026-10-21: the seeded adversarial probe — replayable fuzz cases over argv → crash/survival EvidenceBundle with the seed-recomputable case list, evidence never a verdict, Gate 1.15 extended); remaining: bounded generation loops + candidate lineage → deferred (decisions.md 2026-10-20) |

Deliberately deferred: memoization (spec §19), multi-generation adversarial
loops (decisions.md 2026-10-20 — `--rounds` stays 1..2; re-enters on a
demonstrated round-2 recovery, the generation-loop stop conditions, or
candidate lineage),
disposable clones (decisions.md 2026-10-18 — `WorktreeProvider` stays the only
`WorkspaceProvider`; re-enters with stage 5's read-only roles or a demonstrated
worktree failure class).

Local-model endgame (3090 / Qwen / local GLM) requires no roadmap item: it is a new
worker config on an OpenAI-compatible endpoint, not a subsystem.
