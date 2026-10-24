// Bounded R&D loop self-check (Gate 1.22, fast tier, T-030) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-rounds.mjs
// The change-set's load-bearing pin: no existing gate exercises two rounds,
// so the fast-tier loop check is not optional. Four legs, all token-free:
//
//   A — composer fixtures (the Gate 0.5/1.13 hand-built-input pattern): the
//       round composer (src/rounds.ts) driven directly over hand-built
//       round-1 report inputs — determinism (byte-identical records→plan→
//       packet→rendered block across invocations and under input-array
//       permutation, stable key order, no wall clock), survivor-only
//       records carrying brief/diffBytes/per-gate results with the recorded
//       GateResult.command/advisory review observations/probe summaries,
//       the distillation block declaring EVERY record (the armed T-014
//       contract), no DistillationReport (source pin: the composer never
//       imports parseDistillationReport — the T-013 reserved enforcement
//       point stays successor-owned), and the fingerprint-reconciliation
//       duty (the src/context.ts:101-104 reservation) pinned at source and
//       behavior level.
//   B — fake-adapter capture (the Gate 1.21 S1 pattern): runSkeleton driven
//       end-to-end with fake WorkerAdapters + fake gates against a throwaway
//       fixture repo, rounds: 2 — the composed block lands in the round-2
//       planner prompt VERBATIM (never in round 1's), round-2 candidates get
//       `<survivorId>-r2` ids/branches at the SAME baseSha through fresh
//       worktrees, a round-2 zero-byte diff is a NO-OP elimination
//       regardless of what the planner saw (AGENTS.md #7 — the vacuous gate
//       passes and the diffBytes leg still eliminates), the additive rounds
//       block has exactly the ticketed fields, the run header is written
//       once while round 2 appends more dispatch lines, and an n=1 drive
//       carries NO rounds key and today's exact key sets.
//   C — token-free REAL-CLI 2-round loop (the Gate 1.17 S5 / Gate 1.21 S3
//       machine-worker pattern): a real `npm run skeleton`-shaped CLI
//       invocation with `--rounds 2 --planner-worker machine
//       --planner-command <json> --reviewer-worker machine
//       --reviewer-command <json>` whose round-2 planner.log (the machine
//       adapter logs req.prompt verbatim as a provenance header) is asserted
//       to carry round-1 survivor ids, gate results, and review observations
//       — plus the round-2 dispatch/branch shapes, same-baseSha worktrees,
//       the NO-OP elimination, an n=1 real-CLI run with NO rounds block, and
//       the AC's n=2 disposal face (clean exits 0, every round's worktrees
//       and swarm/* branches disposed, evidence kept).
//       The opencode worker tier is exercised token-free through the
//       existing --opencode-bin override pointed at node with the stub
//       committed AS the repo-root file `run` — the adapter spawns
//       `<bin> run -m <model>` in the leased worktree (the prompt rides
//       stdin since T-042, never argv), and node resolves the entry `run`
//       against its cwd, so the fixture repo's own committed stub executes
//       in every candidate worktree. No adapter file is touched; the
//       engine stays harness-agnostic.
//   D — CLI refusals, exit 1 with zero side effects (no artifacts dir, no
//       locks/ — each through the real CLI with a non-git --repo so the
//       refusal provably precedes repo validation): --rounds 0 / 3 / 1.5 /
//       junk; --rounds 2 + --jobs; --rounds 2 + --no-planner; --help
//       documents --rounds.
//
// All subprocesses are list-form (AGENTS.md #4); the sandbox under C:\swarm
// is created and removed by this check (AGENTS.md #10).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeRoundPacket, ROUND_PREMISE_LINES } from '../src/rounds.ts'
import { runSkeleton } from '../src/runner.ts'
import { SPEC_ID_PATTERN } from '../src/scheduler.ts'
import { WorktreeProvider } from '../src/workspace/worktree.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const read = (p) => readFileSync(p, 'utf8')
const sortedKeys = (o) => Object.keys(o).sort()
const is64hex = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-rounds'
const NODE = process.execPath
const PLANNER_MODEL = 'zai-coding-plan/glm-5.3'

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// A fake Gate (src/types.ts seam) whose recorded GateResult carries its
// command — the composer must carry the recorded command into the packet as
// evidence (never a verdict).
const fakeGate = {
  name: 'always-pass',
  run: async () => ({ name: 'always-pass', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok', command: 'node fake-gate.js' }),
}

// ---------- Leg A — composer fixtures (hand-built inputs, zero tokens) ----------
{
  const survivor = {
    id: 'c01', workerId: 'opencode', model: 'fake/worker-model',
    brief: 'write the marker file with the round-1 brief text',
    workspacePath: null, workerOk: true, workerTimedOut: false, workerDurationMs: 1000,
    diffPath: null, diffBytes: 4321,
    gates: [
      { name: 'build', passed: true, exitCode: 0, durationMs: 10, outputTail: 'ok', command: 'node build.js' },
      { name: 'test', passed: true, exitCode: 0, durationMs: 20, outputTail: 'ok' },
    ],
    passedAllGates: true,
    attempts: [{
      id: 'c01-a1', jobId: 'c01', number: 1, state: 'succeeded',
      startedAt: '2026-10-20T00:00:01.000Z', endedAt: '2026-10-20T00:00:02.001Z',
      inputContextHash: 'a'.repeat(64), promptVersion: 'b'.repeat(64),
      outputArtifacts: [],
    }],
    review: {
      ok: true, attempts: 1, model: 'fake/reviewer-model',
      observations: [{ finding: 'the marker write is minimal and correct', severity: 'info', evidence: 'the captured diff' }],
      rawOutputPath: '',
    },
    probes: [{ probeId: 'probe-a', scenarioId: 'scenario-a', success: true, durationMs: 5, bundlePath: 'C:\\swarm\\fixture\\probes\\c01\\probe-a.json' }],
  }
  const eliminated = {
    id: 'c02', workerId: 'opencode', model: 'fake/worker-model',
    brief: 'an eliminated candidate — never becomes evidence',
    workspacePath: null, workerOk: true, workerTimedOut: false, workerDurationMs: 500,
    diffPath: null, diffBytes: 0,
    gates: [{ name: 'vacuous', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok' }],
    passedAllGates: false,
    attempts: [],
  }
  const candidates = [survivor, eliminated]

  const r1 = composeRoundPacket({ candidates, model: PLANNER_MODEL, finishedRound: 1 })
  const r2 = composeRoundPacket({ candidates, model: PLANNER_MODEL, finishedRound: 1 })
  const reversed = composeRoundPacket({ candidates: [eliminated, survivor], model: PLANNER_MODEL, finishedRound: 1 })

  t('A: determinism — two compositions from identical inputs give byte-identical rendered blocks and packets (stable key order, no wall clock)',
    r1.renderedBlock === r2.renderedBlock && JSON.stringify(r1.packet) === JSON.stringify(r2.packet))
  t('A: input-array order never matters — the permuted candidates array composes to the identical packet and block (id-ascending canon)',
    JSON.stringify(r1.packet) === JSON.stringify(reversed.packet) && r1.renderedBlock === reversed.renderedBlock)
  t('A: exactly one record per gate survivor — the eliminated candidate never becomes evidence',
    r1.records.length === 1 && r1.records[0]?.id === 'ev-c01' && !r1.renderedBlock.includes('never becomes evidence'))
  t('A: the record carries candidate id, type, producer role, and round tag',
    r1.records[0]?.candidate === 'c01' && r1.records[0]?.type === 'survivor-evidence'
    && r1.records[0]?.producerRole === 'composer' && eq(r1.records[0]?.tags, ['round-1-survivor']))
  t('A: the record content carries the brief, diffBytes, per-gate results with the recorded GateResult.command, review observations, and probe summaries',
    r1.records[0]?.content.includes('write the marker file with the round-1 brief text')
    && r1.records[0]?.content.includes('diffBytes: 4321')
    && r1.records[0]?.content.includes('- build: PASS (exit 0, command: node build.js)')
    && r1.records[0]?.content.includes('- test: PASS (exit 0)')
    && r1.records[0]?.content.includes('[info] the marker write is minimal and correct')
    && r1.records[0]?.content.includes('probe-a/scenario-a: success'))
  t('A: the plan is mandatory-typed, artifact-ref, and its distillation block declares EVERY record the builder sees (the armed T-014 contract)',
    eq(r1.plan.mandatory, [{ type: 'survivor-evidence' }])
    && r1.plan.sourceReferencePolicy === 'artifact-ref'
    && eq(r1.plan.distillation?.expectedArtifactIds, r1.records.map((r) => r.id).sort()))
  t('A: no record carries sourceRefs — primary evidence, no distilled claims, no DistillationReport (parseDistillationReport stays the reserved enforcement point)',
    r1.records.every((r) => r.sourceRefs === undefined))
  t('A: source pin — the composer never imports parseDistillationReport (the docblock may name it; the import list may not)',
    !/import\s*\{[^}]*parseDistillationReport/.test(read(join(root, 'src', 'rounds.ts'))))
  t('A: every record rides Layer 1 (survivor evidence is never budget-trimmed), the manifest is all-included, and the ledger stays within the cap',
    r1.packet.layers.mandatory.length === 1 && r1.packet.layers.primary.length === 0
    && r1.packet.layers.distilled.length === 0 && r1.packet.layers.supporting.length === 0
    && r1.packet.manifest.every((m) => m.disposition === 'included')
    && r1.packet.ledger.totalTokens <= r1.packet.ledger.capTokens)
  t('A: the fingerprint is the §7.7-narrowed shape — 64-hex, model/planHash/selected components, the four producerless components null',
    is64hex(r1.packet.fingerprint.hash)
    && r1.packet.fingerprint.components.model === PLANNER_MODEL
    && is64hex(r1.packet.fingerprint.components.planHash)
    && eq(r1.packet.fingerprint.components.selected, r1.packet.layers.mandatory.map((m) => ({ id: m.id, contentHash: m.contentHash })))
    && r1.packet.fingerprint.components.promptVersion === null
    && r1.packet.fingerprint.components.roleVersion === null
    && r1.packet.fingerprint.components.reasoningConfiguration === null
    && r1.packet.fingerprint.components.projectManifestVersion === null)
  t('A: the rendered block is fixed-framing — header naming the round and the packet fingerprint, the record content inside, the footer',
    r1.renderedBlock.startsWith('=== ROUND 1 SURVIVOR EVIDENCE (composed context; fingerprint ')
    && r1.renderedBlock.includes(r1.packet.fingerprint.hash)
    && r1.renderedBlock.includes('candidate c01 (round 1 survivor)')
    && r1.renderedBlock.trimEnd().endsWith('=== END SURVIVOR EVIDENCE ==='))
  // T-050 framing: the composer's premise lines ride every rendered block —
  // the Known issue #6 (2026-10-23) cause-side fix. The lines are FRAMING,
  // not record content: they change no ArtifactRecord, so the packet and its
  // fingerprint (asserted above and recomputed in legs B/C) are unchanged.
  t('A (T-050): the rendered block carries EVERY fixed premise line verbatim — changes-not-base-state, same-base re-lease, survivor-created files absent, base-implementable briefs',
    ROUND_PREMISE_LINES.length >= 4
    && ROUND_PREMISE_LINES.every((line) => r1.renderedBlock.includes(line)))
  t('A (T-050): the premise lines sit inside the framing — after the header, before the first survivor body',
    r1.renderedBlock.indexOf(ROUND_PREMISE_LINES[0]) > r1.renderedBlock.indexOf('=== ROUND 1 SURVIVOR EVIDENCE')
    && r1.renderedBlock.lastIndexOf(ROUND_PREMISE_LINES[ROUND_PREMISE_LINES.length - 1]) < r1.renderedBlock.indexOf('candidate c01 (round 1 survivor)'))
  t('A (T-050): the premise lines are framing, not record bytes — no record content and no packet field carries them',
    r1.records.every((rec) => !ROUND_PREMISE_LINES.some((line) => rec.content.includes(line)))
    && !JSON.stringify(r1.packet).includes('PREMISES'))
  t('A: fingerprint reconciliation (the src/context.ts:101-104 duty) — the composer documents the relationship to input_context_hash at source level, and the context module header records the discharge',
    read(join(root, 'src', 'rounds.ts')).includes('input_context_hash')
    && read(join(root, 'src', 'context.ts')).includes('discharged by T-030'))
  t('A: the round-2 id scheme is charset-safe per SPEC_ID_PATTERN (src/scheduler.ts)',
    SPEC_ID_PATTERN.test('c01-r2') && SPEC_ID_PATTERN.test('c12-r2'))
}

// ---------- Leg B — fake-adapter capture (the Gate 1.21 S1 pattern) ----------
function scriptedAdapters() {
  // Planner fake: round-1 briefs on the plain prompt, round-2 briefs when the
  // composed block is present (keyed on the block's fixed framing header).
  const plannerFake = {
    id: 'fake',
    reqs: [],
    async execute(req) {
      this.reqs.push({ ...req, cwdExisted: existsSync(req.cwd) })
      const tail = req.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE')
        ? JSON.stringify(['round-2 brief A — add a second line to the marker', 'round-2 brief B — change nothing (no-op validation)'])
        : JSON.stringify(['round-1 brief A — write the marker file', 'round-1 brief B — write the marker file differently'])
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: tail, pid: null }
    },
  }
  // Worker fake: writes the marker EXCEPT for the no-op brief; serves the
  // reviewer role's observation prompts too (reviewerWorker absent ⇒ the
  // run-level fake serves review).
  const workerFake = {
    id: 'fake',
    reqs: [],
    async execute(req) {
      this.reqs.push({ ...req, cwdExisted: existsSync(req.cwd) })
      let tail = 'done'
      if (req.prompt.includes('You are the review tier')) {
        tail = JSON.stringify({ observations: [{ finding: 'fake reviewer saw the marker diff', severity: 'info', evidence: 'the diff' }] })
      } else if (!req.prompt.includes('change nothing')) {
        writeFileSync(join(req.cwd, 'marker.txt'), 'work\n')
      }
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: tail, pid: null }
    },
  }
  return { plannerFake, workerFake }
}

async function drive(name, { rounds, candidateIds = ['c01', 'c02'] }) {
  const scenarioDir = join(sandbox, name)
  const repo = join(scenarioDir, 'repo')
  const artifactsDir = join(scenarioDir, 'run')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '-b', 'main')
  writeFileSync(join(repo, 'base.txt'), 'baseline\n')
  git('-c', 'user.name=check-rounds', '-c', 'user.email=rounds@local', 'add', '-A')
  git('-c', 'user.name=check-rounds', '-c', 'user.email=rounds@local', 'commit', '-m', 'baseline')
  const baseSha = git('rev-parse', 'HEAD').trim()
  const { plannerFake, workerFake } = scriptedAdapters()
  const report = await runSkeleton({
    runId: name,
    repo,
    baseSha,
    goal: 'write the marker file',
    model: 'fake/worker-model',
    plannerModel: 'fake/planner-model',
    reviewerModel: 'fake/reviewer-model',
    candidateIds,
    concurrency: 2,
    timeoutMs: 10_000,
    maxAttempts: 1,
    gates: [fakeGate],
    worker: workerFake,
    plannerWorker: plannerFake,
    ...(rounds !== undefined ? { rounds } : {}),
    workspaces: new WorktreeProvider(repo, artifactsDir),
    artifactsDir,
    cleanWorkspaces: false,
  })
  return { report, repo, artifactsDir, baseSha, plannerFake, workerFake }
}

{
  const { report, repo, artifactsDir, baseSha, plannerFake } = await drive('fake-two-rounds', { rounds: 2 })
  const plannerBlockReqs = plannerFake.reqs.filter((r) => r.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE'))
  const plannerPlainReqs = plannerFake.reqs.filter((r) => !r.prompt.includes('=== ROUND 1 SURVIVOR EVIDENCE'))
  t('B: the planner fake served exactly two dispatches — round 1 without the composed block, round 2 with it',
    plannerFake.reqs.length === 2 && plannerPlainReqs.length === 1 && plannerBlockReqs.length === 1)

  // Re-derive the composition independently from the finished round-1
  // candidates the report carries — the composer is deterministic, so the
  // check can rebuild exactly what the runner composed.
  const round1Candidates = report.candidates.filter((c) => !c.id.endsWith('-r2'))
  const recomputed = composeRoundPacket({ candidates: round1Candidates, model: 'fake/planner-model', finishedRound: 1 })
  t('B: the composed block lands in the round-2 planner prompt VERBATIM — the exact recomputed rendered block is a substring of the captured request',
    plannerBlockReqs[0]?.prompt.includes(recomputed.renderedBlock) === true)
  t('B: the round-2 planner prompt demonstrably carries round-1 survivor evidence — survivor ids, briefs, gate results with the recorded command, and review observations',
    plannerBlockReqs[0]?.prompt.includes('c01') && plannerBlockReqs[0]?.prompt.includes('c02')
    && plannerBlockReqs[0]?.prompt.includes('write the marker file')
    && plannerBlockReqs[0]?.prompt.includes('always-pass: PASS (exit 0, command: node fake-gate.js)')
    && plannerBlockReqs[0]?.prompt.includes('fake reviewer saw the marker diff'))
  t('B: the round-1 planner prompt carries no survivor-evidence section (the block is round-2 input only)',
    !plannerPlainReqs[0]?.prompt.includes('SURVIVOR EVIDENCE'))
  t('B (T-050): the round-2 planner prompt carries every premise line (they rode the composed block verbatim above)',
    ROUND_PREMISE_LINES.every((line) => plannerBlockReqs[0]?.prompt.includes(line) === true))
  t('B (T-050): the round-1 planner prompt carries NONE of the premise lines — round-1 prompts are byte-identical to today',
    !ROUND_PREMISE_LINES.some((line) => plannerPlainReqs[0]?.prompt.includes(line)))

  t('B: report on disk — top-level keys exactly today\'s plus the additive rounds block',
    eq(sortedKeys(JSON.parse(read(join(artifactsDir, 'report.json')))),
      ['baseSha', 'candidates', 'finishedAt', 'goal', 'model', 'planner', 'repo', 'rounds', 'runId', 'startedAt']))
  const onDisk = JSON.parse(read(join(artifactsDir, 'report.json')))
  t('B: the rounds block has exactly the ticketed fields — round 1 (executed/survivorIds), round 2 plus packetFingerprint and renderedBlockPath',
    onDisk.rounds.length === 2
    && onDisk.rounds[0]?.round === 1 && onDisk.rounds[0]?.executed === true
      && eq(sortedKeys(onDisk.rounds[0]), ['executed', 'round', 'survivorIds'])
      && eq(onDisk.rounds[0].survivorIds, ['c01', 'c02'])
    && onDisk.rounds[1]?.round === 2 && onDisk.rounds[1]?.executed === true
      && eq(sortedKeys(onDisk.rounds[1]), ['executed', 'packetFingerprint', 'renderedBlockPath', 'round', 'survivorIds']))
  t('B: the recorded packetFingerprint equals the independently recomputed composition\'s fingerprint (the reconciliation pin, behavior side)',
    onDisk.rounds[1]?.packetFingerprint === recomputed.packet.fingerprint.hash && is64hex(onDisk.rounds[1]?.packetFingerprint))
  t('B: the rendered block lives under the run artifacts dir and its bytes equal the recomputed block',
    onDisk.rounds[1]?.renderedBlockPath.startsWith(artifactsDir)
    && existsSync(onDisk.rounds[1].renderedBlockPath)
    && read(onDisk.rounds[1].renderedBlockPath) === recomputed.renderedBlock)

  t('B: candidates are round 1\'s wave then round 2\'s — deterministic distinct `<survivorId>-r2` ids, no collisions',
    eq(report.candidates.map((c) => c.id), ['c01', 'c02', 'c01-r2', 'c02-r2'])
    && report.candidates.every((c) => SPEC_ID_PATTERN.test(c.id)))
  t('B: round-2 candidates lease fresh worktrees at the SAME baseSha (survivor diffs are planning evidence, never stacked patches)',
    existsSync(join(artifactsDir, 'wt', 'c01-r2'))
    && execFileSync('git', ['-C', join(artifactsDir, 'wt', 'c01-r2'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === baseSha
    && execFileSync('git', ['-C', join(artifactsDir, 'wt', 'c02-r2'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === baseSha)
  const dispatchLines = read(join(artifactsDir, 'dispatch.jsonl')).trim().split('\n').map((l) => JSON.parse(l))
  t('B: dispatch.jsonl keeps its line shapes — exactly ONE run header (written once), round 2 is just more dispatch lines with r2 branches',
    dispatchLines.filter((l) => l.type === 'run').length === 1
    && dispatchLines[0]?.type === 'run'
    && dispatchLines.filter((l) => l.type === 'dispatch' && l.jobId === 'c01-r2').length === 1
    && dispatchLines.find((l) => l.type === 'dispatch' && l.jobId === 'c01-r2')?.branch === 'swarm/wt-c01-r2'
    && dispatchLines.find((l) => l.type === 'dispatch' && l.jobId === 'c02-r2')?.branch === 'swarm/wt-c02-r2')

  const c02r2 = report.candidates.find((c) => c.id === 'c02-r2')
  t('B: a round-2 zero-byte diff is a NO-OP elimination regardless of what the planner saw — the vacuous gate PASSED and the diffBytes leg still eliminated (AGENTS.md #7)',
    c02r2?.workerOk === true && c02r2?.diffBytes === 0
    && c02r2?.gates.length === 1 && c02r2?.gates[0]?.passed === true
    && c02r2?.passedAllGates === false && c02r2?.error === undefined)
  t('B: no review observation participates in any verdict — the eliminated no-op was never reviewed; survivors were reviewed after their verdicts',
    c02r2?.review === undefined && !existsSync(join(artifactsDir, 'c02-r2', 'review.json'))
    && report.candidates.filter((c) => c.passedAllGates).every((c) => c.review?.ok === true))
  t('B: round-2 candidate attempts keep their T-007 inputContextHash beside the packet fingerprint (64-hex, machinery unchanged)',
    report.candidates.filter((c) => c.id.endsWith('-r2')).every((c) => is64hex(c.attempts[0]?.inputContextHash)))
  t('B: candidate report keys unchanged (no new per-candidate fields; `review` present exactly where gates passed and review ran)',
    onDisk.candidates.every((c) => eq(sortedKeys(c),
      c.review === undefined
        ? ['attempts', 'brief', 'diffBytes', 'diffPath', 'gates', 'id', 'model', 'passedAllGates', 'workerDurationMs', 'workerId', 'workerOk', 'workerTimedOut', 'workspacePath']
        : ['attempts', 'brief', 'diffBytes', 'diffPath', 'gates', 'id', 'model', 'passedAllGates', 'review', 'workerDurationMs', 'workerId', 'workerOk', 'workerTimedOut', 'workspacePath'])))
  t('B: the last executed planner phase is round 2\'s — the report\'s planner block names the final wave\'s briefs',
    report.planner?.briefs?.length === 2 && report.planner?.briefs[0] === 'round-2 brief A — add a second line to the marker')
}

{
  // Flag-absent at the API level (the rounds key omitted from SkeletonOptions
  // entirely) — the explicit --rounds 1 spelling is pinned over the real CLI
  // in leg C below.
  const { report, artifactsDir, plannerFake } = await drive('fake-one-round', {})
  const onDisk = JSON.parse(read(join(artifactsDir, 'report.json')))
  t('B (n=1, flag-absent): today\'s single pass — NO rounds block, today\'s exact top-level and candidate key sets, one planner dispatch without the block',
    !('rounds' in onDisk)
    && eq(sortedKeys(onDisk), ['baseSha', 'candidates', 'finishedAt', 'goal', 'model', 'planner', 'repo', 'runId', 'startedAt'])
    && onDisk.candidates.length === 2
    && onDisk.candidates.every((c) => eq(sortedKeys(c),
      ['attempts', 'brief', 'diffBytes', 'diffPath', 'gates', 'id', 'model', 'passedAllGates', 'review', 'workerDurationMs', 'workerId', 'workerOk', 'workerTimedOut', 'workspacePath']))
    && plannerFake.reqs.length === 1 && !plannerFake.reqs[0]?.prompt.includes('SURVIVOR EVIDENCE'))
  t('B (n=1): the report object returned in memory carries no rounds key either',
    !('rounds' in report))
}

// ---------- Leg C — token-free REAL-CLI 2-round loop (machine planner +
// ---------- machine reviewer + the committed `run` opencode stub) ----------
const roundDir = join(sandbox, 'real-loop')
const repoLoop = join(roundDir, 'repo-loop')
const repoOne = join(roundDir, 'repo-one')
const runs = join(roundDir, 'runs')
mkdirSync(roundDir, { recursive: true })
const identity = ['-c', 'user.name=check-rounds', '-c', 'user.email=rounds@local']

// The machine planner's command: round-1 briefs on the first call, round-2
// briefs once the run's own planner-r2.log exists (the machine adapter
// writes its provenance header BEFORE spawning the command, and the
// planner's cwd is <artifactsDir>/planner-scratch, so '..' is the run
// artifacts dir). Deterministic: the r2 log cannot exist during round 1.
const plannerScript = join(roundDir, 'planner.cjs')
writeFileSync(plannerScript, [
  'const fs = require(\'node:fs\')',
  'const path = require(\'node:path\')',
  'const r2log = path.join(process.cwd(), \'..\', \'planner-r2.log\')',
  'const briefs = fs.existsSync(r2log)',
  '  ? ["round 2 refined: write feature.txt with content gamma", "change nothing — this brief intentionally validates the no-op elimination path"]',
  '  : ["write feature.txt with content alpha", "write feature.txt with content beta"]',
  'console.log(JSON.stringify(briefs))',
  '',
].join('\n'))
// The machine reviewer's command: a fixed valid observations object —
// advisory evidence produced with zero tokens (the Gate 1.21 S3 pattern).
const reviewerScript = join(roundDir, 'reviewer.cjs')
writeFileSync(reviewerScript, [
  'console.log(JSON.stringify({observations:[{finding:"machine reviewer saw the round-1 feature diff",severity:"info",evidence:"the captured diff"}]}))',
  '',
].join('\n'))
// The opencode stub: committed AS the repo-root file `run`. The adapter
// spawns `<bin> run -m <model>` with cwd = the leased worktree, and node
// resolves the entry `run` against its cwd — the fixture repo's own stub
// executes in every candidate worktree, token-free. Since T-042 the prompt
// arrives on STDIN (never argv), so the stub reads fd 0 to EOF — the same
// bytes the pre-T-042 argv positional carried.
const stubContent = [
  '// T-030 Gate 1.22 fixture: the committed opencode stub (token-free).',
  'const fs = require(\'node:fs\')',
  'const prompt = (() => { try { return fs.readFileSync(0, \'utf8\') } catch { return \'\' } })()',
  'if (prompt.includes(\'change nothing\')) { console.log(\'no-op by brief\'); process.exit(0) }',
  'const brief = (prompt.split(\'GOAL: \')[1] ?? \'\').split(\'\\n\')[0]',
  'fs.writeFileSync(\'feature.txt\', \'implemented: \' + brief + \'\\n\')',
  'console.log(\'stub worker done\')',
  '',
].join('\n')

const makeSandboxRepo = (repo) => {
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
  writeFileSync(join(repo, 'run'), stubContent)
  git(...identity, 'init', '-b', 'main')
  git(...identity, 'add', '-A')
  git(...identity, 'commit', '-m', 'baseline with the run stub')
  return git
}
const gitLoop = makeSandboxRepo(repoLoop)
makeSandboxRepo(repoOne)
const loopBaseSha = gitLoop('rev-parse', 'HEAD').trim()

const runCli = (label, repo, extraArgs) => {
  let code = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, [
      join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(root, 'src', 'cli.ts'),
      '--repo', repo,
      '--goal', 'write feature.txt with the planned content',
      '--gate', 'vacuous=node -e "process.exit(0)"',
      '--candidates', '2',
      '--planner-worker', 'machine', '--planner-command', JSON.stringify([NODE, plannerScript]),
      '--reviewer-worker', 'machine', '--reviewer-command', JSON.stringify([NODE, reviewerScript]),
      '--opencode-bin', NODE,
      '--run-root', runs,
      '--db', join(roundDir, 'refinery.db'),
      ...extraArgs,
    ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  if (code !== 0) console.error(`--- real-loop run output (${label}, exit ${code}) ---\n${out}`)
  return { code, out }
}
const runIdOf = (out) => out.match(/run (\d{14}):/)?.[1]

const twoRound = runCli('2-round loop', repoLoop, ['--rounds', '2'])
t('C: the real-CLI 2-round run exits 0 (mechanical completion — a NO-OP elimination is a verdict, not a failure)', twoRound.code === 0)
t('C: the store accepted the rounds-carrying report end to end (no PERSISTENCE FAILED line)', !twoRound.out.includes('PERSISTENCE FAILED'))
const loopRunId = runIdOf(twoRound.out)
const loopRunDir = join(runs, loopRunId ?? 'missing')
t('C: the 2-round run created its run dir under the sandbox run root', typeof loopRunId === 'string' && existsSync(join(loopRunDir, 'report.json')))
const loopReport = JSON.parse(read(join(loopRunDir, 'report.json')))

t('C: the rounds block is present and exactly ticketed — round 1 executed with both survivors, round 2 executed with the fingerprint and block path',
  loopReport.rounds?.length === 2
  && loopReport.rounds[0]?.round === 1 && loopReport.rounds[0]?.executed === true
    && eq(loopReport.rounds[0].survivorIds, ['c01', 'c02'])
  && loopReport.rounds[1]?.round === 2 && loopReport.rounds[1]?.executed === true
  && is64hex(loopReport.rounds[1]?.packetFingerprint)
  && typeof loopReport.rounds[1]?.renderedBlockPath === 'string')

const loopRound1 = loopReport.candidates.filter((c) => !c.id.endsWith('-r2'))
const loopRecomputed = composeRoundPacket({ candidates: loopRound1, model: PLANNER_MODEL, finishedRound: 1 })
t('C: the recorded packetFingerprint equals the independently recomputed composition of the run\'s own round-1 candidates (full re-derivation)',
  loopReport.rounds[1].packetFingerprint === loopRecomputed.packet.fingerprint.hash)
t('C: the rendered block on disk is byte-identical to the recomputed block and carries the survivor evidence',
  read(loopReport.rounds[1].renderedBlockPath) === loopRecomputed.renderedBlock
  && loopRecomputed.renderedBlock.includes('candidate c01 (round 1 survivor)')
  && loopRecomputed.renderedBlock.includes('machine reviewer saw the round-1 feature diff'))
t('C: candidates are both rounds\' waves in order — c01, c02, c01-r2, c02-r2 (deterministic distinct ids, charset-safe)',
  eq(loopReport.candidates.map((c) => c.id), ['c01', 'c02', 'c01-r2', 'c02-r2']))

const loopC02r2 = loopReport.candidates.find((c) => c.id === 'c02-r2')
t('C: gates decided both rounds — a round-2 zero-byte diff is a NO-OP elimination regardless of what the planner saw (vacuous gate PASSED, diffBytes leg eliminated, never reviewed)',
  loopC02r2?.workerOk === true && loopC02r2?.diffBytes === 0
  && loopC02r2?.gates[0]?.name === 'vacuous' && loopC02r2?.gates[0]?.passed === true
  && loopC02r2?.passedAllGates === false && loopC02r2?.review === undefined
  && twoRound.out.includes('NO-OP (no diff)'))
t('C: round-2 passers passed through the same ladder (worker ok, non-empty diff, gates pass) and were reviewed post-gates',
  loopReport.candidates.filter((c) => c.id !== 'c02-r2').every((c) => c.workerOk && c.diffBytes > 0 && c.passedAllGates && c.review?.ok === true))
t('C: round-2 candidates lease fresh worktrees at the SAME baseSha (never stacked on round-1 diffs)',
  execFileSync('git', ['-C', join(loopRunDir, 'wt', 'c01-r2'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === loopBaseSha
  && execFileSync('git', ['-C', join(loopRunDir, 'wt', 'c02-r2'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === loopBaseSha)

const loopDispatch = read(join(loopRunDir, 'dispatch.jsonl')).trim().split('\n').map((l) => JSON.parse(l))
t('C: dispatch.jsonl — one run header, round 2 as more dispatch lines with `swarm/wt-<id>-r2` branches',
  loopDispatch.filter((l) => l.type === 'run').length === 1
  && loopDispatch.find((l) => l.type === 'dispatch' && l.jobId === 'c01-r2')?.branch === 'swarm/wt-c01-r2'
  && loopDispatch.find((l) => l.type === 'dispatch' && l.jobId === 'c02-r2')?.branch === 'swarm/wt-c02-r2')

const plannerR2Log = read(join(loopRunDir, 'planner-r2.log'))
t('C: the captured round-2 planner.log (machine provenance header = req.prompt verbatim) carries round-1 survivor ids, gate results with commands, and review observations',
  plannerR2Log.includes('=== ROUND 1 SURVIVOR EVIDENCE')
  && plannerR2Log.includes('c01') && plannerR2Log.includes('c02')
  && plannerR2Log.includes('- vacuous: PASS (exit 0, command: node -e "process.exit(0)")')
  && plannerR2Log.includes('machine reviewer saw the round-1 feature diff')
  && plannerR2Log.includes(loopReport.rounds[1].packetFingerprint))
t('C: the round-1 planner.log carries no survivor-evidence section (round separation)',
  !read(join(loopRunDir, 'planner.log')).includes('SURVIVOR EVIDENCE'))

// AC disposal face: after the 2-round loop, clean disposes EVERY round's
// worktrees and swarm/* branches, exits 0, evidence kept (Gate 1.5
// semantics per round).
const loopBranches = () => gitLoop('branch', '--list', 'swarm/*').split('\n').map((l) => l.replace(/^[*+]\s*/, '').trim()).filter(Boolean).sort()
t('C (both rounds\' lease shapes): round 1 and round 2 branches exist side by side before disposal',
  eq(loopBranches(), ['swarm/wt-c01', 'swarm/wt-c01-r2', 'swarm/wt-c02', 'swarm/wt-c02-r2']))
let cleanCode = 0
let cleanOut = ''
try {
  cleanOut = execFileSync(process.execPath, [
    join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(root, 'src', 'clean.ts'),
    '--run', loopRunId, '--run-root', runs, '--force',
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
} catch (e) {
  cleanCode = e.status ?? -1
  cleanOut = `${e.stdout ?? ''}${e.stderr ?? e.message}`
}
if (cleanCode !== 0) console.error(`--- clean output (2-round disposal, exit ${cleanCode}) ---\n${cleanOut}`)
t('C (disposal): clean --run exits 0 over the 2-round run', cleanCode === 0)
t('C (disposal): every round\'s worktrees and swarm/* branches disposed — only main remains, no -r2 branches survive',
  loopBranches().length === 0
  && gitLoop('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length === 1)
t('C (disposal): evidence kept — report.json, dispatch.jsonl, and every round\'s diff.patch survive (the no-op\'s empty diff.patch included)',
  existsSync(join(loopRunDir, 'report.json')) && existsSync(join(loopRunDir, 'dispatch.jsonl'))
  && ['c01', 'c02', 'c01-r2', 'c02-r2'].every((id) => existsSync(join(loopRunDir, id, 'diff.patch')))
  && existsSync(loopReport.rounds[1].renderedBlockPath))

// n=1 real-CLI: today's single pass, NO rounds block (a separate sandbox
// repo, so the two runs' swarm/* branch namespaces cannot collide).
const oneRound = runCli('1-round run', repoOne, ['--rounds', '1'])
t('C: the real-CLI --rounds 1 run exits 0', oneRound.code === 0)
const oneRunId = runIdOf(oneRound.out)
const oneReport = JSON.parse(read(join(runs, oneRunId ?? 'missing', 'report.json')))
t('C (n=1): --rounds 1 is today\'s single pass — NO rounds block, today\'s exact top-level key set, one candidate wave',
  !('rounds' in oneReport)
  && eq(sortedKeys(oneReport), ['baseSha', 'candidates', 'finishedAt', 'goal', 'model', 'planner', 'repo', 'runId', 'startedAt'])
  && eq(oneReport.candidates.map((c) => c.id), ['c01', 'c02']))

t('C: no residual lock files after the runs and the clean',
  !existsSync(join(runs, 'locks')) || readdirSync(join(runs, 'locks')).filter((f) => f.endsWith('.lock')).length === 0)

// ---------- Leg D — CLI refusals, exit 1, zero side effects ----------
{
  const refuseRoot = join(sandbox, 'refusals', 'runs')
  const notARepo = join(sandbox, 'refusals', 'not-a-repo')
  mkdirSync(notARepo, { recursive: true })
  const expectRefusal = (label, args, needle) => {
    let code = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [
        join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(root, 'src', 'cli.ts'),
        ...args,
      ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    } catch (e) {
      code = e.status ?? -1
      out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
    }
    const sideEffects = existsSync(refuseRoot)
      ? readdirSync(refuseRoot).filter((d) => /^\d{14}$/.test(d) || d === 'locks')
      : []
    t(`D: ${label} — exit 1, names the offense, zero side effects (no artifacts dir, no lock)`,
      code === 1 && out.includes(needle) && sideEffects.length === 0)
    if (code !== 1) console.error(`--- refusal output (${label}, exit ${code}) ---\n${out}`)
  }
  const specFile = join(sandbox, 'refusals', 'spec.json')
  writeFileSync(specFile, JSON.stringify({ phases: [{ id: 'p' }], jobs: [{ id: 'j1', phase: 'p', brief: 'b' }] }))

  expectRefusal('--rounds 0', ['--repo', notARepo, '--goal', 'g', '--rounds', '0', '--run-root', refuseRoot],
    '--rounds expects an integer between 1 and 2')
  expectRefusal('--rounds 3 (beyond the cap)', ['--repo', notARepo, '--goal', 'g', '--rounds', '3', '--run-root', refuseRoot],
    '--rounds expects an integer between 1 and 2')
  expectRefusal('--rounds 1.5 (non-integer)', ['--repo', notARepo, '--goal', 'g', '--rounds', '1.5', '--run-root', refuseRoot],
    '--rounds expects an integer between 1 and 2')
  expectRefusal('--rounds abc (not a number)', ['--repo', notARepo, '--goal', 'g', '--rounds', 'abc', '--run-root', refuseRoot],
    '--rounds expects an integer between 1 and 2')
  expectRefusal('--rounds 2 with --jobs', ['--repo', notARepo, '--rounds', '2', '--jobs', specFile, '--run-root', refuseRoot],
    '--rounds 2 requires planner mode')
  expectRefusal('--rounds 2 with --no-planner', ['--repo', notARepo, '--goal', 'g', '--rounds', '2', '--no-planner', '--run-root', refuseRoot],
    '--rounds 2 requires the planner')

  let helpCode = 0
  let helpOut = ''
  try {
    helpOut = execFileSync(process.execPath, [
      join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(root, 'src', 'cli.ts'), '--help',
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  } catch (e) {
    helpCode = e.status ?? -1
    helpOut = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  t('D: --help documents --rounds with its default and bounds', helpCode === 0 && helpOut.includes('--rounds <n>') && helpOut.includes('default: 1'))
}

rmSync(sandbox, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\ncheck-rounds: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-rounds: ALL GREEN')
