import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReport, DANGEROUS_PATTERNS } from '../src/analyst.ts'
import { saveState, type State } from '../src/state.ts'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'loopcast-analyst-'))
  mkdirSync(join(dir, 'logs'), { recursive: true })
  return dir
}

const claudeLine = (name: string, input: unknown) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })

function baseState(overrides: Partial<State> = {}): State {
  return {
    track: 't', current_loop: 2, current_actor: 'dev', completed_loops: [1],
    remaining_loops: [2], status: 'idle', window_start: null, window_end: null,
    session_id: 's1', turn: 3, session_history: [], ...overrides,
  }
}

test('claude turn: counts tool_use calls and flags a dangerous command in the tool input', () => {
  const dir = fixture()
  const log = join(dir, 'logs', 't1.log')
  writeFileSync(log, [
    claudeLine('Read', { file: 'a.ts' }),
    claudeLine('Bash', { command: 'rm -rf node_modules/.cache' }),
    claudeLine('Bash', { command: 'ls' }),
  ].join('\n') + '\n')
  saveState(dir, baseState({
    completed_loops: [1], current_loop: null, turn: 1,
    session_history: [{ turn: 1, role: 'dev', actor: 'claude', loop: 1, started_at: 'a', ended_at: 'b', exit_code: 0, log_file: log }],
  }))
  const r = buildReport('t', dir)
  assert.deepEqual(r.turns[0].tools, { Read: 1, Bash: 2 })
  assert.equal(r.findings.length, 1)
  assert.equal(r.findings[0].pattern, 'rm -rf/-fr')
  assert.equal(r.avgTurnsPerCompletedLoop, 1)
})

test('codex turn: unstructured log gets one synthetic tool bucket, danger-scanned as raw text', () => {
  const dir = fixture()
  const log = join(dir, 'logs', 't2.log')
  writeFileSync(log, 'thinking...\n$ git push --force origin main\ndone\n')
  saveState(dir, baseState({
    session_history: [{ turn: 1, role: 'qa', actor: 'codex', loop: 1, started_at: 'a', ended_at: 'b', exit_code: 0, log_file: log }],
  }))
  const r = buildReport('t', dir)
  assert.equal(Object.keys(r.turns[0].tools)[0].startsWith('exec'), true)
  assert.ok(r.findings.some((f) => f.pattern === 'git push --force'))
})

test('no dangerous patterns match a clean turn', () => {
  const dir = fixture()
  const log = join(dir, 'logs', 't3.log')
  writeFileSync(log, claudeLine('Edit', { file: 'a.ts', content: 'export const x = 1\n' }) + '\n')
  saveState(dir, baseState({
    session_history: [{ turn: 1, role: 'dev', actor: 'claude', loop: 1, started_at: 'a', ended_at: 'b', exit_code: 0, log_file: log }],
  }))
  const r = buildReport('t', dir)
  assert.equal(r.findings.length, 0)
})

test('git push --force-with-lease is not flagged (mitigated, not raw force push)', () => {
  const label = 'git push --force'
  const re = DANGEROUS_PATTERNS.find((p) => p.label === label)!.re
  assert.equal(re.test('git push --force-with-lease origin main'), false)
  assert.equal(re.test('git push --force origin main'), true)
  assert.equal(re.test('git push -f origin main'), true)
})

test('avgTurnsPerCompletedLoop is null with no completed loops', () => {
  const dir = fixture()
  saveState(dir, baseState({ completed_loops: [], session_history: [] }))
  const r = buildReport('t', dir)
  assert.equal(r.avgTurnsPerCompletedLoop, null)
})
