import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadConfig, loadEnvFile, type AgentName, type Config } from './config.ts'
import { commitLoop } from './commit.ts'
import { stallGate } from './gate.ts'
import {
  advanceLoop, discoverLoops, initState, isoLocal, log, normalizeRole, readState, saveState,
  syncLoops, tsCompact, tsDay, tsSessionDay, updateLoopStatusDoc, type Role, type State,
} from './state.ts'
import { appendedSince, parseVerdict, readProgress, seedProgress, snapshot, turnEntry } from './progress.ts'

interface Ctx { root: string; cfg: Config; track: string; dir: string; logDir: string }

// ── setup / preflight ──────────────────────────────────────────────────────────────────────

const isWin = process.platform === 'win32'

const sh = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

function repoRoot(): string {
  try { return sh('git', ['rev-parse', '--show-toplevel']) }
  catch { throw new Error('not a git repository — run loopcast from inside your project repo (or git init first)') }
}

function gitCommonDir(root: string): string {
  try { return sh('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir']) }
  catch { return join(root, '.git') }
}

function binExists(bin: string): boolean {
  try { sh(isWin ? 'where' : 'which', [bin]); return true } catch { return false }
}

// The whole agent subprocess tree must die, not just the CLI wrapper. POSIX: signal the
// detached process group via NEGATIVE pid. Windows has no process groups — taskkill /T
// walks the tree instead (/F only on the hard kill; without it, a graceful close request).
function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return
  try {
    if (isWin) execFileSync('taskkill', ['/pid', String(pid), '/T', ...(sig === 'SIGKILL' ? ['/F'] : [])], { stdio: 'ignore' })
    else process.kill(-pid, sig)
  } catch { /* already gone */ }
}

export function makeCtx(track: string): Ctx {
  const root = repoRoot()
  const cfg = loadConfig(root)
  const dir = join(root, cfg.loopsDir, track)
  return { root, cfg, track, dir, logDir: join(dir, 'logs') }
}

const promptFile = (ctx: Ctx, role: Role): string => join(ctx.dir, `${role}-prompt.md`)

// Returns the ready-to-run state, or throws with a message that says what to do next.
function preflight(ctx: Ctx): State {
  for (const role of ['dev', 'qa'] as const) {
    const f = promptFile(ctx, role)
    if (!existsSync(f)) throw new Error(`missing ${role} prompt for track '${ctx.track}' — expected ${f}; run: loopcast init ${ctx.track}`)
  }
  if (!process.env.LOOPCAST_AGENT_CMD) {
    for (const agent of new Set([ctx.cfg.devAgent, ctx.cfg.qaAgent])) {
      if (!binExists(agent)) throw new Error(`agent binary not found: ${agent} — install it, or change devAgent/qaAgent in loopcast.config.json`)
    }
  }
  const s = initState(ctx.dir, ctx.track)
  if (!s) throw new Error(`no Loop*.md files under ${ctx.dir} — write ${join(ctx.dir, 'loops', 'Loop1.md')} (a human-authored spec) first`)
  seedProgress(ctx.dir, ctx.track)
  syncLoops(s, discoverLoops(ctx.dir))
  saveState(ctx.dir, s)
  return s
}

// ── agent command build (exact reference flags) ────────────────────────────────────────────

export const rolePhrase = (role: Role): string => (role === 'dev' ? 'implementation' : 'review')

export const kickoff = (track: string, sessionId: string, turn: number, role: Role): string =>
  `Track: ${track}. Session: ${sessionId}. Turn: ${turn}. Follow your system prompt exactly and begin your ${rolePhrase(role)} turn now.`

export function sandboxPrefix(profile: string, root: string, gitCommon: string): string[] {
  const home = homedir()
  const params: Record<string, string> = { REPO: root, GIT_COMMON: gitCommon, TMPDIR: process.env.TMPDIR ?? '/tmp' }
  for (const d of ['ssh', 'aws', 'gnupg', 'dotnet', 'nuget', 'bun', 'npm', 'claude', 'docker', 'codex']) {
    params[`HOME_${d.toUpperCase()}`] = join(home, `.${d}`)
  }
  params.HOME_GH = join(home, '.config/gh')
  params.HOME_CACHES = join(home, 'Library/Caches')
  return ['sandbox-exec', '-f', profile, ...Object.entries(params).flatMap(([k, v]) => ['-D', `${k}=${v}`])]
}

export interface BuildOpts {
  agent: AgentName; cfg: Config; root: string; promptText: string
  track: string; sessionId: string; turn: number; role: Role; gitCommon?: string
}

export function buildAgentCmd(o: BuildOpts): string[] {
  const kick = kickoff(o.track, o.sessionId, o.turn, o.role)
  if (o.agent === 'claude') {
    const model = (o.role === 'qa' ? o.cfg.claudeQaModel : o.cfg.claudeDevModel) ?? o.cfg.claudeModel
    const cmd: string[] = []
    if (o.cfg.sandbox) cmd.push(...sandboxPrefix(o.cfg.sandbox, o.root, o.gitCommon ?? gitCommonDir(o.root)))
    // stream-json over text on purpose: text buffers the whole response and leaves an empty
    // log if the turn is killed before finishing; stream-json leaves a readable trail.
    cmd.push('claude', '--model', model, '--dangerously-skip-permissions', '--system-prompt', o.promptText,
      '--disallowedTools', 'WebFetch,WebSearch', '--output-format', 'stream-json', '--verbose', '-p', kick)
    if (o.cfg.maxBudgetUsd !== null) cmd.push('--max-budget-usd', String(o.cfg.maxBudgetUsd))
    return cmd
  }
  return ['codex', 'exec', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true',
    '-C', o.root, `${o.promptText.trimEnd()}\n\n---\n${kick}`]
}

// ── spawn / tee / live view / watchdog ─────────────────────────────────────────────────────

let currentChild: ChildProcess | null = null
let shuttingDown = false // set by the signal handler; closes the window where the auto
// loop's continuation could spawn the next turn's detached agent after Ctrl+C

// The jq live filter, in-process: assistant text blocks + [tool: <name>] markers.
// Unparseable lines are skipped silently — the watchdog appends plain text to the same log.
function printStreamJsonLine(line: string): void {
  if (!line.trim()) return
  try {
    const obj = JSON.parse(line) as { type?: string; message?: { content?: { type?: string; text?: string; name?: string }[] } }
    if (obj.type !== 'assistant') return
    for (const block of obj.message?.content ?? []) {
      if (block.type === 'text' && block.text) console.log(block.text)
      else if (block.type === 'tool_use') console.log(`[tool: ${block.name ?? '?'}]`)
    }
  } catch { /* skipped */ }
}

function runAgent(
  argv: string[],
  o: { cwd: string; logFile: string; env: NodeJS.ProcessEnv; liveParse: boolean; budgetSeconds: number | null },
): Promise<number> {
  return new Promise((resolve) => {
    if (shuttingDown) return resolve(143)
    const logStream = createWriteStream(o.logFile, { flags: 'a' })
    // stdin 'ignore' = /dev/null — non-negotiable: each CLI tries to read supplemental stdin
    // even with the prompt passed as an argument; claude falls back after a warning, codex
    // has no fallback and hangs forever (a confirmed production incident).
    // detached (POSIX only) = own process group, so killGroup reaches the whole tree;
    // on Windows taskkill /T does that walk itself and detaching would only orphan the child.
    const child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, detached: !isWin, stdio: ['ignore', 'pipe', 'pipe'], env: o.env })
    currentChild = child
    child.stdout?.on('data', (chunk: Buffer) => {
      logStream.write(chunk)
      if (!o.liveParse) process.stdout.write(chunk)
    })
    // readline, not a hand-rolled splitter: it flushes the trailing partial line of a
    // killed turn and decodes multi-byte UTF-8 across chunk boundaries correctly.
    if (o.liveParse && child.stdout) createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', printStreamJsonLine)
    child.stderr?.on('data', (chunk: Buffer) => { logStream.write(chunk); process.stderr.write(chunk) })
    let timer: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    if (o.budgetSeconds !== null) {
      const secs = o.budgetSeconds
      timer = setTimeout(() => {
        logStream.write(`[watchdog] turn exceeded ${secs}s budget — sending SIGTERM to process group -${child.pid}\n`)
        killGroup(child.pid, 'SIGTERM')
        killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 15_000) // 15 s grace
      }, secs * 1000)
    }
    child.on('error', (err) => logStream.write(`spawn error: ${err.message}\n`))
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      logStream.end()
      currentChild = null
      // null exit code = killed → 143, matching the reference watchdog. (Windows reports
      // taskkill's own non-zero code instead — the ≠0 fail-path check still holds.)
      resolve(code ?? 143)
    })
  })
}

// ── one turn (port of execute_turn) ────────────────────────────────────────────────────────

export type TurnResult =
  | { kind: 'agent-failure'; exitCode: number }
  | { kind: 'dev-done'; loop: number }
  | { kind: 'advanced'; loop: number; committed: boolean }
  | { kind: 'rejected'; loop: number; explicitNo: boolean; entry: string | null }

async function runTurn(ctx: Ctx, sessionId: string, budgetSeconds: number | null): Promise<TurnResult> {
  const s = readState(ctx.dir)
  const loop = s.current_loop
  if (loop === null) throw new Error('runTurn called with no current loop')
  const role = normalizeRole(s.current_actor)
  const agent = role === 'dev' ? ctx.cfg.devAgent : ctx.cfg.qaAgent
  const turn = s.turn + 1
  const turnLog = join(ctx.logDir, `turn-${String(turn).padStart(4, '0')}-${role}-${agent}-${tsCompact()}.log`)
  mkdirSync(ctx.logDir, { recursive: true })
  log(`turn ${turn} — loop ${loop} — ${role} (${agent})${budgetSeconds ? ` — budget ${budgetSeconds}s` : ''} — log: ${turnLog}`)
  const before = snapshot(ctx.dir)
  const startIso = isoLocal()

  const promptText = readFileSync(promptFile(ctx, role), 'utf8')
  const override = process.env.LOOPCAST_AGENT_CMD // test seam: run a stub script instead of a real agent CLI
  const argv = override
    ? (isWin ? [process.env.comspec ?? 'cmd', '/c', override] : ['/bin/sh', '-c', override])
    : buildAgentCmd({ agent, cfg: ctx.cfg, root: ctx.root, promptText, track: ctx.track, sessionId, turn, role })
  // .loopcast.env overrides process.env — a token saved by `loopcast init` must beat a stale exported one
  const env = { ...process.env, ...loadEnvFile(ctx.root), LOOP_TRACK: ctx.track, LOOPCAST_ROLE: role, LOOPCAST_TURN: String(turn), LOOPCAST_SESSION: sessionId }
  const exitCode = await runAgent(argv, { cwd: ctx.root, logFile: turnLog, env, liveParse: agent === 'claude' && !override, budgetSeconds })
  log(`turn ${turn} finished — exit ${exitCode}`)

  s.session_history.push({ turn, role, actor: agent, loop, started_at: startIso, ended_at: isoLocal(), exit_code: exitCode, log_file: turnLog })
  s.turn = turn

  if (exitCode !== 0 && appendedSince(ctx.dir, before).trim() === '') {
    // Died without reporting anything — an agent/API failure, not an engineering outcome.
    // Don't flip the role, don't touch the loop; the caller backs off (auto) or exits (step).
    saveState(ctx.dir, s)
    return { kind: 'agent-failure', exitCode }
  }

  if (role === 'qa') {
    const verdict = parseVerdict(readProgress(ctx.dir), turn)
    if (verdict === 'YES') {
      log(`qa marked loop ${loop} ready — advancing to the next loop`)
      return { kind: 'advanced', loop, committed: passLoop(ctx, s, loop) }
    }
    log(`qa marked loop ${loop} not ready (or gave no verdict) — another dev pass on the same loop`)
    s.current_actor = 'dev'
    saveState(ctx.dir, s)
    return { kind: 'rejected', loop, explicitNo: verdict === 'NO', entry: turnEntry(readProgress(ctx.dir), turn) }
  }
  updateLoopStatusDoc(ctx.dir, loop, 'in progress')
  s.current_actor = 'qa'
  saveState(ctx.dir, s)
  return { kind: 'dev-done', loop }
}

// The loop-passed transition — shared by the qa-YES path and the gate's force-pass.
// A rejected commit does not un-advance the loop (matching the reference), but it must be
// loud: the work stays in the tree and would otherwise sweep into the NEXT loop's commit.
function passLoop(ctx: Ctx, s: State, loop: number): boolean {
  updateLoopStatusDoc(ctx.dir, loop, 'done')
  advanceLoop(s)
  saveState(ctx.dir, s)
  const committed = commitLoop(ctx.root, ctx.dir, loop, ctx.cfg.commitAreas)
  if (!committed) log(`WARNING: loop ${loop} advanced but its commit did not complete — resolve the uncommitted changes before the next loop passes, or they'll land in the wrong commit`)
  return committed
}

// ── interrupt handling ─────────────────────────────────────────────────────────────────────

function setStatus(dir: string, status: State['status']): void {
  const s = readState(dir)
  s.status = status
  saveState(dir, s)
}

function installInterrupt(ctx: Ctx, resumeCmd: string): () => void {
  let firing = false
  const handler = () => {
    void (async () => {
      if (firing) process.exit(130)
      firing = true
      shuttingDown = true
      const child = currentChild
      if (child?.pid) {
        log('signal received — stopping the current turn and saving state')
        killGroup(child.pid, 'SIGTERM')
        await Promise.race([once(child, 'close'), sleep(5000)])
        killGroup(child.pid, 'SIGKILL')
      }
      setStatus(ctx.dir, 'interrupted')
      log(`interrupted — state saved, resume any time with: ${resumeCmd}`)
      process.exit(130)
    })()
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  return () => { process.off('SIGINT', handler); process.off('SIGTERM', handler) }
}

function nextTurnSummary(ctx: Ctx, s: State): string {
  const role = normalizeRole(s.current_actor)
  return `loop ${s.current_loop} — ${role} (${role === 'dev' ? ctx.cfg.devAgent : ctx.cfg.qaAgent})`
}

// ── commands ───────────────────────────────────────────────────────────────────────────────

export async function step(track: string): Promise<number> {
  const ctx = makeCtx(track)
  const s = preflight(ctx)
  if (s.current_loop === null) {
    log(`no remaining loops for track '${track}' — all discovered Loop*.md are done. Add more before the next turn.`)
    setStatus(ctx.dir, 'completed')
    return 0
  }
  // One session id per calendar day — reuse today's if state.json already has one.
  let sessionId = s.session_id
  if (!sessionId || !sessionId.startsWith(tsDay())) {
    sessionId = tsSessionDay()
    s.session_id = sessionId
  }
  s.status = 'running'
  saveState(ctx.dir, s)
  const restore = installInterrupt(ctx, `loopcast step ${track}`)
  const res = await runTurn(ctx, sessionId, null) // step never caps a turn
  restore()

  if (res.kind === 'agent-failure') {
    setStatus(ctx.dir, 'idle')
    log(`turn failed (exit ${res.exitCode}) with no Progress.md entry — likely a usage-limit/API failure; re-run when ready: loopcast step ${track}`)
    return 1
  }
  const after = readState(ctx.dir)
  if (after.current_loop === null) {
    setStatus(ctx.dir, 'completed')
    log(`all loops complete for track '${track}'`)
  } else {
    setStatus(ctx.dir, 'idle')
    log(`ready — run again for turn ${after.turn + 1}: loopcast step ${track}   (${nextTurnSummary(ctx, after)})`)
  }
  return 0
}

// Agent-failure retry backoff: doubles per consecutive failure, capped — usage limits can
// run multi-hour windows, so the cap keeps polling cheap without giving up.
export function backoffSeconds(streak: number, base: number, cap: number): number {
  let backoff = base
  for (let n = 1; n < streak && backoff < cap; n++) backoff *= 2
  return Math.min(backoff, cap)
}

export async function auto(track: string): Promise<number> {
  const ctx = makeCtx(track)
  const s0 = preflight(ctx)
  const sessionId = tsCompact() // fresh session id per invocation
  s0.session_id = sessionId
  s0.status = 'running'
  saveState(ctx.dir, s0)
  const budget = ctx.cfg.turnMinutes === null ? null : ctx.cfg.turnMinutes * 60
  log(`track '${track}' — session ${sessionId} — auto (turn cap ${ctx.cfg.turnMinutes === null ? 'none' : `${ctx.cfg.turnMinutes}m`}, stall gate after ${ctx.cfg.stallAfterRejects} explicit NOs)`)
  const restore = installInterrupt(ctx, `loopcast auto ${track}`)
  const stopFile = join(ctx.dir, 'stop')
  // A stop file already present at startup belongs to a dead session (nothing consumed
  // it) — purge without acting on it, or a stale request would no-op this whole run.
  if (existsSync(stopFile)) { rmSync(stopFile); log('removed a stale stop file left by a previous session') }
  let failStreak = 0
  let noStreak = 0 // consecutive explicit-NO qa verdicts on the current loop; in-memory on purpose
  try {
    for (;;) {
      // Ctrl+C landed while the last turn was dying: park and let the signal handler
      // finish (status → interrupted, exit 130) instead of spawning another turn.
      if (shuttingDown) await new Promise<never>(() => undefined)
      if (existsSync(stopFile)) {
        rmSync(stopFile) // consume it — a leftover file must not kill the next run
        setStatus(ctx.dir, 'idle')
        log(`stop requested — worker for '${track}' exiting`)
        return 0
      }
      const s = readState(ctx.dir)
      syncLoops(s, discoverLoops(ctx.dir)) // pick up Loop*.md added mid-run
      saveState(ctx.dir, s)
      if (s.current_loop === null) {
        setStatus(ctx.dir, 'completed')
        log(`no remaining loops for track '${track}' — all discovered Loop*.md are done. Add more, then re-run: loopcast auto ${track}`)
        return 0
      }
      const res = await runTurn(ctx, sessionId, budget)
      if (res.kind === 'agent-failure') {
        failStreak += 1
        const backoff = backoffSeconds(failStreak, ctx.cfg.failBackoffSeconds, ctx.cfg.failBackoffMaxSeconds)
        log(`turn failed (exit ${res.exitCode}) with no Progress.md entry — likely a usage-limit/API failure; retry #${failStreak} for the same role in ${Math.round(backoff / 60)}m`)
        await sleep(backoff * 1000)
        continue
      }
      failStreak = 0 // any turn that appends resets the streak
      if (res.kind === 'advanced') noStreak = 0
      if (res.kind !== 'rejected') continue
      // rejected: only explicit NO counts — no verdict = agent failure, not an engineering NO
      if (!res.explicitNo) continue
      noStreak += 1
      if (noStreak < ctx.cfg.stallAfterRejects) continue
      const decision = await stallGate(ctx.dir, res.loop, noStreak, res.entry)
      noStreak = 0
      if (decision === 'force') {
        log(`force-passed loop ${res.loop} past QA — advancing to the next loop`)
        passLoop(ctx, readState(ctx.dir), res.loop)
      } else if (decision === 'stop') {
        setStatus(ctx.dir, 'interrupted')
        log(`stopped at the stall gate — state saved, resume any time with: loopcast auto ${track}`)
        return 130
      }
      // 'continue' → another dev pass (guidance, if any, is already in Progress.md)
    }
  } finally {
    restore()
  }
}

export async function status(track: string, json: boolean): Promise<number> {
  const ctx = makeCtx(track)
  let s: State
  try { s = readState(ctx.dir) }
  catch {
    console.error(`no state yet for track '${track}' — nothing has run. Start with: loopcast init ${track}`)
    return 1
  }
  if (json) {
    console.log(JSON.stringify(s, null, 2))
    return 0
  }
  console.log(`track:      ${s.track}`)
  console.log(`status:     ${s.status}`)
  console.log(`loop:       ${s.current_loop ?? 'none (all done)'}   completed: [${s.completed_loops.join(', ')}]   remaining: [${s.remaining_loops.join(', ')}]`)
  console.log(`session:    ${s.session_id ?? '—'}   turns so far: ${s.turn}`)
  if (s.current_loop !== null) console.log(`next turn:  ${s.turn + 1} — ${nextTurnSummary(ctx, s)}`)
  const last = s.session_history.slice(-3)
  if (last.length) {
    console.log('last turns:')
    for (const h of last) console.log(`  ${String(h.turn).padStart(4, ' ')}  ${h.role} (${h.actor})  loop ${h.loop}  exit ${h.exit_code}  ${h.started_at} → ${h.ended_at}`)
  }
  if (existsSync(join(ctx.dir, 'stop'))) console.log('note:       a stop file is pending — a running auto will exit after its current turn')
  return 0
}

export async function stop(track: string): Promise<number> {
  const ctx = makeCtx(track)
  const stopFile = join(ctx.dir, 'stop')
  let running = false
  try { running = readState(ctx.dir).status === 'running' } catch { /* no state yet */ }
  if (running) {
    writeFileSync(stopFile, '')
    log(`stop requested — the running auto for '${track}' will exit after its current turn`)
    return 0
  }
  if (existsSync(stopFile)) rmSync(stopFile)
  log(`no auto appears to be running for track '${track}' (state is not "running") — cleaned up any stale stop file`)
  return 0
}
