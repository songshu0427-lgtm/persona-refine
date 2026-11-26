import { execFile } from 'node:child_process'
import { constants, existsSync, readFileSync } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createRuntime, page, RpcError, snippet } from '../../runtime-sdk/index.js'
import { createSubagentCaches, selectDesktopSessions } from './desktop-subagents.js'
import { cleanUserText, readTranscript, stepsToItems, workspacePathOf } from './map.js'
import { checkModelMedia, inputMedia, mediaError, readUserImage, userImage } from './desktop-media.js'

const exec = promisify(execFile)
const prefix = 'desktop-agy-'
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const RUNTIME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const LAUNCHER_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/
const ENUM_MODEL_RE = /^MODEL_[A-Z0-9_]+$/
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/
const AUTO_ALIASES = [
  { id: 'pro', name: 'Antigravity Pro (Auto)' },
  { id: 'flash', name: 'Antigravity Flash (Auto)' },
  { id: 'flash_lite', name: 'Antigravity Flash Lite (Auto)' },
]
const RETRY_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE'])
const label = 'Antigravity Desktop'
const PROBE_TAG = 'persona-probe'

const trim = v => (typeof v === 'string' ? v.trim() : '')
const validModelId = v => {
  const id = trim(v)
  return !id || (id[0] === '<' && id.endsWith('>')) || ENUM_MODEL_RE.test(id) ? '' : id
}
const setBounded = (map, key, value, limit) => {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) map.delete(map.keys().next().value)
}

async function findHub(dir) {
  const folder = join(dir, 'daemon')
  let files
  try {
    files = await readdir(folder)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  let live
  for (const file of files.filter(name => /^hub_\d+\.json$/.test(name))) {
    const handle = await open(join(folder, file), constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch(error => { if (error.code !== 'ENOENT') throw error })
    if (!handle) continue
    let d
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 16384) continue
      d = JSON.parse(await handle.readFile('utf8'))
    } catch {
      continue
    } finally {
      await handle.close()
    }
    if (!Number.isSafeInteger(d.pid) || d.pid <= 0 || !Number.isInteger(d.httpPort) || d.httpPort < 1 ||
        d.httpPort > 65535 || file !== `hub_${d.httpPort}.json` || typeof d.csrfToken !== 'string' || !d.csrfToken) continue
    let listeners
    try {
      listeners = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(d.pid), '-iTCP:' + d.httpPort, '-sTCP:LISTEN', '-Fn'], { timeout: 3000 })
    } catch (error) {
      if (error.code === 1) continue
      throw error
    }
    if (!listeners.stdout.split('\n').includes('n127.0.0.1:' + d.httpPort)) continue
    if (live) throw new Error('Multiple Antigravity desktop hubs in the same data directory')
    live = d
  }
  return live
}

function postJson(hub, path, headers, body, method, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: hub.httpPort, method: 'POST', agent: false, path,
      headers: { 'content-type': 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    }, res => {
      const chunks = []
      let bytes = 0
      res.on('error', reject)
      res.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 16 * 1024 * 1024) req.destroy(new Error('Desktop RPC response is too large'))
        else chunks.push(chunk)
      })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) {
          let detail = ''
          try {
            const msg = trim(JSON.parse(text)?.message)
            if (msg) detail = `: ${msg.slice(0, 200)}`
          } catch {}
          return reject(new Error(`Antigravity ${method} returned HTTP ${res.statusCode}${detail}`))
        }
        try { resolve(text ? JSON.parse(text) : {}) } catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify(body ?? {}))
  })
}

export const rpc = (hub, method, body, timeoutMs = 15000) =>
  postJson(hub, '/exa.language_server_pb.LanguageServerService/' + method, { 'x-codeium-csrf-token': hub.csrfToken }, body, method, timeoutMs)

export const conversationRpc = (hub, method, body, timeoutMs = 25000) =>
  postJson(hub, '/product.v1.ConversationService/' + method, {
    'connect-protocol-version': '1',
    'x-antigravity-csrf-token': hub.csrfToken,
  }, body, method, timeoutMs)

export function resolveModel(requestedModel, requestedEffort, catalog = [], fallbackDefault = '') {
  const raw = trim(requestedModel)
  const effort = trim(requestedEffort).toLowerCase()
  const ids = new Set(catalog.map(m => m.id))
  let resolved = raw
    ? catalog.find(m => m.id === raw || m.name.toLowerCase() === raw.toLowerCase())?.id || raw
    : fallbackDefault || catalog.find(m => m.default)?.id || ''
  if (resolved && EFFORTS.includes(effort)) {
    const [base, existing] = resolved.split(EFFORT_SUFFIX)
    const candidate = `${existing ? base : resolved}-${effort}`
    if (ids.has(candidate) || (!ids.size && existing)) resolved = candidate
  }
  return resolved
}

const wrapContext = (uri, body) => `Content of persona-context:///${uri}:\n<persona-context>\n${body.trim()}\n</persona-context>`

function buildStartPrompt({ cwd, context, text, home }) {
  const clean = trim(text)
  if (!clean) return ''
  const parts = []
  if (cwd && cwd !== home) parts.push(wrapContext('workspace.txt', `Working directory: ${cwd}`))
  if (trim(context)) parts.push(wrapContext('snapshot.txt', context))
  parts.push(clean)
  return parts.join('\n\n')
}

function deriveStatus(convState, trajStatus, steps) {
  if (convState === 'RUN_STATE_RUNNING' || convState === 'RUN_STATE_CANCELLING' || trajStatus === 'CASCADE_RUN_STATUS_RUNNING') {
    return 'working'
  }
  const last = steps.findLast(s => ['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'ERROR_MESSAGE'].includes(s?.type))
  return last?.type === 'PLANNER_RESPONSE' && last.status === 'DONE' && trim(last.content) && !last.tool_calls?.length
    ? 'done'
    : 'idle'
}

const explicitInputCount = steps => steps.filter(s => s?.type === 'USER_INPUT' && (!s.source || s.source === 'USER_EXPLICIT')).length

export function createDesktopRuntime({
  dir = join(homedir(), '.gemini', 'antigravity'),
  home = homedir(),
  socketPath,
  log,
  runtime: runtimeOption = 'antigravity-desktop',
  agent: agentOption = 'antigravity-desktop',
  name: nameOption = label,
  launcher: launcherOption = 'antigravity-desktop',
  defaultModel: defaultModelOption = '',
  discover = findHub,
  call = rpc,
  conversationCall,
  hubCacheMs = discover === findHub ? 5000 : 0,
  pollMs = 1000,
  workingPollMs = 1500,
  interruptPollMs = 200,
  interruptTimeoutMs = 5000,
  refreshMs,
} = {}) {
  const runtimeId = trim(runtimeOption) || 'antigravity-desktop'
  if (!RUNTIME_ID_RE.test(runtimeId)) throw new Error('Unsupported Antigravity desktop runtime id')
  const agentId = trim(agentOption) || runtimeId
  if (!RUNTIME_ID_RE.test(agentId)) throw new Error('Unsupported Antigravity desktop agent id')
  const launcherName = trim(launcherOption) || runtimeId
  if (!LAUNCHER_RE.test(launcherName)) throw new Error('Unsupported Antigravity desktop launcher name')
  const displayName = trim(nameOption) || label
  const explicitDefault = trim(defaultModelOption)
  const convFn = typeof conversationCall === 'function' ? conversationCall : call === rpc ? conversationRpc : undefined

  const watched = new Map()
  const selectedModels = new Map() // cascadeId -> { id, stepIndex }
  const stepModels = new Map() // cascadeId -> { stepIndex, native }
  const sessionMeta = new Map()
  const recentlyCreated = new Map()
  const archivedIds = new Set()
  const sentMsgIds = new Map()
  const subagentCaches = createSubagentCaches()
  let sentMsgVersion = 0
  let cachedHub
  let cachedHubAt = 0
  let catalog = []
  let catalogAt = 0
  let catalogLoaded = false
  let catalogFlight
  let workingPollTimer
  let stopped = false

  function raw(id) {
    if (typeof id !== 'string' || !id.startsWith(prefix) || !uuid.test(id.slice(prefix.length))) {
      throw new RpcError('Unknown Antigravity desktop session', 'not_found')
    }
    return id.slice(prefix.length)
  }

  function readConfiguredModel() {
    const file = join(dir, 'settings.json')
    if (!existsSync(file)) return ''
    try {
      return trim(JSON.parse(readFileSync(file, 'utf8'))?.model)
    } catch {
      return ''
    }
  }

  const recordClientMsgId = (rawId, ordinal, text, clientMsgId) => {
    if (!clientMsgId) return
    setBounded(sentMsgIds, `${rawId}:${ordinal}`, { text: cleanUserText(String(text || '')), clientMsgId }, 512)
    sentMsgVersion++
  }

  const clientMsgIdFor = rawId => (_idx, text, ordinal) => {
    const entry = sentMsgIds.get(`${rawId}:${ordinal}`)
    if (entry && (!entry.text || entry.text === cleanUserText(String(text || '')))) return entry.clientMsgId
  }

  const rememberMeta = (rawId, patch) => setBounded(sessionMeta, rawId, { ...sessionMeta.get(rawId), ...patch, updatedAt: Date.now() }, 500)

  function transcript(id, full = false) {
    const rawId = raw(id)
    const brainDir = join(dir, 'brain', rawId)
    const { steps, branch, revision } = readTranscript(brainDir, true)
    const mapped = stepsToItems(steps, {
      brainDir, full,
      clientMsgIdFor: clientMsgIdFor(rawId),
      clientMsgKey: String(sentMsgVersion),
      userImage: media => userImage(media, brainDir),
      userImageKey: 'desktop-v1',
    })
    return { ...mapped, steps, history: [id, 'user-media-v1', branch, revision].join(':') }
  }

  async function getHub(force = false) {
    if (!force && hubCacheMs > 0 && cachedHub && Date.now() - cachedHubAt < hubCacheMs) return cachedHub
    cachedHub = await discover(dir)
    cachedHubAt = Date.now()
    return cachedHub
  }

  async function withHub(fn, { allowOffline = false } = {}) {
    let hub = await getHub(false)
    if (!hub) {
      if (allowOffline) return
      throw new Error('Antigravity Desktop is offline')
    }
    try {
      return await fn(hub)
    } catch (err) {
      if (!RETRY_CODES.has(err?.code)) throw err
      cachedHub = undefined
      cachedHubAt = 0
      hub = await getHub(true)
      if (!hub) {
        if (allowOffline) return
        throw new Error('Antigravity Desktop is offline')
      }
      return await fn(hub)
    }
  }

  const callConv = (hub, method, body) => {
    if (!convFn) throw new RpcError('Antigravity Desktop ConversationService is unavailable', 'unsupported')
    return convFn(hub, method, body)
  }

  async function summaries(hub) {
    const result = await call(hub, 'GetAllCascadeTrajectories', {})
    return result.trajectorySummaries || {}
  }

  async function loadTrajs(hub) {
    try {
      return await summaries(hub)
    } catch (err) {
      if (!convFn || RETRY_CODES.has(err?.code)) throw err
      return {}
    }
  }

  async function listAllConversations(hub) {
    const list = []
    let pageToken = ''
    for (let i = 0; i < 2; i++) {
      const res = await convFn(hub, 'ListConversations', {
        pageSize: 100,
        includeArchived: false,
        ...(pageToken ? { pageToken } : {}),
      })
      if (Array.isArray(res?.conversations)) list.push(...res.conversations)
      pageToken = trim(res?.nextPageToken)
      if (!pageToken) break
    }
    return list
  }

  const publicModels = (list = catalog) => list.map(({ native, supportsImages, supportedMimeTypes, ...model }) => model)

  function launcherEntry(modelsList = publicModels()) {
    const selected = modelsList.find(m => m.default)?.id || explicitDefault || readConfiguredModel()
    return {
      name: launcherName,
      agent: agentId,
      display_name: displayName,
      ...(selected ? { model: selected } : {}),
      models: modelsList,
      prompt_optional: true,
    }
  }

  // The native UI's friendly modelId is Persona's selection id; the enum is what a send's planModel takes.
  async function loadCatalog(hub, cascadeId, refresh = false) {
    if (!refresh && catalogLoaded && catalog.length && Date.now() - catalogAt < 300_000) return catalog
    if (refresh) catalogFlight = undefined
    if (!catalogFlight) {
      catalogFlight = (async () => {
        let next = []
        try {
          const data = await call(hub, 'GetCascadeModelConfigData', cascadeId ? { cascadeId } : {})
          const defaultNative = data.defaultOverrideModelConfig?.modelOrAlias?.model
          const seen = new Set()
          next = (data.clientModelConfigs || []).flatMap(entry => {
            if (entry?.disabled) return []
            const id = entry?.modelId
            const native = entry?.modelOrAlias?.model
            if (typeof id !== 'string' || !id || typeof native !== 'string' || !native || seen.has(id)) return []
            seen.add(id)
            return [{
              id,
              name: entry.label || id,
              native,
              description: entry.tagDescription || '',
              supportsImages: entry.supportsImages,
              supportedMimeTypes: entry.supportedMimeTypes,
              default: Boolean(defaultNative && native === defaultNative),
            }]
          })
        } catch (err) {
          if (RETRY_CODES.has(err?.code)) throw err
        }
        if (!next.length && convFn) {
          try {
            const res = await convFn(hub, 'ListModels', {})
            const rawModels = Array.isArray(res) ? res : Array.isArray(res?.models) ? res.models : []
            const seen = new Set()
            const defId = validModelId(res?.defaultModel)
            next = rawModels.flatMap(item => {
              const id = validModelId(item?.id ?? item?.modelId ?? item?.model)
              if (!id || seen.has(id)) return []
              seen.add(id)
              return [{
                id,
                name: trim(item?.displayName) || trim(item?.label) || trim(item?.name) || id,
                default: Boolean(item?.default === true || item?.isDefault === true || (defId && id === defId)),
              }]
            })
          } catch (err) {
            if (RETRY_CODES.has(err?.code)) throw err
          }
        }
        if (!next.length) {
          const configured = explicitDefault || readConfiguredModel()
          const base = configured ? [{ id: configured, name: configured, default: true }] : []
          const seen = new Set(base.map(m => m.id))
          next = [...base, ...AUTO_ALIASES.filter(a => !seen.has(a.id)).map(a => ({ ...a, default: !configured && a.id === 'pro' }))]
        }
        if (explicitDefault && next.some(m => m.id === explicitDefault)) {
          next = next.map(m => ({ ...m, default: m.id === explicitDefault }))
        }
        catalog = next
        catalogAt = Date.now()
        catalogLoaded = true
        rt.launchersChanged([launcherEntry(publicModels(next))])
        return next
      })().finally(() => { catalogFlight = undefined })
    }
    return catalogFlight
  }

  function lastInputIndex(summary) {
    const index = Number(summary?.lastUserInputStepIndex)
    return Number.isSafeInteger(index) && index >= 0 ? index : -1
  }

  async function currentModel(hub, cascadeId, summary) {
    const index = lastInputIndex(summary)
    const picked = selectedModels.get(cascadeId)
    if (picked) {
      if (index <= picked.stepIndex) return picked.id
      selectedModels.delete(cascadeId)
    }
    if (index < 0) return sessionMeta.get(cascadeId)?.model || ''
    let cached = stepModels.get(cascadeId)
    if (!cached || cached.stepIndex !== index) {
      const tail = await call(hub, 'GetCascadeTrajectorySteps', { cascadeId, stepOffset: index })
      const pc = tail.steps?.[0]?.userInput?.userConfig?.plannerConfig
      cached = { stepIndex: index, native: pc?.requestedModel?.model || pc?.planModel || '' }
      stepModels.set(cascadeId, cached)
    }
    if (!cached.native) return sessionMeta.get(cascadeId)?.model || ''
    const models = await loadCatalog(hub, cascadeId)
    return models.find(model => model.native === cached.native)?.id || sessionMeta.get(cascadeId)?.model || ''
  }

  const ensureWorkingPoll = () => {
    if (stopped || workingPollTimer || workingPollMs <= 0) return
    workingPollTimer = setInterval(() => rt.sessionsChanged(0), workingPollMs)
    workingPollTimer.unref?.()
  }

  const stopWorkingPoll = () => {
    if (!workingPollTimer) return
    clearInterval(workingPollTimer)
    workingPollTimer = undefined
  }

  async function confirmExists(hub, cascadeId) {
    if (!convFn) throw new RpcError('Desktop session no longer listed', 'not_found')
    try {
      await convFn(hub, 'GetConversation', { conversationId: cascadeId })
    } catch (err) {
      throw RETRY_CODES.has(err?.code) ? err : new RpcError('Desktop session no longer listed', 'not_found')
    }
  }

  const updateConversation = (rawId, annotations) =>
    withHub(hub => callConv(hub, 'UpdateConversation', { conversationId: rawId, annotations }))

  const initialLauncher = launcherEntry([])

  const rt = createRuntime({
    async listSessions() {
      const fetched = await withHub(async hub => {
        let convs = null
        if (convFn) {
          try {
            convs = await listAllConversations(hub)
          } catch (err) {
            if (RETRY_CODES.has(err?.code)) throw err
          }
        }
        return { hub, convs, trajs: await (convs ? loadTrajs(hub) : summaries(hub)) }
      }, { allowOffline: true })
      if (!fetched) {
        stopWorkingPoll()
        return []
      }
      const { hub, convs, trajs } = fetched
      const now = Date.now()
      for (const [id, info] of recentlyCreated) {
        if (now - info.createdAt > 120_000) recentlyCreated.delete(id)
      }
      for (const id of stepModels.keys()) {
        if (!Object.hasOwn(trajs, id)) stepModels.delete(id)
      }
      const byId = new Map()
      const excludedIds = new Set(archivedIds)
      if (convs !== null) {
        for (const conv of convs) {
          const id = conv?.id
          if (!id || !uuid.test(id)) continue
          if (conv?.annotations?.archived === true || (Array.isArray(conv?.metadata?.tags) && conv.metadata.tags.includes(PROBE_TAG))) {
            excludedIds.add(id)
            continue
          }
          byId.set(id, conv)
        }
      }
      for (const key of Object.keys(trajs)) {
        if (uuid.test(key) && !byId.has(key) && !excludedIds.has(key)) byId.set(key, null)
      }
      for (const [id, info] of recentlyCreated) {
        if (!byId.has(id) && !excludedIds.has(id)) {
          const iso = new Date(info.createdAt).toISOString()
          byId.set(id, {
            id,
            metadata: { createTime: iso },
            annotations: info.title ? { title: info.title } : {},
            state: { runState: info.working ? 'RUN_STATE_RUNNING' : 'RUN_STATE_IDLE', updateTime: iso },
          })
        }
      }

      let anyWorking = false
      const rows = []
      const bySession = new Map()
      for (const [key, conv] of byId) {
        const traj = trajs[key]
        const meta = sessionMeta.get(key) || {}
        const session_id = prefix + key
        const t = transcript(session_id, false)
        const status = deriveStatus(conv?.state?.runState, traj?.status, t.steps)
        if (status === 'working') anyWorking = true
        const cwd = meta.cwd || workspacePathOf({ WorkspaceURIs: traj?.workspaces?.map(w => w.workspaceFolderAbsoluteUri) }) || ''
        const title = trim(conv?.annotations?.title) || trim(meta.title) || trim(conv?.state?.summary) || trim(traj?.summary) || (cwd ? basename(cwd) : '') || displayName
        const updated_at = conv?.state?.updateTime || traj?.lastModifiedTime || traj?.createdTime || conv?.metadata?.createTime || (meta.createdAt ? new Date(meta.createdAt).toISOString() : undefined)
        bySession.set(session_id, { key, value: traj })
        rows.push({
          session_id,
          title,
          cwd,
          agent_label: displayName,
          space_id: cwd,
          space_name: basename(cwd),
          updated_at,
          launcher: launcherName,
          capabilities: { modes: false },
          rev: Math.max(1, t.toSeq || Number(traj?.stepCount) || 1),
          status,
          ...(t.lastText ? { last_text: t.lastText } : {}),
          ...(meta.startedByPersona ? { started_by_persona: true } : {}),
          ...(status !== 'working' && t.turnError ? t.turnError : {}),
        })
      }
      if (anyWorking) ensureWorkingPoll()
      else stopWorkingPoll()

      const kept = selectDesktopSessions({
        dir, prefix, label: displayName, allSummaries: trajs, rows, recent: (list, opts) => rt.recent(list, opts), caches: subagentCaches,
      })
      await Promise.all(kept.map(async row => {
        const meta = bySession.get(row.session_id)
        const model = meta ? await currentModel(hub, meta.key, meta.value).catch(() => sessionMeta.get(meta.key)?.model || '') : ''
        if (model) row.model = model
      }))
      if (!catalogLoaded) await loadCatalog(hub).catch(() => {})
      return kept
    },

    items(params) {
      const { items, toSeq, history } = transcript(params.session_id)
      return page(items, params, { toSeq, history })
    },

    cursor(sessionId) {
      const { toSeq, history } = transcript(sessionId)
      return { to_seq: toSeq, history }
    },

    item(params) {
      const item = transcript(params.session_id, true).items.find(it => it.id === params.item_id)
      if (!item) throw new RpcError('Unknown desktop transcript item', 'not_found')
      return item
    },

    async image(params) {
      const brainDir = join(dir, 'brain', raw(params.session_id))
      const { steps } = readTranscript(brainDir, true)
      const item = stepsToItems(steps, { userImage: media => userImage(media, brainDir), userImageKey: 'desktop-v1' }).items
        .find(it => it.id === params.item_id && it.kind === 'image')
      if (!item) throw mediaError('missing', 'not_found')
      const step = steps.find((step, i) => (typeof step.step_index === 'number' ? step.step_index : i) + 1 === item.seq)
      const index = Number(item.id.slice(item.id.lastIndexOf('#') + 1)) - 1
      return readUserImage(step?.media?.[index], brainDir)
    },

    watchChanged(id, on, options) {
      clearInterval(watched.get(id))
      watched.delete(id)
      if (!on || options?.transcript) return
      let previous = transcript(id)
      const timer = setInterval(() => {
        const current = transcript(id)
        const fromSeq = current.history === previous.history ? previous.toSeq : 0
        if (current.history !== previous.history || current.toSeq !== previous.toSeq) {
          rt.append(id, { ...current, fromSeq, items: current.items.filter(it => it.seq > fromSeq) })
          previous = current
          rt.sessionsChanged()
        }
      }, pollMs)
      timer.unref?.()
      watched.set(id, timer)
    },

    async start(params = {}) {
      if (params.images?.length) throw new RpcError('Desktop session start accepts text prompts; send images after creating the session', 'unsupported')
      const cwd = trim(params.cwd)
      const rawPrompt = trim(params.prompt)
      const explicitTitle = trim(params.title)
      const initialText = buildStartPrompt({ cwd, context: params.context, text: rawPrompt, home })
      return withHub(async hub => {
        if (!convFn) throw new RpcError('Antigravity Desktop ConversationService is unavailable', 'unsupported')
        if (!catalogLoaded) {
          try {
            await loadCatalog(hub)
          } catch (err) {
            if (RETRY_CODES.has(err?.code)) throw err
          }
        }
        const resolvedModel = resolveModel(params.model, params.effort, catalog, explicitDefault || readConfiguredModel())
        const res = await callConv(hub, 'CreateConversation', {
          ...(resolvedModel ? { model: resolvedModel } : {}),
          tags: ['persona'],
          ...(explicitTitle ? { title: explicitTitle } : {}),
          ...(initialText ? { prompt: [{ text: initialText }] } : {}),
        })
        const conv = res?.conversation ?? res
        const rawId = conv?.id
        if (typeof rawId !== 'string' || !uuid.test(rawId)) {
          throw new Error('Antigravity CreateConversation returned no conversation ID')
        }
        const now = Date.now()
        const nowIso = conv?.metadata?.createTime || conv?.state?.updateTime || new Date(now).toISOString()
        const title = trim(conv?.annotations?.title) || explicitTitle || (rawPrompt ? snippet(rawPrompt, 60) : '') || (cwd ? basename(cwd) : '') || displayName
        archivedIds.delete(rawId)
        rememberMeta(rawId, { cwd, model: resolvedModel || undefined, title: explicitTitle || undefined, createdAt: now, startedByPersona: true, createdViaConv: true })
        if (initialText && params.client_msg_id) recordClientMsgId(rawId, 1, rawPrompt, params.client_msg_id)
        recentlyCreated.set(rawId, { createdAt: now, title, working: Boolean(initialText) })
        if (initialText) ensureWorkingPoll()
        return {
          session: {
            session_id: prefix + rawId,
            title,
            cwd,
            status: initialText ? 'working' : 'idle',
            updated_at: nowIso,
            rev: 1,
            ...(resolvedModel ? { model: resolvedModel } : {}),
            launcher: launcherName,
            agent_label: displayName,
            started_by_persona: true,
            capabilities: { modes: false },
            space_id: cwd,
            space_name: basename(cwd),
          },
        }
      })
    },

    async send(params) {
      const cascadeId = raw(params.session_id)
      const media = inputMedia(params.images)
      if (!params.text?.trim() && !media.length) throw mediaError('empty')
      const text = [params.context, params.text].filter(Boolean).join('\n\n')
      const fields = {
        items: text.trim() ? [{ text }] : [],
        ...(media.length && { media }),
        ...(params.client_msg_id && { clientMessageId: params.client_msg_id }),
      }
      await withHub(async hub => {
        const summary = (await loadTrajs(hub))[cascadeId]
        const meta = sessionMeta.get(cascadeId)
        if (summary) {
          const index = lastInputIndex(summary)
          if (index >= 0) {
            let gotConfig = false
            try {
              const tail = await call(hub, 'GetCascadeTrajectorySteps', { cascadeId, stepOffset: index })
              const previous = tail.steps?.[0]?.userInput
              if (previous?.userConfig?.plannerConfig) {
                fields.cascadeConfig = structuredClone(previous.userConfig)
                if (previous.userAgentSpec) fields.customAgentSpec = previous.userAgentSpec
                gotConfig = true
              }
            } catch (err) {
              if (!meta?.createdViaConv && (!convFn || RETRY_CODES.has(err?.code))) throw err
            }
            if (!gotConfig && !meta?.createdViaConv) {
              if (!convFn) throw new Error('Send a message in Antigravity Desktop to initialize the session configuration')
              await confirmExists(hub, cascadeId)
            }
          } else if (!meta?.createdViaConv) {
            if (!convFn) throw new Error('Send the first message in Antigravity Desktop')
            await confirmExists(hub, cascadeId)
          }
        } else {
          await confirmExists(hub, cascadeId)
        }
        const picked = selectedModels.get(cascadeId)
        const index = lastInputIndex(summary)
        if (fields.cascadeConfig?.plannerConfig && picked && index <= picked.stepIndex) {
          const models = await loadCatalog(hub, cascadeId)
          const model = models.find(m => m.id === picked.id)
          if (model?.native) {
            fields.cascadeConfig.plannerConfig.planModel = model.native
            if (fields.cascadeConfig.plannerConfig.requestedModel) {
              fields.cascadeConfig.plannerConfig.requestedModel = { model: model.native }
            }
          }
        }
        if (fields.media?.length) {
          const models = await loadCatalog(hub, cascadeId)
          const planner = fields.cascadeConfig?.plannerConfig
          const targetNative = planner?.requestedModel?.model || planner?.planModel
          const selectedId = picked?.id || meta?.model
          const model = (targetNative && models.find(m => m.native === targetNative)) ||
            (selectedId && models.find(m => m.id === selectedId))
          checkModelMedia(model, fields.media)
        }
        if (params.client_msg_id) {
          recordClientMsgId(cascadeId, explicitInputCount(readTranscript(join(dir, 'brain', cascadeId), false).steps) + 1, params.text, params.client_msg_id)
        }
        await call(hub, 'SendUserCascadeMessage', { cascadeId, ...fields })
      })
      ensureWorkingPoll()
      rt.sessionsChanged()
    },

    async interrupt(params) {
      const cascadeId = raw(params.session_id)
      let settled = false
      await withHub(async hub => {
        if (!(await loadTrajs(hub))[cascadeId]) await confirmExists(hub, cascadeId)
        await call(hub, 'CancelCascadeInvocation', { cascadeId })
        if (convFn && interruptTimeoutMs > 0) {
          const deadline = Date.now() + interruptTimeoutMs
          for (;;) {
            try {
              const res = await convFn(hub, 'GetConversation', { conversationId: cascadeId })
              const state = (res?.conversation ?? res)?.state?.runState
              if (state === 'RUN_STATE_IDLE') {
                settled = true
                break
              }
              if (!state) break
            } catch {
              break
            }
            if (Date.now() >= deadline) break
            await delay(Math.min(interruptPollMs, Math.max(1, deadline - Date.now())))
          }
        }
      })
      rt.sessionsChanged()
      return settled ? { ok: true, settled: true } : { ok: true }
    },

    async rename(params) {
      const rawId = raw(params.session_id)
      const title = trim(params?.title)
      if (!title) return { ok: true }
      await updateConversation(rawId, { title })
      rememberMeta(rawId, { title })
      const recent = recentlyCreated.get(rawId)
      if (recent) recent.title = title
      rt.sessionsChanged()
    },

    async archive(params) {
      const rawId = raw(params.session_id)
      await updateConversation(rawId, { archived: true })
      recentlyCreated.delete(rawId)
      archivedIds.add(rawId)
      rt.sessionsChanged()
    },

    async unarchive(params) {
      const rawId = raw(params.session_id)
      await updateConversation(rawId, { archived: false })
      archivedIds.delete(rawId)
      rt.sessionsChanged()
    },

    async models(params = {}) {
      return withHub(async hub => {
        const models = await loadCatalog(hub, undefined, Boolean(params.refresh))
        return { agent: agentId, models: publicModels(models) }
      })
    },

    async modes(params) {
      const cascadeId = raw(params.session_id)
      if (params.permission_mode && params.permission_mode !== 'default') {
        throw new RpcError('Desktop permission modes are controlled by Antigravity', 'unsupported')
      }
      if (params.effort) throw new RpcError('Desktop thinking levels are part of the selected model', 'unsupported')
      if (!params.model) return
      await withHub(async hub => {
        const summary = (await loadTrajs(hub))[cascadeId]
        if (!summary) await confirmExists(hub, cascadeId)
        const models = await loadCatalog(hub, cascadeId)
        const model = models.find(m => m.id === params.model)
        if (!model) throw new RpcError('Model unavailable', 'not_found')
        selectedModels.set(cascadeId, { id: model.id, stepIndex: lastInputIndex(summary) })
        rememberMeta(cascadeId, { model: model.id })
      })
      rt.sessionsChanged()
    },
  }, {
    runtime: runtimeId,
    agent: agentId,
    name: displayName,
    launcher: launcherName,
    ...(initialLauncher.model ? { launcherModel: initialLauncher.model } : {}),
    launchers: [initialLauncher],
    modelSwitch: true,
    socketPath,
    log,
    ...(refreshMs !== undefined ? { refreshMs } : {}),
  })

  const baseStop = rt.stop.bind(rt)
  rt.stop = () => {
    stopped = true
    stopWorkingPoll()
    for (const timer of watched.values()) clearInterval(timer)
    watched.clear()
    return baseStop()
  }
  return rt
}
