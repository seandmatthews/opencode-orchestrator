// Bounded output accumulation self-check (Gate 1.44, fast tier, T-058) — run
// under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-bounded-output.mjs
// Zero model tokens. Register R11: a chatty child used to grow the
// orchestrator's heap without bound — the response-tail collectors in BOTH
// adapters (`collectText`) accumulated the entire stdout+stderr before the
// 12,000-char slice, and the probe core concatenated every case's capped
// output into one string and one writeFileSync (~320 MiB for the adversarial
// probe). Legs:
//   C   constants exported and pinned, never knobs (the MAX_RETRY_FINDINGS
//       pattern): MAX_TAIL_BUFFER_CHARS in BOTH adapters, MAX_PROBE_LOG_BYTES
//       in the probe core; no CLI flag exposes any of them.
//   S   source pins: the per-chunk front-trim in both adapters' collectText;
//       the probe core's bounded aggregate accumulator + write-time byte cap.
//   D1  under-cap byte-identity (machine adapter): a small drive's
//       responseTail is the whole out+err concat, byte for byte.
//   D2  over-cap byte-identity (opencode adapter): out beyond the 64,000-char
//       window with a tiny stderr — the surfaced tail still equals the true
//       final 12,000 chars, byte for byte (the tail-window guarantee).
//   D3  THE RECORDED RED BAR'S DRIVE, GREEN (machine adapter, the Gate 1.17
//       direct-drive precedent): a stub child emitting ~660 MB across both
//       streams, driven through the REAL execute()/collectText path inside a
//       node process constrained with --max-old-space-size=64. On main this
//       drive THREW (RangeError: Invalid string length at the unbounded
//       `out + err` join — recorded against this file pre-change; at the
//       ticket's illustrative ~50 MB the same constrained drive COMPLETED on
//       main, because this Node's V8 clamps 64 -> 112 MiB and does not
//       enforce the limit against retained strings — measured, see the
//       ticket) — post-change it must complete under the same constraint,
//       responseTail byte-identical, no cleanupFailures noise, and the log
//       FILE still carries the whole stream (disk, not heap).
//   D4  the same-constrained drive through the REAL OpenCodeWorker (the
//       Gate 1.28 stub-binPath precedent): same stub via NODE_OPTIONS
//       --require, same constraint, same verbatim tail pin.
//   P1  probe aggregate cap (adversarial probe, driven in-process the
//       Gate 1.15 way): a fixture target emitting more than the 16 MiB
//       per-case cap on EVERY case completes; success stays true (memory
//       hygiene never flips a verdict); the log artifact is at most
//       MAX_PROBE_LOG_BYTES; the bundle records the truncation as one loud
//       PROBE LOG TRUNCATED cleanupFailures line on the FINAL case entry
//       only; the bundle stays schema-valid.
//   P2  probe healthy-path byte-identity (command probe): a small run's log
//       artifact is byte-identical to the executed output, no truncation
//       line, schema-valid.
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MAX_TAIL_BUFFER_CHARS as TAIL_OPENCODE } from '../src/worker/opencode.ts'
import { MAX_TAIL_BUFFER_CHARS as TAIL_MACHINE } from '../src/worker/machine.ts'
import { MAX_PROBE_LOG_BYTES, CommandProbe, AdversarialProbe, validateEvidenceBundle } from '../src/probe.ts'
import { OpenCodeWorker } from '../src/worker/opencode.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const read = (p) => readFileSync(p, 'utf8')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-bounded-output'
const NODE = process.execPath
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')

// The position-sensitive emission pattern: every 122-char line embeds its own
// stream name and line index, so a tail verified verbatim cannot come from the
// wrong position. The check, the stub, and the expected-tail builder all use
// these exact strings.
const LINE_SUFFIX = '-' + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(3)
const lineAt = (prefix, i) => prefix + String(i).padStart(8, '0') + LINE_SUFFIX + '\n'
const LINE_BYTES = 122

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(join(sandbox, 'cwd'), { recursive: true })
mkdirSync(join(sandbox, 'logs'), { recursive: true })
mkdirSync(join(sandbox, 'probes', 'direct'), { recursive: true })

// ---------- the stub emitter (written once, used as script AND preload) ----
const stubPath = join(sandbox, 'stub-emit.cjs')
writeFileSync(stubPath, [
  '// T-058 stub: emits deterministic lines to fd 1 then fd 2 via synchronous',
  '// fs.writeSync (fully flushed before exit); counts from env, done-marker',
  '// last. Runs as a main script (machine leg) and as a NODE_OPTIONS --require',
  '// preload (opencode leg — it exits before node ever resolves the argv entry).',
  'const fs = require(\'node:fs\')',
  `const LINE_SUFFIX = ${JSON.stringify(LINE_SUFFIX)}`,
  'function batch(prefix, from, to) {',
  "  let s = ''",
  "  for (let i = from; i < to; i++) s += prefix + String(i).padStart(8, '0') + LINE_SUFFIX + '\\n'",
  "  return Buffer.from(s, 'utf8')",
  '}',
  'function emit(fd, prefix, total) {',
  '  const STEP = 8000',
  '  for (let from = 0; from < total; from += STEP) {',
  '    const buf = batch(prefix, from, Math.min(from + STEP, total))',
  '    let off = 0',
  '    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off)',
  '  }',
  '}',
  "emit(1, 'out:', Number(process.env.T058_OUT_LINES))",
  "emit(2, 'err:', Number(process.env.T058_ERR_LINES))",
  'fs.writeFileSync(process.env.T058_DONE, JSON.stringify({ outLines: Number(process.env.T058_OUT_LINES), errLines: Number(process.env.T058_ERR_LINES) }))',
  'process.exit(0)',
  '',
].join('\n'))

// ---------- the constrained driver (written once, both adapters) -----------
// Runs as its own node process — with or without --max-old-space-size=64 —
// imports the REAL adapter modules from this repo, drives the stub through
// execute(), and records the WorkerResult JSON to T058_RESULT.
const driverPath = join(sandbox, 'driver.mjs')
writeFileSync(driverPath, [
  `import { writeFileSync } from 'node:fs'`,
  `const adapter = process.argv[2]`,
  `const machineMod = await import(${JSON.stringify(pathToFileURL(join(root, 'src', 'worker', 'machine.ts')).href)})`,
  `const opencodeMod = adapter === 'opencode'`,
  `  ? await import(${JSON.stringify(pathToFileURL(join(root, 'src', 'worker', 'opencode.ts')).href)})`,
  `  : machineMod`,
  `const req = {`,
  `  prompt: 'T-058 bounded-accumulation drive (provenance only)',`,
  `  model: 'fake/stub-model',`,
  `  cwd: process.env.T058_CWD,`,
  `  logPath: process.env.T058_LOG,`,
  `  timeoutMs: 120_000,`,
  `  onSpawn: () => {},`,
  `}`,
  `let result`,
  `if (adapter === 'opencode') {`,
  '  process.env.NODE_OPTIONS = `--require ${process.env.T058_STUB.replaceAll(\'\\\\\', \'/\')}`',
  `  result = await new opencodeMod.OpenCodeWorker(process.execPath).execute(req)`,
  `} else {`,
  `  result = await new machineMod.MachineWorker([process.execPath, process.env.T058_STUB]).execute(req)`,
  `}`,
  `writeFileSync(process.env.T058_RESULT, JSON.stringify({`,
  `  ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut,`,
  `  responseTail: result.responseTail,`,
  `  cleanupFailures: result.cleanupFailures ?? [],`,
  `}))`,
  `console.log('T058 DRIVER DONE')`,
  '',
].join('\n'))

/** Drive one adapter leg against the stub (optionally heap-constrained). */
function drive(adapter, outLines, errLines, label, { constrained }) {
  const logPath = join(sandbox, 'logs', `${label}.log`)
  const resultPath = join(sandbox, `${label}.result.json`)
  const donePath = join(sandbox, `${label}.done.json`)
  const args = constrained
    ? [NODE, '--max-old-space-size=64', tsxCli, driverPath, adapter, String(outLines), String(errLines)]
    : [NODE, tsxCli, driverPath, adapter, String(outLines), String(errLines)]
  let out = ''
  let code = 0
  try {
    out = execFileSync(args[0], args.slice(1), {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 300_000,
      env: {
        ...process.env,
        T058_STUB: stubPath,
        T058_CWD: join(sandbox, 'cwd'),
        T058_LOG: logPath,
        T058_RESULT: resultPath,
        T058_DONE: donePath,
        T058_OUT_LINES: String(outLines),
        T058_ERR_LINES: String(errLines),
      },
    })
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  const result = existsSync(resultPath) ? JSON.parse(read(resultPath)) : null
  return { code, out, result, logPath, donePath }
}

/** The responseTail the unbounded collector would have produced: the true
 *  final 12,000 chars of out+err (all emissions are ASCII, so stripAnsi is
 *  the identity). Small drives build the full strings; the big drives use
 *  the analytic fact that |errText| >> 12,000, so the tail lies entirely in
 *  the last few hundred err lines. */
function expectedTail(outLines, errLines) {
  if (outLines <= 2000 && errLines <= 2000) {
    let outText = ''
    let errText = ''
    for (let i = 0; i < outLines; i++) outText += lineAt('out:', i)
    for (let i = 0; i < errLines; i++) errText += lineAt('err:', i)
    return (outText + errText).slice(-12_000)
  }
  let errTail = ''
  for (let i = Math.max(0, errLines - 200); i < errLines; i++) errTail += lineAt('err:', i)
  return errTail.slice(-12_000)
}

/** Windows of a file without reading it whole (the D3/D4 log is ~660 MB): the
 *  head, a 1 MB window around the computed out/err transition (wide enough to
 *  absorb the log header, the exit footer, and drain chunk-race at the
 *  boundary), and the tail. */
function fileEnds(path, errBytes, bytes = 65_536) {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const read = (offset, len) => {
      const n = Math.min(len, size - offset)
      const buf = Buffer.alloc(n)
      readSync(fd, buf, 0, n, offset)
      return buf.toString('utf8')
    }
    return {
      size,
      head: read(0, bytes),
      boundary: read(Math.max(0, size - errBytes - 524_288), 2 * 524_288),
      tail: read(Math.max(0, size - bytes), bytes),
    }
  } finally {
    closeSync(fd)
  }
}

const emittedBytes = (outLines, errLines) => (outLines + errLines) * LINE_BYTES

async function main() {
  // ---------- C: constants exported and pinned, never knobs ----------
  {
    t('C: MAX_TAIL_BUFFER_CHARS exported from BOTH adapters at the documented 64,000 (the MAX_RETRY_FINDINGS pattern — documented constant, never a knob)',
      TAIL_OPENCODE === 64_000 && TAIL_MACHINE === 64_000)
    t('C: the tail window stays >= the 12,000-char RESPONSE_TAIL_CHARS (the tail-window guarantee\'s precondition)',
      TAIL_OPENCODE >= 12_000 && TAIL_MACHINE >= 12_000)
    t('C: MAX_PROBE_LOG_BYTES exported at the documented 32 MiB, above one case\'s 16 MiB per-case cap',
      MAX_PROBE_LOG_BYTES === 32 * 1024 * 1024 && MAX_PROBE_LOG_BYTES > 16 * 1024 * 1024)
    const cli = read(join(root, 'src', 'cli.ts'))
    t('C: no CLI knob exposes the constants (src/cli.ts never names them)',
      !cli.includes('MAX_TAIL_BUFFER_CHARS') && !cli.includes('MAX_PROBE_LOG_BYTES')
      && !cli.includes('max-tail-buffer') && !cli.includes('max-probe-log'))
    const machineSrc = read(join(root, 'src', 'worker', 'machine.ts'))
    const opencodeSrc = read(join(root, 'src', 'worker', 'opencode.ts'))
    const probeSrc = read(join(root, 'src', 'probe.ts'))
    t('S: both adapters trim the accumulator from the FRONT per chunk (text.slice(-MAX_TAIL_BUFFER_CHARS)) — the tail is the only part responseTail surfaces',
      machineSrc.includes('if (text.length > MAX_TAIL_BUFFER_CHARS) text = text.slice(-MAX_TAIL_BUFFER_CHARS)')
      && opencodeSrc.includes('if (text.length > MAX_TAIL_BUFFER_CHARS) text = text.slice(-MAX_TAIL_BUFFER_CHARS)'))
    t('S: RESPONSE_TAIL_CHARS is unchanged at 12,000 in both adapters (the surfaced tail\'s length)',
      machineSrc.includes('const RESPONSE_TAIL_CHARS = 12_000') && opencodeSrc.includes('const RESPONSE_TAIL_CHARS = 12_000'))
    t('S: the probe core drops aggregate parts from the FRONT past the cap and byte-caps the FILE at the write (BoundedProbeLog + the UTF-8-safe tail slice)',
      probeSrc.includes('while (this.parts.length > 1 && this.bytes > MAX_PROBE_LOG_BYTES)')
      && probeSrc.includes('let start = full.length - MAX_PROBE_LOG_BYTES')
      && probeSrc.includes('(full[start]! & 0xc0) === 0x80'))
  }

  // ---------- D1: under-cap byte-identity (machine adapter) ----------
  {
    const outLines = 25
    const errLines = 17
    const r = drive('machine', outLines, errLines, 'd1-under', { constrained: false })
    t('D1: under-cap drive — the real adapter completes, ok, exit 0',
      r.code === 0 && r.result?.ok === true && r.result.exitCode === 0 && r.result.timedOut === false)
    t(`D1: responseTail is the whole out+err concat, byte for byte (${outLines * LINE_BYTES + errLines * LINE_BYTES} chars < 12,000)`,
      r.result?.responseTail === expectedTail(outLines, errLines))
    t('D1: capping adds no cleanupFailures noise (silent-by-design for the run)',
      Array.isArray(r.result?.cleanupFailures) && r.result.cleanupFailures.length === 0)
  }

  // ---------- D2: over-cap byte-identity, cross-boundary (opencode adapter) --
  {
    const outLines = 575 // 70,150 chars — beyond the 64,000-char window
    const errLines = 1 // the tail must reach back INTO the trimmed stdout
    const r = drive('opencode', outLines, errLines, 'd2-over', { constrained: false })
    t('D2: over-cap drive through the real OpenCodeWorker (stub binPath, the Gate 1.28 precedent) — ok, exit 0',
      r.code === 0 && r.result?.ok === true && r.result.exitCode === 0)
    t('D2: responseTail is the stream\'s true final 12,000 chars, byte for byte — the tail reaches from the tiny stderr back into the front-trimmed stdout',
      r.result?.responseTail === expectedTail(outLines, errLines))
  }

  // ---------- D3: THE RECORDED RED BAR'S DRIVE, GREEN (machine, constrained) -
  {
    const outLines = 3_200_000 // ~390 MB on stdout
    const errLines = 2_200_000 // ~268 MB on stderr
    const r = drive('machine', outLines, errLines, 'd3-constrained', { constrained: true })
    t(`D3: the red-bar drive (~${Math.round(emittedBytes(outLines, errLines) / 1048576)} MB across both streams, real MachineWorker, --max-old-space-size=64) completes under the constraint — on main's unbounded collector this exact drive THREW RangeError: Invalid string length at the out+err join (recorded red bar)`,
      r.code === 0 && r.result?.ok === true && r.result.exitCode === 0 && r.result.timedOut === false)
    t('D3: responseTail is byte-identical to the stream\'s true final 12,000 chars (the over-cap regime, both streams far past the window)',
      r.result?.responseTail === expectedTail(outLines, errLines))
    t('D3: no cleanupFailures noise on the capped drive', Array.isArray(r.result?.cleanupFailures) && r.result.cleanupFailures.length === 0)
    t('D3: the stub ran to completion', existsSync(r.donePath))
    const ends = fileEnds(r.logPath, errLines * LINE_BYTES)
    t(`D3: the log FILE still carries the whole stream (${ends.size} bytes >= ${emittedBytes(outLines, errLines)} emitted) — disk, not heap; no evidence lost`,
      ends.size >= emittedBytes(outLines, errLines))
    t('D3: the file holds the first out line, the out/err boundary (last out + first err lines), and the last err line — front AND end present',
      ends.head.includes(lineAt('out:', 0).trim())
      && ends.boundary.includes(lineAt('out:', outLines - 1).trim())
      && ends.boundary.includes(lineAt('err:', 0).trim())
      && ends.tail.includes(lineAt('err:', errLines - 1).trim()))
  }

  // ---------- D4: the same-constrained drive, opencode adapter ----------
  {
    const outLines = 3_200_000
    const errLines = 2_200_000
    const r = drive('opencode', outLines, errLines, 'd4-constrained', { constrained: true })
    t('D4: the same constrained ~660 MB drive through the real OpenCodeWorker (stub preload) completes under --max-old-space-size=64',
      r.code === 0 && r.result?.ok === true && r.result.exitCode === 0 && r.result.timedOut === false)
    t('D4: responseTail is byte-identical to the stream\'s true final 12,000 chars',
      r.result?.responseTail === expectedTail(outLines, errLines))
    const ends = fileEnds(r.logPath, errLines * LINE_BYTES)
    t(`D4: the log FILE still carries the whole stream (${ends.size} bytes >= ${emittedBytes(outLines, errLines)} emitted)`,
      ends.size >= emittedBytes(outLines, errLines))
  }

  // ---------- P1: probe aggregate cap (adversarial probe, in-process) --------
  {
    // 17 MiB per case — MORE than the per-case cap on every case; the stub
    // target ignores its argv case input, emits ASCII, exits 0 (survives).
    // It is a FILE, not `-e`: the adversarial corpus feeds flag-like argv
    // (case 7 is `-0`), which a script path safely demotes to the script's
    // own argv.
    const targetPath = join(sandbox, 'adv-target.cjs')
    writeFileSync(targetPath, [
      "const fs = require('node:fs')",
      'const b = Buffer.alloc(1024 * 1024, 0x61)',
      'for (let i = 0; i < 17; i++) {',
      '  let off = 0',
      '  while (off < b.length) off += fs.writeSync(1, b, off, b.length - off)',
      '}',
      "fs.writeSync(1, Buffer.from('\\n'))",
      'process.exit(0)',
      '',
    ].join('\n'))
    const scenario = {
      id: 'adv-t058',
      type: 'adversarial',
      command: { exe: NODE, args: [targetPath] },
      seed: 7,
      timeoutMs: 180_000,
    }
    const probe = new AdversarialProbe(scenario)
    const bundle = await probe.run({
      workspace: { id: 'wt/direct', path: join(sandbox, 'cwd'), branch: 'main', baseSha: '(direct)' },
      scenario: probe.scenario,
      environment: { artifactsDir: join(sandbox, 'probes'), candidateId: 'direct' },
    })
    t('P1: a fixture target emitting more than the per-case cap on EVERY case completes with success true (memory hygiene never flips a verdict)',
      bundle.success === true)
    if (bundle.success !== true) console.error(`--- P1 debug: error=${JSON.stringify(bundle.error)} first-fail=${JSON.stringify(bundle.gateResults.find((g) => !g.passed)?.outputTail?.slice(0, 300))}`)
    let p1SchemaValid = false
    try {
      validateEvidenceBundle(JSON.parse(JSON.stringify(bundle)))
      p1SchemaValid = true
    } catch {
      p1SchemaValid = false
    }
    t('P1: the bundle stays schema-valid (validateEvidenceBundle accepts it)', p1SchemaValid)
    const logRef = bundle.artifacts[0]
    const logSize = statSync(logRef.path).size
    t(`P1: the aggregate log artifact is at most MAX_PROBE_LOG_BYTES (${logSize} <= ${MAX_PROBE_LOG_BYTES}; ref.sizeBytes ${logRef.sizeBytes} matches the file)`,
      logSize <= MAX_PROBE_LOG_BYTES && logRef.sizeBytes === logSize)
    t('P1: 20 case entries, each carrying its own recorded evidence',
      bundle.gateResults.length === 20 && bundle.gateResults[0].name === 'adv-t058#case-1' && bundle.gateResults[19].name === 'adv-t058#case-20')
    const last = bundle.gateResults[19]
    const truncLine = (last.cleanupFailures ?? []).find((l) => l.startsWith('PROBE LOG TRUNCATED: '))
    const m = truncLine !== undefined ? /^PROBE LOG TRUNCATED: kept the final (\d+) of (\d+) bytes/.exec(truncLine) : null
    t('P1: the bundle records the truncation — one loud PROBE LOG TRUNCATED cleanupFailures line on the FINAL case entry (kept within the cap, of a total above it)',
      m !== null && Number(m[1]) <= MAX_PROBE_LOG_BYTES && Number(m[2]) > MAX_PROBE_LOG_BYTES && Number(m[1]) > 0)
    t('P1: no truncation line on the other 19 case entries (the aggregate fact records once, not spam)',
      bundle.gateResults.slice(0, 19).every((g) => g.cleanupFailures === undefined))
    t('P1: the per-case results artifact still rides the bundle', bundle.artifacts[1]?.name === 'adv-t058.results.json' && existsSync(bundle.artifacts[1].path))
  }

  // ---------- P2: probe healthy-path byte-identity (command probe) -----------
  {
    const scenario = {
      id: 'cmd-t058',
      type: 'command',
      command: { exe: NODE, args: ['-e', "require('node:fs').writeSync(1, 'alpha-t058\\nbeta-t058\\n')"] },
      timeoutMs: 60_000,
    }
    const probe = new CommandProbe(scenario)
    const bundle = await probe.run({
      workspace: { id: 'wt/direct', path: join(sandbox, 'cwd'), branch: 'main', baseSha: '(direct)' },
      scenario: probe.scenario,
      environment: { artifactsDir: join(sandbox, 'probes'), candidateId: 'direct' },
    })
    t('P2: healthy small-run command probe — success true, schema-valid',
      bundle.success === true && validateEvidenceBundle(JSON.parse(JSON.stringify(bundle))).success === true)
    const logRef = bundle.artifacts[0]
    const logBytes = readFileSync(logRef.path)
    t('P2: the log artifact is byte-identical to the executed output (21 bytes, no truncation, ref.sizeBytes exact)',
      logBytes.equals(Buffer.from('alpha-t058\nbeta-t058\n')) && logRef.sizeBytes === 21 && statSync(logRef.path).size === 21)
    if (!(logBytes.equals(Buffer.from('alpha-t058\nbeta-t058\n')) && logRef.sizeBytes === 21)) {
      console.error(`--- P2 debug: success=${bundle.success} error=${JSON.stringify(bundle.error)} size=${logBytes.length} content=${JSON.stringify(logBytes.toString('utf8').slice(0, 300))}`)
    }
    t('P2: no truncation line, no cleanupFailures on the healthy path',
      bundle.gateResults[0].cleanupFailures === undefined)
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
      console.error(`\ncheck-bounded-output: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-bounded-output: ALL GREEN')
  })
