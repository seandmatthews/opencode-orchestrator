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
