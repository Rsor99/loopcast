import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forcePassEntry, guidanceEntry } from '../src/gate.ts'
import { backoffSeconds } from '../src/turn.ts'

test('backoff math: doubles per consecutive failure, capped, stays at cap', () => {
  assert.equal(backoffSeconds(1, 600, 4800), 600)
  assert.equal(backoffSeconds(2, 600, 4800), 1200)
  assert.equal(backoffSeconds(3, 600, 4800), 2400)
  assert.equal(backoffSeconds(4, 600, 4800), 4800)
  assert.equal(backoffSeconds(9, 600, 4800), 4800)
})

test('guidance entry: Human decision header + requirement-owner wording', () => {
  const e = guidanceEntry(12, 'ship it with the simpler index')
  assert.ok(/^\n## \[\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{4}\] · Human decision — Loop 12 guidance while stuck\n/.test(e))
  assert.ok(e.includes('> ship it with the simpler index'))
  assert.ok(e.includes('may amend requirement text in Loop12.md'))
  assert.ok(e.includes('(Entry written by the orchestrator.)'))
})

test('force-pass entry: FORCE-PASSED header, default note', () => {
  const e = forcePassEntry(7, '')
  assert.ok(e.includes('· Human decision — Loop 7 FORCE-PASSED past QA'))
  assert.ok(e.includes('> (no note given)'))
  assert.ok(e.includes('Loop advanced without a qa YES.'))
  assert.ok(forcePassEntry(7, 'good enough').includes('> good enough'))
})
