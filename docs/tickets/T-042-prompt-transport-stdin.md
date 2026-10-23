# T-042 — Prompt transport off argv: the OpenCode adapter stops passing prompts as a command-line argument (Windows 32,767-char ceiling)

**Status:** done 2026-10-23
**Category:** adapters
**Value (1-5):** 5 · **Risk (1-5):** 2
**Depends on:** —

## What

`OpenCodeWorker.execute` passes the entire composed prompt as ONE argv element
(`src/worker/opencode.ts:44-46`, `['run', '-m', model, req.prompt]` /
`['run', '--agent', 'plan', '-m', model, req.prompt]`). On Windows the whole
spawned command line is capped at 32,767 UTF-16 chars, and Node's `spawn`
**throws synchronously** when it is exceeded — verified on this machine
(2026-10-23 adversarial-review session, node 22.23.1, win32 10.0.26200):

```js
// recorded red bar — re-run verbatim
node -e "const {spawnSync}=require('node:child_process'); for (const n of [32000,33000]) { const r = spawnSync(process.execPath, ['-e','process.exit(0)','x'.repeat(n)]); console.log(n, r.error ? 'ERR '+r.error.code : 'ok exit='+r.status) }"
// observed: 32000 -> ok exit=0 ; 33000 -> ERR ENAMETOOLONG
```

The async form used by the adapter throws from `spawn()` itself
(`node:internal/child_process:420`), escapes to `runJob`'s catch
(`src/runner.ts:1249`), and records the attempt as a mechanical `error` — a
mechanical retry re-spends the identical failure, and nothing in the report
names the real cause.

Nothing bounds prompt size anywhere on the path: `parseBriefs` caps no brief
length (`src/parse.ts`), `builderPrompt` caps nothing, and
`composeGateRetryBrief` (`src/runner.ts:804-854`) composes original brief +
diff capped at 30,000 chars + worker summary up to 12,000
(`RESPONSE_TAIL_CHARS`) + each failing gate's 4,000-char `outputTail` + up to
5 findings × ~4,000 chars. The 30K diff cap alone leaves ~2.5K headroom under
the OS ceiling; diff + summary, or a mid-size diff + two failing gates +
findings, crosses it routinely. **The T-038/T-040 feedback retry fails at
spawn exactly when the candidate has a real diff and real gate failures — the
cases the feature exists for.** A verbose planner brief kills first attempts
the same way. (Scope note: `MachineWorker` never passes the prompt through
argv — it logs it as provenance — so this ticket is OpenCode-adapter-only.)

The change: the adapter sends the prompt out-of-band. Step 0 is a harness
probe, then the transport:

1. **Step 0 — `scripts/diag-stdin.mjs`** (the `diag-pwd.mjs`/`diag-execute.mjs`
   precedent): one real token-cheap call establishing whether
   `opencode run` reads the prompt from stdin when stdin is piped and no
   message positional is given. The probe's answer is recorded in this
   ticket before the transport lands (AGENTS #9: never claim an unrun check).
2. **Transport**: preferred = prompt via stdin (spawn args drop the prompt
   positional entirely; stdin streams the bytes). Fallback if step 0 answers
   no = `--file` attachment (documented in `opencode run --help`): write the
   prompt to a temp file outside any repo (the planner-scratch pattern),
   pass `-f <file>` plus a short fixed argv message naming the attachment.
   Either way, after the change **no prompt bytes ride in argv** — which also
   stops goals, briefs, and retry diffs from being visible to any local
   process listing (a side benefit worth an AC line of its own).

Invariants the change must hold: the worker.log argv line still records the
actual spawn shape with the prompt elided (`src/worker/opencode.ts:49`'s
posture, updated to the new shape); PWD/OLDPWD pinning unchanged; both
execution policies (`worktree-write`, `--agent plan`) take the new transport;
`responseTail` collection unchanged; timeout/kill path unchanged
(`runChildWithTimeout` untouched).

## Step 0 — recorded probe answer (2026-10-23, before the transport landed)

`node scripts/diag-stdin.mjs C:\swarm\diag-stdin-target` (a throwaway git
dir; the probe feeds the prompt via piped stdin, ends it, spawns the
vendored harness exactly the adapter's way — list-form argv, PWD/OLDPWD
pinned — with NO message positional). Observed output:

```
cwd arg:         C:\swarm\diag-stdin-target
argv:            ["run","-m","zai-coding-plan/glm-5.3-flash"]
stdin fed:       70 chars, then end
exit:            0
--- agent reply (stdout) ---
STDIN-PROBE-OK-4177
--- probe verdict ---
STDIN-SUPPORTED: opencode run with no message positional read the piped stdin as the prompt
```

**Answer: STDIN-SUPPORTED** (opencode-ai 1.19.3 reads piped stdin as the
message when no message positional is given — exact marker reply, exit 0).
The preferred transport applies; the `-f/--file` fallback is not
implemented. The recorded repro above (32000 ok / 33000 ERR ENAMETOOLONG)
was also re-run verbatim this session and reproduced identically.

## Why

This is the flagship feature (T-038 `--gate-retry`, T-040 findings-ride-the-
brief) dead on the platform this repo runs on, silently, with a misattributed
failure reason ("error: spawn ENAMETOOLONG" reads as a flake, not a design
hole). Every byte of headroom the composition caps leave is borrowed against
an OS limit no code checks. The fix is small, local to the one
OpenCode-aware file, and removes the ceiling class rather than trimming
briefs to fit it.

## Acceptance criteria

- [x] Step 0 recorded: `scripts/diag-stdin.mjs` exists and this ticket records
      the probed answer (stdin supported or not) with the observed output
      before the transport change lands — pinned by the change-set contents.
- [x] **Red bar recorded first** (AGENTS #8): a fast-tier check drives the
      REAL adapter (stub `binPath` pointing at a tiny script, the Gate 1.17
      stub-harness precedent) with a >32,767-char prompt and asserts today's
      behavior: the execute() call rejects/throws and no child ever ran —
      pinned by the new check script failing on main.
- [x] Green: the same check with a 100,000-char prompt through the new
      transport — the child spawns, receives the full prompt verbatim (the
      stub asserts the received byte count), exits 0, `ok: true` — pinned by
      the same check script, green.
- [x] No prompt bytes in argv: the stub-adapter check asserts the child's
      `process.argv` contains no prompt substring (a canary token embedded in
      the prompt must not appear in argv) — pinned by the same check.
- [x] Byte-shape pin: prompts at normal sizes (<1K) through the new transport
      produce byte-identical model-facing behavior assertions as today's
      recorded cases where the existing adapter checks already pin behavior —
      no existing adapter check is weakened or deleted (AGENTS #8).
- [x] `worker.log` records the new argv shape with the prompt elided for both
      execution policies — pinned by the check script.
- [x] A composed retry brief at the composition ceiling (30K diff + 12K
      summary + 2 gates × 4K tails + 5 capped findings ≈ 70K chars) survives
      a real spawn — pinned by the stub-adapter check at that size.
- [x] VERIFICATION.md extended in the same change-set (AGENTS #6): the
      ceiling, the recorded red bar, the new gate section — pinned by the
      full fast tier ALL GREEN.
- [x] **Gate 2 owed** (adapter touched — the trigger list); **Gate 3 owed**
      (the adapter's transport is the change). Both trigger analyses recorded
      at landing; the Gate 2 leg should include one real `--gate-retry` run
      or record honestly why the flag still could not fire (the T-038
      precedent: no candidate failed a gate in either proof run).

## Landed

2026-10-23, lane `ticket/T-042-prompt-transport-stdin`. What actually changed:

- **src/worker/opencode.ts** — the transport, local to the one
  OpenCode-aware file: `args` drops the prompt positional entirely
  (`['run', '-m', model]` / `['run', '--agent', 'plan', '-m', model]`);
  `stdio[0]` goes 'ignore' → 'pipe'; after spawn the adapter writes the
  prompt with `child.stdin.end(req.prompt, 'utf8')` (never blocks — Node
  buffers what the child has not read) behind a mandatory no-op `error`
  listener (an undraining harness emits EPIPE; a write error must never
  masquerade as a worker verdict — the exit path owns the outcome). The
  argv log line now renders `args.join(' ')` — byte-identical output to
  the old `args.slice(0, -1).join(' ')` because the dropped element was
  exactly the elided prompt, so the `<prompt: N chars>` marker, Gate 2's
  round-growth regex, and the S2 log-line pins read it unchanged. The
  class docblock records the ceiling, the step-0 probe, and the
  invariants. PWD/OLDPWD pinning, `onSpawn`, responseTail collection, and
  `runChildWithTimeout` (untouched) all stand.
- **scripts/diag-stdin.mjs** — NEW, the step-0 probe (the diag-pwd.mjs /
  diag-execute.mjs precedent): one real token-cheap call against the
  vendored opencode-ai 1.19.3, spawned exactly the adapter's way with no
  message positional and the prompt piped to stdin. Answer recorded above:
  **STDIN-SUPPORTED** (exact marker reply, exit 0) — the preferred
  transport applies and the `-f/--file` fallback is not implemented.
- **scripts/check-prompt-transport.mjs** — NEW, the pinning gate
  (Gate 1.28, the next free number at landing): C0 re-runs the recorded
  platform red bar verbatim (32,000 ok / 33,000 ENAMETOOLONG); T1–T5
  drive the REAL adapter against a node stub via `NODE_OPTIONS --require`
  (the check-capabilities S2 pin face, extended so the stub reads all of
  fd 0 synchronously and exits 0 — a faithful 'harness consumed the
  prompt' stand-in) at 33K / 40K-through-the-plan-policy / 100K /
  composition-ceiling-70,749 / <1K, asserting verbatim receipt (exact
  text + byte count), exit 0 `ok: true`, the spawn contract
  (onSpawn/result.pid), PWD/OLDPWD pinning, the log line for both
  policies, and a per-leg canary NEVER in argv.
- **scripts/check-capabilities.mjs** — S2's argv pin follows the
  transport: `prompt last` becomes `prompt never in argv, model terminal`
  (a strictly stronger assertion of the new contract); all other S2
  assertions unchanged, all four policy faces re-measured green.
- **scripts/check-rounds.mjs** — leg C's committed `run` stub read the
  prompt from `process.argv[4]`; it now reads fd 0 to EOF — same bytes,
  same no-op-by-brief/GOAL-parsing logic, every assertion untouched. (The
  first post-change fast tier caught exactly this: leg C's NO-OP
  elimination went red because the stub's empty argv prompt always wrote
  feature.txt.)
- **scripts/verify.mjs** — Gate 1.28 wired into the fast tier after
  Gate 1.27.
- **VERIFICATION.md** — Gate 1.28 section: the ceiling, the step-0 probe
  record, the legs, the red bar, the existing-checks accounting, the
  carve list, the Gate 2/Gate 3 trigger analyses.

**Red bar (AGENTS #8), recorded before the transport landed:** the new
check run on the pre-change tree (this lane at f256184, adapter
untouched): C0 green; every adapter leg RED — T1–T4 each
`execute() rejected — spawn ENAMETOOLONG` with no stub record (no child
ever ran), T5 with the canary IN argv and the stub's stdin empty, while
the unchanged faces (responseTail, spawn contract, PWD pinning, log-line
format) were green on the same run. 6 failures, exit 1. Green after the
change: 30 ok, `check-prompt-transport: ALL GREEN`, exit 0.

**Gate numbers measured this change-set** (all in the lane, this session):

- Gate 0 (`tsc --noEmit`): green, exit 0.
- Step 0 probe (`node scripts/diag-stdin.mjs`): STDIN-SUPPORTED (recorded
  above).
- Recorded platform red bar re-run verbatim: `32000 ok exit=0` /
  `33000 ERR ENAMETOOLONG` — reproduced identically.
- New check, red on the pre-change adapter: 6 failures, exit 1; green
  after the change: 30 ok, exit 0.
- Gate 1.20 standalone (`check-capabilities.mjs`): ALL GREEN, exit 0
  (S2's four policy faces on the new pins).
- Gate 1.22 standalone (`check-rounds.mjs`): ALL GREEN, exit 0 (after the
  stub's prompt acquisition moved to stdin; red before that fix, as
  recorded above).
- Full fast tier (`node scripts/verify.mjs fast`): **ALL GREEN, exit 0 —
  1602 ok lines**, every section Gate 0 through Gate 1.28.
- Gate 3 (`node scripts/diag-pwd.mjs`, both faces, in the lane
  post-change): no override → the harness reports the inherited-PWD
  directory (the Known issue #1 demonstration, the T-010/T-039 record
  shape); override to an existing git dir → the harness reports the
  override target. The quirk is intact; the adapter's PWD/OLDPWD pinning
  remains load-bearing; the transport change is invisible to the probe.

**Gate 2 — owed to the driving run** (an adapter is on Gate 2's trigger
list; not run in this lane — real model tokens are the pipeline's to
spend): the full tier's standard real 2-round `--gate-retry
--verifier-model` e2e now exercises the stdin transport on every
planner/worker/reviewer/verifier dispatch, and its planner round-growth
assertion reads the unchanged `<prompt: N chars>` log marker. Whether a
real `--gate-retry` leg fires is read off the run's `gateRetry` blocks
and recorded by the driving run — the T-038/T-040 precedent stands (no
candidate failed a gate in any recorded proof run so far; if that repeats
it is recorded honestly, not manufactured). **Gate 3 — run once at
landing** (an adapter changed): measured above, both faces, quirk intact.

No deviations from the ticket text. No ride-alongs: `src/runner.ts`,
`src/types.ts`, gates, workspace handling, and report shape are
untouched; `package-lock.json` unmodified.

## Verification

New fast-tier check (next free gate number at landing) driving the real
adapter against a stub harness at 40K/100K-char prompts; Gate 0; full fast
tier ALL GREEN; Gate 2 + Gate 3 owed and recorded per the trigger list.

## References

src/worker/opencode.ts:44-49 (argv prompt, log line) · src/runner.ts:804-854
(`composeGateRetryBrief`), :453, :466-467 (caps), :950-951 (prompt
composition), :1249 (the catch that mislabels the throw) · src/parse.ts (no
brief-length bound) · src/worker/machine.ts:53-67 (MachineWorker unaffected —
prompt is provenance-only) · VERIFICATION.md (adapter check precedents, Gate
1.12 S4 / Gate 1.17 stub-harness pattern) · 2026-10-23 adversarial review
finding F1 (recorded repro above).
