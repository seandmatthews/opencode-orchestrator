// T-049 — yield instrumentation: the A2 measuring stick (the 2026-10-23
// adversarial review §4). One pure derivation, `deriveRunYield`, turning a
// finished RunReport into the additive, producer-only `RunReport.yield`
// block, so per-run yield stops being anecdote before the next
// model/prompt/rounds decision. Every count is computed from data the
// report already holds — the ladder vocabulary (`FailureReason`,
// src/types.ts) and the store's elimination classes (`eliminationReason`,
// src/store/index.ts: error → worker-failed → no-op → no-gates →
// gates-failed) — with exactly ONE read beyond the report's own fields: the
// marker scan over the no-op attempts' worker.log bytes (recorded evidence
// on disk, the same files the run wrote).
//
// Boundaries (the ticket's, pinned by Gate 1.36):
//   - Producer-only: the block is produced ONLY when the run recorded at
//     least one machine-known no-op elimination (workerOk, zero-byte diff).
//     A clean run's report shape is byte-identical to pre-T-049.
//   - Evidence only, never a verdict input: no ladder line, retry decision,
//     or elimination path reads it (decisions.md 2026-10-10: gates decide
//     survival). A derailment marker is a HEURISTIC labeled as one — a
//     deterministic string match on recorded bytes, never a classification
//     the ladder reads.
//   - No decisions, no thresholds, no early-stop wiring: A2 explicitly does
//     NOT feed verdicts. Store columns, dashboard tiles, and cross-run
//     aggregation are later slices (the T-034 producer-only precedent);
//     the report is this slice's durable copy.
import { readFileSync } from 'node:fs'
import type { Attempt, CandidateReport, DerailmentMarkerNote, RunReport, RunYield, RunYieldCounts, RunYieldRound } from './types.js'

/**
 * The harness's external_directory auto-reject line — the recorded
 * derailment marker. The full line as recorded in the cited run evidence
 * (run 20261024021432, the T-047 lane's driving Gate 2, its c02-r2
 * worker.log; recorded verbatim in VERIFICATION.md's Known issue #6
 * 2026-10-24 entry, byte-cross-checked against the same harness frame on
 * disk in run 20261010235146's c02/c03 worker.logs) is:
 *
 *   permission requested: external_directory (C:\swarm\verify\20261024021432\wt\c02\r2\*); auto-rejecting
 *
 * The parenthesized path is per-run; the matched literal below is the
 * line's stable path-independent frame — a byte-exact substring of every
 * recorded instance (ANSI console prefixes ride before it and do not
 * affect the match). Never a paraphrase; never a regex.
 */
export const DERAILMENT_MARKER = 'permission requested: external_directory'

/** The store's 'no-op' elimination class (eliminationReason,
 *  src/store/index.ts), the machine-known NO-OP of AGENTS.md #7: the worker
 *  exited 0 and the captured diff is zero bytes. `error` candidates keep
 *  the store's higher-precedence 'error' class and are not no-ops. */
function isNoOpElimination(c: CandidateReport): boolean {
  return !c.error && c.workerOk && c.diffBytes === 0
}

/** The store's 'gates-failed' elimination class: the worker succeeded, the
 *  diff is non-zero, gates ran, and at least one rejected. */
function isGateFailedFinal(c: CandidateReport): boolean {
  return !c.error && c.workerOk && c.diffBytes > 0 && c.gates.length > 0 && !c.gates.every((g) => g.passed)
}

/** An attempt's worker leg succeeded: no failure record (a succeeded
 *  attempt) or the T-038 'gates-failed' pre-retry leg (the worker
 *  succeeded; the gates, not the worker, rejected — decisions.md
 *  2026-10-21). The worker-side reasons ('worker-failed', 'error') fail. */
function attemptWorkerOk(a: Attempt): boolean {
  return a.failure === undefined || a.failure.reason === 'gates-failed'
}

/** The count set over one candidate slice — the whole run, or one round's
 *  members. See `RunYieldCounts` (src/types.ts) for the per-field
 *  definitions; this is the single arithmetic every scope shares. */
function countYield(candidates: readonly CandidateReport[]): RunYieldCounts {
  let attemptsDispatched = 0
  let workerOkAttempts = 0
  let nonZeroDiffAttempts = 0
  let gateFailedFinalAttempts = 0
  let noOpEliminations = 0
  let survivors = 0
  for (const c of candidates) {
    attemptsDispatched += c.attempts.length
    if (isGateFailedFinal(c)) gateFailedFinalAttempts++
    if (isNoOpElimination(c)) noOpEliminations++
    if (c.passedAllGates) survivors++
    const final = c.attempts.length - 1
    for (let i = 0; i < c.attempts.length; i++) {
      const a = c.attempts[i]!
      if (attemptWorkerOk(a)) workerOkAttempts++
      // Machine-known diff bytes exist on the report for exactly two
      // attempt classes: the final attempt (the candidate's diffBytes) and
      // a 'gates-failed' pre-retry leg (non-zero by the T-038 firing
      // condition). Anything else counts nowhere — honest absence.
      if (i === final ? c.diffBytes > 0 : a.failure?.reason === 'gates-failed') nonZeroDiffAttempts++
    }
  }
  return {
    candidates: candidates.length,
    attemptsDispatched,
    workerOkAttempts,
    nonZeroDiffAttempts,
    gateFailedFinalAttempts,
    noOpEliminations,
    survivors,
  }
}

/** The no-op attempt's worker.log path — the attempt's own recorded
 *  artifact (the runner puts the log first in outputArtifacts; the basename
 *  match is robust to the evidence files appended after it). Null when the
 *  attempt recorded no log. */
function workerLogPathOf(a: Attempt): string | null {
  const found = a.outputArtifacts.find((p) => p.split(/[\\/]/).pop() === 'worker.log')
  return found ?? null
}

/**
 * Derive the per-run yield block (T-049). Pure over the report's own fields
 * plus the no-op attempts' worker.log bytes; returns null when the run
 * recorded no machine-known no-op elimination — the producer-only gate, so
 * a clean run's report never carries the block. Never throws on missing or
 * unreadable evidence files (the run already recorded what it recorded; a
 * marker scan that cannot read degrades to no note, never to a failure).
 */
export function deriveRunYield(report: RunReport): RunYield | null {
  const noOpCandidates = report.candidates.filter(isNoOpElimination)
  if (noOpCandidates.length === 0) return null
  const noOpAttemptIds: string[] = []
  const derailmentMarkers: DerailmentMarkerNote[] = []
  for (const c of noOpCandidates) {
    const final = c.attempts[c.attempts.length - 1]
    if (final === undefined) continue
    noOpAttemptIds.push(final.id)
    const logPath = workerLogPathOf(final)
    if (logPath === null) continue
    let log: string
    try {
      log = readFileSync(logPath, 'utf8')
    } catch {
      continue
    }
    if (log.includes(DERAILMENT_MARKER)) {
      derailmentMarkers.push({ attemptId: final.id, marker: DERAILMENT_MARKER })
    }
  }
  const block: RunYield = { ...countYield(report.candidates), noOpAttemptIds }
  if (derailmentMarkers.length > 0) block.derailmentMarkers = derailmentMarkers
  if (report.rounds !== undefined) {
    // Round membership by the runner's id convention (src/runner.ts): round
    // 2+ ids are `<survivorId>-rN`. One entry per recorded round, in the
    // rounds block's own order — a not-executed round records zeros.
    block.perRound = report.rounds.map((r) => {
      const suffix = `-r${r.round}`
      const members = report.candidates.filter((c) => (r.round === 1 ? !c.id.endsWith('-r2') : c.id.endsWith(suffix)))
      const round: RunYieldRound = { round: r.round, ...countYield(members) }
      return round
    })
  }
  return block
}
