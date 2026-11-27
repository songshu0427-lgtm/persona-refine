import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startFakeNode } from '../../runtime-sdk/testing/fake-node.js'
import { createDesktopRuntime } from '../lib/desktop.js'

const PARENT = '11111111-1111-4111-8111-111111111111'
const SUB_A = '22222222-2222-4222-8222-222222222222'
const SUB_B = '33333333-3333-4333-8333-333333333333'
const GRANDCHILD = '44444444-4444-4444-8444-444444444444'
const NORMAL = '55555555-5555-4555-8555-555555555555'

function writeTranscript(dir, id, steps) {
  const folder = join(dir, 'brain', id, '.system_generated', 'logs')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'transcript.jsonl'), steps.map(s => JSON.stringify(s)).join('\n') + '\n')
}

function writeParentMessage(dir, childId, parentId, content, timestamp = '2026-11-25T16:13:55Z') {
  const folder = join(dir, 'brain', childId, '.system_generated', 'messages')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'msg-1.json'), JSON.stringify({
    id: 'msg-1',
    recipient: childId,
    sender: parentId,
    timestamp,
    renderDetails: { messageTitle: 'Message from Parent Agent' },
    content,
  }))
}

test('desktop folds Antigravity subagents under their parent with role titles and parent background tasks', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-agy-sub-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const now = new Date().toISOString()
  // Parent invokes two subagents in parallel (with JSON-quoted args as Antigravity exports them).
  writeTranscript(dir, PARENT, [
    { step_index: 0, type: 'USER_INPUT', content: 'Run blind evaluation' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        { name: 'invoke_subagent', args: { Role: '"L3 Blind Judge Order1"', Prompt: '"Evaluate batch 1 carefully.\\nRule 1..."' } },
        { name: 'invoke_subagent', args: { Role: '"L3 Blind Judge Order2"', Prompt: '"Evaluate batch 2 carefully.\\nRule 1..."' } },
      ],
    },
    // Out-of-order completion: SUB_B finishes creation before SUB_A.
    { step_index: 2, type: 'GENERIC', content: `Created the following subagent:\n{\n  "conversationId": "${SUB_B}"\n}` },
    { step_index: 3, type: 'GENERIC', content: `Created the following subagent:\n{\n  "conversationId": "${SUB_A}"\n}` },
  ])

  // SUB_A detected via .system_generated/messages/*.json (matches prompt 1 -> Order1 despite out-of-order creation).
  writeParentMessage(dir, SUB_A, PARENT, 'Evaluate batch 1 carefully.\nRule 1...')

  // SUB_B detected via transcript.jsonl SYSTEM_MESSAGE sender fallback (no messages dir).
  writeTranscript(dir, SUB_B, [
    {
      step_index: 0,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      content: `The following is a <SYSTEM_MESSAGE>\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${now} sender=${PARENT} priority=MESSAGE_PRIORITY_HIGH content=Evaluate batch 2 carefully.\nRule 1...\n</SYSTEM_MESSAGE>`,
    },
  ])

  // GRANDCHILD spawned by SUB_B -> should carry parent = SUB_B, root = PARENT, and fallback title from prompt.
  writeParentMessage(dir, GRANDCHILD, SUB_B, '# Deep Verification Worker\nCheck edge cases')

  // NORMAL user session must never be marked as a subagent.
  writeTranscript(dir, NORMAL, [{ step_index: 0, type: 'USER_INPUT', content: 'Regular chat' }])

  const node = await startFakeNode(t)
  const summaries = {
    [PARENT]: {
      summary: 'Top1000 Blind Eval',
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///code/business-meta' }],
      createdTime: now,
      lastModifiedTime: now,
      stepCount: 4,
      lastUserInputStepIndex: 0,
      status: 'CASCADE_RUN_STATUS_IDLE',
    },
    [SUB_A]: {
      summary: '',
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///code/business-meta' }],
      createdTime: now,
      lastModifiedTime: now,
      stepCount: 2,
      lastUserInputStepIndex: -1,
      status: 'CASCADE_RUN_STATUS_RUNNING',
    },
    [SUB_B]: {
      summary: '',
      workspaces: [], // missing workspace should inherit from parent
      createdTime: now,
      lastModifiedTime: now,
      stepCount: 3,
      lastUserInputStepIndex: -1,
      status: 'CASCADE_RUN_STATUS_IDLE',
    },
    [GRANDCHILD]: {
      summary: '',
      workspaces: [],
      createdTime: now,
      lastModifiedTime: now,
      stepCount: 1,
      lastUserInputStepIndex: -1,
      status: 'CASCADE_RUN_STATUS_RUNNING',
    },
    [NORMAL]: {
      summary: 'Normal Chat',
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///code/business-meta' }],
      createdTime: now,
      lastModifiedTime: now,
      stepCount: 2,
      lastUserInputStepIndex: 0,
      status: 'CASCADE_RUN_STATUS_IDLE',
    },
  }

  const runtime = createDesktopRuntime({
    dir,
    socketPath: node.path,
    discover: async () => ({}),
    call: async (_, method) => {
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: summaries }
      if (method === 'GetCascadeTrajectorySteps') return { steps: [] }
      if (method === 'GetCascadeModelConfigData') return {}
      return {}
    },
  })
  t.after(() => runtime.stop())
  await runtime.start()
  await node.ready

  for (let i = 0; i < 100 && !node.last('runtime.sessions'); i++) await delay(25)
  const sessions = node.last('runtime.sessions')?.sessions || []
  const byId = new Map(sessions.map(s => [s.session_id, s]))

  const parent = byId.get('desktop-agy-' + PARENT)
  const subA = byId.get('desktop-agy-' + SUB_A)
  const subB = byId.get('desktop-agy-' + SUB_B)
  const grand = byId.get('desktop-agy-' + GRANDCHILD)
  const normal = byId.get('desktop-agy-' + NORMAL)

  assert.ok(parent && subA && subB && grand && normal)
  assert.equal(parent.is_subagent, undefined)
  assert.equal(normal.is_subagent, undefined)
  assert.equal(normal.parent_session_id, undefined)

  // SUB_A: prompt matched Role 1 despite out-of-order creation, folded under PARENT.
  assert.equal(subA.is_subagent, true)
  assert.equal(subA.parent_session_id, 'desktop-agy-' + PARENT)
  assert.equal(subA.root_session_id, 'desktop-agy-' + PARENT)
  assert.equal(subA.title, 'L3 Blind Judge Order1')
  assert.equal(subA.status, 'working')

  // SUB_B: transcript SYSTEM_MESSAGE sender detected, workspace inherited from parent, Role 2 matched.
  assert.equal(subB.is_subagent, true)
  assert.equal(subB.parent_session_id, 'desktop-agy-' + PARENT)
  assert.equal(subB.root_session_id, 'desktop-agy-' + PARENT)
  assert.equal(subB.title, 'L3 Blind Judge Order2')
  assert.equal(subB.cwd, '/code/business-meta')

  // GRANDCHILD: nested under SUB_B with root PARENT and first-line prompt fallback title.
  assert.equal(grand.is_subagent, true)
  assert.equal(grand.parent_session_id, 'desktop-agy-' + SUB_B)
  assert.equal(grand.root_session_id, 'desktop-agy-' + PARENT)
  assert.equal(grand.title, 'Deep Verification Worker')
  assert.equal(grand.cwd, '/code/business-meta')

  // Working subagents appear in their parent's background list so the parent stays working.
  assert.deepEqual(parent.background, [{
    id: SUB_A,
    kind: 'agent',
    description: 'L3 Blind Judge Order1',
    started_at: now,
  }])
  assert.deepEqual(subB.background, [{
    id: GRANDCHILD,
    kind: 'agent',
    description: 'Deep Verification Worker',
    started_at: now,
  }])
})

test('desktop pins idle parent past recent() cutoff while its subagent is working', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-agy-pin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const now = new Date().toISOString()
  const old = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString() // older than 14 days
  writeParentMessage(dir, SUB_A, PARENT, 'Still working on old parent task')

  const node = await startFakeNode(t)
  const runtime = createDesktopRuntime({
    dir,
    socketPath: node.path,
    discover: async () => ({}),
    call: async (_, method) => {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            [PARENT]: { summary: 'Old Parent', createdTime: old, lastModifiedTime: old, stepCount: 2, status: 'CASCADE_RUN_STATUS_IDLE' },
            [SUB_A]: { summary: '', createdTime: now, lastModifiedTime: now, stepCount: 1, status: 'CASCADE_RUN_STATUS_RUNNING' },
          },
        }
      }
      return {}
    },
  })
  t.after(() => runtime.stop())
  await runtime.start()
  await node.ready

  for (let i = 0; i < 100 && !node.last('runtime.sessions'); i++) await delay(25)
  const sessions = node.last('runtime.sessions')?.sessions || []
  const ids = sessions.map(s => s.session_id)
  assert.ok(ids.includes('desktop-agy-' + PARENT), 'old parent must stay pinned while subagent works')
  assert.ok(ids.includes('desktop-agy-' + SUB_A))
})

test('desktop folds Antigravity Side Questions under parent with sideQuestionTitles, hides orphans, and promotes once listed in ListConversations', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-agy-sideq-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const now = new Date().toISOString()
  const SIDE_Q = '66666666-6666-4666-8666-666666666666'
  const ORPHAN_Q = '77777777-7777-4777-8777-777777777777'
  let promoted = false

  const node = await startFakeNode(t)
  const runtime = createDesktopRuntime({
    dir,
    socketPath: node.path,
    workingPollMs: 0,
    usageWindowsEveryMs: 0,
    discover: async () => ({ httpPort: 55555, csrfToken: 'tok' }),
    conversationCall: async (_, method) => {
      if (method !== 'ListConversations') return {}
      const conversations = [
        {
          id: PARENT,
          metadata: { createTime: now, projectId: 'f378dd9b-b625-46cd-af38-fb23b0669d7a' },
          annotations: { title: 'Top1000 逐站模板代码评审' },
          state: { summary: '看一下这个对话，然后这有top1000的范围', runState: 'RUN_STATE_IDLE', updateTime: now },
        },
      ]
      if (promoted) {
        conversations.push({
          id: SIDE_Q,
          metadata: { createTime: now, projectId: 'f378dd9b-b625-46cd-af38-fb23b0669d7a' },
          annotations: { title: 'Top1000 基线与 N21 问题总结' },
          state: { summary: 'Top1000 基线与 N21 问题总结', runState: 'RUN_STATE_IDLE', updateTime: now },
        })
      }
      return { conversations }
    },
    call: async (_, method) => {
      if (method !== 'GetAllCascadeTrajectories') return {}
      return {
        trajectorySummaries: {
          [PARENT]: {
            summary: 'Top1000 逐站模板代码评审',
            workspaces: [{ workspaceFolderAbsoluteUri: 'file:///code/business-meta' }],
            createdTime: now,
            lastModifiedTime: now,
            stepCount: 10,
            status: 'CASCADE_RUN_STATUS_IDLE',
            annotations: {
              title: 'Top1000 逐站模板代码评审',
              sideQuestionCascadeIds: [SIDE_Q],
              sideQuestionTitles: { [SIDE_Q]: 'Top1000 基线与 N21 问题总结' },
            },
          },
          [SIDE_Q]: {
            summary: '看一下这个对话，然后这有top1000的范围',
            workspaces: [{ workspaceFolderAbsoluteUri: 'file:///code/business-meta' }],
            createdTime: now,
            lastModifiedTime: now,
            stepCount: 12,
            status: 'CASCADE_RUN_STATUS_IDLE',
            trajectoryType: promoted ? 'CORTEX_TRAJECTORY_TYPE_CASCADE' : 'CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION',
          },
          [ORPHAN_Q]: {
            summary: 'Orphan side question',
            workspaces: [{ workspaceFolderAbsoluteUri: 'file:///code/business-meta' }],
            createdTime: now,
            lastModifiedTime: now,
            stepCount: 5,
            status: 'CASCADE_RUN_STATUS_IDLE',
            trajectoryType: 'CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION',
          },
        },
      }
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

  // Side Question must link as a side session (parent_agent_id) under PARENT with its real title, NOT standalone or subagent card.
  const sideRow = first.get('desktop-agy-' + SIDE_Q)
  assert.ok(sideRow)
  assert.equal(sideRow.parent_agent_id, 'desktop-agy-' + PARENT)
  assert.equal(sideRow.is_subagent, undefined)
  assert.equal(sideRow.parent_session_id, undefined)
  assert.equal(sideRow.root_session_id, undefined)
  assert.equal(sideRow.title, 'Top1000 基线与 N21 问题总结')
  // Orphan Side Question with no listed parent must be hidden.
  assert.equal(first.has('desktop-agy-' + ORPHAN_Q), false)

  // Once promoted ("Continue as a New Conversation"), it appears in ListConversations and becomes top-level.
  promoted = true
  const before = node.all('runtime.sessions').length
  await runtime.pushNow()
  await until(() => node.all('runtime.sessions').length > before)
  const second = new Map(node.last('runtime.sessions').sessions.map(s => [s.session_id, s]))
  const promotedRow = second.get('desktop-agy-' + SIDE_Q)
  assert.ok(promotedRow)
  assert.equal(promotedRow.parent_agent_id, undefined)
  assert.equal(promotedRow.is_subagent, undefined)
  assert.equal(promotedRow.parent_session_id, undefined)
  assert.equal(promotedRow.title, 'Top1000 基线与 N21 问题总结')
})
