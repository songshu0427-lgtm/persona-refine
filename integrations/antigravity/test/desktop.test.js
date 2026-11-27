import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startFakeNode } from '../../runtime-sdk/testing/fake-node.js'
import { createDesktopRuntime, resolveModel } from '../lib/desktop.js'
import { installAntigravityPackage } from '../install.mjs'

test('desktop attaches to existing sessions, follows transcripts, and routes only their controls', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-agy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const key = '11111111-2222-4333-8444-555555555555'
  const session_id = 'desktop-agy-' + key
  const folder = join(dir, 'brain', key, '.system_generated', 'logs')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, 'transcript.jsonl')
  writeFileSync(file, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'hi' }) + '\n')
  const node = await startFakeNode(t)
  const calls = []
  const cascadeConfig = { plannerConfig: { planModel: 'test-model' } }
  const customAgentSpec = { name: 'test-agent' }
  let online = true, listed = true, configured = true
  const runtime = createDesktopRuntime({ dir, socketPath: node.path, discover: async () => online ? {} : undefined,
    call: async (_, method, params) => {
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: listed ? { [key]: {
        summary: 'test session', lastModifiedTime: new Date().toISOString(), stepCount: 1, lastUserInputStepIndex: 7,
      } } : {} }
      if (method === 'GetCascadeTrajectorySteps') {
        assert.deepEqual(params, { cascadeId: key, stepOffset: 7 })
        return { steps: configured ? [{ userInput: { userConfig: cascadeConfig, userAgentSpec: customAgentSpec } }] : [] }
      }
      if (method === 'GetCascadeModelConfigData') return {}
      calls.push({ method, params })
      return {}
    } })
  t.after(() => runtime.stop())
  await runtime.start()
  await node.ready
  const until = async fn => {
    for (let i = 0; i < 100 && !fn(); i++) await delay(25)
    assert.ok(fn())
  }
  await until(() => node.last('runtime.sessions'))
  assert.equal(node.last('runtime.sessions').sessions[0].session_id, session_id)
  assert.equal(node.last('runtime.sessions').sessions[0].launcher, 'antigravity-desktop')
  assert.deepEqual(node.last('runtime.sessions').sessions[0].capabilities, { modes: false })
  const read = await node.peer.call('session.items', { session_id })
  assert.equal(read.items[0].text, 'hi')
  await node.peer.call('session.watch', { session_id })
  appendFileSync(file, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'hello' }) + '\n')
  await until(() => node.last('session.items'))
  assert.equal(node.last('session.items').items[0].text, 'hello')
  await node.peer.call('session.send', { session_id, text: 'next', client_msg_id: 'one' })
  await node.peer.call('session.send', { session_id, text: 'next', client_msg_id: 'one' })
  await node.peer.call('session.interrupt', { session_id })
  await assert.rejects(node.peer.call('session.send', { session_id: 'agy-' + key, text: 'wrong' }), { code: 'not_found' })
  assert.deepEqual(calls, [
    { method: 'SendUserCascadeMessage', params: { cascadeId: key, items: [{ text: 'next' }], cascadeConfig, customAgentSpec, clientMessageId: 'one' } },
    { method: 'CancelCascadeInvocation', params: { cascadeId: key } },
  ])
  await assert.rejects(node.peer.call('session.send', { session_id, text: ' ' }), { code: 'bad_request' })
  await assert.rejects(node.peer.call('session.send', { session_id, text: 'image', images: [{}] }), { code: 'bad_request' })
  configured = false
  await assert.rejects(node.peer.call('session.send', { session_id, text: 'not initialized' }), /initialize the session configuration/)
  listed = false
  await assert.rejects(node.peer.call('session.interrupt', { session_id }), { code: 'not_found' })
  online = false
  await assert.rejects(node.peer.call('session.send', { session_id, text: 'offline' }), /offline/)
  assert.equal(calls.length, 2, 'rejected requests never mutate the native session')
})

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='

test('desktop lists native models and applies a selection only to the next send', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-agy-models-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const key = '11111111-2222-4333-8444-555555555555'
  const session_id = 'desktop-agy-' + key
  mkdirSync(join(dir, 'brain', key, '.system_generated', 'logs'), { recursive: true })
  const node = await startFakeNode(t)
  const sends = []
  let stepReads = 0
  let stepIndex = 4
  let currentNative = 'MODEL_PLACEHOLDER_M532'
  let failNextSend = false
  const previous = {
    plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M532', requestedModel: { model: 'MODEL_PLACEHOLDER_M532' }, nested: { preserved: true } },
    executorConfig: { useCoreDirect: true },
    conversationHistoryConfig: { preserved: true },
  }
  const runtime = createDesktopRuntime({ dir, socketPath: node.path, discover: async () => ({}),
    call: async (_, method, params) => {
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: { [key]: {
        summary: 'test session', lastModifiedTime: new Date().toISOString(), stepCount: stepIndex + 1, lastUserInputStepIndex: stepIndex,
      } } }
      if (method === 'GetCascadeTrajectorySteps') {
        stepReads++
        return { steps: [{ userInput: {
          userConfig: { ...previous, plannerConfig: { ...previous.plannerConfig, planModel: currentNative } },
          userAgentSpec: { builtinAgent: true },
        } }] }
      }
      if (method === 'GetCascadeModelConfigData') {
        return {
          defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' } },
          clientModelConfigs: [
            { modelId: 'neon-high', label: 'Neon (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' }, supportsImages: false },
            { modelId: 'neon-xhigh', label: 'Neon (XHigh)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M535' }, supportsImages: true,
              supportedMimeTypes: { 'image/png': true } },
            { modelId: 'retired', label: 'Retired', disabled: true, modelOrAlias: { model: 'MODEL_RETIRED' } },
          ],
        }
      }
      if (method === 'SendUserCascadeMessage') {
        if (failNextSend) { failNextSend = false; throw new Error('fake native refusal') }
        sends.push(params)
      }
      return {}
    } })
  t.after(() => runtime.stop())
  await runtime.start()
  await node.ready
  const until = async fn => {
    for (let i = 0; i < 100 && !fn(); i++) await delay(25)
    assert.ok(fn())
  }
  await until(() => node.last('runtime.sessions')?.sessions?.[0]?.model)
  assert.equal(node.last('runtime.sessions').sessions[0].model, 'neon-high')
  assert.deepEqual(node.last('runtime.sessions').sessions[0].capabilities, { modes: false })
  const initialReads = stepReads
  runtime.sessionsChanged()
  await delay(50)
  assert.equal(stepReads, initialReads, 'unchanged lastUserInputStepIndex reuses cached step model')
  const listed = await node.peer.call('launchers.models', { launcher: 'antigravity-desktop' })
  assert.deepEqual(listed, { agent: 'antigravity-desktop', models: [
    { id: 'neon-high', name: 'Neon (High)', description: '', default: true },
    { id: 'neon-xhigh', name: 'Neon (XHigh)', description: '', default: false },
  ] })
  const images = [{ mime: 'image/png', data: png }]
  await assert.rejects(node.peer.call('session.send', { session_id, text: 'look', images }), { code: 'unsupported' })
  assert.equal(sends.length, 0, 'a non-vision model refuses the whole message')
  await node.peer.call('session.modes', { session_id, model: 'neon-xhigh' })
  assert.equal(sends.length, 0, 'selecting a model does not send a prompt')
  await until(() => node.last('runtime.sessions')?.sessions?.[0]?.model === 'neon-xhigh')
  await assert.rejects(node.peer.call('session.modes', { session_id, model: 'missing' }), /Model unavailable/)
  await assert.rejects(node.peer.call('session.modes', { session_id, effort: 'high' }), /thinking levels/)
  await assert.rejects(node.peer.call('session.modes', { session_id, permission_mode: 'plan' }), /permission modes/)
  const imageMessage = { session_id, text: 'next', context: 'context', images, client_msg_id: 'one' }
  await node.peer.call('session.send', imageMessage)
  await node.peer.call('session.send', imageMessage)
  assert.equal(sends.length, 1)
  assert.deepEqual(sends[0].items, [{ text: 'context\n\nnext' }])
  assert.deepEqual(sends[0].media, [{ mimeType: 'image/png', inlineData: png }])
  assert.equal(sends[0].images, undefined, 'do not send the deprecated native field')
  assert.equal(sends[0].clientMessageId, 'one')
  assert.equal(sends[0].cascadeConfig.plannerConfig.planModel, 'MODEL_PLACEHOLDER_M535')
  assert.deepEqual(sends[0].cascadeConfig, {
    plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M535', requestedModel: { model: 'MODEL_PLACEHOLDER_M535' }, nested: { preserved: true } },
    executorConfig: { useCoreDirect: true },
    conversationHistoryConfig: { preserved: true },
  })
  assert.equal(previous.plannerConfig.planModel, 'MODEL_PLACEHOLDER_M532', 'the cached native config is not mutated')
  assert.deepEqual(sends[0].customAgentSpec, { builtinAgent: true })
  const imageOnly = { session_id, images, client_msg_id: 'image-only' }
  failNextSend = true
  await assert.rejects(node.peer.call('session.send', imageOnly), /fake native refusal/)
  await node.peer.call('session.send', imageOnly)
  await node.peer.call('session.send', imageOnly)
  assert.equal(sends.length, 2, 'a refused send is retryable; an accepted send is deduplicated')
  assert.deepEqual(sends[1].items, [])
  assert.deepEqual(sends[1].media, sends[0].media)
  assert.deepEqual(sends[1].cascadeConfig, sends[0].cascadeConfig)

  // If the user later switches the model in Antigravity Desktop and sends a new message there, Persona follows it.
  stepIndex = 6
  currentNative = 'MODEL_PLACEHOLDER_M532'
  runtime.sessionsChanged()
  await until(() => node.last('runtime.sessions')?.sessions?.[0]?.model === 'neon-high')
  await node.peer.call('session.send', { session_id, text: 'after native switch', client_msg_id: 'two' })
  assert.equal(sends.at(-1).cascadeConfig.plannerConfig.planModel, 'MODEL_PLACEHOLDER_M532')
  await assert.rejects(node.peer.call('session.send', { session_id, images }), { code: 'unsupported' })
  assert.equal(sends.length, 3, 'image validation follows the new native model, not the old Persona selection')
})

test('supervised desktop entrypoint exits on parent EOF without the App', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-agy-eof-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const node = await startFakeNode(t)
  const { current } = installAntigravityPackage({ socketPath: node.path })
  const child = spawn(process.execPath, [join(current, 'antigravity', 'desktop.mjs'),
    '--desktop-dir', dir, '--socket', node.path, '--parent-stdin'], { stdio: ['pipe', 'ignore', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  const exit = once(child, 'exit')
  await Promise.race([node.ready, exit.then(() => { throw new Error('Bridge exited before hello: ' + errors) })])
  child.stdin.end()
  assert.deepEqual(await exit, [0, null], errors)
})

test('desktop supports ConversationService start, rename, archive, cursor, settled interrupt, and hub retry', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-agy-conv-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const createdId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const archivedId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  const probeId = 'cccccccc-dddd-4eee-8fff-111111111111'
  const existingId = 'dddddddd-eeee-4fff-8111-222222222222'
  const folder = join(dir, 'brain', createdId, '.system_generated', 'logs')
  mkdirSync(folder, { recursive: true })
  const node = await startFakeNode(t)

  const convCalls = []
  const lsCalls = []
  let discoverCount = 0
  let failOnceWithRefused = false
  let runState = 'RUN_STATE_RUNNING'
  const conversations = new Map([
    [existingId, { id: existingId, annotations: { title: 'From Conv' }, state: { runState: 'RUN_STATE_IDLE', updateTime: new Date().toISOString() } }],
    [archivedId, { id: archivedId, annotations: { title: 'Hidden Archived', archived: true }, state: { runState: 'RUN_STATE_IDLE' } }],
    [probeId, { id: probeId, metadata: { tags: ['persona-probe'] }, state: { runState: 'RUN_STATE_IDLE' } }],
  ])

  const runtime = createDesktopRuntime({
    dir,
    home: '/Users/tester',
    socketPath: node.path,
    hubCacheMs: 60_000,
    workingPollMs: 0,
    interruptPollMs: 10,
    interruptTimeoutMs: 500,
    discover: async () => ({ httpPort: 50000 + (++discoverCount), csrfToken: 'tok' }),
    call: async (hub, method, params) => {
      if (failOnceWithRefused) {
        failOnceWithRefused = false
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      }
      lsCalls.push({ port: hub.httpPort, method, params })
      if (method === 'GetAllCascadeTrajectories') {
        return { trajectorySummaries: { [archivedId]: { summary: 'Archived Leak' }, [probeId]: { summary: 'Probe Leak' } } }
      }
      if (method === 'GetCascadeModelConfigData') {
        return {
          defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M1' } },
          clientModelConfigs: [
            { modelId: 'gemini-pro-high', label: 'Gemini Pro (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M1' }, supportsImages: true },
            { modelId: 'gemini-pro-low', label: 'Gemini Pro (Low)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M2' }, supportsImages: true },
          ],
        }
      }
      return {}
    },
    conversationCall: async (hub, method, params) => {
      convCalls.push({ port: hub.httpPort, method, params })
      if (method === 'ListConversations') return { conversations: [...conversations.values()] }
      if (method === 'CreateConversation') {
        const conv = {
          id: createdId,
          metadata: { createTime: new Date().toISOString(), tags: params.tags || [] },
          annotations: params.title ? { title: params.title } : {},
          state: { runState: params.prompt?.length ? 'RUN_STATE_RUNNING' : 'RUN_STATE_IDLE', updateTime: new Date().toISOString() },
        }
        conversations.set(createdId, conv)
        return { conversation: conv }
      }
      if (method === 'UpdateConversation') {
        const cur = conversations.get(params.conversationId) || { id: params.conversationId, annotations: {}, state: { runState: 'RUN_STATE_IDLE' } }
        cur.annotations = { ...cur.annotations, ...params.annotations }
        conversations.set(params.conversationId, cur)
        return { conversation: cur }
      }
      if (method === 'GetConversation') {
        const cur = conversations.get(params.conversationId)
        if (!cur) throw new Error('HTTP 404')
        return { conversation: { ...cur, state: { ...cur.state, runState } } }
      }
      return {}
    },
  })
  t.after(() => runtime.stop())
  await runtime.start()
  await node.ready

  const until = async fn => {
    for (let i = 0; i < 100 && !fn(); i++) await delay(25)
    assert.ok(fn())
  }
  await until(() => node.last('runtime.sessions'))
  // Archived and persona-probe conversations must be filtered even though GetAllCascadeTrajectories returned them.
  const initialIds = node.last('runtime.sessions').sessions.map(s => s.session_id)
  assert.deepEqual(initialIds, ['desktop-agy-' + existingId])

  // Start a new conversation with effort override and cwd context.
  const started = await node.peer.call('session.start', {
    cwd: '/Users/tester/repo',
    prompt: 'Hello desktop',
    model: 'gemini-pro-high',
    effort: 'low',
    title: 'Initial Title',
    client_msg_id: 'start-msg-1',
  })
  const sid = 'desktop-agy-' + createdId
  assert.equal(started.session.session_id, sid)
  assert.equal(started.session.status, 'working')
  assert.equal(started.session.model, 'gemini-pro-low')
  assert.equal(started.session.started_by_persona, true)
  const createReq = convCalls.find(c => c.method === 'CreateConversation')
  assert.equal(createReq.params.model, 'gemini-pro-low')
  assert.deepEqual(createReq.params.tags, ['persona'])
  assert.equal(createReq.params.title, 'Initial Title')
  assert.match(createReq.params.prompt[0].text, /Working directory: \/Users\/tester\/repo/)
  assert.match(createReq.params.prompt[0].text, /Hello desktop/)

  // Start rejects images (must send images after session creation).
  await assert.rejects(node.peer.call('session.start', { prompt: 'hi', images: [{ mime: 'image/png', data: png }] }), { code: 'unsupported' })

  // Transcript client_msg_id matching + watch cursor (uses driver.cursor).
  writeFileSync(join(folder, 'transcript.jsonl'), JSON.stringify({ step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Hello desktop' }) + '\n')
  const page = await node.peer.call('session.items', { session_id: sid })
  assert.equal(page.items[0].client_msg_id, 'start-msg-1')
  const watched = await node.peer.call('session.watch', { session_id: sid, after_seq: 1, history: page.history })
  assert.equal(watched.ok, true)
  await node.peer.call('session.unwatch', { session_id: sid })

  // Follow-up send on a newly created conversation works even before trajectory steps exist, and retries after ECONNREFUSED.
  failOnceWithRefused = true
  await node.peer.call('session.send', { session_id: sid, text: 'second turn', client_msg_id: 'turn-2' })
  assert.ok(discoverCount >= 2, 'ECONNREFUSED invalidated hub cache and rediscovered')
  assert.equal(lsCalls.at(-1).method, 'SendUserCascadeMessage')
  assert.equal(lsCalls.at(-1).params.cascadeId, createdId)

  // Rename, settled interrupt, archive, and unarchive.
  await node.peer.call('session.rename', { session_id: sid, title: 'Renamed Title' })
  assert.deepEqual(convCalls.at(-1).params, { conversationId: createdId, annotations: { title: 'Renamed Title' } })

  runState = 'RUN_STATE_IDLE'
  const intr = await node.peer.call('session.interrupt', { session_id: sid })
  assert.deepEqual(intr, { ok: true, settled: true })

  await node.peer.call('session.archive', { session_id: sid })
  await until(() => !node.last('runtime.sessions').sessions.some(s => s.session_id === sid))

  await node.peer.call('session.unarchive', { session_id: sid })
  await until(() => node.last('runtime.sessions').sessions.some(s => s.session_id === sid))

  // resolveModel helper checks.
  const cat = [{ id: 'gemini-pro-high', name: 'Gemini Pro (High)', default: true }, { id: 'gemini-pro-low', name: 'Gemini Pro (Low)' }]
  assert.equal(resolveModel('Gemini Pro (High)', 'low', cat), 'gemini-pro-low')
  assert.equal(resolveModel('', '', cat), 'gemini-pro-high')
})

test('desktop reports Antigravity quota windows when node advertises usage_windows and re-emits on hub reconnect', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-agy-quota-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const node = await startFakeNode(t, { features: ['prefer_running', 'usage_windows'], hub: false })
  let quotaCalls = 0
  let failForceRefresh = true
  const future5h = new Date(Date.now() + 2 * 3600_000).toISOString()
  const future7d = new Date(Date.now() + 5 * 24 * 3600_000).toISOString()
  const runtime = createDesktopRuntime({
    dir,
    socketPath: node.path,
    usageWindowsEveryMs: 0,
    discover: async () => ({ httpPort: 55555, csrfToken: 'tok' }),
    call: async (_, method, params) => {
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: {} }
      if (method === 'GetCascadeModelConfigData') return {}
      if (method === 'RetrieveUserQuotaSummary') {
        quotaCalls++
        if (failForceRefresh && params?.request?.forceRefresh === true) {
          failForceRefresh = false
          throw new Error('forceRefresh unsupported')
        }
        return {
          response: {
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [
                  { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: future5h },
                  { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.95, resetTime: future7d },
                ],
              },
              {
                displayName: 'Claude and GPT models',
                buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 1 }],
              },
            ],
          },
        }
      }
      if (method === 'GetUserStatus') {
        return { userStatus: { planStatus: { planInfo: { planName: 'Pro' } } } }
      }
      return {}
    },
  })
  t.after(() => runtime.stop())
  await runtime.start()
  await node.ready

  const until = async fn => {
    for (let i = 0; i < 100 && !fn(); i++) await delay(25)
    assert.ok(fn())
  }
  await until(() => node.last('usage.windows'))
  const first = node.last('usage.windows')
  assert.equal(first.provider, 'agy')
  assert.equal(first.name, 'Antigravity')
  assert.equal(first.plan, 'Pro')
  assert.deepEqual(first.windows, [
    { label: '5h', window_minutes: 300, used_percent: 10, resets_at: future5h, model: 'Gemini Models' },
    { label: '5h', window_minutes: 300, used_percent: 0, model: 'Claude and GPT models' },
    { label: '7d', window_minutes: 10080, used_percent: 5, resets_at: future7d, model: 'Gemini Models' },
  ])
  const callsAfterFirst = quotaCalls
  // When the hub connects right after startup, desktop re-emits the fresh snapshot without hitting RPC again.
  node.setHub(true)
  await until(() => node.all('usage.windows').length >= 2)
  assert.equal(quotaCalls, callsAfterFirst)
})

test('desktop resolves cwd via sibling projectId and preserves cached cwd when trajectories fail', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-agy-cwd-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const node = await startFakeNode(t)
  const activeId = '11111111-1111-4111-8111-111111111111'
  const olderId = '22222222-2222-4222-8222-222222222222'
  const projectId = 'f378dd9b-b625-46cd-af38-fb23b0669d7a'
  let failTrajs = false

  const runtime = createDesktopRuntime({
    dir,
    socketPath: node.path,
    usageWindowsEveryMs: 0,
    workingPollMs: 0,
    discover: async () => ({ httpPort: 55555, csrfToken: 'tok' }),
    call: async (_, method) => {
      if (method === 'GetAllCascadeTrajectories') {
        if (failTrajs) throw new Error('Antigravity GetAllCascadeTrajectories returned HTTP 500')
        return {
          trajectorySummaries: {
            [activeId]: {
              summary: 'Active Session',
              status: 'CASCADE_RUN_STATUS_IDLE',
              lastModifiedTime: '2026-11-27T08:00:00Z',
              workspaces: [{ workspaceFolderAbsoluteUri: 'file:///Users/tester/business-meta' }],
              trajectoryMetadata: { projectId },
            },
          },
        }
      }
      if (method === 'GetCascadeModelConfigData') return {}
      return {}
    },
    conversationCall: async (_, method) => {
      if (method === 'ListConversations') {
        return {
          conversations: [
            {
              id: activeId,
              metadata: { createTime: '2026-11-27T07:00:00Z', projectId },
              annotations: { title: 'Active Session' },
              state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-27T08:00:00Z' },
            },
            {
              id: olderId,
              metadata: { createTime: '2026-11-24T08:00:00Z', projectId },
              annotations: { title: 'Older Session Without Trajectory' },
              state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-24T12:00:00Z' },
            },
          ],
        }
      }
      return {}
    },
  })
  t.after(() => runtime.stop())
  await runtime.start()
  await node.ready

  const until = async fn => {
    for (let i = 0; i < 100 && !fn(); i++) await delay(25)
    assert.ok(fn())
  }
  await until(() => node.last('runtime.sessions'))
  const first = new Map(node.last('runtime.sessions').sessions.map(s => [s.session_id, s]))
  assert.equal(first.get('desktop-agy-' + activeId)?.cwd, '/Users/tester/business-meta')
  assert.equal(first.get('desktop-agy-' + olderId)?.cwd, '/Users/tester/business-meta')
  assert.equal(first.get('desktop-agy-' + olderId)?.space_name, 'business-meta')

  // A transient GetAllCascadeTrajectories failure must not wipe either session's cwd to "".
  failTrajs = true
  const beforeCount = node.all('runtime.sessions').length
  await runtime.pushNow()
  await until(() => node.all('runtime.sessions').length > beforeCount)
  const second = new Map(node.last('runtime.sessions').sessions.map(s => [s.session_id, s]))
  assert.equal(second.get('desktop-agy-' + activeId)?.cwd, '/Users/tester/business-meta')
  assert.equal(second.get('desktop-agy-' + olderId)?.cwd, '/Users/tester/business-meta')
})
