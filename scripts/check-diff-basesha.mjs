// Evidence-destruction guard self-check (Gate 1.30, fast tier, T-044) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-diff-basesha.mjs
// Zero model tokens. One scratch repo + the REAL WorktreeProvider and the REAL
// removeBranch/clean, pinning both halves of the ticket against the exact
// destruction chain it names (worker commits → diff HEAD reads empty → NO-OP
// mislabel → clean tree sidesteps the dirty-refusal → worktree removed →
// branch -D shreds the only copy):
//   C1  capture: a simulated committing worker (`git commit` inside the
//       lease) — diff() returns the committed work (non-empty, contains the
//       commit's change), so the ladder's `diffBytes > 0`
//       (src/runner.ts:1201) sees real work and the candidate is never
//       mislabeled a no-op (src/store/index.ts:1433's mapping).
//   C2  guard: removeBranch REFUSES `git branch -D` on a branch whose tip !=
//       the run's baseSha, with the loud evidence line naming branch, tip,
//       and base; --force still removes it.
//   C3  true no-op preserved: commit-then-revert (tree back at base, HEAD
//       beyond it) captures an EMPTY diff — NO-OP keeps its honest semantics
//       ("no change relative to the pinned base"), and the ladder still
//       records the NO-OP verdict for an all-pass gate set.
//   C4  inertness: on a non-committing worktree (HEAD === baseSha) the new
//       `git diff <baseSha>` capture is byte-identical to the old
//       `git diff HEAD` form, compared on one identical tree (text edit +
//       untracked new file + binary edit) — structurally inert for every
//       honest worker (the T-026 intent-to-add/--binary posture rides
//       unchanged).
//   C5  clean plumbing: a report-driven `npm run clean` (baseSha plumbed
//       through disposal's RunReportLike/readReport) refuses the
//       commit-carrying branch (exit 1, loud line, branch survives, the now-
//       clean worktree still disposed) while the at-base sibling branch is
//       removed un-refused; `--force` finishes the job.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorktreeProvider } from '../src/workspace/worktree.ts'
import { removeBranch } from '../src/disposal.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-t044'
const repo = join(sandbox, 'repo')
const runs = join(sandbox, 'runs')
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const IDENTITY = ['-c', 'user.name=check-t044', '-c', 'user.email=t044@local']

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
const git = (...args) => run('git', ['-C', repo, ...args])
const branchExists = (b) => git('branch', '--list', b).trim() !== ''

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(repo, { recursive: true })
mkdirSync(runs, { recursive: true })
git('init', '-b', 'main')
writeFileSync(join(repo, 'file.txt'), 'baseline\n')
writeFileSync(join(repo, 'other.txt'), 'unrelated\n')
writeFileSync(join(repo, 'asset.bin'), Buffer.from([0x00, 0xff, 0x01, 0x02, 0x03]))
git(...IDENTITY, 'add', '-A')
git(...IDENTITY, 'commit', '-m', 'baseline')
const BASE = git('rev-parse', 'HEAD').trim()

// The ladder expression verbatim (src/runner.ts:1201): what a candidate's
// verdict is from its gate set + captured diff bytes.
const ladder = (gates, diffBytes) => gates.length > 0 && gates.every((g) => g.passed) && diffBytes > 0
const ALL_PASS = [{ name: 'build', passed: true }]

// ---------- C1 + C2: the committing worker, capture then guard ----------
const runDir1 = join(runs, '20260101000010')
const provider = new WorktreeProvider(repo, runDir1)
const lease = provider.lease('wt/c01', BASE)
t('C1 setup: the lease worktree HEAD === baseSha and the branch tip === baseSha',
  run('git', ['-C', lease.path, 'rev-parse', 'HEAD']).trim() === BASE
  && git('rev-parse', 'swarm/wt-c01').trim() === BASE)

// The simulated committing worker: edits + commits inside the lease, exactly
// the prompt-rule violation (src/runner.ts:173) the ticket says is coming.
writeFileSync(join(lease.path, 'file.txt'), 'baseline\ncommitted-by-worker\n')
run('git', ['-C', lease.path, ...IDENTITY, 'add', '-A'])
run('git', ['-C', lease.path, ...IDENTITY, 'commit', '-m', 'worker committed despite the prompt rule'])
const WORKER_TIP = git('rev-parse', 'swarm/wt-c01').trim()
t('C1 setup: the worker commit moved the branch tip beyond baseSha', WORKER_TIP !== BASE)

const committedDiff = provider.diff(lease)
const committedBytes = Buffer.byteLength(committedDiff)
t('C1: diff() returns the committed work — non-empty and containing the commit\'s change',
  committedBytes > 0 && committedDiff.includes('committed-by-worker'))
t('C1: the ladder sees diffBytes > 0 — an all-pass gate set survives, no NO-OP mislabel',
  ladder(ALL_PASS, committedBytes) === true)

// The guard. The worktree reads clean (tree === HEAD), so disposal's
// dirty-refusal cannot fire — removeBranch is the only thing between the
// commit and `git branch -D`. Capture console.error to pin the loud line.
provider.dispose(lease)
t('C2 setup: the committed worktree reads clean, so the dirty-refusal cannot fire',
  !existsSync(lease.path))
const res = { removed: 0, refused: 0, failed: 0 }
const stderrLines = []
const origErr = console.error
console.error = (...a) => { stderrLines.push(a.join(' ')) }
try {
  removeBranch(repo, 'swarm/wt-c01', res, { expectedBaseSha: BASE })
} finally {
  console.error = origErr
}
const loudLine = stderrLines.join('\n')
t('C2: removeBranch REFUSES the commit-carrying branch (refused++, removed stays 0, branch survives)',
  res.refused === 1 && res.removed === 0 && branchExists('swarm/wt-c01'))
t('C2: the refusal is the loud evidence line — names branch, tip, base, and the --force bypass',
  loudLine.includes('swarm/wt-c01') && loudLine.includes(WORKER_TIP.slice(0, 12)) && loudLine.includes(BASE.slice(0, 12))
  && loudLine.includes('carries commits beyond baseSha') && loudLine.includes('evidence')
  && loudLine.includes('--force'))
const resForce = { removed: 0, refused: 0, failed: 0 }
removeBranch(repo, 'swarm/wt-c01', resForce, { expectedBaseSha: BASE, force: true })
t('C2: --force still removes it (the explicit human override, the dirty-refusal posture)',
  resForce.removed === 1 && resForce.refused === 0 && !branchExists('swarm/wt-c01'))

// ---------- C3: true no-op — commit-then-revert captures an empty diff ----------
const lease2 = provider.lease('wt/c02', BASE)
writeFileSync(join(lease2.path, 'file.txt'), 'baseline\ntransient\n')
run('git', ['-C', lease2.path, ...IDENTITY, 'add', '-A'])
run('git', ['-C', lease2.path, ...IDENTITY, 'commit', '-m', 'transient'])
writeFileSync(join(lease2.path, 'file.txt'), 'baseline\n')
run('git', ['-C', lease2.path, ...IDENTITY, 'add', '-A'])
run('git', ['-C', lease2.path, ...IDENTITY, 'commit', '-m', 'revert to base content'])
t('C3 setup: HEAD is two commits beyond base but the tree is back at base content',
  run('git', ['-C', lease2.path, 'rev-parse', 'HEAD']).trim() !== BASE)
const noopDiff = provider.diff(lease2)
t('C3: a worktree returned exactly to base captures an EMPTY diff (honest NO-OP semantics)',
  noopDiff === '')
t('C3: the ladder still records the NO-OP verdict for an all-pass gate set',
  ladder(ALL_PASS, Buffer.byteLength(noopDiff)) === false)
provider.dispose(lease2)

// ---------- C4: inertness — new capture ≡ old capture, byte-for-byte ----------
const lease3 = provider.lease('wt/c03', BASE)
writeFileSync(join(lease3.path, 'file.txt'), 'baseline\nuncommitted edit\n')          // tracked edit
writeFileSync(join(lease3.path, 'new-file.txt'), 'untracked, intent-to-add captured\n') // untracked new
writeFileSync(join(lease3.path, 'asset.bin'), Buffer.from([0x00, 0xff, 0xaa, 0xbb, 0xcc])) // binary edit
const engineDiff = provider.diff(lease3) // the new form: git diff <baseSha> --binary
// The old form, captured on the SAME tree (the engine's add -A --intent-to-add
// already ran; re-running it is idempotent): git diff HEAD --binary.
run('git', ['-C', lease3.path, 'add', '-A', '--intent-to-add', '.'])
const oldFormDiff = run('git', ['-C', lease3.path, 'diff', 'HEAD', '--binary'])
t('C4 setup: the inertness tree produces a non-trivial diff (text + new file + binary hunks)',
  engineDiff.includes('uncommitted edit') && engineDiff.includes('new-file.txt') && engineDiff.includes('GIT binary patch'))
t('C4: non-committing worktree — new `git diff <baseSha>` capture is byte-identical to the old `git diff HEAD` form',
  engineDiff === oldFormDiff)
provider.dispose(lease3)

// ---------- C5: the clean CLI rides the guard through the report plumbing ----------
const runDir5 = join(runs, '20260101000011')
const provider5 = new WorktreeProvider(repo, runDir5)
const k1 = provider5.lease('wt/k1', BASE) // the committing worker's worktree (clean tree)
writeFileSync(join(k1.path, 'other.txt'), 'unrelated\ncommitted-by-worker\n')
run('git', ['-C', k1.path, ...IDENTITY, 'add', '-A'])
run('git', ['-C', k1.path, ...IDENTITY, 'commit', '-m', 'the only copy of the work'])
const k2 = provider5.lease('wt/k2', BASE) // honest non-committing worker, tree at base
const K1_TIP = git('rev-parse', 'swarm/wt-k1').trim() // read before clean can touch it
writeFileSync(join(runDir5, 'report.json'), JSON.stringify({
  runId: '20260101000011', repo, baseSha: BASE, goal: 't044 clean plumbing', model: 'm',
  startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z',
  candidates: [
    { id: 'k1', workspacePath: k1.path },
    { id: 'k2', workspacePath: k2.path },
  ],
}, null, 2))

const runClean = (args, label) => {
  let code = 0
  let out = ''
  try {
    out = run(process.execPath, [tsxCli, join(root, 'src', 'clean.ts'), ...args], { timeout: 120_000 })
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}${e.stderr ?? e.message}`
  }
  console.log(`--- clean ${label} (exit ${code}) ---`)
  return { code, out }
}
const c5a = runClean(['--run', '20260101000011', '--run-root', runs], 'plain (guard leg)')
t('C5: clean exits 1 — the commit-carrying branch was refused', c5a.code === 1)
t('C5: the refusal is the loud evidence line naming the branch and both SHAs',
  c5a.out.includes('swarm/wt-k1') && c5a.out.includes(K1_TIP.slice(0, 12)) && c5a.out.includes(BASE.slice(0, 12))
  && c5a.out.includes('carries commits beyond baseSha'))
t('C5: the commit — the only copy of the work — survives on its branch', branchExists('swarm/wt-k1'))
t('C5: the now-clean committed worktree was still disposed (the guard is the branch, not the tree)',
  !existsSync(k1.path) && c5a.out.includes(`removed worktree: ${k1.path}`))
t('C5: per-item results — the at-base sibling branch was removed un-refused in the same pass',
  c5a.out.includes('removed branch: swarm/wt-k2') && !branchExists('swarm/wt-k2'))
t('C5: the tallies read exactly one refusal and zero failures', /1 refused, 0 failed/.test(c5a.out))
const c5b = runClean(['--run', '20260101000011', '--run-root', runs, '--force'], 'force')
t('C5: --force finishes the job — the branch goes, exit 0',
  c5b.code === 0 && !branchExists('swarm/wt-k1') && c5b.out.includes('removed branch: swarm/wt-k1'))

rmSync(sandbox, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\ncheck-diff-basesha: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-diff-basesha: ALL GREEN')
