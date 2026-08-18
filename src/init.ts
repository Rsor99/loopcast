import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { configFile, saveEnvVar } from './config.ts'
import { seedProgress } from './progress.ts'
import { log } from './state.ts'
import { makeCtx } from './turn.ts'

// Interactive setup — TTY only (piped/CI stdin skips it, keeping init scriptable): pick the
// dev/qa agents + claude model into loopcast.config.json (merged over the existing config;
// auto-gitignored — per-dev settings),
// and optionally store CLAUDE_CODE_OAUTH_TOKEN in .loopcast.env so an expiring login doesn't
// take the loop down mid-run. Blank answers keep the shown default.
async function setup(root: string): Promise<void> {
  if (!process.stdin.isTTY) return
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const ask = async (q: string, def: string): Promise<string> => (await rl.question(`${q} [${def}]: `)).trim() || def
    const askAgent = async (q: string, def: string): Promise<string> => {
      for (;;) {
        const v = await ask(q, def)
        if (v === 'claude' || v === 'codex') return v
        console.log('  choose "claude" or "codex"')
      }
    }
    let cfg: Record<string, unknown> = {}
    try { cfg = JSON.parse(readFileSync(configFile(root), 'utf8')) as Record<string, unknown> } catch { /* fresh file */ }
    cfg.devAgent = await askAgent('dev agent (claude/codex)', String(cfg.devAgent ?? 'claude'))
    cfg.qaAgent = await askAgent('qa agent (claude/codex)', String(cfg.qaAgent ?? 'codex'))
    if (cfg.devAgent === 'claude' || cfg.qaAgent === 'claude') {
      cfg.claudeModel = await ask('claude model', String(cfg.claudeModel ?? 'claude-sonnet-5'))
      const token = (await rl.question('CLAUDE_CODE_OAUTH_TOKEN (blank = unchanged): ')).trim()
      if (token) {
        saveEnvVar(root, 'CLAUDE_CODE_OAUTH_TOKEN', token)
        ignoreAtRoot(root, '.loopcast.env') // a secret must never be committable
        log('token saved to .loopcast.env (gitignored, mode 600)')
      }
    }
    writeFileSync(join(root, 'loopcast.config.json'), JSON.stringify(cfg, null, 2) + '\n')
    ignoreAtRoot(root, 'loopcast.config.json') // per-dev settings — keep out of the repo
    log(`wrote loopcast.config.json (devAgent=${String(cfg.devAgent)}, qaAgent=${String(cfg.qaAgent)}; gitignored)`)
  } finally { rl.close() }
}

function ignoreAtRoot(root: string, entry: string): void {
  const gi = join(root, '.gitignore')
  const text = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
  if (!text.split('\n').includes(entry)) writeFileSync(gi, `${text && !text.endsWith('\n') ? `${text}\n` : text}${entry}\n`)
}

// Scaffold .loopcast/<track>/ — prompts from templates, Progress.md seed, PRD/ + loops/ +
// logs/ + .gitignore. Never overwrites an existing file; state.json is created lazily by
// step/auto once loops/Loop*.md files exist (and re-running never resets progress).
export async function init(track: string): Promise<number> {
  const ctx = makeCtx(track)
  await setup(ctx.root) // ctx.cfg predates setup's answers; init only uses cfg.loopsDir, which setup never changes
  const trackDirRel = `${ctx.cfg.loopsDir}/${track}`
  for (const d of ['logs', 'loops', 'PRD']) mkdirSync(join(ctx.dir, d), { recursive: true })
  const created: string[] = []
  const write = (name: string, content: string) => {
    const f = join(ctx.dir, name)
    if (existsSync(f)) {
      log(`kept existing ${trackDirRel}/${name}`)
      return
    }
    writeFileSync(f, content)
    created.push(name)
  }
  for (const role of ['dev', 'qa'] as const) {
    const template = readFileSync(new URL(`../templates/${role}-prompt.md`, import.meta.url), 'utf8')
    write(`${role}-prompt.md`, template.replaceAll('{{TRACK}}', track).replaceAll('{{TRACK_DIR}}', trackDirRel))
  }
  write('.gitignore', 'logs/\nstop\n')
  write('PRD/README.md', `# ${track} — PRD\n\nProduct/phase requirement docs for this track live here (human-written, markdown).\nDistill them into \`../loops/Loop<N>.md\` specs — the PRD itself is never executed.\n`)
  seedProgress(ctx.dir, track) // no-op if it already exists
  log(`scaffolded ${trackDirRel}/ (${created.length ? created.join(', ') : 'nothing new'})`)
  console.log(`
Next steps:
  1. Edit the "project gates" block in ${trackDirRel}/dev-prompt.md and qa-prompt.md —
     put your real build/lint/test commands there.
  2. (optional) Drop your PRD/phase docs into ${trackDirRel}/PRD/.
  3. Write ${trackDirRel}/loops/Loop1.md — a human-authored spec with a title heading
     ("# Loop 1 — <title>") and concrete acceptance criteria.
  4. Run one turn:  loopcast step ${track}
     or run continuously:  loopcast auto ${track}`)
  return 0
}
