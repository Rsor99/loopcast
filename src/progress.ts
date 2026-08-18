import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const progressFile = (dir: string): string => join(dir, 'Progress.md')

export function seedProgress(dir: string, track: string): void {
  const f = progressFile(dir)
  if (existsSync(f)) return
  writeFileSync(
    f,
    `# Loop Progress — ${track}\n\n` +
      'Append-only engineering journal shared by the dev (implementation) and qa (review)\n' +
      'agents. Each turn adds exactly one entry at the end — never edit or remove an\n' +
      'existing entry. It is a log, not a source of truth — re-verify its claims against\n' +
      'the codebase before acting on them.\n',
  )
}

export function readProgress(dir: string): string {
  try { return readFileSync(progressFile(dir), 'utf8') } catch { return '' }
}

// Byte-offset snapshot (reference used a line count + tail; same two uses: emptiness
// check on the failure path, verbatim display). Only what THIS turn appended counts — a
// verdict grep over the whole file would pick up a previous loop's stale "YES" whenever a
// qa turn dies without writing, and silently mark loops done with zero work.
export const snapshot = (dir: string): number => readProgress(dir).length
export const appendedSince = (dir: string, snap: number): string => readProgress(dir).slice(snap)
export const appendEntry = (dir: string, entry: string): void => appendFileSync(progressFile(dir), entry)

export type Verdict = 'YES' | 'NO' | null

// Port of the reference awk: the window is the lines after the first line containing
// "· Turn <n> —" (the entry's header), ending at the next "## [" line. Located anywhere in
// the file on purpose — qa has inserted its entry mid-file instead of appending, which made
// an appended-window grep miss a real YES and loop forever on an approved loop. The
// stale-YES protection is preserved: another turn's entry can never match this turn's
// number, and a qa turn that wrote nothing still yields no verdict → dev pass.
function windowBounds(lines: string[], turn: number): [number, number] | null {
  const start = lines.findIndex((l) => l.includes(`· Turn ${turn} —`))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## [')) {
      end = i
      break
    }
  }
  return [start, end]
}

// Last verdict match in the window wins (port of `grep -o ... | tail -1`).
export function parseVerdict(text: string, turn: number): Verdict {
  const lines = text.split('\n')
  const bounds = windowBounds(lines, turn)
  if (!bounds) return null
  const window = lines.slice(bounds[0] + 1, bounds[1]).join('\n')
  const matches = [...window.matchAll(/READY FOR NEXT SESSION: *(YES|NO)/g)]
  const last = matches[matches.length - 1]
  if (!last) return null
  return last[1] === 'YES' ? 'YES' : 'NO'
}

// This turn's entry verbatim, header included — shown by the stall gate.
export function turnEntry(text: string, turn: number): string | null {
  const lines = text.split('\n')
  const bounds = windowBounds(lines, turn)
  if (!bounds) return null
  return lines.slice(bounds[0], bounds[1]).join('\n').trim()
}
