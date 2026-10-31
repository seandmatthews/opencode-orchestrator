// Brief-count honesty self-check (Gate 1.42, fast tier, T-056) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-brief-count.mjs
// Pins the exact-count clause in parseBriefs' scans (src/parse.ts) and the
// consequence path end to end, all token-free. Two legs:
//
//   A — parser contract: the ticket's red-bar shapes (a 1-brief array for
//       count 2, a 3-brief array for count 2) parse NULL post-change — the
//       pad/truncate tail is gone; the exact-count clause holds through ALL
//       THREE scans (plain, separator-repair, objects); and every
//       EXACTLY-COUNT input is untouched byte-for-byte (the inertness
//       contract's narrowed scope — the preserved case pinned explicitly,
//       including both recorded Gate 0.5 fixtures).
//   B — fallback e2e (the Gate 1.22 leg-B fake-adapter pattern): runSkeleton
//       driven end-to-end with a stub planner whose reply is SHORT — the run
//       lands in the raw-goal fallback (planner.ok false, fallbackUsed true,
//       the loud console line), NOT padded dispatch: every candidate rides
//       the raw goal, no worker ever sees the padded brief. The control face:
//       an exactly-N planner reply dispatches its parsed briefs exactly as
//       before (the preserved case, end to end).
//
// Red bar, recorded FIRST against main (AGENTS.md #8; asserted by a read-only
// probe importing main's src/parse.ts before this change-set existed):
//   parseBriefs('["a"]', 2)          -> ["a","a"]   (cyclic pad)
//   parseBriefs('["a","b","c"]', 2)  -> ["a","b"]   (silent truncate)
// Leg A asserts the green replacement of exactly those two outputs.
//
// All subprocesses are list-form (AGENTS.md #4); the sandbox under C:\swarm
// is created and removed by this check (AGENTS.md #10).
import { swarmRoot } from './swarm-root.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBriefs } from '../src/parse.ts'
import { runSkeleton } from '../src/runner.ts'
import { WorktreeProvider } from '../src/workspace/worktree.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = swarmRoot + '/verify-brief-count'

// ---------- Leg A — parser contract (token-free) ----------
{
  // The ticket's red-bar shapes, green replacements of the recorded main
  // outputs (see the header). Under-count AND over-count, plain scan.
  t('A: a 1-brief array for count 2 parses null — no cyclic pad (main returned ["a","a"]; the recorded red bar)',
    parseBriefs('["a"]', 2) === null)
  t('A: a 3-brief array for count 2 parses null — no truncate (main returned ["a","b"]; the recorded red bar)',
    parseBriefs('["a","b","c"]', 2) === null)
  t('A: a short array embedded in prose still parses null at a mismatched count — prose tolerance never manufactures the missing briefs',
    parseBriefs('Sure! Here you go: ["a"] hope that helps', 2) === null)
  t('A: the exact-count clause holds through the objects scan — 1 object for count 2 and 3 objects for count 4 both parse null',
    parseBriefs('[{"brief":"only one"}]', 2) === null
    && parseBriefs('[{"brief":"a"},{"brief":"b"},{"brief":"c"}]', 4) === null)
  // The separator repair is count-gated too: its repaired slice parses to
  // exactly 2, so count 3 must stay null (repair never tops up).
  const separated = '["first brief ends here."," "second brief has [brackets] inside"]\r\n\r\n> plan · glm-5.3\r\n\r\n'
  t('A: the separator repair is count-gated — the recorded duplicated-quote shape (2 briefs after repair) parses null for count 3',
    parseBriefs(separated, 3) === null
    && JSON.stringify(parseBriefs(separated, 2)) === JSON.stringify(['first brief ends here.', 'second brief has [brackets] inside']))
  // The preserved case, pinned explicitly: exactly-N arrays return N briefs
  // byte-identical to main's output (trim parity included) — the inertness
  // contract's narrowed scope is exactly the count-mismatch case.
  t('A: preserved byte-identity — exactly-N arrays return main\'s exact output, trim parity included',
    JSON.stringify(parseBriefs('["a","b"]', 2)) === '["a","b"]'
    && JSON.stringify(parseBriefs('[" x ","y "]', 2)) === JSON.stringify(['x', 'y'])
    && JSON.stringify(parseBriefs('["only"]', 1)) === '["only"]')
  t('A: preserved byte-identity — the non-string element filter keeps working when the FILTERED count is exactly N (mixed array, count 1)',
    JSON.stringify(parseBriefs('[1,{"x":2},"a"]', 1)) === '["a"]')
  // The Gate 0.5 recorded fixture parses to exactly its count — asserted, not
  // weakened (the ticket's fixture-preservation criterion).
  const objectsRaw = readFileSync(join(root, 'scripts', 'fixtures', 'planner-r2-objects-raw.txt'), 'utf8')
  const objectsBriefs = parseBriefs(objectsRaw, 2)
  t('A: the Gate 0.5 recorded fixture (planner-r2-objects-raw.txt, 2 labeled briefs) parses to exactly its count — the model\'s own two briefs, unchanged',
    Array.isArray(objectsBriefs) && objectsBriefs.length === 2
    && objectsBriefs[0]?.startsWith('Brief A - ') && objectsBriefs[1]?.startsWith('Brief B - ')
    && objectsBriefs.every((b) => objectsRaw.includes(b)))
}

// ---------- Leg B — fallback e2e (token-free stub adapters, the Gate 1.22
// ---------- leg-B fake-adapter pattern) ----------
function scriptedAdapters(plannerReply) {
  // Planner fake: the SAME scripted reply on the initial call and on the
  // bounded repair attempt (the honest simulation — still short/valid on
  // repair). Records every request.
  const plannerFake = {
    id: 'fake',
    reqs: [],
    async execute(req) {
      this.reqs.push({ ...req })
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: plannerReply, pid: null }
    },
  }
  // Worker fake: writes the marker (non-zero diff, gate-decided survival);
  // serves the reviewer role's observation prompts too.
  const workerFake = {
    id: 'fake',
    reqs: [],
    async execute(req) {
      this.reqs.push({ ...req })
      let tail = 'done'
      if (req.prompt.includes('You are the review tier')) {
        tail = JSON.stringify({ observations: [{ finding: 'fake reviewer saw the marker diff', severity: 'info', evidence: 'the diff' }] })
      } else {
        writeFileSync(join(req.cwd, 'marker.txt'), 'work\n')
      }
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 5, logPath: req.logPath, responseTail: tail, pid: null }
    },
  }
  return { plannerFake, workerFake }
}

const fakeGate = {
  name: 'always-pass',
  run: async () => ({ name: 'always-pass', passed: true, exitCode: 0, durationMs: 1, outputTail: 'ok', command: 'node fake-gate.js' }),
}

async function drive(name, plannerReply) {
  const scenarioDir = join(sandbox, name)
  const repo = join(scenarioDir, 'repo')
  const artifactsDir = join(scenarioDir, 'run')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '-b', 'main')
  writeFileSync(join(repo, 'base.txt'), 'baseline\n')
  git('-c', 'user.name=check-brief-count', '-c', 'user.email=briefcount@local', 'add', '-A')
  git('-c', 'user.name=check-brief-count', '-c', 'user.email=briefcount@local', 'commit', '-m', 'baseline')
  const baseSha = git('rev-parse', 'HEAD').trim()
  const { plannerFake, workerFake } = scriptedAdapters(plannerReply)
  // Capture runSkeleton's console lines (the loud fallback line is part of
  // the pinned behavior) while letting them through.
  const lines = []
  const orig = console.log
  console.log = (...args) => { lines.push(args.map(String).join(' ')) }
  let report
  try {
    report = await runSkeleton({
      runId: name,
      repo,
      baseSha,
      goal: 'write the marker file',
      model: 'fake/worker-model',
      plannerModel: 'fake/planner-model',
      reviewerModel: 'fake/reviewer-model',
      candidateIds: ['c01', 'c02'],
      concurrency: 2,
      timeoutMs: 10_000,
      maxAttempts: 1,
      gates: [fakeGate],
      worker: workerFake,
      plannerWorker: plannerFake,
      workspaces: new WorktreeProvider(repo, artifactsDir),
      artifactsDir,
      cleanWorkspaces: false,
    })
  } finally {
    console.log = orig
  }
  return { report, artifactsDir, plannerFake, workerFake, lines }
}

// Face 1 — a SHORT planner reply lands in the raw-goal fallback, loudly,
// instead of padded dispatch.
{
  const lazy = '["the single brief the lazy planner sent"]'
  const { report, artifactsDir, plannerFake, workerFake, lines } = await drive('short-reply', lazy)
  t('B (short): the planner phase FAILED honestly — ok false, fallbackUsed true, both attempts spent (initial + the bounded repair), zero briefs recorded',
    report.planner?.ok === false && report.planner?.fallbackUsed === true
    && report.planner?.attempts === 2 && report.planner?.briefs?.length === 0)
  t('B (short): the loud console line says the run fell back to the raw goal',
    lines.some((l) => /^planner: no valid output, using raw goal in \d+s \(2 attempts\)$/.test(l.trim())))
  t('B (short): the planner fake served exactly two dispatches — initial + bounded repair — and got the same short reply both times',
    plannerFake.reqs.length === 2 && plannerFake.reqs.every((r) => r.prompt.includes('Produce exactly 2 distinct implementation briefs')))
  t('B (short): NO padded dispatch — every candidate rode the RAW GOAL, not the lazy brief (main would have dispatched the padded "the single brief..." twice)',
    report.candidates.length === 2
    && report.candidates.every((c) => c.brief === 'write the marker file')
    && report.candidates.every((c) => c.brief !== 'the single brief the lazy planner sent'))
  t('B (short): no worker was ever handed the padded brief — every worker prompt carries the raw goal\'s GOAL line only',
    workerFake.reqs.filter((r) => r.prompt.includes('You are implementing')).length === 2
    && workerFake.reqs.filter((r) => r.prompt.includes('You are implementing')).every((r) => r.prompt.includes('GOAL: write the marker file'))
    && workerFake.reqs.every((r) => !r.prompt.includes('the single brief the lazy planner sent')))
  t('B (short): the run still completed honestly — both raw-goal candidates dispatched, gates decided, survivors survived',
    report.candidates.every((c) => c.workerOk === true && c.diffBytes > 0 && c.passedAllGates === true && c.gates[0]?.passed === true))
  t('B (short): the raw output is preserved verbatim for diagnosis (planner-raw.txt keeps the short reply\'s bytes)',
    existsSync(join(artifactsDir, 'planner-raw.txt'))
    && readFileSync(join(artifactsDir, 'planner-raw.txt'), 'utf8') === lazy)
}

// Face 2 (control) — an exactly-N planner reply dispatches its parsed briefs
// exactly as before: the preserved case, end to end.
{
  const briefA = 'write the marker file with content alpha'
  const briefB = 'write the marker file with content beta'
  const { report, plannerFake, workerFake, lines } = await drive('exact-reply', JSON.stringify([briefA, briefB]))
  t('B (exact): the planner phase succeeded as always — ok true, no fallback, one attempt, both briefs parsed',
    report.planner?.ok === true && report.planner?.fallbackUsed === false
    && report.planner?.attempts === 1
    && JSON.stringify(report.planner?.briefs) === JSON.stringify([briefA, briefB]))
  t('B (exact): the console line is the plain success line',
    lines.some((l) => /^planner: 2 briefs in \d+s \(1 attempt\)$/.test(l.trim())))
  t('B (exact): the parsed briefs rode the dispatch in order — c01 got brief A, c02 got brief B',
    report.candidates.length === 2
    && report.candidates[0]?.brief === briefA && report.candidates[1]?.brief === briefB)
  t('B (exact): each worker prompt carries its own brief\'s GOAL line',
    workerFake.reqs.filter((r) => r.prompt.includes('You are implementing')).length === 2
    && workerFake.reqs.some((r) => r.prompt.includes(`GOAL: ${briefA}`))
    && workerFake.reqs.some((r) => r.prompt.includes(`GOAL: ${briefB}`)))
  t('B (exact): only ONE planner dispatch — no repair attempt fired on a valid reply',
    plannerFake.reqs.length === 1)
}

rmSync(sandbox, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\ncheck-brief-count: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-brief-count: ALL GREEN')
