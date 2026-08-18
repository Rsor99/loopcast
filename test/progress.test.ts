import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerdict, turnEntry } from '../src/progress.ts'

const entry = (turn: number, body: string) => `## [2026-08-18 10:00 +0700] Session s · Turn ${turn} — Loop 1 — qa (review)\n\n${body}\n\n`

test('verdict found in this turn entry', () => {
  const text = entry(4, '**READY FOR NEXT SESSION: YES**')
  assert.equal(parseVerdict(text, 4), 'YES')
})

test('mid-file entry is still found (qa inserted before a later entry)', () => {
  const text = entry(4, 'READY FOR NEXT SESSION: NO') + entry(6, 'READY FOR NEXT SESSION: YES')
  assert.equal(parseVerdict(text, 4), 'NO')
})

test('stale YES from a previous turn never counts when this turn wrote nothing', () => {
  const text = entry(3, 'READY FOR NEXT SESSION: YES')
  assert.equal(parseVerdict(text, 5), null)
})

test('entry present but no verdict line → null', () => {
  const text = entry(4, 'ran the gates, all green, forgot the verdict')
  assert.equal(parseVerdict(text, 4), null)
})

test('window ends at the next ## [ header — later YES ignored', () => {
  const text = entry(4, 'READY FOR NEXT SESSION: NO') + entry(5, 'READY FOR NEXT SESSION: YES')
  assert.equal(parseVerdict(text, 4), 'NO')
})

test('last verdict match in the window wins', () => {
  const text = entry(4, 'draft: READY FOR NEXT SESSION: YES\nfinal: READY FOR NEXT SESSION: NO')
  assert.equal(parseVerdict(text, 4), 'NO')
})

test('turn 1 does not match turn 10 header', () => {
  const text = entry(10, 'READY FOR NEXT SESSION: YES')
  assert.equal(parseVerdict(text, 1), null)
})

test('turnEntry returns header + body verbatim', () => {
  const text = entry(4, 'body line') + entry(5, 'other')
  const e = turnEntry(text, 4)
  assert.ok(e?.startsWith('## [') && e.includes('· Turn 4 —') && e.includes('body line'))
  assert.ok(!e.includes('other'))
})
