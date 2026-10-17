// Artifact-store persistence + tamper-evidence self-check (Gate 1.16, fast
// tier, T-016) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-artifacts.mjs
// Pins the re-verification primitive (`verifyRunArtifacts`,
// src/store/index.ts — spec §29:1877's "validate artifact files/hashes"
// face) against a sandbox run with controlled evidence files: intact files
// verify, a flipped byte is 'mutated', a deleted file is 'missing', a
// null-hash row is 'unverified' — never 'mutated' — even once its file
// appears. Also pins that verification is read-only over both sides (the DB
// byte-identical, evidence only ever read) and that hash-at-ingest measured
// the controlled content. No existing gate pins this: Gate 1.15 pins bundle
// WRITING, not store persistence, and Gate 2 spends model tokens. Zero
// model tokens, no git, no pipeline, no CLI (T-016 carves the readback
// entry point — the recovery slice owns that integration).
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ingest, verifyRunArtifacts } from '../src/store/index.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const sandbox = mkdtempSync(join(tmpdir(), 't016-artifacts-'))
try {
  const runId = '20261016000000'
  const runDir = join(sandbox, 'run')
  mkdirSync(join(runDir, 'c01'), { recursive: true })
  mkdirSync(join(runDir, 'c02'), { recursive: true })
  mkdirSync(join(runDir, 'probes', 'c01'), { recursive: true })

  // Controlled evidence files — content is chosen here, so ingest-time
  // sizes/hashes are exactly pinnable. c02's diff is named by the report
  // but deliberately never written: the missing-file case.
  const FILES = {
    report: { path: join(runDir, 'report.json'), content: '' },
    planner: { path: join(runDir, 'planner-raw.txt'), content: '["brief one","brief two"]\n' },
    workerLog: { path: join(runDir, 'c01', 'worker.log'), content: 'worker log line one\nworker log line two\n' },
    diff: { path: join(runDir, 'c01', 'diff.patch'), content: 'diff --git a/calc.js b/calc.js\n--- a/calc.js\n+++ b/calc.js\n@@ -1 +1 @@\n-old\n+new\n' },
    reviewRaw: { path: join(runDir, 'c01', 'review-raw.txt'), content: '{"observations":[]}\n' },
    bundle: { path: join(runDir, 'probes', 'c01', 'p1.json'), content: '{"probeId":"p1","scenarioId":"p1","success":true,"artifacts":[],"measurements":[],"gateResults":[]}\n' },
  }
  const MISSING = join(runDir, 'c02', 'diff.patch')

  const report = {
    runId,
    repo: 'C:\\swarm\\demo-target',
    baseSha: '4eabbb245b7f876b04fd4828dd729c7c624ddbe3',
    goal: 'artifact-store sandbox run',
    model: 'zai-coding-plan/glm-5.3-flash',
    planner: { model: 'zai-coding-plan/glm-5.3', ok: true, attempts: 1, durationMs: 5, briefs: ['b1', 'b2'], fallbackUsed: false, rawOutputPath: FILES.planner.path },
    startedAt: '2026-10-16T10:00:00.000Z',
    finishedAt: '2026-10-16T10:01:00.000Z',
    candidates: [
      {
        id: 'c01', workerId: 'opencode', model: 'zai-coding-plan/glm-5.3-flash', brief: 'b1',
        workspacePath: null, workerOk: true, workerTimedOut: false, workerDurationMs: 1000,
        diffPath: FILES.diff.path, diffBytes: Buffer.byteLength(FILES.diff.content),
        gates: [{ name: 'build', passed: true, exitCode: 0, durationMs: 10, outputTail: 'ok' }],
        passedAllGates: true,
        attempts: [{
          id: 'c01-a1', jobId: 'c01', number: 1, state: 'succeeded',
          startedAt: '2026-10-16T10:00:01.000Z', endedAt: '2026-10-16T10:00:02.000Z',
          inputContextHash: 'a'.repeat(64), promptVersion: null,
          // diff.patch is named by BOTH diffPath and this array — the dedup
          // case: still exactly one artifacts row.
          outputArtifacts: [FILES.workerLog.path, FILES.diff.path],
        }],
        probes: [{ probeId: 'p1', scenarioId: 'p1', success: true, durationMs: 250, bundlePath: FILES.bundle.path }],
        review: { ok: true, attempts: 1, model: 'zai-coding-plan/glm-5.3', observations: [], rawOutputPath: FILES.reviewRaw.path },
      },
      {
        id: 'c02', workerId: 'opencode', model: 'zai-coding-plan/glm-5.3-flash', brief: 'b2',
        workspacePath: null, workerOk: true, workerTimedOut: false, workerDurationMs: 4567,
        diffPath: MISSING, diffBytes: 12,
        gates: [], passedAllGates: false,
        attempts: [],
      },
    ],
  }
  FILES.report.content = `${JSON.stringify(report, null, 2)}\n`

  for (const f of Object.values(FILES)) writeFileSync(f.path, f.content)
  const evidenceShaBefore = Object.fromEntries(Object.values(FILES).map((f) => [f.path, sha256(f.path)]))

  const dbPath = join(sandbox, 'refinery.db')
  ingest(report, dbPath)

  // ---------- hash-at-ingest measured the controlled content ----------
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const rows = db.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY artifact_id').all(runId)
  t('7 artifact rows (report.json, planner raw, worker.log, deduped diff, review raw, probe bundle, c02 missing diff)',
    rows.length === 7 && rows.filter((r) => r.path === FILES.diff.path).length === 1)
  const byPath = new Map(rows.map((r) => [r.path, r]))
  t('hash-at-ingest: size_bytes/content_hash equal the controlled content (streaming read, cross-checked)',
    Object.values(FILES).every((f) => {
      const r = byPath.get(f.path)
      return r !== undefined && r.size_bytes === Buffer.byteLength(f.content) && r.content_hash === sha256(f.path)
    }))
  t('the deduped diff row is attempt-scoped (named by diffPath AND the final attempt outputArtifacts — ONE row)',
    byPath.get(FILES.diff.path)?.job_id === 'c01' && byPath.get(FILES.diff.path)?.attempt_number === 1)
  t('the missing file records NULL size and NULL hash — never fabricated (AGENTS.md #7)',
    byPath.get(MISSING) !== undefined
    && byPath.get(MISSING)?.size_bytes === null && byPath.get(MISSING)?.content_hash === null)
  t('probe bundle artifacts row is kind report; probe_runs row matches the summary verbatim',
    byPath.get(FILES.bundle.path)?.kind === 'report'
    && eq(db.prepare('SELECT * FROM probe_runs WHERE run_id = ?').get(runId), {
      run_id: runId, job_id: 'c01', probe_id: 'p1', scenario_id: 'p1',
      success: 1, duration_ms: 250, bundle_path: FILES.bundle.path,
    }))
  db.close()

  // ---------- re-verification: the four statuses ----------
  let v = verifyRunArtifacts(runId, dbPath)
  t('re-verification of intact files: 6 verified + the null-hash row unverified — never mutated',
    v.length === 7
    && v.filter((x) => x.status === 'verified').length === 6
    && v.find((x) => x.path === MISSING)?.status === 'unverified')
  t('re-verification results are ordered by artifact_id (deterministic)',
    eq(v.map((x) => x.artifactId), [...v.map((x) => x.artifactId)].sort()))

  // ---------- read-only over both sides ----------
  const dbShaBefore = sha256(dbPath)
  verifyRunArtifacts(runId, dbPath)
  verifyRunArtifacts(runId, dbPath)
  t('verification is read-only over the DB (byte-identical across repeated runs)', sha256(dbPath) === dbShaBefore)
  t('verification never writes evidence (every still-intact file byte-identical)',
    Object.values(FILES).every((f) => f.path === FILES.diff.path || sha256(f.path) === evidenceShaBefore[f.path]))

  // ---------- tamper: flip one file's bytes ----------
  writeFileSync(FILES.diff.path, FILES.diff.content.replace('+new', '+mutated'))
  v = verifyRunArtifacts(runId, dbPath)
  t('flipping one file\'s bytes is detected as mutated',
    v.find((x) => x.path === FILES.diff.path)?.status === 'mutated')
  t('the tamper disturbs no other row (5 verified + 1 unverified around the mutated one)',
    v.filter((x) => x.status === 'verified').length === 5
      && v.filter((x) => x.status === 'unverified').length === 1)

  // ---------- delete one ----------
  rmSync(FILES.workerLog.path)
  v = verifyRunArtifacts(runId, dbPath)
  t('deleting one file reports missing',
    v.find((x) => x.path === FILES.workerLog.path)?.status === 'missing')
  t('the null-hash row still reports unverified — not mutated, not missing',
    v.find((x) => x.path === MISSING)?.status === 'unverified')

  // ---------- the sharp unverified pin: null hash, file exists ----------
  writeFileSync(MISSING, 'appeared after ingest\n')
  v = verifyRunArtifacts(runId, dbPath)
  t('a null-hash row stays unverified even once its file exists (nothing recorded, nothing claimed)',
    v.find((x) => x.path === MISSING)?.status === 'unverified')

  // ---------- unknown run: empty result, never a throw ----------
  t('an unknown run has no artifacts to verify (empty result)',
    verifyRunArtifacts('19999999999999', dbPath).length === 0)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

if (failures.length > 0) {
  console.error(`\ncheck-artifacts: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-artifacts: ALL GREEN')
