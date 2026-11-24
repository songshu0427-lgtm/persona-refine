import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startFakeNode } from '../../runtime-sdk/testing/fake-node.js'
import { createDesktopRuntime } from '../lib/desktop.js'

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
  await assert.rejects(node.peer.call('session.send', { session_id, text: ' ' }), { code: 'unsupported' })
  await assert.rejects(node.peer.call('session.send', { session_id, text: 'image', images: [{}] }), { code: 'unsupported' })
  configured = false
  await assert.rejects(node.peer.call('session.send', { session_id, text: 'not initialized' }), /initialize the session configuration/)
  listed = false
  await assert.rejects(node.peer.call('session.interrupt', { session_id }), { code: 'not_found' })
  online = false
  await assert.rejects(node.peer.call('session.send', { session_id, text: 'offline' }), /offline/)
  assert.equal(calls.length, 2, 'rejected requests never mutate the native session')
})

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
  const previous = {
    plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M532', nested: { preserved: true } },
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
            { modelId: 'neon-high', label: 'Neon (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' } },
            { modelId: 'neon-xhigh', label: 'Neon (XHigh)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M535' } },
            { modelId: 'retired', label: 'Retired', disabled: true, modelOrAlias: { model: 'MODEL_RETIRED' } },
          ],
        }
      }
      if (method === 'SendUserCascadeMessage') sends.push(params)
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
  await node.peer.call('session.modes', { session_id, model: 'neon-xhigh' })
  assert.equal(sends.length, 0, 'selecting a model does not send a prompt')
  await until(() => node.last('runtime.sessions')?.sessions?.[0]?.model === 'neon-xhigh')
  await assert.rejects(node.peer.call('session.modes', { session_id, model: 'missing' }), /Model unavailable/)
  await assert.rejects(node.peer.call('session.modes', { session_id, effort: 'high' }), /thinking levels/)
  await assert.rejects(node.peer.call('session.modes', { session_id, permission_mode: 'plan' }), /permission modes/)
  await node.peer.call('session.send', { session_id, text: 'next', client_msg_id: 'one' })
  assert.equal(sends.length, 1)
  assert.equal(sends[0].cascadeConfig.plannerConfig.planModel, 'MODEL_PLACEHOLDER_M535')
  assert.deepEqual(sends[0].cascadeConfig, {
    plannerConfig: { planModel: 'MODEL_PLACEHOLDER_M535', nested: { preserved: true } },
    executorConfig: { useCoreDirect: true },
    conversationHistoryConfig: { preserved: true },
  })
  assert.equal(previous.plannerConfig.planModel, 'MODEL_PLACEHOLDER_M532', 'the cached native config is not mutated')
  assert.deepEqual(sends[0].customAgentSpec, { builtinAgent: true })

  // If the user later switches the model in Antigravity Desktop and sends a new message there, Persona follows it.
  stepIndex = 6
  currentNative = 'MODEL_PLACEHOLDER_M532'
  runtime.sessionsChanged()
  await until(() => node.last('runtime.sessions')?.sessions?.[0]?.model === 'neon-high')
  await node.peer.call('session.send', { session_id, text: 'after native switch', client_msg_id: 'two' })
  assert.equal(sends[1].cascadeConfig.plannerConfig.planModel, 'MODEL_PLACEHOLDER_M532')
})

test('supervised desktop entrypoint exits on parent EOF without the App', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-agy-eof-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const node = await startFakeNode(t)
  const child = spawn(process.execPath, [new URL('../desktop.mjs', import.meta.url).pathname,
    '--desktop-dir', dir, '--socket', node.path, '--parent-stdin'], { stdio: ['pipe', 'ignore', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  const exit = once(child, 'exit')
  await Promise.race([node.ready, exit.then(() => { throw new Error('Bridge exited before hello: ' + errors) })])
  child.stdin.end()
  assert.deepEqual(await exit, [0, null], errors)
})
