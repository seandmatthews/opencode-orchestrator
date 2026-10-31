// Run-root resolution self-check (Gate 1.51, fast tier, T-065) — run under tsx:
//   node node_modules/tsx/dist/cli.mjs scripts/check-run-root.mjs
// Token-free, deterministic, no opencode involvement. Pins the platform-aware
// default run root: `C:\swarm` on Windows (the documented default since the
// 2026-10-10 Windows-first decision), `$HOME/swarm` elsewhere, and
// `SWARM_RUN_ROOT` overriding both — plus the store DB derivation and one
// end-to-end leg proving the env override reaches a real CLI's defaulting
// (the lock CLI with NO --run-root must create its lock under the override,
// never under the platform default).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultRunRoot, defaultStoreDb } from '../src/run-root.ts'

const failures = []
const t = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'}: ${name}`)
  if (!cond) failures.push(name)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = join(root, '.verify-run-root-sandbox')
const isWindows = process.platform === 'win32'
const expectedDefault = isWindows ? 'C:\\swarm' : join(homedir(), 'swarm')
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// ---------- S1 — the resolver's contract, unit-level ----------
const savedEnv = process.env.SWARM_RUN_ROOT
delete process.env.SWARM_RUN_ROOT
t('S1: default run root is C:\\swarm on Windows, $HOME/swarm elsewhere',
  defaultRunRoot() === expectedDefault)
t('S1: default store DB sits at <default run root>/refinery.db',
  defaultStoreDb() === join(expectedDefault, 'refinery.db'))
const override = join(sandbox, 'override')
process.env.SWARM_RUN_ROOT = override
t('S1: SWARM_RUN_ROOT overrides the platform default', defaultRunRoot() === override)
t('S1: the override flows into the default store DB', defaultStoreDb() === join(override, 'refinery.db'))
if (savedEnv === undefined) delete process.env.SWARM_RUN_ROOT
else process.env.SWARM_RUN_ROOT = savedEnv

// ---------- S2 — end-to-end: the lock CLI honors SWARM_RUN_ROOT ----------
// A throwaway git repo, the Gate 1.5 pattern; acquire + release through the
// REAL src/lock.ts with NO --run-root and SWARM_RUN_ROOT pointing at the
// override. The lock file must land under <override>/locks/.
const repo = join(sandbox, 'repo')
mkdirSync(repo, { recursive: true })
const identity = ['-c', 'user.name=check-run-root', '-c', 'user.email=runroot@local']
execFileSync('git', ['-C', repo, 'init', '-b', 'main'], { stdio: 'ignore' })
writeFileSync(join(repo, 'file.txt'), 'baseline\n')
execFileSync('git', ['-C', repo, ...identity, 'add', '-A'], { stdio: 'ignore' })
execFileSync('git', ['-C', repo, ...identity, 'commit', '-m', 'baseline'], { stdio: 'ignore' })

const runLock = (args) => spawnSync(process.execPath, [tsxCli, join(root, 'src', 'lock.ts'), ...args], {
  encoding: 'utf8',
  env: { ...process.env, SWARM_RUN_ROOT: override },
})
const acquire = runLock(['acquire', repo])
t('S2: lock acquire honors SWARM_RUN_ROOT without --run-root (exit 0)', acquire.status === 0)
const overrideLocks = join(override, 'locks')
const lockFiles = existsSync(overrideLocks) ? readdirSync(overrideLocks).filter((f) => f.endsWith('.lock')) : []
t('S2: the lock file was created under <SWARM_RUN_ROOT>/locks/', lockFiles.length === 1)
const release = runLock(['release', repo])
t('S2: lock release exits 0 and leaves no lock file behind',
  release.status === 0 && (!existsSync(overrideLocks) || readdirSync(overrideLocks).length === 0))

rmSync(sandbox, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`check-run-root: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log('check-run-root: all green')
