import { readFileSync } from 'node:fs'
import { readState, type HistoryEntry } from './state.ts'
import { makeCtx, assistantBlocks } from './turn.ts'
import { cyan, dim, green, red } from './color.ts'

// Shell/text patterns worth flagging wherever they appear in a tool call's input (claude) or
// the raw log text (codex, best-effort — see parseCodexTurn). Data, not code: extend this list
// rather than adding branches.
export const DANGEROUS_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'rm -rf/-fr', re: /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\b/i },
  { label: 'sudo', re: /\bsudo\b/ },
  { label: 'curl|wget piped to shell', re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i },
  { label: 'git push --force', re: /\bgit\s+push\b(?![^\n]*--force-with-lease)[^\n]*(--force\b|\s-f\b)/ },
  { label: 'git reset --hard', re: /\bgit\s+reset\s+--hard\b/ },
  { label: 'git clean -f', re: /\bgit\s+clean\s+[^\n]*-\w*f/ },
  { label: 'chmod 777', re: /\bchmod\s+(-R\s+)?0?777\b/ },
  { label: 'dd to a device', re: /\bdd\s+[^\n]*of=\/dev\// },
  { label: 'mkfs', re: /\bmkfs\b/ },
  { label: 'fork bomb', re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/ },
  { label: 'kill -9 1 / pkill -9', re: /\b(kill\s+-9\s+1\b|pkill\s+-9\b)/ },
  { label: 'skip git hooks (--no-verify)', re: /--no-verify\b/ },
  { label: 'read ssh/cloud/.env secrets', re: /\b(cat|less|cp)\s+[^\n]*(\.ssh\/(id_rsa|id_ed25519)|\.aws\/credentials|\.env\b)/ },
  { label: 'drop/truncate table', re: /\b(DROP\s+TABLE|TRUNCATE\s+TABLE)\b/i },
  { label: 'npm publish', re: /\bnpm\s+publish\b/ },
]

export interface DangerFinding { turn: number; role: string; actor: string; tool: string; pattern: string; snippet: string }
export interface TurnReport { turn: number; role: string; actor: string; loop: number; tools: Record<string, number> }

const truncate = (s: string, n = 140): string => (s.length > n ? s.slice(0, n) + '…' : s)

// claude turns: exact tool_use calls from the stream-json log, one call at a time. Every
// call's input is danger-scanned (not just Bash) — a dangerous shell one-liner can just as
// well arrive inside a Write/Edit file body.
function parseClaudeTurn(h: HistoryEntry, text: string): { tools: Record<string, number>; findings: DangerFinding[] } {
  const tools: Record<string, number> = {}
  const findings: DangerFinding[] = []
  const seen = new Set<string>() // one finding per (pattern) per turn — avoid flooding on a chatty loop
  for (const line of text.split('\n')) {
    for (const block of assistantBlocks(line)) {
      if (block.type !== 'tool_use') continue
      const name = block.name ?? '?'
      tools[name] = (tools[name] ?? 0) + 1
      const inputText = JSON.stringify(block.input ?? {})
      for (const pat of DANGEROUS_PATTERNS) {
        if (seen.has(pat.label) || !pat.re.test(inputText)) continue
        seen.add(pat.label)
        findings.push({ turn: h.turn, role: h.role, actor: h.actor, tool: name, pattern: pat.label, snippet: truncate(inputText) })
      }
    }
  }
  return { tools, findings }
}

// codex (and any non-claude actor) writes plain progress text, not structured events —
// `codex exec` only emits JSONL with --json, which loopcast doesn't pass (see turn.ts). So
// this is best-effort: bucket every such turn under one synthetic "exec" tool, and danger-scan
// the raw log text directly (may pick up prose alongside real commands — approximate on purpose).
function parseCodexTurn(h: HistoryEntry, text: string): { tools: Record<string, number>; findings: DangerFinding[] } {
  const bucket = 'exec (approximate — unstructured codex log)'
  const findings: DangerFinding[] = []
  for (const pat of DANGEROUS_PATTERNS) {
    const m = pat.re.exec(text)
    if (!m) continue
    const start = Math.max(0, m.index - 40)
    findings.push({ turn: h.turn, role: h.role, actor: h.actor, tool: bucket, pattern: pat.label, snippet: truncate(text.slice(start, m.index + m[0].length + 40).trim()) })
  }
  return { tools: { [bucket]: 1 }, findings }
}

export interface AnalystReport {
  track: string
  turnsTotal: number
  loopsCompleted: number
  loopsTouched: number
  avgTurnsPerCompletedLoop: number | null
  currentLoop: number | null
  currentLoopTurnsSoFar: number | null
  byRole: Record<string, number>
  byActor: Record<string, number>
  toolUsageTotal: Record<string, number>
  dangerousPatterns: string[]
  turns: TurnReport[]
  findings: DangerFinding[]
}

export function buildReport(track: string, dir: string): AnalystReport {
  const s = readState(dir)
  const byRole: Record<string, number> = {}
  const byActor: Record<string, number> = {}
  const toolUsageTotal: Record<string, number> = {}
  const turns: TurnReport[] = []
  const findings: DangerFinding[] = []
  const perLoop = new Map<number, number>()

  for (const h of s.session_history) {
    byRole[h.role] = (byRole[h.role] ?? 0) + 1
    byActor[h.actor] = (byActor[h.actor] ?? 0) + 1
    perLoop.set(h.loop, (perLoop.get(h.loop) ?? 0) + 1)
    let text: string
    try { text = readFileSync(h.log_file, 'utf8') } catch { turns.push({ turn: h.turn, role: h.role, actor: h.actor, loop: h.loop, tools: {} }); continue }
    const { tools, findings: turnFindings } = h.actor === 'claude' ? parseClaudeTurn(h, text) : parseCodexTurn(h, text)
    turns.push({ turn: h.turn, role: h.role, actor: h.actor, loop: h.loop, tools })
    findings.push(...turnFindings)
    for (const [name, n] of Object.entries(tools)) toolUsageTotal[name] = (toolUsageTotal[name] ?? 0) + n
  }

  const completedCounts = s.completed_loops.map((l) => perLoop.get(l) ?? 0)
  const avgTurnsPerCompletedLoop = completedCounts.length ? completedCounts.reduce((a, b) => a + b, 0) / completedCounts.length : null

  return {
    track, turnsTotal: s.session_history.length, loopsCompleted: s.completed_loops.length, loopsTouched: perLoop.size,
    avgTurnsPerCompletedLoop, currentLoop: s.current_loop, currentLoopTurnsSoFar: s.current_loop !== null ? (perLoop.get(s.current_loop) ?? 0) : null,
    byRole, byActor, toolUsageTotal, dangerousPatterns: DANGEROUS_PATTERNS.map((p) => p.label), turns, findings,
  }
}

const fmtCounts = (o: Record<string, number>): string => Object.entries(o).map(([k, v]) => `${k} ${v}`).join('   ') || '—'
const fmtTools = (o: Record<string, number>): string => Object.entries(o).map(([k, v]) => `${k} x${v}`).join(', ') || '—'

function printReport(r: AnalystReport): void {
  console.log(`track:               ${cyan(r.track)}`)
  console.log(`turns total:         ${r.turnsTotal}`)
  console.log(`loops completed:     ${r.loopsCompleted}   touched: ${r.loopsTouched}`)
  console.log(`avg turns/loop:      ${r.avgTurnsPerCompletedLoop === null ? 'n/a (no completed loops yet)' : r.avgTurnsPerCompletedLoop.toFixed(1)}`)
  if (r.currentLoop !== null) console.log(`current loop:        ${r.currentLoop} — ${r.currentLoopTurnsSoFar} turn(s) so far, in progress`)
  console.log()
  console.log(`turns by role:       ${fmtCounts(r.byRole)}`)
  console.log(`turns by actor:      ${fmtCounts(r.byActor)}`)
  console.log()
  console.log('per-turn tool usage:')
  for (const t of r.turns) console.log(`  turn ${String(t.turn).padStart(4, ' ')}  ${t.role.padEnd(3, ' ')} (${t.actor})  loop ${t.loop}  ${fmtTools(t.tools)}`)
  console.log()
  console.log('tool usage (all turns):')
  for (const [name, n] of Object.entries(r.toolUsageTotal)) console.log(`  ${name}  ${n}`)
  console.log()
  if (r.findings.length === 0) {
    console.log(`dangerous findings:  ${green('none')}`)
  } else {
    console.log(red(`⚠ dangerous findings: ${r.findings.length}`))
    for (const f of r.findings) console.log(`  turn ${f.turn}  ${f.role} (${f.actor})  ${f.tool}  ${red(`[${f.pattern}]`)}  ${f.snippet}`)
  }
  console.log()
  console.log(dim(`dangerous patterns checked (n=${r.dangerousPatterns.length}): ${r.dangerousPatterns.join(', ')}`))
}

export async function analyst(track: string, json: boolean): Promise<number> {
  const ctx = makeCtx(track)
  let report: AnalystReport
  try { report = buildReport(track, ctx.dir) }
  catch {
    console.error(`no state yet for track '${track}' — nothing has run. Start with: loopcast init ${track}`)
    return 1
  }
  if (json) console.log(JSON.stringify(report, null, 2))
  else printReport(report)
  return 0
}
