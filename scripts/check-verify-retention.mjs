// Verify-root retention self-check (Gate 1.41, fast tier, T-055) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-verify-retention.mjs
// Token-free, deterministic, no git, no opencode binary, no model IDs. Pins
// the T-055 contract: the full tier's reset used to open Gate 2 with
// `rmSync(verifyRoot, { recursive: true, force: true })` — every full-tier
// invocation permanently destroyed every prior Gate 2 run dir under
// C:/swarm/verify, un-citing the repo's cite-the-artifacts evidence behind
// its back (the recorded incident: run 20261024021432, cited by name in
// VERIFICATION.md Known issue #6's 2026-10-24 observation, was wiped from
// disk before T-049 could read its worker.logs — see T-049's Landed). Now
// the reset drives the exported helper (scripts/verify-retention.mjs):
// every existing `^\d{14}$` run DIRECTORY under the live root moves to
// C:/swarm/verify-archive/<runId>/ (plain same-drive rename, bytes never
// rewritten), then the archive keeps only the most recent ARCHIVE_KEEP_RUNS
// (10) archived runs and deletes older ones — bounded disk, evidence with a
// grace period instead of none. Everything non-timestamped is never moved
// or deleted: a timestamped FILE is a stray, not a run dir, and `locks/`
// (T-004's checkout-lock home, <run-root>\locks\<hash>.lock, src/lock.ts:42)
// now survives the reset where the old wipe destroyed it.
//
//   R   the recorded red bar, reproduced (AGENTS.md #8): the pre-T-055
//       reset against a fixture live root holding two run dirs wipes both
//       with NOTHING archived — asserted as the destruction the green
//       faces replace. This face runs identically pre/post change.
//   G   retention through the helper: both fixture run dirs land under the
//       archive root with their marker bytes byte-identical, the live root
//       holds zero run dirs, the most recent ARCHIVE_KEEP_RUNS are kept
//       while older archives are deleted (the DEFAULT bound pinned exactly;
//       the `keep` parameter pinned at 2); the returned moved/deleted lists
//       are honest.
//   L   the updated full-tier assertion's predicate (`listRunDirs` length,
//       the exact code scripts/verify.mjs's Gate 2 assertion now uses):
//       passes with an archived-history root (one live run dir, twelve
//       archived), and stays exact (0 -> not one, 2 -> not one).
//   S   non-timestamped safety: `locks/`, `verify-red/`, a stray file, and
//       a timestamped FILE are never moved or deleted by the helper (the
//       file stays in the live root, not the archive); the archive-side
//       prune never touches a non-timestamped entry planted in the archive
//       root; a nonexistent live root is a no-throw no-op.
//   H   the check never touches the real C:/swarm/verify: its run-dir
//       snapshot is identical before and after (the fixture sandbox is
//       C:/swarm/verify-retention, removed afterward).
//
// R and H run on plain node:fs so they execute even on a tree without the
// T-055 helper; G/L/S drive the helper and report themselves as the
// recorded red bar when it is absent (pre-change main — the T-052
// seam-absence pattern).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const failures = []
let assertions = 0
const t = (name, cond) => {
  assertions++
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const sandbox = 'C:/swarm/verify-retention'
const REAL_VERIFY_ROOT = 'C:/swarm/verify'
const RUN_DIR_RE = /^\d{14}$/

// Local (helper-independent) run-dir listing for the R and H faces — the
// G/L/S faces pin the helper's own listRunDirs instead.
const localRunDirs = (root) => {
  if (!existsSync(root)) return []
  return readdirSync(root).filter((d) => RUN_DIR_RE.test(d) && statSync(join(root, d)).isDirectory()).sort()
}

const writeRunDir = (root, name, marker) => {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'report.json'), `{"marker":"${marker}"}\n`)
}

async function main() {
  rmSync(sandbox, { recursive: true, force: true })
  mkdirSync(sandbox, { recursive: true })

  // H runs both before and after the fixtures: the check must leave the
  // real verify root exactly as it found it.
  const realBefore = existsSync(REAL_VERIFY_ROOT) ? localRunDirs(REAL_VERIFY_ROOT).join(',') : '<absent>'

  // ---------- R — the recorded red bar: the OLD behavior, reproduced ----------
  {
    const live = join(sandbox, 'red', 'live')
    const archiveWouldBe = join(sandbox, 'red', 'archive')
    writeRunDir(live, '20260101000000', 'R-ONE')
    writeRunDir(live, '20260102000000', 'R-TWO')

    // The pre-T-055 full-tier reset, reproduced verbatim (scripts/verify.mjs
    // on main: `rmSync(verifyRoot, { recursive: true, force: true })`).
    rmSync(live, { recursive: true, force: true })

    t('R1: the old reset wipes the live root entirely (both fixture run dirs gone)', existsSync(live) === false)
    t('R2: the old reset archives NOTHING (no archive root comes into existence)', existsSync(archiveWouldBe) === false)
    t('R3: the wiped evidence is unrecoverable from disk (no run-dir entries survive anywhere in the sandbox)',
      (!existsSync(join(sandbox, 'red')) || localRunDirs(join(sandbox, 'red')).length === 0)
        && !existsSync(join(sandbox, 'red', 'live', '20260101000000'))
        && !existsSync(join(sandbox, 'red', 'live', '20260102000000')))
  }

  // ---------- G/L/S — the NEW behavior, through the helper ----------
  let retention = null
  let loadError = null
  try {
    retention = await import('./verify-retention.mjs')
  } catch (e) {
    loadError = e?.message ?? String(e)
  }

  if (!retention) {
    // Pre-change main: the helper does not exist. Every green face is
    // reported as its own failure — the recorded red bar (the T-052
    // seam-absence pattern).
    const why = `the T-055 helper scripts/verify-retention.mjs is absent on this tree (the recorded red bar): ${loadError}`
    t(`G1 (retention + default keep): ${why}`, false)
    t(`G2 (the keep parameter): ${why}`, false)
    t(`G3 (honest return value): ${why}`, false)
    t(`L1 (exactly-one passes with an archived-history root): ${why}`, false)
    t(`L2 (exactness unchanged): ${why}`, false)
    t(`S1 (non-timestamped live-root safety): ${why}`, false)
    t(`S2 (archive-side prune safety): ${why}`, false)
    t(`S3 (nonexistent live root no-throw): ${why}`, false)
  } else {
    const { ARCHIVE_KEEP_RUNS, archiveExistingRuns, listRunDirs, pruneArchive } = retention

    // ----- G1 — retention + the DEFAULT bound (ARCHIVE_KEEP_RUNS) -----
    {
      const live = join(sandbox, 'g1', 'live')
      const archive = join(sandbox, 'g1', 'archive')
      // Nine old archived runs + two live ones = eleven after the move, so
      // the default keep (10) must delete EXACTLY the single oldest.
      const plantedOld = ['20260101000000', '20260102000000', '20260103000000', '20260104000000',
        '20260105000000', '20260106000000', '20260107000000', '20260108000000', '20260109000000']
      for (const name of plantedOld) writeRunDir(archive, name, `OLD-${name}`)
      writeRunDir(live, '20260201000000', 'G-LIVE-ONE')
      writeRunDir(live, '20260201000001', 'G-LIVE-TWO')

      const res = archiveExistingRuns(live, archive) // default keep

      t('G1.0: ARCHIVE_KEEP_RUNS is the documented exported constant 10', ARCHIVE_KEEP_RUNS === 10)
      t('G1.1: the helper reports exactly the two live run dirs as moved', Array.isArray(res.moved) && res.moved.length === 2
        && res.moved[0] === '20260201000000' && res.moved[1] === '20260201000001')
      t('G1.2: both moved run dirs exist under the archive root', existsSync(join(archive, '20260201000000'))
        && existsSync(join(archive, '20260201000001')))
      t('G1.3: the move preserved the bytes (plain rename, never rewritten)',
        readFileSync(join(archive, '20260201000000', 'report.json'), 'utf8') === '{"marker":"G-LIVE-ONE"}\n'
        && readFileSync(join(archive, '20260201000001', 'report.json'), 'utf8') === '{"marker":"G-LIVE-TWO"}\n')
      t('G1.4: the live root holds zero run dirs after the archive', listRunDirs(live).length === 0)
      t('G1.5: the archive holds exactly ARCHIVE_KEEP_RUNS (10) run dirs after the prune', listRunDirs(archive).length === ARCHIVE_KEEP_RUNS)
      t('G1.6: the helper reports exactly the single oldest archive as deleted',
        Array.isArray(res.deleted) && res.deleted.length === 1 && res.deleted[0] === '20260101000000')
      t('G1.7: the KEPT set is exactly the ten most recent run dirs',
        JSON.stringify(listRunDirs(archive)) === JSON.stringify(['20260102000000', '20260103000000', '20260104000000',
          '20260105000000', '20260106000000', '20260107000000', '20260108000000', '20260109000000',
          '20260201000000', '20260201000001']))
    }

    // ----- G2 — the keep parameter (parameterized bound) -----
    {
      const live = join(sandbox, 'g2', 'live')
      const archive = join(sandbox, 'g2', 'archive')
      const plantedOld = ['20260301000000', '20260302000000', '20260303000000', '20260304000000']
      for (const name of plantedOld) writeRunDir(archive, name, `OLD-${name}`)
      writeRunDir(live, '20260305000000', 'G2-LIVE')

      const res = archiveExistingRuns(live, archive, 2)

      t('G2.1: keep=2 leaves exactly the two most recent archived run dirs',
        JSON.stringify(listRunDirs(archive)) === JSON.stringify(['20260304000000', '20260305000000']))
      t('G2.2: keep=2 deletes exactly the three oldest',
        JSON.stringify(res.deleted) === JSON.stringify(['20260301000000', '20260302000000', '20260303000000']))
      t('G2.3: the moved dir is the survivor and carries its bytes',
        readFileSync(join(archive, '20260305000000', 'report.json'), 'utf8') === '{"marker":"G2-LIVE"}\n')
    }

    // ----- L — the full-tier assertion's predicate, shared code -----
    {
      const live = join(sandbox, 'l1', 'live')
      const archive = join(sandbox, 'l1', 'archive')
      writeRunDir(live, '20260401000000', 'L-ONLY')
      for (let d = 1; d <= 12; d++) writeRunDir(archive, `202605${String(d).padStart(2, '0')}000000`, `L-ARCH-${d}`)

      // The assertion as scripts/verify.mjs's Gate 2 now states it: exactly
      // one run dir in the LIVE root. Twelve archived runs must not move
      // the number — that is the whole point of the archive living elsewhere.
      t('L1: exactly-one passes with an archived-history root (1 live run dir, 12 archived)', listRunDirs(live).length === 1)
      t('L1b: the archive side really holds twelve (the fixture is what it claims)', listRunDirs(archive).length === 12)

      const empty = join(sandbox, 'l2', 'empty')
      const two = join(sandbox, 'l2', 'two')
      mkdirSync(empty, { recursive: true })
      mkdirSync(two, { recursive: true })
      writeRunDir(two, '20260601000000', 'L-TWO-A')
      writeRunDir(two, '20260601000001', 'L-TWO-B')
      t('L2: the predicate stays exact (0 run dirs -> 0, not one)', listRunDirs(empty).length === 0)
      t('L2b: the predicate stays exact (2 run dirs -> 2, not one)', listRunDirs(two).length === 2)
    }

    // ----- S — non-timestamped safety -----
    {
      const live = join(sandbox, 's1', 'live')
      const archive = join(sandbox, 's1', 'archive')
      mkdirSync(join(live, 'locks'), { recursive: true })
      writeFileSync(join(live, 'locks', 'abc123.lock'), 'LOCK-BYTES\n')
      mkdirSync(join(live, 'verify-red'), { recursive: true })
      writeFileSync(join(live, 'verify-red', 'note.txt'), 'RED-NOTE\n')
      writeFileSync(join(live, 'stray.txt'), 'STRAY-BYTES\n')
      writeFileSync(join(live, '20991231235959'), 'TIMESTAMPED-FILE-NOT-A-DIR\n')
      writeRunDir(live, '20260701000000', 'S-ONLY')

      archiveExistingRuns(live, archive, 5)

      t('S1: locks/ survives with its bytes (the T-004 lock home is never touched)',
        readFileSync(join(live, 'locks', 'abc123.lock'), 'utf8') === 'LOCK-BYTES\n')
      t('S1b: verify-red/ survives with its bytes', readFileSync(join(live, 'verify-red', 'note.txt'), 'utf8') === 'RED-NOTE\n')
      t('S1c: a stray file survives with its bytes', readFileSync(join(live, 'stray.txt'), 'utf8') === 'STRAY-BYTES\n')
      t('S1d: a timestamped FILE is never moved (it stays in the live root, bytes intact)',
        readFileSync(join(live, '20991231235959'), 'utf8') === 'TIMESTAMPED-FILE-NOT-A-DIR\n')
      t('S1e: the timestamped file never reached the archive (only run DIRECTORIES archive)',
        existsSync(join(archive, '20991231235959')) === false)
      t('S1f: the run DIRECTORY did move (the helper still does its one job)',
        existsSync(join(archive, '20260701000000', 'report.json')) && !existsSync(join(live, '20260701000000')))
    }
    {
      const archive = join(sandbox, 's2', 'archive')
      mkdirSync(archive, { recursive: true })
      writeFileSync(join(archive, 'notes.txt'), 'ARCHIVE-NOTES\n')
      const planted = ['20260801000000', '20260802000000', '20260803000000', '20260804000000',
        '20260805000000', '20260806000000', '20260807000000']
      for (const name of planted) writeRunDir(archive, name, `S2-${name}`)

      const deleted = pruneArchive(archive, 5)

      t('S2: the archive-side prune deletes exactly the oldest beyond keep=5',
        JSON.stringify(deleted) === JSON.stringify(['20260801000000', '20260802000000'])
        && listRunDirs(archive).length === 5)
      t('S2b: the prune never touches a non-timestamped entry in the archive root',
        readFileSync(join(archive, 'notes.txt'), 'utf8') === 'ARCHIVE-NOTES\n')
    }
    {
      const absent = join(sandbox, 's3', 'does-not-exist')
      const archive = join(sandbox, 's3', 'archive')
      let threw = null
      try {
        const res = archiveExistingRuns(absent, archive)
        t('S3: a nonexistent live root is a no-throw no-op (moved empty)', threw === null && Array.isArray(res.moved) && res.moved.length === 0)
      } catch (e) {
        threw = e
        t(`S3: a nonexistent live root is a no-throw no-op (moved empty) — THREW: ${e?.message}`, false)
      }
      t('S3b: a nonexistent live root is not conjured into existence', existsSync(absent) === false)
    }
  }

  // ---------- H — the check never touches the real verify root ----------
  const realAfter = existsSync(REAL_VERIFY_ROOT) ? localRunDirs(REAL_VERIFY_ROOT).join(',') : '<absent>'
  t(`H1: the real verify root's run-dir set is identical before and after (check isolation)`, realBefore === realAfter)

  rmSync(sandbox, { recursive: true, force: true })
  console.log(`\n=== check-verify-retention (Gate 1.41): ${failures.length === 0 ? `ALL GREEN (${assertions} assertions)` : `${failures.length} failure(s) of ${assertions}`} ===`)
  process.exitCode = failures.length === 0 ? 0 : 1
}

main().then(
  () => { /* exitCode already set */ },
  (e) => {
    console.error(`FAIL: check threw: ${e?.stack ?? e}`)
    process.exit(1)
  },
)
