# T-058 — Bounded output accumulation: a chatty child can no longer OOM the orchestrator (register R11)

**Status:** done 2026-10-26
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

- [x] **Red bar recorded first** (AGENTS #8), token-free: a stub child
      emitting ~50 MB across both streams, driven through the REAL
      `collectText` path (stub adapter, the Gate 1.17 precedent) inside a
      node process constrained with `--max-old-space-size=64` — on main
      the constrained process dies (OOM) or throws; the constrained-run
      failure asserted as the red bar.
- [x] Green, adapters: the same drive post-change completes under the
      same constraint; `responseTail` is byte-identical to the stream's
      true final 12,000 chars (both under-cap and over-cap drives pinned
      verbatim) — pinned by the same check.
- [x] Green, probe: a fixture target emitting more than the per-case cap
      on every case completes; the aggregate log artifact is at most
      MAX_PROBE_LOG_BYTES and the bundle records the truncation; the
      bundle stays schema-valid — pinned by the same check (or its probe
      sibling).
- [x] Constants exported and pinned (the `MAX_RETRY_FINDINGS` pattern),
      never knobs — pinned by the same check.
- [x] Healthy-path byte-identity: small-stream behavior is unchanged and
      every existing adapter/probe check rides green (Gate 1.12, 1.15,
      1.17, 1.32 suites) — pinned by the full fast tier.
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6) — pinned
      by the full fast tier ALL GREEN.
- [x] **Gate 2 owed** (`src/worker` + probe core touched — the trigger
      list); trigger analysis recorded at landing. **Gate 3 n/a.**

## Landed

Lane `ticket/T-058-bounded-output-accumulation` off main 9a74ccf.
Everything below was run in this change-set.

**Adapters** (`src/worker/opencode.ts`, `src/worker/machine.ts` — twins):
`collectText` now front-trims per chunk — past the new exported
`MAX_TAIL_BUFFER_CHARS = 64_000` chars the FRONT of the accumulator is
dropped (the tail is the only part `responseTail` ever surfaces). The
constant is documented, exported from BOTH adapters, never a knob (the
`MAX_RETRY_FINDINGS` pattern), and must stay ≥ `RESPONSE_TAIL_CHARS`
(12,000, unchanged) for the tail-window guarantee. `runChildWithTimeout`'s
disk-side file drain is untouched — the log FILE still carries the whole
stream (pinned: the ~660 MB drive's log is 658,800,425 bytes, first-out /
out-err-boundary / last-err lines all present).

**Probe core** (`src/probe.ts`): exported `MAX_PROBE_LOG_BYTES = 32 MiB`.
Two bounds, each simple: `BoundedProbeLog` (replacing the plain
`logParts: string[]` in the benchmark/web/adversarial probes; joins
identically, so healthy-path output is byte-identical) drops FRONT parts
past the cap while accumulating and counts what it dropped in
`droppedBytes`; `writeProbeLog` (the single write path all six probes
share, wrapping the byte-capped `logArtifact`) enforces the same cap
byte-exactly on the FILE (tail-kept, the byte-cut never lands mid-UTF-8
sequence). The truncation is recorded on the bundle as ONE loud
`PROBE LOG TRUNCATED: kept the final <kept> of <total> bytes` line on the
FINAL GateResult's existing `cleanupFailures` — the T-053 log-write-loss
channel, no new bundle fields, schema-valid, `success` untouched (memory
hygiene never flips a verdict), and NO new cleanupFailures noise on capped
adapter drives (pinned). Per-case caps unchanged (16 MiB collection caps,
the web probe's childOutput cap).

**Red bar** (AGENTS #8, recorded FIRST against the unmodified sources): the
constrained drive — a stub child emitting ~660 MB across both streams
(3.2M + 2.2M deterministic 122-char lines) through the REAL `MachineWorker`
`execute()`/`collectText` under `--max-old-space-size=64` — THREW on main:

```
RangeError: Invalid string length
    at <anonymous> (src\worker\machine.ts:91:22)   <- responseText = out + err
```

exit 1; the identical drive post-change completes (exit 0, 3.0s) with
`responseTail` byte-identical to the stream's true final 12,000 chars.

**Deviation, measured and forced** (acceptance criterion says "~50 MB"):
at exactly ~50 MB the constrained red-bar drive on main COMPLETED — this
machine's Node v22.23.1 (win32) clamps `--max-old-space-size=64` up to a
112 MiB old-space floor (`heap_size_limit` = 117,440,512, measured), and
this V8 does not enforce that limit against retained strings (measured:
480 MB of retained strings survived; 160 MB cons-rope + flatten survived;
retained OBJECTS do trip it — the classic heap OOM, exit 134). The
criterion's "dies (OOM) or throws" therefore reproduces only through its
"or throws" arm: the drive was scaled to ~660 MB so the accumulated
`out + err` crosses V8's max string length and the unbounded join throws
`RangeError: Invalid string length`. Same instrument (real `collectText`
path, real adapters, stub children, same constraint flag), same assertion
shape (constrained-run failure = red, completion = green), ~3x the
illustrative size; the post-change green side completes under the identical
constraint. The check's D3 leg carries this history in its assertion text.

**Deviations, design** (both recorded in VERIFICATION.md Gate 1.44):
(a) the truncation record rides `GateResult.cleanupFailures` on the bundle's
FINAL entry — the ticket's "existing metadata fields per the bundle
contract" is exactly this T-053-shaped evidence channel; multi-entry
bundles attach it to the entry that completed the aggregate artifact, not
to every entry (one loud line, no spam). (b) the aggregate cap is enforced
TWICE — in-memory (`BoundedProbeLog` front-drop, the heap bound) and at the
write (`writeProbeLog`'s byte-exact file cap, the artifact bound) — because
capping only at the write would still build the ~320 MiB string first, and
capping only in memory would leave the file contract unenforced.

**Gate numbers measured at landing** (all run in this lane):

- Gate 0 typecheck: exit 0 (`tsc --noEmit`).
- New Gate 1.44 (`node node_modules/tsx/dist/cli.mjs
  scripts/check-bounded-output.mjs`, token-free): ALL GREEN, 31
  assertions, ~8.4s — legs C (constants, never knobs), S (source pins),
  D1 (under-cap byte-identity, machine), D2 (over-cap cross-boundary
  byte-identity, opencode), D3/D4 (the red-bar drive green under
  `--max-old-space-size=64`, machine + opencode, file-drain evidence),
  P1 (probe aggregate cap + truncation + schema), P2 (probe healthy-path
  byte-identity).
- Full fast tier (`node scripts/verify.mjs fast`): **ALL GREEN, 4m04s** —
  Gate 0 + Gate 1 fixture + Gate 0.5 + Gates 1.5–1.44, including the
  healthy-path suites this ticket's criterion names: Gate 1.12
  (termination), 1.15 (probe layer), 1.17 (MachineWorker), 1.32 (gate/diff
  overlap) all riding green unchanged.

**Gate 2 trigger analysis — OWED, not run by this change-set.** The ticket
names the trigger: `src/worker` (both adapters' `collectText`) + the probe
core are on the Gate 2 trigger list. Analysis: the change is
observable-output-preserving by construction and pinned byte-identical
token-free (D1–D4, P2), so no Gate 2 assertion's meaning changes; what Gate
2 adds is the real-harness confirmation that a normal worker run's
`responseTail` and probe logs remain healthy under the bounded collectors —
owed at landing, run by the driving pipeline, recorded here when green.
**Gate 3 n/a** — no harness directory-resolution surface touched (no
spawn-env or cwd change; the PWD/OLDPWD pinning is untouched).

## Verification

New fast-tier check: **Gate 1.44** (`scripts/check-bounded-output.mjs`,
VERIFICATION.md "Gate 1.44 — bounded output accumulation") — the
constrained red-bar drive green under the fix (both adapters), the
tail-byte-identity greens in both regimes, the probe aggregate cap with its
loud truncation record and schema validity, the exported never-knob
constants, and the probe healthy-path byte-identity. Gate 0 exit 0; full
fast tier ALL GREEN (4m04s, Gates 1.5–1.44 including 1.12/1.15/1.17/1.32
riding green). Gate 2 owed (trigger: `src/worker` + probe core) and
recorded by the driving pipeline; Gate 3 n/a.

## References

src/worker/opencode.ts:100-110 (collectText), :92 (RESPONSE_TAIL_CHARS) ·
src/worker/machine.ts:108-118 (the twin), :100 · src/probe.ts:596-597
(per-case caps), :1612-1621 (the unbounded concatenation), :748-758 (the
single write) · src/worker/run-with-timeout.ts:81-102 (the file drain —
unchanged, the reason no evidence is lost) ·
docs/adversarial-review-2026-10-23.md R11 (the disposition this
promotes) · docs/tickets/T-053 (the sibling log-write hardening),
T-032 (the probe corpus whose per-case caps multiply).
