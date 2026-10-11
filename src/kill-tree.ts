import { execFileSync } from 'node:child_process'

/**
 * Kill a process and all descendants. Windows-first: worker harnesses
 * spawn trees (opencode -> tools), so a bare process.kill() is not
 * sufficient to stop a job.
 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // Process tree already gone; that is the outcome we wanted.
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}
