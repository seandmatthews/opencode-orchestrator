// Clean's evidence-parity predicate self-check (Gate 1.34, fast tier, T-048) —
// run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-clean-evidence.mjs
// Zero model tokens. The 2026-10-23 scratch-repo repro re-run, pinned: the
// capture (`WorktreeProvider.diff` — `git add -A --intent-to-add .` + the
// T-044 diff) leaves porcelain permanently dirty (` M build.js` /
// `A notes-new-file.md`), so the old predicate — refuse any non-empty
// porcelain — refused exactly the worktrees worth cleaning and taught the
// operator to always pass --force. The new predicate (src/disposal.ts):
// a worktree is removable without --force iff its current state matches the
// captured evidence — re-run the capture form, byte-compare against the
// stored final-attempt diff.patch — or holds nothing at all. Legs:
//   P0  geometry export: evidenceDiffPath maps lease-shaped worktree paths
//       to the runner's evidence layout (attempt 1 `<runDir>/<id>/
//       diff.patch`, attempt n≥2 `<runDir>/<id>/attempt-<n>/diff.patch`),
//       null off the `wt/` convention (namespace import, so the pre-change
//       red bar is behavioral, not a module-link crash).
//   P1  captured-green (the red-bar face): a worktree whose changes were
//       fully captured by diff() — porcelain provably dirty — is removed by
//       plain `clean --run` (no --force), branch and all, evidence kept.
//   P2  protection intact, both legs: the same setup plus a post-capture
//       append is REFUSED without --force (loud line: differs from its
//       captured evidence — post-capture changes), worktree + branch +
//       evidence survive; `--force` still discards (exit 0, all gone).
//   P3  missing-evidence refusal: a worktree whose run dir holds no stored
//       diff.patch (the crashed-pre-capture shape) is refused — changes
//       with no evidence holding them are un-captured by definition.
//   P4  both-empty leg: a no-op candidate (empty stored patch, tree at
//       base) cleans without --force — "equal (or both empty) ⇒ captured".
//   P5  line-ending stability (Known issue #5's CRLF class): the whole
//       captured-then-cleaned cycle on a repo with core.autocrlf=true —
//       baseline and worker bytes CRLF-shaped on disk, provably — no false
//       refusal (byte-comparison is stable when the same capture form runs
//       twice under the same config).
//   P6  retry-leg geometry: the attempt-2 lease `wt/<id>-a2` finds its
//       evidence at `<runDir>/<id>/attempt-2/diff.patch` and cleans green.
// The gc lane (the same predicate riding shared disposeTargets) is pinned
// by check-gc.mjs's pass D, both legs (Gate 1.18).
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorktreeProvider } from '../src/workspace/worktree.ts'
import * as disposal from '../src/disposal.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = 'C:/swarm/verify-t048'
const repo = join(sandbox, 'repo')
const crlfRepo = join(sandbox, 'repo-crlf')
const runs = join(sandbox, 'runs')
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const IDENTITY = ['-c', 'user.name=check-t048', '-c', 'user.email=t048@local']

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
const git = (...args) => run('git', ['-C', repo, ...args])
const branchExists = (b) => git('branch', '--list', b).trim() !== ''

rmSync(sandbox, { recursive: true, force: true })
for (const d of [repo, crlfRepo, runs]) mkdirSync(d, { recursive: true })

function initRepo(r, extra) {
  run('git', ['-C', r, 'init', '-b', 'main'])
  if (extra) run('git', ['-C', r, ...extra])
  writeFileSync(join(r, 'build.js'), 'function build() { return 1 }\nmodule.exports = { build }\n')
  writeFileSync(join(r, 'file.txt'), 'baseline\n')
  writeFileSync(join(r, 'asset.bin'), Buffer.from([0x00, 0xff, 0x01, 0x02, 0x03]))
  run('git', ['-C', r, ...IDENTITY, 'add', '-A'])
  run('git', ['-C', r, ...IDENTITY, 'commit', '-m', 'baseline'])
  return run('git', ['-C', r, 'rev-parse', 'HEAD']).trim()
}

const BASE = initRepo(repo)
// The CRLF-shaped repo (P5): autocrlf active from the first commit, so every
// checkout — including leased worktrees — carries CRLF bytes on disk.
const CRLF_BASE = initRepo(crlfRepo, ['config', 'core.autocrlf', 'true'])

// ---------- fixture helpers: lease + capture + evidence exactly like the runner ----------
/** One candidate's world the way src/runner.ts leaves it: a lease at the run
 *  base, worker edits, the capture through the REAL WorktreeProvider.diff,
 *  evidence written at the runner's own geometry (`<runDir>/<id>/diff.patch`
 *  for attempt 1, `<runDir>/<id>/attempt-<n>/diff.patch` for retry legs),
 *  and a report.json carrying repo/baseSha/candidates (the clean contract). */
function makeCandidate(runId, id, { edits, capture = true, postCapture = null, leaseId = null, repoDir = repo, base = BASE }) {
  const runDir = join(runs, runId)
  const provider = new WorktreeProvider(repoDir, runDir)
  const lease = provider.lease(leaseId ?? `wt/${id}`, base)
  edits(lease.path)
  // The runner's evidence geometry (src/runner.ts): attempt 1 writes
  // <runDir>/<id>/diff.patch, attempt n ≥ 2 <runDir>/<id>/attempt-<n>/diff.patch.
  const attempt = leaseId?.match(/-a(\d+)$/) ?? null
  const evidencePath = attempt
    ? join(runDir, id, `attempt-${attempt[1]}`, 'diff.patch')
    : join(runDir, id, 'diff.patch')
  let diff = null
  if (capture) {
    diff = provider.diff(lease) // the engine's capture form: add -A --intent-to-add . + git diff <baseSha> --binary
    mkdirSync(dirname(evidencePath), { recursive: true })
    writeFileSync(evidencePath, diff)
  }
  if (postCapture) postCapture(lease.path)
  writeFileSync(join(runDir, 'report.json'), JSON.stringify({
    runId, repo: repoDir, baseSha: base, goal: 't048 evidence-parity check', model: 'm',
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z',
    candidates: [{ id, workspacePath: lease.path, diffPath: capture ? evidencePath : null }],
  }, null, 2))
  return { runDir, lease, diff }
}

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

// ---------- P0: the geometry export (the evidence-path mapping) ----------
t('P0: evidenceDiffPath is exported from src/disposal.ts',
  typeof disposal.evidenceDiffPath === 'function')
if (typeof disposal.evidenceDiffPath === 'function') {
  const ep = disposal.evidenceDiffPath
  t('P0: attempt-1 lease wt/<id> maps to <runDir>/<id>/diff.patch',
    ep('C:/x/runs/20260101000001/wt/c01') === 'C:/x/runs/20260101000001/c01/diff.patch'.replaceAll('/', '\\'))
  t('P0: retry lease wt/<id>-a2 maps to <runDir>/<id>/attempt-2/diff.patch',
    ep('C:/x/runs/20260101000001/wt/c01-a2') === 'C:/x/runs/20260101000001/c01/attempt-2/diff.patch'.replaceAll('/', '\\'))
  t('P0: a path off the wt/ convention maps to null (no evidence geometry)',
    ep('C:/x/some/other/shape/c01') === null)
} else {
  t('P0: attempt-1 lease maps to <runDir>/<id>/diff.patch', false)
  t('P0: retry lease maps to <runDir>/<id>/attempt-<n>/diff.patch', false)
  t('P0: off-convention path maps to null', false)
}

// ---------- P1: captured-green — the 2026-10-23 repro, post-fix ----------
const p1 = makeCandidate('20260101000021', 'p1', {
  edits: (wt) => {
    writeFileSync(join(wt, 'build.js'), 'function build() { return 2 }\nmodule.exports = { build }\n') // tracked edit
    writeFileSync(join(wt, 'notes-new-file.md'), 'worker notes\n')                                     // untracked new (ITA-captured)
    writeFileSync(join(wt, 'asset.bin'), Buffer.from([0x00, 0xff, 0xaa, 0xbb, 0xcc]))                 // binary edit
  },
})
const p1Porcelain = run('git', ['-C', p1.lease.path, 'status', '--porcelain'])
t('P1 premise: post-capture porcelain is non-empty and shows the repro shape (M build.js / A notes-new-file.md)',
  p1Porcelain.trim() !== '' && p1Porcelain.includes('build.js') && p1Porcelain.includes('notes-new-file.md'))
t('P1 premise: the stored diff.patch is a real capture (non-empty, carries all three change kinds)',
  p1.diff !== null && p1.diff.includes('return 2') && p1.diff.includes('notes-new-file.md') && p1.diff.includes('GIT binary patch'))
const p1a = runClean(['--run', '20260101000021', '--run-root', runs], 'P1 plain (captured)')
t('P1: a fully-captured worktree is removed by PLAIN clean (no --force) — exit 0',
  p1a.code === 0 && !existsSync(p1.lease.path) && p1a.out.includes(`removed worktree: ${p1.lease.path}`))
t('P1: its swarm/* branch went with it', !branchExists('swarm/wt-p1') && p1a.out.includes('removed branch: swarm/wt-p1'))
t('P1: evidence survives — report.json and the stored diff.patch are never deleted',
  existsSync(join(p1.runDir, 'report.json')) && existsSync(join(p1.runDir, 'p1', 'diff.patch')))

// ---------- P2: protection intact — post-capture change, both legs ----------
const p2 = makeCandidate('20260101000022', 'p2', {
  edits: (wt) => {
    writeFileSync(join(wt, 'build.js'), 'function build() { return 3 }\nmodule.exports = { build }\n')
  },
  postCapture: (wt) => {
    appendFileSync(join(wt, 'build.js'), '// post-capture stray line\n') // AFTER diff() ran
  },
})
const p2a = runClean(['--run', '20260101000022', '--run-root', runs], 'P2 plain (post-capture edit)')
t('P2: the post-capture edit is REFUSED without --force — exit 1',
  p2a.code === 1 && p2a.out.includes(`refused`) && p2a.out.includes(p2.lease.path))
t('P2: the refusal names the reason — differs from its captured evidence, post-capture changes, --force bypass',
  p2a.out.includes('differs from its captured evidence') && p2a.out.includes('post-capture changes') && p2a.out.includes('--force'))
t('P2: worktree + branch + evidence all survive the refusal',
  existsSync(p2.lease.path) && branchExists('swarm/wt-p2') && existsSync(join(p2.runDir, 'p2', 'diff.patch')))
const p2b = runClean(['--run', '20260101000022', '--run-root', runs, '--force'], 'P2 force')
t('P2: --force still discards — exit 0, worktree and branch gone, evidence kept',
  p2b.code === 0 && !existsSync(p2.lease.path) && !branchExists('swarm/wt-p2')
  && existsSync(join(p2.runDir, 'p2', 'diff.patch')) && existsSync(join(p2.runDir, 'report.json')))

// ---------- P3: missing-evidence refusal (evidence-first posture) ----------
const p3 = makeCandidate('20260101000023', 'p3', {
  capture: false, // the crashed-pre-capture shape: worker edits, no stored diff.patch anywhere
  edits: (wt) => {
    writeFileSync(join(wt, 'build.js'), 'function build() { return 4 }\nmodule.exports = { build }\n')
    writeFileSync(join(wt, 'untracked.txt'), 'never captured\n')
  },
})
t('P3 premise: no diff.patch exists anywhere in the run dir',
  !existsSync(join(p3.runDir, 'p3', 'diff.patch')))
const p3a = runClean(['--run', '20260101000023', '--run-root', runs], 'P3 plain (no stored evidence)')
t('P3: a changed worktree with no stored diff.patch is REFUSED — exit 1',
  p3a.code === 1 && p3a.out.includes('refused') && p3a.out.includes(p3.lease.path))
t('P3: the refusal says the changes are un-captured and names the missing evidence + the --force bypass',
  p3a.out.includes('un-captured changes') && p3a.out.includes('diff.patch') && p3a.out.includes('--force'))
t('P3: worktree + branch survive (nothing was discarded on a guess)',
  existsSync(p3.lease.path) && branchExists('swarm/wt-p3'))

// ---------- P4: both-empty — the honest no-op candidate cleans green ----------
const p4 = makeCandidate('20260101000024', 'p4', {
  edits: () => {}, // no-op worker: empty capture, empty tree
})
t('P4 premise: the stored patch is empty and the tree sits at base (the both-empty shape)',
  p4.diff === '' && run('git', ['-C', p4.lease.path, 'diff', BASE]).trim() === '')
const p4a = runClean(['--run', '20260101000024', '--run-root', runs], 'P4 plain (both empty)')
t('P4: a no-op candidate (empty stored patch, tree at base) cleans without --force — exit 0',
  p4a.code === 0 && !existsSync(p4.lease.path) && !branchExists('swarm/wt-p4'))

// ---------- P5: line-ending stability — the CRLF-shaped cycle, autocrlf active ----------
const p5 = makeCandidate('20260101000025', 'p5', {
  repoDir: crlfRepo, base: CRLF_BASE,
  edits: (wt) => {
    writeFileSync(join(wt, 'build.js'), 'function build() { return 5 }\r\nmodule.exports = { build }\r\n')
    writeFileSync(join(wt, 'crlf-notes.md'), 'crlf worker notes\r\n')
  },
})
t('P5 premise: autocrlf is active and the worktree holds CRLF bytes on disk (Known issue #5 class)',
  run('git', ['-C', crlfRepo, 'config', 'core.autocrlf']).trim() === 'true'
  && readFileSync(join(p5.lease.path, 'file.txt'), 'utf8').includes('\r\n'))
t('P5 premise: the CRLF-shaped capture is a real diff (non-empty)',
  p5.diff !== null && p5.diff.includes('return 5') && p5.diff.includes('crlf-notes.md'))
const p5a = runClean(['--run', '20260101000025', '--run-root', runs], 'P5 plain (CRLF cycle)')
t('P5: the captured-then-cleaned cycle under autocrlf does NOT false-refuse — exit 0, disposed with branch',
  p5a.code === 0 && !existsSync(p5.lease.path)
  && !run('git', ['-C', crlfRepo, 'branch', '--list', 'swarm/wt-p5']).trim())
t('P5: the CRLF evidence survives', existsSync(join(p5.runDir, 'p5', 'diff.patch')))

// ---------- P6: retry-leg geometry — the attempt-2 lease finds its attempt-2 evidence ----------
const p6 = makeCandidate('20260101000026', 'p6', {
  leaseId: 'wt/p6-a2', // the runner's attempt-2 lease shape (src/runner.ts: wt/<id>-a<n>)
  edits: (wt) => {
    writeFileSync(join(wt, 'build.js'), 'function build() { return 6 }\nmodule.exports = { build }\n')
  },
})
t('P6 premise: the retry evidence sits at <runDir>/p6/attempt-2/diff.patch and is a real capture',
  existsSync(join(p6.runDir, 'p6', 'attempt-2', 'diff.patch')) && p6.diff.includes('return 6'))
const p6a = runClean(['--run', '20260101000026', '--run-root', runs], 'P6 plain (retry leg)')
t('P6: the attempt-2 lease cleans green against its attempt-2 evidence — exit 0, worktree + branch gone',
  p6a.code === 0 && !existsSync(p6.lease.path)
  && !run('git', ['-C', repo, 'branch', '--list', 'swarm/wt-p6-a2']).trim())

rmSync(sandbox, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\ncheck-clean-evidence: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-clean-evidence: ALL GREEN')
