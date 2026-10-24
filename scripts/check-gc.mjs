// Worktree lease GC self-check (Gate 1.18, fast tier, T-020) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-gc.mjs
// Zero model tokens, zero opencode involvement. One shared sandbox repo with a
// run root holding one run dir per classification, driven through the real
// `gc` CLI (the Gate 1.5 sandbox pattern). Scenarios:
//   A1  crashed-reconciled (dispatch.jsonl + recovery.json, no report.json):
//       the orphaned worktree is removed and its swarm/* branch removed after
//       it, through clean's disposal semantics; exit-healthy contributor.
//   A2  crashed-unreconciled (no report.json, no recovery.json): reported
//       "run npm run recover first", NOTHING removed — worktree, branch, and
//       dispatch evidence intact.
//   A3  finished, the reproduced --clean leak shape (report.json with
//       workspacePath:null candidates): the leaked branches swarm/wt-c03a,
//       swarm/wt-c03b, and the retry leg swarm/wt-c03b-a2 are deleted; the
//       unowned swarm/wt-ghost is reported and never deleted.
//   A4  finished with a still-registered worktree: no worktree disposal; its
//       branch is held by the registered worktree and never deleted.
//   A5  crashed-reconciled with a DIRTY worktree: refused (GC takes no
//       --force), reported per-item with the clean --force pointer, worktree
//       + branch intact — the whole pass exits 1.
//   A6  wt/int-* integration worktree: never auto-disposed — reported held,
//       byte-identical across the pass, while its crashed-reconciled
//       sibling's orphan IS disposed.
//   E   evidence never deleted: report.json / dispatch.jsonl / recovery.json
//       / worker.log / diff.patch hash-identical across pass A.
//   B   a held checkout lock skips every run as live, naming the holder pid
//       and lock path, removing nothing, exit 0 (healthy); the documented
//       --force-lock override proceeds (parity with clean) and disposes;
//       the lock is released on every path.
//   C   finished run owning a branch whose tip is beyond the report's
//       baseSha (the committing worker, worktree already gone — the --clean
//       leak shape, T-044): the sweep REFUSES the attributable, unregistered
//       branch with the loud evidence line; exit 1; branch survives.
//   D   T-048's evidence-parity predicate rides gc's crashed-reconciled
//       lane (shared disposeTargets), both legs: a worktree whose changes
//       were captured before the crash (stored diff.patch at the runner's
//       evidence geometry) is DISPOSED by the no---force gc pass, and the
//       same shape plus a post-capture edit is REFUSED per-item (worktree +
//       branch + evidence survive); exit 1.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-gc'
const repo = join(sandbox, 'repo')
const runs = join(sandbox, 'runs')
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const IDENTITY = ['-c', 'user.name=check-gc', '-c', 'user.email=gc@local']

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
const git = (...args) => run('git', ['-C', repo, ...args])
const read = (p) => readFileSync(p, 'utf8')
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const lockFilesIn = (dir) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.lock'))
  } catch {
    return []
  }
}

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(repo, { recursive: true })
mkdirSync(runs, { recursive: true })
git('init', '-b', 'main')
writeFileSync(join(repo, 'file.txt'), 'baseline\n')
git(...IDENTITY, 'add', '-A')
git(...IDENTITY, 'commit', '-m', 'baseline')
// The run base every lease branch sits at (T-044: the report's baseSha is
// the expected tip removeBranch's guard compares against — the fixture
// records the REAL base, exactly like src/cli.ts's report writer).
const BASE = git('rev-parse', 'HEAD').trim()

const swarmBranches = () => git('branch', '--list', 'swarm/*').split('\n').map((l) => l.replace(/^[*+]\s*/, '').trim()).filter(Boolean).sort().join(',')
const worktreeCount = () => git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length

/** Hand-lease one worktree the way a run's WorktreeProvider does
 *  (src/workspace/worktree.ts): `git worktree add <runDir>/wt/<id> -b
 *  swarm/wt-<id> <base>` — list-form git only. */
function leaseWorktree(runId, id, { detach = false, dirty = false } = {}) {
  const runDir = join(runs, runId)
  const wtDir = join(runDir, 'wt')
  mkdirSync(wtDir, { recursive: true })
  const wt = join(wtDir, id)
  const branch = `swarm/wt-${id}`
  if (detach) git('worktree', 'add', '--detach', wt, 'main')
  else git('worktree', 'add', wt, '-b', branch, 'main')
  if (dirty) writeFileSync(join(wt, 'file.txt'), 'uncommitted change\n')
  return { runDir, wt, branch }
}

/** Evidence shaped exactly like the engine's producers: dispatch.jsonl as
 *  src/runner.ts writes it (T-010), recovery.json as src/recover.ts writes it
 *  (T-010), report.json as the runner's --clean flow leaves it
 *  (workspacePath:null candidates). */
function writeDispatch(runId, entries) {
  const runDir = join(runs, runId)
  const lines = [
    JSON.stringify({ type: 'run', runId, repo, baseSha: '0'.repeat(40), goal: 'gc check', model: 'm', maxAttempts: 1, startedAt: '2026-01-01T00:00:00.000Z' }),
    ...entries.map((e) => JSON.stringify({
      type: 'dispatch', jobId: e.id, attempt: 1, leaseId: `wt/${e.id}`,
      branch: `swarm/wt-${e.id}`, worktreePath: join(runDir, 'wt', e.id), startedAt: '2026-01-01T00:00:01.000Z',
    })),
  ]
  writeFileSync(join(runDir, 'dispatch.jsonl'), lines.join('\n') + '\n')
}

function writeRecovery(runId, workspaces) {
  writeFileSync(join(runs, runId, 'recovery.json'), JSON.stringify({
    runId, recoveredAt: '2026-01-01T00:02:00.000Z', abandonedAttempts: [], kills: [],
    cleanupFailures: [],
    workspaces: workspaces.map((w) => ({ path: w.path, branch: w.branch ?? null, exists: true, dirty: w.dirty ?? false })),
    jobs: [],
  }, null, 2))
}

function writeFinishedReport(runId, candidates) {
  writeFileSync(join(runs, runId, 'report.json'), JSON.stringify({
    runId, repo, baseSha: BASE, goal: 'gc check', model: 'm',
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:03:00.000Z', candidates,
  }, null, 2))
}

const runGc = (args, label) => {
  let code = 0
  let out = ''
  try {
    out = run(process.execPath, [tsxCli, join(root, 'src', 'gc.ts'), '--run-root', runs, ...args], { timeout: 120_000 })
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  console.log(`--- gc ${label ?? ''} (exit ${code}) ---`)
  return { code, out }
}

// ---------- build the sandbox: one run dir per classification ----------
// A1 — crashed-reconciled, clean orphan worktree c01.
const a1 = leaseWorktree('20260101000001', 'c01')
writeDispatch('20260101000001', [{ id: 'c01' }])
writeRecovery('20260101000001', [{ path: a1.wt, branch: a1.branch }])

// A2 — crashed-unreconciled: dispatch evidence only, NO recovery.json.
const a2 = leaseWorktree('20260101000002', 'c02')
writeDispatch('20260101000002', [{ id: 'c02' }])
mkdirSync(join(runs, '20260101000002'), { recursive: true })

// A3 — finished, the reproduced --clean leak: workspacePath:null candidates,
// retry leg on c03b, leaked branches pre-created in the repo, plus evidence.
const leakedIds = [['c03a', 1], ['c03b', 2]]
for (const [id, attempts] of leakedIds) {
  git('branch', `swarm/wt-${id}`, 'main')
  if (attempts === 2) git('branch', 'swarm/wt-c03b-a2', 'main')
}
git('branch', 'swarm/wt-ghost', 'main')
mkdirSync(join(runs, '20260101000003'), { recursive: true })
writeFinishedReport('20260101000003', [
  { id: 'c03a', workspacePath: null, attempts: [{ number: 1, state: 'succeeded' }] },
  { id: 'c03b', workspacePath: null, attempts: [{ number: 1, state: 'failed' }, { number: 2, state: 'succeeded' }] },
])
mkdirSync(join(runs, '20260101000003', 'c03a'), { recursive: true })
writeFileSync(join(runs, '20260101000003', 'c03a', 'worker.log'), 'worker log a\n')
writeFileSync(join(runs, '20260101000003', 'c03a', 'diff.patch'), 'diff --git a/file.txt b/file.txt\n')

// A4 — finished with a still-registered (not disposed in-run) worktree c04.
const a4 = leaseWorktree('20260101000004', 'c04')
writeFinishedReport('20260101000004', [{ id: 'c04', workspacePath: a4.wt, attempts: [{ number: 1, state: 'succeeded' }] }])

// A5 — crashed-reconciled with a DIRTY worktree c05 (GC takes no --force).
const a5 = leaseWorktree('20260101000005', 'c05', { dirty: true })
writeDispatch('20260101000005', [{ id: 'c05' }])
writeRecovery('20260101000005', [{ path: a5.wt, branch: a5.branch, dirty: true }])

// A6 — crashed-reconciled with a wt/int-c06 integration worktree (detached,
// dirty by construction — the src/integrate.ts shape) + a clean orphan c06b.
const a6int = leaseWorktree('20260101000006', 'int-c06', { detach: true, dirty: true })
const a6b = leaseWorktree('20260101000006', 'c06b')
writeDispatch('20260101000006', [{ id: 'c06b' }])
writeRecovery('20260101000006', [
  { path: a6int.wt, branch: null, dirty: true },
  { path: a6b.wt, branch: a6b.branch },
])

// hashTree: a stable digest of every file under a dir (the int-* survival pin).
const hashTree = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true })
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((d) => {
    const p = join(dir, d.name)
    return d.isDirectory() ? hashTree(p, `${prefix}${d.name}/`) : `${prefix}${d.name}:${sha256(p)}`
  })
  .join('\n')

// Evidence census for the never-deleted pin (E).
const evidencePaths = [
  join(runs, '20260101000001', 'dispatch.jsonl'), join(runs, '20260101000001', 'recovery.json'),
  join(runs, '20260101000002', 'dispatch.jsonl'),
  join(runs, '20260101000003', 'report.json'), join(runs, '20260101000003', 'c03a', 'worker.log'), join(runs, '20260101000003', 'c03a', 'diff.patch'),
  join(runs, '20260101000004', 'report.json'),
  join(runs, '20260101000005', 'dispatch.jsonl'), join(runs, '20260101000005', 'recovery.json'),
  join(runs, '20260101000006', 'dispatch.jsonl'), join(runs, '20260101000006', 'recovery.json'),
]
const evidenceBefore = Object.fromEntries(evidencePaths.map((p) => [p, sha256(p)]))
const intTreeBefore = hashTree(a6int.wt)

// ---------- --help documents the surface (incl. --force-lock parity) ----------
{
  let code = 0
  let out = ''
  try { out = run(process.execPath, [tsxCli, join(root, 'src', 'gc.ts'), '--help']) } catch (e) { code = e.status ?? -1; out = `${e.stdout ?? ''}${e.stderr ?? e.message}` }
  t('help: exit 0, documents --run-root, --force-lock parity, and no --force',
    code === 0 && out.includes('--run-root <path>') && out.includes('--force-lock') && out.includes('clean -- --run <id> --force'))
}

// ---------- pass A: the free-lock sweep over every classification ----------
const a = runGc([], 'pass A')
t('pass A: exits 1 — exactly one disposal item (the dirty c05) was refused', a.code === 1)
t('pass A: classification census — 6 run dirs, 1 crashed-unreconciled, 3 crashed-reconciled, 2 finished',
  a.out.includes('6 run dir(s)') && a.out.includes('1 crashed-unreconciled') && a.out.includes('3 crashed-reconciled') && a.out.includes('2 finished'))

// A1 — crashed-reconciled disposal through clean's semantics.
t('A1: classified crashed-reconciled', a.out.includes('class: crashed-reconciled'))
t('A1: the orphaned worktree was removed and its branch removed AFTER it (clean\'s order)',
  existsSync(join(runs, '20260101000001')) && a.out.includes(`removed worktree: ${a1.wt}`)
  && a.out.indexOf(`removed worktree: ${a1.wt}`) < a.out.indexOf('removed branch: swarm/wt-c01'))
t('A1: worktree gone, branch gone, no longer registered',
  !existsSync(a1.wt) && !swarmBranches().includes('swarm/wt-c01') && !git('worktree', 'list', '--porcelain').includes(a1.wt))

// A2 — crashed-unreconciled: report recover-first, remove nothing.
t('A2: classified crashed-unreconciled with the recover-first pointer',
  a.out.includes('crashed-unreconciled') && a.out.includes('npm run recover') && a.out.includes('nothing removed'))
t('A2: nothing removed — worktree, branch, and dispatch evidence intact',
  existsSync(a2.wt) && swarmBranches().includes('swarm/wt-c02') && git('worktree', 'list', '--porcelain').includes('wt-c02'))

// A3 — finished: the --clean leak swept, unowned branch kept.
t('A3: classified finished', a.out.includes('class: finished'))
t('A3: exactly the leaked branches were removed — c03a, c03b, and the retry leg c03b-a2',
  !swarmBranches().includes('swarm/wt-c03a') && !swarmBranches().includes('swarm/wt-c03b') && !swarmBranches().includes('swarm/wt-c03b-a2')
  && a.out.includes('removed branch: swarm/wt-c03a') && a.out.includes('removed branch: swarm/wt-c03b') && a.out.includes('removed branch: swarm/wt-c03b-a2'))
t('A3: the unowned swarm/wt-ghost is reported and never deleted',
  swarmBranches().includes('swarm/wt-ghost') && a.out.includes('unowned swarm/* branch') && a.out.includes('swarm/wt-ghost'))

// A4 — finished with a registered worktree: no disposal, branch kept.
t('A4: no worktree disposal — the registered c04 worktree and its branch survive',
  existsSync(a4.wt) && git('worktree', 'list', '--porcelain').includes('wt-c04') && swarmBranches().includes('swarm/wt-c04'))
t('A4: the sweep reports why — branch held by a registered worktree',
  a.out.includes('branch held by a registered worktree') && a.out.includes('swarm/wt-c04'))

// A5 — changed worktree with no stored evidence refused, per-item, with the
// clean --force pointer (T-048: the refusal names the un-captured changes and
// the missing diff.patch — the evidence-first posture).
t('A5: the changed, un-captured worktree is refused (GC takes no --force) with the per-item refusal',
  a.out.includes(`refused (worktree holds un-captured changes — stored diff.patch missing or unreadable; re-run with --force to discard): ${a5.wt}`))
t('A5: the refusal carries the clean --force pointer for the run',
  a.out.includes('gc never discards changes') && a.out.includes(`npm run clean -- --run 20260101000005 --force`))
t('A5: worktree + branch intact after the refusal',
  existsSync(a5.wt) && swarmBranches().includes('swarm/wt-c05') && git('worktree', 'list', '--porcelain').includes('wt-c05'))

// A6 — wt/int-* held, sibling orphan disposed.
t('A6: the wt/int-c06 integration worktree is reported held for human disposition',
  a.out.includes('held (wt/int-* integration-replay worktree') && a.out.includes('int-c06'))
t('A6: the int worktree survives byte-identical', hashTree(a6int.wt) === intTreeBefore)
t('A6: the sibling orphan c06b WAS disposed — worktree + branch gone',
  !existsSync(a6b.wt) && !swarmBranches().includes('swarm/wt-c06b'))

// E — evidence never deleted.
t('E: every evidence file is hash-identical across the pass',
  evidencePaths.every((p) => sha256(p) === evidenceBefore[p]))

// locks released on every path.
t('pass A: no residual lock files (the per-repo lock released in finally on every path)',
  lockFilesIn(join(runs, 'locks')).length === 0)

// ---------- resolve A5 the way gc's pointer says, then pass B ----------
{
  let code = 0
  try {
    run(process.execPath, [tsxCli, join(root, 'src', 'clean.ts'), '--run', '20260101000005', '--run-root', runs, '--force'])
  } catch (e) { code = e.status ?? -1 }
  t('A5 follow-up: the pointer\'s advice works — clean --run <id> --force disposes c05 (exit 0)', code === 0)
}

// B — a held checkout lock skips the run as live (the T-004 never-auto-reap policy).
const b1lease = leaseWorktree('20260101000007', 'c07')
writeDispatch('20260101000007', [{ id: 'c07' }])
writeRecovery('20260101000007', [{ path: b1lease.wt, branch: b1lease.branch }])
const locksDir = join(runs, 'locks')
run(process.execPath, [tsxCli, join(root, 'src', 'lock.ts'), 'acquire', repo, '--run-root', runs, '--run-id', 't020-gc'])
const holder = JSON.parse(read(join(locksDir, lockFilesIn(locksDir)[0])))
t('B: the lock file records the holder pid', Number.isInteger(holder.pid))
const c07DispatchHash = sha256(join(runs, '20260101000007', 'dispatch.jsonl'))

const b1 = runGc([], 'pass B (held lock)')
t('B: exits 0 — skipped-live is a healthy classification, not a failure', b1.code === 0)
t('B: the run is classified live and names the holder pid and lock path',
  b1.out.includes('class: live (checkout lock held)') && b1.out.includes(`pid ${holder.pid}`) && b1.out.includes('.lock'))
t('B: nothing was removed under the held lock — c07 worktree, branch, and evidence intact',
  existsSync(b1lease.wt) && swarmBranches().includes('swarm/wt-c07')
  && sha256(join(runs, '20260101000007', 'dispatch.jsonl')) === c07DispatchHash)

// the documented override: --force-lock proceeds, exactly clean's parity.
const b2 = runGc(['--force-lock'], 'pass B (--force-lock)')
t('B: --force-lock takes the lock and disposes c07 (parity with clean)',
  b2.code === 0 && !existsSync(b1lease.wt) && !swarmBranches().includes('swarm/wt-c07'))
t('B: the lock was released on the --force-lock path — no residual lock files',
  lockFilesIn(locksDir).length === 0)

// ---------- C (T-044): the sweep refuses a commit-carrying branch ----------
// A finished run owning a branch whose tip sits beyond the report's baseSha —
// the committing worker, worktree already gone (the --clean leak shape). The
// branch is attributable (report candidate c08), unregistered, and STILL
// never deleted: it carries commits, which are evidence.
const cLease = leaseWorktree('20260101000008', 'c08')
writeFileSync(join(cLease.wt, 'file.txt'), 'committed beyond base\n')
run('git', ['-C', cLease.wt, ...IDENTITY, 'add', '-A'])
run('git', ['-C', cLease.wt, ...IDENTITY, 'commit', '-m', 'worker commit'])
git('worktree', 'remove', '--force', cLease.wt) // the in-run dispose — branch left behind
writeFinishedReport('20260101000008', [{ id: 'c08', workspacePath: null, attempts: [{ number: 1, state: 'succeeded' }] }])
const C08_TIP = git('rev-parse', 'swarm/wt-c08').trim()
t('C setup: the branch carries a commit beyond the run base', C08_TIP !== BASE)

const c = runGc([], 'pass C (commit-carrying branch)')
t('C: exits 1 — the commit-carrying branch was refused', c.code === 1)
t('C: classification census — 8 run dirs, 1 crashed-unreconciled, 4 crashed-reconciled, 3 finished',
  c.out.includes('8 run dir(s)') && c.out.includes('1 crashed-unreconciled') && c.out.includes('4 crashed-reconciled') && c.out.includes('3 finished'))
t('C: the sweep REFUSES swarm/wt-c08 with the loud evidence line naming tip and base',
  c.out.includes('carries commits beyond baseSha') && c.out.includes('swarm/wt-c08')
  && c.out.includes(C08_TIP.slice(0, 12)) && c.out.includes(BASE.slice(0, 12)))
t('C: the branch — the only copy of the committed work — survives the sweep',
  swarmBranches().includes('swarm/wt-c08'))
t('C: no residual lock files after pass C', lockFilesIn(locksDir).length === 0)

// ---------- D (T-048): the evidence-parity predicate rides gc's lane ----------
// Both legs, crashed-reconciled (the only gc class that disposes worktrees):
// a worktree whose changes were captured before the crash — evidence written
// exactly where the runner writes it, with the engine's own capture form —
// is disposed by the no---force gc pass; the same shape plus a post-capture
// edit is refused per-item. No report.json, so the parity comparison runs
// against the worktree's HEAD (identical bytes to the base-diff capture on
// a non-committing lease — HEAD === baseSha).
const captureInto = (lease, runId, id) => {
  run('git', ['-C', lease.wt, 'add', '-A', '--intent-to-add', '.'])
  const diff = run('git', ['-C', lease.wt, 'diff', BASE, '--binary'])
  mkdirSync(join(runs, runId, id), { recursive: true })
  writeFileSync(join(runs, runId, id, 'diff.patch'), diff)
  return diff
}
const d1 = leaseWorktree('20260101000009', 'c09')
writeFileSync(join(d1.wt, 'file.txt'), 'captured before the crash\n')
writeFileSync(join(d1.wt, 'extra-d1.txt'), 'new file, captured\n')
const d1Diff = captureInto(d1, '20260101000009', 'c09')
writeDispatch('20260101000009', [{ id: 'c09' }])
writeRecovery('20260101000009', [{ path: d1.wt, branch: d1.branch }])
t('D setup: the crashed-run capture is a real diff covering both changes',
  d1Diff.includes('captured before the crash') && d1Diff.includes('extra-d1.txt'))

const d2 = leaseWorktree('20260101000010', 'c10')
writeFileSync(join(d2.wt, 'file.txt'), 'captured, then edited after\n')
captureInto(d2, '20260101000010', 'c10')
writeFileSync(join(d2.wt, 'file.txt'), 'captured, then edited after\nplus a post-capture line\n') // AFTER the capture
writeDispatch('20260101000010', [{ id: 'c10' }])
writeRecovery('20260101000010', [{ path: d2.wt, branch: d2.branch }])

const d = runGc([], 'pass D (T-048 evidence parity)')
t('D: exits 1 — the post-capture-edit worktree was refused', d.code === 1)
t('D: classification census — 10 run dirs, 1 crashed-unreconciled, 6 crashed-reconciled, 3 finished',
  d.out.includes('10 run dir(s)') && d.out.includes('1 crashed-unreconciled') && d.out.includes('6 crashed-reconciled') && d.out.includes('3 finished'))
t('D leg 1: the captured-before-crash worktree was DISPOSED by the no---force gc pass, branch and all',
  !existsSync(d1.wt) && !swarmBranches().includes('swarm/wt-c09')
  && d.out.includes(`removed worktree: ${d1.wt}`) && d.out.includes('removed branch: swarm/wt-c09'))
t('D leg 2: the post-capture edit is refused per-item with the evidence-parity line',
  d.out.includes(`refused (worktree differs from its captured evidence — post-capture changes; re-run with --force to discard): ${d2.wt}`))
t('D leg 2: worktree + branch + evidence survive the refusal',
  existsSync(d2.wt) && swarmBranches().includes('swarm/wt-c10')
  && existsSync(join(runs, '20260101000010', 'c10', 'diff.patch')))
t('D: the refusal pointer still names the clean --force path', d.out.includes('gc never discards changes'))
t('D: no residual lock files after pass D', lockFilesIn(locksDir).length === 0)

// end state: exactly what GC must leave for a human remains.
t('end state: exactly the deliberately-kept worktrees remain — main, the unreconciled c02, the kept c04, the held int-c06, the refused c10',
  worktreeCount() === 5 && git('worktree', 'list', '--porcelain').includes('wt-c02')
  && git('worktree', 'list', '--porcelain').includes('wt-c04') && git('worktree', 'list', '--porcelain').includes('int-c06')
  && git('worktree', 'list', '--porcelain').includes('wt-c10'))
t('end state: exactly the deliberately-kept branches remain — c02 (unreconciled), c04 (registered), c08 (carries commits — evidence), c10 (post-capture changes — evidence parity refusal), ghost (unowned)',
  swarmBranches() === 'swarm/wt-c02,swarm/wt-c04,swarm/wt-c08,swarm/wt-c10,swarm/wt-ghost')

rmSync(sandbox, { recursive: true, force: true })
