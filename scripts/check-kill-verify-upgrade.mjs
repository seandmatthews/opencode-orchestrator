// Verified-dead upgrade self-check (Gate 1.40, fast tier, T-054) — run under
// tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-kill-verify-upgrade.mjs
// Token-free, deterministic, no git, no opencode binary, no model IDs: plants
// real node process trees, asserts on the REAL process table
// (process.kill(pid, 0)), and drives the diagnosed leg two ways:
//   - INJECTED snapshot/liveness stubs (the T-052 identity-probe injection
//     precedent, src/recover.ts's CreationTimeProbe) for the TRANSIENT
//     shapes — the one-off CIM hiccup is not reproducible for real on
//     demand, so the stub supplies exactly the recorded shape. The seam is
//     introduced BY the T-054 change-set: on main's engine the stubs are
//     inert (the extra argument is ignored and the REAL snapshot runs), so
//     the transient legs' call-count pins fail on main — recorded as that
//     seam-absence failure, the T-052 red-bar pattern.
//   - the REAL snapshot failing FOR REAL (every WindowsPowerShell PATH
//     segment stripped, both preconditions asserted — the T-052 check's R6
//     mechanic) for the genuinely-unverifiable shape: fail-closed, driven
//     end to end with no stubs, kill never skipped.
// Pins the T-054 fix for VERIFICATION.md Known issue #10's fifth observation
// (the captured line: `CLEANUP FAIL: pid N tree kill could not be verified
// (descendant verification unavailable)` sitting on a tree that verifiably
// died — the snapshot/verification leg, NOT an already-gone root):
//   A   the diagnosed leg — snapshot fails ONCE (transient): the bounded
//       pre-kill retry re-arms the full original verification; the outcome
//       is verified-dead with the full pre-kill tree counted in `reaped`,
//       NO CLEANUP FAIL line, the success line available to the log
//       consumer. Red bar (recorded in the ticket): pre-T-054 this shape
//       proceeded unverified and reported the spurious cleanup failure.
//   B   the reporting surface, pure: a verified-dead outcome emits NO
//       failure line (killFailureLines empty, killSuccessLine carrying the
//       reaped count); survivor, unverifiable, and dead-root shapes keep
//       their named lines verbatim (the never-weakened pins).
//   C   genuine survivors keep their per-pid lines through the NORMAL path
//       (a forced-alive liveness stub on a really-killed tree).
//   D   a genuinely-unverifiable outcome (snapshot fails pre-kill twice AND
//       the post-kill re-check also fails) stays loud, and the kill itself
//       is never skipped — the tree is really dead on the real table.
//   E   the post-kill re-check leg — snapshot fails through the kill window
//       (twice pre-kill), one post-kill liveness re-check enumerates the
//       tree and proves it dead: the outcome upgrades to verified-when-
//       proven-dead with NO failure line. Red bar (recorded in the ticket):
//       pre-T-054 this shape also reported the spurious cleanup failure.
//   F   the post-kill re-check stays loud in the loud direction: a live
//       process it finds keeps its per-pid line.
//   R   the REAL-failure leg: with powershell.exe unresolvable (PATH
//       stripped, both preconditions asserted), the REAL kill of a REAL
//       planted tree cannot verify through ANY attempt — the outcome stays
//       exactly the loud unverifiable shape (fail-closed, T-011) and the
//       kill is never skipped. On main's engine this leg also REPRODUCED
//       the fifth observation's signature end to end (the recorded red
//       bar): the real snapshot failure around a kill whose tree the real
//       process table proves dead, reported as a CLEANUP FAIL.
import { swarmRoot } from './swarm-root.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killFailureLines, killSuccessLine, killTreeVerified, snapshotTree } from '../src/kill-tree.ts'

const failures = []
let assertions = 0
const t = (name, cond) => {
  assertions++
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = swarmRoot + '/verify-killverify'
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Every pid this script ever learns about — swept best-effort at the end, so
// nothing we planted outlives the check (AGENTS.md #10, mechanized).
const planted = new Set()

// The planted tree node (Gate 1.12's fixture, byte-for-byte): depth N spawns
// depth N-1, every node records its pid in the sandbox dir, every node stays
// alive until killed.
const treeNode = join(sandbox, 'tree-node.js')
writeFileSync(treeNode, `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const depth = Number(process.argv[2])
const dir = process.argv[3]
if (depth > 1) spawn(process.execPath, [__filename, String(depth - 1), dir], { stdio: 'ignore' })
writeFileSync(join(dir, 'pid-' + depth + '.json'), String(process.pid))
setInterval(() => {}, 1000)
`)

async function waitForPids(dir, depths, deadlineMs = 15000) {
  const out = {}
  const deadline = Date.now() + deadlineMs
  for (const d of depths) {
    const f = join(dir, `pid-${d}.json`)
    while (!existsSync(f)) {
      if (Date.now() > deadline) throw new Error(`tree node depth ${d} never came up (${f})`)
      await sleep(50)
    }
    out[d] = Number(readFileSync(f, 'utf8'))
    planted.add(out[d])
  }
  return out
}

// Plant a live 3-level tree (root = pid-3, mid = pid-2, leaf = pid-1) and
// return its recorded pids.
async function plantTree(name) {
  const dir = join(sandbox, name)
  mkdirSync(dir, { recursive: true })
  const parent = spawn(process.execPath, [treeNode, '3', dir], { stdio: 'ignore' })
  planted.add(parent.pid)
  const pids = await waitForPids(dir, [1, 2, 3])
  return { dir, pids }
}

async function waitUntilDead(pids, deadlineMs = 5000) {
  const deadline = Date.now() + deadlineMs
  while (pids.some(isAlive)) {
    if (Date.now() > deadline) return
    await sleep(25)
  }
}

const treeReallyDead = (pids) => !pids.some(isAlive)

// Stub lenses (injected per the T-052 identity-probe precedent):
// transientSnapshot — throws exactly once (the diagnosed one-off CIM hiccup),
// then delegates to the REAL snapshot.
const transientSnapshot = () => {
  let calls = 0
  return (pid) => {
    calls++
    if (calls === 1) throw new Error('stub: transient CIM hiccup (Known issue #10, fifth observation)')
    return snapshotTree(pid)
  }
}
// downThroughKillSnapshot — throws on the two pre-kill attempts, delegates to
// the REAL snapshot on the post-kill re-check.
const downThroughKillSnapshot = () => {
  let calls = 0
  return (pid) => {
    calls++
    if (calls <= 2) throw new Error('stub: CIM down through the kill window')
    return snapshotTree(pid)
  }
}
// alwaysDownSnapshot — throws on every attempt (genuinely unverifiable).
const alwaysDownSnapshot = () => () => {
  throw new Error('stub: CIM unavailable for the whole window')
}
// forcedAlive — reports ONE planted pid alive no matter what the table says
// (a reporting stub, never a real survivor; the tree really dies and the
// sweep at the end proves it).
const forcedAlive = (pid) => (p) => (p === pid ? true : isAlive(p))

// T-065: the T-054 machinery — pre-kill snapshot, tree kill, post-kill
// re-check — is Windows-only code; off-Windows killTreeVerified takes its
// best-effort root-SIGKILL early return (KI#9) and every injected lens is
// unreachable. The machinery legs below run on Windows; their POSIX twins
// pin the contract the platform OWNS: verification is never claimed, the
// root dies, the descendants survive as the documented leak.
const windowsKill = process.platform === 'win32'
const posixRootKillPin = async (label, pids) => {
  const r = killTreeVerified(pids[3])
  const lines = killFailureLines(pids[3], r)
  t(`${label} (POSIX): the root-only kill never claims verification — verified false, no survivor claim, reaped 0 (KI#9)`,
    r.rootWasLive === true && r.verified === false && Array.isArray(r.survivors) && r.survivors.length === 0 && r.reaped === 0)
  t(`${label} (POSIX): the loud named line verbatim (fail-closed, T-011)`,
    lines.length === 1 && lines[0] === `CLEANUP FAIL: pid ${pids[3]} tree kill could not be verified (descendant verification unavailable)`)
  await waitUntilDead([pids[3]])
  t(`${label} (POSIX): the root is dead; the spawned descendants survive as the documented KI#9 leak`,
    !isAlive(pids[3]) && isAlive(pids[2]) && isAlive(pids[1]))
}

// ---------- A — the diagnosed leg: transient snapshot failure, outcome proven good ----------
{
  const { pids } = await plantTree('a')
  if (windowsKill) {
    let calls = 0
    const snap = transientSnapshot()
    const r = killTreeVerified(pids[3], {
      snapshotTree: (pid) => {
        calls++
        return snap(pid)
      },
    })
    const lines = killFailureLines(pids[3], r)
    console.log(`    A observed failure lines: ${JSON.stringify(lines)}`)
    t('A: the transient-snapshot leg reports a live root', r.rootWasLive === true)
    t('A: verified-when-proven-dead — verified true, no survivors', r.verified === true && Array.isArray(r.survivors) && r.survivors.length === 0)
    t('A: reaped counts the full pre-kill tree (root, mid, leaf)', r.reaped === 3)
    t('A: NO failure line for the proven-dead outcome', lines.length === 0)
    t('A: the success line carries the verified reaped count', killSuccessLine(r) === 'tree killed, verified: 3 processes reaped')
    t('A: exactly one bounded pre-kill retry (no unbounded loop)', calls === 2)
    await waitUntilDead([pids[1], pids[2], pids[3]])
    t('A: whole tree dead on the real process table', treeReallyDead([pids[1], pids[2], pids[3]]))
  } else {
    await posixRootKillPin('A', pids)
  }
}

// ---------- B — the reporting surface, pure (never-weakened pins) ----------
{
  const verifiedDead = { rootWasLive: true, verified: true, survivors: [], reaped: 7 }
  t('B: a verified-dead outcome emits NO failure line', killFailureLines(424242, verifiedDead).length === 0)
  t('B: the success line carries the reaped count verbatim', killSuccessLine(verifiedDead) === 'tree killed, verified: 7 processes reaped')
  const survivorShape = { rootWasLive: true, verified: false, survivors: [555], reaped: 0 }
  t('B: a survivor outcome keeps its per-pid line verbatim', killFailureLines(424242, survivorShape)[0] === 'CLEANUP FAIL: pid 555 survived taskkill /T /F')
  const unverifiable = { rootWasLive: true, verified: false, survivors: [], reaped: 0 }
  t('B: an unverifiable outcome keeps its loud named line verbatim', killFailureLines(424242, unverifiable)[0] === 'CLEANUP FAIL: pid 424242 tree kill could not be verified (descendant verification unavailable)')
  const deadRoot = { rootWasLive: false, verified: false, survivors: [], reaped: 0 }
  t('B: a dead-root outcome keeps its named line verbatim (Known issue #8 untouched)', killFailureLines(424242, deadRoot)[0] === 'CLEANUP FAIL: root pid 424242 already gone before kill; descendant verification impossible')
}

// ---------- C — genuine survivors keep their per-pid lines (normal path) ----------
{
  const { pids } = await plantTree('c')
  if (windowsKill) {
    const r = killTreeVerified(pids[3], { isAlive: forcedAlive(pids[2]) })
    const lines = killFailureLines(pids[3], r)
    t('C: a survivor keeps the loud verdict — verified false, survivor named, reaped 0', r.verified === false && r.survivors.length === 1 && r.survivors[0] === pids[2] && r.reaped === 0)
    t('C: the survivor keeps its per-pid line verbatim', lines.some((l) => l === `CLEANUP FAIL: pid ${pids[2]} survived taskkill /T /F`))
    await waitUntilDead([pids[1], pids[2], pids[3]])
    t('C: the forced-alive pin was a reporting stub, not a real survivor — tree really dead', treeReallyDead([pids[1], pids[2], pids[3]]))
  } else {
    await posixRootKillPin('C', pids)
  }
}

// ---------- D — genuinely unverifiable stays loud; the kill is never skipped ----------
{
  const { pids } = await plantTree('d')
  if (windowsKill) {
    let calls = 0
    const snap = alwaysDownSnapshot()
    const r = killTreeVerified(pids[3], {
      snapshotTree: (pid) => {
        calls++
        return snap(pid)
      },
    })
    const lines = killFailureLines(pids[3], r)
    t('D: the unverifiable outcome reports verified false with no survivor claim', r.rootWasLive === true && r.verified === false && r.reaped === 0 && Array.isArray(r.survivors) && r.survivors.length === 0)
    t('D: genuinely unverifiable stays loud — the named line verbatim (fail-closed, T-011)', lines.length === 1 && lines[0] === `CLEANUP FAIL: pid ${pids[3]} tree kill could not be verified (descendant verification unavailable)`)
    t('D: bounded verification attempts (two pre-kill + one post-kill re-check)', calls === 3)
    await waitUntilDead([pids[1], pids[2], pids[3]])
    t('D: the kill was never skipped — whole tree dead on the real process table', treeReallyDead([pids[1], pids[2], pids[3]]))
  } else {
    await posixRootKillPin('D', pids)
  }
}

// ---------- E — the post-kill re-check leg: upgrade to verified-when-proven-dead ----------
{
  const { pids } = await plantTree('e')
  if (windowsKill) {
    let calls = 0
    const snap = downThroughKillSnapshot()
    const r = killTreeVerified(pids[3], {
      snapshotTree: (pid) => {
        calls++
        return snap(pid)
      },
    })
    const lines = killFailureLines(pids[3], r)
    console.log(`    E observed failure lines: ${JSON.stringify(lines)}`)
    t('E: the post-kill re-check upgrades the outcome — verified true, no survivors', r.rootWasLive === true && r.verified === true && Array.isArray(r.survivors) && r.survivors.length === 0)
    t('E: reaped counts the re-check enumeration (root + anything still linked)', r.reaped >= 1)
    t('E: NO failure line for the proven-dead outcome', lines.length === 0)
    t('E: bounded verification attempts (two pre-kill + one post-kill re-check)', calls === 3)
    await waitUntilDead([pids[1], pids[2], pids[3]])
    t('E: whole tree dead on the real process table', treeReallyDead([pids[1], pids[2], pids[3]]))
  } else {
    await posixRootKillPin('E', pids)
  }
}

// ---------- F — the post-kill re-check stays loud on a live process ----------
{
  const { pids } = await plantTree('f')
  if (windowsKill) {
    let calls = 0
    const snap = downThroughKillSnapshot()
    // The re-check's enumeration on a cleanly-killed tree is the root alone
    // (the fresh table no longer links the dead descendants), so the loud
    // direction is forced on the ROOT: a kill that did not take is caught by
    // the re-check and keeps its per-pid line.
    const r = killTreeVerified(pids[3], {
      snapshotTree: (pid) => {
        calls++
        return snap(pid)
      },
      isAlive: forcedAlive(pids[3]),
    })
    const lines = killFailureLines(pids[3], r)
    t('F: a live process the re-check finds stays loud — verified false, survivor named, reaped 0', r.verified === false && r.survivors.length === 1 && r.survivors[0] === pids[3] && r.reaped === 0)
    t('F: the survivor keeps its per-pid line verbatim', lines.some((l) => l === `CLEANUP FAIL: pid ${pids[3]} survived taskkill /T /F`))
    await waitUntilDead([pids[1], pids[2], pids[3]])
    t('F: the forced-alive pin was a reporting stub, not a real survivor — tree really dead', treeReallyDead([pids[1], pids[2], pids[3]]))
  } else {
    await posixRootKillPin('F', pids)
  }
}

// ---------- R — the REAL-failure leg: powershell unresolvable, fail-closed end to end ----------
{
  const { pids } = await plantTree('r')
  if (windowsKill) {
    // Both preconditions asserted (the T-052 check's R6 pattern), so a machine
    // where the unavailability cannot be forced fails this leg loudly instead
    // of running it vacuously.
    const positive = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true })
    t('R precondition: powershell.exe resolves under the normal PATH (the snapshot works when present)', positive.status === 0)
    const strippedPath = process.env.PATH.split(';').filter((seg) => seg.trim() !== '' && !/WindowsPowerShell/i.test(seg)).join(';')
    const envStripped = { ...process.env }
    delete envStripped.PATH
    envStripped.PATH = strippedPath
    const negative = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true, env: envStripped })
    t('R precondition: powershell.exe does NOT resolve under the stripped PATH (unavailability forced deterministically)', negative.error !== undefined || negative.status !== 0)
    // The REAL drive — no stubs: every snapshot attempt fails for real (ENOENT),
    // the kill fires anyway, and the outcome stays exactly the loud
    // unverifiable shape. On main's engine this was the recorded red bar: the
    // fifth observation's signature (a real snapshot failure around a kill
    // whose tree the real table proves dead, reported as a CLEANUP FAIL).
    const savedPath = process.env.PATH
    let r
    try {
      process.env.PATH = strippedPath
      r = killTreeVerified(pids[3])
    } finally {
      process.env.PATH = savedPath
    }
    const lines = killFailureLines(pids[3], r)
    console.log(`    R observed failure lines: ${JSON.stringify(lines)}`)
    t('R: the real-failure drive reports a live root, unverified, no survivor claim, reaped 0', r.rootWasLive === true && r.verified === false && Array.isArray(r.survivors) && r.survivors.length === 0 && r.reaped === 0)
    t('R: genuinely unverifiable stays loud — the named line verbatim (fail-closed, T-011)', lines.length === 1 && lines[0] === `CLEANUP FAIL: pid ${pids[3]} tree kill could not be verified (descendant verification unavailable)`)
    await waitUntilDead([pids[1], pids[2], pids[3]])
    t('R: the kill was never skipped — whole tree dead on the real process table', treeReallyDead([pids[1], pids[2], pids[3]]))
    t('R: the normal PATH is restored after the drive', process.env.PATH === savedPath)
  } else {
    await posixRootKillPin('R', pids)
  }
}

// ---------- sweep: nothing planted outlives this check ----------
for (const pid of planted) {
  if (isAlive(pid)) {
    try {
      killTreeVerified(pid)
    } catch {
      // best-effort; the assertions above already proved the kills work
    }
  }
}
rmSync(sandbox, { recursive: true, force: true })

console.log(`\n=== check-kill-verify-upgrade (Gate 1.40): ${failures.length === 0 ? `ALL GREEN (${assertions} assertions)` : `${failures.length} failure(s) of ${assertions}`} ===`)
process.exit(failures.length === 0 ? 0 : 1)
