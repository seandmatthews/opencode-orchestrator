# T-058 — Bounded output accumulation: a chatty child can no longer OOM the orchestrator (register R11)

**Status:** proposed
**Category:** engine
**Value (1-5):** 3 · **Risk (1-5):** 2
**Depends on:** —

## What

The response-tail collectors in BOTH adapters accumulate the child's entire
stdout+stderr in memory with no cap — `collectText`
(`src/worker/opencode.ts:100-110`, `src/worker/machine.ts:108-118`) — and
the tail is sliced to 12,000 chars only AFTER full collection
(`RESPONSE_TAIL_CHARS`, sliced at :85/:93). A machine-worker command or a
worker harness streaming gigabytes (a chatty candidate-controlled build, a
runaway loop) grows the orchestrator's heap without bound: the OOM kills
the RUN, not just the candidate. The probe core caps each case at 16 MiB
(`src/probe.ts:596-597`) but concatenates all ~20 cases into one string and
one `writeFileSync` (:1612-1621, the log artifact) — up to ~320 MiB per
probe per candidate, same failure class at smaller scale.

The change — bounded memory, byte-identical observable output:

1. **Adapters**: cap the accumulator at a documented, exported constant
   (`MAX_TAIL_BUFFER_CHARS`, e.g. 64,000 — comfortably above
   `RESPONSE_TAIL_CHARS` = 12,000 with slack for both streams'
   interleaving); when over, drop from the FRONT (keep the tail — the
   only part `responseTail` ever surfaces). The full stream still reaches
   the log file via `runChildWithTimeout`'s unbounded FILE drain (disk,
   not heap — unchanged). `responseTail`'s bytes are identical for streams
   under AND over the cap (the tail-window guarantee pinned).
2. **Probe core**: cap the aggregate log artifact at a documented,
   exported constant (`MAX_PROBE_LOG_BYTES`, e.g. 32 MiB — tail-kept, the
   bundle records the truncation in its existing metadata fields per the
   bundle contract). Per-case caps unchanged.
3. Never break the run on overflow: capping is silent-by-design for the
   run (memory hygiene), LOUD in the artifact metadata where evidence is
   truncated (the bundle), and the log FILE keeps everything — no honesty
   loss, no new cleanupFailures noise.

## Why

R11's disposition was `ticket-later`. The orchestrator dying to one
candidate's stdout is a whole-run loss (every lane's work, the lock held);
the fix is a front-trimming accumulator and an aggregate cap — small,
deterministic, and provable token-free under a constrained heap.

## Acceptance criteria

- [ ] **Red bar recorded first** (AGENTS #8), token-free: a stub child
      emitting ~50 MB across both streams, driven through the REAL
      `collectText` path (stub adapter, the Gate 1.17 precedent) inside a
      node process constrained with `--max-old-space-size=64` — on main
      the constrained process dies (OOM) or throws; the constrained-run
      failure asserted as the red bar.
- [ ] Green, adapters: the same drive post-change completes under the
      same constraint; `responseTail` is byte-identical to the stream's
      true final 12,000 chars (both under-cap and over-cap drives pinned
      verbatim) — pinned by the same check.
- [ ] Green, probe: a fixture target emitting more than the per-case cap
      on every case completes; the aggregate log artifact is at most
      MAX_PROBE_LOG_BYTES and the bundle records the truncation; the
      bundle stays schema-valid — pinned by the same check (or its probe
      sibling).
- [ ] Constants exported and pinned (the `MAX_RETRY_FINDINGS` pattern),
      never knobs — pinned by the same check.
- [ ] Healthy-path byte-identity: small-stream behavior is unchanged and
      every existing adapter/probe check rides green (Gate 1.12, 1.15,
      1.17, 1.32 suites) — pinned by the full fast tier.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6) — pinned
      by the full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (`src/worker` + probe core touched — the trigger
      list); trigger analysis recorded at landing. **Gate 3 n/a.**

## Landed

## Verification

New fast-tier check (next free gate number at landing): the constrained
50 MB red bar, the tail-byte-identity greens (both regimes), the probe
aggregate cap, the exported constants. Gate 0, full fast tier ALL GREEN;
Gate 2 owed and recorded.

## References

src/worker/opencode.ts:100-110 (collectText), :92 (RESPONSE_TAIL_CHARS) ·
src/worker/machine.ts:108-118 (the twin), :100 · src/probe.ts:596-597
(per-case caps), :1612-1621 (the unbounded concatenation), :748-758 (the
single write) · src/worker/run-with-timeout.ts:81-102 (the file drain —
unchanged, the reason no evidence is lost) ·
docs/adversarial-review-2026-10-23.md R11 (the disposition this
promotes) · docs/tickets/T-053 (the sibling log-write hardening),
T-032 (the probe corpus whose per-case caps multiply).
