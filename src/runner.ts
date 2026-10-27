import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBriefs, parseReview } from './parse.js'
import { evidenceBundlePath, failedBundle, writeEvidenceBundle } from './probe.js'
import type { Probe } from './probe.js'
import { computeGateCommandOverlap } from './gate/overlap.js'
import { annotateBriefPremise } from './premise.js'
import type { BriefPremiseAnnotation } from './premise.js'
import { composePlannerDigest } from './planner-digest.js'
import type { PlannerDigest } from './planner-digest.js'
import { composeWorkerOrientation } from './worker-orientation.js'
import { composeRoundPacket } from './rounds.js'
import { fenceRecordedEvidence, RECORDED_GATE_OUTPUT_LABEL } from './evidence-fence.js'
import { deriveRunYield } from './yield.js'
import { buildEarlyStops, buildSchedule, earlyStopMet, readyJobs } from './scheduler.js'
import type { EarlyStopPolicy, PhaseSpec } from './scheduler.js'
import { DERIVED_PHASE_ID } from './store/index.js'
import type { Attempt, CandidateReport, FailureRecord, Gate, GateResult, PlannerDigestRecord, PlannerReport, ProbeRunSummary, ReviewObservation, ReviewReport, RoundRecord, RunReport, VerifierReport, WorkerAdapter, WorkspaceLease, WorkspaceProvider } from './types.js'

/**
 * Best-effort append to <runDir>/dispatch.jsonl (T-010) — the in-run evidence
 * artifact startup reconciliation consumes. The store is post-hoc only (ingest
 * runs after runSkeleton returns), so a hard-killed run would leave zero DB
 * rows; this file leaves partial evidence instead of nothing. Appends can
 * never break a run (the adapter's appendLog posture,
 * src/worker/opencode.ts). The file is part of the run's evidence set:
 * `clean` never deletes it (it sweeps worktrees and swarm/* branches only),
 * and `recover` reads it after a crash. Line shapes (one JSON object per
 * line, appended in this order per attempt):
 *   {type:'run', runId, repo, baseSha, goal, model, maxAttempts, startedAt}
 *     (gains an optional `gateRetry: true` field when the T-038 flag is set —
 *      recovery derives the one-attempt-taller bound from it; absent otherwise,
 *      so a flag-less header is byte-identical)
 *   {type:'dispatch', jobId, attempt, leaseId, branch, worktreePath, startedAt}
 *   {type:'pid', jobId, attempt, pid, at}
 *   {type:'completion', jobId, attempt, ok, timedOut, exitCode, diffBytes, endedAt}
 *     (diffBytes is null when the diff capture failed — a failed capture is
 *      never readable as the machine-answered zero-byte NO-OP verdict)
 */
function appendDispatchEvidence(artifactsDir: string, line: object): void {
  try {
    appendFileSync(join(artifactsDir, 'dispatch.jsonl'), `${JSON.stringify(line)}\n`)
  } catch {
    // Evidence appends must never break a run.
  }
}

/** One fully-resolved executable job (T-009 --jobs mode): the spec's
 *  scheduling fields with the run-level flags applied as defaults
 *  (model/worker/timeoutMs/gates) and the adapter/gate objects bound. The
 *  engine stays harness-agnostic: adapters and gates arrive behind the
 *  WorkerAdapter/Gate seams (src/types.ts), model IDs only as strings. */
export interface ResolvedJob {
  id: string
  phaseId: string
  /** Expanded edges (job deps + phase-dep expansion) the ready function enforces. */
  dependencies: string[]
  brief: string
  model: string
  worker: WorkerAdapter
  timeoutMs: number
  gates: Gate[]
  /** Evidence probes (T-015, spec §12) behind the Probe seam. Absent when
   *  the job has none — default-mode jobs never carry probes. */
  probes?: Probe[]
  /**
   * T-050 brief-premise annotation, present ONLY on planner-authored briefs
   * whose path-shaped tokens name files absent at the run's baseSha (never
   * on --jobs briefs — operator-owned — nor on raw-goal fallback briefs).
   * `brief` above keeps the planner's text (the candidate report's brief);
   * `annotated` is what every attempt of this job dispatches, hashed into
   * its promptVersion (one composition, two consumers), with the
   * before/after evidence written as `brief-premise.txt` in the candidate's
   * evidence dir. Never a verdict input — annotations change what a worker
   * is TOLD, which is a brief, not a gate.
   */
  premiseAnnotation?: BriefPremiseAnnotation
}

/** The validated spec a --jobs run drives: the declared phases (for the
 *  recorded schedule) plus the resolved jobs. */
export interface ScheduledRunSpec {
  phases: PhaseSpec[]
  jobs: ResolvedJob[]
}

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
  /** Reviewer-tier model ID for advisory post-gate review, or null to skip. */
  reviewerModel: string | null
  /**
   * T-039 verifier-tier model ID for active pre-disposition verification, or
   * null/absent to skip the role entirely (the producer-only pattern: no
   * `verifier` block on any candidate, report shape unchanged). Unlike the
   * reviewer this role is opt-in — there is no default model. Optional at
   * the seam (the T-025 plannerWorker/reviewerWorker pattern) so direct
   * `runSkeleton` callers compile and behave unchanged: absent ≡ null ≡ the
   * role never dispatches.
   */
  verifierModel?: string | null
  /**
   * T-039: the verifier's own adapter (the T-025 per-role harness selection
   * pattern). Optional — absent (the default) resolves to `worker`, so the
   * verifier rides the run-level adapter exactly as the planner/reviewer
   * flags resolve theirs.
   */
  verifierWorker?: WorkerAdapter
  candidateIds: string[]
  concurrency: number
  timeoutMs: number
  /**
   * Maximum number of attempts per candidate (T-007; CLI default 1 = a
   * single attempt, the pre-retry behavior). Only mechanical failures are
   * retried — an attempt that throws or whose worker fails (non-zero exit /
   * timeout). Verdicts are never re-rolled: a worker that succeeded but
   * produced a zero-byte diff or failed gates is eliminated on the ladder
   * exactly as before (decisions.md: machine gates decide survival).
   */
  maxAttempts: number
  gates: Gate[]
  worker: WorkerAdapter
  /**
   * T-038 bounded gate-failure retry: grant each candidate EXACTLY ONE extra
   * attempt when its worker succeeded but the machine gates rejected the
   * change, with the retry brief composed mechanically from the gates' own
   * recorded output (name, command, outputTail) plus the captured diff. The
   * bound is fixed at one — no numeric knob. Blind re-rolls stay banned:
   * zero-byte diffs, no-gates candidates, failed diff captures, and
   * worker-failed legs (T-007's `maxAttempts`) are never retried by this
   * flag. The same Gate objects re-run unchanged on the retry; both legs are
   * recorded; the final attempt's verdict stands (decisions.md 2026-10-21).
   * Absent/false = today's ladder exactly.
   */
  gateRetry?: boolean
  /**
   * T-025 per-role harness selection: the planner's and reviewer's own
   * adapters. Optional — absent (the default) resolves to `worker`, so all
   * three roles ride the run-level adapter exactly as before and direct
   * `runSkeleton` callers compile and behave unchanged. The CLI builds a
   * role's adapter through the same createWorker only for a non-default
   * `--planner-worker`/`--reviewer-worker` selection.
   */
  plannerWorker?: WorkerAdapter
  reviewerWorker?: WorkerAdapter
  /**
   * T-030 bounded R&D loop: total planning/implementation rounds (1..2 —
   * capped at 2 this slice, refused beyond that at the CLI). Default/absent
   * = 1 = the single-pass behavior exactly; no `rounds` block on the report.
   * At 2, round 1 runs as today and — when it produced at least one gate
   * survivor — the round composer (src/rounds.ts) renders the survivors'
   * evidence into the round-2 planner prompt, and a fresh candidate wave
   * (ids `<survivorId>-r2`, same baseSha) repeats the mechanics. Only
   * meaningful in planner mode (`--goal`): a `--jobs` run or `--no-planner`
   * has no planner phase to feed (refused at the CLI; a direct caller
   * passing `rounds: 2` with either gets round 2 recorded as not executed,
   * never fabricated).
   */
  rounds?: number
  /**
   * T-059 planner repo digest (R14's minimal context producer): compose a
   * deterministic file-tree/manifest digest of the TARGET repo at baseSha
   * (src/planner-digest.ts) and ride it through plannerPrompt's contextBlock
   * seam in BOTH planner rounds (round 2: joined before the composed
   * survivor-evidence block). The digest is prompt bytes, never access —
   * the planner's scratch cwd, capability posture ('--agent plan', T-023),
   * and parse path are untouched. Evidence: planner-digest.txt under the
   * artifacts dir + `RunReport.plannerDigest` (its sha256).
   *
   * SEAM DEFAULT — absent/false = today's exact prompt bytes, byte-identical
   * (the rounds/gateRetry seam pattern: a direct caller and every pinned
   * prompt face stay unchanged); the CLI resolves the run-level default TRUE
   * (`--no-planner-context` opts out, the --no-planner/--no-review idiom), so
   * every real CLI run carries the digest. A composition failure degrades
   * loudly to digest-less prompts (the premise-guard posture) and records
   * nothing — the report never claims context the planner did not receive.
   */
  plannerContext?: boolean
  workspaces: WorkspaceProvider
  artifactsDir: string
  /** Dispose workspaces after evidence capture instead of leaving them for inspection. */
  cleanWorkspaces: boolean
  /**
   * T-009 --jobs mode: the validated job spec's phases and fully resolved
   * jobs. Present ⇒ DAG-driven: no planner (briefs come from the jobs),
   * dispatch follows the deterministic ready function, and the run report
   * carries the schedule block. Absent ⇒ default mode: the degenerate
   * one-phase spec is synthesized from candidateIds + briefs and driven
   * through the same loop, with NO schedule block — today's behavior.
   */
  scheduled?: ScheduledRunSpec
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

/**
 * T-060: the full dispatched worker prompt — the engine-composed orientation
 * block (src/worker-orientation.ts) PREPENDED to the UNCHANGED builder
 * template, joined by one blank line. `orientationBlock` null = today's
 * exact bytes (the run's digest failed to compose — the loud degradation
 * logged once at run start; the premise-guard posture). The builder
 * template's own bytes never change: the planner-authored brief rides
 * verbatim inside it, `CandidateReport.brief` keeps the brief, and only
 * this engine-composed wrapper grows. Exported so the pinning gates
 * (1.24/1.27/1.35/1.46) compose the exact expected bytes through the same
 * seam — the builderPrompt precedent.
 */
export function workerDispatchPrompt(brief: string, workspacePath: string, orientationBlock: string | null): string {
  const builder = builderPrompt(brief, workspacePath)
  return orientationBlock === null ? builder : `${orientationBlock}\n\n${builder}`
}

/**
 * T-050: run the brief-premise guard over PLANNER-AUTHORED briefs before
 * they become jobs (rounds 1 AND 2 — the caller passes the round-1
 * survivors' changed paths for the round-2 call, empty for round 1).
 * `--jobs` briefs and raw-goal fallback briefs are operator-owned and never
 * reach this function. Never-break-a-run posture (the probes/verifier/
 * overlap pattern): a guard failure — most plausibly an unresolvable base
 * commit, which annotateBriefPremise treats as loud-degradation rather than
 * a silent everything-is-absent flood — logs once per brief and dispatches
 * that brief unannotated; an unannotated lie is exactly today's behavior,
 * never worse. Returns one entry per brief: undefined = inert (dispatch
 * today's exact bytes, write no evidence file).
 */
function annotatePlannerBriefs(
  opts: SkeletonOptions,
  briefs: readonly string[],
  survivorChangedPaths: readonly string[],
): (BriefPremiseAnnotation | undefined)[] {
  return briefs.map((brief) => {
    try {
      // null (inert) folds to undefined — one array shape for "dispatch
      // today's exact bytes".
      return annotateBriefPremise({ brief, repo: opts.repo, baseSha: opts.baseSha, survivorChangedPaths: [...survivorChangedPaths] }) ?? undefined
    } catch (e) {
      console.log(`brief-premise guard failed (${errorMessage(e)}); dispatching the brief unannotated`)
      return undefined
    }
  })
}

export async function runSkeleton(opts: SkeletonOptions): Promise<RunReport> {
  const startedAt = new Date().toISOString()
  mkdirSync(join(opts.artifactsDir, 'wt'), { recursive: true })
  // T-010: the run header is the first dispatch.jsonl line — recovery derives
  // the target repo and the retry bound (maxAttempts) from it after a crash.
  // T-038: the header carries `gateRetry: true` when the flag is set, so
  // recovery derives the one-attempt-taller bound; the field is absent
  // otherwise (the flag-less header is byte-identical to today's).
  appendDispatchEvidence(opts.artifactsDir, {
    type: 'run',
    runId: opts.runId,
    repo: opts.repo,
    baseSha: opts.baseSha,
    goal: opts.goal,
    model: opts.model,
    maxAttempts: opts.maxAttempts,
    ...(opts.gateRetry === true ? { gateRetry: true } : {}),
    startedAt,
  })

  // Planning tier (default mode only): one smart-model job turns the goal
  // into N distinct briefs. Failure here degrades gracefully — candidates
  // fall back to the raw goal. --jobs mode skips it entirely: briefs come
  // from the spec and the goal is not required.
  // T-050: PLANNER-AUTHORED briefs (and only those — fallback raw-goal
  // briefs below stay operator-owned) pass the brief-premise guard before
  // they become jobs: path-shaped tokens naming files absent at baseSha get
  // a fixed engine note appended. Round 1 has no survivor evidence, so
  // every absent path is the base-commit-absent kind.
  let briefs: string[] = opts.candidateIds.map(() => opts.goal)
  let planner: PlannerReport | undefined
  let premiseAnnotations: (BriefPremiseAnnotation | undefined)[] = []

  // T-059 planner repo digest + T-060 worker orientation share ONE digest
  // per run: composed ONCE here (repo + baseSha are fixed across rounds and
  // identical for every candidate) through the same list-form git discipline
  // the premise guard uses, before any planner or worker phase. Bytes, never
  // access: the digest rides plannerPrompt's contextBlock seam (T-059) and
  // the worker orientation block's tree section (T-060) — the planner's
  // scratch cwd, capability postures, and parse path are untouched below.
  // The digest's PLANNER-side evidence (planner-digest.txt +
  // RunReport.plannerDigest, one composition / two consumers) stays tied to
  // the planner-context flag exactly as T-059 pinned it (Gate 1.45 E2: flag
  // off ⇒ no file, no report field); since T-060 the digest is composed for
  // EVERY run regardless, because every worker dispatch carries the
  // orientation block. The never-break-a-run posture (the premise-guard
  // pattern): a composition failure — most plausibly an unreadable repo —
  // logs loudly ONCE here and the whole run degrades to today's exact prompt
  // bytes on both sides (no orientation block, no context block, no file, no
  // report field — the report never claims context any role did not
  // receive).
  let runDigest: PlannerDigest | null = null
  let plannerDigestBlock: string | null = null
  let plannerDigest: PlannerDigestRecord | undefined
  try {
    runDigest = composePlannerDigest({ repo: opts.repo, baseSha: opts.baseSha })
  } catch (e) {
    console.log(`planner digest failed (${errorMessage(e)}); planning without repo context and dispatching workers without the orientation tree — today's exact prompts`)
  }
  if (runDigest !== null && !opts.scheduled && opts.plannerModel && opts.plannerContext === true) {
    const digestPath = join(opts.artifactsDir, 'planner-digest.txt')
    writeFileSync(digestPath, runDigest.text)
    plannerDigestBlock = runDigest.text
    plannerDigest = { path: digestPath, sha256: runDigest.sha256 }
    console.log(`planner context: repo digest @ ${opts.baseSha.slice(0, 12)} — ${runDigest.listedPaths}/${runDigest.totalPaths} tracked paths, ${runDigest.text.length} chars${runDigest.truncated ? ` (TRUNCATED by the ${runDigest.cap} cap)` : ''}`)
  }

  if (!opts.scheduled && opts.plannerModel) {
    // Round 1 rides the digest alone as its context block (the round-2
    // composed block's parameter — the seam T-030 established). Digest-less
    // (opt-out, --jobs, --no-planner, or composition failure) ⇒ no round
    // object, today's exact call.
    planner = await runPlannerPhase(opts, plannerDigestBlock !== null
      ? { count: opts.candidateIds.length, contextBlock: plannerDigestBlock }
      : undefined)
    if (planner.ok) {
      briefs = planner.briefs
      premiseAnnotations = annotatePlannerBriefs(opts, briefs, [])
    }
    console.log(`planner: ${planner.ok ? `${briefs.length} briefs` : 'no valid output, using raw goal'} in ${(planner.durationMs / 1000).toFixed(0)}s (${planner.attempts} attempt${planner.attempts > 1 ? 's' : ''})`)
    console.log('')
  }

  // The job list the scheduler drives (T-009). --jobs mode: the resolved
  // specs. Default mode: the degenerate one-phase spec — one dependency-free
  // job per candidate, exactly T-006's derived DAG — so both modes run the
  // same loop; only the schedule recording differs. `brief` is always the
  // planner's (or operator's) text; the T-050 annotation rides separately
  // and is consumed at dispatch (runJob), never on the report.
  const jobs: ResolvedJob[] = opts.scheduled?.jobs ?? opts.candidateIds.map((id, i) => ({
    id,
    phaseId: DERIVED_PHASE_ID,
    dependencies: [],
    brief: briefs[i]!,
    ...(premiseAnnotations[i] !== undefined ? { premiseAnnotation: premiseAnnotations[i] } : {}),
    model: opts.model,
    worker: opts.worker,
    timeoutMs: opts.timeoutMs,
    gates: opts.gates,
  }))

  const round1 = await driveJobs(jobs, opts, runDigest)
  let candidates = jobs.map((j) => round1.reports.get(j.id)).filter((r): r is CandidateReport => r !== undefined)
  const schedule = opts.scheduled
    ? buildSchedule(opts.scheduled.phases, round1.nodes, round1.terminal, round1.dispatchIndexOf)
    : undefined
  // T-031: the early-stop evidence block — one record per phase that
  // DECLARED a policy, derived from the same inputs as the schedule block.
  // Present only when a `--jobs` phase declared one; default mode AND
  // policy-less `--jobs` runs carry no block (the report is unchanged).
  const earlyStops = opts.scheduled
    ? buildEarlyStops(opts.scheduled.phases, round1.nodes, round1.terminal, round1.dispatchIndexOf)
    : undefined

  // The bounded R&D loop (T-030): round 1's survivors are planning evidence
  // for one more round. The composer (src/rounds.ts) is pure and renders a
  // fixed-framing text block; the block rides the round-2 planner prompt —
  // prompt text, never capability — and round 2 re-enters the SAME
  // mechanics: runPlannerPhase unchanged (same artifact-only scratch-dir
  // posture, parseBriefs unchanged), then a fresh candidate wave through the
  // same scheduler loop on fresh state, leased at the SAME baseSha (survivor
  // diffs are planning evidence, never stacked patches — candidate lineage
  // is M8). Round-2 ids are `<survivorId>-r2` (SPEC_ID_PATTERN-safe), so
  // branches, store rows, and report entries never collide across rounds.
  // One runId, one checkout lock (held by the caller across both rounds);
  // dispatch.jsonl keeps its line shapes — round 2 is just more dispatch
  // lines after the one run header written above.
  const roundsWanted = opts.rounds ?? 1
  let rounds: RoundRecord[] | undefined
  if (roundsWanted >= 2) {
    const round1Survivors = candidates.filter((c) => c.passedAllGates)
    rounds = [{ round: 1, executed: true, survivorIds: round1Survivors.map((c) => c.id) }]
    // Round 2 needs a planner phase to feed: --jobs mode has none (the CLI
    // refuses the combination; a direct caller gets the round recorded as
    // not executed, never fabricated), and so does --no-planner. No
    // round-1 survivor means there is no evidence to compose from — round 2
    // is recorded not-executed rather than run blind.
    if (!opts.scheduled && opts.plannerModel !== null && round1Survivors.length > 0) {
      const composition = composeRoundPacket({ candidates, model: opts.plannerModel, finishedRound: 1 })
      const renderedBlockPath = join(opts.artifactsDir, 'round-2-context-block.txt')
      writeFileSync(renderedBlockPath, composition.renderedBlock)
      const round2Ids = round1Survivors.map((s) => `${s.id}-r2`)
      let briefs2: string[] = round2Ids.map(() => opts.goal)
      // T-059: round 2's planner is the same repo-blind specifier round 1's
      // is — the digest rides its prompt too, joined BEFORE the composed
      // survivor-evidence block (repo shape first, then the round's
      // evidence). Digest-less ⇒ the context block is the composed block
      // alone, byte-identical to pre-T-059.
      const round2ContextParts = [plannerDigestBlock, composition.renderedBlock].filter((p): p is string => p !== null)
      const planner2 = await runPlannerPhase(opts, {
        count: round2Ids.length,
        ...(round2ContextParts.length > 0 ? { contextBlock: round2ContextParts.join('\n\n') } : {}),
        evidenceTag: '-r2',
      })
      // T-050: the round-2 briefs pass the SAME premise guard, now with the
      // round-1 survivors' changed paths (the T-045 changedPaths seam's
      // output, recorded per candidate during the final-attempt diff
      // derivation) as survivor evidence — a brief naming a file a
      // survivor's diff CREATED gets the survivor-created reason (the Known
      // issue #6 mechanism), anything else absent gets the base-commit note.
      let premiseAnnotations2: (BriefPremiseAnnotation | undefined)[] = []
      if (planner2.ok) {
        briefs2 = planner2.briefs
        premiseAnnotations2 = annotatePlannerBriefs(
          opts,
          briefs2,
          round1Survivors.flatMap((s) => round1.changedPathsById.get(s.id) ?? []),
        )
      }
      console.log(`planner (round 2): ${planner2.ok ? `${briefs2.length} briefs` : 'no valid output, using raw goal'} in ${(planner2.durationMs / 1000).toFixed(0)}s (${planner2.attempts} attempt${planner2.attempts > 1 ? 's' : ''})`)
      console.log('')
      const jobs2: ResolvedJob[] = round2Ids.map((id, i) => ({
        id,
        phaseId: DERIVED_PHASE_ID,
        dependencies: [],
        brief: briefs2[i]!,
        ...(premiseAnnotations2[i] !== undefined ? { premiseAnnotation: premiseAnnotations2[i] } : {}),
        model: opts.model,
        worker: opts.worker,
        timeoutMs: opts.timeoutMs,
        gates: opts.gates,
      }))
      const round2 = await driveJobs(jobs2, opts, runDigest)
      const candidates2 = jobs2.map((j) => round2.reports.get(j.id)).filter((r): r is CandidateReport => r !== undefined)
      rounds.push({
        round: 2,
        executed: true,
        survivorIds: candidates2.filter((c) => c.passedAllGates).map((c) => c.id),
        packetFingerprint: composition.packet.fingerprint.hash,
        renderedBlockPath,
      })
      candidates = [...candidates, ...candidates2]
      planner = planner2
    } else {
      rounds.push({ round: 2, executed: false, survivorIds: [] })
    }
  }

  const report: RunReport = {
    runId: opts.runId,
    repo: opts.repo,
    baseSha: opts.baseSha,
    goal: opts.goal,
    model: opts.model,
    // The last executed planner phase's report — round 2's when the loop
    // ran (the planner whose briefs the final candidate wave rode), round
    // 1's otherwise. Round 1's planner evidence stays on disk at today's
    // paths (planner.log / planner-raw.txt).
    planner,
    startedAt,
    finishedAt: new Date().toISOString(),
    // Report order follows the spec order (candidateIds order in default
    // mode) — today's summary/ingest order. Only dispatched jobs appear: a
    // never-dispatched job is recorded as not-dispatched in the schedule
    // block, never fabricated as a candidate. Round-2 candidates append
    // after round 1's, in round-1 survivor order.
    candidates,
  }
  if (schedule) {
    report.schedule = schedule
  }
  // T-059: the digest's run-level evidence — present only when the digest
  // actually rode the planner prompts (the producer-only pattern; a
  // composition failure records nothing).
  if (plannerDigest !== undefined) {
    report.plannerDigest = plannerDigest
  }
  if (earlyStops !== undefined && earlyStops.length > 0) {
    report.earlyStops = earlyStops
  }
  if (rounds !== undefined) {
    report.rounds = rounds
  }
  // T-049: the yield block — the A2 measuring stick, derived mechanically
  // from the finished report (src/yield.ts) AFTER every other block is
  // attached, so the derivation sees the same report.json a reader will.
  // Producer-only: no machine-known no-op elimination → no block, and the
  // report shape is byte-identical to pre-T-049. Evidence only, never a
  // verdict input (the probes/verifier posture): a derivation failure logs
  // and records nothing — an instrument must never break the run it
  // measures.
  try {
    const yieldBlock = deriveRunYield(report)
    if (yieldBlock !== null) report.yield = yieldBlock
  } catch (e) {
    console.log(`yield derivation failed: ${errorMessage(e)}`)
  }
  writeFileSync(join(opts.artifactsDir, 'report.json'), JSON.stringify(report, null, 2))
  return report
}

/** The dispatch-eligible nodes: the job DAG minus the early-stop-suppressed
 *  jobs (T-031). This filtering MUST happen BEFORE `readyJobs` applies its
 *  concurrency-cap slice, not after it: a suppressed-but-ready job sorting
 *  ahead of another phase's ready job would otherwise occupy the whole cap
 *  slice every iteration, strand that phase's dispatchable work for the rest
 *  of the run, and record a false 'blocked' (review round 1 red — ES7 pins
 *  exactly that adversarial ordering). A stopped phase may only skip its OWN
 *  undispatched work; it never consumes another phase's dispatch capacity.
 *  Suppression is monotone (a met policy stays met), so recomputing the
 *  filter per iteration is stable. No policies ⇒ no suppression ⇒ the
 *  caller passes the input through unchanged. */
function eligibleForDispatch(
  nodes: { id: string; phaseId: string; dependencies: string[] }[],
  suppressed: ReadonlySet<string>,
): { id: string; phaseId: string; dependencies: string[] }[] {
  return suppressed.size === 0 ? nodes : nodes.filter((n) => !suppressed.has(n.id))
}

/** The scheduler loop (T-009): repeatedly take the deterministic ready list
 *  and dispatch up to the concurrency cap. dispatchIndex is a job's position
 *  in the run's dispatch order; terminal states feed the next ready call. A
 *  job whose dependencies can never reach terminal success (an upstream
 *  failure) is simply never dispatched — recorded, not fabricated. Each
 *  round of the bounded loop (T-030) drives its own job wave through this
 *  one loop with fresh state — the round-2 wave shares no terminal/dispatch
 *  bookkeeping with round 1's.
 *
 *  T-031 phase-level early stop (spec §20): policies come ONLY from the
 *  --jobs spec's phases (`opts.scheduled`); default mode has none and the
 *  loop is untouched. Per iteration, a phase whose policy is MET (the pure
 *  `earlyStopMet` — monotone, since terminal success never un-happens) has
 *  its not-yet-dispatched jobs filtered out of the dispatch-eligible input
 *  BEFORE the ready call's concurrency-cap slice (`eligibleForDispatch`) —
 *  a stopped phase never occupies another phase's dispatch capacity. The
 *  stop ONLY suppresses dispatch: an in-flight job runs to completion —
 *  never killed, no cancellation path; a suppressed job stays non-terminal,
 *  records `dispatchIndex: null` (not-dispatched, never fabricated as
 *  terminal), and its dependents are never ready (readyJobs requires
 *  dependencies at terminal success). Termination is unchanged: suppressed
 *  jobs never dispatch, `inFlight` drains, the `inFlight.size === 0` break
 *  fires exactly as before. A dispatched job's verdict ladder below dispatch
 *  is untouched by the stop. */
async function driveJobs(jobs: ResolvedJob[], opts: SkeletonOptions, runDigest: PlannerDigest | null): Promise<{
  reports: Map<string, CandidateReport>
  terminal: Map<string, 'succeeded' | 'failed'>
  dispatchIndexOf: Map<string, number>
  nodes: { id: string; phaseId: string; dependencies: string[] }[]
  changedPathsById: Map<string, string[]>
}> {
  const nodes = jobs.map((j) => ({ id: j.id, phaseId: j.phaseId, dependencies: j.dependencies }))
  const byId = new Map(jobs.map((j) => [j.id, j]))
  const terminal = new Map<string, 'succeeded' | 'failed'>()
  const running = new Set<string>()
  const inFlight = new Set<Promise<void>>()
  const dispatchIndexOf = new Map<string, number>()
  const reports = new Map<string, CandidateReport>()
  // T-050: each wave's per-candidate changed paths (the T-045 seam's output,
  // recorded where the overlap block already derives it) — the round-2
  // brief-premise guard's survivor-evidence input. In-run state only, never
  // serialized: a wave's map dies with the wave, exactly like its terminal
  // bookkeeping.
  const changedPathsById = new Map<string, string[]>()
  let dispatched = 0
  // T-031: the declaring phases' policies, by phase id (default mode: empty
  // ⇒ no stop input anywhere). Once met, a policy stays met.
  const stopPolicies = new Map<string, EarlyStopPolicy>()
  for (const p of opts.scheduled?.phases ?? []) {
    if (p.earlyStop !== undefined) stopPolicies.set(p.id, p.earlyStop)
  }
  const suppressed = new Set<string>()
  for (;;) {
    if (stopPolicies.size > 0) {
      for (const [phaseId, policy] of stopPolicies) {
        if (earlyStopMet(policy, nodes.filter((n) => n.phaseId === phaseId), terminal)) {
          for (const n of nodes) {
            if (n.phaseId === phaseId) suppressed.add(n.id)
          }
        }
      }
    }
    for (const id of readyJobs(eligibleForDispatch(nodes, suppressed), terminal, running, opts.concurrency)) {
      const job = byId.get(id)!
      dispatchIndexOf.set(id, dispatched++)
      running.add(id)
      const p = runJob(job, opts, runDigest, changedPathsById).then((rep) => {
        reports.set(id, rep)
        terminal.set(id, rep.passedAllGates ? 'succeeded' : 'failed')
      }).finally(() => {
        running.delete(id)
        inFlight.delete(p)
      })
      inFlight.add(p)
    }
    if (inFlight.size === 0) break
    await Promise.race([...inFlight])
  }
  return { reports, terminal, dispatchIndexOf, nodes, changedPathsById }
}

function plannerPrompt(goal: string, count: number, contextBlock?: string): string {
  const lines = [
    'You are the planning tier of a multi-candidate implementation system.',
    `GOAL: ${goal}`,
  ]
  // T-030: the round composer's rendered block rides as an optional section
  // between the goal and the output contract — prompt text, never
  // capability: the planner keeps its artifact-only scratch-dir posture and
  // parseBriefs parses the reply exactly as round 1's. Absent (every n=1
  // run) ⇒ the prompt is byte-identical to the pre-T-030 text.
  // T-059: the planner repo digest rides the SAME parameter — round 1's
  // context block is the digest alone, round 2's is digest + composed
  // survivor block. Same posture: bytes, never access; absent ⇒ byte-
  // identical to today.
  if (contextBlock !== undefined) {
    lines.push('', contextBlock)
  }
  lines.push(
    '',
    `Produce exactly ${count} distinct implementation briefs, one per candidate worker.`,
    'Each brief must be self-contained, concrete, and independently implementable as a small diff.',
    'Where the goal allows more than one approach, vary the approach across briefs.',
    'Do not reference "the other briefs"; each worker sees only its own.',
    '',
    `Output ONLY a JSON array of ${count} strings. No markdown fences, no commentary.`,
  )
  return lines.join('\n')
}

const MAX_DIFF_CHARS = 30_000

/**
 * T-040: the retry brief's findings section is bounded by these documented
 * constants — CLI config for them is carved (the ticket), so the values live
 * here, exported for the pinning gate (Gate 1.27). Top-N: at most
 * MAX_RETRY_FINDINGS eligible findings ride the brief, in the verifier's own
 * order. Char cap: each finding's `finding` and `evidence` string is capped
 * at MAX_RETRY_FINDING_CHARS (the MAX_DIFF_CHARS precedent, narrowed from a
 * whole-section cap to a per-string cap so one huge evidence blob cannot
 * crowd out the other findings). A flood of findings must not drown the gate
 * output, which stays the primary payload.
 */
export const MAX_RETRY_FINDINGS = 5
export const MAX_RETRY_FINDING_CHARS = 2_000

/**
 * T-047: the ignored-path parity summary's entry cap, a documented constant
 * (the MAX_RETRY_FINDINGS pattern) — at most MAX_IGNORED_PATHS entries of
 * the porcelain `!!` set ride `CandidateReport.ignoredPaths.entries`. The
 * cap bounds the REPORT summary only: the attempt's `ignored-paths.txt`
 * evidence file keeps the full snapshot, and `count` records the true
 * pre-cap total (the gateRetry.findings.count provenance pattern). Ignored
 * directories ride collapsed (`!! node_modules/` is one line, default
 * porcelain untracked mode), so the cap is a flood guard, not a
 * dependency-tree limit.
 */
export const MAX_IGNORED_PATHS = 50

function reviewerPrompt(brief: string, workspacePath: string, diff: string, gateLines: string[]): string {
  const truncated = diff.length > MAX_DIFF_CHARS
  return [
    'You are the review tier of a multi-candidate implementation system.',
    'A worker implemented a brief and all machine gates passed.',
    'Produce advisory observations for a human reviewer. You never decide survival.',
    '',
    'Do not modify any files. Reading the repository below for context is encouraged.',
    `  ${workspacePath}`,
    '',
    `BRIEF the worker was given:`,
    brief,
    '',
    'MACHINE GATE RESULTS:',
    ...gateLines,
    '',
    `CANDIDATE DIFF${truncated ? ` (truncated to ${MAX_DIFF_CHARS} chars)` : ''}:`,
    diff.slice(0, MAX_DIFF_CHARS),
    '',
    'Output ONLY a JSON object, no markdown fences, no commentary:',
    '{"observations": [{"finding": "<one concrete observation>", "severity": "info" | "concern" | "blocker-advisory", "evidence": "<what you looked at>"}]}',
    'Give 2 to 6 observations. severities: info = worth knowing, concern = possible problem,',
    'blocker-advisory = would block merge if a human agrees.',
  ].join('\n')
}

/** One planner phase's round-scoped inputs (T-030): the candidate count the
 *  prompt asks briefs for, the composer's rendered context block to embed
 *  (round 2 only), and the evidence-filename tag keeping a second round's
 *  planner evidence from overwriting round 1's (round 2 writes
 *  planner-r2.log / planner-r2-raw.txt; round 1 keeps today's paths). */
interface PlannerRound {
  count: number
  contextBlock?: string
  evidenceTag?: string
}

async function runPlannerPhase(opts: SkeletonOptions, round?: PlannerRound): Promise<PlannerReport> {
  // T-025: the planner rides its own adapter when one was selected,
  // otherwise the run-level worker — the flags-absent default is today's
  // behavior exactly. One local covers both execute calls (they share baseReq).
  const worker = opts.plannerWorker ?? opts.worker
  const count = round?.count ?? opts.candidateIds.length
  const prompt = plannerPrompt(opts.goal, count, round?.contextBlock)
  const logPath = join(opts.artifactsDir, `planner${round?.evidenceTag ?? ''}.log`)
  const rawOutputPath = join(opts.artifactsDir, `planner${round?.evidenceTag ?? ''}-raw.txt`)
  const started = Date.now()

  // T-023 (spec §3.6:144, §14): the planner's capability posture is
  // mechanism-level now, not prompt-reinforced. Its cwd is a fresh disposable
  // scratch dir under the run artifacts — never the canonical checkout
  // (ground rule 3), never any repo — with the 'artifact-only' policy passed
  // explicitly so the adapter restricts the spawn. The prompt names no repo
  // path (plannerPrompt: goal + count only), so this removes an accidental
  // capability, not a used one. Scratch contents are never evidence:
  // planner evidence stays planner.log + planner-raw.txt. Both execute calls
  // (initial + repair) share baseReq, so one change covers both.
  const scratchDir = join(opts.artifactsDir, 'planner-scratch')
  mkdirSync(scratchDir, { recursive: true })
  try {
    const baseReq = {
      model: opts.plannerModel!,
      cwd: scratchDir,
      logPath,
      timeoutMs: opts.timeoutMs,
      executionPolicy: 'artifact-only',
    } as const
    let result = await worker.execute({ ...baseReq, prompt })
    let attempts = 1
    let briefs = result.ok ? parseBriefs(result.responseTail, count) : null

    if (!briefs && !result.timedOut) {
      attempts = 2
      console.log('planner: output was not a valid JSON array, running one bounded repair attempt')
      result = await worker.execute({
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
  } finally {
    // Best-effort removal — the scratch dir is never evidence, and cleanup
    // failure must not mask the planner's report.
    try {
      rmSync(scratchDir, { recursive: true, force: true })
    } catch {
      // Best-effort by contract.
    }
  }
}

async function runReview(
  opts: SkeletonOptions,
  ctx: { id: string; dir: string; workspacePath: string; brief: string; diff: string; gateLines: string[] },
): Promise<ReviewReport> {
  // T-025: the reviewer rides its own adapter when one was selected (in BOTH
  // modes — review runs post-gates in both), otherwise the run-level worker.
  // One local covers both execute calls (they share baseReq).
  const worker = opts.reviewerWorker ?? opts.worker
  const prompt = reviewerPrompt(ctx.brief, ctx.workspacePath, ctx.diff, ctx.gateLines)
  const logPath = join(ctx.dir, 'reviewer.log')
  const rawOutputPath = join(ctx.dir, 'review-raw.txt')
  const started = Date.now()

  // T-023 (spec §14): the reviewer's posture is mechanism-level now — the
  // 'worktree-read' policy is passed explicitly and the OpenCode adapter
  // restricts the spawn to its plan agent (edit tools deny-listed). The cwd
  // stays the candidate worktree lease: a disposable workspace whose diff
  // and gate results were already captured into evidence files before review
  // runs (the capture is above; review is invoked below), so the canonical
  // repo is never exposed either way. The prompt's "Do not modify any files"
  // line stays as reinforcement (decisions.md: prompts are
  // defense-in-depth, never the boundary).
  const baseReq = {
    model: opts.reviewerModel!,
    cwd: ctx.workspacePath,
    logPath,
    timeoutMs: opts.timeoutMs,
    executionPolicy: 'worktree-read',
  } as const
  let result = await worker.execute({ ...baseReq, prompt })
  let attempts = 1
  let review = result.ok ? parseReview(result.responseTail) : null

  if (!review && !result.timedOut) {
    attempts = 2
    console.log(`[${ctx.id}] review: output was not a valid observation object, running one bounded repair attempt`)
    result = await worker.execute({
      ...baseReq,
      prompt: [
        prompt,
        '',
        'Your previous response was not a valid JSON observations object. Previous response:',
        result.responseTail,
        '',
        'Output ONLY the JSON object: {"observations": [{"finding": "...", "severity": "info" | "concern" | "blocker-advisory", "evidence": "..."}]}. No other text.',
      ].join('\n'),
    })
    review = result.ok ? parseReview(result.responseTail) : null
  }

  writeFileSync(rawOutputPath, result.responseTail)
  const report: ReviewReport = {
    ok: review !== null,
    attempts,
    model: opts.reviewerModel!,
    observations: review?.observations ?? [],
    rawOutputPath,
  }
  writeFileSync(join(ctx.dir, 'review.json'), JSON.stringify(report, null, 2))
  const severities = report.observations.map((o) => o.severity).join(', ')
  console.log(`[${ctx.id}] review: ${report.observations.length} observation(s) in ${((Date.now() - started) / 1000).toFixed(0)}s${report.observations.length > 0 ? ` (${severities})` : ''}${report.ok ? '' : ' — PARSE FAILED after repair'}`)
  return report
}

/**
 * The T-039 verifier prompt (the reviewerPrompt template): the brief, the
 * captured diff (char-capped at the MAX_DIFF_CHARS precedent), and the list
 * of gates that ALREADY ran — with names, commands, and verdicts — then the
 * novelty directive: these machine checks already ran; do not merely re-run
 * the suite; run NEW checks — edge cases, timing, adversarial inputs — and
 * cite every command you ran and its output (spec §3.3: evidence before
 * interpretation; a finding without its command and output is not evidence).
 * The output contract is the reviewer's observations object, parsed by the
 * same parseReview.
 */
function verifierPrompt(brief: string, workspacePath: string, diff: string, gateLines: string[]): string {
  const truncated = diff.length > MAX_DIFF_CHARS
  return [
    'You are the verification tier of a multi-candidate implementation system.',
    'A worker implemented a brief, the candidate diff below was already captured, and the machine gates listed below already ran.',
    'Your job is ACTIVE verification, not re-review: run NEW checks yourself — edge cases, timing, adversarial inputs,',
    'boundary conditions — against the candidate workspace. Do not merely re-run the gates that already ran.',
    '',
    'You may run commands inside the workspace below. Never modify any files:',
    'the diff evidence was already captured before you run, and your value is the findings, not the changes.',
    `  ${workspacePath}`,
    '',
    `BRIEF the worker was given:`,
    brief,
    '',
    'MACHINE GATES THAT ALREADY RAN (do not just re-run these):',
    ...gateLines,
    '',
    `CANDIDATE DIFF${truncated ? ` (truncated to ${MAX_DIFF_CHARS} chars)` : ''}:`,
    diff.slice(0, MAX_DIFF_CHARS),
    '',
    'Cite EVERY command you ran and the exact output you saw, in the evidence field. A finding without',
    'the command that produced it and that command\'s output is not evidence.',
    '',
    'Output ONLY a JSON object, no markdown fences, no commentary:',
    '{"observations": [{"finding": "<one concrete finding>", "severity": "info" | "concern" | "blocker-advisory", "evidence": "<commands run + output cited>"}]}',
    'Give 2 to 6 observations. severities: info = worth knowing, concern = possible problem,',
    'blocker-advisory = would block merge if a human agrees. Your findings never change the run verdict.',
  ].join('\n')
}

/**
 * One verifier run on a candidate's attempt (T-039 final-attempt call;
 * T-040 adds the PRE-RETRY call at the same seam): the runReview
 * parse-with-repair shape — one bounded repair attempt on invalid output,
 * parse failure degrading to `ok: false` with empty observations, never
 * verdict-affecting — riding the 'worktree-read' posture (see below) and
 * persisting the raw model output as `verifier-raw.txt` (the review-raw.txt
 * pattern) beside `verifier.log`. `evidenceTag` (T-040, optional — absent on
 * the T-039 call, whose paths are byte-identical) distinguishes a second
 * call's evidence files within one candidate so neither leg's raw output can
 * overwrite the other's (the planner round-tag precedent).
 */
async function runVerifier(
  opts: SkeletonOptions,
  ctx: { id: string; dir: string; workspacePath: string; brief: string; diff: string; gateLines: string[]; evidenceTag?: string },
): Promise<VerifierReport> {
  // T-025 pattern: the verifier rides its own adapter when one was selected
  // (--verifier-worker), otherwise the run-level worker. One local covers
  // both execute calls (initial + the bounded repair) — they share baseReq.
  const worker = opts.verifierWorker ?? opts.worker
  const prompt = verifierPrompt(ctx.brief, ctx.workspacePath, ctx.diff, ctx.gateLines)
  const logPath = join(ctx.dir, `verifier${ctx.evidenceTag ?? ''}.log`)
  const rawOutputPath = join(ctx.dir, `verifier${ctx.evidenceTag ?? ''}-raw.txt`)
  const started = Date.now()

  // T-023 (spec §14): the verifier rides the SAME restricted posture as the
  // reviewer — 'worktree-read', passed explicitly, enforced at the adapter
  // with refuse-not-downgrade. T-039's step-one probe
  // (scripts/diag-execute.mjs, run against the vendored harness) answered
  // that this posture is EXECUTE-CAPABLE — the plan agent runs commands
  // while its edit tools stay deny-listed — which is exactly the
  // execute-but-don't-mutate split the verifier needs, so no additional
  // ExecutionPolicy value was added. The cwd is the candidate worktree
  // lease: a disposable workspace whose diff evidence was captured before
  // the verifier runs, so nothing the verifier does can dirty it — and never
  // the canonical checkout (ground rule 3). The prompt's "never modify any
  // files" line stays as reinforcement (decisions.md: prompts are
  // defense-in-depth, never the boundary).
  const baseReq = {
    model: opts.verifierModel!,
    cwd: ctx.workspacePath,
    logPath,
    timeoutMs: opts.timeoutMs,
    executionPolicy: 'worktree-read',
  } as const
  let result = await worker.execute({ ...baseReq, prompt })
  let attempts = 1
  let parsed = result.ok ? parseReview(result.responseTail) : null

  if (!parsed && !result.timedOut) {
    attempts = 2
    console.log(`[${ctx.id}] verifier: output was not a valid observation object, running one bounded repair attempt`)
    result = await worker.execute({
      ...baseReq,
      prompt: [
        prompt,
        '',
        'Your previous response was not a valid JSON observations object. Previous response:',
        result.responseTail,
        '',
        'Output ONLY the JSON object: {"observations": [{"finding": "...", "severity": "info" | "concern" | "blocker-advisory", "evidence": "..."}]}. No other text.',
      ].join('\n'),
    })
    parsed = result.ok ? parseReview(result.responseTail) : null
  }

  writeFileSync(rawOutputPath, result.responseTail)
  const report: VerifierReport = {
    model: opts.verifierModel!,
    ok: parsed !== null,
    attempts,
    observations: parsed?.observations ?? [],
    rawOutputPath,
  }
  const severities = report.observations.map((o) => o.severity).join(', ')
  console.log(`[${ctx.id}] verifier: ${report.observations.length} finding(s) in ${((Date.now() - started) / 1000).toFixed(0)}s${report.observations.length > 0 ? ` (${severities})` : ''}${report.ok ? '' : ' — PARSE FAILED after repair'}`)
  return report
}

/** §7.7 context fingerprint, narrowed to what has a producer: sha256 over
 *  brief + model + the composed prompt with the workspace-path line excluded,
 *  so the same brief+model hashes identically across attempts (an
 *  input-context hash compares inputs, not worktree paths). T-060 scope note:
 *  "the composed prompt" here stays the BUILDER TEMPLATE — the orientation
 *  block (engine mechanics, identical across a run's candidates but for the
 *  per-attempt lease path, exactly like the excluded workspace line) is
 *  deliberately not hashed; recording the exact dispatched text is
 *  promptVersion's job, and it moves (Gate 1.46). The full fingerprint adds
 *  prompt version, role version, selected artifact IDs/hashes, reasoning
 *  configuration, and project-manifest version (§7.7:615-620) — none has a
 *  producer until the Milestone-2 context system. */
function inputContextHash(brief: string, model: string, workspacePath: string): string {
  const promptWithoutWorkspace = builderPrompt(brief, workspacePath)
    .split('\n')
    .filter((line) => line !== `  ${workspacePath}`)
    .join('\n')
  return createHash('sha256').update(`${brief}\n${model}\n${promptWithoutWorkspace}`).digest('hex')
}

/** T-038: the composed feedback brief for the one bounded gate retry — pure
 *  string assembly in the runner, no model call composes or adjudicates it
 *  (decisions.md 2026-10-21). Fixed framing: the change WAS applied and
 *  these machine gates rejected it; fix the failures — the same gates re-run
 *  unchanged on the new attempt. Content: the original brief, the failing
 *  attempt's captured diff (char-capped at MAX_DIFF_CHARS, the
 *  reviewer-prompt precedent), per FAILING gate its name, its recorded
 *  command (`GateResult.command`, T-027) and its `outputTail` (the 4000-byte
 *  tail, src/gate/command.ts), and the worker's attempt summary where the
 *  harness produced one. Passing gates contribute nothing.
 *
 *  T-040: `findings` — the ELIGIBLE observations (severity blocker-advisory |
 *  concern, pre-filtered by the caller) from the pre-retry verification —
 *  ride as a section AFTER the gates section, top-N bounded at
 *  MAX_RETRY_FINDINGS and per-string char-capped at MAX_RETRY_FINDING_CHARS
 *  (both documented, exported above): a flood of findings must not drown the
 *  gate output, which stays the primary payload. The caller may pass none
 *  (no verifier configured, parse failure, verifier crash, zero eligible
 *  findings) — the brief is then byte-identical to T-038's composition, no
 *  empty section. The returned fingerprint is the sha256 of the exact text —
 *  findings included by construction — the bytes written to the retry
 *  attempt's `retry-brief.txt` AND wrapped into its prompt (the T-030
 *  packetFingerprint pattern; one composition, two consumers).
 *  `includedFindings` is the number actually embedded (≤ findings.length),
 *  the `gateRetry.findings.included` provenance.
 *
 *  T-061: EMBEDDED-EVIDENCE FENCING at this seam — every failing gate's
 *  recorded `outputTail` rides inside a role-labeled plain-text fence
 *  (src/evidence-fence.ts) carrying the fixed not-instructions line, the
 *  bytes VERBATIM (never sanitized — the T-029 fixture-faithfulness rule).
 *  Gate output is target-repo-influenced (test names and assertion messages
 *  are attacker-writable content in the target repo); the fence makes the
 *  provenance legible to the worker that reads the brief and decides
 *  nothing. The tail's own 4,000-byte capture cap (T-027,
 *  src/gate/command.ts) stays the evidence's bound — no second cap here.
 *  The findings section below keeps its T-040 caps UNCHANGED
 *  (MAX_RETRY_FINDINGS / MAX_RETRY_FINDING_CHARS). The next seam that
 *  embeds recorded evidence into a model-bound prompt copies this
 *  discipline (the fence module's docblock states it in full). */
function composeGateRetryBrief(
  brief: string,
  diff: string,
  failedGates: GateResult[],
  workerSummary: string,
  findings: ReviewObservation[] = [],
): { text: string; fingerprint: string; includedFindings: number } {
  const truncated = diff.length > MAX_DIFF_CHARS
  const lines = [
    'Your previous attempt below WAS APPLIED to the workspace, but the machine gates REJECTED it.',
    'Fix the gate failures. The SAME machine gates re-run unchanged on this new attempt.',
    '',
    'ORIGINAL BRIEF:',
    brief,
    '',
    `YOUR PREVIOUS DIFF${truncated ? ` (truncated to ${MAX_DIFF_CHARS} chars)` : ''}:`,
    diff.slice(0, MAX_DIFF_CHARS),
    '',
  ]
  const summary = workerSummary.trim()
  if (summary !== '') {
    lines.push('YOUR PREVIOUS ATTEMPT SUMMARY:', summary, '')
  }
  lines.push('FAILED MACHINE GATES:')
  for (const g of failedGates) {
    lines.push(
      '',
      `GATE: ${g.name}`,
      `COMMAND: ${g.command ?? '(not recorded)'}`,
      'OUTPUT (tail):',
      // T-061: the recorded tail rides inside the role-labeled fence —
      // bytes verbatim between the markers, provenance legible to the
      // worker, nothing sanitized (src/evidence-fence.ts's discipline).
      fenceRecordedEvidence(RECORDED_GATE_OUTPUT_LABEL, g.outputTail),
    )
  }
  const included = findings.slice(0, MAX_RETRY_FINDINGS)
  if (included.length > 0) {
    const cap = (s: string) => (s.length > MAX_RETRY_FINDING_CHARS ? s.slice(0, MAX_RETRY_FINDING_CHARS) : s)
    lines.push(
      '',
      'VERIFIER FINDINGS (advisory — a verifier actively tested the previous attempt; fix these too. The SAME machine gates still decide):',
    )
    for (const f of included) {
      lines.push(
        '',
        `FINDING (${f.severity}): ${cap(f.finding)}`,
        `EVIDENCE: ${cap(f.evidence ?? '(none cited)')}`,
      )
    }
  }
  const text = lines.join('\n')
  return { text, fingerprint: createHash('sha256').update(text).digest('hex'), includedFindings: included.length }
}

/** Execute one job (T-009): the T-007 attempt loop verbatim, with the job's
 *  resolved config in place of the run-level fields. The first attempt's
 *  worktree is leased LAZILY here — when the scheduler dispatches the job —
 *  at the run's baseSha, never up front; retry attempts lease their own
 *  fresh worktree (wt/<jobId>-a<n>) at the same baseSha. A mechanical
 *  failure (throw or !workerOk) requeues as a fresh attempt while the
 *  maxAttempts bound allows; a succeeded-but-no-op or no-gates leg is a
 *  verdict and is never re-rolled (decisions.md: gates decide survival).
 *
 *  T-038: under `--gate-retry`, a worker-succeeded attempt whose captured
 *  diff is non-zero but whose machine gates reject it gets EXACTLY ONE more
 *  attempt (a flag-firing attempt is recorded 'failed' with reason
 *  'gates-failed', its gate results attached attempt-scoped) — the retry
 *  brief composed mechanically from the gates' own recorded output. The
 *  bound is one per candidate regardless of maxAttempts (total attempts
 *  ≤ maxAttempts + 1). The retry brief becomes the retry attempt's brief:
 *  its promptVersion and inputContextHash hash the composed text (the hash
 *  correctly differs from attempt 1's — the brief differs), while
 *  `base.brief` keeps the ORIGINAL brief. T-040: before composition, the
 *  retry-eligible leg is itself verified (the pre-retry verifier call site)
 *  and its eligible findings ride the composed brief under documented caps —
 *  still no model call composes the brief, still zero verdict inputs. Blind
 *  re-rolls stay banned (decisions.md 2026-10-21). */
async function runJob(job: ResolvedJob, opts: SkeletonOptions, runDigest: PlannerDigest | null, changedPathsById?: Map<string, string[]>): Promise<CandidateReport> {
  const id = job.id
  const dir = join(opts.artifactsDir, id)
  mkdirSync(dir, { recursive: true })
  const base: CandidateReport = {
    id,
    workerId: job.worker.id,
    model: job.model,
    brief: job.brief,
    workspacePath: null,
    workerOk: false,
    workerTimedOut: false,
    workerDurationMs: 0,
    diffPath: null,
    diffBytes: 0,
    gates: [],
    passedAllGates: false,
    attempts: [],
  }

  let lease: WorkspaceLease | null = null
  // T-011: cleanup failures accumulate across the job's attempts (worker-side
  // from every executed attempt, gate-side from the final one) and land on
  // the candidate report — recorded evidence that never changes a verdict
  // (decisions.md: gates decide survival).
  const cleanupFailures: string[] = []
  // T-038: the brief the CURRENT attempt is dispatched with — the original
  // brief for attempt 1, the composed feedback brief for a gate-retry leg.
  // `base.brief` keeps the ORIGINAL brief; the composed text is attempt-scoped
  // evidence, never a replacement.
  // T-050: when the premise guard fired for this job's brief, EVERY attempt
  // dispatches the ANNOTATED text (the premise is about the base commit, not
  // about any one attempt) — `base.brief` still keeps the planner's text,
  // and the before/after evidence lands in brief-premise.txt below.
  let attemptBrief = job.premiseAnnotation !== undefined ? job.premiseAnnotation.annotated : job.brief
  // T-038: the composed retry brief, composed ONCE per retry (below) and
  // consumed at the top of the retry leg's iteration — one composition, two
  // consumers: the exact prompt text (hashed into that attempt's
  // promptVersion) and the `retry-brief.txt` evidence file.
  let pendingRetryBrief: string | null = null
  // T-038: the bound is one gate-retry per candidate, regardless of
  // maxAttempts (total attempts ≤ maxAttempts + 1).
  let gateRetryUsed = false
  for (let n = 1; ; n++) {
    // Attempt-scoped lease id (T-007): two leases on `wt/<id>` would both
    // derive `swarm/wt-<id>` (the T-004 branch-collision hazard), and
    // attempt 2 would overwrite attempt 1's worker.log. Job ids are unique
    // per spec and charset-restricted (src/scheduler.ts), so the branches
    // cannot collide mid-run. Attempts ≥ 2 get their own evidence directory.
    lease = opts.workspaces.lease(n === 1 ? `wt/${id}` : `wt/${id}-a${n}`, opts.baseSha)
    base.workspacePath = lease.path
    const evidenceDir = n === 1 ? dir : join(dir, `attempt-${n}`)
    mkdirSync(evidenceDir, { recursive: true })
    const logPath = join(evidenceDir, 'worker.log')
    const diffPath = join(evidenceDir, 'diff.patch')

    // T-029 (spec §6.7:446 — "Every agent attempt records the exact prompt
    // version used"): the builder prompt is composed ONCE per attempt, and the
    // SAME variable is both hashed into `promptVersion` and sent to the
    // adapter below — the hashed bytes and the sent bytes cannot drift. The
    // version is an EXACT-TEXT sha256, not a workspace-normalized template
    // hash: the prompt embeds the lease path, whose runDir carries the
    // timestamped runId, and retry attempts lease fresh paths (wt/<id>-a<n>),
    // so promptVersion values are unique per attempt by construction. That is
    // the point: cross-attempt input comparability is `inputContextHash`'s job
    // (sha256 over brief + model + the prompt with the workspace-path line
    // excluded — identical across same-brief attempts). The two fields answer
    // different questions — inputContextHash: "was this attempt asked the same
    // thing as that one?"; promptVersion: "is this the hash of the exact text
    // that produced this attempt's evidence?" Both are audit provenance;
    // neither ever touches a verdict (decisions.md 2026-10-10: machine gates
    // decide survival; models advise).
    // T-038: on a gate-retry leg the brief IS the composed feedback text —
    // attempt 2's inputContextHash correctly differs from attempt 1's,
    // because its brief differs; the hash is doing its job.
    // T-060: the engine-composed orientation block (src/worker-orientation.ts)
    // is PREPENDED to every worker dispatch — the two facts every derailed
    // worker got wrong (where exactly am I, what files exist), pure engine
    // mechanics over the run's one digest + this attempt's lease path, never
    // model judgment (the T-050 annotation seam's discipline). The block
    // moves promptVersion by construction (the exact text grew — the T-029
    // producer records the composition change; pinned by Gate 1.46), the
    // builder template rides byte-unchanged after it, `base.brief` keeps the
    // planner's text, and the full dispatched prompt is recorded below as
    // dispatched-prompt.txt. runDigest null = the run-start composition
    // failure (logged once there): today's exact prompt bytes, no block.
    const orientationBlock = runDigest !== null
      ? composeWorkerOrientation({ leasePath: lease.path, baseSha: opts.baseSha, digest: runDigest }).text
      : null
    const prompt = workerDispatchPrompt(attemptBrief, lease.path, orientationBlock)
    const promptVersion = createHash('sha256').update(prompt).digest('hex')

    const attempt: Attempt = {
      id: `${id}-a${n}`,
      jobId: id,
      number: n,
      state: 'running',
      startedAt: new Date().toISOString(),
      inputContextHash: inputContextHash(attemptBrief, job.model, lease.path),
      promptVersion,
      outputArtifacts: [logPath],
    }
    base.attempts.push(attempt)
    // T-060: the full dispatched prompt (orientation + brief) is run evidence
    // — the exact bytes this attempt's promptVersion hashes, on disk the
    // moment the attempt exists (one composition, two consumers; the
    // brief-premise.txt/retry-brief.txt precedent). Rides the attempt's
    // outputArtifacts.
    {
      const dispatchedPromptPath = join(evidenceDir, 'dispatched-prompt.txt')
      writeFileSync(dispatchedPromptPath, prompt)
      attempt.outputArtifacts.push(dispatchedPromptPath)
    }
    // T-050: the premise annotation's before/after evidence — written ONCE,
    // on the first attempt (its evidence dir IS the candidate dir), riding
    // the dispatched attempt's outputArtifacts like diff.patch and
    // retry-brief.txt. The AUTHORED section is the planner's brief verbatim;
    // the DISPATCHED section is the annotated text this attempt's
    // promptVersion hashes.
    if (n === 1 && job.premiseAnnotation !== undefined) {
      const premisePath = join(evidenceDir, 'brief-premise.txt')
      writeFileSync(premisePath, job.premiseAnnotation.evidenceText)
      attempt.outputArtifacts.push(premisePath)
    }
    // T-038: a gate-retry leg's evidence dir carries the composed brief —
    // the exact text hashed into `gateRetry.fingerprint` below and wrapped
    // into this attempt's prompt above.
    if (pendingRetryBrief !== null) {
      const retryBriefPath = join(evidenceDir, 'retry-brief.txt')
      writeFileSync(retryBriefPath, pendingRetryBrief)
      attempt.outputArtifacts.push(retryBriefPath)
      pendingRetryBrief = null
    }
    // T-010: the dispatch is on disk the moment the lease exists — a crash
    // after this point leaves the worktree discoverable and the attempt
    // reconcilable (dispatch without a completion line = recorded-running).
    appendDispatchEvidence(opts.artifactsDir, {
      type: 'dispatch',
      jobId: id,
      attempt: n,
      leaseId: lease.id,
      branch: lease.branch,
      worktreePath: lease.path,
      startedAt: attempt.startedAt,
    })

    try {
      console.log(`[${id}] attempt ${n}: worker start (${job.worker.id}, model=${job.model})`)
      const result = await job.worker.execute({
        // The exact text hashed into attempt.promptVersion above (T-029) —
        // one composition, two consumers, no drift possible.
        prompt,
        model: job.model,
        cwd: lease.path,
        logPath,
        timeoutMs: job.timeoutMs,
        // T-023: the builder posture, passed explicitly — the check pins what
        // was sent, never what was defaulted (§14.1:1014: a write-capable
        // worker's writable workspace is the worktree, never the canonical
        // checkout — already true here by the worktree lease).
        executionPolicy: 'worktree-write',
        // T-010: the pid line lands as soon as the adapter knows its root
        // pid — before any hang — so recovery can find it after a crash
        // while execute() never resolves.
        onSpawn: (pid) => appendDispatchEvidence(opts.artifactsDir, {
          type: 'pid',
          jobId: id,
          attempt: n,
          pid,
          at: new Date().toISOString(),
        }),
      })
      attempt.endedAt = new Date().toISOString()
      console.log(`[${id}] attempt ${n}: worker done in ${(result.durationMs / 1000).toFixed(0)}s ok=${result.ok} exit=${result.exitCode}`)
      // T-011: worker-side cleanup failures (a timeout kill that could not be
      // verified) are evidence on the candidate, never a retry/verdict input.
      cleanupFailures.push(...(result.cleanupFailures ?? []))

      // A failed worker is the only worker-side retryable leg. A worker that
      // SUCCEEDED is final no matter what the verdict will be: zero-byte
      // diffs and failed gates are ladder verdicts, and re-rolling them
      // would be model-shopping around a machine verdict (decisions.md:
      // gates decide survival).
      const failure: FailureRecord | null = result.ok ? null : {
        reason: 'worker-failed',
        message: result.timedOut ? `worker timed out after ${job.timeoutMs}ms` : `worker exited with code ${result.exitCode}`,
        timedOut: result.timedOut,
        exitCode: result.exitCode,
      }

      // Diff evidence is captured on every attempt — a retried leg's diff is
      // still audit history (spec §6.5). Gates do NOT run here: retryable
      // legs never reach them.
      let diff = ''
      let diffCaptured = false
      try {
        diff = opts.workspaces.diff(lease)
        writeFileSync(diffPath, diff)
        attempt.outputArtifacts.push(diffPath)
        diffCaptured = true
        console.log(`[${id}] attempt ${n}: diff captured: ${Buffer.byteLength(diff)} bytes`)
      } catch (e) {
        console.log(`[${id}] attempt ${n}: diff capture failed: ${errorMessage(e)}`)
      }

      // T-010: the attempt's completion line — written only when the adapter
      // RESOLVED (a thrown attempt gets none, so recovery conservatively
      // treats it as recorded-running and can still kill its recorded pid).
      // diffBytes is the captured diff's size; a FAILED capture is recorded
      // as null, never as 0 — a zero-byte diff is a machine verdict (the
      // NO-OP rule), and absent evidence must not be readable as one.
      appendDispatchEvidence(opts.artifactsDir, {
        type: 'completion',
        jobId: id,
        attempt: n,
        ok: result.ok,
        timedOut: result.timedOut,
        exitCode: result.exitCode,
        diffBytes: diffCaptured ? Buffer.byteLength(diff) : null,
        endedAt: attempt.endedAt,
      })

      if (failure && base.attempts.length < opts.maxAttempts) {
        attempt.state = 'failed'
        attempt.failure = failure
        console.log(`[${id}] attempt ${n} failed (${failure.reason}); retrying with a fresh workspace (${base.attempts.length}/${opts.maxAttempts})`)
        if (opts.cleanWorkspaces) {
          try {
            opts.workspaces.dispose(lease)
          } catch (e) {
            console.log(`[${id}] workspace dispose failed: ${errorMessage(e)}`)
          }
        }
        continue
      }

      // The gates run on every attempt that reaches here (a final attempt of
      // either kind, or a worker-succeeded candidate the gate-retry may
      // claim). T-038: the results land in an attempt-local array so a
      // pre-retry leg's verdicts attach to THEIR attempt
      // (`Attempt.gateResults`) and `base.gates` keeps meaning "the FINAL
      // attempt's gates" — the pre-T-038 semantics, byte-for-byte.
      const attemptGates: GateResult[] = []
      for (const gate of job.gates) {
        const r: GateResult = await gate.run(lease.path)
        attemptGates.push(r)
        // T-011: gate-side cleanup failures (a timed-out gate whose tree kill
        // was not proven good) join the candidate's evidence, named by gate.
        cleanupFailures.push(...(r.cleanupFailures ?? []).map((line) => `gate ${r.name}: ${line}`))
        console.log(`[${id}] gate ${r.name}: ${r.passed ? 'PASS' : 'FAIL'} (${(r.durationMs / 1000).toFixed(1)}s)`)
      }

      // T-038: the ONE bounded feedback-informed gate retry. Every condition
      // is machine-checked: the worker succeeded, the diff was captured and
      // is non-zero (a zero-byte NO-OP or a failed capture has no failure
      // output to feed back — AGENTS.md #7), at least one of a non-empty
      // gate set failed (no-gates stays terminal), the flag is set, and this
      // candidate has not spent its one retry. The bound is one regardless
      // of maxAttempts — total attempts ≤ maxAttempts + 1. Blind re-rolls
      // stay banned: this leg's inputs are NEW information the first attempt
      // never had — the gates' own recorded output (decisions.md
      // 2026-10-21). The same Gate objects re-run unchanged above; the final
      // attempt's verdict below stands either way.
      const failedGates = attemptGates.filter((g) => !g.passed)
      if (opts.gateRetry === true && !gateRetryUsed && result.ok
        && diffCaptured && Buffer.byteLength(diff) > 0
        && attemptGates.length > 0 && failedGates.length > 0) {
        gateRetryUsed = true
        attempt.state = 'failed'
        attempt.failure = {
          reason: 'gates-failed',
          message: `machine gates rejected the change (${failedGates.map((g) => g.name).join(', ')}); one feedback-informed retry follows, composed from the gates' recorded output`,
          timedOut: false,
          exitCode: failedGates[0]!.exitCode,
        }
        // Attempt-scoped gate evidence: the pre-retry leg's verdicts attach
        // to their own attempt and would otherwise be lost (the final
        // attempt's gates overwrite the candidate-level array below).
        attempt.gateResults = attemptGates
        // T-040: the PRE-RETRY verifier call site — fires exactly when this
        // leg is retry-eligible (the condition above) and BEFORE composition,
        // against the failing attempt's lease (same posture, same schema, and
        // the same failure context the final-attempt call gets: the gates
        // that already ran with names/verdicts/commands, the captured diff,
        // the brief). Bounded by construction: the gate-retry bound is one,
        // so a candidate is verified at most twice — once here, once on its
        // final attempt per T-039. Findings are advisory inputs to the
        // COMPOSITION only — they shape what the retry tries; the re-run
        // gates decide what survives (decisions.md 2026-10-10, extended
        // 2026-10-21): no verdict line below reads them. The evidence tag
        // keeps this leg's verifier files (verifier-pre-retry.log/-raw.txt,
        // in THIS attempt's evidence dir) from ever overwriting the final
        // attempt's (verifier.log/-raw.txt). Any failure here — parse failure
        // after the bounded repair, or the adapter throwing — composes a
        // GATES-ONLY brief and the retry still fires: verifier absence (or
        // breakage) never blocks the mechanical retry, and the degradation is
        // recorded in `gateRetry.findings.ok` rather than silently swallowed.
        let retryFindings: ReviewObservation[] = []
        let findingsOk = false
        if (opts.verifierModel) {
          try {
            const preRetry = await runVerifier(opts, {
              id,
              dir: evidenceDir,
              workspacePath: lease.path,
              brief: job.brief,
              diff,
              gateLines: attemptGates.map((g) => `- ${g.name}: ${g.passed ? 'PASS' : 'FAIL'}${g.command !== undefined ? ` — command: ${g.command}` : ' — command not recorded'}`),
              evidenceTag: '-pre-retry',
            })
            findingsOk = preRetry.ok
            // Only actionable severities ride: blocker-advisory and concern.
            // `info` is worth knowing, not a fix instruction; `count` below is
            // the ELIGIBLE count, pre-cap.
            retryFindings = preRetry.observations.filter((o) => o.severity === 'blocker-advisory' || o.severity === 'concern')
          } catch (e) {
            console.log(`[${id}] pre-retry verifier failed: ${errorMessage(e)}; composing a gates-only retry brief — the retry is mechanical and never blocked`)
          }
        }
        const composed = composeGateRetryBrief(job.brief, diff, failedGates, result.responseTail, retryFindings)
        pendingRetryBrief = composed.text
        base.gateRetry = {
          fromAttempt: n,
          toAttempt: n + 1,
          gates: failedGates.map((g) => g.name),
          fingerprint: composed.fingerprint,
          // T-040 provenance, beside the fingerprint (which covers the full
          // composed text including the findings section by construction):
          // count = eligible findings returned pre-cap; included = embedded
          // post-caps; ok = parsed schema-valid verifier output existed at all
          // (false = no verifier configured, or the pre-retry output failed
          // to parse / the verifier crashed — the recorded degradation).
          findings: { count: retryFindings.length, included: composed.includedFindings, ok: findingsOk },
        }
        attemptBrief = composed.text
        console.log(`[${id}] attempt ${n}: gates rejected the change (${failedGates.map((g) => g.name).join(', ')}); composing the one feedback-informed gate retry (attempt ${n + 1})`)
        if (opts.cleanWorkspaces) {
          try {
            opts.workspaces.dispose(lease)
          } catch (e) {
            console.log(`[${id}] workspace dispose failed: ${errorMessage(e)}`)
          }
        }
        continue
      }

      // Final attempt (worker succeeded, or the bound was reached): the
      // job's top-level fields are this attempt's values — the exact flow
      // and verdict ladder the runner had before T-009, so the run summary,
      // the store's per-candidate writes, and clean/integrate discovery are
      // unchanged.
      attempt.state = result.ok ? 'succeeded' : 'failed'
      if (failure) attempt.failure = failure
      base.workerOk = result.ok
      base.workerTimedOut = result.timedOut
      base.workerDurationMs = result.durationMs
      if (diffCaptured) {
        base.diffPath = diffPath
        base.diffBytes = Buffer.byteLength(diff)
      }
      base.gates = attemptGates
      base.passedAllGates = base.gates.length > 0 && base.gates.every((g) => g.passed) && base.diffBytes > 0

      // T-045: gate/diff overlap evidence — the final attempt's changed
      // paths (re-derived in the lease, riding T-044's pinned-base
      // semantics) intersected with the path-shaped tokens of each gate's
      // RECORDED command (GateResult.command, T-027). Produced beside the
      // ladder, never read by it (the cleanupFailures pattern): the verdict
      // line above was already computed from `passed`/`diffBytes` alone,
      // and nothing below feeds this block back into any verdict
      // (decisions.md 2026-10-10: gates decide survival). A HEURISTIC,
      // documented as one: transitive loads are invisible (`node build.js`
      // can require anything), and npm/make-style commands with no path
      // tokens yield no overlap by construction. Absent when nothing
      // overlaps (the producer-only optional-field pattern). The overlap
      // computation itself must never break a run (the probes/verifier
      // posture): a failure logs loudly and records nothing.
      if (diffCaptured) {
        try {
          const changedPaths = opts.workspaces.changedPaths(lease)
          // T-050: the wave's in-run survivor-evidence map records this final
          // attempt's changed paths beside the T-045 derivation that already
          // walks the same seam — one derivation, two consumers (the
          // round-2 premise guard reads the map after the wave drains).
          // Never serialized; never a verdict input.
          changedPathsById?.set(id, changedPaths)
          const overlap = computeGateCommandOverlap(attemptGates, changedPaths, lease.path)
          if (overlap.length > 0) {
            base.gateCommandOverlap = overlap
            for (const o of overlap) {
              const g = attemptGates.find((x) => x.name === o.gate)
              console.log(`[${id}] gate ${o.gate}: ${g?.passed ? 'PASS' : 'FAIL'} — NOTE: diff touches files this gate executes: ${o.touched.join(', ')}`)
            }
          }
        } catch (e) {
          console.log(`[${id}] gate/diff overlap computation failed: ${errorMessage(e)}`)
        }
      }

      // T-047: ignored-path parity evidence — the final attempt's ignored-
      // tree snapshot, taken AFTER the gate loop (so gate-installed trees —
      // npm-install-style gates — are included: they are the parity-relevant
      // set) and BEFORE dispose. `diff` above respects .gitignore (the
      // 2026-10-23 recorded repro), so files under ignored paths exist in
      // the lease the gates executed in but appear in NEITHER the captured
      // diff NOR an ordinary status — the run's survivor and the replayed
      // artifact measure different trees, and until T-047 the report
      // carried no trace of it. Produced beside the ladder, never read by
      // it (the T-045 posture): the verdict line above was already computed
      // from `passed`/`diffBytes` alone, and nothing below feeds this block
      // back into any verdict (decisions.md 2026-10-10: gates decide
      // survival). Producer-only: an empty `!!` set records nothing (the
      // report shape is byte-identical to today's). The snapshot itself
      // must never break a run (the probes/verifier posture): a failure
      // logs loudly and records nothing. Visibility only — dependency
      // provisioning (spec §13's manifest), pristine gate environments, and
      // tamper DETECTION are the ticket's carved non-goals.
      try {
        const porcelain = opts.workspaces.ignoredStatus(lease)
        const ignored = porcelain
          .split('\n')
          .filter((line) => line.startsWith('!! '))
          .map((line) => line.slice(3))
        if (ignored.length > 0) {
          const snapshotPath = join(evidenceDir, 'ignored-paths.txt')
          writeFileSync(snapshotPath, porcelain)
          attempt.outputArtifacts.push(snapshotPath)
          const entries = ignored.slice(0, MAX_IGNORED_PATHS)
          base.ignoredPaths = { count: ignored.length, entries }
          const more = ignored.length > entries.length ? `, +${ignored.length - entries.length} more` : ''
          console.log(`[${id}] ignored paths: ${ignored.length} (${entries.join(', ')}${more}) — written to ignored-paths.txt; gate parity with a replay is not established`)
        }
      } catch (e) {
        console.log(`[${id}] ignored-path snapshot failed: ${errorMessage(e)}`)
      }

      // T-015: probes ride beside the ladder as a parallel evidence seam —
      // run on the final completed attempt immediately after the gate loop,
      // before review and workspace dispose, REGARDLESS of gate outcomes
      // (evidence about failures is evidence). The expression above is
      // byte-identical to the pre-probe ladder and stays the only verdict
      // input: a probe result, including a success:false bundle, never
      // changes a verdict or a gate PASS/FAIL (decisions.md 2026-10-10:
      // machine gates decide survival; probes advise/record).
      if (job.probes && job.probes.length > 0) {
        base.probes = await runProbes(job, opts, lease)
      }

      // T-039: active pre-disposition verification — after the gate loop and
      // probes, before review, on the final completed attempt REGARDLESS of
      // gate outcome (the T-015 posture: evidence about failures is
      // evidence). The diff was captured before the gates ran (above), so
      // the verifier's executions in the workspace cannot dirty diff
      // evidence. Findings, never verdicts: the ladder computed above reads
      // `passed`/`diffBytes` alone and no line below feeds the verifier block
      // back into any verdict — a blocker-advisory finding eliminates
      // nothing, promotes nothing, reorders nothing (decisions.md 2026-10-21:
      // a model-authored check never decides survival in the run that
      // produced it). Reviewer ordering and survivor-only scope unchanged;
      // the verifier is not a reviewer replacement this slice.
      if (opts.verifierModel) {
        base.verifier = await runVerifier(opts, {
          id,
          dir,
          workspacePath: lease.path,
          brief: job.brief,
          diff,
          gateLines: base.gates.map((g) => `- ${g.name}: ${g.passed ? 'PASS' : 'FAIL'}${g.command !== undefined ? ` — command: ${g.command}` : ' — command not recorded'}`),
        })
      }

      if (opts.reviewerModel && base.passedAllGates) {
        base.review = await runReview(opts, {
          id,
          dir,
          workspacePath: lease.path,
          brief: job.brief,
          diff,
          gateLines: base.gates.map((g) => `- ${g.name}: ${g.passed ? 'PASS' : 'FAIL'}`),
        })
      }
      break
    } catch (e) {
      attempt.endedAt = new Date().toISOString()
      attempt.state = 'failed'
      attempt.failure = { reason: 'error', message: errorMessage(e), timedOut: false, exitCode: null }
      console.log(`[${id}] attempt ${n} errored: ${attempt.failure.message}`)
      if (base.attempts.length < opts.maxAttempts) {
        console.log(`[${id}] attempt ${n} → retrying with a fresh workspace (${base.attempts.length}/${opts.maxAttempts})`)
        if (opts.cleanWorkspaces) {
          try {
            opts.workspaces.dispose(lease)
          } catch (e2) {
            console.log(`[${id}] workspace dispose failed: ${errorMessage(e2)}`)
          }
        }
        continue
      }
      base.error = attempt.failure.message
      console.log(`[${id}] job errored: ${base.error}`)
      break
    }
  }

  if (opts.cleanWorkspaces) {
    try {
      opts.workspaces.dispose(lease!)
      base.workspacePath = null
    } catch (e) {
      console.log(`[${id}] workspace dispose failed: ${errorMessage(e)}`)
    }
  }

  // T-011: the candidate report's one place answering "did anything survive a
  // timeout". Absent when nothing failed — happy-path reports are unchanged —
  // and never an input to any verdict.
  if (cleanupFailures.length > 0) base.cleanupFailures = cleanupFailures

  return base
}

/** Execute one job's probes on its final completed attempt (T-015, spec
 *  §12): each probe runs behind the Probe seam, its EvidenceBundle is
 *  validated and written to <artifactsDir>/probes/<candidateId>/<probeId>.json
 *  under the run's artifacts dir (decisions.md 2026-10-10: run root
 *  C:\swarm\; never the worktree as the durable copy), and the summary
 *  lands on the candidate report. A probe that throws records a
 *  success:false bundle with the error and never breaks the run; a bundle
 *  that cannot be written is logged and skipped (no summary ever names a
 *  file that is not on disk). Nothing here touches any verdict. */
async function runProbes(job: ResolvedJob, opts: SkeletonOptions, lease: WorkspaceLease): Promise<ProbeRunSummary[]> {
  const summaries: ProbeRunSummary[] = []
  for (const probe of job.probes ?? []) {
    const started = Date.now()
    let bundle
    try {
      bundle = await probe.run({
        workspace: lease,
        scenario: probe.scenario,
        environment: { artifactsDir: opts.artifactsDir, candidateId: job.id },
      })
    } catch (e) {
      bundle = failedBundle(probe.id, probe.scenario.id, errorMessage(e))
    }
    console.log(`[${job.id}] probe ${probe.id}: ${bundle.success ? 'PASS' : 'FAIL'} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    try {
      const bundlePath = writeEvidenceBundle(bundle, { artifactsDir: opts.artifactsDir, candidateId: job.id })
      summaries.push({
        probeId: probe.id,
        scenarioId: probe.scenario.id,
        success: bundle.success,
        durationMs: Date.now() - started,
        bundlePath,
      })
    } catch (e) {
      console.log(`[${job.id}] probe ${probe.id}: evidence write failed: ${errorMessage(e)}`)
    }
  }
  return summaries
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
