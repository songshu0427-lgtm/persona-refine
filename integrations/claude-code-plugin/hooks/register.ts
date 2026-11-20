import type { EngineInterface, Register } from 'claude-code'
import {
  BASE,
  CAPABILITIES,
  POLL_WAIT_MS,
  PREVIEW_PRESTART_COOLDOWN_MS,
  PREVIEW_READY_STEP_MS,
  PREVIEW_READY_WAIT_MS,
  SUBMIT_QUEUE_SETTLE_MS,
  applyStepOverride,
  buildPreviewShellCommand,
  homeDir,
  isWindowsPath,
  mergeOverride,
  nextBackoff,
  parsePreviewLaunchConfig,
  previewTaskDescription,
  readPermissionPoll,
  readPoll,
  socketPath,
  verdict,
  type ActiveTurn,
  type InterruptRequest,
  type Message,
  type PollAnswer,
  type PreviewLaunchConfig,
  type SessionOverride,
  type SettingsUpdate,
} from './bridge'

// Persona's plugin (README.md): while this session lives it asks the local Persona node for the owner's own messages,
// session-scoped model / effort picks, owner turn interrupts, and remote permission approvals from the Persona apps,
// and pre-starts configured `.claude/launch.json` preview servers under `bypassPermissions` so Claude Desktop opens
// previews without blocking on a host shell confirmation card.

type Engine = EngineInterface

export const register: Register = on => {
  // One poll loop per load: a reload runs session.start again in a fresh environment, and the old loop goes with
  // its environment. A /clear keeps the loop: each poll names the session open now.
  let loop = 0
  let override: SessionOverride | undefined
  let activeTurn: ActiveTurn | undefined
  let permissionMode: string | undefined
  let permSeq = 0
  const prestartedPreviews = new Map<string, number>()

  const trackMode = (agentId: string | undefined, mode: string | undefined) => {
    if (agentId === undefined && typeof mode === 'string' && mode !== '') {
      permissionMode = mode
    }
  }

  on('classic.SessionStart', (_$, e, next) => {
    trackMode(e.agent_id, e.permission_mode)
    return next(e)
  })

  on('classic.UserPromptSubmit', (_$, e, next) => {
    trackMode(e.agent_id, e.permission_mode)
    return next(e)
  })

  on('classic.PostToolUse', (_$, e, next) => {
    trackMode(e.agent_id, e.permission_mode)
    return next(e)
  })

  on('classic.PostToolUseFailure', (_$, e, next) => {
    trackMode(e.agent_id, e.permission_mode)
    return next(e)
  })

  on('classic.ConfigChange', (_$, e, next) => {
    trackMode(e.agent_id, e.permission_mode)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const session = await $.session.id().catch(() => '')
      activeTurn = { session, turnId: e.turnId }
    }
    return next(e)
  })

  on('turn.complete', (_$, e, next) => {
    if (e.agentId === undefined && activeTurn?.turnId === e.turnId) {
      activeTurn = undefined
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const session = await $.session.id().catch(() => '')
    if (activeTurn?.turnId !== e.turnId) {
      activeTurn = { session, turnId: e.turnId }
    }
    if (override === undefined) return yield* next(e)
    const sessionModel = override.model !== undefined ? await $.session.model().catch(() => undefined) : undefined
    const applied = applyStepOverride(e, override, session, sessionModel)
    override = applied.nextOverride
    return yield* next(applied.step)
  })

  on('tool.call', { tool: 'mcp__Claude_Browser__preview_start' }, async ($, e, next) => {
    if (e.agentId !== undefined || permissionMode !== 'bypassPermissions') return next(e)
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (name === '') return next(e)
    await prestartPreviewServer($, name, prestartedPreviews, next.signal)
    return next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    trackMode(e.agent_id, e.permission_mode)
    if (e.tool_name === 'AskUserQuestion') return next(e)
    const sock = await resolveSocket($)
    if (sock === undefined) return next(e)
    const requestId = `perm_${++permSeq}_${await $.clock.now()}`
    let settled = false
    const notifyCancel = () => {
      if (settled) return
      void $.http
        .fetch(`${BASE}/permission`, post(sock, { session_id: e.session_id, request_id: requestId, cancel: true }))
        .catch(() => undefined)
    }
    next.signal.addEventListener('abort', notifyCancel, { once: true })
    try {
      while (!next.signal.aborted) {
        let status = 0
        let text = ''
        try {
          const res = await $.http.fetch(
            `${BASE}/permission`,
            post(sock, {
              session_id: e.session_id,
              request_id: requestId,
              agent_id: e.agent_id ?? '',
              tool_name: e.tool_name,
              tool_input: e.tool_input,
              cwd: e.cwd,
              transcript_path: e.transcript_path,
              permission_mode: e.permission_mode ?? '',
              wait_ms: POLL_WAIT_MS,
            }),
          )
          status = res.status
          text = res.text
        } catch {
          return next(e)
        }
        const answer = readPermissionPoll(status, text)
        if (answer.kind === 'passthrough') {
          settled = true
          return next(e)
        }
        if (answer.kind === 'decided') {
          settled = true
          return { decision: answer.decision }
        }
      }
      return next(e)
    } finally {
      next.signal.removeEventListener('abort', notifyCancel)
      if (!settled) notifyCancel()
    }
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const mine = ++loop
    void run(
      $,
      () => mine === loop,
      async (session, update) => {
        const sessionModel = update.model !== undefined ? await $.session.model().catch(() => undefined) : undefined
        override = mergeOverride(override, session, update, sessionModel)
      },
      () => activeTurn,
      turnId => {
        if (activeTurn?.turnId === turnId) activeTurn = undefined
      },
    )
    return started
  })
}

async function resolveSocket($: Engine): Promise<string | undefined> {
  const home = homeDir(await $.env.get('USERPROFILE'), await $.env.get('HOME'))
  return socketPath(home, await $.env.get('PERSONA_HOME'))
}

async function prestartPreviewServer(
  $: Engine,
  name: string,
  prestarted: Map<string, number>,
  signal: AbortSignal,
): Promise<void> {
  try {
    const loaded = await loadPreviewConfig($, name)
    if (loaded === undefined) return
    const { cfg, baseDir } = loaded
    if (isWindowsPath(baseDir) || (cfg.cwd !== undefined && isWindowsPath(cfg.cwd))) return
    if (await isLocalHttpListening($, cfg.port)) return
    const session = await $.session.id().catch(() => '')
    const key = `${session}:${cfg.name}:${cfg.port}`
    const now = await $.clock.now()
    const lastAt = prestarted.get(key)
    if (lastAt !== undefined && now - lastAt < PREVIEW_PRESTART_COOLDOWN_MS) return
    prestarted.set(key, now)
    const launched = await $.tool.call({
      tool: 'Bash',
      command: buildPreviewShellCommand(cfg, baseDir),
      description: previewTaskDescription(cfg.name),
      run_in_background: true,
    })
    if ('deny' in launched) {
      prestarted.delete(key)
      return
    }
    const deadline = (await $.clock.now()) + PREVIEW_READY_WAIT_MS
    while (!signal.aborted && (await $.clock.now()) < deadline) {
      if (await isLocalHttpListening($, cfg.port)) return
      await sleep($, PREVIEW_READY_STEP_MS)
    }
  } catch {
    // Fall back cleanly to Claude Desktop's native preview_start flow.
  }
}

async function loadPreviewConfig(
  $: Engine,
  name: string,
): Promise<{ cfg: PreviewLaunchConfig; baseDir: string } | undefined> {
  const dirs: string[] = []
  const root = await $.session.root().catch(() => '')
  if (root !== '') dirs.push(root)
  const cwd = await $.session.cwd().catch(() => '')
  if (cwd !== '' && !dirs.includes(cwd)) dirs.push(cwd)
  for (const dir of dirs) {
    try {
      const raw = await $.fs.read(`${dir.replace(/\/+$/, '')}/.claude/launch.json`)
      const cfg = parsePreviewLaunchConfig(raw, name)
      if (cfg !== undefined) return { cfg, baseDir: dir }
    } catch {
      // Try next candidate directory.
    }
  }
  return undefined
}

async function isLocalHttpListening($: Engine, port: number): Promise<boolean> {
  try {
    await $.http.fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' })
    return true
  } catch {
    return false
  }
}

async function run(
  $: Engine,
  current: () => boolean,
  onSettings: (session: string, update: SettingsUpdate) => Promise<void>,
  getActiveTurn: () => ActiveTurn | undefined,
  clearActiveTurn: (turnId: string) => void,
): Promise<void> {
  const sock = await resolveSocket($)
  if (sock === undefined) return
  const pluginVersion = await manifestVersion($)
  const engineVersion = await $.session
    .version()
    .then(v => v.version)
    .catch(() => '')
  let backoff = 0
  let reachable: boolean | undefined
  while (current()) {
    const session = await $.session.id()
    let answer: PollAnswer
    try {
      const res = await $.http.fetch(`${BASE}/poll`, post(sock, {
        session_id: session,
        plugin_version: pluginVersion,
        engine_version: engineVersion,
        capabilities: CAPABILITIES,
        wait_ms: POLL_WAIT_MS,
      }))
      answer = readPoll(res.status, res.text)
    } catch {
      answer = { kind: 'unavailable' }
    }
    if (!current()) return
    const now = answer.kind === 'messages'
    if (now !== reachable) {
      reachable = now
      $.ui.log(now ? 'Persona node reached' : `Persona node not reachable (${answer.kind})`, { to: 'debug' })
    }
    if (answer.kind !== 'messages') {
      backoff = answer.kind === 'refused' ? answer.retryMs : nextBackoff(backoff)
      await sleep($, backoff)
      continue
    }
    backoff = 0
    if (answer.settings !== undefined) await applySettings($, sock, session, answer.settings, onSettings)
    if (answer.interrupt !== undefined) {
      await applyInterrupt($, sock, session, answer.interrupt, getActiveTurn, clearActiveTurn)
    }
    for (const m of answer.messages) await deliver($, sock, session, m)
    if (answer.retryMs > 0) await sleep($, answer.retryMs)
  }
}

async function applySettings(
  $: Engine,
  sock: string,
  session: string,
  update: SettingsUpdate,
  onSettings: (session: string, update: SettingsUpdate) => Promise<void>,
): Promise<void> {
  let ok = true
  try {
    await onSettings(session, update)
  } catch {
    ok = false
  }
  const ack = ok ? { submitted: true } : { submitted: false, reason: 'failed' }
  try {
    await $.http.fetch(`${BASE}/ack`, post(sock, { session_id: session, id: update.id, ...ack }))
  } catch {
    // The node went away before receiving the ack.
  }
}

async function applyInterrupt(
  $: Engine,
  sock: string,
  session: string,
  req: InterruptRequest,
  getActiveTurn: () => ActiveTurn | undefined,
  clearActiveTurn: (turnId: string) => void,
): Promise<void> {
  let ack: { submitted: boolean; reason?: string }
  if ((await $.clock.now()) > req.deadlineMs) {
    ack = { submitted: false, reason: 'late' }
  } else {
    const turn = getActiveTurn()
    if (turn === undefined || turn.session !== session || turn.turnId === '') {
      ack = { submitted: false, reason: 'no_turn' }
    } else {
      try {
        await $.turn.abort({ turnId: turn.turnId })
        clearActiveTurn(turn.turnId)
        ack = { submitted: true }
      } catch (err) {
        const msg = String(err)
        if (msg.includes('no turn is running') || msg.includes('is already ending')) {
          clearActiveTurn(turn.turnId)
          ack = { submitted: true, reason: 'already_settled' }
        } else {
          ack = { submitted: false, reason: 'failed' }
        }
      }
    }
  }
  try {
    await $.http.fetch(`${BASE}/ack`, post(sock, { session_id: session, id: req.id, ...ack }))
  } catch {
    // The node went away before receiving the ack.
  }
}

/**
 * Submits one message as the person's words, if it may go in now, and tells the node what became of it.
 * When a turn is running, Claude Code enqueues the prompt synchronously (`queue-operation: enqueue`) and only resolves
 * `$.prompt.submit` once the queued prompt enters its own turn; racing against `SUBMIT_QUEUE_SETTLE_MS` keeps the poll
 * loop free to receive interrupts, model switches, or further follow-up prompts while the active turn finishes.
 */
async function deliver($: Engine, sock: string, session: string, m: Message): Promise<void> {
  let outcome: string = verdict(m, await $.clock.now())
  if (outcome === 'ok' && typeof m.text === 'string') {
    try {
      const pending = $.prompt.submit({ text: m.text, asUser: true })
      // Prevent unhandled rejection if `pending` settles later after being queued behind a running turn.
      pending.catch(() => undefined)
      outcome = await Promise.race([
        pending.then(
          submitted => (submitted.drop !== undefined ? 'dropped' : 'ok'),
          () => 'failed',
        ),
        sleep($, SUBMIT_QUEUE_SETTLE_MS).then(() => 'ok'),
      ])
    } catch {
      outcome = 'failed'
    }
  }
  const ack = outcome === 'ok' ? { submitted: true } : { submitted: false, reason: outcome }
  try {
    await $.http.fetch(`${BASE}/ack`, post(sock, { session_id: session, id: m.id, ...ack }))
  } catch {
    // The node went away: it reads the transcript to learn what became of the message.
  }
}

async function manifestVersion($: Engine): Promise<string> {
  try {
    const manifest: unknown = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
    const version = (manifest as { version?: unknown }).version
    return typeof version === 'string' ? version : ''
  } catch {
    return ''
  }
}

function post(socket: string, body: Record<string, unknown>) {
  return {
    method: 'POST',
    socketPath: socket,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function sleep($: Engine, ms: number): Promise<void> {
  return new Promise(resolve => {
    $.clock.after(ms, resolve)
  })
}
