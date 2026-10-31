// Lock-ownership + fail-closed recover identity self-check (Gate 1.38, fast
// tier, T-052) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-lock-ownership.mjs
//
// Pins register R4's two fail-open seams, both now refusing when verification
// cannot run (the engine's refusal vocabulary applied to its own recovery
// machinery):
//
//   lock (src/lock.ts) — programmatic release verifies OWNERSHIP first:
//     L1  a normal acquire/release pair still releases, silently (every
//         existing Gate 1.5 lock check rides green unchanged);
//     L2  the takeover sequence — A acquires, B force-acquires
//         (--force-lock), A's finally-release — ends with B's lock INTACT,
//         byte-identical, and a loud "held by pid N — force-taken; not
//         releasing" line (pre-T-052: A's release DELETED B's lock — the
//         mutual-exclusion break recorded as this gate's red bar);
//     L3  a garbage lock file is never unlinked by programmatic release
//         (loud unreadable skip — never delete what you cannot identify);
//     L4  the lock CLI's `release` verb still drops ANY holder — the
//         documented human override (--force-lock's counterpart);
//     L5  a force-taker's own release pairs with its acquire (the
//         `clean --force-lock` shape), silently.
//
//   recover (src/recover.ts) — the identity check fails CLOSED:
//     R1-R3 (generated driver, injected creation-time probe — the T-052
//         seam, defaulting to the real PowerShell spawn): identity
//         unavailable (probe null / dispatch stamp unreadable / creation
//         time unparseable) → NO kill attempted for that pid, the loud
//         "identity could not be established (...) — NOT killing pid N;
//         kill it manually if it is a leftover" record present, the live
//         child untouched on the real process table;
//     R4  identity available and matching → the kill proceeds exactly as
//         today (real taskkill tree kill, child dead, kill recorded);
//     R5  identity available and MISMATCHED → refused (existing behavior,
//         now pinned): identity-mismatch cleanup failure, child alive;
//     R6  end-to-end through the real `recover` command with PowerShell
//         unresolvable (PATH stripped of every WindowsPowerShell segment —
//         the ticket's "PowerShell missing" cause, forced
//         deterministically; both preconditions asserted): the REAL probe
//         answers unavailable → refuse-to-kill, exit 1, the loud record in
//         stdout AND recovery.json (reason identity-unavailable), the
//         orphan still alive, the checkout lock still released.
//
// Zero model tokens, no opencode. The check imports src/lock.ts directly
// (safe pre- and post-T-052 — lock.ts has the run-directly entry guard);
// src/recover.ts is NEVER imported in-process here: the injected-probe legs
// run in a generated driver subprocess so this check also runs cleanly
// against pre-T-052 code (where importing recover.ts executes its CLI main
// and exits) — that property is what made the AGENTS #8 red bar a single
// `node ... check-lock-ownership.mjs` run against main's engine.
import { killTree } from './kill-tree.mjs'
import { swarmRoot } from './swarm-root.mjs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acquireCheckoutLock, lockPathFor, releaseCheckoutLock } from '../src/lock.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const lockTs = join(root, 'src', 'lock.ts')
const recoverTs = join(root, 'src', 'recover.ts')
const sandbox = swarmRoot + '/verify-lock-ownership'

rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })

// Every real child this check spawns, for teardown (AGENTS.md #10).
const orphans = []
const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code !== 'ESRCH'
  }
}
const killOrphans = () => {
  for (const pid of orphans.splice(0)) {
    if (!isAlive(pid)) continue
    try {
      killTree(pid)
      console.log(`teardown: killed leftover child pid ${pid}`)
    } catch {
      // already gone
    }
  }
}

// ---------- lock legs (src/lock.ts) ----------

const lockRoot = join(sandbox, 'runs')
const lockRepo = join(sandbox, 'repo') // never needs to exist: the lock path derives from the normalized repo string
const lp = lockPathFor(lockRoot, lockRepo)
const lockFiles = () => {
  try {
    return readdirSync(join(lockRoot, 'locks')).filter((f) => f.endsWith('.lock'))
  } catch {
    return []
  }
}

/** Capture console.error around a programmatic release (the loud skip lines). */
const captureErr = (fn) => {
  const lines = []
  const orig = console.error
  console.error = (...a) => lines.push(a.join(' '))
  try {
    fn()
  } finally {
    console.error = orig
  }
  return lines
}

const cliLock = (args) => {
  const r = spawnSync(process.execPath, [tsxCli, lockTs, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  return { code: r.status === null ? -1 : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}` }
}

// L1 — the normal pair is unchanged: releases, silently.
acquireCheckoutLock(lockRoot, lockRepo, { cmd: 'check-L1' })
const l1lines = captureErr(() => releaseCheckoutLock(lp))
t('L1: a normal acquire/release pair still releases (lock file gone)', !existsSync(lp))
t('L1: the normal release is silent (no loud skip line)', l1lines.length === 0)

// L2 — the takeover sequence (the ticket's red bar (a), pinned green here).
acquireCheckoutLock(lockRoot, lockRepo, { cmd: 'check-A' }) // A = this process
const taken = cliLock(['acquire', lockRepo, '--run-root', lockRoot, '--force-lock']) // B = the CLI child
t('L2: B\'s --force-lock acquire takes the lock over A (exit 0, acquisition semantics unchanged)', taken.code === 0)
const bBytes = existsSync(lp) ? readFileSync(lp, 'utf8') : ''
const bPid = (() => {
  try {
    const parsed = JSON.parse(bBytes)
    return typeof parsed.pid === 'number' ? parsed.pid : null
  } catch {
    return null
  }
})()
t('L2: the taken-over lock file names B (a pid other than A\'s)', bPid !== null && bPid !== process.pid)
const l2lines = captureErr(() => releaseCheckoutLock(lp)) // A's programmatic (finally) release
t('L2: A\'s release SKIPS — B\'s lock is intact, byte-identical (pre-T-052 this DELETED B\'s lock)', existsSync(lp) && readFileSync(lp, 'utf8') === bBytes)
t('L2: the skip is loud: the lock path, the foreign pid, and "not releasing"',
  l2lines.length === 1 && l2lines[0].includes(lp) && l2lines[0].includes(`pid ${bPid}`) && l2lines[0].includes('not releasing'))

// L3 — an unreadable lock file is never deleted by programmatic release.
const garbage = 'this is not json\n'
writeFileSync(lp, garbage)
const l3lines = captureErr(() => releaseCheckoutLock(lp))
t('L3: a garbage lock file is never unlinked by programmatic release (file intact)', existsSync(lp) && readFileSync(lp, 'utf8') === garbage)
t('L3: the unreadable skip is loud, naming the path', l3lines.length === 1 && l3lines[0].includes(lp) && /unreadable|cannot identify/i.test(l3lines[0]))

// L4 — the CLI release verb stays the explicit human override: any holder drops.
writeFileSync(lp, JSON.stringify({ pid: 4194303, startedAt: new Date().toISOString(), cmd: 'foreign-holder' }, null, 2))
const r4a = cliLock(['release', lockRepo, '--run-root', lockRoot])
t('L4: the lock CLI release drops a foreign-pid holder (the documented human override)', r4a.code === 0 && !existsSync(lp))
writeFileSync(lp, 'garbage\n')
const r4b = cliLock(['release', lockRepo, '--run-root', lockRoot])
t('L4: the lock CLI release drops an unreadable lock too (any holder)', r4b.code === 0 && !existsSync(lp))
t('L4: no lock files left after the CLI override legs', lockFiles().length === 0)

// L5 — a force-taker's own release pairs with its acquire (clean --force-lock shape).
writeFileSync(lp, JSON.stringify({ pid: 4194303, startedAt: new Date().toISOString(), cmd: 'stale-holder' }, null, 2))
acquireCheckoutLock(lockRoot, lockRepo, { cmd: 'check-L5' }, true) // force-take, exactly like `clean --force-lock`
const l5lines = captureErr(() => releaseCheckoutLock(lp))
t('L5: a force-taker\'s own release still releases, silently (the clean --force-lock pairing)', !existsSync(lp) && l5lines.length === 0)

// ---------- recover identity legs (src/recover.ts) ----------
// R1-R5 run in a generated driver subprocess with an INJECTED creation-time
// probe (the T-052 seam) driving the real kill-site machinery against real
// live children on the real process table.

function writeRecoverDriver() {
  const mod = (p) => pathToFileURL(join(root, p)).href
  const src = `
import { spawn } from 'node:child_process'
import { killTree } from '${mod(join('scripts', 'kill-tree.mjs'))}'
import { identityMatches, reconcileKills } from '${mod(join('src', 'recover.ts'))}'

const failures = []
const t = (name, cond) => { console.log((cond ? 'ok' : 'FAIL') + ': ' + name); if (!cond) failures.push(name) }
const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const spawnSleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true })
// T-065: the platform-faithful sweep kill — raw taskkill is a Windows-only
// binary, and a survivor left alive here pins the driver's event loop open
// (its ChildProcess handle) past ALL GREEN, into the outer 120s timeout.
const killPid = (pid) => { try { killTree(pid) } catch {} }
const captureLog = (fn) => {
  const lines = []
  const orig = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try { fn() } finally { console.log = orig }
  return lines
}

const survivor = spawnSleeper() // one live child shared by every no-kill leg
const victim = spawnSleeper() // killed by the R4 matching leg
const now = Date.now()
const dispatch = { type: 'dispatch', jobId: 'j1', attempt: 1, startedAt: new Date(now - 1000).toISOString() }
const pidRecord = (pid) => ({ type: 'pid', jobId: 'j1', attempt: 1, pid, at: new Date(now).toISOString() })

async function main() {
  // R1 — the probe itself unavailable (PowerShell missing/blocked, protected
  // process, non-Windows host): refuse to kill.
  {
    const verdict = identityMatches(dispatch, pidRecord(survivor.pid), () => null)
    t('R1: probe unavailable -> identityMatches refuses (ok false, unavailable true)', verdict.ok === false && verdict.unavailable === true)
    let out
    const lines = captureLog(() => { out = reconcileKills([dispatch], new Map([['j1#1', pidRecord(survivor.pid)]]), () => null) })
    const f = out.cleanupFailures[0]
    const loudMessage = typeof f?.message === 'string' && f.message.startsWith('identity could not be established (')
      && f.message.includes(') — NOT killing pid ' + survivor.pid + '; kill it manually if it is a leftover')
    t('R1: identity-unavailable -> NO kill attempted (child still alive), reason identity-unavailable, the mandated loud record in the failure AND stdout',
      out.kills.length === 0 && out.cleanupFailures.length === 1 && f.reason === 'identity-unavailable' && f.pid === survivor.pid
      && loudMessage && lines.length === 1 && lines[0].includes('NOT killing pid ' + survivor.pid)
      && isAlive(survivor.pid))
  }
  // R2 — the dispatch stamp unreadable: refuse to kill.
  {
    const d2 = { ...dispatch, startedAt: undefined }
    const verdict = identityMatches(d2, pidRecord(survivor.pid), () => new Date(now - 500).toISOString())
    t('R2: dispatch stamp unreadable -> the unavailable class refuses (ok false, unavailable true)', verdict.ok === false && verdict.unavailable === true)
    const out = reconcileKills([d2], new Map([['j1#1', pidRecord(survivor.pid)]]), () => new Date(now - 500).toISOString())
    t('R2: no kill attempted for an unreadable dispatch stamp (child alive)', out.kills.length === 0
      && out.cleanupFailures[0]?.reason === 'identity-unavailable' && isAlive(survivor.pid))
  }
  // R3 — the creation time unparseable: refuse to kill.
  {
    const verdict = identityMatches(dispatch, pidRecord(survivor.pid), () => 'not-a-timestamp')
    t('R3: creation time unparseable -> the unavailable class refuses (ok false, unavailable true)', verdict.ok === false && verdict.unavailable === true)
    const out = reconcileKills([dispatch], new Map([['j1#1', pidRecord(survivor.pid)]]), () => 'not-a-timestamp')
    t('R3: no kill attempted for an unparseable creation time (child alive)', out.kills.length === 0
      && out.cleanupFailures[0]?.reason === 'identity-unavailable' && isAlive(survivor.pid))
  }
  // R4 — identity available and matching: the kill proceeds exactly as today.
  {
    const inside = new Date(now - 500).toISOString()
    const p4 = pidRecord(victim.pid)
    const verdict = identityMatches(dispatch, p4, () => inside)
    t('R4: identity available and matching -> verdict ok with the window note', verdict.ok === true && verdict.unavailable === false
      && verdict.note.includes('inside the dispatch evidence window'))
    const out = reconcileKills([dispatch], new Map([['j1#1', p4]]), () => inside)
    await sleep(500) // let the taskkill settle on the process table
    t('R4: the kill proceeds exactly as today — real tree kill, child dead, kill recorded with the window note',
      out.kills.length === 1 && out.kills[0].pid === victim.pid && out.kills[0].jobId === 'j1'
      && out.cleanupFailures.length === 0 && !isAlive(victim.pid))
  }
  // R5 — identity available and MISMATCHED: refused (existing behavior, pinned).
  {
    const verdict = identityMatches(dispatch, pidRecord(survivor.pid), () => '2020-01-01T00:00:00.000Z')
    t('R5: identity available and MISMATCHED -> refused as a mismatch (ok false, NOT the unavailable class)', verdict.ok === false && verdict.unavailable === false)
    const out = reconcileKills([dispatch], new Map([['j1#1', pidRecord(survivor.pid)]]), () => '2020-01-01T00:00:00.000Z')
    t('R5: mismatched identity -> identity-mismatch cleanup failure, no kill, child alive', out.kills.length === 0
      && out.cleanupFailures[0]?.reason === 'identity-mismatch' && isAlive(survivor.pid))
  }
}

main()
  .catch((e) => { failures.push('driver crashed: ' + (e instanceof Error ? e.message : String(e))); console.error(e) })
  .finally(() => {
    killPid(survivor.pid)
    if (isAlive(victim.pid)) killPid(victim.pid)
    if (failures.length > 0) {
      console.error('recover-driver: ' + failures.length + ' failure(s)')
      process.exit(1)
    }
    console.log('recover-driver: ALL GREEN')
  })
`
  const p = join(sandbox, 'recover-driver.mjs')
  writeFileSync(p, src)
  return p
}

const driver = writeRecoverDriver()
try {
  run(process.execPath, [tsxCli, driver], { stdio: 'inherit', timeout: 120_000 })
  t('R1-R5: the injected-probe recover identity legs all pass (driver exit 0)', true)
} catch (e) {
  t('R1-R5: the injected-probe recover identity legs all pass (driver exit 0)', false)
  console.error(`--- recover-driver exited ${e.status ?? '?'} (output streamed above) ---`)
}

// R6 — end-to-end through the real recover command, PowerShell unresolvable:
// every WindowsPowerShell segment stripped from the child's PATH, so the REAL
// creation-time probe answers unavailable (execFileSync ENOENT — the ticket's
// "PowerShell missing" cause). Both preconditions are asserted so an
// environment where this cannot be forced fails LOUDLY here, never silently
// degrades into a vacuous leg.
// T-065: PATH separators are ';' on Windows, ':' on POSIX — the strip must
// remove only the powershell-bearing segments either way. (The ';' split on
// POSIX treated the whole colon-joined PATH as ONE segment and deleted it,
// leaving the child recover without git.)
const pathSep = process.platform === 'win32' ? ';' : ':'
const strippedPath = process.env.PATH.split(pathSep).filter((seg) => seg.trim() !== '' && !/WindowsPowerShell/i.test(seg)).join(pathSep)
const envStripped = { ...process.env }
for (const k of Object.keys(envStripped)) {
  if (k.toLowerCase() === 'path') delete envStripped[k]
}
envStripped.PATH = strippedPath
const positive = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true })
const negative = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true, env: envStripped })
t('R6 precondition: powershell.exe resolves under the normal PATH (the probe works when present)', positive.status === 0)
t('R6 precondition: powershell.exe does NOT resolve under the stripped PATH (unavailability forced deterministically)', negative.error !== undefined || negative.status !== 0)
if (positive.status === 0 && (negative.error !== undefined || negative.status !== 0)) {
  // A real sandbox repo (recover's workspace inspection runs git) + a real
  // live orphan named by synthetic dispatch evidence with current stamps.
  const name = 'path-strip'
  const repo = join(sandbox, name, 'repo')
  mkdirSync(repo, { recursive: true })
  const g = (...args) => run('git', ['-C', repo, ...args])
  const ident = ['-c', 'user.name=check-lock-ownership', '-c', 'user.email=lockown@local']
  g('init', '-b', 'main')
  writeFileSync(join(repo, 'base.txt'), 'baseline\n')
  g(...ident, 'add', '-A')
  g(...ident, 'commit', '-m', 'baseline')
  const baseSha = g('rev-parse', 'HEAD').trim()
  const runRoot = join(sandbox, name, 'runs')
  const runId = '20991010160000'
  const runDir = join(runRoot, runId)
  mkdirSync(join(runDir, 'wt'), { recursive: true })
  const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true })
  orphan.unref() // the handle must never pin this check's event loop — teardown below kills it
  orphans.push(orphan.pid)
  const nowIso = new Date().toISOString()
  writeFileSync(join(runDir, 'dispatch.jsonl'), [
    { type: 'run', runId, repo, baseSha, goal: 'path-strip fail-closed probe', model: 'fake/model', maxAttempts: 1, startedAt: nowIso },
    { type: 'dispatch', jobId: 'j1', attempt: 1, leaseId: 'wt/j1', branch: 'swarm/wt-j1', worktreePath: join(runDir, 'wt', 'j1'), startedAt: nowIso },
    { type: 'pid', jobId: 'j1', attempt: 1, pid: orphan.pid, at: nowIso },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  const r = spawnSync(process.execPath, [tsxCli, recoverTs, '--run', runId, '--run-root', runRoot, '--db', join(sandbox, name, 'recovery.db')],
    { encoding: 'utf8', windowsHide: true, env: envStripped, timeout: 120_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}`
  t('R6: with the real probe unavailable, recover refuses to kill — exit 1', r.status === 1)
  t('R6: the loud record is on stdout, verbatim (identity could not be established / NOT killing pid / kill it manually)',
    out.includes('identity could not be established') && out.includes(`NOT killing pid ${orphan.pid}`) && out.includes('kill it manually'))
  t('R6: the orphan is STILL ALIVE on the real process table (no kill attempted)', isAlive(orphan.pid))
  const recoveryPath = join(runDir, 'recovery.json')
  if (existsSync(recoveryPath)) {
    const recovery = JSON.parse(readFileSync(recoveryPath, 'utf8'))
    const f = recovery.cleanupFailures?.[0]
    const r6ok = recovery.kills.length === 0 && f?.reason === 'identity-unavailable' && f?.pid === orphan.pid
      && typeof f?.message === 'string' && f.message.includes('NOT killing pid') && f.message.includes('kill it manually if it is a leftover')
    if (!r6ok) {
      console.error(`--- R6 recovery.json mismatch: kills=${JSON.stringify(recovery.kills)} failures=${JSON.stringify(recovery.cleanupFailures)} ---`)
    }
    t('R6: recovery.json records reason identity-unavailable with the mandated message and zero kills', r6ok)
  } else {
    console.error(`--- R6: recovery.json absent (recover exit ${r.status}); recover output tail ---\n${out.slice(-1200)}`)
    t('R6: recovery.json records reason identity-unavailable with the mandated message and zero kills', false)
  }
  t('R6: the checkout lock was still taken and released on the refusing path (no .lock residue)',
    (() => { try { return readdirSync(join(runRoot, 'locks')).filter((f) => f.endsWith('.lock')).length === 0 } catch { return true } })())
} else {
  t('R6: PowerShell unresolvability could not be forced on this machine (leg not vacuous — see preconditions)', false)
}

// Teardown (AGENTS.md #10): the R6 orphan SURVIVES by design (the leg pins
// that recover refused to kill it) — reap it here, then drop the sandbox.
killOrphans()
rmSync(sandbox, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\ncheck-lock-ownership: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-lock-ownership: ALL GREEN')
