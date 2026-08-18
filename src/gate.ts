import { createInterface } from 'node:readline/promises'
import { appendEntry } from './progress.ts'
import { log, tsHuman } from './state.ts'

export type GateDecision = 'continue' | 'force' | 'stop'

// The wording deliberately tells dev the guidance may amend the Loop spec's requirement
// text — it IS the requirement-owner decision loops otherwise wait on.
export function guidanceEntry(loop: number, guidance: string): string {
  return (
    `\n## [${tsHuman()}] · Human decision — Loop ${loop} guidance while stuck\n\n` +
    `Instruction from the human reviewer:\n\n> ${guidance}\n\n` +
    `Dev: apply this before the next qa verdict. This instruction may amend requirement text in Loop${loop}.md — it IS the requirement-owner decision loops otherwise wait on. (Entry written by the orchestrator.)\n`
  )
}

export function forcePassEntry(loop: number, note: string): string {
  return (
    `\n## [${tsHuman()}] · Human decision — Loop ${loop} FORCE-PASSED past QA\n\n` +
    `Note from the human reviewer:\n\n> ${note || '(no note given)'}\n\n` +
    `Loop advanced without a qa YES. (Entry written by the orchestrator.)\n`
  )
}

// Pause the loop and ask on the terminal — no timeout, auto simply waits.
// Non-TTY stdin (piped/CI): an unattended gate that can't be answered must fail safe,
// not spin — behave as "n" with a loud message.
export async function stallGate(dir: string, loop: number, streak: number, lastEntry: string | null): Promise<GateDecision> {
  if (!process.stdin.isTTY) {
    log(`loop ${loop} stuck — QA said NO ${streak}× in a row, and stdin is not a TTY so nobody can answer the gate. Stopping; resume interactively with: loopcast auto`)
    return 'stop'
  }
  const line = '─'.repeat(40)
  console.log(`\n⏸  loop ${loop} stuck — QA said NO ${streak}× in a row.`)
  console.log('   Last QA entry:')
  console.log(`   ${line}`)
  console.log(lastEntry ?? '(no entry found for the last qa turn)')
  console.log(`   ${line}`)
  console.log('   [y] continue — another dev pass (add guidance below)')
  console.log('   [f] force-pass — advance past QA and commit as-is')
  console.log('   [n] stop — save state and exit')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const abort = new AbortController()
  rl.on('SIGINT', () => abort.abort()) // Ctrl+C at the gate = stop
  try {
    let choice = ''
    while (choice !== 'y' && choice !== 'f' && choice !== 'n') {
      choice = (await rl.question('   choice [y/f/n]: ', { signal: abort.signal })).trim().toLowerCase()
    }
    if (choice === 'n') return 'stop'
    const guidance = (await rl.question('   guidance for dev (empty = none): ', { signal: abort.signal })).trim()
    if (choice === 'f') {
      appendEntry(dir, forcePassEntry(loop, guidance))
      return 'force'
    }
    if (guidance) appendEntry(dir, guidanceEntry(loop, guidance))
    return 'continue'
  } catch {
    return 'stop' // aborted (Ctrl+C)
  } finally {
    rl.close()
  }
}
