import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { createRuntime, page, RpcError } from '../../runtime-sdk/index.js'
import { readTranscript, stepsToItems, workspacePathOf } from './map.js'

const exec = promisify(execFile)
const prefix = 'desktop-agy-'
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const label = 'Antigravity Desktop'

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

function rpc(hub, method, body) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: hub.httpPort, method: 'POST', agent: false,
      path: '/exa.language_server_pb.LanguageServerService/' + method,
      headers: { 'content-type': 'application/json', 'x-codeium-csrf-token': hub.csrfToken },
      signal: AbortSignal.timeout(15000),
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
        if (res.statusCode !== 200) return reject(new Error(`Antigravity ${method} returned HTTP ${res.statusCode}`))
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

export function createDesktopRuntime({ dir = join(homedir(), '.gemini', 'antigravity'), socketPath, log, discover = findHub, call = rpc } = {}) {
  const watched = new Map()
  const selectedModels = new Map() // cascadeId -> { id, stepIndex }
  const stepModels = new Map() // cascadeId -> { stepIndex, native }
  let catalog = []
  let catalogFlight

  function raw(id) {
    if (typeof id !== 'string' || !id.startsWith(prefix) || !uuid.test(id.slice(prefix.length))) {
      throw new RpcError('Unknown Antigravity desktop session', 'not_found')
    }
    return id.slice(prefix.length)
  }
  function transcript(id, full = false) {
    const brainDir = join(dir, 'brain', raw(id))
    const { steps, branch, revision } = readTranscript(brainDir, true)
    return { ...stepsToItems(steps, { brainDir, full }), history: [id, 'no-tool-media', branch, revision].join(':') }
  }
  async function summaries(hub) {
    const result = await call(hub, 'GetAllCascadeTrajectories', {})
    return result.trajectorySummaries || {}
  }
  async function connect() {
    const hub = await discover(dir)
    if (!hub) throw new Error('Antigravity Desktop is offline')
    return hub
  }
  // The native UI's friendly modelId is Persona's selection id; the enum is what a send's planModel takes.
  async function loadCatalog(hub, cascadeId, refresh = false) {
    if (!refresh && catalog.length) return catalog
    if (refresh) catalogFlight = undefined
    if (!catalogFlight) {
      catalogFlight = (async () => {
        const data = await call(hub, 'GetCascadeModelConfigData', cascadeId ? { cascadeId } : {})
        const defaultNative = data.defaultOverrideModelConfig?.modelOrAlias?.model
        const seen = new Set()
        const next = (data.clientModelConfigs || []).flatMap(entry => {
          if (entry?.disabled) return []
          const id = entry?.modelId, native = entry?.modelOrAlias?.model
          if (typeof id !== 'string' || !id || typeof native !== 'string' || !native || seen.has(id)) return []
          seen.add(id)
          return [{ id, name: entry.label || id, native, description: entry.tagDescription || '',
            default: Boolean(defaultNative && native === defaultNative) }]
        })
        catalog = next
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
    if (index < 0) return ''
    let cached = stepModels.get(cascadeId)
    if (!cached || cached.stepIndex !== index) {
      const tail = await call(hub, 'GetCascadeTrajectorySteps', { cascadeId, stepOffset: index })
      const pc = tail.steps?.[0]?.userInput?.userConfig?.plannerConfig
      cached = { stepIndex: index, native: pc?.requestedModel?.model || pc?.planModel || '' }
      stepModels.set(cascadeId, cached)
    }
    if (!cached.native) return ''
    const models = await loadCatalog(hub, cascadeId)
    return models.find(model => model.native === cached.native)?.id || ''
  }
  async function control(id, method, fields) {
    const cascadeId = raw(id)
    const hub = await connect()
    const summary = (await summaries(hub))[cascadeId]
    if (!summary) throw new RpcError('Desktop session no longer listed', 'not_found')
    if (method === 'SendUserCascadeMessage') {
      // Without the desktop config, the server accepts the prompt but fails during execution.
      const index = lastInputIndex(summary)
      if (index < 0) throw new Error('Send the first message in Antigravity Desktop')
      const tail = await call(hub, 'GetCascadeTrajectorySteps', { cascadeId, stepOffset: index })
      const previous = tail.steps?.[0]?.userInput
      if (!previous?.userConfig?.plannerConfig) throw new Error('Send a message in Antigravity Desktop to initialize the session configuration')
      fields.cascadeConfig = structuredClone(previous.userConfig)
      const picked = selectedModels.get(cascadeId)
      if (picked && index <= picked.stepIndex) {
        const models = await loadCatalog(hub, cascadeId)
        const model = models.find(m => m.id === picked.id)
        if (model) {
          fields.cascadeConfig.plannerConfig.planModel = model.native
          if (fields.cascadeConfig.plannerConfig.requestedModel) {
            fields.cascadeConfig.plannerConfig.requestedModel = { model: model.native }
          }
        }
      }
      if (previous.userAgentSpec) fields.customAgentSpec = previous.userAgentSpec
    }
    await call(hub, method, { cascadeId, ...fields })
    rt.sessionsChanged()
  }
  const rt = createRuntime({
    async listSessions() {
      const hub = await discover(dir)
      if (!hub) return []
      const allSummaries = await summaries(hub)
      for (const id of stepModels.keys()) {
        if (!Object.hasOwn(allSummaries, id)) stepModels.delete(id)
      }
      const rows = []
      const bySession = new Map()
      for (const [key, value] of Object.entries(allSummaries)) {
        if (!uuid.test(key)) continue
        const cwd = workspacePathOf({ WorkspaceURIs: value.workspaces?.map(w => w.workspaceFolderAbsoluteUri) })
        const session_id = prefix + key
        bySession.set(session_id, { key, value })
        rows.push({ session_id, title: value.summary || label, cwd, agent_label: label,
          space_id: cwd, space_name: basename(cwd), updated_at: value.lastModifiedTime || value.createdTime,
          launcher: 'antigravity-desktop', capabilities: { modes: false },
          rev: Number(value.stepCount) || 1, status: value.status === 'CASCADE_RUN_STATUS_RUNNING' ? 'working' : 'idle' })
      }
      const kept = rt.recent(rows, { days: 14, max: 80, pinned: row => row.status === 'working' })
      await Promise.all(kept.map(async row => {
        const meta = bySession.get(row.session_id)
        const model = meta ? await currentModel(hub, meta.key, meta.value).catch(() => '') : ''
        if (model) row.model = model
      }))
      return kept
    },
    items(params) {
      const { items, toSeq, history } = transcript(params.session_id)
      return page(items, params, { toSeq, history })
    },
    item(params) {
      const item = transcript(params.session_id, true).items.find(it => it.id === params.item_id)
      if (!item) throw new RpcError('Unknown desktop transcript item', 'not_found')
      return item
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
      }, 1000)
      timer.unref()
      watched.set(id, timer)
    },
    async send(params) {
      raw(params.session_id)
      if (params.images?.length || !params.text?.trim()) throw new RpcError('Desktop sessions accept text prompts', 'unsupported')
      const text = [params.context, params.text].filter(Boolean).join('\n\n')
      await control(params.session_id, 'SendUserCascadeMessage', {
        items: [{ text }], ...(params.client_msg_id && { clientMessageId: params.client_msg_id }),
      })
    },
    interrupt: params => control(params.session_id, 'CancelCascadeInvocation', {}),
    async models(params = {}) {
      const hub = await connect()
      const models = await loadCatalog(hub, undefined, Boolean(params.refresh))
      return { agent: 'antigravity-desktop', models: models.map(({ native, ...model }) => model) }
    },
    async modes(params) {
      const cascadeId = raw(params.session_id)
      if (params.permission_mode && params.permission_mode !== 'default') {
        throw new RpcError('Desktop permission modes are controlled by Antigravity', 'unsupported')
      }
      if (params.effort) throw new RpcError('Desktop thinking levels are part of the selected model', 'unsupported')
      if (!params.model) return
      const hub = await connect()
      const summary = (await summaries(hub))[cascadeId]
      if (!summary) throw new RpcError('Desktop session no longer listed', 'not_found')
      const models = await loadCatalog(hub, cascadeId)
      const model = models.find(model => model.id === params.model)
      if (!model) throw new RpcError('Model unavailable', 'not_found')
      selectedModels.set(cascadeId, { id: model.id, stepIndex: lastInputIndex(summary) })
      rt.sessionsChanged()
    },
  }, { runtime: 'antigravity-desktop', agent: 'antigravity-desktop', name: label, modelSwitch: true, socketPath, log })
  return rt
}
