import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { CommitArea } from './config.ts'
import { log, loopFile } from './state.ts'

const git = (root: string, args: string[]): void => {
  execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
}

function gitOk(root: string, args: string[]): boolean {
  try { git(root, args); return true } catch { return false }
}

export function loopTitle(trackDir: string, loop: number): string {
  try {
    const m = /^# Loop \d+ — (.*)$/m.exec(readFileSync(loopFile(trackDir, loop), 'utf8'))
    if (m) return m[1]
  } catch { /* fall through */ }
  return `loop ${loop}`
}

// Commit a passed loop's work — agents never commit; work accumulates uncommitted until qa
// approves, then this runs, so history reads as one commit per loop, not per turn.
// Default (areas null): one `git add -A` commit `loop(<N>): <title>`. commitAreas reproduces
// fixed-order per-area commits `loop(<N>)[<name>]: <title>`; a "-A" path sweeps the rest —
// keep it last. A commit rejected (pre-commit hook) → unstage, warn, stop committing; the
// work stays in the tree for a human. Never push. Never amend. Never bypass hooks.
export function commitLoop(root: string, trackDir: string, loop: number, areas: CommitArea[] | null): boolean {
  const title = loopTitle(trackDir, loop)
  const list: CommitArea[] = areas ?? [{ name: '', path: '-A' }]
  for (const area of list) {
    if (area.path === '-A') {
      // A failed add (stale index.lock) degrades like a failed commit — warn, never crash.
      if (!gitOk(root, ['add', '-A'])) {
        log(`WARNING: git add -A failed for loop ${loop} — stopping; the loop's changes stay uncommitted for a human to resolve`)
        return false
      }
    } else {
      const spec = [area.path, ...(area.exclude ? [`:(exclude)${area.exclude}`] : [])]
      gitOk(root, ['add', '--', ...spec]) // path may not exist yet — skip quietly
    }
    if (gitOk(root, ['diff', '--cached', '--quiet'])) continue // nothing staged for this area
    const msg = area.name ? `loop(${loop})[${area.name}]: ${title}` : `loop(${loop}): ${title}`
    try {
      git(root, ['commit', '-q', '-m', msg])
      log(`loop commit: ${msg}`)
    } catch {
      log(
        `WARNING: "${msg}" commit failed (likely a pre-commit hook rejection) — unstaging; the loop's remaining changes stay uncommitted for a human to resolve`,
      )
      gitOk(root, ['reset', '-q'])
      return false
    }
  }
  return true
}
