// Integration replay (T-005): re-verify a surviving candidate's captured
// diff.patch against the target repo at its CURRENT HEAD.
//
//   npm run integrate -- --run <runId> --candidate cXX --gate "name=command" [...]
//
// First slice of spec §17 (§17.2 steps 1-4 and 6, minus the model jobs):
// replay onto a fresh detached worktree, re-run the operator-supplied gates,
// report the verdict. Merging stays a human act (§17.4) — this command never
// commits, never creates a branch, never moves a ref, and touches no model
// adapter (decisions.md: machine gates decide survival).
//
// The --gate name set must exactly match the gates the candidate passed in
// the run, and — since T-027 — when a recorded gate result carries its
// command (GateResult.command, stamped by CommandGate), the re-supplied
// command must equal it exactly: compare-when-recorded, so the replay can
// prove it exercised the same commands the run survived. A report that
// predates command recording replays on the name set alone (the T-005
// contract, byte-for-byte).
//
// The integration worktree is left in place for inspection, holding the
// replayed diff as uncommitted changes: plain `npm run clean` refuses it
// (dirty-protection), `clean --force` disposes it via the existing wt/
// discovery. The evidence — integrate/<id>.json, diff.patch, report.json —
// always survives.
//
// Replay mutates the target repo's worktree state, so steps after the policy
// refusals run under the T-004 checkout lock, released in finally.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CommandGate } from './gate/command.js'
import { acquireCheckoutLock, CheckoutLockRefused, releaseCheckoutLock } from './lock.js'
import type { CandidateReport, GateResult, RunReport } from './types.js'

const usage = `Integration replay: re-verify a surviving candidate's diff at current HEAD.

Usage:
  npm run integrate -- --run <runId> --candidate <id> --gate "name=command" [options]

Options:
  --run <runId>        Run directory under the run root (required)
  --candidate <id>     Candidate id from the run's report (required)
  --gate "name=cmd"    Machine gate; repeatable. The NAME set must exactly match
                       the gates the candidate passed in the run; when the run
                       recorded a gate's command, the re-supplied command must
                       equal it exactly (compare-when-recorded, T-027)
  --run-root <path>    Where runs live (default: C:\\swarm)
  --force-lock         Take the checkout lock from a suspected-stale holder
  --help               Show this help

Reads <runRoot>/<runId>/report.json and <candidate>/diff.patch, replays the
diff onto a fresh detached worktree at the target repo's current HEAD, re-runs
the gates there, and writes <runRoot>/<runId>/integrate/<id>.json. Exit 0 iff
the diff applied, changed the tree, and every gate passed. Never commits,
never branches, never moves a ref.`

interface Options {
  runRoot: string
  run: string
  candidate: string
  forceLock: boolean
  gates: { name: string; command: string }[]
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { runRoot: 'C:\\swarm', run: '', candidate: '', forceLock: false, gates: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${arg}`)
      return v
    }
    switch (arg) {
      case '--run': opts.run = value(); break
      case '--candidate': opts.candidate = value(); break
      case '--force-lock': opts.forceLock = true; break
      case '--run-root': opts.runRoot = value(); break
      case '--gate': {
        const spec = value()
        const eq = spec.indexOf('=')
        if (eq <= 0) throw new Error(`--gate expects "name=command", got: ${spec}`)
        opts.gates.push({ name: spec.slice(0, eq), command: spec.slice(eq + 1) })
        break
      }
      case '--help': case '-h': console.log(usage); process.exit(0)
      default: throw new Error(`unknown option: ${arg}\n\n${usage}`)
    }
  }
  if (!opts.run || !opts.candidate) throw new Error(`--run and --candidate are required\n\n${usage}`)
  if (opts.gates.length === 0) throw new Error(`at least one --gate is required\n\n${usage}`)
  return opts
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function errorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  // execFileSync folds stderr into the message; keep the tail (git's reason).
  return m.length > 600 ? `…${m.slice(-600)}` : m
}

function refuse(message: string): never {
  console.error(`refused: ${message}`)
  process.exit(1)
}

function readReport(runDir: string): RunReport {
  const path = join(runDir, 'report.json')
  if (!existsSync(path)) refuse(`no report.json at ${path}`)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunReport
  } catch (e) {
    refuse(`report.json at ${path} is not readable JSON: ${errorMessage(e)}`)
  }
}

function gateContract(recorded: GateResult[], supplied: { name: string; command: string }[]): string | null {
  const missing = recorded.filter((g) => !supplied.some((s) => s.name === g.name)).map((g) => g.name)
  const extra = supplied.filter((s) => !recorded.some((g) => g.name === s.name)).map((s) => s.name)
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`)
    if (extra.length > 0) parts.push(`not in the run's recorded gate set: ${extra.join(', ')}`)
    return `gate names must exactly match the gates the candidate passed (recorded: ${recorded.map((g) => g.name).join(', ')}). ${parts.join('; ')}`
  }
  // Compare-when-recorded (T-027): a gate whose run recorded its command
  // (GateResult.command — stamped by CommandGate) pins the re-supplied
  // command exactly; a recorded result without command (a pre-T-027 report)
  // falls back to name-only, the T-005 contract byte-for-byte.
  const mismatched = recorded.filter((g) => {
    const s = supplied.find((x) => x.name === g.name)
    return s !== undefined && g.command !== undefined && s.command !== g.command
  })
  if (mismatched.length > 0) {
    const parts = mismatched.map((g) => `${g.name}: recorded "${g.command}" but re-supplied "${supplied.find((x) => x.name === g.name)?.command}"`)
    return `re-supplied gate commands must match the commands recorded in the run's report — a replay must exercise the same commands the run survived. ${parts.join('; ')}`
  }
  return null
}

interface IntegrateVerdict {
  runId: string
  candidateId: string
  appliedAt: string
  targetHead: string
  runBaseSha: string
  applied: boolean
  treeChanged: boolean
  gates: { name: string; passed: boolean; exitCode: number | null; durationMs: number; outputTail: string; command?: string }[]
  passed: boolean
  worktreePath: string
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2))
  const runDir = join(opts.runRoot, opts.run)
  if (!existsSync(runDir)) refuse(`no such run directory: ${runDir}`)

  // ---- evidence + policy refusals (read-only, before the lock) ----
  const report = readReport(runDir)
  if (!report.repo) refuse(`report.json has no repo field — replay is defined only against the run's own target`)
  if (!existsSync(report.repo)) refuse(`the run's target repo does not exist on disk: ${report.repo}`)

  const candidate: CandidateReport | undefined = report.candidates.find((c) => c.id === opts.candidate)
  if (!candidate) refuse(`no such candidate '${opts.candidate}' in run ${report.runId} (candidates: ${report.candidates.map((c) => c.id).join(', ')})`)
  if (candidate.passedAllGates !== true) refuse(`candidate ${opts.candidate} did not pass all gates in the run — integrate replays survivors only`)
  if (!candidate.diffPath) refuse(`candidate ${opts.candidate} has no captured diff (diffPath is null)`)
  if (!existsSync(candidate.diffPath)) refuse(`captured diff missing on disk: ${candidate.diffPath}`)
  if (candidate.diffBytes === 0) refuse(`zero-byte diff for ${opts.candidate} — a NO-OP is never a pass`)

  const contract = gateContract(candidate.gates, opts.gates)
  if (contract) refuse(contract)

  // ---- locked region: everything that mutates the target repo ----
  const worktreePath = join(runDir, 'wt', `int-${opts.candidate}`)
  if (existsSync(worktreePath)) {
    refuse(`integration worktree already exists: ${worktreePath} (npm run clean -- --run ${opts.run} --force disposes it)`)
  }

  let lockPath: string
  try {
    lockPath = acquireCheckoutLock(opts.runRoot, report.repo, { cmd: 'integrate', runId: report.runId }, opts.forceLock)
  } catch (e) {
    if (e instanceof CheckoutLockRefused) {
      console.error(`refused: checkout lock held on ${report.repo} — nothing was replayed`)
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }

  try {
    const targetHead = git(report.repo, ['rev-parse', 'HEAD']).trim()
    mkdirSync(join(runDir, 'wt'), { recursive: true })
    // Detached at current HEAD: no branch is created and no ref moves (§17.4).
    // Deliberately not WorktreeProvider.lease — that pins the run's baseSha
    // and creates a swarm/* branch, both wrong for replay-at-current-HEAD.
    git(report.repo, ['worktree', 'add', '--detach', worktreePath, 'HEAD'])
    console.log(`integrate ${opts.candidate}: worktree at ${worktreePath} (HEAD ${targetHead.slice(0, 12)}, run base ${report.baseSha.slice(0, 12)})`)

    // No process.exit below this point: exit() would skip the finally below
    // and leak the lock. Every failure path returns a non-zero code, released
    // first, exited after.
    return await replay(opts, report, candidate, candidate.diffPath, worktreePath, targetHead)
  } finally {
    releaseCheckoutLock(lockPath)
  }
}

async function replay(
  opts: Options,
  report: RunReport,
  candidate: CandidateReport,
  diffPath: string,
  worktreePath: string,
  targetHead: string,
): Promise<number> {
  const runDir = join(opts.runRoot, opts.run)

  // git apply is atomic: a rejecting patch leaves the tree untouched, so
  // there is no partial state to clean up.
  //
  // Binary-safe replay (T-026): capture is `git diff HEAD --binary`, so every
  // binary hunk carries the full 40-hex index line git apply requires and a
  // clean target replays byte-identically. A patch carrying the lossy stub
  // line ("Binary files … differ") predates binary-safe capture — historical
  // evidence that cannot be reconstructed (spec §17.3: prior evidence is
  // marked historical). A genuinely drifted binary — pre-image no longer at
  // current HEAD — fails apply --check with an ordinary "patch does not
  // apply" and is refused below like any other conflict.
  if (/^Binary files .* differ$/m.test(readFileSync(diffPath, 'utf8'))) {
    console.error(`refused: the captured diff contains the lossy pre-fix binary stub ("Binary files … differ") — it predates binary-safe capture (git diff HEAD --binary) and cannot be reconstructed; this evidence is historical (spec §17.3).`)
    return 1
  }
  try {
    git(worktreePath, ['apply', '--check', diffPath])
  } catch (e) {
    const msg = errorMessage(e)
    console.error(`refused: git apply --check failed — the patch no longer applies at current HEAD ${targetHead.slice(0, 12)}:`)
    console.error(msg)
    return 1
  }
  git(worktreePath, ['apply', diffPath])
  console.log(`integrate ${opts.candidate}: diff applied (${candidate.diffBytes} bytes)`)

  const treeChanged = git(worktreePath, ['status', '--porcelain']).trim() !== ''
  if (!treeChanged) {
    console.error(`refused: the patch applied but changed nothing — a NO-OP is never a pass (AGENTS.md #7)`)
    writeVerdict(runDir, opts.candidate, {
      runId: report.runId,
      candidateId: opts.candidate,
      appliedAt: new Date().toISOString(),
      targetHead,
      runBaseSha: report.baseSha,
      applied: true,
      treeChanged: false,
      gates: [],
      passed: false,
      worktreePath,
    })
    return 1
  }

  const results = []
  for (const g of opts.gates) {
    const gate = new CommandGate(g.name, g.command)
    const r = await gate.run(worktreePath)
    results.push(r)
    console.log(`integrate ${opts.candidate}: gate ${r.name}: ${r.passed ? 'PASS' : 'FAIL'} (${(r.durationMs / 1000).toFixed(1)}s)`)
  }

  const passed = results.length > 0 && results.every((r) => r.passed)
  writeVerdict(runDir, opts.candidate, {
    runId: report.runId,
    candidateId: opts.candidate,
    appliedAt: new Date().toISOString(),
    targetHead,
    runBaseSha: report.baseSha,
    applied: true,
    treeChanged: true,
    gates: results,
    passed,
    worktreePath,
  })

  const gateText = results.map((r) => `${r.name} ${r.passed ? 'PASS' : 'FAIL'}`).join(', ')
  console.log(`integrate ${opts.candidate}: ${gateText} => ${passed ? 'PASS' : 'FAIL'} (worktree kept for inspection; clean --run ${opts.run} --force disposes it)`)
  console.log(`verdict: ${join(runDir, 'integrate', `${opts.candidate}.json`)}`)
  return passed ? 0 : 1
}

function writeVerdict(runDir: string, candidateId: string, verdict: IntegrateVerdict): void {
  const dir = join(runDir, 'integrate')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${candidateId}.json`), JSON.stringify(verdict, null, 2))
}

try {
  const code = await main()
  if (code !== 0) process.exit(code)
} catch (e: unknown) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
