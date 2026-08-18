import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  advanceLoop,
  discoverLoops,
  loopFile,
  initState,
  normalizeRole,
  readState,
  syncLoops,
  updateLoopStatusDoc,
  type State,
} from '../src/state.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'loopcast-'))

const base = (over: Partial<State>): State => ({
  track: 't',
  current_loop: 1,
  current_actor: 'dev',
  completed_loops: [],
  remaining_loops: [1, 2],
  status: 'idle',
  window_start: null,
  window_end: null,
  session_id: null,
  turn: 0,
  session_history: [],
  ...over,
})

test('discovery: loops/ subdir only, numeric sort, non-matching files ignored', () => {
  const d = dir()
  mkdirSync(join(d, 'loops'))
  for (const n of ['Loop10.md', 'Loop2.md', 'Loop1.md', 'LoopX.md', 'notes.md']) writeFileSync(join(d, 'loops', n), '')
  writeFileSync(join(d, 'Loop7.md'), '') // track root is NOT scanned
  assert.deepEqual(discoverLoops(d), [1, 2, 10])
  assert.equal(loopFile(d, 1), join(d, 'loops', 'Loop1.md'))
  assert.deepEqual(discoverLoops(mkdtempSync(join(tmpdir(), 'loopcast-'))), []) // no loops/ dir
})

test('initState: creates schema, no-op when file exists, null without loops', () => {
  const empty = dir()
  assert.equal(initState(empty, 't'), null)

  const d = dir()
  mkdirSync(join(d, 'loops'))
  writeFileSync(join(d, 'loops', 'Loop3.md'), '')
  const s = initState(d, 't')
  assert.ok(s)
  assert.equal(s.current_loop, 3)
  assert.deepEqual(s.remaining_loops, [3])
  assert.equal(s.status, 'idle')
  assert.ok(existsSync(join(d, 'logs')))

  s.turn = 7
  writeFileSync(join(d, 'state.json'), JSON.stringify(s))
  const again = initState(d, 't')
  assert.equal(again?.turn, 7) // re-run never resets progress
  assert.deepEqual(readState(d).remaining_loops, [3])
})

test('sync: new loops appended sorted, completed/current untouched', () => {
  const s = base({ current_loop: 2, completed_loops: [1], remaining_loops: [2, 3] })
  syncLoops(s, [1, 2, 3, 5, 4])
  assert.deepEqual(s.remaining_loops, [2, 3, 4, 5])
  assert.deepEqual(s.completed_loops, [1])
  assert.equal(s.current_loop, 2)
})

test('sync: null current promoted from remaining, dev up, idle', () => {
  const s = base({ current_loop: null, current_actor: 'qa', status: 'completed', completed_loops: [1, 2], remaining_loops: [] })
  syncLoops(s, [1, 2, 3])
  assert.equal(s.current_loop, 3)
  assert.equal(s.current_actor, 'dev')
  assert.equal(s.status, 'idle')
  assert.deepEqual(s.remaining_loops, [3]) // current stays in remaining until done
})

test('advance: current → completed, next popped, dev up; null when none left', () => {
  const s = base({ current_loop: 1, remaining_loops: [1, 2], current_actor: 'qa' })
  advanceLoop(s)
  assert.deepEqual(s.completed_loops, [1])
  assert.equal(s.current_loop, 2)
  assert.equal(s.current_actor, 'dev')
  advanceLoop(s)
  assert.equal(s.current_loop, null)
  assert.deepEqual(s.completed_loops, [1, 2])
})

test('normalizeRole: qa is qa, anything else plays dev', () => {
  assert.equal(normalizeRole('dev'), 'dev')
  assert.equal(normalizeRole('qa'), 'qa')
  assert.equal(normalizeRole('mystery'), 'dev')
})

test('updateLoopStatusDoc: replaces Status line, tolerates absence', () => {
  const d = dir()
  mkdirSync(join(d, 'loops'))
  writeFileSync(join(d, 'loops', 'Loop1.md'), '# Loop 1 — x\n\nPhase: y · Status: planned · Started: —\n')
  updateLoopStatusDoc(d, 1, 'in progress')
  assert.ok(readFileSync(join(d, 'loops', 'Loop1.md'), 'utf8').includes('Status: in progress'))
  updateLoopStatusDoc(d, 99, 'done') // missing file — no throw
})
