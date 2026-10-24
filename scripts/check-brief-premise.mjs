// Brief-premise guard self-check (Gate 1.35, fast tier, T-050) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-brief-premise.mjs
// Pins T-050 — the Known issue #6 (2026-10-23, run 20261023204747) successor:
// the rounds composer renders survivor evidence into the round-2 planner
// prompt, and that round-2 planner wrote a brief asserting `vec3.js` exists —
// a file only a round-1 SURVIVOR DIFF creates, absent from the shared base
// round 2 re-leases at. The worker's read failed, it exited 0 with zero
// edits, and the NO-OP ladder eliminated it — the ladder was right; the brief
// lied about the workspace. Two deterministic changes, both pinned here:
//
//   1. the composer framing fix (src/rounds.ts): the rendered block's fixed
//      framing carries explicit premise lines — survivor diffs are CHANGES
//      against the same base, not base state; round 2 re-leases at the SAME
//      baseSha; files created by survivor diffs DO NOT exist in a round-2
//      worktree; every brief must be implementable at the base commit alone;
//   2. the mechanical guard (src/premise.ts + the runner's planner-mode brief
//      path): before PLANNER-AUTHORED briefs become jobs (rounds 1 AND 2;
//      --jobs briefs are operator-owned and NEVER touched), each brief is
//      scanned for path-shaped tokens; a token naming a file ABSENT at
//      baseSha (git cat-file -e against the recorded base — no lease needed)
//      gets a fixed engine note appended — the survivor-created reason when
//      the path is in a round-1 survivor's changed paths (the T-045
//      changedPaths seam), the distinct base-commit-absent note otherwise.
//      The ANNOTATED brief dispatches (hashed into that attempt's
//      promptVersion — one composition, two consumers, the T-029/T-038
//      precedent); the planner's UNANNOTATED brief is preserved verbatim in
//      brief-premise.txt (before/after), and `brief` on the candidate report
//      keeps the planner's text. Annotations never touch any verdict
//      expression — they change what a worker is TOLD, which is a brief, not
//      a gate.
//
// Legs, zero model tokens (fake WorkerAdapters + the real WorktreeProvider +
// the real runner; module-direct legs for the bound and determinism):
//   P1 — the red-bar face: the 2026-10-23 mechanism replayed token-free —
//        vec3.js exists ONLY in a recorded round-1 survivor diff, the round-2
//        brief says "extend vec3.js …"; post-change the dispatched prompt
//        carries the fixed survivor-created note naming vec3.js,
//        brief-premise.txt records before/after, the dispatched attempt's
//        promptVersion equals the annotated prompt's hash and DIFFERS from
//        the unannotated text's, and `brief` keeps the planner's text. On
//        main every guard assertion in this leg fails (the brief dispatches
//        unannotated) — the recorded red bar, VERIFICATION.md Gate 1.35.
//   P2 — absent-at-base: a token absent at base and NOT in survivor evidence
//        gets the DISTINCT base-commit-absent note (and never the
//        survivor-created one).
//   P3 — inertness: a brief whose path tokens all exist at base dispatches a
//        byte-identical prompt, writes NO evidence file, adds NO report field
//        (today's exact candidate key set; no premise bytes in the inert
//        candidate's serialized block).
//   P4 — --jobs briefs never annotated (operator-owned, scheduled mode):
//        byte-identical dispatch, no evidence file.
//   P5 — bounded: a brief with more absent-at-base tokens than the exported
//        constant annotates at most the constant's notes (first-mention
//        order), deterministic across invocations.
//   P6 — verdict inertness, both directions: an annotated candidate that
//        makes a real change passes exactly by its gates; an annotated no-op
//        is eliminated exactly by the diffBytes leg.
//   P7 — round-1 annotation (the repo-blind round-1 planner hallucinating a
//        path gets the absent-at-base note) and the operator-owned carve:
//        planner-fallback raw-goal briefs and --no-planner briefs never
//        annotate.
//   P8 — module contract: src/premise.ts loads, MAX_PREMISE_NOTES exported,
//        note emission deterministic byte-for-byte.
//
// All subprocesses list-form (AGENTS.md #4); the sandbox under C:\swarm is
// created and removed by this check (AGENTS.md #10).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builderPrompt, runSkeleton } from '../src/runner.ts'
import { composeRoundPacket } from '../src/rounds.ts'
import { WorktreeProvider } from '../src/workspace/worktree.ts'

// The framing lines (T-050) — dynamic for the same reason as the premise
// module: on main the export does not exist and the red bar stays behavioral.
let roundsMod = null
try {
  roundsMod = await import('../src/rounds.ts')
} catch {
  roundsMod = null
}
const ROUND_PREMISE_LINES = roundsMod?.ROUND_PREMISE_LINES ?? null

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const read = (p) => readFileSync(p, 'utf8')
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-brief-premise'
const IDENTITY = ['-c', 'user.name=check-brief-premise', '-c', 'user.email=premise@local']

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// The guard module (T-050). Dynamic so the pre-change red bar is behavioral —
// on main the import fails, P8 records it, and every module-dependent leg
// fails as a named assertion instead of crashing the check.
let premise = null
let premiseErr = ''
try {
  premise = await import('../src/premise.ts')
} catch (e) {
  premiseErr = e instanceof Error ? e.message : String(e)
}

// The fixed engine notes, pinned here VERBATIM (hard-coded literals — a
// wording drift in src/premise.ts must fail this check, never ride it).
const NOTE_SURVIVOR_VEC3 = 'ENGINE PREMISE NOTE: "vec3.js" does NOT exist in your worktree; it was created by a round-1 candidate\'s diff — create it yourself if the change needs it'
const NOTE_ABSENT_GHOST = 'ENGINE PREMISE NOTE: "ghost.js" does not exist at the base commit — verify the path'
const NOTE_ABSENT_VEC3 = 'ENGINE PREMISE NOTE: "vec3.js" does not exist at the base commit — verify the path'

// A fake Gate (src/types.ts seam, the check-rounds pattern): always passes,
// records its command (GateResult.command, T-027).
const fakeGate = {
  name: 'always-pass',
  run: async () => ({ name: 'always-pass', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok', command: 'node build.js' }),
}

// A scripted planner fake (the check-rounds leg-B pattern): round-1 briefs on
// the plain prompt, round-2 briefs once the composed survivor-evidence block
// is present. `round1`/`round2` are either the brief arrays or the literal
// string 'garbage' (a never-parsing reply, for the fallback face).
function plannerScripted(round1, round2) {
  return {
    id: 'fake',
    reqs: [],
    async execute(req) {
      this.reqs.push({ ...req })
      const pick = req.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE') ? round2 : round1
      const tail = pick === 'garbage' ? 'this is not a json array of briefs' : JSON.stringify(pick)
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: tail, pid: null }
    },
  }
}

// A scripted worker fake: for each [briefText, writes] pair, a worker prompt
// whose GOAL line carries briefText gets the writes (repo-relative files); a
// prompt matching no pair writes nothing (the no-op). Matching is on the
// `GOAL: <brief>` prefix, which the premise annotation preserves verbatim
// (notes APPEND after the brief, never rewrite it) — so the script behaves
// identically pre- and post-change.
function workerScripted(actions) {
  return {
    id: 'fake',
    reqs: [],
    async execute(req) {
      this.reqs.push({ ...req })
      if (req.prompt.startsWith('You are implementing')) {
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

// The dispatched WORKER prompt for one candidate id (the fake captured every
// execute call; the worker prompts are the builder-prompt ones, keyed by the
// lease path's final segment — `wt/<id>` → `<id>`).
const dispatchedPrompt = (fake, id) =>
  fake.reqs.find((r) => r.prompt.startsWith('You are implementing') && r.cwd.replaceAll('\\', '/').endsWith(`/${id}`))?.prompt ?? null

// One throwaway scenario repo (the check-rounds drive pattern): calc.js and
// notes.md at base — NO vec3.js, NO ghost.js (the premise lies are lies).
function makeScenario(name, { files = { 'calc.js': 'export const calc = (a, b) => a + b\n', 'notes.md': '# notes\n' } } = {}) {
  const scenarioDir = join(sandbox, name)
  const repo = join(scenarioDir, 'repo')
  const artifactsDir = join(scenarioDir, 'run')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
  for (const [file, content] of Object.entries(files)) writeFileSync(join(repo, file), content)
  git(...IDENTITY, 'init', '-b', 'main')
  git(...IDENTITY, 'add', '-A')
  git(...IDENTITY, 'commit', '-m', 'baseline')
  const baseSha = git('rev-parse', 'HEAD').trim()
  return { scenarioDir, repo, artifactsDir, baseSha, git }
}

async function drive(name, { files, goal, plannerModel = 'fake/planner-model', planner, worker, rounds, scheduled }) {
  const scenario = makeScenario(name, { files })
  const report = await runSkeleton({
    runId: name,
    repo: scenario.repo,
    baseSha: scenario.baseSha,
    goal,
    model: 'fake/worker-model',
    plannerModel,
    reviewerModel: null,
    candidateIds: ['c01', 'c02'],
    concurrency: 2,
    timeoutMs: 10_000,
    maxAttempts: 1,
    gates: [fakeGate],
    worker,
    ...(planner !== undefined ? { plannerWorker: planner } : {}),
    ...(rounds !== undefined ? { rounds } : {}),
    ...(scheduled !== undefined ? { scheduled } : {}),
    workspaces: new WorktreeProvider(scenario.repo, scenario.artifactsDir),
    artifactsDir: scenario.artifactsDir,
    cleanWorkspaces: false,
  })
  return { ...scenario, report }
}

// The pre-T-050 candidate-report key set (review disabled in every drive —
// the check-gate-overlap PRE_T045_KEYS pin).
const TODAY_KEYS = ['attempts', 'brief', 'diffBytes', 'diffPath', 'gates', 'id', 'model',
  'passedAllGates', 'workerDurationMs', 'workerId', 'workerOk', 'workerTimedOut', 'workspacePath']

const main = async () => {
  try {
    // ---------- P1/P2/P6/P7(a)/P3-in-drive: the 2-round mechanism replay ----------
    // Round-1 brief A CREATES vec3.js (the survivor diff); brief B edits
    // calc.js (exists at base — the inert face). Round-2 brief A asserts the
    // Known issue #6 premise ("extend vec3.js …" — vec3.js is NOT at base);
    // brief B asserts a pure hallucination ("extend ghost.js …") and the
    // worker no-ops on it (the verdict-inertness fail direction).
    const R1_A = 'write vec3.js with add(v) and scale(k) helpers'
    const R1_B = 'refactor calc.js to export its functions'
    const R2_A = 'extend vec3.js with a length() method returning the magnitude'
    const R2_B = 'extend ghost.js with helper functions'
    const planner = plannerScripted([R1_A, R1_B], [R2_A, R2_B])
    const worker = workerScripted([
      [R1_A, [['vec3.js', 'export const add = (a, b) => a.map((x, i) => x + b[i])\n']]],
      [R1_B, [['calc.js', 'export const calc = (a, b) => a + b // refactored\n']]],
      [R2_A, [['vec3.js', 'export const length = (a) => Math.hypot(...a)\n']]],
      // R2_B deliberately has no action: the annotated no-op.
    ])
    const d = await drive('two-rounds', {
      goal: 'make the calculator better',
      planner,
      worker,
      rounds: 2,
    })
    const { report, repo, artifactsDir, baseSha } = d
    const byId = Object.fromEntries(report.candidates.map((c) => [c.id, c]))
    const wp = new WorktreeProvider(repo, artifactsDir)
    const changedPathsOf = (id) => wp.changedPaths({ id: `wt/${id}`, path: join(artifactsDir, 'wt', id), branch: `swarm/wt-${id}`, baseSha })

    // The runner's own survivor-evidence input, re-derived independently
    // through the same T-045 seam the guard consumes.
    const survivorPaths = [...changedPathsOf('c01'), ...changedPathsOf('c02')]
    t('P1: the drive set up the mechanism — c01\'s survivor diff CREATES vec3.js, c02\'s edits calc.js (the T-045 changedPaths seam)',
      eq(survivorPaths.slice().sort(), ['calc.js', 'vec3.js']))
    t('P1: both round-1 candidates survived and round 2 executed (two round-2 candidates dispatched)',
      byId.c01?.passedAllGates === true && byId.c02?.passedAllGates === true
      && report.rounds?.[1]?.executed === true && byId['c01-r2'] !== undefined && byId['c02-r2'] !== undefined)

    // P1 — the survivor-created note, before/after evidence, promptVersion split.
    const p1Prompt = dispatchedPrompt(worker, 'c01-r2')
    t('P1: the round-2 dispatched prompt was captured (the worker fake saw the c01-r2 lease)', p1Prompt !== null)
    t('P1: the dispatched prompt carries the fixed survivor-created note naming vec3.js',
      p1Prompt !== null && p1Prompt.includes(NOTE_SURVIVOR_VEC3))
    t('P1: the note is appended AFTER the verbatim brief — the original GOAL line is intact inside the dispatched prompt',
      p1Prompt !== null && p1Prompt.includes(`GOAL: ${R2_A}\n`))
    const premisePath = join(artifactsDir, 'c01-r2', 'brief-premise.txt')
    t('P1: brief-premise.txt exists in the candidate evidence dir and rides the dispatched attempt\'s outputArtifacts',
      existsSync(premisePath) && (byId['c01-r2']?.attempts[0]?.outputArtifacts ?? []).includes(premisePath))
    const ev = existsSync(premisePath) ? read(premisePath) : ''
    t('P1: brief-premise.txt records before/after — the AUTHORED section carries the planner\'s brief verbatim, the DISPATCHED section the annotated brief',
      ev.includes('BRIEF AS AUTHORED') && ev.includes(R2_A) && ev.includes('BRIEF AS DISPATCHED')
      && ev.indexOf('BRIEF AS AUTHORED') < ev.indexOf(R2_A) && ev.indexOf('BRIEF AS DISPATCHED') > ev.indexOf(R2_A))
    const c01r2 = byId['c01-r2']
    const unannotatedHash = sha256(builderPrompt(R2_A, join(artifactsDir, 'wt', 'c01-r2')))
    t('P1: promptVersion split (one composition, two consumers) — the dispatched attempt\'s promptVersion EQUALS the sha256 of the dispatched prompt and DIFFERS from the unannotated text\'s hash',
      c01r2?.attempts[0]?.promptVersion === sha256(p1Prompt ?? '')
      && c01r2?.attempts[0]?.promptVersion !== unannotatedHash
      && p1Prompt !== builderPrompt(R2_A, join(artifactsDir, 'wt', 'c01-r2')))
    t('P1: `brief` on the candidate report keeps the PLANNER\'S text (composed text is attempt-scoped evidence, never a replacement — the retry-brief precedent)',
      c01r2?.brief === R2_A && !c01r2?.brief.includes('ENGINE PREMISE NOTE'))
    if (premise !== null) {
      const recomputed = premise.annotateBriefPremise({ brief: R2_A, repo, baseSha, survivorChangedPaths: survivorPaths })
      t('P1: the guard is deterministic — re-annotating the same brief from the same seam-re-derived inputs reproduces the dispatched prompt byte-for-byte',
        recomputed !== null && p1Prompt === builderPrompt(recomputed.annotated, join(artifactsDir, 'wt', 'c01-r2')))
      t('P1: the recomputed note kind is survivor-created (vec3.js is in survivor changed paths)',
        recomputed !== null && eq(recomputed.notes, [{ path: 'vec3.js', kind: 'survivor-created' }]))
      t('P1: the recomputed evidence text is byte-identical to the on-disk brief-premise.txt',
        recomputed !== null && recomputed.evidenceText === ev)
    } else {
      t('P1: the guard module loaded (recomposition leg)', false)
    }

    // P2 — the distinct absent-at-base note.
    const p2Prompt = dispatchedPrompt(worker, 'c02-r2')
    t('P2: a token absent at base and NOT in survivor evidence gets the DISTINCT base-commit-absent note',
      p2Prompt !== null && p2Prompt.includes(NOTE_ABSENT_GHOST))
    t('P2: the absent-at-base candidate NEVER gets the survivor-created reason (ghost.js is in no survivor diff)',
      p2Prompt !== null && !p2Prompt.includes('created by a round-1 candidate\'s diff'))
    t('P2: annotation is per-brief — c02-r2\'s prompt does not carry c01-r2\'s vec3.js note',
      p2Prompt !== null && !p2Prompt.includes('"vec3.js"'))

    // P3 (in-drive face) — the inert brief: calc.js exists at base.
    const p3Prompt = dispatchedPrompt(worker, 'c02')
    t('P3: a brief whose path tokens all exist at base dispatches a BYTE-IDENTICAL prompt (no annotation, no appended bytes)',
      p3Prompt === builderPrompt(R1_B, join(artifactsDir, 'wt', 'c02')))
    t('P3: the inert candidate has NO brief-premise.txt and today\'s exact candidate key set (no report field)',
      !existsSync(join(artifactsDir, 'c02', 'brief-premise.txt'))
      && eq(Object.keys(byId.c02 ?? {}).sort(), TODAY_KEYS))
    t('P3: the inert candidate\'s serialized report block carries no note bytes anywhere (the note text is the marker — the sandbox path itself contains "premise")',
      !JSON.stringify(byId.c02 ?? {}).includes('ENGINE PREMISE'))

    // P6 — verdict inertness, both directions, on ANNOTATED candidates.
    t('P6 (pass direction): an annotated candidate that makes a real change passes exactly by its gates — passedAllGates true, gates all PASS, diff non-empty',
      c01r2?.passedAllGates === true && c01r2?.gates.every((g) => g.passed) === true && c01r2?.diffBytes > 0)
    const c02r2 = byId['c02-r2']
    t('P6 (fail direction): an annotated no-op is eliminated exactly by the diffBytes leg — worker ok, vacuous gate PASS, diffBytes 0, passedAllGates false (AGENTS.md #7)',
      c02r2?.workerOk === true && c02r2?.gates[0]?.passed === true && c02r2?.diffBytes === 0 && c02r2?.passedAllGates === false)
    t('P6: the annotated no-op still gets its before/after evidence file (evidence about failures is evidence)',
      existsSync(join(artifactsDir, 'c02-r2', 'brief-premise.txt')))

    // P7(a) — round-1 annotation: the repo-blind round-1 planner hallucinating
    // a path (vec3.js before anyone created it) gets the absent-at-base note.
    const p7Prompt = dispatchedPrompt(worker, 'c01')
    t('P7: a ROUND-1 brief asserting an absent-at-base path gets the absent-at-base note (the round-1 planner is repo-blind too)',
      p7Prompt !== null && p7Prompt.includes(NOTE_ABSENT_VEC3))
    t('P7: the round-1 note is the base-commit reason, never the survivor reason (no survivor evidence exists in round 1)',
      p7Prompt !== null && !p7Prompt.includes('created by a round-1 candidate\'s diff'))
    t('P7: the round-1 annotated candidate also keeps the planner\'s brief on the report',
      byId.c01?.brief === R1_A)

    // ---------- P3 dedicated: a pure-inert single-round drive ----------
    // Every path token (calc.js, notes.md) exists at base: byte-identical
    // dispatch, no evidence file, no report field — the producer-only pattern.
    {
      const INERT = 'refactor calc.js and extend notes.md with usage examples'
      const plannerI = plannerScripted([INERT, INERT], [])
      const workerI = workerScripted([[INERT, [['calc.js', 'export const calc = (a, b) => a + b // v2\n']]]])
      const di = await drive('inert', { goal: 'refactor the calculator', planner: plannerI, worker: workerI })
      const ci = di.report.candidates[0]
      const pi = dispatchedPrompt(workerI, 'c01')
      t('P3 (dedicated): an all-tokens-at-base brief dispatches byte-identical prompts for every candidate (no note section anywhere)',
        di.report.candidates.every((c) => dispatchedPrompt(workerI, c.id) === builderPrompt(c.brief, join(di.artifactsDir, 'wt', c.id)))
        && pi === builderPrompt(INERT, join(di.artifactsDir, 'wt', 'c01')))
      t('P3 (dedicated): no brief-premise.txt for any candidate, no note bytes in any candidate block, today\'s key sets',
        !di.report.candidates.some((c) => existsSync(join(di.artifactsDir, c.id, 'brief-premise.txt')))
        && di.report.candidates.every((c) => eq(Object.keys(c).sort(), TODAY_KEYS))
        && !di.report.candidates.some((c) => JSON.stringify(c).includes('ENGINE PREMISE')))
      t('P3 (dedicated): the inert drive still passes exactly by its gates (verdicts untouched by the guard\'s absence)',
        ci?.passedAllGates === true && ci?.diffBytes > 0)
    }

    // ---------- P4: --jobs briefs are operator-owned — never annotated ----------
    {
      const JOBS_BRIEF = 'extend missing-file.js with helper functions'
      const workerJ = workerScripted([[JOBS_BRIEF, [['made.txt', 'jobs-mode change\n']]]])
      const dj = await drive('jobs-mode', {
        goal: 'unused in jobs mode',
        plannerModel: null,
        worker: workerJ,
        scheduled: {
          phases: [{ id: 'p1', dependencies: [], completion: 'all' }],
          jobs: [{
            id: 'j1', phaseId: 'p1', dependencies: [], brief: JOBS_BRIEF,
            model: 'fake/worker-model', worker: workerJ, timeoutMs: 10_000, gates: [fakeGate],
          }],
        },
      })
      const cj = dj.report.candidates.find((c) => c.id === 'j1')
      const pj = dispatchedPrompt(workerJ, 'j1')
      t('P4: a --jobs brief naming an absent-at-base file dispatches BYTE-IDENTICAL to today (operator-owned briefs are never annotated)',
        pj === builderPrompt(JOBS_BRIEF, join(dj.artifactsDir, 'wt', 'j1')) && !pj.includes('ENGINE PREMISE NOTE'))
      t('P4: no brief-premise.txt for the jobs candidate and no note bytes in its report block',
        !existsSync(join(dj.artifactsDir, 'j1', 'brief-premise.txt'))
        && !JSON.stringify(cj ?? {}).includes('ENGINE PREMISE'))
      t('P4: the jobs candidate still passes exactly by its gates',
        cj?.passedAllGates === true && cj?.diffBytes > 0)
    }

    // ---------- P7(b/c): the operator-owned carve — fallback and --no-planner ----------
    {
      const GOAL = 'improve nowhere-file.js performance'
      const workerF = workerScripted([[GOAL, [['made.txt', 'fallback change\n']]]])
      const df = await drive('fallback', {
        goal: GOAL,
        planner: plannerScripted('garbage', []),
        worker: workerF,
      })
      t('P7 (fallback): when the planner fails to parse, the raw-goal briefs (operator text) dispatch unannotated even though nowhere-file.js is absent at base',
        df.report.planner?.ok === false && df.report.planner?.fallbackUsed === true
        && dispatchedPrompt(workerF, 'c01') === builderPrompt(GOAL, join(df.artifactsDir, 'wt', 'c01'))
        && !dispatchedPrompt(workerF, 'c01').includes('ENGINE PREMISE NOTE'))
      const workerN = workerScripted([[GOAL, [['made.txt', 'no-planner change\n']]]])
      const dn = await drive('no-planner', { goal: GOAL, plannerModel: null, worker: workerN })
      t('P7 (--no-planner): raw-goal briefs under --no-planner dispatch unannotated (operator-owned, same carve)',
        dn.report.planner === undefined
        && dispatchedPrompt(workerN, 'c01') === builderPrompt(GOAL, join(dn.artifactsDir, 'wt', 'c01'))
        && !dispatchedPrompt(workerN, 'c01').includes('ENGINE PREMISE NOTE'))
    }

    // ---------- P5/P8: module-direct — the bound, the constant, determinism ----------
    if (premise !== null) {
      const { repo, baseSha } = d
      const BOUND_BRIEF = 'improve a1.js a2.js a3.js a4.js a5.js a6.js a7.js a8.js'
      const bounded = premise.annotateBriefPremise({ brief: BOUND_BRIEF, repo, baseSha, survivorChangedPaths: [] })
      t('P5: MAX_PREMISE_NOTES is an exported number ≥ 1 (documented constant, the MAX_RETRY_FINDINGS pattern)',
        typeof premise.MAX_PREMISE_NOTES === 'number' && premise.MAX_PREMISE_NOTES >= 1)
      t('P5: a brief with MORE absent-at-base tokens than the constant annotates AT MOST the constant\'s notes',
        bounded !== null && bounded.notes.length <= premise.MAX_PREMISE_NOTES)
      t('P5: the bound keeps FIRST-MENTION order (a1.js … aN.js, never a suffix sample) and every note is the absent-at-base kind',
        bounded !== null && eq(bounded.notes.map((n) => n.path), BOUND_BRIEF.split(' ').filter((w) => w.endsWith('.js')).slice(0, premise.MAX_PREMISE_NOTES))
        && bounded.notes.every((n) => n.kind === 'absent-at-base'))
      const again = premise.annotateBriefPremise({ brief: BOUND_BRIEF, repo, baseSha, survivorChangedPaths: [] })
      t('P8: determinism — the same inputs annotate byte-identically (annotated, evidenceText, notes) across invocations',
        again !== null && bounded !== null && again.annotated === bounded.annotated
        && again.evidenceText === bounded.evidenceText && eq(again.notes, bounded.notes))
      t('P8: a token that EXISTS at base never annotates (calc.js) — the membership probe is against the recorded baseSha',
        premise.annotateBriefPremise({ brief: 'refactor calc.js', repo, baseSha, survivorChangedPaths: [] }) === null)
      t('P8: the membership test is case-insensitive on survivor paths (the T-045 normForMatch posture) — VEC3.JS matches vec3.js survivor evidence',
        premise.annotateBriefPremise({ brief: 'extend VEC3.JS with more', repo, baseSha, survivorChangedPaths: survivorPaths })?.notes[0]?.kind === 'survivor-created')
    } else {
      t('P8: src/premise.ts loads (the guard module exists — import error: ' + premiseErr.slice(0, 80) + ')', false)
      t('P5: MAX_PREMISE_NOTES exported (module-direct leg)', false)
    }

    // ---------- The composer framing fix, pinned from the same drive ----------
    // The rendered block carries the fixed premise lines verbatim (they are
    // also pinned inside check-rounds Gate 1.22 leg A — belt and braces, the
    // ticket asks both checks to carry the framing pins), and the round-1
    // planner prompt (no block) carries NONE of them.
    const recomposition = composeRoundPacket({ candidates: report.candidates.filter((c) => !c.id.endsWith('-r2')), model: 'fake/planner-model', finishedRound: 1 })
    t('F: the framing lines are exported from src/rounds.ts (ROUND_PREMISE_LINES, the pinning surface)',
      Array.isArray(ROUND_PREMISE_LINES) && ROUND_PREMISE_LINES.length >= 4)
    t('F: the composed rendered block carries EVERY fixed premise line verbatim (changes-not-state, same-base re-lease, survivor files absent, base-implementable briefs)',
      ROUND_PREMISE_LINES !== null && ROUND_PREMISE_LINES.every((line) => recomposition.renderedBlock.includes(line)))
    t('F: the premise lines sit inside the block\'s framing — after the header, before the first survivor body',
      ROUND_PREMISE_LINES !== null
      && recomposition.renderedBlock.indexOf(ROUND_PREMISE_LINES[0]) > recomposition.renderedBlock.indexOf('=== ROUND 1 SURVIVOR EVIDENCE')
      && recomposition.renderedBlock.lastIndexOf(ROUND_PREMISE_LINES[ROUND_PREMISE_LINES.length - 1]) < recomposition.renderedBlock.indexOf('candidate c01 (round 1 survivor)'))
    const r2plannerPrompt = planner.reqs.find((r) => r.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE'))?.prompt ?? ''
    const r1plannerPrompt = planner.reqs.find((r) => !r.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE'))?.prompt ?? ''
    t('F: the round-2 planner prompt embeds the composed block WITH the premise lines (recomposition verbatim)',
      r2plannerPrompt.includes(recomposition.renderedBlock) && (ROUND_PREMISE_LINES ?? []).every((line) => r2plannerPrompt.includes(line)))
    t('F: the round-1 planner prompt (no block) carries NONE of the premise lines — round-1 prompts byte-identical to today',
      r1plannerPrompt !== '' && !(ROUND_PREMISE_LINES ?? []).some((line) => r1plannerPrompt.includes(line)))
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
      console.error(`\ncheck-brief-premise: ${failures.length} failure(s)`)
      process.exit(1)
    }
    console.log('\ncheck-brief-premise: ALL GREEN')
  })
