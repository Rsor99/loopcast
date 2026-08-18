#!/usr/bin/env node
// loopcast — dev ⇄ qa agent loop orchestrator. See SPEC.md.
import { readFileSync } from 'node:fs'

const USAGE = `loopcast — dev ⇄ qa agent loop orchestrator

Usage: loopcast <command> [track] [flags]

Commands:
  init [track]     scaffold .loopcast/<track>/ (setup questions + prompts from templates)
  step [track]     run exactly one due turn (dev or qa) in the foreground
  auto [track]     run turns continuously until loops run out / stop / Ctrl+C
  status [track]   print state + next-turn summary (--json for raw state)
  stop [track]     ask a running \`auto\` to exit after its current turn
  analyst [track]  turns/loop, per-turn tool usage, dangerous-command scan (--json for raw report)

Track defaults to "main". Flags: --json (status, analyst), -h/--help, --version.`

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  return pkg.version
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.includes('-h') || args.includes('--help') || args.length === 0) {
    console.log(USAGE)
    return 0
  }
  if (args.includes('--version')) {
    console.log(version())
    return 0
  }
  const [cmd, ...rest] = args
  const flags = rest.filter((a) => a.startsWith('-'))
  const track = rest.find((a) => !a.startsWith('-')) ?? 'main'

  switch (cmd) {
    case 'init':
      return (await import('./init.ts')).init(track)
    case 'step':
      return (await import('./turn.ts')).step(track)
    case 'auto':
      return (await import('./turn.ts')).auto(track)
    case 'status':
      return (await import('./turn.ts')).status(track, flags.includes('--json'))
    case 'stop':
      return (await import('./turn.ts')).stop(track)
    case 'analyst':
      return (await import('./analyst.ts')).analyst(track, flags.includes('--json'))
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`)
      return 1
  }
}

// exitCode, not process.exit(): exit() tears down before piped stdout drains, truncating
// large `status --json` output mid-stream.
main().then(
  (code) => { process.exitCode = code },
  (err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1 },
)
