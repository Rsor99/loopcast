import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type AgentName = 'claude' | 'codex'

// path "-A" = catch-all sweep (keep last)
export interface CommitArea { name: string; path: string; exclude?: string }

export interface Config {
  loopsDir: string
  devAgent: AgentName
  qaAgent: AgentName
  claudeModel: string
  claudeDevModel: string | null // null → claudeModel
  claudeQaModel: string | null
  maxBudgetUsd: number | null
  turnMinutes: number | null
  stallAfterRejects: number
  failBackoffSeconds: number
  failBackoffMaxSeconds: number
  sandbox: string | false // path to a macOS Seatbelt .sb profile, or false
  commitAreas: CommitArea[] | null // null = single `git add -A` commit
}

// Config lives in loopcast.config.json (per-dev settings — `init` auto-gitignores it).
export const configFile = (root: string): string => join(root, 'loopcast.config.json')

const DEFAULTS: Config = {
  loopsDir: '.loopcast', devAgent: 'claude', qaAgent: 'codex',
  claudeModel: 'claude-sonnet-5', claudeDevModel: null, claudeQaModel: null,
  maxBudgetUsd: null, turnMinutes: null, stallAfterRejects: 3,
  failBackoffSeconds: 600, failBackoffMaxSeconds: 4800, sandbox: false, commitAreas: null,
}

// ── .loopcast.env (repo root, gitignored, mode 600) — secrets such as CLAUDE_CODE_OAUTH_TOKEN
// live here, never in loopcast.config.json; runTurn merges it into every agent turn's environment,
// OVER process.env, so a token saved via `loopcast init` beats a stale one exported in the shell.
export const envFile = (root: string): string => join(root, '.loopcast.env')

export function loadEnvFile(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const m of readFileSync(envFile(root), 'utf8').matchAll(/^([A-Za-z_]\w*)=(.*)$/gm)) out[m[1]] = m[2]
  } catch { /* no file */ }
  return out
}

export function saveEnvVar(root: string, key: string, value: string): void {
  const vars = { ...loadEnvFile(root), [key]: value }
  writeFileSync(envFile(root), Object.entries(vars).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 })
}

const NUMERIC = new Set<keyof Config>(['maxBudgetUsd', 'turnMinutes', 'stallAfterRejects', 'failBackoffSeconds', 'failBackoffMaxSeconds'])

export const envKey = (key: string): string => 'LOOPCAST_' + key.replace(/([A-Z])/g, '_$1').toUpperCase()

// Precedence: env (LOOPCAST_*) > loopcast.config.json > defaults. CLI has no config flags in v1.
export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): Config {
  let file: Partial<Config> = {}
  const cf = configFile(root)
  try {
    file = JSON.parse(readFileSync(cf, 'utf8')) as Partial<Config>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${cf} is not valid JSON — fix or delete it (${String(err)})`)
  }
  const cfg: Config = { ...DEFAULTS, ...file }
  for (const key of Object.keys(DEFAULTS) as (keyof Config)[]) {
    const raw = env[envKey(key)]
    if (raw === undefined || raw === '') continue
    let value: unknown = raw
    if (NUMERIC.has(key)) value = Number(raw)
    else if (key === 'sandbox') value = raw === 'false' || raw === '0' ? false : raw
    else if (key === 'commitAreas') value = JSON.parse(raw)
    Object.assign(cfg, { [key]: value })
  }
  // NaN would silently defeat every `=== null` / `<` guard downstream (watchdog, stall
  // gate, backoff) — reject bad numbers loudly, from env and loopcast.config.json alike.
  for (const key of NUMERIC) {
    const v = cfg[key]
    if (v !== null && !Number.isFinite(v)) throw new Error(`config ${key} must be a number (got ${JSON.stringify(v)}) — fix ${envKey(key)} or loopcast.config.json`)
  }
  for (const agent of [cfg.devAgent, cfg.qaAgent]) {
    if (agent !== 'claude' && agent !== 'codex') throw new Error(`devAgent/qaAgent must be "claude" or "codex" (got "${String(agent)}")`)
  }
  return cfg
}
