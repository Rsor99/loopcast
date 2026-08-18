import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envFile, envKey, loadConfig, loadEnvFile, saveEnvVar } from '../src/config.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'loopcast-cfg-'))

test('defaults when no file and no env', () => {
  const cfg = loadConfig(dir(), {})
  assert.equal(cfg.devAgent, 'claude')
  assert.equal(cfg.qaAgent, 'codex')
  assert.equal(cfg.turnMinutes, null)
  assert.equal(cfg.stallAfterRejects, 3)
})

test('env beats file beats default; mechanical env names', () => {
  const d = dir()
  writeFileSync(join(d, 'loopcast.config.json'), '{"turnMinutes": 50, "loopsDir": "tracks"}')
  assert.equal(envKey('turnMinutes'), 'LOOPCAST_TURN_MINUTES')
  const cfg = loadConfig(d, { LOOPCAST_TURN_MINUTES: '30' })
  assert.equal(cfg.turnMinutes, 30)
  assert.equal(cfg.loopsDir, 'tracks')
})

test('non-numeric numeric config rejected loudly, env and file alike', () => {
  assert.throws(() => loadConfig(dir(), { LOOPCAST_TURN_MINUTES: '30m' }), /turnMinutes must be a number/)
  const d = dir()
  writeFileSync(join(d, 'loopcast.config.json'), '{"stallAfterRejects": "three"}')
  assert.throws(() => loadConfig(d, {}), /stallAfterRejects must be a number/)
})

test('sandbox env: false/0 → off, anything else is a profile path', () => {
  assert.equal(loadConfig(dir(), { LOOPCAST_SANDBOX: 'false' }).sandbox, false)
  assert.equal(loadConfig(dir(), { LOOPCAST_SANDBOX: '/p.sb' }).sandbox, '/p.sb')
})

test('config read from loopcast.config.json only; legacy loopcast.json ignored', () => {
  const d = dir()
  writeFileSync(join(d, 'loopcast.json'), '{"loopsDir": "old"}')
  assert.equal(loadConfig(d, {}).loopsDir, '.loopcast') // legacy name is not read
})

test('bad agent name rejected', () => {
  assert.throws(() => loadConfig(dir(), { LOOPCAST_DEV_AGENT: 'gemini' }), /must be "claude" or "codex"/)
})

test('env file: save + load roundtrip, update in place, missing file = {}', () => {
  const root = dir()
  assert.deepEqual(loadEnvFile(root), {})
  saveEnvVar(root, 'CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-abc')
  saveEnvVar(root, 'OTHER', 'x=y') // value may contain '='
  saveEnvVar(root, 'CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-new')
  assert.deepEqual(loadEnvFile(root), { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-new', OTHER: 'x=y' })
  assert.equal(statSync(envFile(root)).mode & 0o777, 0o600)
  assert.ok(readFileSync(envFile(root), 'utf8').endsWith('\n'))
})
