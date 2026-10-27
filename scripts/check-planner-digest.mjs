// Planner repo digest self-check (Gate 1.45, fast tier, T-059) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-planner-digest.mjs
// Pins T-059 (the adversarial review 2026-10-23's R14, minimal producer): a
// deterministic file-tree/manifest digest of the TARGET repo at the run's
// baseSha rides the planner prompt through the existing contextBlock seam in
// BOTH rounds — bytes, never access (the planner's scratch cwd, capability
// posture, and parse path are untouched; the digest names no repo path).
// Composed by src/planner-digest.ts under two documented caps (MAX_DIGEST_
// PATHS / MAX_DIGEST_CHARS) whose truncations are LOUD (the digest says it
// was cut and names the binding cap), persisted as planner-digest.txt under
// the run artifacts dir with its sha256 in report.json, and opted out by
// --no-planner-context (default ON at the CLI).
//
// Legs, zero model tokens (fake WorkerAdapters + the real WorktreeProvider +
// the real runner; module-direct legs for the bound and determinism):
//   M  — module contract: src/planner-digest.ts loads, both caps exported
//        numbers ≥ 1, RECOGNIZED_MANIFESTS a non-empty string array.
//   D1 — byte-determinism: two compositions byte-identical (text + sha256),
//        and unchanged across working-tree mutations and later commits (the
//        digest reads the COMMIT, never the working tree).
//   D2 — content/provenance: header states the baseSha verbatim; the
//        package.json identity line is the exact literal (name+version from
//        the COMMIT's bytes); every tracked path lists forward-slash in git
//        ls-tree order and exists at base; no truncation line when under the
//        caps; NO repo path anywhere in the digest (bytes, never access).
//   D3 — path cap honesty: a repo over MAX_DIGEST_PATHS lists exactly the
//        cap, states listed-of-total in the section header, and the TRUNCATED
//        line names the cut count and the path-cap constant; total chars
//        within MAX_DIGEST_CHARS.
//   D4 — char cap honesty: a repo whose listing overflows MAX_DIGEST_CHARS
//        with paths to spare is re-cut BELOW the path cap until the composed
//        text fits, and the TRUNCATED line names the char-cap constant.
//   D5 — loud failure: composing against a non-git dir throws (the
//        never-break-a-run signal); the runner wraps composition in
//        try/catch with a loud degradation log (source pin).
//   E1 — evidence + verbatim embedding (digest ON): planner-digest.txt under
//        the artifacts dir; report.plannerDigest records its path and the
//        sha256 of the on-disk bytes, equal to the module-recomposed digest;
//        the round-1 planner prompt carries the FILE's bytes verbatim,
//        between the GOAL line and the output contract.
//   E2 — opt-out inertness (the T-056 pattern): with plannerContext false OR
//        absent, the captured planner prompt is byte-identical to main's
//        hard-coded no-block template, no digest file exists, and the report
//        carries today's exact top-level key set (no plannerDigest).
//   E3 — both rounds: digest ON, rounds 2 — the round-1 prompt carries the
//        digest alone; the round-2 prompt carries digest + composed survivor
//        block with the EXACT '\n\n' join (byte-precise); digest-less rounds
//        2 carries the composed block alone, byte-identical to main's
//        round-2 form.
//   C1 — CLI face: --help documents --no-planner-context; the flag parses
//        (a trailing known refusal still fires ITS refusal, never 'unknown
//        option'); the CLI defaults the option true and passes it through
//        (source pin).
//
// The recorded red bar (VERIFICATION.md Gate 1.45): on main the module import
// fails and every module-dependent leg fails; the demo-fixture probe at
// C:\swarm\verify-red\T-059-red.log records the AC#1 red — main's planner
// prompt carries no tree/manifest bytes and no planner-digest.txt exists.
// All subprocesses list-form (AGENTS.md #4); the sandbox under C:\swarm is
// created and removed by this check (AGENTS.md #10).
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSkeleton } from '../src/runner.ts'
import { composeRoundPacket } from '../src/rounds.ts'
import { WorktreeProvider } from '../src/workspace/worktree.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const read = (p) => readFileSync(p, 'utf8')
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-planner-digest'
const IDENTITY = ['-c', 'user.name=check-planner-digest', '-c', 'user.email=digest@local']

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// The digest module (T-059). Dynamic so the pre-change red bar is behavioral
// — on main the import fails, M records it, and every module-dependent leg
// fails as a named assertion instead of crashing the check.
let digestMod = null
let digestErr = ''
try {
  digestMod = await import('../src/planner-digest.ts')
} catch (e) {
  digestErr = e instanceof Error ? e.message : String(e)
}
const compose = digestMod?.composePlannerDigest ?? null
const MAX_PATHS = digestMod?.MAX_DIGEST_PATHS ?? null
const MAX_CHARS = digestMod?.MAX_DIGEST_CHARS ?? null

// A fake Gate (src/types.ts seam, the check-brief-premise pattern).
const fakeGate = {
  name: 'always-pass',
  run: async () => ({ name: 'always-pass', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok', command: 'node build.js' }),
}

// A scripted planner fake (the check-rounds leg-B pattern): round-1 briefs on
// the plain prompt, round-2 briefs once the composed survivor-evidence block
// is present. Captures every request for the prompt assertions.
function plannerScripted(round1, round2) {
  return {
    id: 'fake',
    reqs: [],
    async execute(req) {
      this.reqs.push({ ...req })
      const pick = req.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE') ? round2 : round1
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: JSON.stringify(pick), pid: null }
    },
  }
}

// A scripted worker fake: a worker prompt whose GOAL line carries briefText
// writes the file (repo-relative); the digest rides PLANNER prompts only, so
// worker matching is unaffected by it.
function workerScripted(actions) {
  return {
    id: 'fake',
    reqs: [],
    async execute(req) {
      this.reqs.push({ ...req })
      // includes, not startsWith: since T-060 the worker prompt begins with
      // the engine's orientation block and the builder template rides inside
      // it (Gate 1.46); the discriminator strength is unchanged — planner
      // prompts never carry this line.
      if (req.prompt.includes('You are implementing')) {
        for (const [brief, file, content] of actions) {
          if (req.prompt.includes(`GOAL: ${brief}\n`)) writeFileSync(join(req.cwd, file), content)
        }
      }
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: 'fake worker done', pid: null }
    },
  }
}

// One throwaway scenario repo: package.json + nested tracked files.
function makeScenario(name, { files }) {
  const scenarioDir = join(sandbox, name)
  const repo = join(scenarioDir, 'repo')
  const artifactsDir = join(scenarioDir, 'run')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(repo, dirname(file)), { recursive: true })
    writeFileSync(join(repo, file), content)
  }
  git(...IDENTITY, 'init', '-b', 'main')
  git(...IDENTITY, 'add', '-A')
  git(...IDENTITY, 'commit', '-m', 'baseline')
  const baseSha = git('rev-parse', 'HEAD').trim()
  return { scenarioDir, repo, artifactsDir, baseSha, git }
}

// The plannerPrompt template, hard-coded to MAIN's exact no-block bytes (the
// NOTE_* literal discipline: a drift in src/runner.ts's template must fail
// this check, never ride it). contextBlock optional — the round-2 form.
const mainFormPlannerPrompt = (goal, count, contextBlock) => {
  const lines = [
    'You are the planning tier of a multi-candidate implementation system.',
    `GOAL: ${goal}`,
  ]
  if (contextBlock !== undefined) lines.push('', contextBlock)
  lines.push(
    '',
    `Produce exactly ${count} distinct implementation briefs, one per candidate worker.`,
    'Each brief must be self-contained, concrete, and independently implementable as a small diff.',
    'Where the goal allows more than one approach, vary the approach across briefs.',
    'Do not reference "the other briefs"; each worker sees only its own.',
    '',
    `Output ONLY a JSON array of ${count} strings. No markdown fences, no commentary.`,
  )
  return lines.join('\n')
}

// Drive the real runner over a scenario (the check-brief-premise drive).
async function drive(scenario, { goal, planner, worker, rounds, plannerContext }) {
  const report = await runSkeleton({
    runId: '20990101000001',
    repo: scenario.repo,
    baseSha: scenario.baseSha,
    goal,
    model: 'fake/worker-model',
    plannerModel: 'fake/planner-model',
    reviewerModel: null,
    candidateIds: ['c01', 'c02'],
    concurrency: 2,
    timeoutMs: 10_000,
    maxAttempts: 1,
    gates: [fakeGate],
    worker,
    plannerWorker: planner,
    ...(rounds !== undefined ? { rounds } : {}),
    ...(plannerContext !== undefined ? { plannerContext } : {}),
    workspaces: new WorktreeProvider(scenario.repo, scenario.artifactsDir),
    artifactsDir: scenario.artifactsDir,
    cleanWorkspaces: false,
  })
  return report
}

const main = async () => {
  try {
    // ---------- M — module contract ----------
    t('M: src/planner-digest.ts loads (the digest producer exists)', digestMod !== null)
    if (digestMod === null) {
      t('M: import error recorded (first 100 chars): ' + digestErr.slice(0, 100), false)
    }
    t('M: MAX_DIGEST_PATHS and MAX_DIGEST_CHARS are exported numbers ≥ 1 (documented constants, the MAX_RETRY_FINDINGS pattern)',
      typeof MAX_PATHS === 'number' && MAX_PATHS >= 1 && typeof MAX_CHARS === 'number' && MAX_CHARS >= 1)
    t('M: RECOGNIZED_MANIFESTS is a non-empty array of strings (package.json per the ticket)',
      Array.isArray(digestMod?.RECOGNIZED_MANIFESTS) && digestMod.RECOGNIZED_MANIFESTS.length > 0
      && digestMod.RECOGNIZED_MANIFESTS.every((m) => typeof m === 'string'))

    // ---------- D1/D2 — determinism + content over the base fixture ----------
    if (compose !== null) {
      const scenario = makeScenario('base', {
        files: {
          'package.json': JSON.stringify({ name: 'digest-fixture', version: '2.1.0', private: true }, null, 2) + '\n',
          'calc.js': 'export const calc = (a, b) => a + b\n',
          'build.js': 'console.log("build ok")\n',
          'src/deep/nested/util.js': 'export const id = (x) => x\n',
          'docs/notes.md': '# notes\n',
        },
      })
      const { repo, baseSha, git } = scenario
      const first = compose({ repo, baseSha })
      const second = compose({ repo, baseSha })

      t('D1: two compositions over the same repo+baseSha are byte-identical (text and sha256)',
        first.text === second.text && first.sha256 === second.sha256 && first.sha256 === sha256(first.text))

      // Working-tree mutations and LATER commits must not move the digest at
      // the recorded base (the digest reads the commit, never the tree).
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'MUTATED-WORKING-TREE', version: '9.9.9' }, null, 2) + '\n')
      writeFileSync(join(repo, 'untracked-stray.js'), '// untracked\n')
      git(...IDENTITY, 'add', 'untracked-stray.js')
      git(...IDENTITY, 'commit', '-m', 'later commit (must not move the base digest)')
      const third = compose({ repo, baseSha })
      t('D1: the digest is pinned to baseSha — working-tree mutations and later commits leave it byte-identical',
        third.text === first.text && third.sha256 === first.sha256)

      const lines = first.text.split('\n')
      t('D2: the header states the digest contract and the BASE COMMIT line carries baseSha verbatim',
        lines[0] === '=== TARGET REPO DIGEST (composed deterministically by the engine from git at the base commit — context about the repository, NOT access to it) ==='
        && first.text.includes(`BASE COMMIT: ${baseSha}`))
      t('D2: the manifest identity line is the exact literal — name+version from the COMMIT\'s package.json, presence and identity, never full contents',
        first.text.includes('MANIFEST package.json: name "digest-fixture", version "2.1.0"'))
      t('D2: the tree section lists every tracked path in git ls-tree order, forward-slash',
        first.text.includes('TRACKED FILES AT BASE (5 paths, forward-slash, git ls-tree order):')
        && first.text.includes(['build.js', 'calc.js', 'docs/notes.md', 'package.json', 'src/deep/nested/util.js'].join('\n'))
        && !first.text.includes('\\'))
      t('D2: every listed path exists at the base commit (git cat-file -e against baseSha)',
        ['build.js', 'calc.js', 'docs/notes.md', 'package.json', 'src/deep/nested/util.js'].every((p) =>
          spawnSync('git', ['-C', repo, 'cat-file', '-e', `${baseSha}:${p}`], { encoding: 'utf8', windowsHide: true }).status === 0))
      t('D2: under the caps there is NO truncation line (truncated false, cap null) and the digest names NO repo path (bytes, never access)',
        first.truncated === false && first.cap === null && !first.text.includes('TRUNCATED')
        && !first.text.includes(repo) && !first.text.includes(repo.replaceAll('/', '\\')))
      t('D2: the digest closes with the fixed end marker',
        lines[lines.length - 1] === '=== END TARGET REPO DIGEST ===')

      // ---------- D3 — the path cap ----------
      const overFiles = { 'package.json': '{"name":"cap-fixture","version":"1.0.0"}\n' }
      for (let i = 0; i < MAX_PATHS + 60; i++) overFiles[`f${String(i).padStart(4, '0')}.js`] = '// x\n'
      const over = makeScenario('path-cap', { files: overFiles })
      const d3 = compose({ repo: over.repo, baseSha: over.baseSha })
      t('D3: a repo over MAX_DIGEST_PATHS lists exactly the cap (listedPaths === constant, totalPaths honest)',
        d3.listedPaths === MAX_PATHS && d3.totalPaths === MAX_PATHS + 60 + 1 && d3.truncated === true && d3.cap === 'path')
      t('D3: the section header states listed-of-total and the TRUNCATED line names the cut count and the PATH-cap constant',
        d3.text.includes(`TRACKED FILES AT BASE (listing ${MAX_PATHS} of ${MAX_PATHS + 61} paths, forward-slash, git ls-tree order):`)
        && d3.text.includes(`TRUNCATED: 61 of ${MAX_PATHS + 61} tracked paths not shown — cut by the path cap (${MAX_PATHS}).`))
      t('D3: total chars within MAX_DIGEST_CHARS even at the path cap',
        d3.text.length <= MAX_CHARS)

      // ---------- D4 — the char cap ----------
      const longFiles = { 'package.json': '{"name":"char-fixture","version":"1.0.0"}\n' }
      const longName = 'd'.repeat(84)
      for (let i = 0; i < 400; i++) longFiles[`${longName}-${String(i).padStart(3, '0')}.js`] = '// x\n'
      const overChars = makeScenario('char-cap', { files: longFiles })
      const d4 = compose({ repo: overChars.repo, baseSha: overChars.baseSha })
      t('D4: a listing that overflows MAX_DIGEST_CHARS is re-cut BELOW the path cap until the text fits (binding cap: char)',
        d4.text.length <= MAX_CHARS && d4.cap === 'char' && d4.truncated === true
        && d4.listedPaths < 400 && d4.listedPaths < MAX_PATHS)
      t('D4: the TRUNCATED line names the CHAR-cap constant and the honest not-shown count',
        d4.text.includes(`TRUNCATED: ${401 - d4.listedPaths} of 401 tracked paths not shown — cut by the char cap (${MAX_CHARS}).`))
      t('D4: the char-capped digest is still byte-deterministic (recomposition identical)',
        eq(d4, compose({ repo: overChars.repo, baseSha: overChars.baseSha })))

      // ---------- D5 — loud failure ----------
      const notAGitDir = join(sandbox, 'not-a-repo')
      mkdirSync(notAGitDir, { recursive: true })
      let threw = false
      try {
        compose({ repo: notAGitDir, baseSha: '0'.repeat(40) })
      } catch {
        threw = true
      }
      t('D5: composing against a non-git repo THROWS (the loud signal — never a silent empty tree)',
        threw)
      const runnerSource = read(join(root, 'src', 'runner.ts'))
      t('D5: the runner wraps digest composition in try/catch and logs the degradation loudly (never-break-a-run, the premise-guard posture)',
        runnerSource.includes('planner digest failed (') && runnerSource.includes("today's exact prompts"))
    } else {
      for (const leg of ['D1', 'D2', 'D3', 'D4', 'D5']) t(`${leg}: module-direct legs (digest module missing)`, false)
    }

    // ---------- E1 — evidence + verbatim embedding (digest ON) ----------
    {
      const scenario = makeScenario('drive-on', {
        files: {
          'package.json': '{"name":"drive-fixture","version":"3.0.0"}\n',
          'calc.js': 'export const calc = (a, b) => a + b\n',
          'build.js': 'console.log("build ok")\n',
        },
      })
      const GOAL = 'make the calculator better'
      const B1 = 'extend calc.js with a clamp helper'
      const B2 = 'add tests for calc.js edge cases'
      const planner = plannerScripted([B1, B2], [])
      const worker = workerScripted([[B1, 'made-a.js', '// a\n'], [B2, 'made-b.js', '// b\n']])
      const report = await drive(scenario, { goal: GOAL, planner, worker, plannerContext: true })
      const digestPath = join(scenario.artifactsDir, 'planner-digest.txt')
      t('E1: planner-digest.txt exists under the run artifacts dir and report.plannerDigest records exactly that path',
        existsSync(digestPath) && report.plannerDigest?.path === digestPath)
      const fileBytes = existsSync(digestPath) ? read(digestPath) : ''
      t('E1: report.plannerDigest.sha256 is the sha256 of the ON-DISK bytes and equals the module-recomposed digest (one composition, two consumers)',
        report.plannerDigest?.sha256 === sha256(fileBytes)
        && compose !== null && report.plannerDigest?.sha256 === compose({ repo: scenario.repo, baseSha: scenario.baseSha }).sha256)
      const prompt = planner.reqs.find((r) => !r.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE'))?.prompt ?? ''
      t('E1: the round-1 planner prompt carries the FILE\'s digest bytes VERBATIM, between the GOAL line and the output contract',
        prompt.includes(fileBytes)
        && prompt.indexOf(`GOAL: ${GOAL}`) < prompt.indexOf('=== TARGET REPO DIGEST')
        && prompt.indexOf('=== END TARGET REPO DIGEST ===') < prompt.indexOf('Produce exactly'))
      t('E1: the digest names the real tree the briefs will be specified against (calc.js at root — the R14 premise fix)',
        fileBytes.includes('calc.js') && fileBytes.includes('MANIFEST package.json: name "drive-fixture", version "3.0.0"'))

      // ---------- E2 — opt-out inertness (the T-056 pattern) ----------
      // Fresh scenario: cleanWorkspaces false leaves wt leases + swarm/wt-*
      // branches behind in the previous scenario (the E3 note applies here
      // too — a re-drive over the same repo would collide on branch names).
      const scenarioOff = makeScenario('drive-off', {
        files: {
          'package.json': '{"name":"drive-off-fixture","version":"3.0.0"}\n',
          'calc.js': 'export const calc = (a, b) => a + b\n',
          'build.js': 'console.log("build ok")\n',
        },
      })
      const plannerOff = plannerScripted([B1, B2], [])
      const workerOff = workerScripted([[B1, 'made-a.js', '// a\n'], [B2, 'made-b.js', '// b\n']])
      const reportOff = await drive(scenarioOff, { goal: GOAL, planner: plannerOff, worker: workerOff, plannerContext: false })
      const promptOff = plannerOff.reqs.find((r) => !r.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE'))?.prompt ?? ''
      t('E2: with the digest OFF the planner prompt is BYTE-IDENTICAL to main\'s no-block template (hard-coded literal)',
        promptOff === mainFormPlannerPrompt(GOAL, 2))
      const scenario2 = makeScenario('drive-absent', {
        files: { 'package.json': '{"name":"absent-fixture","version":"1.0.0"}\n', 'a.js': '// a\n' },
      })
      const plannerAbs = plannerScripted(['x', 'y'], [])
      const workerAbs = workerScripted([['x', 'made.js', '// x\n'], ['y', 'made2.js', '// y\n']])
      const reportAbs = await drive(scenario2, { goal: GOAL, planner: plannerAbs, worker: workerAbs })
      const promptAbs = plannerAbs.reqs[0]?.prompt ?? ''
      t('E2: with the option ABSENT (the seam default — direct callers) the prompt is byte-identical to main\'s too',
        promptAbs === mainFormPlannerPrompt(GOAL, 2))
      t('E2: no planner-digest.txt and NO plannerDigest report key on either digest-less drive; today\'s exact top-level key set',
        !existsSync(join(scenarioOff.artifactsDir, 'planner-digest.txt')) && !existsSync(join(scenario2.artifactsDir, 'planner-digest.txt'))
        && reportOff.plannerDigest === undefined && reportAbs.plannerDigest === undefined
        && eq(Object.keys(reportAbs).sort(), ['baseSha', 'candidates', 'finishedAt', 'goal', 'model', 'planner', 'repo', 'runId', 'startedAt']))

      // ---------- E3 — both rounds ----------
      // Fresh scenarios per drive: cleanWorkspaces false leaves wt/c01
      // leases + swarm/wt-* branches behind, and a second drive over the
      // same scenario would collide on the branch names.
      const R1_A = 'write helpers.js with scale(k)'
      const R1_B = 'refactor calc.js to export its functions'
      const R2_A = 'extend helpers.js with a length() helper'
      const R2_B = 'extend calc.js with rounding'
      const scenarioR = makeScenario('drive-rounds', {
        files: {
          'package.json': '{"name":"rounds-fixture","version":"1.1.0"}\n',
          'calc.js': 'export const calc = (a, b) => a + b\n',
          'build.js': 'console.log("build ok")\n',
        },
      })
      const plannerR = plannerScripted([R1_A, R1_B], [R2_A, R2_B])
      const workerR = workerScripted([
        [R1_A, 'helpers.js', 'export const scale = (a, k) => a.map((x) => x * k)\n'],
        [R1_B, 'calc.js', 'export const calc = (a, b) => a + b // v2\n'],
        [R2_A, 'helpers.js', 'export const length = (a) => Math.hypot(...a)\n'],
        [R2_B, 'calc.js', 'export const calc = (a, b) => a + b // v3\n'],
      ])
      const reportR = await drive(scenarioR, { goal: GOAL, planner: plannerR, worker: workerR, rounds: 2, plannerContext: true })
      t('E3: the 2-round digest-ON drive executed both rounds with round-1 survivors (the loop ran)',
        reportR.rounds?.[0]?.executed === true && reportR.rounds?.[1]?.executed === true
        && (reportR.rounds?.[0]?.survivorIds ?? []).length === 2)
      const r1Prompt = plannerR.reqs.find((r) => !r.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE'))?.prompt ?? ''
      const r2Prompt = plannerR.reqs.find((r) => r.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE'))?.prompt ?? ''
      const digestFileR = read(join(scenarioR.artifactsDir, 'planner-digest.txt'))
      const recomposed = composeRoundPacket({ candidates: reportR.candidates.filter((c) => !c.id.endsWith('-r2')), model: 'fake/planner-model', finishedRound: 1 })
      t('E3: the round-1 prompt carries the digest ALONE (no survivor block) — the digest rides the contextBlock seam',
        r1Prompt.includes(digestFileR) && !r1Prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE'))
      t('E3: the round-2 prompt carries digest + composed survivor block with the EXACT \'\\n\\n\' join (byte-precise, digest first)',
        r2Prompt.includes(digestFileR + '\n\n' + recomposed.renderedBlock))

      // Digest-less rounds 2: byte-identical to main's round-2 form.
      const scenarioRD = makeScenario('drive-rounds-absent', {
        files: {
          'package.json': '{"name":"rounds-absent-fixture","version":"1.1.0"}\n',
          'calc.js': 'export const calc = (a, b) => a + b\n',
          'build.js': 'console.log("build ok")\n',
        },
      })
      const plannerRD = plannerScripted([R1_A, R1_B], [R2_A, R2_B])
      const workerRD = workerScripted([
        [R1_A, 'helpers.js', 'export const scale = (a, k) => a.map((x) => x * k)\n'],
        [R1_B, 'calc.js', 'export const calc = (a, b) => a + b // v2\n'],
        [R2_A, 'helpers2.js', 'export const length = (a) => Math.hypot(...a)\n'],
        [R2_B, 'calc2.js', 'export const calc = (a, b) => a + b // v3\n'],
      ])
      const reportRD = await drive(scenarioRD, { goal: GOAL, planner: plannerRD, worker: workerRD, rounds: 2 })
      const r1PromptD = plannerRD.reqs.find((r) => !r.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE'))?.prompt ?? ''
      const r2PromptD = plannerRD.reqs.find((r) => r.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE'))?.prompt ?? ''
      const recomposedD = composeRoundPacket({ candidates: reportRD.candidates.filter((c) => !c.id.endsWith('-r2')), model: 'fake/planner-model', finishedRound: 1 })
      t('E3: digest-less (seam default absent): BOTH rounds\' prompts are byte-identical to main\'s forms — round 1 no block, round 2 the composed block alone',
        r1PromptD === mainFormPlannerPrompt(GOAL, 2)
        && r2PromptD === mainFormPlannerPrompt(GOAL, 2, recomposedD.renderedBlock))
      t('E3: the digest-less rounds drive writes no digest file and no report field (the seam default is today\'s bytes)',
        !existsSync(join(scenarioRD.artifactsDir, 'planner-digest.txt')) && reportRD.plannerDigest === undefined)
    }

    // ---------- C1 — CLI face ----------
    {
      const cliRun = (args) => {
        const r = spawnSync(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
        return { code: r.status === null ? -1 : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
      }
      const help = cliRun(['--help'])
      t('C1: --help documents --no-planner-context', help.code === 0 && help.out.includes('--no-planner-context'))
      const scenario = makeScenario('cli-face', { files: { 'a.js': '// a\n' } })
      // The flag PARSES: a following known refusal fires ITS OWN refusal
      // (never 'unknown option'), zero side effects (parse-order proof).
      const refusal = cliRun(['--repo', scenario.repo, '--goal', 'x', '--no-planner-context', '--rounds', '3'])
      t('C1: --no-planner-context parses (a trailing --rounds 3 refusal fires its own message, not \'unknown option\')',
        refusal.code === 1 && refusal.out.includes('--rounds expects an integer between 1 and 2') && !refusal.out.includes('unknown option'))
      const cliSource = read(join(root, 'src', 'cli.ts'))
      t('C1: the CLI defaults plannerContext TRUE (default ON) and passes it through to runSkeleton (source pin)',
        /plannerContext:\s*true/.test(cliSource) && cliSource.includes('plannerContext: opts.plannerContext')
        && cliSource.includes("case '--no-planner-context': opts.plannerContext = false; break"))
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

main()
  .catch((e) => {
    failures.push(`check crashed: ${e instanceof Error ? e.message : String(e)}`)
    console.error(e)
  })
  .finally(() => {
    if (failures.length > 0) {
      console.error(`\ncheck-planner-digest: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-planner-digest: ALL GREEN')
  })
