import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import {
  applyStepOverride,
  buildPreviewShellCommand,
  homeDir,
  mergeOverride,
  nextBackoff,
  parsePreviewLaunchConfig,
  previewTaskDescription,
  readPermissionPoll,
  readPoll,
  socketPath,
  verdict,
} from '../hooks/bridge'

const SESSION = '11111111-2222-3333-4444-555555555555'

type Answer = { status: number; body: unknown } | { fail: true }

// The engine beneath the plugin: a session, its manifest, and a node that answers polls in the order given (then
// none: a node that went away), recording every request, prompt, background shell pre-start, and permission poll.
function world(
  on: On,
  polls: Answer[],
  env: Record<string, string> = { HOME: '/home/me' },
  extra: {
    permissionPolls?: Answer[]
    files?: Record<string, string>
    listeningPorts?: Set<number>
    cwd?: string
  } = {},
) {
  const requests: { url: string; method?: string; socketPath?: string; body: Record<string, unknown> }[] = []
  const submitted: { text: string; origin: unknown }[] = []
  const aborted: string[] = []
  const steps: { model: string; effort?: string | number; agentId?: string }[] = []
  const toolCalls: Record<string, unknown>[] = []
  const permissionPolls = [...(extra.permissionPolls ?? [])]
  const listeningPorts = extra.listeningPorts ?? new Set<number>()
  const workDir = extra.cwd ?? '/work'
  let sessionModel = 'claude-sonnet-5-5'
  let holdSubmit = false
  let abortError: string | undefined
  let onBashLaunch: (() => void) | undefined

  mock.env(on, env)
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: workDir }))
  on('session.root', () => ({ value: workDir }))
  on('session.model', () => ({ value: sessionModel }))
  on('session.version', () => ({ value: { version: '2.1.326', base: '2.1.326' } }))
  on('fs.read', (_$, e) => {
    if (extra.files !== undefined && e.path in extra.files) {
      return { value: extra.files[e.path]! }
    }
    if (e.path.endsWith('/.claude-plugin/plugin.json')) {
      return { value: '{"name":"persona","version":"0.4.0"}' }
    }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('ui.log', () => ({ value: undefined }))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.ConfigChange', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('tool.call', (_$, e) => {
    const { tool_use_id: _id, ...rec } = e as unknown as Record<string, unknown>
    toolCalls.push(rec)
    if (rec.tool === 'Bash') {
      onBashLaunch?.()
      return { result: 'started in background' }
    }
    return { result: 'ok' }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('turn.abort', (_$, e) => {
    if (abortError !== undefined) throw new Error(abortError)
    aborted.push(e.turnId)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    submitted.push({ text: e.text, origin: e.origin })
    if (holdSubmit) return new Promise(() => {})
    return { text: e.text }
  })
  on('turn.step', async function* (_$, e) {
    steps.push({
      model: e.model,
      ...(e.effort !== undefined ? { effort: e.effort } : {}),
      ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
    })
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('http.fetch', (_$, e) => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/$/.exec(e.url)
    if (m !== null) {
      const port = Number(m[1])
      if (!listeningPorts.has(port)) throw new Error('ECONNREFUSED')
      return { value: { status: 200, ok: true, headers: {}, text: '' } }
    }
    const rawBody = typeof e.init?.body === 'string' ? e.init.body : '{}'
    const parsed = JSON.parse(rawBody) as Record<string, unknown>
    requests.push({ url: e.url, method: e.init?.method, socketPath: e.init?.socketPath, body: parsed })
    if (e.url.endsWith('/ack')) return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
    if (e.url.endsWith('/permission')) {
      if (parsed.cancel === true) return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
      const next = permissionPolls.shift() ?? { fail: true }
      if ('fail' in next) throw new Error('connection refused')
      return { value: { status: next.status, ok: next.status === 200, headers: {}, text: JSON.stringify(next.body) } }
    }
    const next = polls.shift() ?? { fail: true }
    if ('fail' in next) throw new Error('connection refused')
    return { value: { status: next.status, ok: next.status === 200, headers: {}, text: JSON.stringify(next.body) } }
  })
  return {
    requests,
    submitted,
    aborted,
    steps,
    toolCalls,
    listeningPorts,
    clock,
    setSessionModel(m: string) {
      sessionModel = m
    },
    setHoldSubmit(v: boolean) {
      holdSubmit = v
    },
    setAbortError(err: string | undefined) {
      abortError = err
    },
    setOnBashLaunch(fn: (() => void) | undefined) {
      onBashLaunch = fn
    },
  }
}

const start = { cwd: '/work', surface: 'desktop', isInteractive: true } as const

describe('persona plugin', () => {
  test('submits the node’s message as the person’s words and says so', async ($, on) => {
    const w = world(on, [{ status: 200, body: { messages: [{ id: 'm1', text: 'go ahead and merge', deadline_ms: 9_000 }] } }])
    await $.session.start(start)
    await w.clock.settle()

    expect(w.submitted).toEqual([{ text: 'go ahead and merge', origin: { kind: 'plugin', name: 'persona', asUser: true } }])
    const [poll, ack] = w.requests
    expect(poll?.url).toBe('http://persona/claude-plugin/v1/poll')
    expect(poll?.socketPath).toBe('/home/me/.persona/node.sock')
    expect(poll?.body).toEqual({
      session_id: SESSION,
      plugin_version: '0.4.0',
      engine_version: '2.1.326',
      capabilities: ['settings', 'busy_input', 'interrupt', 'permission_bridge'],
      wait_ms: 25_000,
    })
    expect(ack?.url).toBe('http://persona/claude-plugin/v1/ack')
    expect(ack?.body).toEqual({ session_id: SESSION, id: 'm1', submitted: true })
  })

  test('queues a busy message without blocking the poll loop and aborts the active main-loop turn on interrupt', async ($, on) => {
    const w = world(on, [
      { status: 200, body: { messages: [{ id: 'm-busy', text: 'also check edge cases', deadline_ms: 9_000 }] } },
      { status: 200, body: { messages: [], interrupt: { id: 'int-1', deadline_ms: 9_000 } } },
      { status: 200, body: { messages: [], interrupt: { id: 'int-2', deadline_ms: 9_000 } } },
    ])
    w.setHoldSubmit(true)
    await $.turn.start({ text: 'initial task', turnId: 'turn-main-1' })
    await $.turn.start({ text: 'subagent task', turnId: 'turn-sub-1', agentId: 'sub-1' })
    await $.session.start(start)
    await w.clock.settle()

    // While prompt.submit waits behind the running turn, advancing the settle window acks the queued message and polls on.
    await w.clock.advance(250)
    await w.clock.settle()

    expect(w.submitted).toEqual([{ text: 'also check edge cases', origin: { kind: 'plugin', name: 'persona', asUser: true } }])
    expect(w.aborted).toEqual(['turn-main-1'])
    expect(w.requests.filter(r => r.url.endsWith('/ack')).map(r => r.body)).toEqual([
      { session_id: SESSION, id: 'm-busy', submitted: true },
      { session_id: SESSION, id: 'int-1', submitted: true },
      { session_id: SESSION, id: 'int-2', submitted: false, reason: 'no_turn' },
    ])
  })

  test('applies session-only model and effort switches on main-loop turn.step and yields when desktop changes model', async ($, on) => {
    const w = world(on, [
      { status: 200, body: { messages: [], settings: { id: 's1', model: 'gateway-opus-5-5[1m]', effort: 'xhigh' } } },
    ])
    await $.session.start(start)
    await w.clock.settle()

    expect(w.requests.filter(r => r.url.endsWith('/ack')).map(r => r.body)).toEqual([
      { session_id: SESSION, id: 's1', submitted: true },
    ])

    const runStep = async (input: Parameters<typeof $.turn.step>[0]) => {
      const gen = $.turn.step(input)
      while (!(await gen.next()).done) {
        // drain chunks
      }
    }

    // Main loop step gets the picked model and effort; subagent step keeps its own model.
    await runStep({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1 })
    await runStep({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'sub-1' })
    expect(w.steps).toEqual([
      { model: 'gateway-opus-5-5[1m]', effort: 'xhigh' },
      { model: 'claude-haiku-5-5', agentId: 'sub-1' },
    ])

    // Changing model in Claude Desktop UI supersedes Persona's earlier pick.
    w.setSessionModel('claude-opus-5-5')
    await runStep({ turnId: 't2', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 2 })
    expect(w.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test('pre-starts .claude/launch.json dev server before preview_start only under bypassPermissions', async ($, on) => {
    const launchJson = JSON.stringify({
      version: '0.0.1',
      configurations: [
        {
          name: 'demo-web',
          runtimeExecutable: 'npm',
          runtimeArgs: ['run', 'dev', '--', '--port', '4173'],
          port: 4173,
          cwd: 'apps/web',
          env: { HOST: '127.0.0.1' },
        },
      ],
    })
    const w = world(on, [], { HOME: '/home/me' }, { files: { '/work/.claude/launch.json': launchJson } })
    w.setOnBashLaunch(() => {
      w.listeningPorts.add(4173)
    })

    // Default mode: never pre-starts.
    await $.classic.SessionStart({ source: 'startup', permission_mode: 'default' })
    await $.tool.call({ tool: 'mcp__Claude_Browser__preview_start', name: 'demo-web' } as never)
    expect(w.toolCalls.map(c => c.tool)).toEqual(['mcp__Claude_Browser__preview_start'])

    // Bypass mode: pre-starts matching background Bash task with Claude Desktop's exact description before preview_start.
    await $.classic.ConfigChange({ source: 'user_settings', permission_mode: 'bypassPermissions' })
    await $.tool.call({ tool: 'mcp__Claude_Browser__preview_start', name: 'demo-web' } as never)
    expect(w.toolCalls).toEqual([
      { tool: 'mcp__Claude_Browser__preview_start', name: 'demo-web' },
      {
        tool: 'Bash',
        command: "cd '/work/apps/web' && exec env HOST='127.0.0.1' 'npm' 'run' 'dev' '--' '--port' '4173'",
        description: 'Dev server "demo-web" (preview_start)',
        run_in_background: true,
      },
      { tool: 'mcp__Claude_Browser__preview_start', name: 'demo-web' },
    ])

    // Already listening on 4173: does not spawn a duplicate background server.
    await $.tool.call({ tool: 'mcp__Claude_Browser__preview_start', name: 'demo-web' } as never)
    expect(w.toolCalls.filter(c => c.tool === 'Bash').length).toBe(1)
  })

  test('bridges non-bypass classic.PermissionRequest over /permission long-polls and passes AskUserQuestion through', async ($, on) => {
    const w = world(
      on,
      [],
      { HOME: '/home/me' },
      {
        permissionPolls: [
          { status: 200, body: { status: 'pending' } },
          {
            status: 200,
            body: {
              status: 'decided',
              decision: {
                behavior: 'allow',
                updatedPermissions: [
                  {
                    type: 'addRules',
                    rules: [{ toolName: 'Bash' }],
                    behavior: 'allow',
                    destination: 'session',
                  },
                ],
              },
            },
          },
          { status: 200, body: { status: 'passthrough' } },
        ],
      },
    )

    // AskUserQuestion stays on the existing clq_ transcript channel without hitting /permission.
    const askRes = await $.classic.PermissionRequest({
      session_id: SESSION,
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] },
      permission_mode: 'default',
    })
    expect(askRes).toEqual({})
    expect(w.requests.filter(r => r.url.endsWith('/permission'))).toEqual([])

    // Standard tool permission: polls once ('pending'), polls again ('decided'), returns remote decision.
    const permRes = await $.classic.PermissionRequest({
      session_id: SESSION,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      permission_mode: 'default',
    })
    expect(permRes).toEqual({
      decision: {
        behavior: 'allow',
        updatedPermissions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash' }],
            behavior: 'allow',
            destination: 'session',
          },
        ],
      },
    })
    const permCalls = w.requests.filter(r => r.url.endsWith('/permission'))
    expect(permCalls.length).toBe(2)
    expect(permCalls[0]?.body.tool_name).toBe('Bash')
    expect(permCalls[0]?.body.request_id).toBe(permCalls[1]?.body.request_id)

    // Passthrough status delegates back to Claude Code's native dialog without sending cancel.
    const passRes = await $.classic.PermissionRequest({
      session_id: SESSION,
      tool_name: 'Edit',
      tool_input: { file_path: '/work/a.ts' },
      permission_mode: 'default',
    })
    expect(passRes).toEqual({})
    expect(w.requests.filter(r => r.url.endsWith('/permission') && r.body.cancel === true)).toEqual([])
  })

  test('submits nothing late, empty or a slash command, and tells the node why', async ($, on) => {
    const w = world(on, [{
      status: 200,
      body: {
        messages: [
          { id: 'late', text: 'too late', deadline_ms: 500 },
          { id: 'cmd', text: ' /exit', deadline_ms: 9_000 },
          { id: 'empty', text: '  ', deadline_ms: 9_000 },
          { id: 'odd', text: 42, deadline_ms: 9_000 },
          { id: 'bad id!', text: 'no id', deadline_ms: 9_000 },
        ],
      },
    }])
    await $.session.start(start)
    await w.clock.settle()

    expect(w.submitted).toEqual([])
    expect(w.requests.filter(r => r.url.endsWith('/ack')).map(r => r.body)).toEqual([
      { session_id: SESSION, id: 'late', submitted: false, reason: 'late' },
      { session_id: SESSION, id: 'cmd', submitted: false, reason: 'command' },
      { session_id: SESSION, id: 'empty', submitted: false, reason: 'invalid' },
      { session_id: SESSION, id: 'odd', submitted: false, reason: 'invalid' },
    ])
  })

  test('backs off quietly while no node answers, and polls again once one does', async ($, on) => {
    const w = world(on, [{ fail: true }, { status: 404, body: {} }, { status: 200, body: { messages: [] } }])
    await $.session.start(start)
    await w.clock.settle()
    expect(w.requests.length).toBe(1)
    await w.clock.advance(2_000) // the first backoff: an old node answers 404
    expect(w.requests.length).toBe(2)
    await w.clock.advance(3_999) // the second is twice the first
    expect(w.requests.length).toBe(2)
    await w.clock.advance(1)
    expect(w.requests.length).toBe(4) // answered empty: the next poll goes at once (and finds no node)
    expect(w.submitted).toEqual([])
  })

  test('waits as long as the node asks when it does not serve this session', async ($, on) => {
    const w = world(on, [{ status: 403, body: { error: 'not_this_session', retry_ms: 300_000 } }])
    await $.session.start(start)
    await w.clock.settle()
    await w.clock.advance(299_999)
    expect(w.requests.length).toBe(1)
    await w.clock.advance(1)
    expect(w.requests.length).toBe(2)
  })

  test('finds the node where the node itself looks', async ($, on) => {
    const w = world(on, [], { USERPROFILE: 'C:\\Users\\me', HOME: '/c/Users/me', PERSONA_HOME: 'persona-data' })
    await $.session.start(start)
    await w.clock.settle()
    expect(w.requests[0]?.socketPath).toBe('C:\\Users\\me\\persona-data\\node.sock')
  })
})

describe('protocol helpers', () => {
  test('socket path', () => {
    expect(socketPath('/home/me', undefined)).toBe('/home/me/.persona/node.sock')
    expect(socketPath('/home/me', '~')).toBe('/home/me/node.sock')
    expect(socketPath('/home/me', '~/state')).toBe('/home/me/state/node.sock')
    expect(socketPath('/home/me', '/srv/persona')).toBe('/srv/persona/node.sock')
    expect(socketPath('C:\\Users\\me', undefined)).toBe('C:\\Users\\me\\.persona\\node.sock')
    expect(socketPath('C:\\Users\\me', 'D:\\persona')).toBe('D:\\persona\\node.sock')
    expect(socketPath(undefined, '/srv/persona')).toBe(undefined)
    expect(homeDir('C:\\Users\\me', '/c/Users/me')).toBe('C:\\Users\\me')
    expect(homeDir(undefined, '/Users/me')).toBe('/Users/me')
  })

  test('preview launch config and permission poll helpers', () => {
    const cfg = parsePreviewLaunchConfig(
      JSON.stringify({
        configurations: [
          {
            name: 'my app',
            runtimeExecutable: 'python3',
            runtimeArgs: ['-m', 'http.server', "80'80"],
            port: 8080,
            env: { PORT: 8080 },
          },
        ],
      }),
      'my app',
    )
    expect(cfg).toEqual({
      name: 'my app',
      runtimeExecutable: 'python3',
      runtimeArgs: ['-m', 'http.server', "80'80"],
      port: 8080,
      env: { PORT: '8080' },
    })
    expect(previewTaskDescription('my app')).toBe('Dev server "my app" (preview_start)')
    expect(buildPreviewShellCommand(cfg!, '/repo')).toBe("cd '/repo' && exec env PORT='8080' 'python3' '-m' 'http.server' '80'\\''80'")
    expect(parsePreviewLaunchConfig('{"configurations":[{"name":"bad","runtimeExecutable":"sh","port":70000}]}', 'bad')).toBe(undefined)
    expect(parsePreviewLaunchConfig('{"configurations":[{"name":"bad","runtimeExecutable":"sh","port":3000,"env":{"BAD-KEY":"1"}}]}', 'bad')).toBe(undefined)

    expect(readPermissionPoll(200, '{"status":"pending"}')).toEqual({ kind: 'pending' })
    expect(readPermissionPoll(200, '{"status":"passthrough"}')).toEqual({ kind: 'passthrough' })
    expect(readPermissionPoll(200, '{"status":"decided","decision":{"behavior":"deny","message":"declined on phone","interrupt":true}}')).toEqual({
      kind: 'decided',
      decision: { behavior: 'deny', message: 'declined on phone', interrupt: true },
    })
    expect(
      readPermissionPoll(
        200,
        '{"status":"decided","decision":{"behavior":"allow","updatedInput":{"plan":"ok"},"updatedPermissions":[{"type":"setMode","mode":"bypassPermissions","destination":"session"}]}}',
      ),
    ).toEqual({
      kind: 'decided',
      decision: {
        behavior: 'allow',
        updatedInput: { plan: 'ok' },
        updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
      },
    })
    expect(readPermissionPoll(500, '')).toEqual({ kind: 'passthrough' })
  })

  test('poll answers and override helpers', () => {
    expect(readPoll(200, '{"messages":[{"id":"a","text":"hi","deadline_ms":5}],"settings":{"id":"s1","model":"opus","effort":"high"},"interrupt":{"id":"i1","deadline_ms":9},"retry_ms":10}')).toEqual({
      kind: 'messages',
      messages: [{ id: 'a', text: 'hi', deadlineMs: 5 }],
      settings: { id: 's1', model: 'opus', effort: 'high' },
      interrupt: { id: 'i1', deadlineMs: 9 },
      retryMs: 10,
    })
    expect(readPoll(200, '{"messages":[],"settings":{"id":"s2","model":"-bad"}}')).toEqual({
      kind: 'messages',
      messages: [],
      retryMs: 0,
    })
    const ov = mergeOverride(undefined, SESSION, { id: 's1', model: 'opus', effort: 'auto' }, 'claude-sonnet-5-5')
    expect(applyStepOverride({ model: 'claude-sonnet-5-5', effort: 'medium' }, ov, SESSION, 'claude-sonnet-5-5').step).toEqual({
      model: 'opus',
    })
    expect(readPoll(200, 'not json')).toEqual({ kind: 'unavailable' })
    expect(readPoll(404, '')).toEqual({ kind: 'unavailable' })
    expect(readPoll(403, '{}')).toEqual({ kind: 'refused', retryMs: 60_000 })
    expect(verdict({ id: 'a', text: 'x'.repeat(200_001), deadlineMs: 10 }, 0)).toBe('invalid')
    expect(nextBackoff(0)).toBe(2_000)
    expect(nextBackoff(40_000)).toBe(60_000)
  })
})
