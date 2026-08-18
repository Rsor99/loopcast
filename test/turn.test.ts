import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentCmd, kickoff, makeSpinner } from '../src/turn.ts'
import type { Config } from '../src/config.ts'

const cfg: Config = {
  loopsDir: 'loops',
  devAgent: 'claude',
  qaAgent: 'codex',
  claudeModel: 'claude-sonnet-5',
  claudeDevModel: null,
  claudeQaModel: 'claude-opus-5',
  maxBudgetUsd: null,
  turnMinutes: null,
  stallAfterRejects: 3,
  failBackoffSeconds: 600,
  failBackoffMaxSeconds: 4800,
  sandbox: false,
  commitAreas: null,
}

const base = { cfg, root: '/repo', promptText: 'PROMPT\n', track: 't', sessionId: 's1', turn: 3 } as const

test('claude command: exact reference flags, per-role model, kickoff prompt', () => {
  const cmd = buildAgentCmd({ ...base, agent: 'claude', role: 'dev' })
  assert.deepEqual(cmd, [
    'claude',
    '--model', 'claude-sonnet-5',
    '--dangerously-skip-permissions',
    '--system-prompt', 'PROMPT\n',
    '--disallowedTools', 'WebFetch,WebSearch',
    '--output-format', 'stream-json',
    '--verbose',
    '-p', 'Track: t. Session: s1. Turn: 3. Follow your system prompt exactly and begin your implementation turn now.',
  ])
  const qa = buildAgentCmd({ ...base, agent: 'claude', role: 'qa' })
  assert.equal(qa[2], 'claude-opus-5') // qa model override
  assert.ok(qa[qa.length - 1].includes('begin your review turn now'))
})

test('claude command: budget flag appended when configured', () => {
  const cmd = buildAgentCmd({ ...base, cfg: { ...cfg, maxBudgetUsd: 5 }, agent: 'claude', role: 'dev' })
  assert.deepEqual(cmd.slice(-2), ['--max-budget-usd', '5'])
})

test('claude command: sandbox wraps with sandbox-exec -f <profile> -D params', () => {
  const cmd = buildAgentCmd({ ...base, cfg: { ...cfg, sandbox: '/p.sb' }, agent: 'claude', role: 'dev', gitCommon: '/repo/.git' })
  assert.deepEqual(cmd.slice(0, 3), ['sandbox-exec', '-f', '/p.sb'])
  assert.ok(cmd.includes('REPO=/repo') && cmd.includes('GIT_COMMON=/repo/.git'))
  assert.equal(cmd[cmd.indexOf('claude') - 1].startsWith('HOME_'), true)
})

test('codex command: workspace-write sandbox, prompt + kickoff in one argument', () => {
  const cmd = buildAgentCmd({ ...base, agent: 'codex', role: 'qa' })
  assert.deepEqual(cmd.slice(0, 8), [
    'codex', 'exec',
    '--sandbox', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-C', '/repo',
  ])
  assert.equal(cmd[8], `PROMPT\n\n---\n${kickoff('t', 's1', 3, 'qa')}`)
})

// Captures process.stdout.write calls for the duration of fn, restoring the real write after.
function captureWrites(fn: () => void): string[] {
  const calls: string[] = []
  const real = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string) => { calls.push(chunk); return true }) as typeof process.stdout.write
  try { fn() } finally { process.stdout.write = real }
  return calls
}

test('spinner: first draw has nothing to erase; a name change erases the previous line first', () => {
  const spinner = makeSpinner()
  const calls = captureWrites(() => {
    spinner.onTool('Bash') // nothing drawn yet — no erase, one line written
    spinner.onTool('Read') // a line IS drawn — erase (cursor up + clear) precedes the redraw
  })
  assert.equal(calls.length, 3) // [draw Bash] [erase] [draw Read]
  assert.ok(calls[0].includes('Bash') && !calls[0].startsWith('\x1b[1A'))
  assert.equal(calls[1], '\x1b[1A\x1b[2K')
  assert.ok(calls[2].includes('Read'))
})

test('spinner: onText erases a drawn line but writes nothing if none is drawn', () => {
  const spinner = makeSpinner()
  const beforeAnyTool = captureWrites(() => spinner.onText())
  assert.deepEqual(beforeAnyTool, [])
  captureWrites(() => spinner.onTool('Bash'))
  const afterTool = captureWrites(() => spinner.onText())
  assert.deepEqual(afterTool, ['\x1b[1A\x1b[2K'])
})

test('spinner: stop() clears the interval and erases the last drawn line', () => {
  const spinner = makeSpinner()
  captureWrites(() => spinner.onTool('Bash'))
  const calls = captureWrites(() => spinner.stop())
  assert.deepEqual(calls, ['\x1b[1A\x1b[2K'])
})
