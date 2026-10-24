# T-051 — Dashboard write surface: Host/Origin validation on the server + the approvals double-decide race closed (register R3)

**Status:** done 2026-10-24
**Category:** ops
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** —

## What

The dashboard's only write, `POST /approvals/decide`
(`src/dashboard.ts:927-968`), has no Origin/Host validation, no CSRF token
— any webpage the operator visits can silently post a form to
`http://127.0.0.1:<port>/approvals/decide` and durably approve or reject a
pending survivor; classic DNS-rebinding additionally defeats the 127.0.0.1
bind because the Host header is never checked (`handle`, :970-1029). The
store's refusals limit WHICH rows can flip, but approving a pending request
is exactly the write an attacker wants — and it is the audit record other
subsystems treat as the human decision of record. Sibling (register R3,
same finding): `decideApproval` reads row state BEFORE `BEGIN` and updates
unconditionally (`src/store/index.ts:691-706`), so two concurrent decides
(a second browser tab, or a CSRF racing a human) can both observe
`waiting_for_approval`, both commit, and leave one APPROVED **and** one
REJECTED event with last-write-wins on the row — precisely the rewritable
audit trail the refusal at :694-696 promises cannot happen.

Three changes:

1. **Request gate** (dashboard handle): Host must be `127.0.0.1[:port]` or
   `localhost[:port]`; Origin, when present, must match one of the same
   origins. Anything else → 403 with a loud one-line log naming the
   rejected header. This closes browser-form CSRF (browsers send Origin on
   cross-origin POSTs) and DNS-rebinding (rebound requests carry an
   attacker Host).
2. **The decide race, closed by construction** (store): move the state read
   inside the transaction and make the UPDATE conditional
   (`WHERE status = 'waiting_for_approval'`), refusing with today's
   double-decide message when `changes() === 0`. Note for the implementer:
   `node:sqlite` is synchronous, so the interleaving needs two processes —
   the red-bar posture below records this honestly rather than faking a
   deterministic race.
3. **Malformed percent-encoding → 400, not 500** (the cosmetic sibling in
   the same handler): guard `decodeURIComponent`.

Non-goals: content-type checks, CSRF tokens (Host/Origin cover the browser
threat class), auth beyond localhost (the T-034 trust-domain posture), and
`requestApproval`'s outside-transaction check (its race fails loudly on the
PK, not silently — carved).

## Why

The register's R3 disposition was `ticket-later` with this exact scope.
It's the only network-reachable write in the repo, it mutates the
approval-audit other code reads as truth, and the fix is three small
mechanical changes with no behavior change for the legitimate operator
(browsers on localhost send Origin headers that will pass the gate).

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free against the real
      server (the `check-dashboard.mjs` precedent): a `POST
      /approvals/decide` with `Origin: http://evil.example` is accepted
      today (2xx/4xx-store-refusal, not 403), and a request with `Host:
      evil.example` is served today — both asserted on main as the red
      bar. The TOCTOU has no deterministic single-process red (node:sqlite
      is synchronous; the race needs two processes) — recorded here as the
      code-shape citation (`:691-706` read-outside-BEGIN +
      unconditional UPDATE), never claimed as a reproduced red.
- [ ] Green, gate: both hostile legs return 403 with the loud log line;
      legitimate localhost requests (with and without Origin) are served
      exactly as today — pinned by the same check plus every existing
      dashboard check riding green unchanged.
- [ ] Green, race closed by construction: the conditional UPDATE refuses a
      second sequential decide with today's exact double-decide message;
      a two-process concurrent pair (the check spawns both) yields exactly
      one success and one refusal under the new guard — pinned by the same
      check.
- [ ] Green, 400: `%zz` in a path returns 400, not 500 — pinned by the
      same check.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) — pinned
      by the full fast tier ALL GREEN.
- [ ] **Gate 2**: no runner/adapter/report-shape change (dashboard + store
      seam only) — trigger analysis recorded at landing per the T-041
      precedent; **Gate 3 n/a.**

## Landed

Lane `ticket/T-051-dashboard-host-origin-decide-txn`, 2026-10-24. Three
changes, exactly the ticket's scope:

1. **Request gate** — `src/dashboard.ts`: `LOOPBACK_HOST` /
   `LOOPBACK_ORIGIN` + `gateRefusal()` at the top of `handle`, before any
   route (so before any DB open): Host must be `127.0.0.1[:port]` or
   `localhost[:port]`, Origin (when present) must be
   `http://127.0.0.1[:port]` or `http://localhost[:port]`; anything else →
   403 plus exactly one loud `console.error` line naming the rejected
   header and its value. A missing Host (raw-socket HTTP/1.0 face) refuses
   too — nothing trusted by default.
2. **Decide race closed by construction** — `src/store/index.ts`
   `decideApproval`: the approval_gates state read moved inside `BEGIN`,
   the UPDATE made conditional
   (`AND state = 'waiting_for_approval'`), `changes === 0` refused with
   today's byte-identical double-decide message. Message, statuses, and
   every other refusal face unchanged (Gate 1.9 riding green).
3. **`decodePathSegment`** — `src/dashboard.ts`: `decodeURIComponent` on
   the three decoded path segments guarded; `%zz` → a 400 page naming the
   segment, never the outer catch's 500.

**Red bar** (AGENTS #8), recorded on main's engine at the lane before the
change (final check version): `scripts/check-dashboard-write.mjs` exit 1,
18 failures, teed to
`C:\swarm\verify-red\T-051-redbar.log` — the cross-origin decide POST was
ACCEPTED (200, durably approving the row; the cascade into the race legs
failing is the attack demonstrated end to end), `Host: evil.example` was
served (200), the https/suffix origins reached the store (409), the
Host-less request was served (200), all three `%zz` legs 500'd. The TOCTOU
itself stays a code-shape citation per this ticket's own AC — never
claimed as a reproduced red.

**Gate 2 trigger analysis** (the T-041 precedent): NOT triggered — the
change-set touches `src/dashboard.ts` (a recorded-state consumer) and the
`decideApproval` seam of `src/store/index.ts` only; nothing on the trigger
list (src/runner.ts, adapters, gates, workspace handling, report shape)
changed; no report-shape or runner behavior difference exists for a real
run to surface. **Gate 3 n/a** (no adapter; the dashboard spawns no
harness).

## Verification

New fast-tier check `scripts/check-dashboard-write.mjs` wired as **Gate
1.37** (`scripts/verify.mjs`; VERIFICATION.md's Gate 1.37 section written
in the same change-set): the two ticketed hostile 403 legs (evil Origin on
the decide POST, evil Host on a GET) plus https-origin, suffix-spoof
Origin/Host, and Host-less legs, each with its one loud log line;
legitimate-request inertness (localhost Host, matching Origin, no Origin —
the Gate 1.23 fetch face — all served as today, a matching-Origin decide
landing through the real store); sha256 proof every refused request
touched zero DB bytes; sequential double-decide 409 with today's exact
message; the overlapping two-process pair (exactly one decide lands, one
event, never APPROVED+REJECTED — loser face logged, never asserted, it is
timing-dependent) and the quick-succession pair (refuses AT THE GUARD with
the exact message); the three `%zz` → 400 legs. Gate 0 exit 0; the new
check ALL GREEN (three consecutive runs); full fast tier ALL GREEN
including Gate 1.23 (every existing dashboard check riding green
unchanged).

## References

docs/adversarial-review-2026-10-23.md R3 (the disposition this promotes) ·
src/dashboard.ts:927-1029 (the write + handler) · src/store/index.ts:691-706
(the TOCTOU shape) · docs/tickets/T-034 (the localhost trust-domain
posture), T-008 (the approvals store) · VERIFICATION.md (the
check-dashboard fast-tier precedent).
