import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Role = 'dev' | 'qa'

// actor = the agent binary name (claude/codex)
export interface HistoryEntry {
  turn: number; role: string; actor: string; loop: number
  started_at: string; ended_at: string; exit_code: number; log_file: string
}

// current_actor holds the ROLE (dev/qa). window_start/window_end: kept for schema
// compatibility with the reference state shape; loopcast never sets them.
export interface State {
  track: string
  current_loop: number | null
  current_actor: string
  completed_loops: number[]
  remaining_loops: number[]
  status: 'idle' | 'running' | 'interrupted' | 'completed'
  window_start: number | null
  window_end: number | null
  session_id: string | null
  turn: number
  session_history: HistoryEntry[]
}

export const stateFile = (dir: string): string => join(dir, 'state.json')

// Loop specs live in <track>/loops/ — the only location scanned.
export const loopFile = (dir: string, loop: number): string => join(dir, 'loops', `Loop${loop}.md`)

export function discoverLoops(dir: string): number[] {
  try {
    return readdirSync(join(dir, 'loops'))
      .flatMap((n) => /^Loop(\d+)\.md$/.exec(n)?.[1] ?? [])
      .map(Number)
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

export const readState = (dir: string): State => JSON.parse(readFileSync(stateFile(dir), 'utf8')) as State

// The orchestrator is the ONLY writer of state.json — agents read it and communicate
// through Progress.md, which keeps the bookkeeping immune to an agent mis-editing JSON.
// Atomic: write tmp.<pid>, rename over — a reader never sees a half-written file.
export function saveState(dir: string, s: State): void {
  const f = stateFile(dir)
  const tmp = `${f}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n')
  renameSync(tmp, f)
}

// No-op if state.json exists — re-running never resets progress.
// Returns null if the track has no Loop*.md (nothing to run).
export function initState(dir: string, track: string): State | null {
  if (existsSync(stateFile(dir))) return readState(dir)
  const loops = discoverLoops(dir)
  if (loops.length === 0) return null
  mkdirSync(join(dir, 'logs'), { recursive: true })
  const s: State = {
    track, current_loop: loops[0], current_actor: 'dev', completed_loops: [],
    remaining_loops: loops, status: 'idle', window_start: null, window_end: null,
    session_id: null, turn: 0, session_history: [],
  }
  saveState(dir, s)
  return s
}

// Pick up Loop*.md added after state.json was created (initState is a no-op once the file
// exists, so a new batch of loop files would otherwise be invisible forever). New numbers
// append to remaining_loops; completed_loops / current_loop are never touched. If
// current_loop is null because a past run finished everything, promote the first remaining
// and hand it to dev. Idempotent — runs at every startup.
export function syncLoops(s: State, discovered: number[]): void {
  const known = new Set([...s.completed_loops, ...s.remaining_loops, ...(s.current_loop !== null ? [s.current_loop] : [])])
  const fresh = discovered.filter((n) => !known.has(n))
  s.remaining_loops = [...s.remaining_loops, ...fresh].sort((a, b) => a - b)
  if (s.current_loop === null && s.remaining_loops.length > 0) {
    s.current_loop = s.remaining_loops[0]
    s.current_actor = 'dev'
    s.status = 'idle'
  }
}

// qa said "READY FOR NEXT SESSION: YES": current → completed, pop the next remaining
// (or null), hand the new loop back to dev.
export function advanceLoop(s: State): void {
  if (s.current_loop === null) return
  s.completed_loops = [...s.completed_loops, s.current_loop]
  s.remaining_loops = s.remaining_loops.filter((n) => n !== s.current_loop)
  s.current_loop = s.remaining_loops[0] ?? null
  s.current_actor = 'dev'
}

// Tolerant read of current_actor: anything but "qa" plays dev.
export const normalizeRole = (actor: string): Role => (actor === 'qa' ? 'qa' : 'dev')

// Keep Loop<N>.md's human-readable `Status:` line in sync; tolerate absence.
export function updateLoopStatusDoc(dir: string, loop: number, status: 'in progress' | 'done'): void {
  const f = loopFile(dir, loop)
  if (!existsSync(f)) return
  const text = readFileSync(f, 'utf8')
  writeFileSync(f, text.replace(/Status: (planned|in progress|done)/, `Status: ${status}`))
}

// ── local-time formatting (reference used BSD `date`; formats preserved byte-for-byte) ──

const pad = (n: number) => String(n).padStart(2, '0')

function parts(d: Date) {
  const off = -d.getTimezoneOffset()
  const a = Math.abs(off)
  return {
    Y: d.getFullYear(), M: pad(d.getMonth() + 1), D: pad(d.getDate()),
    h: pad(d.getHours()), m: pad(d.getMinutes()), s: pad(d.getSeconds()),
    z: `${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}${pad(a % 60)}`,
  }
}

// %Y%m%d-%H%M%S — auto session ids + log file names
export const tsCompact = (d = new Date()): string => { const p = parts(d); return `${p.Y}${p.M}${p.D}-${p.h}${p.m}${p.s}` }
// %Y%m%d-%H%M — step session ids (one per calendar day, reused)
export const tsSessionDay = (d = new Date()): string => tsCompact(d).slice(0, 13)
export const tsDay = (d = new Date()): string => tsCompact(d).slice(0, 8)
// %Y-%m-%dT%H:%M:%S%z — session_history timestamps
export const isoLocal = (d = new Date()): string => { const p = parts(d); return `${p.Y}-${p.M}-${p.D}T${p.h}:${p.m}:${p.s}${p.z}` }
// %Y-%m-%d %H:%M %z — orchestrator-written Progress.md entry headers
export const tsHuman = (d = new Date()): string => { const p = parts(d); return `${p.Y}-${p.M}-${p.D} ${p.h}:${p.m} ${p.z}` }

export function log(msg: string): void {
  const p = parts(new Date())
  console.log(`[${p.Y}-${p.M}-${p.D} ${p.h}:${p.m}:${p.s} ${p.z}] ${msg}`)
}
