import { execFileSync } from 'node:child_process'

/**
 * The outcome of one verified process-tree kill (T-011, spec §15.3 MVP
 * contract: Windows tree termination, verify descendants disappear, remaining
 * descendants are cleanup failures).
 */
export interface KillTreeResult {
  /** False = the root was already gone at kill time; nothing was killed. */
  rootWasLive: boolean
  /**
   * True = the root and every descendant captured in the pre-kill snapshot
   * were verified dead afterwards — or, on the T-054 post-kill re-check
   * path, the root plus every process the re-check could still link to it
   * were verified dead (Known issue #10's diagnosed snapshot-failure leg,
   * proven dead instead of reported failed). False means the outcome is
   * unproven, not that the kill failed. Verification is Windows-only today
   * (VERIFICATION.md Known issues #9).
   */
  verified: boolean
  /**
   * Snapshot pids still alive after the kill. False survivors via pid reuse
   * are possible and acceptable — the failure direction is loud, not silent.
   */
  survivors: number[]
  /**
   * Snapshot pids verified dead after the kill (root + descendants); the
   * `N` in the worker log's `tree killed, verified: N processes reaped`.
   * On the T-054 post-kill re-check path: the re-check's OWN enumeration
   * (the dead root plus anything still linked to it) — the pre-kill tree's
   * size is unknowable when its snapshot failed. 0 whenever the outcome
   * could not be verified.
   */
  reaped: number
}

/**
 * Injectable verification lenses (T-054), defaulting to the real
 * implementations — injectable per the T-052 identity-probe precedent
 * (src/recover.ts's `CreationTimeProbe`) so the diagnosed transient-snapshot
 * shape (VERIFICATION.md Known issue #10's fifth observation) is
 * deterministic to test: a real one-off CIM hiccup cannot be produced on
 * demand. Call sites omit this and get the real machinery.
 */
export interface KillTreeDeps {
  /** Defaults to the real fixed-constant CIM snapshot (`snapshotTree`). */
  snapshotTree?: (rootPid: number) => number[]
  /** Defaults to the real signal-0 liveness probe. */
  isAlive?: (pid: number) => boolean
}

/**
 * Fixed-constant CIM snapshot query — zero interpolation, so spawning it
 * list-form (AGENTS.md #4) holds trivially.
 */
const CIM_SNAPSHOT = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId'

/**
 * Kill a process and all descendants, and verify the outcome (T-011):
 *
 * 1. alive check first — an already-gone root is a *reported result*, never a
 *    swallowed error (the pre-T-011 silent catch is removed). Deliberately
 *    NOT relied upon: `taskkill /T /F` reaching descendants of an already-dead
 *    root (Windows reparenting — behavior unverified, Known issues #8); call
 *    sites fire while the root is alive by construction.
 * 2. snapshot the tree BEFORE killing — one fixed-constant PowerShell CIM
 *    query, list-form; the pre-kill enumeration (root + BFS over ppid edges)
 *    is what step 4 verifies against. Scope is descendants visible at
 *    snapshot time; the narrow snapshot-to-kill race is documented and the
 *    race-free mechanism stays Windows Job Objects "Later" (spec §15.3:1084,
 *    decisions.md 2026-10-10).
 * 3. kill — the verbatim list-form `taskkill /pid <pid> /T /F`.
 * 4. verify — a liveness check on the root and every snapshot pid; anything
 *    still alive lands in `survivors` and the result reports
 *    `verified: false`.
 *
 * T-054 (VERIFICATION.md Known issue #10, the captured fifth observation):
 * a snapshot failure is no longer allowed to condemn a possibly-good outcome
 * to `verified: false` by itself — the transient one-off CIM hiccup used to
 * report provably-dead trees as cleanup failures. The diagnosed leg gets two
 * bounded second chances, and the kill is never skipped by either:
 *   - one immediate PRE-kill snapshot retry — when it lands, the full
 *     original verification (pre-kill pid list, post-kill sweep) runs
 *     unchanged;
 *   - otherwise the kill fires and ONE post-kill liveness re-check
 *     (`killUnverifiedThenRecheck`) gets the last word: everything the
 *     re-check can still link to the root proven dead upgrades the outcome
 *     to verified; anything alive keeps the per-pid loud lines; a re-check
 *     that also cannot run keeps the exact pre-T-054 loud unverifiable shape
 *     (fail-closed — the T-011 posture).
 *
 * Never throws and never stays silent: every outcome is the returned result.
 */
export function killTreeVerified(pid: number, deps: KillTreeDeps = {}): KillTreeResult {
  const snapshot = deps.snapshotTree ?? snapshotTree
  const alive = deps.isAlive ?? isAlive
  if (!alive(pid)) {
    return { rootWasLive: false, verified: false, survivors: [], reaped: 0 }
  }
  if (process.platform !== 'win32') {
    // Best-effort root kill; descendant verification is Windows-only today
    // (VERIFICATION.md Known issues #9) — reported, never asserted.
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Died between the two checks — still unverified on this platform.
    }
    return { rootWasLive: true, verified: false, survivors: [], reaped: 0 }
  }
  let tree: number[]
  try {
    tree = snapshot(pid)
  } catch {
    // A failed snapshot must never skip the kill — and since T-054 it must
    // not, by itself, condemn the outcome to `verified: false` (the
    // transient-hiccup flake class, Known issue #10): retry once pre-kill,
    // then let the post-kill re-check have the last word.
    try {
      tree = snapshot(pid)
    } catch {
      return killUnverifiedThenRecheck(pid, snapshot, alive)
    }
  }
  taskkillTree(pid)
  const survivors = tree.filter((p) => alive(p))
  return {
    rootWasLive: true,
    verified: survivors.length === 0,
    survivors,
    reaped: survivors.length === 0 ? tree.length : 0,
  }
}

/**
 * The T-054 post-kill re-check: the kill has fired (never skipped — the
 * failed snapshot must not skip it, the T-011 invariant), and ONE more
 * snapshot attempt decides between three loudness-preserving outcomes.
 * Verified-dead here means: the re-check's own enumeration — the root plus
 * every process still linked to it in the fresh process table — sweeps dead.
 * The pre-kill tree's full pid list is unknowable (its snapshot failed), so
 * `reaped` honestly counts the re-check's own enumeration, and a descendant
 * that no longer links to the root could evade the sweep — the upgrade is
 * still strictly stronger than the unconditional `verified: false` it
 * replaces, and anything the re-check CAN see and prove alive stays loud.
 */
function killUnverifiedThenRecheck(
  pid: number,
  snapshot: (rootPid: number) => number[],
  alive: (pid: number) => boolean,
): KillTreeResult {
  taskkillTree(pid)
  let recheck: number[]
  try {
    recheck = snapshot(pid)
  } catch {
    // Genuinely unverifiable — the exact pre-T-054 loud shape stands
    // (fail-closed, the T-011 posture).
    return { rootWasLive: true, verified: false, survivors: [], reaped: 0 }
  }
  const survivors = recheck.filter((p) => alive(p))
  if (survivors.length > 0) {
    return { rootWasLive: true, verified: false, survivors, reaped: 0 }
  }
  // Proven dead post-kill — the outcome upgrades to verified-when-proven-dead.
  return { rootWasLive: true, verified: true, survivors: [], reaped: recheck.length }
}

/**
 * The pid→ppid map snapshot with the root plus every descendant (BFS down
 * ppid edges) — exported so Gate 1.12's S5 can pin the pre-kill enumeration
 * depth directly, and the default lens of `killTreeVerified`'s injectable
 * `snapshotTree` seam (T-054). Throws on output it cannot parse and on a
 * spawn that cannot run (the caller retries once, then proceeds through the
 * T-054 post-kill re-check); the kill itself is never skipped.
 */
export function snapshotTree(rootPid: number): number[] {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', CIM_SNAPSHOT],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  )
  const children = new Map<number, number[]>()
  for (const rawLine of out.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('ProcessId') || /^[-\s]+$/.test(line)) continue
    const cols = line.split(/\s+/)
    if (cols.length !== 2 || !/^\d+$/.test(cols[0]!) || !/^\d+$/.test(cols[1]!)) {
      throw new Error(`unexpected process-snapshot output: ${JSON.stringify(line.slice(0, 80))}`)
    }
    const p = Number(cols[0])
    const ppid = Number(cols[1])
    const known = children.get(ppid)
    if (known) known.push(p)
    else children.set(ppid, [p])
  }
  const tree: number[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const p = queue.shift()!
    tree.push(p)
    for (const c of children.get(p) ?? []) {
      if (!seen.has(c)) {
        seen.add(c)
        queue.push(c)
      }
    }
  }
  return tree
}

/** The one success line the timeout paths append to a worker log when a kill
 *  verified clean — log-only evidence, never a cleanup failure. */
export function killSuccessLine(r: KillTreeResult): string {
  return `tree killed, verified: ${r.reaped} processes reaped`
}

/** The verified-kill outcome as loud `CLEANUP FAIL:` lines — what lands in
 *  the `cleanupFailures` fields and the worker log. Empty exactly when the
 *  outcome is proven good (`verified: true`, which since T-054 includes the
 *  post-kill re-check upgrade for Known issue #10's snapshot-failure leg);
 *  survivors, an already-gone root, or a kill that could not be verified at
 *  all each still get their named line (T-011, fail-closed). */
export function killFailureLines(pid: number, r: KillTreeResult): string[] {
  if (!r.rootWasLive) {
    return [`CLEANUP FAIL: root pid ${pid} already gone before kill; descendant verification impossible`]
  }
  if (r.verified) return []
  const lines = r.survivors.map((s) => `CLEANUP FAIL: pid ${s} survived taskkill /T /F`)
  if (lines.length === 0) {
    lines.push(`CLEANUP FAIL: pid ${pid} tree kill could not be verified (descendant verification unavailable)`)
  }
  return lines
}

/**
 * Fire-and-forget tree kill, kept for T-010's recovery machinery
 * (src/recover.ts), which runs its own identity check before and its own
 * liveness check after this call. The pre-T-011 silent catch is gone: the
 * outcome is *reported* by `killTreeVerified` and deliberately ignored here —
 * never swallowed by a catch.
 */
export function killTree(pid: number): void {
  killTreeVerified(pid)
}

/** The verbatim list-form primitive (AGENTS.md #4). A taskkill failure is not
 *  silent success (the removed pre-T-011 behavior): step 4 verifies every
 *  snapshot pid afterwards and the result reports whatever survived. */
function taskkillTree(pid: number): void {
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    // Reported below: either the root died in the snapshot-to-kill race
    // (verification proves it) or the kill was denied (survivors say so).
  }
}

/** Liveness. EPERM (exists, not signable) counts as alive — the conservative,
 *  loud direction; only a definitive "no such process" is dead. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e instanceof Error && (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
