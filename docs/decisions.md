# Decisions — locked

Cite these; do not relitigate them in tickets or reviews. A new decision that
contradicts one of these must first rewrite its entry here, with a date and a reason.

- **2026-10-10 — TypeScript on Node 22.** The domain is JSON-schema-shaped artifacts
  and churn-heavy policies; `opencode-ai` is an npm dependency (spawned as a real exe
  from `node_modules/opencode-ai/bin/`); the future dashboard shares the language.
  Rust remains available for a small native Windows Job Objects helper if
  `taskkill /T /F` ever proves insufficient.
- **2026-10-10 — The engine is model/harness-agnostic, everything behind interfaces.**
  User directive. Model-to-role mapping is configuration, never engine code. Only
  harness bet long-term: OpenCode (it is open and will likely survive). Codex is fine
  for now, strictly as a future adapter (its CLI currently lives only in WSL at
  `/home/sean/.local/bin/codex`).
- **2026-10-10 — Two-tier defaults for testing:** planner `zai-coding-plan/glm-5.3`,
  workers `zai-coding-plan/glm-5.3-flash`. Cheaper smart-tier models and local
  endpoints replace these by config alone.
- **2026-10-10 — Machine gates decide survival; models advise.** Spec §3.2. Gate =
  shell command, exit 0 passes. A zero-byte diff is a NO-OP verdict, never a pass
  (learned: gates blessed untouched worktrees during the PWD incident).
- **2026-10-10 — Mechanism over prompts for isolation.** PWD/OLDPWD pinned to the
  contracted cwd in the adapter (spec §3.6, §14). Prompt statements of policy are
  defense-in-depth, never the boundary.
- **2026-10-10 — Run root is `C:\swarm\`.** Short paths per spec §15.4; fixture at
  `C:\swarm\demo-target`, run artifacts at `C:\swarm\<runId>\`.
- **2026-10-10 — Process docs mirror the dnd-campaign-generator / pigeon-simulator
  culture:** README + AGENTS.md + VERIFICATION.md split, tickets as the durable
  record, verification extended in the same change-set, Windows-first hygiene
  (list-form subprocess, .gitattributes, known-issues ledger).
- **2026-10-18 — Disposable clones are deferred; `WorktreeProvider` is the only
  `WorkspaceProvider` (T-022).** The `WorkspaceProvider` seam (`src/types.ts:78-85`,
  the lease/diff/dispose interface) keeps exactly one implementation,
  `WorktreeProvider` (`src/workspace/worktree.ts:61-86`), hard-wired at its single
  construction site (`src/cli.ts:333`). No clone provider, no provider factory, no
  `--workspace` flag until a consumer exists. Re-entry conditions — either one
  reopens this through a new dated entry that rewrites this one (the mechanism at
  the top of this file), never a relitigation: (a) a read-only role lands — spec
  §10's verifiers (`:769` deep code verifier "Read-only", `:788` security auditor,
  `:809` UI/visual verifier), §14.1:1016's researchers, §14.2:1023's
  `{ type: "disposable-clone-readonly" }` policy, §34:2094's Milestone-5
  "read-only workspace where applicable" — i.e. ROADMAP stage 5; or (b) a
  demonstrated worktree failure class the worktree machinery cannot absorb.
  Neither exists today. A future clone ticket must reconcile this
  integration-cost inventory:
  - **Disposal**: `clean` refuses a target that "exists but is not a registered
    git worktree" (`src/clean.ts:198`) — a clone workspace is not one, so a clone
    dispose face is new code in every disposal path, and it must re-implement the
    evidence-never-deleted / dirty-refusal rule (`src/clean.ts:6-8`, pinned by
    Gate 1.5, VERIFICATION.md:43-47).
  - **Recovery**: `sniffRepo` reads the worktree `.git` pointer *file*
    (`src/workspace/worktree.ts:24-32`); a clone's `.git` is a directory, the
    read throws, the catch returns null, and `recover` exits 1 "cannot determine
    the target repository" (`src/recover.ts:452-456`). Predicted from read code,
    not yet reproduced against a real clone — the successor ticket builds that
    fixture first.
  - **Evidence**: dispatch/recovery records carry `branch`
    (`src/runner.ts:428-436`, consumed at `src/recover.ts:543-547`) — a clone has
    no `swarm/*` answer.
  - **Gates**: Gate 1.5 (cleanup semantics, VERIFICATION.md:36-59), Gate 1.8
    (fresh workspace per attempt with `swarm/wt-*` branches,
    VERIFICATION.md:323-328), Gate 1.10 (default-mode lease/branch/evidence
    shapes, VERIFICATION.md:514-518), Gate 1.11 (report-only inspection incl.
    branch, VERIFICATION.md:621-625) all pin worktree behavior; T-021's Gate 1.19
    additionally pins the lease-path shape `<runDir>\wt\<leaseId>`
    (T-021:52-55).
  - **GC**: T-020's orphan classification is worktree/branch-evidence shaped by
    construction and explicitly carves clones out (T-020:112-113).
- **2026-10-20 — Multi-generation feedback loops are deferred; `--rounds`
  stays integer 1..2 (T-033).** The rule: `--rounds` accepts only integers
  1..2 — the parse-time cap (`src/cli.ts:218-219`, refusal "capped at one
  feedback round this slice"), machine-pinned by Gate 1.22 leg D's
  `--rounds 3 (beyond the cap)` refusal face (`scripts/check-rounds.mjs:556`;
  VERIFICATION.md:2386, :2251). Scope, so ROADMAP.md:22's ambiguity dies
  with it: the deferral covers (i) widening the T-030 survivor-evidence
  feedback loop beyond one feedback round — spec §34:2140's "bounded
  generation loops" — AND (ii) any adversarial-in-loop generation structure
  (the second reading of ROADMAP.md:22's "multi-generation adversarial
  loops"). It does NOT cover T-032's adversarial probe (evidence bundle,
  never a verdict, no loop) and does NOT ban candidate lineage records as
  such (§34:2137, carved by T-030:88-90) — lineage is re-entry condition
  (c) below, not a forbidden structure. Whatever shape eventually re-enters
  keeps composed survivor evidence a planning input only, never a verdict
  input (the machine-gates decision above, 2026-10-10 — gates decide
  survival; models advise) — already how `src/rounds.ts` is built and pinned
  (Gate 1.22).
  Empirical grounding, stated honestly: the bounded loop demonstrably runs
  end to end on real tokens — the driving Gate 2 run's artifacts at
  `C:\swarm\verify\20261020171354\report.json` record round 1 executed with
  survivors `[c01, c02]` and round 2 executed with survivors
  `[c01-r2, c02-r2]`, all four candidates `passedAllGates`, planner `ok` —
  but as an improvement signal the run shows NOTHING: round-1 survival was
  100% (2/2), so round 2 had nothing to recover (the larger round-2
  `diffBytes` — 4761/8915 vs 3888/4830 — ride different briefs, not a
  controlled comparison). T-030's staged question (T-030:107-108, mirrored
  VERIFICATION.md:2401-2403) is unanswered, not answered-yes. Two honesty
  caveats: the run id appears in no repo doc besides the ticket log (grep
  over VERIFICATION.md, docs/, README.md, AGENTS.md — its only hits are the
  T-033 ticket file itself), so this entry is the run's first durable record
  outside the ticket that proposed it; and the run's artifacts live outside
  the repo with the wrapper's exit status recorded nowhere in it — this
  entry cites the artifacts, never a passing verdict.
  Re-entry conditions, any of which reopens this via a new dated entry that
  rewrites this one (the mechanism at the top of this file), never a
  relitigation: (a) recorded runs where round-1 survival is below 100% and
  round 2 demonstrably recovers — T-030's staged empirical question actually
  answered; (b) T-031's generation-loop stop conditions land (spec
  §20:1273-1274, consecutive-generations-no-new-survivor /
  max-generation-count) and need generations to iterate — the extension
  point T-031 itself names (T-031:128-131, `src/runner.ts:209-257`); or
  (c) candidate lineage lands (§34:2137; T-030:88-90's carve) — without
  generation identity beyond the `-rN` id suffix, iterated generations are
  unaccountable.
