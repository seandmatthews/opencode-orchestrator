# T-022 — Disposable clones deferred: WorktreeProvider stays the only WorkspaceProvider (spec §3.6, §14, §34 M3)

**Status:** done 2026-10-18
**Category:** docs
**Value (1-5):** 3 · **Risk (1-5):** 1
**Depends on:** —

## What

A docs-only change-set that records a deferral decision and settles the
accounting for one stage-3 item — disposable clones. Three files plus the
index row:

1. **docs/decisions.md** gains one dated entry (2026-10-18) — *Disposable
   clones are deferred; WorktreeProvider is the only WorkspaceProvider.* The
   entry:
   - States the rule: `WorkspaceProvider` (`src/types.ts:78-85`, the
     lease/diff/dispose seam) keeps exactly one implementation,
     `WorktreeProvider` (`src/workspace/worktree.ts:61-86`), hard-wired at its
     single construction site (`src/cli.ts:333`). No clone provider, no provider
     factory, no `--workspace` flag until a consumer exists.
   - Names the re-entry conditions, either of which reopens this via a new
     dated entry that rewrites this one (the decisions.md:3-4 mechanism), never
     a relitigation: (a) a read-only role lands — spec §10's verifiers (`:769`
     deep code verifier "Read-only", `:788` security auditor, `:809` UI/visual
     verifier), §14.1:1016's researchers, §14.2:1023's
     `{ type: "disposable-clone-readonly" }` policy, §34:2094's Milestone-5
     "read-only workspace where applicable" — i.e. ROADMAP stage 5; or (b) a
     demonstrated worktree failure class the worktree machinery cannot absorb.
     Neither exists today.
   - Carries the integration-cost inventory a future clone ticket must
     reconcile, with anchors:
     - **Disposal**: `clean` refuses a target that "exists but is not a
       registered git worktree" (`src/clean.ts:198`) — a clone workspace is not
       one, so a clone dispose face is new code in every disposal path, and it
       must re-implement the evidence-never-deleted / dirty-refusal rule
       (`src/clean.ts:6-8`, pinned by Gate 1.5, VERIFICATION.md:43-47).
     - **Recovery**: `sniffRepo` reads the worktree `.git` pointer *file*
       (`src/workspace/worktree.ts:24-32`); a clone's `.git` is a directory,
       the read throws, the catch returns null, and `recover` exits 1 "cannot
       determine the target repository" (`src/recover.ts:452-456`). Predicted
       from read code, not yet reproduced against a real clone — the successor
       ticket builds that fixture first.
     - **Evidence**: dispatch/recovery records carry `branch`
       (`src/runner.ts:428-436`, consumed at `src/recover.ts:543-547`) — a
       clone has no `swarm/*` answer.
     - **Gates**: Gate 1.5 (cleanup semantics, VERIFICATION.md:36-59), Gate 1.8
       (fresh workspace per attempt with `swarm/wt-*` branches, :323-328),
       Gate 1.10 (default-mode lease/branch/evidence shapes, :514-518), Gate
       1.11 (report-only inspection incl. branch, :621-625) all pin worktree
       behavior; proposed T-021's Gate 1.19 additionally pins the lease-path
       shape `<runDir>\wt\<leaseId>` (T-021:52-55).
     - **GC**: proposed T-020's orphan classification is
       worktree/branch-evidence shaped by construction and explicitly carves
       clones out (T-020:112-113).
2. **docs/ROADMAP.md** — the stage-3 row (`:15`) drops "disposable clones" from
   its remaining list; "disposable clones" joins the deliberately-deferred line
   (`:22`, the memoization precedent) with a pointer at the decision and at
   stage 5.
3. **docs/tickets/README.md** — this ticket's index row. Nothing else in the
   index changes.

**Does NOT claim:** no `src/` or `scripts/` change; no VERIFICATION.md change
(AGENTS.md #6 extends verification with *features* — this records the absence
of one); no `WorkspaceLease` widening toward §16:1114-1122 (`candidateId` /
`createdAt` / `expiresAt` / `retentionClass` — the divergence T-015:32-35
already records as "Documented, not relitigated"); no §14.2 `WorkspacePolicy`
consumer (zero hits in `src/` and `scripts/` — scout greps quoted in Why). Any
`WorkspaceProvider` clone implementation and any lease widening belong to the
stage-5 read-only-verifier ticket that first consumes them, sequenced behind
T-020 (GC) and T-021 (long-path pin), which own the GC and path-budget halves
of M3's remainder. Retention policies are the remainder's other carved item —
owned by their own future successor ticket (T-020:98-100, T-021:111-115) — and
this change-set decides nothing about them.

## Why

"Disposable clones" is one of two unowned items on stage 3's remaining list
(`ROADMAP.md:15`) — the other, retention policies, is already carved to its own
successor ticket sequenced behind T-020 (T-020:98-100, T-021:111-115) — and
both open tickets explicitly disclaim clones (T-020:112-113, T-021:137-140).
The spec read puts the term exactly five times —
§3.6:146 (one of five read-only mechanisms), §14.1:1016 ("Builders receive
worktrees or disposable clones"), §14.2:1023 (union member), §14.3:1037
(mechanism list), §34:2054 (bare noun in M3's build list) — and the spec never
defines clone mechanics: §16 (Worktree Lifecycle and GC, :1109-1148) is entirely
worktree-scoped. The engine's only role today is builders, and §14.1:1016 is an
either/or whose implemented half is worktrees.

Refuted-by-absence, not merely unconfirmed: no gate, Known issue, ticket, or
spec section records any worktree failure a clone would prevent (VERIFICATION.md
Known issues 1-10, full read). Provider injection through the seam is already
gate-proven — five fast-tier checks construct `WorktreeProvider` and inject it
(scripts/check-probe.mjs:208, check-recovery.mjs:183/292/342,
check-retry.mjs:110, check-scheduler.mjs:153) — so a provider factory would be
dead configuration behind a single implementation. Scout greps this session:
`grep -rn "WorkspacePolicy" src/ scripts/` → zero hits;
`grep -rn "git.*clone|'clone'" src/ scripts/*.mjs` → zero hits. The one proven
workspace pain — the `swarm/*` branch leak — is T-020's reproduced scope
(T-020:131-156), and a clone's one structural advantage (no `swarm/*` branches)
duplicates that fix rather than adding anything. A clone provider today would be
machinery without a consumer, landing outside every disposal/recovery/GC
invariant built since T-002 (Value 2 / Risk 4); the recorded deferral is the
honest disposition (Value 3 / Risk 1).

Consistent with the locked decisions: this *adds* a decision rather than
contradicting one (decisions.md:3-4); the seam already satisfies
decisions.md:11-15 (everything behind interfaces — which is exactly why no seam
refinement is needed either); run-root location is settled (decisions.md:25-26);
a workspace provider is verdict-neutral machinery, so no gate impact is claimed
either way (decisions.md:19-21).

## Acceptance criteria

- [x] The change-set touches exactly four paths — `docs/decisions.md`,
      `docs/ROADMAP.md`, `docs/tickets/T-022-disposable-clones-deferred.md`,
      `docs/tickets/README.md` (index row) — and nothing under `src/` or
      `scripts/`. Human-judgement item, named manual check: `git diff --stat`
      against the base reviewed in change-set review; any extra path fails it.
- [x] The decisions entry carries its date, the single-implementation rule,
      both re-entry conditions (stage-5 read-only role; demonstrated worktree
      failure class), and the integration-cost inventory with the file:line
      anchors listed under What. Human-judgement item, named manual check: the
      entry is read against the What section in change-set review.
- [x] The ROADMAP stage-3 row no longer lists "disposable clones" under
      remaining, and the deliberately-deferred line names it with the stage-5
      pointer. Pinned by the same named manual check (diff read).
- [x] Gate 0 (`npm run typecheck`) green in the same change-set — trivially, no
      `src/` file is touched; run via `npm run verify`. No behavioral claim.

No new check is added: no gate can pin decision prose, and adding one would be
ceremony — docs/tickets/README.md:29-30 sends human-judgement items to a named
manual check instead.

## Landed

2026-10-18, lane branch `ticket/T-022-disposable-clones-deferred` (base
c604b2a). Docs-only, exactly the four paths this ticket names — `git diff
--stat c604b2a` at landing names `docs/decisions.md`, `docs/ROADMAP.md`,
`docs/tickets/README.md`, and this ticket file, and nothing under `src/` or
`scripts/` (the named manual check re-runs it in change-set review).

What changed:

- **docs/decisions.md** — one dated entry (2026-10-18): the
  single-implementation rule (`WorkspaceProvider` at `src/types.ts:78-85`
  keeps exactly `WorktreeProvider` at `src/workspace/worktree.ts:61-86`,
  hard-wired at its single construction site `src/cli.ts:333`; no clone
  provider, no provider factory, no `--workspace` flag until a consumer
  exists), both re-entry conditions (a stage-5 read-only role lands — §10's
  verifiers :769/788/809, §14.1:1016's researchers, §14.2:1023's
  `disposable-clone-readonly` policy, §34:2094's M5 "read-only workspace
  where applicable"; or a demonstrated worktree failure class the worktree
  machinery cannot absorb — neither exists today), and the five-item
  integration-cost inventory (disposal: `src/clean.ts:198` + the
  evidence-never-deleted / dirty-refusal rule `src/clean.ts:6-8` pinned by
  Gate 1.5; recovery: `sniffRepo` `src/workspace/worktree.ts:24-32` →
  `src/recover.ts:452-456`, with the predicted-not-yet-reproduced flag
  carried; evidence: `branch` at `src/runner.ts:428-436` consumed at
  `src/recover.ts:543-547`; gates: 1.5 / 1.8 / 1.10 / 1.11 plus T-021's Gate
  1.19 lease-path shape (T-021:52-55); GC: T-020:112-113's clone carve).
  Every anchor was re-verified against the tree at the base commit before
  landing.
- **docs/ROADMAP.md** — the stage-3 row drops "disposable clones" from its
  remaining list; the deliberately-deferred line names it with the decision
  pointer (decisions.md 2026-10-18) and the stage-5 re-entry pointer (the
  memoization precedent).
- **docs/tickets/README.md** — this ticket's index row → `done 2026-10-18`.
  Nothing else in the index changed.
- **This ticket file** — status flipped, boxes checked, this section added.

Deviations: none in substance. One wording note: inside decisions.md the
What-section's "the decisions.md:3-4 mechanism" self-reference became "the
mechanism at the top of this file" — a file cannot cite its own line numbers
stably; the rule cited is verbatim decisions.md:3-4 (a contradicting decision
must first rewrite the entry, with a date and a reason). Per this ticket's
own Does-NOT-claim, no `src/`/`scripts/` file changed, VERIFICATION.md is
deliberately NOT extended, and no gate script was added (no behavior added;
no gate can pin decision prose) — the fast tier runs unchanged.

Gates measured (all run in the lane on this change-set):

- `npm run verify` (fast tier) — exit 0, all built-in checks green (Gate 0
  typecheck + Gate 1 fixture baseline + the fast-tier gate suite; none of
  them touched by this docs-only change-set).
- `git diff --stat c604b2a` — exactly the four paths above, nothing under
  `src/` or `scripts/`.

## Verification

Gate 0 only (via the `npm run verify` fast tier) plus the named manual
change-set review above. No VERIFICATION.md extension: AGENTS.md ground rule 6
scopes verification to features, and this change-set adds no behavior. Gates
1 / 1.5 / 1.8 / 1.10 / 1.11 / 2 / 3 are untouched and remain green for the
reasons already recorded there.

## References

- Spec: docs/spec/inference-refinery-v2.md §3.6:146, §10:769/788/809,
  §14.1:1016, §14.2:1023, §14.3:1037, §16:1109-1148, §34:2054, §34:2094
- Code: src/types.ts:70-85 · src/workspace/worktree.ts:24-32, 61-86 ·
  src/cli.ts:333 · src/runner.ts:90, 407, 428-436 · src/clean.ts:6-8, 198 ·
  src/recover.ts:452-456, 543-547
- Tickets: T-020 (worktree lease GC — owns the branch-leak pain; carves
  clones, retention policies, short-path run roots, T-020:112-113) · T-021
  (long-path pin — claims the carved short-path-run-roots item and carves
  retention policies to their own successor, T-021:111-115; Gate 1.19
  lease-path shape) · T-015:32-35 (WorkspaceLease divergence,
  documented-not-relitigated)
- Decisions: docs/decisions.md:3-4, :11-15, :19-21, :25-26
