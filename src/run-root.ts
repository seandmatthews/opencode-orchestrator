import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The engine's default run root (T-065): `C:\swarm` on Windows (the
 * documented default since the 2026-10-10 Windows-first decision),
 * `$HOME/swarm` elsewhere, and `SWARM_RUN_ROOT` overrides both — the one
 * knob a WSL/Linux setup needs. Mirrored in scripts/swarm-root.mjs for the
 * plain-node verify tier (scripts/verify.mjs runs without tsx).
 */
export function defaultRunRoot(): string {
  return process.env.SWARM_RUN_ROOT ?? (process.platform === 'win32' ? 'C:\\swarm' : join(homedir(), 'swarm'))
}

/** The default durable store DB, under the default run root. */
export function defaultStoreDb(): string {
  return join(defaultRunRoot(), 'refinery.db')
}
