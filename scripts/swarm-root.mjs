// The verify tier's sandbox root, platform-aware (T-065): every check script
// and verify.mjs derives its throwaway git sandboxes from here instead of the
// historical hard-coded C:/swarm, so the token-free tier runs unchanged on
// Linux/WSL. Mirrors src/run-root.ts — same env var, same per-platform
// default — duplicated because verify.mjs runs under plain node while src/
// is TypeScript.
import { homedir } from 'node:os'

export const swarmRoot = process.env.SWARM_RUN_ROOT
  ?? (process.platform === 'win32' ? 'C:/swarm' : `${homedir()}/swarm`)
