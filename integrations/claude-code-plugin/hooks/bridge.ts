import type { PermissionRequestDecision } from 'claude-code'

// Protocol 1 between this plugin and the local Persona node (README.md): where the node's socket is, what a poll's
// answer holds, which messages may go in as the person's words, session-scoped model / effort overrides, bypass-mode
// preview server pre-start helpers, and remote permission approval parsing. Pure functions; register.ts does the I/O.

/** The base of the node's endpoints; the host name is not used (the request goes over the socket). */
export const BASE = 'http://persona/claude-plugin/v1'

/** Optional protocol capabilities this plugin version serves on /poll. */
export const CAPABILITIES = ['settings', 'busy_input', 'interrupt', 'permission_bridge'] as const

/** How long deliver waits for $.prompt.submit to reject or drop before treating a mid-turn call as queued. */
export const SUBMIT_QUEUE_SETTLE_MS = 250

/** How long the node may hold a poll: under the 30 s after which Claude Code's fetch gives up. */
export const POLL_WAIT_MS = 25_000

/** Backoff while no node answers: from the first to the most, doubling. */
export const BACKOFF_FIRST_MS = 2_000
export const BACKOFF_MOST_MS = 60_000

/** Cooldown before pre-starting the same preview_start configuration again when the port has not come up yet. */
export const PREVIEW_PRESTART_COOLDOWN_MS = 10_000

/** Bounded readiness probe window after launching a background dev server before handing off to preview_start. */
export const PREVIEW_READY_WAIT_MS = 1_500
export const PREVIEW_READY_STEP_MS = 150

/** The longest text submitted, in UTF-16 units; the node never sends more (its inbox line holds 1 MiB). */
export const TEXT_MOST = 200_000

const ID = /^[A-Za-z0-9_-]{1,128}$/
const MODEL = /^[A-Za-z0-9._:/[\]-]{1,200}$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export type EffortChoice = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto'

const EFFORTS: ReadonlySet<string> = new Set<EffortChoice>(['low', 'medium', 'high', 'xhigh', 'max', 'auto'])

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const)
const PERMISSION_BEHAVIORS = new Set(['allow', 'deny', 'ask'] as const)
const PERMISSION_DESTINATIONS = new Set(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg'] as const)

export function validModel(model: unknown): model is string {
  return typeof model === 'string' && MODEL.test(model) && !model.startsWith('-')
}

export function isEffortChoice(effort: unknown): effort is EffortChoice {
  return typeof effort === 'string' && EFFORTS.has(effort)
}

/**
 * The node's socket, as the node resolves it: `$PERSONA_HOME/node.sock` when that is set (`~`, `~/…` and a relative
 * path are taken from the home directory), else `<home>/.persona/node.sock`. `undefined` without a home directory.
 */
export function socketPath(home: string | undefined, personaHome: string | undefined): string | undefined {
  if (!home) return undefined
  const sep = /^[A-Za-z]:[\\/]/.test(home) || home.includes('\\') ? '\\' : '/'
  const join = (a: string, b: string) => (a.endsWith('/') || a.endsWith('\\') ? a + b : a + sep + b)
  let root = join(home, '.persona')
  const p = personaHome?.trim()
  if (p) {
    if (p === '~') root = home
    else if (p.startsWith('~/') || p.startsWith('~\\')) root = join(home, p.slice(2))
    else if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) root = p
    else root = join(home, p)
  }
  return join(root, 'node.sock')
}

/** The home directory: `USERPROFILE` on Windows (what the node's Go reads there), else `HOME`. */
export function homeDir(userProfile: string | undefined, home: string | undefined): string | undefined {
  if (userProfile && /^[A-Za-z]:[\\/]/.test(userProfile)) return userProfile
  return home || undefined
}

/** One message the node handed over: its id, the text, and the time after which it must not be submitted. */
export type Message = { id: string; text: unknown; deadlineMs: number }

/** A session-only model / effort switch handed over by the node. */
export type SettingsUpdate = { id: string; model?: string; effort?: EffortChoice }

/** An owner Stop handed over by the node to cancel the running main-loop turn via $.turn.abort. */
export type InterruptRequest = { id: string; deadlineMs: number }

/** The running main-loop turn tracked from turn.start / turn.step until turn.complete. */
export type ActiveTurn = { session: string; turnId: string }

/** In-memory session-only model / effort override applied on main-loop `turn.step` calls. */
export type SessionOverride = {
  session: string
  model?: string
  baseModel?: string
  effort?: EffortChoice
}

/** Validated `.claude/launch.json` configuration entry for `mcp__Claude_Browser__preview_start`. */
export type PreviewLaunchConfig = {
  name: string
  runtimeExecutable: string
  runtimeArgs: string[]
  port: number
  cwd?: string
  env?: Record<string, string>
}

/** Answer returned by `/claude-plugin/v1/permission`. */
export type PermissionPollAnswer =
  | { kind: 'pending' }
  | { kind: 'passthrough' }
  | { kind: 'decided'; decision: PermissionRequestDecision }

/** What a poll came to. */
export type PollAnswer =
  | { kind: 'messages'; messages: Message[]; settings?: SettingsUpdate; interrupt?: InterruptRequest; retryMs: number }
  | { kind: 'refused'; retryMs: number } // the node does not take this process for this session
  | { kind: 'unavailable' } // no node, an old node, or no answer

function readSettings(raw: unknown): SettingsUpdate | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { id, model, effort } = raw as Record<string, unknown>
  if (typeof id !== 'string' || !ID.test(id)) return undefined
  if (model !== undefined && model !== '' && !validModel(model)) return undefined
  if (effort !== undefined && effort !== '' && !isEffortChoice(effort)) return undefined
  const m = typeof model === 'string' && model !== '' ? model : undefined
  const ef = isEffortChoice(effort) ? effort : undefined
  if (m === undefined && ef === undefined) return undefined
  return { id, ...(m !== undefined ? { model: m } : {}), ...(ef !== undefined ? { effort: ef } : {}) }
}

function readInterrupt(raw: unknown): InterruptRequest | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { id, deadline_ms: deadline } = raw as Record<string, unknown>
  if (typeof id !== 'string' || !ID.test(id) || typeof deadline !== 'number') return undefined
  return { id, deadlineMs: deadline }
}

/** Reads a poll's answer: status and body as `$.http.fetch` resolved them. */
export function readPoll(status: number, body: string): PollAnswer {
  if (status === 403) return { kind: 'refused', retryMs: retryOf(parse(body), BACKOFF_MOST_MS) }
  if (status !== 200) return { kind: 'unavailable' }
  const answer = parse(body)
  if (answer === undefined) return { kind: 'unavailable' }
  const list = Array.isArray(answer.messages) ? answer.messages : []
  const messages: Message[] = []
  for (const m of list) {
    if (typeof m !== 'object' || m === null) continue
    const { id, text, deadline_ms: deadline } = m as Record<string, unknown>
    if (typeof id !== 'string' || !ID.test(id) || typeof deadline !== 'number') continue
    messages.push({ id, text, deadlineMs: deadline })
  }
  const settings = readSettings(answer.settings)
  const interrupt = readInterrupt(answer.interrupt)
  return {
    kind: 'messages',
    messages,
    ...(settings !== undefined ? { settings } : {}),
    ...(interrupt !== undefined ? { interrupt } : {}),
    retryMs: retryOf(answer, 0),
  }
}

/** Exact shell task description Claude Desktop's `preview_start` checks in `shellTasks()`. */
export function previewTaskDescription(name: string): string {
  return `Dev server ${JSON.stringify(name)} (preview_start)`
}

/** POSIX single-quote escaping for arbitrary argv / cwd / env values. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Extracts and validates a launch configuration by name from `.claude/launch.json`. */
export function parsePreviewLaunchConfig(rawJson: string, targetName: string): PreviewLaunchConfig | undefined {
  if (typeof targetName !== 'string' || targetName.trim() === '' || targetName.length > 200) return undefined
  const root = parse(rawJson)
  if (root === undefined || !Array.isArray(root.configurations)) return undefined
  for (const item of root.configurations) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    if (rec.name !== targetName) continue
    const exe = rec.runtimeExecutable
    if (typeof exe !== 'string' || exe.trim() === '' || /[\0\r\n]/.test(exe)) return undefined
    const port = rec.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
    const argsRaw = rec.runtimeArgs
    const runtimeArgs: string[] = []
    if (argsRaw !== undefined) {
      if (!Array.isArray(argsRaw)) return undefined
      for (const a of argsRaw) {
        if (typeof a !== 'string' || a.includes('\0')) return undefined
        runtimeArgs.push(a)
      }
    }
    let cwd: string | undefined
    if (rec.cwd !== undefined) {
      if (typeof rec.cwd !== 'string' || rec.cwd.includes('\0')) return undefined
      const trimmed = rec.cwd.trim()
      if (trimmed !== '') cwd = trimmed
    }
    let env: Record<string, string> | undefined
    if (rec.env !== undefined) {
      if (typeof rec.env !== 'object' || rec.env === null || Array.isArray(rec.env)) return undefined
      env = {}
      for (const [k, v] of Object.entries(rec.env as Record<string, unknown>)) {
        if (!ENV_KEY.test(k)) return undefined
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return undefined
        const sv = String(v)
        if (sv.includes('\0')) return undefined
        env[k] = sv
      }
    }
    return {
      name: targetName,
      runtimeExecutable: exe.trim(),
      runtimeArgs,
      port,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(env !== undefined ? { env } : {}),
    }
  }
  return undefined
}

/** True when a path uses Windows drive or UNC syntax, where POSIX `cd ... && exec ...` shell syntax does not apply. */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.includes('\\')
}

/** Builds a POSIX shell command to launch `cfg` from `baseDir` with safe quoting. */
export function buildPreviewShellCommand(cfg: PreviewLaunchConfig, baseDir: string): string {
  let targetDir = baseDir
  if (cfg.cwd !== undefined) {
    targetDir = cfg.cwd.startsWith('/') ? cfg.cwd : `${baseDir.replace(/\/+$/, '')}/${cfg.cwd}`
  }
  const envParts: string[] = []
  if (cfg.env !== undefined) {
    for (const [k, v] of Object.entries(cfg.env)) {
      envParts.push(`${k}=${shellQuote(v)}`)
    }
  }
  const cmdParts = [shellQuote(cfg.runtimeExecutable), ...cfg.runtimeArgs.map(shellQuote)]
  const execLine = envParts.length > 0 ? `env ${envParts.join(' ')} ${cmdParts.join(' ')}` : cmdParts.join(' ')
  return `cd ${shellQuote(targetDir)} && exec ${execLine}`
}

type PermissionUpdatesList = NonNullable<Extract<PermissionRequestDecision, { behavior: 'allow' }>['updatedPermissions']>

function readPermissionUpdates(raw: unknown): PermissionUpdatesList | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PermissionUpdatesList = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined
    const rec = item as Record<string, unknown>
    const dest = rec.destination
    if (typeof dest !== 'string' || !PERMISSION_DESTINATIONS.has(dest as never)) return undefined
    const destination = dest as PermissionUpdatesList[number]['destination']
    if (rec.type === 'setMode') {
      if (typeof rec.mode !== 'string' || !PERMISSION_MODES.has(rec.mode as never)) return undefined
      out.push({
        type: 'setMode',
        mode: rec.mode as Extract<PermissionUpdatesList[number], { type: 'setMode' }>['mode'],
        destination,
      })
      continue
    }
    if (rec.type === 'addRules' || rec.type === 'replaceRules' || rec.type === 'removeRules') {
      if (typeof rec.behavior !== 'string' || !PERMISSION_BEHAVIORS.has(rec.behavior as never)) return undefined
      if (!Array.isArray(rec.rules)) return undefined
      const rules: { toolName: string; ruleContent?: string }[] = []
      for (const r of rec.rules) {
        if (typeof r !== 'object' || r === null || Array.isArray(r)) return undefined
        const rr = r as Record<string, unknown>
        if (typeof rr.toolName !== 'string' || rr.toolName === '') return undefined
        if (rr.ruleContent !== undefined && typeof rr.ruleContent !== 'string') return undefined
        rules.push({
          toolName: rr.toolName,
          ...(typeof rr.ruleContent === 'string' ? { ruleContent: rr.ruleContent } : {}),
        })
      }
      out.push({
        type: rec.type,
        rules,
        behavior: rec.behavior as 'allow' | 'deny' | 'ask',
        destination,
      })
      continue
    }
    return undefined
  }
  return out
}

/** Reads `/claude-plugin/v1/permission` responses into a typed permission poll answer. */
export function readPermissionPoll(status: number, body: string): PermissionPollAnswer {
  if (status !== 200) return { kind: 'passthrough' }
  const answer = parse(body)
  if (answer === undefined) return { kind: 'passthrough' }
  if (answer.status === 'pending') return { kind: 'pending' }
  if (answer.status !== 'decided') return { kind: 'passthrough' }
  const raw = answer.decision
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'passthrough' }
  const dec = raw as Record<string, unknown>
  if (dec.behavior === 'allow') {
    const updatedInput =
      typeof dec.updatedInput === 'object' && dec.updatedInput !== null && !Array.isArray(dec.updatedInput)
        ? (dec.updatedInput as Record<string, unknown>)
        : undefined
    const updatedPermissions = dec.updatedPermissions !== undefined ? readPermissionUpdates(dec.updatedPermissions) : undefined
    return {
      kind: 'decided',
      decision: {
        behavior: 'allow',
        ...(updatedInput !== undefined ? { updatedInput } : {}),
        ...(updatedPermissions !== undefined ? { updatedPermissions } : {}),
      },
    }
  }
  if (dec.behavior === 'deny') {
    return {
      kind: 'decided',
      decision: {
        behavior: 'deny',
        ...(typeof dec.message === 'string' && dec.message !== '' ? { message: dec.message } : {}),
        ...(dec.interrupt === true ? { interrupt: true } : {}),
      },
    }
  }
  return { kind: 'passthrough' }
}

/** Merges a new settings update into the active session override. */
export function mergeOverride(
  prev: SessionOverride | undefined,
  session: string,
  update: SettingsUpdate,
  sessionModel: string | undefined,
): SessionOverride {
  const base = prev?.session === session ? prev : undefined
  const next: SessionOverride = { session }
  if (update.model !== undefined) {
    next.model = update.model
    if (sessionModel !== undefined) next.baseModel = sessionModel
  } else if (base?.model !== undefined) {
    next.model = base.model
    if (base.baseModel !== undefined) next.baseModel = base.baseModel
  }
  if (update.effort !== undefined) next.effort = update.effort
  else if (base?.effort !== undefined) next.effort = base.effort
  return next
}

/** Applies the active session override to a main-loop `turn.step` input, clearing it if the computer changed models. */
export function applyStepOverride<
  E extends { model: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number; agentId?: string },
>(
  step: E,
  override: SessionOverride | undefined,
  session: string,
  sessionModel: string | undefined,
): { step: E; nextOverride: SessionOverride | undefined } {
  if (override === undefined || step.agentId !== undefined) return { step, nextOverride: override }
  if (override.session !== session) return { step, nextOverride: undefined }
  if (
    override.model !== undefined &&
    override.baseModel !== undefined &&
    sessionModel !== undefined &&
    sessionModel !== override.baseModel
  ) {
    // The user picked a different model in the desktop / terminal UI after Persona's switch: let the newer pick win.
    return { step, nextOverride: undefined }
  }
  const nextStep: E = { ...step }
  if (override.model !== undefined) nextStep.model = override.model
  if (override.effort === 'auto') delete nextStep.effort
  else if (override.effort !== undefined) nextStep.effort = override.effort
  return { step: nextStep, nextOverride: override }
}

/** Why a message is not submitted, or `ok`. */
export type Verdict = 'ok' | 'invalid' | 'late' | 'command'

/**
 * Whether the message may go in as the person's words now (`now`, epoch ms): text that is a string with something in
 * it and not too long, before its deadline, and no slash command (the node sends none; a command would run, not be
 * read).
 */
export function verdict(m: Message, now: number): Verdict {
  if (typeof m.text !== 'string' || m.text.trim() === '' || m.text.length > TEXT_MOST) return 'invalid'
  if (now > m.deadlineMs) return 'late'
  if (m.text.trimStart().startsWith('/')) return 'command'
  return 'ok'
}

/** The wait after a failed poll: the first backoff, then twice the last, up to the most. */
export function nextBackoff(last: number): number {
  return last <= 0 ? BACKOFF_FIRST_MS : Math.min(last * 2, BACKOFF_MOST_MS)
}

function parse(body: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(body)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function retryOf(answer: Record<string, unknown> | undefined, fallback: number): number {
  const r = answer?.retry_ms
  return typeof r === 'number' && r >= 0 && r <= 3_600_000 ? r : fallback
}
