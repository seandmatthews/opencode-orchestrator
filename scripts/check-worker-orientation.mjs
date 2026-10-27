// Worker orientation self-check (Gate 1.46, fast tier, T-060) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-worker-orientation.mjs
// Pins T-060 (VERIFICATION.md Known issue #6 — four of the five recorded
// worker-derailment classes are path/repo confusion; the adversarial review
// 2026-10-23's A2 disposition): an engine-composed ORIENTATION BLOCK is
// prepended to EVERY worker dispatch, composed by src/worker-orientation.ts
// from the worktree lease + the run's baseSha + T-059's digest producer (the
// SAME tree-section composer, src/planner-digest.ts composeTreeSection — the
// same bytes, no second composition path). The block carries: (1) the
// candidate's absolute lease path VERBATIM with the one-line scope statement
// (everything outside it is out of scope, the canonical checkout included),
// (2) the baseSha the lease is pinned to, (3) the capped tracked-file tree.
// The T-050 annotation seam's discipline: engine mechanics, never model
// judgment — the planner-authored brief bytes in report.json stay
// BYTE-UNCHANGED (only the engine-composed wrapper grows), the premise guard
// stays untouched and inert for briefs whose paths all exist at base, and
// every candidate in a run gets the same block shape (no differential
// treatment the report cannot explain). Prompt-side only: no verdict
// expression reads the block; Attempt.promptVersion (the T-029 exact-text
// producer) records the composition change — it must MOVE vs main's bare
// builderPrompt hash for the same inputs.
//
// Legs, zero model tokens (fake WorkerAdapters + the real WorktreeProvider +
// the real runner; module-direct legs for determinism and the cap):
//   M  — module contract: src/worker-orientation.ts loads, MAX_ORIENTATION_
//        CHARS exported number ≥ 1 (documented constant, the MAX_RETRY_
//        FINDINGS pattern), workerDispatchPrompt exported from src/runner.ts.
//   O1 — byte-determinism: two compositions over the same lease + digest are
//        byte-identical (text and every reported count).
//   O2 — fidelity + framing literals: the workspace line is the lease path
//        byte-for-byte (indented exactly two spaces, on its own line), the
//        scope line names the out-of-scope rule (canonical checkout included)
//        verbatim, the BASE COMMIT line carries baseSha verbatim, and the
//        fixed start/end markers are the exact literals (hard-coded here — a
//        wording drift in src/worker-orientation.ts must FAIL this check,
//        never ride it).
//   O3 — same-bytes tree: under the caps the block embeds the digest
//        producer's OWN tree-section bytes verbatim (composeTreeSection over
//        the digest's post-cap path list), and the module spawns nothing —
//        bytes from the shared producer, never a second git walk (source
//        pin).
//   O4 — cap honesty: a repo whose tree overflows MAX_ORIENTATION_CHARS is
//        re-cut below the digest's own cut until the block fits; the block
//        states the truncation, names the orientation-cap constant, and the
//        not-shown count is honest against the repo's true total.
//   E1 — the drive face (the AC red bar): default-mode planner drive with
//        plannerContext FALSE (workers orient regardless — the digest's
//        report/evidence faces stay tied to the planner flag, Gate 1.45 E2
//        preserved): the dispatched worker prompt is byte-exactly
//        orientationBlock + '\n\n' + builder template via workerDispatchPrompt;
//        promptVersion equals the dispatched text's sha256 and DIFFERS from
//        main's bare-builderPrompt hash; the planner-authored brief bytes in
//        report.json ride verbatim; dispatched-prompt.txt lands in every
//        attempt's outputArtifacts with the exact dispatched bytes (one
//        composition, two consumers); the premise guard stays inert (no
//        brief-premise.txt, no note bytes — every brief path exists at base);
//        and both candidates' blocks differ ONLY by the lease path (the same
//        block shape for every candidate in the run).
//   E2 — digest ON + --jobs: with plannerContext true the planner digest
//        evidence appears exactly as T-059 pinned it while the worker tree
//        rides the same digest's bytes; a --jobs (scheduled) drive's worker
//        prompt carries the orientation block too — every worker dispatch,
//        both modes, all rounds.
//
// The recorded red bar (AGENTS.md #8, VERIFICATION.md Gate 1.46): on main the
// module import fails (M), every module-dependent leg fails by name, and the
// E1 drive records the ticket's AC — the dispatched worker prompt for a
// stubbed run carries NO orientation block. Verbatim output at
// C:\swarm\verify-red\T-060-red.log.
//
// All subprocesses list-form (AGENTS.md #4); the sandbox under C:\swarm is
// created and removed by this check (AGENTS.md #10).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builderPrompt, runSkeleton } from '../src/runner.ts'
import { composePlannerDigest } from '../src/planner-digest.ts'
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
const sandbox = 'C:/swarm/verify-worker-orientation'
const IDENTITY = ['-c', 'user.name=check-worker-orientation', '-c', 'user.email=orientation@local']

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// The orientation module (T-060). Dynamic so the pre-change red bar is
// behavioral — on main the import fails, M records it, and every
// module-dependent leg fails as a named assertion instead of crashing the
// check (the check-planner-digest pattern).
let orientationMod = null
let orientationErr = ''
try {
  orientationMod = await import('../src/worker-orientation.ts')
} catch (e) {
  orientationErr = e instanceof Error ? e.message : String(e)
}
const compose = orientationMod?.composeWorkerOrientation ?? null
const MAX_CHARS = orientationMod?.MAX_ORIENTATION_CHARS ?? null
const treeSectionOf = (await import('../src/planner-digest.ts')).composeTreeSection
const workerDispatchPrompt = (await import('../src/runner.ts')).workerDispatchPrompt

// The orientation block's fixed framing, pinned VERBATIM (the NOTE_* literal
// discipline — a drift in src/worker-orientation.ts must fail, never ride).
const ORIENTATION_START = '=== WORKSPACE ORIENTATION (composed deterministically by the engine — facts about your workspace, copied from the worktree lease and git at the base commit) ==='
const ORIENTATION_END = '=== END WORKSPACE ORIENTATION ==='
const WORKSPACE_LINE = 'YOUR EXACT WORKSPACE (the one and only directory you may read or change):'
const SCOPE_LINE = 'That exact path, byte-for-byte as printed above, is your workspace. Everything outside it is OUT OF SCOPE for this task — the canonical checkout of the target repository included, and any directory guessed from the task text is wrong unless it is inside the path above. Do not shorten, backslash-flip, or re-type this path from memory; copy it exactly.'
const BASE_COMMIT_LINE = (sha) => `BASE COMMIT your workspace is pinned to: ${sha}`

// A fake Gate (src/types.ts seam, the check-brief-premise pattern).
const fakeGate = {
  name: 'always-pass',
  run: async () => ({ name: 'always-pass', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok', command: 'node build.js' }),
}

// A scripted planner fake (the check-rounds leg-B pattern).
function plannerScripted(round1) {
  return {
    id: 'fake',
    reqs: [],
    async execute(req) {
      this.reqs.push({ ...req })
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: JSON.stringify(round1), pid: null }
    },
  }
}

// A scripted worker fake (the check-brief-premise pattern; the matcher is
// includes-based — since T-060 the worker prompt begins with the orientation
// block, and the builder template's opener rides inside it).
function workerScripted(actions) {
  return {
    id: 'fake',
    reqs: [],
    async execute(req) {
      this.reqs.push({ ...req })
      if (req.prompt.includes('You are implementing')) {
        for (const [brief, writes] of actions) {
          if (req.prompt.includes(`GOAL: ${brief}\n`)) {
            for (const [file, content] of writes) writeFileSync(join(req.cwd, file), content)
          }
        }
      }
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: 'fake worker done', pid: null }
    },
  }
}

// One throwaway scenario repo (the check-brief-premise makeScenario pattern).
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

// Main's bare no-context planner prompt (the check-planner-digest literal
// discipline): the planner side must stay byte-identical when the digest is
// off, orientation or not.
const mainFormPlannerPrompt = (goal, count) => [
  'You are the planning tier of a multi-candidate implementation system.',
  `GOAL: ${goal}`,
  '',
  `Produce exactly ${count} distinct implementation briefs, one per candidate worker.`,
  'Each brief must be self-contained, concrete, and independently implementable as a small diff.',
  'Where the goal allows more than one approach, vary the approach across briefs.',
  'Do not reference "the other briefs"; each worker sees only its own.',
  '',
  `Output ONLY a JSON array of ${count} strings. No markdown fences, no commentary.`,
].join('\n')

// Drive the real runner over a scenario (the check-brief-premise drive).
async function drive(scenario, { goal, planner, worker, plannerContext, scheduled }) {
  const report = await runSkeleton({
    runId: '20990102000001',
    repo: scenario.repo,
    baseSha: scenario.baseSha,
    goal,
    model: 'fake/worker-model',
    plannerModel: scheduled ? null : 'fake/planner-model',
    reviewerModel: null,
    candidateIds: ['c01', 'c02'],
    concurrency: 2,
    timeoutMs: 10_000,
    maxAttempts: 1,
    gates: [fakeGate],
    worker,
    ...(planner !== undefined ? { plannerWorker: planner } : {}),
    ...(plannerContext !== undefined ? { plannerContext } : {}),
    ...(scheduled !== undefined ? { scheduled } : {}),
    workspaces: new WorktreeProvider(scenario.repo, scenario.artifactsDir),
    artifactsDir: scenario.artifactsDir,
    cleanWorkspaces: false,
  })
  return report
}

const main = async () => {
  try {
    // ---------- M — module contract ----------
    t('M: src/worker-orientation.ts loads (the orientation producer exists)', orientationMod !== null)
    if (orientationMod === null) {
      t('M: import error recorded (first 100 chars): ' + orientationErr.slice(0, 100), false)
    }
    t('M: MAX_ORIENTATION_CHARS is an exported number ≥ 1 (documented constant, the MAX_RETRY_FINDINGS pattern)',
      typeof MAX_CHARS === 'number' && MAX_CHARS >= 1)
    t('M: workerDispatchPrompt is exported from src/runner.ts (the one composition path for the full dispatched prompt)',
      typeof workerDispatchPrompt === 'function')

    // ---------- O1/O2/O3 — determinism, fidelity, same-bytes tree ----------
    if (compose !== null && typeof treeSectionOf === 'function') {
      const scenario = makeScenario('module', {
        files: {
          'package.json': '{"name":"orientation-fixture","version":"1.0.0"}\n',
          'calc.js': 'export const calc = (a, b) => a + b\n',
          'build.js': 'console.log("build ok")\n',
          'docs/notes.md': '# notes\n',
        },
      })
      const digest = composePlannerDigest({ repo: scenario.repo, baseSha: scenario.baseSha })
      const leasePath = join(scenario.artifactsDir, 'wt', 'c01')
      const first = compose({ leasePath, baseSha: scenario.baseSha, digest })
      const second = compose({ leasePath, baseSha: scenario.baseSha, digest })

      t('O1: two compositions over the same lease + digest are byte-identical (text and every reported count)',
        eq(first, second))

      const lines = first.text.split('\n')
      t('O2: the block opens with the fixed start marker (hard-coded literal)',
        lines[0] === ORIENTATION_START)
      t('O2: the workspace line names the one-and-only directory rule (hard-coded literal) and the lease path rides byte-for-byte on its own line, indented exactly two spaces',
        first.text.includes(WORKSPACE_LINE) && first.text.includes(`\n  ${leasePath}\n`))
      t('O2: the scope line states the out-of-scope rule with the canonical checkout included, VERBATIM (hard-coded literal)',
        first.text.includes(SCOPE_LINE))
      t('O2: the BASE COMMIT line carries the run\'s baseSha verbatim',
        first.text.includes(BASE_COMMIT_LINE(scenario.baseSha)))
      t('O2: the block closes with the fixed end marker (hard-coded literal)',
        lines[lines.length - 1] === ORIENTATION_END)
      // The two KI#6 path-confusion facts the block exists for: the path
      // appears EXACTLY once on its own line (never mid-sentence, where the
      // 2026-10-24 hyphen-as-separator mis-transcription class lived), and
      // no forward-slashed or case-flipped variant rides anywhere.
      t('O2: the lease path appears exactly once, as the indented workspace line — never embedded in prose',
        first.text.split(leasePath).length === 2)

      t('O3: under the caps the block embeds the digest producer\'s OWN tree-section bytes verbatim (composeTreeSection over the digest\'s post-cap path list — the same bytes, no second composition path)',
        typeof digest.treePaths !== 'undefined' && digest.treePaths.length > 0
        && first.text.includes(treeSectionOf(digest.treePaths, digest.totalPaths, null)))
      t('O3: the orientation module spawns nothing — bytes from the shared producer, never a second git walk (source pin)',
        !read(join(root, 'src', 'worker-orientation.ts')).includes('spawnSync')
        && !read(join(root, 'src', 'worker-orientation.ts')).includes('execFile'))

      // ---------- O4 — cap honesty ----------
      const capFiles = { 'package.json': '{"name":"cap-fixture","version":"1.0.0"}\n' }
      const longName = 'o'.repeat(84)
      for (let i = 0; i < 400; i++) capFiles[`${longName}-${String(i).padStart(3, '0')}.js`] = '// x\n'
      const capScenario = makeScenario('cap', { files: capFiles })
      const capDigest = composePlannerDigest({ repo: capScenario.repo, baseSha: capScenario.baseSha })
      const capped = compose({ leasePath: join(capScenario.artifactsDir, 'wt', 'c01'), baseSha: capScenario.baseSha, digest: capDigest })
      t('O4: a repo whose tree overflows MAX_ORIENTATION_CHARS is re-cut BELOW the digest\'s own cut until the block fits',
        capped.text.length <= MAX_CHARS && capped.treeListed < capDigest.treePaths.length)
      t('O4: the truncation is stated in-block, naming the orientation-cap constant, with an honest not-shown count against the repo\'s true total',
        capped.text.includes(`TRUNCATED: ${capDigest.totalPaths - capped.treeListed} of ${capDigest.totalPaths} tracked paths not shown — cut by the orientation cap (${MAX_CHARS}).`))
      t('O4: the capped block is still byte-deterministic (recomposition identical)',
        eq(capped, compose({ leasePath: join(capScenario.artifactsDir, 'wt', 'c01'), baseSha: capScenario.baseSha, digest: capDigest })))
    } else {
      for (const leg of ['O1', 'O2', 'O3', 'O4']) t(`${leg}: module-direct legs (orientation module missing)`, false)
    }

    // ---------- E1 — the drive face (plannerContext FALSE: workers orient regardless) ----------
    {
      const scenario = makeScenario('drive-off', {
        files: {
          'package.json': '{"name":"drive-off-fixture","version":"3.0.0"}\n',
          'calc.js': 'export const calc = (a, b) => a + b\n',
          'build.js': 'console.log("build ok")\n',
        },
      })
      const GOAL = 'make the calculator better'
      // Both briefs name only files that exist at base — the premise guard
      // must stay inert (T-050 untouched by T-060).
      const B1 = 'extend calc.js with a clamp helper'
      const B2 = 'add comments to build.js'
      const planner = plannerScripted([B1, B2])
      const worker = workerScripted([[B1, [['calc.js', 'export const clamp = (x) => x\n']]], [B2, [['build.js', 'console.log("build ok") // v2\n']]]])
      const report = await drive(scenario, { goal: GOAL, planner, worker, plannerContext: false })
      const c01 = report.candidates.find((c) => c.id === 'c01')
      const c02 = report.candidates.find((c) => c.id === 'c02')
      const wprompt = (id) => worker.reqs.find((r) => r.prompt.includes('You are implementing') && r.cwd.replaceAll('\\', '/').endsWith(`/${id}`))?.prompt ?? null
      const p1 = wprompt('c01')
      const p2 = wprompt('c02')
      const lease1 = join(scenario.artifactsDir, 'wt', 'c01')
      const digest = composePlannerDigest({ repo: scenario.repo, baseSha: scenario.baseSha })
      const orientation1 = compose !== null ? compose({ leasePath: lease1, baseSha: scenario.baseSha, digest }) : null

      t('E1: both candidates dispatched and survived (the drive is healthy)', c01?.passedAllGates === true && c02?.passedAllGates === true)
      t('E1: the dispatched worker prompts were captured', p1 !== null && p2 !== null)

      // The AC red-bar assertion: the prompt carries the orientation block.
      t('E1: the dispatched worker prompt CARRIES the orientation block (start marker, workspace line, base commit, end marker)',
        p1 !== null && p1.includes(ORIENTATION_START) && p1.includes(WORKSPACE_LINE) && p1.includes(BASE_COMMIT_LINE(scenario.baseSha)) && p1.includes(ORIENTATION_END))
      t('E1: the dispatched prompt is byte-exactly orientationBlock + \'\\n\\n\' + the UNCHANGED builder template (workerDispatchPrompt, one composition path)',
        p1 !== null && orientation1 !== null && typeof workerDispatchPrompt === 'function'
        && p1 === workerDispatchPrompt(B1, lease1, orientation1.text)
        && p1 === `${orientation1.text}\n\n${builderPrompt(B1, lease1)}`)
      // Lease-path fidelity against the RUN's own recorded lease (dispatch.jsonl), not the check's assumption.
      const dispatchLine = read(join(scenario.artifactsDir, 'dispatch.jsonl')).split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)).find((l) => l.type === 'dispatch' && l.jobId === 'c01')
      t('E1: the block\'s lease path is byte-equal to the run\'s OWN recorded worktree path (dispatch.jsonl fidelity, not a check-side guess)',
        dispatchLine !== undefined && p1 !== null && p1.includes(`\n  ${dispatchLine.worktreePath}\n`))
      t('E1: the builder template rides byte-unchanged inside the dispatched prompt (GOAL line intact for the worker fakes)',
        p1 !== null && p1.includes(`GOAL: ${B1}\n`))

      // Prompt-version honesty (the T-029 producer records the change).
      t('E1: promptVersion MOVEMENT — the attempt\'s promptVersion equals the sha256 of the dispatched prompt and DIFFERS from main\'s bare builderPrompt hash for the same inputs',
        c01?.attempts[0]?.promptVersion === sha256(p1 ?? '')
        && c01?.attempts[0]?.promptVersion !== sha256(builderPrompt(B1, lease1)))

      // Brief integrity: the planner-authored bytes ride report.json verbatim.
      t('E1: the planner-authored brief bytes in report.json are byte-identical to what the planner said (only the engine-composed wrapper grew)',
        c01?.brief === B1 && c02?.brief === B2 && !JSON.stringify(report.candidates).includes('WORKSPACE ORIENTATION'))
      t('E1: the planner prompt stays byte-identical to main\'s no-context template (planner side untouched; digest OFF)',
        planner.reqs[0]?.prompt === mainFormPlannerPrompt(GOAL, 2))
      t('E1: digest OFF ⇒ no planner-digest.txt and no plannerDigest report key (Gate 1.45 E2\'s face preserved)', 
        !existsSync(join(scenario.artifactsDir, 'planner-digest.txt')) && report.plannerDigest === undefined)

      // Evidence: the full dispatched prompt (orientation + brief) recorded.
      const dispatchedPath = join(scenario.artifactsDir, 'c01', 'dispatched-prompt.txt')
      t('E1: dispatched-prompt.txt exists in the candidate evidence dir, rides the attempt\'s outputArtifacts, and carries the EXACT dispatched bytes (one composition, two consumers)',
        existsSync(dispatchedPath) && read(dispatchedPath) === p1
        && (c01?.attempts[0]?.outputArtifacts ?? []).includes(dispatchedPath))

      // Premise guard inertness (T-050 untouched).
      t('E1: the premise guard stays inert for briefs whose paths all exist at base (no brief-premise.txt, no note bytes)',
        !existsSync(join(scenario.artifactsDir, 'c01', 'brief-premise.txt'))
        && !existsSync(join(scenario.artifactsDir, 'c02', 'brief-premise.txt'))
        && !p1?.includes('ENGINE PREMISE NOTE') && !p2?.includes('ENGINE PREMISE NOTE'))

      // Per-run uniformity: same block shape for every candidate.
      const lease2 = join(scenario.artifactsDir, 'wt', 'c02')
      const orientation2 = compose !== null ? compose({ leasePath: lease2, baseSha: scenario.baseSha, digest }) : null
      t('E1: every candidate in the run gets the SAME block shape — the two candidates\' blocks differ only by the lease path (no differential treatment)',
        orientation1 !== null && orientation2 !== null && p1 !== null && p2 !== null
        && orientation1.text.replaceAll(lease1, lease2) === orientation2.text
        && p2 === `${orientation2.text}\n\n${builderPrompt(B2, lease2)}`)

      // ---------- E2 — digest ON + --jobs ----------
      const scenarioOn = makeScenario('drive-on', {
        files: {
          'package.json': '{"name":"drive-on-fixture","version":"3.0.0"}\n',
          'calc.js': 'export const calc = (a, b) => a + b\n',
          'build.js': 'console.log("build ok")\n',
        },
      })
      const plannerOn = plannerScripted([B1, B2])
      const workerOn = workerScripted([[B1, [['calc.js', 'export const clamp2 = (x) => x\n']]], [B2, [['build.js', 'console.log("build ok") // v3\n']]]])
      const reportOn = await drive(scenarioOn, { goal: GOAL, planner: plannerOn, worker: workerOn, plannerContext: true })
      const digestOnPath = join(scenarioOn.artifactsDir, 'planner-digest.txt')
      t('E2: with plannerContext TRUE the T-059 faces appear exactly as before (planner-digest.txt + report.plannerDigest) while the worker orientation rides the same run digest',
        existsSync(digestOnPath) && reportOn.plannerDigest?.path === digestOnPath && reportOn.plannerDigest?.sha256 === sha256(read(digestOnPath)))
      const wOn = workerOn.reqs.find((r) => r.prompt.includes('You are implementing'))?.prompt ?? ''
      const digestOn = composePlannerDigest({ repo: scenarioOn.repo, baseSha: scenarioOn.baseSha })
      t('E2: the worker block\'s tree section is the digest\'s own bytes (one digest per run, two consumers)',
        wOn !== '' && typeof treeSectionOf === 'function' && typeof digestOn.treePaths !== 'undefined'
        && wOn.includes(treeSectionOf(digestOn.treePaths, digestOn.totalPaths, null)))

      const JOBS_BRIEF = 'extend calc.js with a scale helper'
      const scenarioJ = makeScenario('drive-jobs', {
        files: {
          'package.json': '{"name":"jobs-fixture","version":"1.0.0"}\n',
          'calc.js': 'export const calc = (a, b) => a + b\n',
        },
      })
      const workerJ = workerScripted([[JOBS_BRIEF, [['calc.js', 'export const scale = (a, k) => a * k\n']]]])
      await drive(scenarioJ, {
        goal: 'unused in jobs mode',
        worker: workerJ,
        scheduled: {
          phases: [{ id: 'p1', dependencies: [], completion: 'all' }],
          jobs: [{
            id: 'j1', phaseId: 'p1', dependencies: [], brief: JOBS_BRIEF,
            model: 'fake/worker-model', worker: workerJ, timeoutMs: 10_000, gates: [fakeGate],
          }],
        },
      })
      const pj = workerJ.reqs.find((r) => r.prompt.includes('You are implementing'))?.prompt ?? ''
      t('E2: a --jobs (scheduled) drive\'s worker prompt carries the orientation block too — every worker dispatch, both modes',
        pj !== '' && pj.includes(ORIENTATION_START) && pj.includes(WORKSPACE_LINE) && pj.includes(ORIENTATION_END)
        && existsSync(join(scenarioJ.artifactsDir, 'j1', 'dispatched-prompt.txt')) && read(join(scenarioJ.artifactsDir, 'j1', 'dispatched-prompt.txt')) === pj)
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
      console.error(`\ncheck-worker-orientation: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-worker-orientation: ALL GREEN')
  })
