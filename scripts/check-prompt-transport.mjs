// Prompt transport self-check (Gate 1.28, fast tier, T-042) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-prompt-transport.mjs
// Pins T-042: the OpenCode adapter never passes prompt bytes through argv.
// Windows caps the whole spawned command line at 32,767 UTF-16 chars and
// Node's spawn throws ENAMETOOLONG SYNCHRONOUSLY above it (the recorded red
// bar in docs/tickets/T-042-prompt-transport-stdin.md, re-run verbatim as
// leg C0 below) — which killed the T-038/T-040 gate-retry brief exactly when
// it had real feedback to carry (the composition caps alone sum past the
// ceiling: 30K diff + 12K summary + gate tails + findings) while the runner
// misattributed the throw as a mechanical 'error'. The transport is STDIN:
// the step-0 probe scripts/diag-stdin.mjs (the diag-pwd.mjs /
// diag-execute.mjs precedent) established first-hand that the vendored
// opencode-ai 1.19.3 reads piped stdin as the message when no message
// positional is given (observed 2026-10-23: exact marker reply, exit 0). A
// side benefit now pinned: no goal, brief, or retry-diff bytes ride argv,
// so none are visible to local process listings.
//
// Every adapter leg drives the REAL `OpenCodeWorker` with a stub binPath
// (constructor-injected, the Gate 1.12 S2 / check-capabilities S2 pin face):
// binPath = the node executable, the stub injected via NODE_OPTIONS
// --require. The stub reads ALL of fd 0 synchronously (so its record exists
// before node would fail to resolve the adapter's bare 'run' entry arg —
// and process.exit(0) in the preload means the stub exits 0, a faithful
// 'harness consumed the prompt and succeeded' stand-in), records argv, the
// received stdin bytes, and env.PWD/OLDPWD, prints a stdout marker (pinning
// responseTail collection), and exits 0. Legs, zero model tokens:
//
// C0 — platform ceiling, the recorded red bar re-run verbatim: a 32,000-char
//      argv element spawns fine (exit 0); 33,000 exceeds the ceiling and
//      spawnSync reports ENAMETOOLONG. The OS fact that motivated the
//      ticket, pinned on every fast-tier run (this leg is green on the
//      pre-change tree too — the ceiling is the platform's, not the
//      adapter's).
// T1 — the ticket's red-bar size (>32,767): a 33,000-char prompt through
//      the adapter spawns, the child receives the FULL prompt verbatim
//      (byte count + exact text), exits 0, ok: true.
// T2 — 40,000 chars through a RESTRICTED policy (both execution policies
//      take the new transport): verbatim receipt; argv is exactly
//      [exe, run, --agent, plan, -m, model]; the log line records the
//      actual argv shape with the prompt elided; PWD/OLDPWD pinned.
// T3 — 100,000 chars: verbatim receipt, exit 0, ok: true — the ceiling
//      class is removed, not trimmed to fit.
// T4 — the composed-retry-brief ceiling (~70K): a prompt built to the
//      T-038/T-040 composition recipe's documented sizes (30K diff + 12K
//      worker summary + 2 failing gates × 4K output tails + 5 findings ×
//      2K finding + 2K evidence + framing — composeGateRetryBrief is
//      module-private in src/runner.ts, so the check composes the
//      same-shaped text) survives a real spawn with verbatim receipt.
// T5 — byte-shape at normal size (<1K): the model-facing bytes are the
//      exact prompt text; the spawn contract is intact (onSpawn fired once,
//      result.pid equals it; the stub's stdout rides responseTail); the
//      log line keeps the `<prompt: N chars>` elision marker byte-identical
//      to the pre-T-042 format (Gate 2's round-growth regex reads it), and
//      never carries the prompt bytes.
// Every leg asserts a per-leg canary token embedded in the prompt NEVER
// appears in the child's argv — the no-prompt-bytes-in-argv property.
//
// Red bar (AGENTS.md #8), recorded BEFORE the transport landed by running
// this check on the pre-change tree: C0 green; every adapter leg RED —
// T1–T4 with execute() REJECTING (spawn ENAMETOOLONG thrown synchronously
// before any child existed — no stub record, no child ever ran), T5 with
// the prompt arriving in argv and the stub's stdin empty. Verbatim output
// in VERIFICATION.md's Gate 1.28 section.
//
// All subprocess calls are list-form (AGENTS.md #4); the sandbox under
// C:\swarm is created and removed by this check (AGENTS.md #10).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenCodeWorker } from '../src/worker/opencode.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const read = (p) => readFileSync(p, 'utf8')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-prompt-transport'

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const main = async () => {
  // ---------- C0 — the platform ceiling, the recorded red bar verbatim ----------
  {
    // Re-run of the ticket's recorded repro, byte-for-byte:
    //   for n in [32000, 33000]: spawnSync(node, ['-e','process.exit(0)','x'.repeat(n)])
    // observed 2026-10-23 (node 22.23.1, win32 10.0.26200): 32000 ok, 33000 ENAMETOOLONG.
    const r32 = spawnSync(process.execPath, ['-e', 'process.exit(0)', 'x'.repeat(32_000)])
    const r33 = spawnSync(process.execPath, ['-e', 'process.exit(0)', 'x'.repeat(33_000)])
    t('C0: a 32,000-char argv element spawns fine (exit 0)', r32.error === undefined && r32.status === 0)
    t('C0: a 33,000-char argv element exceeds the 32,767 UTF-16 command-line ceiling (spawnSync error)',
      r33.error?.code === 'ENAMETOOLONG' && r33.status === null)
  }

  // ---------- the stub harness ----------
  const stubRecord = join(sandbox, 'stub-record.cjs')
  // CJS, loaded via NODE_OPTIONS --require: runs inside the spawned stub
  // process before node touches the adapter's bare 'run' entry argument.
  // Reads ALL of fd 0 synchronously (blocking until the parent's stdin
  // end() delivers EOF — the record therefore exists only after every
  // prompt byte arrived), records the real argv and the pinned env vars,
  // prints a stdout marker, and exits 0.
  writeFileSync(stubRecord, [
    "'use strict'",
    'const fs = require("node:fs")',
    'let stdin = "(stub never read stdin)"',
    'try { stdin = fs.readFileSync(0, "utf8") } catch (e) { stdin = "(read failed: " + (e.code ?? e.message) + ")" }',
    'const out = process.env.T042_STUB_OUT',
    'if (out) {',
    '  fs.writeFileSync(out, JSON.stringify({',
    '    argv: process.argv,',
    '    stdin: stdin,',
    '    pwd: process.env.PWD === undefined ? null : process.env.PWD,',
    '    oldpwd: process.env.OLDPWD === undefined ? null : process.env.OLDPWD,',
    '  }))',
    '}',
    'console.log("T042-STUB-STDOUT-MARKER")',
    'process.exit(0)',
    '',
  ].join('\n'))

  const worker = new OpenCodeWorker(process.execPath)

  // One adapter leg: spawn through the REAL adapter against the stub, with
  // a per-leg record path. A synchronous spawn throw (the pre-T-042
  // ENAMETOOLONG behavior) surfaces as `rejected` — recorded, so the red
  // run reports every leg instead of crashing on the first.
  async function driveLeg(cwdName, req) {
    const cwd = join(sandbox, cwdName)
    mkdirSync(cwd, { recursive: true })
    const recordPath = join(sandbox, `${cwdName}.json`)
    process.env.T042_STUB_OUT = recordPath
    let spawnPid = null
    try {
      const result = await worker.execute({
        model: 'fake/stub-model',
        cwd,
        logPath: join(sandbox, `${cwdName}.log`),
        timeoutMs: 15_000,
        onSpawn: (pid) => { spawnPid = pid },
        ...req,
      })
      return { result, rejected: null, cwd, recordPath, spawnPid }
    } catch (e) {
      return { result: null, rejected: e, cwd, recordPath, spawnPid }
    }
  }
  const readRecord = (leg) => (existsSync(leg.recordPath) ? JSON.parse(read(leg.recordPath)) : null)
  const canaryAbsentFromArgv = (rec, canary) => rec !== null && !JSON.stringify(rec.argv).includes(canary)
  const argvShapeOk = (rec, restricted) => {
    if (rec === null) return false
    const argv = rec.argv
    if (basename(argv[1] ?? '').toLowerCase() !== 'run') return false
    if (restricted) {
      return argv.length === 6 && argv[2] === '--agent' && argv[3] === 'plan' && argv[4] === '-m' && argv[5] === 'fake/stub-model'
    }
    return argv.length === 4 && argv[2] === '-m' && argv[3] === 'fake/stub-model'
  }

  const prevNodeOptions = process.env.NODE_OPTIONS
  const prevStubOut = process.env.T042_STUB_OUT
  process.env.NODE_OPTIONS = `--require ${stubRecord.replaceAll('\\', '/')}`
  try {
    // ---------- T1 — the ticket's red-bar size: 33,000 chars through the adapter ----------
    {
      const canary = 'T042-CANARY-t1-6f31e0c2'
      const prompt = canary + '\n' + 'x'.repeat(33_000 - canary.length - 1)
      t('T1: the leg prompt is exactly 33,000 chars (> the 32,767 ceiling)', prompt.length === 33_000)
      const leg = await driveLeg('leg-t1', { prompt, executionPolicy: 'worktree-write' })
      const rec = readRecord(leg)
      if (leg.rejected !== null) {
        t(`T1: a >32,767-char prompt spawns and completes through the adapter (observed instead: execute() rejected — ${leg.rejected.message})`, false)
        t('T1: the stub never ran (no child record exists)', rec === null)
      } else {
        t('T1: a >32,767-char prompt spawns, exits 0, ok: true',
          leg.result.ok === true && leg.result.exitCode === 0 && leg.result.timedOut === false)
        t('T1: the child received the FULL prompt verbatim over stdin', rec !== null && rec.stdin === prompt)
        t('T1: the stub received exactly 33,000 prompt bytes', rec !== null && Buffer.byteLength(rec.stdin) === 33_000)
        t('T1: the spawn contract holds (onSpawn fired once, result.pid equals it)',
          leg.spawnPid !== null && leg.result.pid === leg.spawnPid)
        t('T1: no prompt bytes in argv (canary absent), argv shape exact',
          canaryAbsentFromArgv(rec, canary) && argvShapeOk(rec, false))
      }
    }

    // ---------- T2 — 40,000 chars through a RESTRICTED policy (plan agent) ----------
    {
      const canary = 'T042-CANARY-t2-8ac4d9b7'
      const prompt = canary + '\n' + 'y'.repeat(40_000 - canary.length - 1)
      t('T2: the leg prompt is exactly 40,000 chars', prompt.length === 40_000)
      const leg = await driveLeg('leg-t2', { prompt, executionPolicy: 'worktree-read' })
      const rec = readRecord(leg)
      if (leg.rejected !== null) {
        t(`T2: 40,000 chars through the plan policy spawn and complete (observed instead: execute() rejected — ${leg.rejected.message})`, false)
      } else {
        t('T2: the restricted policy takes the new transport: spawns, exits 0, ok: true',
          leg.result.ok === true && leg.result.exitCode === 0 && leg.result.timedOut === false)
        t('T2: the child received the FULL prompt verbatim over stdin', rec !== null && rec.stdin === prompt)
        t('T2: argv is exactly [exe, run, --agent, plan, -m, model] — no prompt bytes (canary absent)',
          canaryAbsentFromArgv(rec, canary) && argvShapeOk(rec, true))
        t('T2: env.PWD and env.OLDPWD are pinned to req.cwd (unchanged by the transport)',
          rec !== null && rec.pwd === leg.cwd && rec.oldpwd === leg.cwd)
        const logLine = read(join(sandbox, 'leg-t2.log'))
        t('T2: worker.log records the new argv shape with the prompt elided (plan policy)',
          logLine.includes('$ opencode run --agent plan -m fake/stub-model <prompt: 40000 chars>')
          && !logLine.includes(canary))
      }
    }

    // ---------- T3 — 100,000 chars ----------
    {
      const canary = 'T042-CANARY-t3-2be7f5a1'
      const prompt = canary + '\n' + 'z'.repeat(100_000 - canary.length - 1)
      t('T3: the leg prompt is exactly 100,000 chars', prompt.length === 100_000)
      const leg = await driveLeg('leg-t3', { prompt, executionPolicy: 'worktree-write' })
      const rec = readRecord(leg)
      if (leg.rejected !== null) {
        t(`T3: a 100,000-char prompt spawns and completes (observed instead: execute() rejected — ${leg.rejected.message})`, false)
      } else {
        t('T3: a 100,000-char prompt spawns, exits 0, ok: true',
          leg.result.ok === true && leg.result.exitCode === 0 && leg.result.timedOut === false)
        t('T3: the child received the FULL prompt verbatim over stdin', rec !== null && rec.stdin === prompt)
        t('T3: the stub received exactly 100,000 prompt bytes', rec !== null && Buffer.byteLength(rec.stdin) === 100_000)
        t('T3: no prompt bytes in argv (canary absent), argv shape exact',
          canaryAbsentFromArgv(rec, canary) && argvShapeOk(rec, false))
      }
    }

    // ---------- T4 — the composed-retry-brief ceiling (~70K chars) ----------
    {
      // The T-038/T-040 composition recipe at its documented caps
      // (src/runner.ts): MAX_DIFF_CHARS 30,000; RESPONSE_TAIL_CHARS 12,000
      // (the worker summary cap); each failing gate's outputTail 4,000
      // (src/gate/command.ts); MAX_RETRY_FINDINGS 5 ×
      // MAX_RETRY_FINDING_CHARS 2,000 per finding AND per evidence string.
      // composeGateRetryBrief is module-private, so this composes the
      // same-shaped text at the same sizes — the size class the ticket
      // names ("≈70K chars") is what must survive the spawn.
      const canary = 'T042-CANARY-t4-c93a1e64'
      const diff = 'DIFF-LINE-'.repeat(3_000) // 30,000 chars
      const summary = 'SUMMARY-LINE-'.repeat(923) + 'x'.repeat(12_000 - 'SUMMARY-LINE-'.length * 923) // 12,000
      const gateTails = [
        'gate build failed\n' + 'b'.repeat(4_000 - 'gate build failed\n'.length),
        'gate test failed\n' + 'c'.repeat(4_000 - 'gate test failed\n'.length),
      ] // 2 × 4,000
      const findings = Array.from({ length: 5 }, (_, i) => ({
        finding: `FINDING-${i}-`.padEnd(2_000, 'f'),
        evidence: `EVIDENCE-${i}-`.padEnd(2_000, 'e'),
      })) // 5 × (2,000 + 2,000)
      const prompt = [
        'Your previous attempt below WAS APPLIED to the workspace, but the machine gates REJECTED it.',
        'Fix the gate failures. The SAME machine gates re-run unchanged on this new attempt.',
        '',
        'ORIGINAL BRIEF:',
        `${canary} make the calculator more capable.`,
        '',
        'YOUR PREVIOUS DIFF (truncated to 30000 chars):',
        diff,
        '',
        'YOUR PREVIOUS ATTEMPT SUMMARY:',
        summary,
        '',
        'FAILED MACHINE GATES:',
        ...gateTails.flatMap((tail) => ['', 'GATE: build', 'COMMAND: node build.js', 'OUTPUT (tail):', tail]),
        '',
        'VERIFIER FINDINGS (advisory — fix these too. The SAME machine gates still decide):',
        ...findings.flatMap((f) => ['', `FINDING (blocker-advisory): ${f.finding}`, `EVIDENCE: ${f.evidence}`]),
      ].join('\n')
      t('T4: the composed retry-brief prompt is in the ~70K composition-ceiling class (≥70,000 chars)',
        prompt.length >= 70_000 && prompt.length > 32_767)
      const leg = await driveLeg('leg-t4', { prompt, executionPolicy: 'worktree-write' })
      const rec = readRecord(leg)
      if (leg.rejected !== null) {
        t(`T4: a composition-ceiling (~70K) retry brief survives a real spawn (observed instead: execute() rejected — ${leg.rejected.message})`, false)
      } else {
        t('T4: a composition-ceiling (~70K) retry brief spawns, exits 0, ok: true',
          leg.result.ok === true && leg.result.exitCode === 0 && leg.result.timedOut === false)
        t(`T4: the child received the FULL ${prompt.length}-char retry brief verbatim over stdin`,
          rec !== null && rec.stdin === prompt)
        t('T4: no prompt bytes in argv (canary absent), argv shape exact',
          canaryAbsentFromArgv(rec, canary) && argvShapeOk(rec, false))
      }
    }

    // ---------- T5 — byte-shape at normal size (<1K) ----------
    {
      const canary = 'T042-CANARY-t5-4d80b3f9'
      const prompt = [
        'You are implementing one brief of a multi-candidate implementation system.',
        `BRIEF: ${canary} add a percentage operation to the calculator.`,
        'Work only inside the current repository checkout.',
        'Produce a small, self-contained diff. Reply with a short summary when done.',
      ].join('\n')
      t('T5: the leg prompt is at normal size (<1K)', prompt.length < 1_000)
      const leg = await driveLeg('leg-t5', { prompt, executionPolicy: 'worktree-write' })
      const rec = readRecord(leg)
      if (leg.rejected !== null) {
        t(`T5: a normal-size prompt spawns and completes (observed instead: execute() rejected — ${leg.rejected.message})`, false)
      } else {
        t('T5: the model-facing bytes are byte-identical — the stub received the exact prompt text over stdin',
          rec !== null && rec.stdin === prompt)
        t('T5: responseTail collection unchanged (the stub\'s stdout rides the result)',
          leg.result.responseTail.includes('T042-STUB-STDOUT-MARKER'))
        t('T5: the spawn contract holds (onSpawn fired once, result.pid equals it)',
          leg.spawnPid !== null && leg.result.pid === leg.spawnPid)
        t('T5: env.PWD and env.OLDPWD are pinned to req.cwd (unchanged by the transport)',
          rec !== null && rec.pwd === leg.cwd && rec.oldpwd === leg.cwd)
        t('T5: no prompt bytes in argv (canary absent), argv shape exact',
          canaryAbsentFromArgv(rec, canary) && argvShapeOk(rec, false))
        const logLine = read(join(sandbox, 'leg-t5.log'))
        t(`T5: worker.log records the new argv shape with the prompt elided (worktree-write policy, <prompt: ${prompt.length} chars> marker byte-identical to the pre-T-042 format)`,
          logLine.includes(`$ opencode run -m fake/stub-model <prompt: ${prompt.length} chars>`)
          && !logLine.includes(canary))
      }
    }
  } finally {
    if (prevNodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = prevNodeOptions
    if (prevStubOut === undefined) delete process.env.T042_STUB_OUT
    else process.env.T042_STUB_OUT = prevStubOut
    rmSync(stubRecord, { force: true })
  }

  rmSync(sandbox, { recursive: true, force: true })
}

main()
  .catch((e) => {
    failures.push(`gate crashed: ${e instanceof Error ? e.message : String(e)}`)
    console.error(e)
  })
  .finally(() => {
    if (failures.length > 0) {
      console.error(`\ncheck-prompt-transport: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-prompt-transport: ALL GREEN')
  })
