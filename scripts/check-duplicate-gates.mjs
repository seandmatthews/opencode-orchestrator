// Duplicate-gate-name refusal self-check (Gate 1.43, fast tier, T-057) — run
// under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-duplicate-gates.mjs
// Pins the two parse-time refusals that close the store's last-write-wins
// gate-evidence loss (adversarial review 2026-10-23, R7a): gate_results is
// keyed (run_id, candidate_id, gate_name) with an upsert
// (src/store/index.ts), so two gates sharing a name recorded BOTH verdicts
// in report.json but only the LAST one in the durable store — a
// first-failed/second-passed pair read as an all-pass gate table for an
// eliminated candidate. The ladder was never affected (it reads the
// in-memory array), which is exactly why the divergence went unnoticed.
// Three legs, all token-free:
//
//   A — parser contract: a --jobs spec whose job carries two gates named
//       `build` refuses at parse time naming the job and the duplicated
//       name (the probe-id `seen`-set precedent, src/scheduler.ts);
//       uniqueness is PER JOB (two jobs may each carry a `build` — the
//       store keys rows per candidate too); unique-named specs parse
//       byte-identically to main's output; the duplicate-probe-id refusal
//       is unchanged.
//   B — CLI faces: repeated --gate names refuse at parse time naming the
//       duplicate, and the --jobs duplicate-gate spec refuses through the
//       real CLI — both BEFORE repo validation (a deliberately-absent
//       --repo would otherwise name the repo error, the recorded red-bar
//       contrast), with ZERO side effects (no artifacts dir, no lock under
//       the sandbox run root). Control faces: distinct names parse past
//       (the failure is the repo error — parse accepted), on main's
//       recorded behavior.
//   C — the loss mechanism, for the record: ingest of a same-named
//       build(fail)+build(pass) pair upserts to ONE gate_results row
//       carrying the LAST verdict — the store contract the refusals guard.
//       The store is unchanged by T-057 (refusal upstream, at both parse
//       sites); post-change the engine can no longer PRODUCE such a report.
//
// Red bars, recorded FIRST against main (AGENTS.md #8; a read-only probe
// importing main's src/scheduler.ts + src/store/index.ts and driving main's
// src/cli.ts as a subprocess, before this change-set existed):
//   RED1  parseJobsSpec of a spec with two gates named `build` on one job
//         PARSED, returning both:
//         [{"name":"build","command":"node build.js"},{"name":"build","command":"node test.js"}]
//   RED2  repeated --gate "a=…" --gate "a=…" PARSED — the CLI failed later,
//         at repo validation ("--repo '…' is not a git repository…"), not
//         at parse time.
//   RED3  ingest of build(fail)+build(pass) left ONE gate_results row:
//         {"gate_name":"build","passed":1,"exit_code":0,"output_tail":"second passed"}
//         (the first-failure evidence gone).
// Intentional shape (asserted in the same probe): no JSON fixture in the
// repo carries a gates array with duplicate names, and no `--gate` literal
// in scripts/src/docs repeats a name — the ticket's premise held (the
// T-057 ticket file itself, which quotes the red-bar example, excluded,
// stated there).
//
// All subprocesses are list-form (AGENTS.md #4); the sandbox under C:\swarm
// is created and removed by this check (AGENTS.md #10).
import { swarmRoot } from './swarm-root.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { parseJobsSpec } from '../src/scheduler.ts'
import { ingest } from '../src/store/index.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const sandbox = swarmRoot + '/verify-duplicate-gates'
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })
const runRoot = join(sandbox, 'runs')

const noSideEffects = (label) => {
  const entries = existsSync(runRoot) ? readdirSync(runRoot) : []
  t(`${label}: zero side effects — no artifacts dir, no lock under the sandbox run root`,
    entries.filter((d) => /^\d{14}$/.test(d)).length === 0 && !existsSync(join(runRoot, 'locks')))
}

// The CLI driven as a real subprocess (list-form), against a
// deliberately-absent repo: a parse-passing invocation fails LATER with the
// repo-validation message (RED2's recorded main behavior), so the refusal
// message itself proves WHERE the run stopped.
const absentRepo = join(sandbox, 'no-such-repo')
const runCli = (label, args) => {
  const r = spawnSync(process.execPath, [tsxCli, join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8' })
  const code = r.status === null ? -1 : r.status
  const out = `${r.stderr ?? ''}${r.stdout ?? ''}`
  if (code !== 1) console.error(`--- cli output (${label}, exit ${code}) ---\n${out}`)
  return { code, out }
}

// ---------- Leg A — parser contract (parseJobsSpec) ----------
console.log('--- A: parseJobsSpec — duplicate gate names refuse at parse time ---')
{
  const dupSpec = {
    phases: [{ id: 'p1', completion: 'all' }],
    jobs: [{ id: 'j1', phase: 'p1', brief: 'b', gates: [
      { name: 'build', command: 'node build.js' },
      { name: 'build', command: 'node test.js' },
    ] }],
  }
  let threw = null
  try { parseJobsSpec(structuredClone(dupSpec)) } catch (e) { threw = e }
  t('A: a spec with two gates named build on one job REFUSES at parse time (main returned both gates; the recorded red bar)',
    threw !== null)
  t('A: the refusal names the job (job \'j1\')',
    threw !== null && threw.message.includes("job 'j1'"))
  t('A: the refusal names the duplicated gate name (\'build\')',
    threw !== null && threw.message.includes("'build'"))

  // Scope: uniqueness is PER JOB — the store keys gate_results per candidate
  // too (one candidate per job), so two jobs may each carry a `build`.
  let scoped = null
  let scopedThrew = null
  try {
    scoped = parseJobsSpec({
      phases: [{ id: 'p1', completion: 'all' }],
      jobs: [
        { id: 'j1', phase: 'p1', brief: 'b', gates: [{ name: 'build', command: 'node build.js' }] },
        { id: 'j2', phase: 'p1', brief: 'b', gates: [{ name: 'build', command: 'node other.js' }] },
      ],
    })
  } catch (e) { scopedThrew = e }
  t('A: uniqueness is per job — two jobs each carrying a build gate parse unchanged',
    scopedThrew === null && scoped !== null && scoped.jobs.length === 2 && scoped.jobs.every((j) => j.gates.length === 1))

  // Preserved case, pinned explicitly: unique-named gates parse to main's
  // exact output.
  const unique = parseJobsSpec({
    phases: [{ id: 'p1', completion: 'all' }],
    jobs: [{ id: 'j1', phase: 'p1', brief: 'b', gates: [
      { name: 'build', command: 'node build.js' },
      { name: 'test', command: 'node test.js' },
    ] }],
  })
  t('A: preserved byte-identity — unique-named gates parse to the exact main shape (order and values verbatim)',
    JSON.stringify(unique.jobs[0].gates) === JSON.stringify([{ name: 'build', command: 'node build.js' }, { name: 'test', command: 'node test.js' }]))
  const sameCmd = parseJobsSpec({
    phases: [{ id: 'p1', completion: 'all' }],
    jobs: [{ id: 'j1', phase: 'p1', brief: 'b', gates: [
      { name: 'a', command: 'node x.js' },
      { name: 'b', command: 'node x.js' },
    ] }],
  })
  t('A: distinct names sharing one command parse unchanged (the NAME is the store key, not the command)',
    JSON.stringify(sameCmd.jobs[0].gates) === JSON.stringify([{ name: 'a', command: 'node x.js' }, { name: 'b', command: 'node x.js' }]))

  // The precedent this change extends is itself untouched.
  let probeThrew = null
  try {
    parseJobsSpec({
      phases: [{ id: 'p1', completion: 'all' }],
      jobs: [{ id: 'j1', phase: 'p1', brief: 'b', probes: [
        { id: 'same-id', type: 'command', command: { exe: 'node', args: ['x.js'] } },
        { id: 'same-id', type: 'command', command: { exe: 'node', args: ['y.js'] } },
      ] }],
    })
  } catch (e) { probeThrew = e }
  t('A: the probe-id refusal is unchanged (the precedent extended, not altered)',
    probeThrew !== null && probeThrew.message.includes("duplicate probe id 'same-id'"))
}

// ---------- Leg B — CLI faces (parse-time refusals, zero side effects) ----------
console.log('--- B: the CLI refuses repeated --gate names and duplicate --jobs gate names at parse time ---')
{
  // Face 1 — repeated --gate names.
  const dupGate = runCli('dup --gate', [
    '--repo', absentRepo, '--goal', 'gate refusal check',
    '--gate', 'a=node -e "process.exit(0)"', '--gate', 'a=node -e "process.exit(0)"',
    '--run-root', runRoot,
  ])
  t('B: repeated --gate names refuse with exit 1 (got ' + dupGate.code + ')', dupGate.code === 1)
  t('B: the refusal names the duplicate (\'a\') and says so at parse time',
    /duplicate --gate name 'a'/.test(dupGate.out))
  t('B: the refusal is the PARSE refusal, not the later repo error (the absent repo would name it; the recorded main red bar)',
    !dupGate.out.includes('is not a git repository'))
  noSideEffects('B (dup --gate)')

  // Face 2 — duplicate gate names in a --jobs spec, through the real CLI
  // (loadJobsSpec runs before repo validation — src/cli.ts main()).
  const specPath = join(sandbox, 'dup-gates-spec.json')
  writeFileSync(specPath, JSON.stringify({
    phases: [{ id: 'p1', completion: 'all' }],
    jobs: [{ id: 'j1', phase: 'p1', brief: 'b', gates: [
      { name: 'build', command: 'node build.js' },
      { name: 'build', command: 'node test.js' },
    ] }],
  }, null, 2))
  const dupSpec = runCli('dup spec', [
    '--repo', absentRepo, '--jobs', specPath, '--run-root', runRoot,
  ])
  t('B: a --jobs spec with duplicate gate names refuses through the CLI with exit 1 (got ' + dupSpec.code + ')', dupSpec.code === 1)
  t('B: the CLI refusal names the job (job \'j1\') and the duplicated name (\'build\')',
    dupSpec.out.includes("job 'j1'") && dupSpec.out.includes("'build'"))
  t('B: the spec refusal precedes repo validation (no repo error; loadJobsSpec runs first)',
    !dupSpec.out.includes('is not a git repository'))
  noSideEffects('B (dup spec)')

  // Control faces — distinct names parse PAST the gate loop: the failure is
  // the repo-validation error, exactly main's recorded parse-pass behavior.
  const okGate = runCli('distinct --gate control', [
    '--repo', absentRepo, '--goal', 'control',
    '--gate', 'a=node -e "process.exit(0)"', '--gate', 'b=node -e "process.exit(0)"',
    '--run-root', runRoot,
  ])
  t('B (control): distinct --gate names still parse — the failure is the absent-repo error, not a gate refusal',
    okGate.code === 1 && okGate.out.includes('is not a git repository')
    && !okGate.out.includes('duplicate --gate name') && !okGate.out.includes('duplicate gate name'))
  noSideEffects('B (control)')

  const uniqueSpecPath = join(sandbox, 'unique-gates-spec.json')
  writeFileSync(uniqueSpecPath, JSON.stringify({
    phases: [{ id: 'p1', completion: 'all' }],
    jobs: [{ id: 'j1', phase: 'p1', brief: 'b', gates: [
      { name: 'build', command: 'node build.js' },
      { name: 'test', command: 'node test.js' },
    ] }],
  }, null, 2))
  const okSpec = runCli('unique spec control', [
    '--repo', absentRepo, '--jobs', uniqueSpecPath, '--run-root', runRoot,
  ])
  t('B (control): a unique-named --jobs spec still parses — the failure is the absent-repo error',
    okSpec.code === 1 && okSpec.out.includes('is not a git repository')
    && !okSpec.out.includes('duplicate --gate name') && !okSpec.out.includes('duplicate gate name'))
  noSideEffects('B (control)')
}

// ---------- Leg C — the loss mechanism, for the record ----------
console.log('--- C: the store\'s last-write-wins is real — the refusals guard it upstream ---')
{
  const dbPath = join(sandbox, 'loss-demo.db')
  const report = {
    runId: 'dupgate57T00001', repo: 'C:/nowhere', baseSha: '0'.repeat(40), goal: 'g', model: 'm',
    startedAt: '2026-10-26T00:00:00.000Z', finishedAt: '2026-10-26T00:01:00.000Z',
    candidates: [{
      id: 'c01', workerId: 'w', model: 'm', brief: 'b', workspacePath: null,
      workerOk: true, workerTimedOut: false, workerDurationMs: 1000, diffPath: null, diffBytes: 10,
      gates: [
        { name: 'build', passed: false, exitCode: 1, durationMs: 5, outputTail: 'FIRST ATTEMPT FAILED — the evidence the upsert drops' },
        { name: 'build', passed: true, exitCode: 0, durationMs: 5, outputTail: 'second passed' },
      ],
      passedAllGates: false, attempts: [],
    }],
  }
  ingest(report, dbPath)
  const db = new DatabaseSync(dbPath)
  const rows = db.prepare('SELECT gate_name, passed, exit_code, output_tail FROM gate_results WHERE run_id = ?').all(report.runId)
  db.close()
  t('C: a same-named gate pair upserts to ONE gate_results row (the store contract, demonstrated once for the record)',
    rows.length === 1)
  t('C: the surviving row is the LAST write — a first-failed/second-passed pair would read as all-pass (the loss the parse refusals close)',
    rows.length === 1 && rows[0].passed === 1 && rows[0].output_tail === 'second passed')
}

rmSync(sandbox, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\ncheck-duplicate-gates: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-duplicate-gates: ALL GREEN')
