# T-036 — Commit identity migrated to matthews.sean.d@gmail.com

**Status:** done 2026-10-21
**Category:** ops
**Value (1-5):** 2 · **Risk (1-5):** 1
**Depends on:** —

## What

Rewrite every commit's author/committer email from `matth@local` (an address no
GitHub account can verify) to `matthews.sean.d@gmail.com`, so the work
attributes on GitHub and the contribution graph reflects it. Author name stays
`matth`; dates, messages, and tree contents are untouched.

Not a code change: a one-shot `git filter-branch --env-filter` over `main`
(127 commits, 2026-10-10..2026-10-21), plus the follow-ups that keep the new
identity sticky:

- repo-local config `user.name=matth`, `user.email=matthews.sean.d@gmail.com`
  (plain commits work; the old `-c user.email=matth@local` convention is retired);
- `.zcode/workflows/ticket-forge.dwf.ts` and `.zcode/workflows/ticket-implement.dwf.ts`
  stop hardcoding `matth@local` in their commit commands and prompt prose
  (this change-set);
- pre-rewrite history preserved on branch `backup/pre-email-rewrite`
  (old main `fc60439`); delete it only after the force-push is confirmed good.

## Why

GitHub attributes commits by email; `matth@local` is unverifiable, so every
commit rendered unattributed. Every SHA changed in the rewrite, so the next
push to `origin` must be a force push — done deliberately by the human, never
by an agent run.

## Acceptance criteria

- [x] `git log --format='%ae %ce' | sort -u` over main shows only
      `matthews.sean.d@gmail.com matthews.sean.d@gmail.com` — 127/127 commits.
- [x] Tree hash unchanged by the rewrite: `main^{tree}` =
      bde523322109a37e0b7c3592282ac6f535b6a154 before and after.
- [x] No tracked file references `matth@local` (`git grep` green) — pinned by
      this change-set.
- [ ] `git push --force origin main` — HUMAN step, deliberate, not agent-run;
      origin still serves the pre-rewrite history until then.

## Landed

2026-10-21: `git filter-branch --env-filter` rewrote 127/127 commits on main
(`fc60439` → `1f7da12`), names and dates preserved, tree hash byte-identical.
The fully-merged T-032 lane worktree (`C:\Users\matth\Documents\orchestrator-lanes\T-032`)
and its branch were removed in the same pass (0 unique commits, clean tree).
Repo-local identity config set; both saved workflows re-pointed in this lane.
Origin untouched by the agent.

## Verification

Manual git checks above; this ticket is repo meta, not engine behavior —
nothing under `src/` or `scripts/` changed, so no VERIFICATION.md gate
applies. Fast tier re-run green on the merged main.
