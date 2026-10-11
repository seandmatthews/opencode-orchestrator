import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CandidateReport, Gate, GateResult, PlannerReport, RunReport, WorkerAdapter, WorkspaceLease, WorkspaceProvider } from './types.js'

export interface SkeletonOptions {
  runId: string
  repo: string
  /** All candidates are pinned to this ref (a SHA, so it cannot move mid-run). */
  baseSha: string
  goal: string
  /** Worker-tier model ID given to every candidate. */
  model: string
  /** Planner-tier model ID, or null to skip planning (candidates get the raw goal). */
  plannerModel: string | null
  candidateIds: string[]
  concurrency: number
  timeoutMs: number
  gates: Gate[]
  worker: WorkerAdapter
  workspaces: WorkspaceProvider
  artifactsDir: string
  /** Dispose workspaces after evidence capture instead of leaving them for inspection. */
  cleanWorkspaces: boolean
}

export function builderPrompt(goal: string, workspacePath: string): string {
  return [
    'You are implementing a small, well-specified change in the git repository located at:',
    `  ${workspacePath}`,
    'Read, write, and run commands only inside that directory.',
    '',
    `GOAL: ${goal}`,
    '',
    'Rules:',
    '- Make the minimal change that satisfies the goal.',
    '- Do not create git commits, branches, stashes, or worktrees.',
    '- Do not modify files unrelated to the goal.',
    '- When finished, reply with a one-paragraph summary of what you changed.',
  ].join('\n')
}

export async function runSkeleton(opts: SkeletonOptions): Promise<RunReport> {
  const startedAt = new Date().toISOString()
  mkdirSync(join(opts.artifactsDir, 'wt'), { recursive: true })

  // Planning tier: one smart-model job turns the goal into N distinct briefs.
  // Failure here degrades gracefully — candidates fall back to the raw goal.
  let briefs: string[] = opts.candidateIds.map(() => opts.goal)
  let planner: PlannerReport | undefined
  if (opts.plannerModel) {
    planner = await runPlannerPhase(opts)
    if (planner.ok) briefs = planner.briefs
    console.log(`planner: ${planner.ok ? `${briefs.length} briefs` : 'no valid output, using raw goal'} in ${(planner.durationMs / 1000).toFixed(0)}s (${planner.attempts} attempt${planner.attempts > 1 ? 's' : ''})`)
    console.log('')
  }

  // Lease every candidate up front so all workers start from the same base.
  const leases = new Map<string, WorkspaceLease>()
  for (const id of opts.candidateIds) {
    leases.set(id, opts.workspaces.lease(`wt/${id}`, opts.baseSha))
  }

  let next = 0
  const reports: CandidateReport[] = new Array(opts.candidateIds.length)
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= opts.candidateIds.length) return
      const id = opts.candidateIds[i]!
      reports[i] = await runCandidate(id, leases.get(id)!, briefs[i]!, opts)
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, lane))

  const report: RunReport = {
    runId: opts.runId,
    repo: opts.repo,
    baseSha: opts.baseSha,
    goal: opts.goal,
    model: opts.model,
    planner,
    startedAt,
    finishedAt: new Date().toISOString(),
    candidates: reports,
  }
  writeFileSync(join(opts.artifactsDir, 'report.json'), JSON.stringify(report, null, 2))
  return report
}

function plannerPrompt(goal: string, count: number): string {
  return [
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
}

/** Extract a JSON string-array of exactly `count` briefs; fills short arrays by cycling. */
export function parseBriefs(text: string, count: number): string[] | null {
  const lastBracket = text.lastIndexOf(']')
  if (lastBracket === -1) return null
  for (let i = lastBracket; i >= 0; i--) {
    if (text[i] === '[') {
      try {
        const parsed: unknown = JSON.parse(text.slice(i, lastBracket + 1))
        if (!Array.isArray(parsed)) continue
        const briefs = parsed
          .filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
          .map((b) => b.trim())
        if (briefs.length === 0) continue
        const original = briefs.length
        while (briefs.length < count) briefs.push(briefs[briefs.length % original]!)
        return briefs.slice(0, count)
      } catch {
        // Try the next '[' to the left.
      }
    }
  }
  return null
}

async function runPlannerPhase(opts: SkeletonOptions): Promise<PlannerReport> {
  const count = opts.candidateIds.length
  const prompt = plannerPrompt(opts.goal, count)
  const logPath = join(opts.artifactsDir, 'planner.log')
  const rawOutputPath = join(opts.artifactsDir, 'planner-raw.txt')
  const started = Date.now()

  // The planner may read the repo to write informed briefs, but must not
  // modify it; enforcement moves into capability restrictions later.
  const baseReq = { model: opts.plannerModel!, cwd: opts.repo, logPath, timeoutMs: opts.timeoutMs }
  let result = await opts.worker.execute({ ...baseReq, prompt })
  let attempts = 1
  let briefs = result.ok ? parseBriefs(result.responseTail, count) : null

  if (!briefs && !result.timedOut) {
    attempts = 2
    console.log('planner: output was not a valid JSON array, running one bounded repair attempt')
    result = await opts.worker.execute({
      ...baseReq,
      prompt: [
        prompt,
        '',
        'Your previous response was not a valid JSON array of strings. Previous response:',
        result.responseTail,
        '',
        'Output ONLY the JSON array. No other text.',
      ].join('\n'),
    })
    briefs = result.ok ? parseBriefs(result.responseTail, count) : null
  }

  writeFileSync(rawOutputPath, result.responseTail)
  return {
    model: opts.plannerModel!,
    ok: briefs !== null,
    attempts,
    durationMs: Date.now() - started,
    briefs: briefs ?? [],
    fallbackUsed: briefs === null,
    rawOutputPath,
  }
}

async function runCandidate(id: string, lease: WorkspaceLease, brief: string, opts: SkeletonOptions): Promise<CandidateReport> {
  const dir = join(opts.artifactsDir, id)
  mkdirSync(dir, { recursive: true })
  const base: CandidateReport = {
    id,
    workerId: opts.worker.id,
    model: opts.model,
    brief,
    workspacePath: lease.path,
    workerOk: false,
    workerTimedOut: false,
    workerDurationMs: 0,
    diffPath: null,
    diffBytes: 0,
    gates: [],
    passedAllGates: false,
  }

  try {
    console.log(`[${id}] worker start (${opts.worker.id}, model=${opts.model})`)
    const result = await opts.worker.execute({
      prompt: builderPrompt(brief, lease.path),
      model: opts.model,
      cwd: lease.path,
      logPath: join(dir, 'worker.log'),
      timeoutMs: opts.timeoutMs,
    })
    base.workerOk = result.ok
    base.workerTimedOut = result.timedOut
    base.workerDurationMs = result.durationMs
    console.log(`[${id}] worker done in ${(result.durationMs / 1000).toFixed(0)}s ok=${result.ok} exit=${result.exitCode}`)

    try {
      const diff = opts.workspaces.diff(lease)
      const diffPath = join(dir, 'diff.patch')
      writeFileSync(diffPath, diff)
      base.diffPath = diffPath
      base.diffBytes = Buffer.byteLength(diff)
      console.log(`[${id}] diff captured: ${base.diffBytes} bytes`)
    } catch (e) {
      console.log(`[${id}] diff capture failed: ${errorMessage(e)}`)
    }

    for (const gate of opts.gates) {
      const r: GateResult = await gate.run(lease.path)
      base.gates.push(r)
      console.log(`[${id}] gate ${r.name}: ${r.passed ? 'PASS' : 'FAIL'} (${(r.durationMs / 1000).toFixed(1)}s)`)
    }
    base.passedAllGates = base.gates.length > 0 && base.gates.every((g) => g.passed) && base.diffBytes > 0
  } catch (e) {
    base.error = errorMessage(e)
    console.log(`[${id}] candidate errored: ${base.error}`)
  }

  if (opts.cleanWorkspaces) {
    try {
      opts.workspaces.dispose(lease)
      base.workspacePath = null
    } catch (e) {
      console.log(`[${id}] workspace dispose failed: ${errorMessage(e)}`)
    }
  }

  return base
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
