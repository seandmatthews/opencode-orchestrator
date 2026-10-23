# T-042 — Prompt transport off argv: the OpenCode adapter stops passing prompts as a command-line argument (Windows 32,767-char ceiling)

**Status:** proposed
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

## Why

This is the flagship feature (T-038 `--gate-retry`, T-040 findings-ride-the-
brief) dead on the platform this repo runs on, silently, with a misattributed
failure reason ("error: spawn ENAMETOOLONG" reads as a flake, not a design
hole). Every byte of headroom the composition caps leave is borrowed against
an OS limit no code checks. The fix is small, local to the one
OpenCode-aware file, and removes the ceiling class rather than trimming
briefs to fit it.

## Acceptance criteria

- [ ] Step 0 recorded: `scripts/diag-stdin.mjs` exists and this ticket records
      the probed answer (stdin supported or not) with the observed output
      before the transport change lands — pinned by the change-set contents.
- [ ] **Red bar recorded first** (AGENTS #8): a fast-tier check drives the
      REAL adapter (stub `binPath` pointing at a tiny script, the Gate 1.17
      stub-harness precedent) with a >32,767-char prompt and asserts today's
      behavior: the execute() call rejects/throws and no child ever ran —
      pinned by the new check script failing on main.
- [ ] Green: the same check with a 100,000-char prompt through the new
      transport — the child spawns, receives the full prompt verbatim (the
      stub asserts the received byte count), exits 0, `ok: true` — pinned by
      the same check script, green.
- [ ] No prompt bytes in argv: the stub-adapter check asserts the child's
      `process.argv` contains no prompt substring (a canary token embedded in
      the prompt must not appear in argv) — pinned by the same check.
- [ ] Byte-shape pin: prompts at normal sizes (<1K) through the new transport
      produce byte-identical model-facing behavior assertions as today's
      recorded cases where the existing adapter checks already pin behavior —
      no existing adapter check is weakened or deleted (AGENTS #8).
- [ ] `worker.log` records the new argv shape with the prompt elided for both
      execution policies — pinned by the check script.
- [ ] A composed retry brief at the composition ceiling (30K diff + 12K
      summary + 2 gates × 4K tails + 5 capped findings ≈ 70K chars) survives
      a real spawn — pinned by the stub-adapter check at that size.
- [ ] VERIFICATION.md extended in the same change-set (AGENTS #6): the
      ceiling, the recorded red bar, the new gate section — pinned by the
      full fast tier ALL GREEN.
- [ ] **Gate 2 owed** (adapter touched — the trigger list); **Gate 3 owed**
      (the adapter's transport is the change). Both trigger analyses recorded
      at landing; the Gate 2 leg should include one real `--gate-retry` run
      or record honestly why the flag still could not fire (the T-038
      precedent: no candidate failed a gate in either proof run).

## Landed

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
