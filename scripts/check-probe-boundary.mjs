// Probe class-boundary contracts self-check (Gate 1.49, fast tier, T-063 —
// register R18's first disposition branch) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-probe-boundary.mjs
// Token-free (zero model calls, the Gate 1.15 pattern), three legs:
//   1. class-boundary capture refusals — a DIRECTLY constructed
//      ScreenshotProbe scenario (createProbe, never through parseJobsSpec)
//      with an absolute (drive-letter, backslash, UNC, rooted) or '..'
//      capture path is REFUSED by the class with the spec parser's own
//      vocabulary, BEFORE the capture command runs. The red bar was
//      recorded on main before the change (the same two faces NOT refused;
//      the '..' face completing the exfiltration — success:true, the
//      fixture PNG five levels above the workspace copied into the run's
//      evidence — quoted in VERIFICATION.md's Gate 1.49 section and T-063's
//      Landed). A valid workspace-relative capture still runs to success
//      (the guard does not over-refuse).
//   2. parse-side parity — for every refusal input, parseJobsSpec refuses
//      and its message ENDS WITH the class-side rule (the where-prefix is
//      the only difference): the two sides cannot diverge. A well-formed
//      spec with a valid capture still parses verbatim (the in-pipeline
//      path is unchanged — the full parity suite is Gate 1.15's, running
//      green beside this gate).
//   3. evidence-path ids (the VALIDATE branch of the ticket's two-part
//      disposition — the read showed neither id provably engine-generated
//      at the module boundary: candidateId is the operator-supplied --jobs
//      job id in-pipeline, probeId the operator-supplied scenario id, both
//      charset-checked only one layer up by parseJobsSpec): every id
//      interpolated into an evidence path is checked against SPEC_ID_PATTERN
//      before join() — a '..'/absolute candidateId or probeId throws and
//      NOTHING is written (join normalizes '..' away, so an unchecked id
//      could point the run folder or an evidence file outside the artifacts
//      dir); a full happy-path probe run with the pipeline's own id shapes
//      (c01 / shot-1) is untouched.
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createProbe,
  evidenceBundlePath,
  failedBundle,
  probeEvidenceDir,
  writeEvidenceBundle,
} from '../src/probe.ts'
import { parseJobsSpec, SPEC_ID_PATTERN } from '../src/scheduler.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-probe-boundary'
rmSync(sandbox, { recursive: true, force: true })
// Deep-nested workspace — the recorded red bar's shape: a '..' chain from
// here escapes the sandbox upward.
const wsPath = join(sandbox, 'a', 'b', 'c', 'ws')
mkdirSync(wsPath, { recursive: true })
const artifactsDir = join(sandbox, 'artifacts')
const shotFixture = join(root, 'scripts', 'fixtures', 'tiny-1x1.png')

// The probe id every refusal face shares, so the class-side rule can be
// extracted by stripping one known prefix.
const PID = 'sp'
const classPrefix = `screenshot probe '${PID}': `

// A capture command that would leave a marker in the workspace if it ever
// ran — the "never silently run" pin reads its absence.
const markerCmd = {
  exe: process.execPath,
  args: ['-e', "require('node:fs').writeFileSync('marker-ran.txt', 'ran'); process.exit(0)"],
}
const markerPath = join(wsPath, 'marker-ran.txt')

async function runScenario(scenario, environment) {
  const probe = createProbe(scenario)
  return probe.run({
    workspace: { id: 'wt/boundary', path: wsPath, branch: 'main', baseSha: '(boundary)' },
    scenario: probe.scenario,
    environment,
  })
}

async function classRefusal(capture) {
  rmSync(markerPath, { force: true })
  try {
    await runScenario({ id: PID, type: 'screenshot', capture, command: markerCmd }, { artifactsDir, candidateId: 'c01' })
    return { refused: false, message: '', markerRan: existsSync(markerPath) }
  } catch (e) {
    return { refused: true, message: e instanceof Error ? e.message : String(e), markerRan: existsSync(markerPath) }
  }
}

function parseRefusal(capture) {
  const spec = {
    phases: [{ id: 'p' }],
    jobs: [{ id: 'j1', phase: 'p', brief: 'b', probes: [{ id: PID, type: 'screenshot', command: { exe: 'node', args: [] }, capture }] }],
  }
  try {
    parseJobsSpec(spec)
    return { refused: false, message: '' }
  } catch (e) {
    return { refused: true, message: e instanceof Error ? e.message : String(e) }
  }
}

function throwsWith(fn) {
  try {
    fn()
    return { threw: false, message: '' }
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) }
  }
}

console.log('--- leg 1+2: class-boundary capture refusals + parse-side parity ---')

const refusalInputs = [
  // [input, expected rule prefix] — the rules are the parser's own, verbatim.
  ['', 'capture must be a non-empty workspace-relative path on a screenshot probe'],
  [undefined, 'capture must be a non-empty workspace-relative path on a screenshot probe'],
  [67, 'capture must be a non-empty workspace-relative path on a screenshot probe'],
  ['C:/abs/shot.png', 'capture must be workspace-relative; absolute paths are refused'],
  ['C:\\abs\\shot.png', 'capture must be workspace-relative; absolute paths are refused'],
  ['\\\\srv\\share\\shot.png', 'capture must be workspace-relative; absolute paths are refused'],
  ['/rooted/shot.png', 'capture must be workspace-relative; absolute paths are refused'],
  ['../up.png', "capture must not contain a '..' segment"],
  ['a/../up.png', "capture must not contain a '..' segment"],
  ['a\\..\\up.png', "capture must not contain a '..' segment"],
  ['a/../../up.png', "capture must not contain a '..' segment"],
]

for (const [input, rulePrefix] of refusalInputs) {
  const label = input === undefined ? 'missing' : JSON.stringify(input)
  // Both sides render the raw value through JSON.stringify in a template —
  // undefined interpolates as the string 'undefined', matching exactly.
  const got = `(got ${JSON.stringify(input)})`
  const cls = await classRefusal(input)
  t(`class refuses capture ${label} (the recorded red faces now refused)`,
    cls.refused && cls.message.startsWith(classPrefix))
  t(`  with the spec parser's rule: ${rulePrefix.slice(0, 46)}...`,
    cls.refused && cls.message.slice(classPrefix.length).startsWith(rulePrefix))
  t(`  and the ${got} shape carrying the input verbatim`,
    cls.refused && cls.message.includes(got))
  t('  BEFORE the capture command runs (no marker in the workspace)',
    !cls.markerRan)
  const parse = parseRefusal(input)
  const rule = cls.refused ? cls.message.slice(classPrefix.length) : ''
  t("parseJobsSpec refuses the same input and the messages agree (non-divergence: parse msg = where-prefix + class rule)",
    parse.refused
      && parse.message.startsWith("--jobs spec refused: job 'j1' probes[0] ")
      && parse.message.endsWith(rule))
}

// The recorded red-bar faces, asserted by name for the ticket's traceability:
// an absolute path at a real PNG outside the workspace, and the 5-up '..'
// chain that completed the exfiltration on main (success:true + copy).
const redAbs = await classRefusal(shotFixture)
t('RED FACE 1 (absolute path at the fixture PNG): refused with the absolute-path rule',
  redAbs.refused && redAbs.message.includes('absolute paths are refused'))
const redDots = await classRefusal('../../../../../scripts/fixtures/tiny-1x1.png')
t("RED FACE 2 (the '..' chain that exfiltrated on main): refused with the '..' rule",
  redDots.refused && redDots.message.includes("must not contain a '..' segment"))

// Control: a valid workspace-relative capture still runs to success and the
// durable copy lands at the evidence path (the guard does not over-refuse;
// the pipeline's legitimate shape is untouched).
const happyEnv = { artifactsDir, candidateId: 'c01' }
const happyScenario = {
  id: 'shot-happy',
  type: 'screenshot',
  capture: 'shots/happy.png',
  command: {
    exe: process.execPath,
    args: [
      '-e',
      "require('node:fs').mkdirSync(require('node:path').dirname(process.argv[2]), { recursive: true }); require('node:fs').copyFileSync(process.argv[1], process.argv[2])",
      shotFixture,
      'shots/happy.png',
    ],
  },
}
const happy = await runScenario(happyScenario, happyEnv)
t('control: valid relative capture still succeeds with the durable copy at <artifactsDir>/probes/<candidateId>/<probeId>.png',
  happy.success === true
  && happy.artifacts.some((a) => a.kind === 'screenshot' && a.name === 'shot-happy.png')
  && existsSync(join(artifactsDir, 'probes', 'c01', 'shot-happy.png')))

console.log('--- leg 3: evidence-path ids (the VALIDATE branch) ---')

const idCharset = 'does not match [a-z0-9][a-z0-9-]*'

const badCandidateDir = throwsWith(() => probeEvidenceDir(artifactsDir, '../escape'))
t('probeEvidenceDir refuses a ".." candidateId (join would normalize it outside the artifacts dir)',
  badCandidateDir.threw && badCandidateDir.message.includes(`evidence path candidateId "../escape" ${idCharset}`))
const absCandidateDir = throwsWith(() => probeEvidenceDir(artifactsDir, 'C:/abs'))
t('probeEvidenceDir refuses an absolute candidateId',
  absCandidateDir.threw && absCandidateDir.message.includes(`evidence path candidateId "C:/abs" ${idCharset}`))
const badProbeBundle = throwsWith(() => evidenceBundlePath(artifactsDir, 'c01', '../escape'))
t('evidenceBundlePath refuses a ".." probeId (the evidence FILE name)',
  badProbeBundle.threw && badProbeBundle.message.includes(`evidence path probeId "../escape" ${idCharset}`))
const badCandidateBundle = throwsWith(() => evidenceBundlePath(artifactsDir, '../escape', 'p1'))
t('evidenceBundlePath refuses a bad candidateId (via the run-folder helper)',
  badCandidateBundle.threw && badCandidateBundle.message.includes(`evidence path candidateId "../escape" ${idCharset}`))

// writeEvidenceBundle with a bad probeId: refused BEFORE any file is built
// or written — in a FRESH artifacts dir (never touched by the control leg
// above), so "nothing written" is a real assertion: the dir does not even
// exist (and no path was ever constructed outside it).
const artifactsDirBad = join(sandbox, 'artifacts-bad')
const badIdBundle = failedBundle('../escape', '../escape', 'id refusal face')
const wrote = throwsWith(() => writeEvidenceBundle(badIdBundle, { artifactsDir: artifactsDirBad, candidateId: 'c01' }))
t('writeEvidenceBundle refuses a charset-violating probeId and writes nothing',
  wrote.threw && wrote.message.includes(`evidence path probeId "../escape" ${idCharset}`)
  && !existsSync(artifactsDirBad))

// The hand-built ENVIRONMENT face: a bad candidateId on an otherwise valid
// screenshot run throws inside run() (the log writer's probeEvidenceDir)
// and the fresh artifacts dir is never even created.
let badEnvThrew = false
let badEnvMessage = ''
try {
  await runScenario({ ...happyScenario, id: 'shot-badenv' }, { artifactsDir: artifactsDirBad, candidateId: '../escape' })
} catch (e) {
  badEnvThrew = true
  badEnvMessage = e instanceof Error ? e.message : String(e)
}
t('a directly constructed environment with a ".." candidateId is refused, nothing written',
  badEnvThrew && badEnvMessage.includes(`evidence path candidateId "../escape" ${idCharset}`)
  && !existsSync(artifactsDirBad))

// The in-pipeline-ids-unaffected leg (the honesty face of the VALIDATE
// branch): the charset is the engine's own SPEC_ID_PATTERN and it accepts
// exactly the shapes the pipeline produces — engine-generated default-mode
// candidate ids, operator --jobs job/probe ids, rounds' -r2 suffixes.
const pipelineShapes = ['c01', 'c12', 'job-a', 'shot-1', 'c01-r2']
t(`SPEC_ID_PATTERN accepts every pipeline id shape (${pipelineShapes.join(', ')})`,
  pipelineShapes.every((s) => SPEC_ID_PATTERN.test(s)))
t('the happy-path run above already proved the guard lets those ids through (bundle + png on disk)',
  existsSync(join(artifactsDir, 'probes', 'c01', 'shot-happy.png')))

// Positive parse parity: a well-formed spec carrying a valid capture still
// parses with the capture preserved verbatim (the in-pipeline path for
// valid inputs is byte-identical; the refusal faces above pin the rest).
const parsed = parseJobsSpec({
  phases: [{ id: 'p' }],
  jobs: [{ id: 'j1', phase: 'p', brief: 'b', probes: [{ id: PID, type: 'screenshot', command: { exe: 'node', args: [] }, capture: 'shots/happy.png' }] }],
})
t('parse-side control: a valid capture parses and is preserved verbatim',
  parsed.jobs[0].probes[0].capture === 'shots/happy.png')

// Tidy on success only — leave the tree for post-mortem on failure.
if (failures.length === 0) rmSync(sandbox, { recursive: true, force: true })

console.log(failures.length === 0 ? '\nprobe-boundary self-check: ALL GREEN' : `\nprobe-boundary self-check: ${failures.length} failure(s)`)
process.exit(failures.length === 0 ? 0 : 1)
