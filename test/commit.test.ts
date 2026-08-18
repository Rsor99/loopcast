import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitLoop, loopTitle } from '../src/commit.ts'

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'loopcast-git-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', d, ...args], { stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@test')
  git('config', 'user.name', 'test')
  writeFileSync(join(d, '.keep'), '')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return d
}

function messages(d: string): string[] {
  return execFileSync('git', ['-C', d, 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n')
}

test('loopTitle: first heading match, fallback without file', () => {
  const d = mkdtempSync(join(tmpdir(), 'loopcast-'))
  mkdirSync(join(d, 'loops'), { recursive: true })
  writeFileSync(join(d, 'loops', 'Loop2.md'), '# Loop 2 — do the thing\n\nStatus: planned\n')
  assert.equal(loopTitle(d, 2), 'do the thing')
  assert.equal(loopTitle(d, 9), 'loop 9')
})

test('default: one add -A commit `loop(<N>): <title>`', () => {
  const d = repo()
  const track = join(d, 'loops/main')
  mkdirSync(join(track, 'loops'), { recursive: true })
  writeFileSync(join(track, 'loops', 'Loop1.md'), '# Loop 1 — hello\n')
  writeFileSync(join(d, 'a.txt'), 'x')
  assert.equal(commitLoop(d, track, 1, null), true)
  assert.equal(messages(d)[0], 'loop(1): hello')
})

test('commitAreas: fixed order, skip-empty areas, catch-all sweeps the rest', () => {
  const d = repo()
  const track = join(d, 'loops/main')
  mkdirSync(join(track, 'loops'), { recursive: true })
  writeFileSync(join(track, 'loops', 'Loop1.md'), '# Loop 1 — split\n')
  mkdirSync(join(d, 'app/tests'), { recursive: true })
  writeFileSync(join(d, 'app/main.ts'), 'x')
  writeFileSync(join(d, 'app/tests/main.test.ts'), 'x')
  writeFileSync(join(d, 'root.txt'), 'x')
  const ok = commitLoop(d, track, 1, [
    { name: 'App', path: 'app', exclude: 'app/tests' },
    { name: 'App Tests', path: 'app/tests' },
    { name: 'Empty', path: 'nothing/here' },
    { name: 'Chore', path: '-A' },
  ])
  assert.equal(ok, true)
  // newest first — commit order was App, App Tests, Chore; Empty skipped
  assert.deepEqual(messages(d).slice(0, 3), ['loop(1)[Chore]: split', 'loop(1)[App Tests]: split', 'loop(1)[App]: split'])
  const appFiles = execFileSync('git', ['-C', d, 'show', '--stat', '--format=', 'HEAD~2'], { encoding: 'utf8' })
  assert.ok(appFiles.includes('app/main.ts') && !appFiles.includes('app/tests'))
})

test('hook rejection: unstage, stop, report false; work stays in tree', () => {
  const d = repo()
  const track = join(d, 'loops/main')
  mkdirSync(join(track, 'loops'), { recursive: true })
  writeFileSync(join(track, 'loops', 'Loop1.md'), '# Loop 1 — hooked\n')
  mkdirSync(join(d, '.git/hooks'), { recursive: true })
  writeFileSync(join(d, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n')
  execFileSync('chmod', ['+x', join(d, '.git/hooks/pre-commit')])
  writeFileSync(join(d, 'a.txt'), 'x')
  assert.equal(commitLoop(d, track, 1, null), false)
  const staged = execFileSync('git', ['-C', d, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim()
  assert.equal(staged, '') // unstaged
  const status = execFileSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' })
  assert.ok(status.includes('a.txt')) // work still in the tree
})
