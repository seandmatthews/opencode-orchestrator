// The verify tier's process-tree kill, platform-faithful (T-065). Mirrors
// src/kill-tree.ts's posture exactly: on Windows the verbatim list-form
// `taskkill /pid X /T /F`; elsewhere a best-effort root SIGKILL with NO
// descendant verification (VERIFICATION.md Known issue #9) — cleanup
// sweepers degrade honestly instead of failing on a Windows-only binary.
import { execFileSync } from 'node:child_process'

export function killTree(pid) {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone — best-effort */ }
}

/** The single-process kill (`taskkill /pid X /F`, no /T): the target alone,
 *  its children deliberately spared — the T-010 crash scenario's shape, where
 *  the orphaned worker IS the evidence. */
export function killPid(pid) {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/pid', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone — best-effort */ }
}
