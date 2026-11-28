import { MCP_SERVER_NAMES, SNAPSHOT_RE, SNAPSHOT_END_RE } from '../../runtime-sdk/lib/compat.js'
// Mapping between Antigravity CLI (agy) transcripts / ACP updates and Persona runtime items.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { appToolName, clipInput, light, snippet } from '../../runtime-sdk/index.js'

export const RUNTIME = 'agy'
export const LABEL = 'Antigravity'
export const PREFIX = 'agy-'

// Kept off native JSON: an appended replacement branch is a new logical step even when its timestamp repeats.
const STEP_IDENTITY = Symbol('persona.agy.stepIdentity')
const IMMUTABLE_STEPS = Symbol('persona.agy.immutableSteps')
const weakItemsCache = new WeakMap()

function stepIdentity(step, branch = '') {
  const birth = typeof step.created_at === 'string' ? step.created_at : ''
  return birth || branch ? createHash('sha256').update(birth).update('\n').update(branch).digest('hex').slice(0, 20) : ''
}

const OWN_TOOLS = {
  run_command: 'Bash',
  view_file: 'Read',
  read_file: 'Read',
  write_to_file: 'Write',
  write_file: 'Write',
  replace_file_content: 'Edit',
  edit_file: 'Edit',
  grep_search: 'Grep',
  find_by_name: 'Glob',
  search_web: 'WebSearch',
  read_url_content: 'WebFetch',
  ask_question: 'AskUserQuestion',
  invoke_subagent: 'Agent',
}

export function toPersonaId(rawId) {
  const s = String(rawId ?? '').trim()
  if (!s) return ''
  return s.startsWith(PREFIX) ? s : `${PREFIX}${s}`
}

export function toAgyId(personaId) {
  const s = String(personaId ?? '').trim()
  return s.startsWith(PREFIX) ? s.slice(PREFIX.length) : s
}

const USER_REQ_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/

export function cleanUserText(raw) {
  if (typeof raw !== 'string') return ''
  const m = USER_REQ_RE.exec(raw)
  let body = m ? m[1] : raw
  let prev
  do {
    prev = body
    body = body.replace(SNAPSHOT_RE, '').replace(SNAPSHOT_END_RE, '')
  } while (body !== prev)
  return body.trim()
}

const PERSONA_MCP_TOOL_RE = new RegExp(`^mcp_(?:${MCP_SERVER_NAMES.join('|')})(?:_[0-9a-fA-F]{8,16})?_([a-z][a-z0-9_]*)$`)
const BARE_TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/

export function mapToolName(name) {
  if (typeof name === 'string') {
    const m = PERSONA_MCP_TOOL_RE.exec(name)
    if (m) return `mcp__persona__${m[1]}`
  }
  return appToolName(name, OWN_TOOLS)
}

export function mapToolCall(name, args) {
  const rawName = name || 'tool'
  const mapped = mapToolName(rawName)
  if (mapped === 'mcp__persona__persona_call' && args && typeof args === 'object' && !Array.isArray(args)) {
    const target = typeof args.name === 'string' ? args.name.trim() : ''
    if (BARE_TOOL_NAME_RE.test(target)) {
      const inner = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments : {}
      return { toolName: `mcp__persona__${target}`, toolInput: clipInput(inner) }
    }
  }
  return { toolName: mapped, toolInput: mapToolInput(rawName, args) }
}

export function mapToolInput(name, args) {
  if (!args || typeof args !== 'object') return {}
  switch (name) {
    case 'run_command':
      return clipInput({
        command: args.CommandLine ?? args.command ?? '',
        description: args.toolSummary ?? args.Cwd ?? '',
      })
    case 'view_file':
    case 'read_file':
      return clipInput({
        file_path: args.AbsolutePath ?? args.Path ?? args.file_path ?? '',
      })
    case 'write_to_file':
    case 'write_file':
      return clipInput({
        file_path: args.TargetFile ?? args.Path ?? args.file_path ?? '',
        content: args.CodeContent ?? args.Content ?? args.content ?? '',
      })
    case 'replace_file_content':
    case 'edit_file':
      return clipInput({
        file_path: args.TargetFile ?? args.Path ?? args.file_path ?? '',
        old_string: args.TargetContent ?? args.Target ?? args.old_string ?? '',
        new_string: args.ReplacementContent ?? args.Replacement ?? args.new_string ?? '',
      })
    case 'grep_search':
      return clipInput({
        pattern: args.Query ?? args.Pattern ?? args.pattern ?? '',
        path: args.SearchPath ?? args.Path ?? args.path ?? '',
      })
    case 'find_by_name':
      return clipInput({
        pattern: args.Pattern ?? args.pattern ?? '',
        path: args.SearchDirectory ?? args.Path ?? args.path ?? '',
      })
    case 'search_web':
      return clipInput({
        query: args.query ?? args.Query ?? '',
      })
    case 'read_url_content':
      return clipInput({
        url: args.Url ?? args.url ?? '',
      })
    case 'invoke_subagent':
      return clipInput({
        description: args.toolSummary ?? 'subagent',
        prompt: typeof args.Subagents === 'string' ? args.Subagents : JSON.stringify(args.Subagents ?? ''),
      })
    default:
      return clipInput(args)
  }
}

export function cleanGenericOutput(content) {
  if (typeof content !== 'string') return ''
  // Strip run_command metadata header if followed by Output:
  const outIdx = content.indexOf('\nOutput:\n')
  if (outIdx >= 0 && content.startsWith('Created At:')) {
    return content.slice(outIdx + '\nOutput:\n'.length)
  }
  return content
}

/**
 * Parse a transcript.jsonl file (or array of parsed step objects) into Persona items.
 * @param {object[]} steps
 * @param {{ brainDir?: string, full?: boolean, skipCache?: boolean, clientMsgKey?: string, userImageKey?: string, clientMsgIdFor?: (idx: number, text: string, ordinal: number) => string | undefined, userImage?: (media: object) => object | undefined }} [opts]
 */
export function stepsToItems(steps, opts = {}) {
  const canWeakCache = !opts.skipCache && Boolean(steps?.[IMMUTABLE_STEPS]) &&
    (!opts.clientMsgIdFor || typeof opts.clientMsgKey === 'string') &&
    (!opts.userImage || typeof opts.userImageKey === 'string')
  const weakOptKey = canWeakCache
    ? `${opts.full ? 1 : 0}:${opts.brainDir || ''}:${opts.clientMsgKey || ''}:${opts.userImageKey || ''}`
    : ''
  if (canWeakCache) {
    const hit = weakItemsCache.get(steps)?.get(weakOptKey)
    if (hit) return hit
  }

  const items = []
  const pendingCalls = []
  let maxSeq = 0
  let lastText = ''
  let turnError
  let afterWork = false
  let userOrdinal = 0

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (!step || typeof step !== 'object') continue
    const idx = typeof step.step_index === 'number' ? step.step_index : i
    const seq = idx + 1
    if (seq > maxSeq) maxSeq = seq
    const ts = step.created_at || new Date().toISOString()
    const identity = step[STEP_IDENTITY] ?? stepIdentity(step)
    const line = identity ? `${seq}@${identity}` : String(seq)

    switch (step.type) {
      case 'USER_INPUT': {
        if (step.source && step.source !== 'USER_EXPLICIT') break
        // A new prompt answers the previous reply. Only assistant words can ask the user for a response.
        lastText = ''
        turnError = undefined
        afterWork = false
        userOrdinal++
        const text = cleanUserText(step.content)
        const msgId = (typeof step.client_msg_id === 'string' && step.client_msg_id) || opts.clientMsgIdFor?.(idx, text, userOrdinal)
        const common = { seq, role: 'user', ts, ...(msgId ? { client_msg_id: msgId } : {}) }
        if (text) {
          const item = { ...common, id: `${line}#0`, kind: 'text', text }
          items.push(opts.full ? item : light(item))
        }
        // Only runtimes with a matching session.image reader opt into lazy user attachments.
        for (const [i, media] of (Array.isArray(step.media) ? step.media : []).entries()) {
          const image = opts.userImage?.(media)
          if (image) items.push({ ...common, id: `${line}#${i + 1}`, kind: 'image', image })
        }
        break
      }
      case 'CHECKPOINT': {
        items.push({ id: `${line}#0`, seq, role: 'system', kind: 'notice', text: '上下文已压缩', ts })
        break
      }
      case 'PLANNER_RESPONSE': {
        turnError = undefined
        let sub = 0
        if (typeof step.thinking === 'string' && step.thinking.trim()) {
          const item = { id: `${line}#${sub++}`, seq, role: 'assistant', kind: 'thinking', text: step.thinking.trim(), ts }
          items.push(opts.full ? item : light(item))
        }
        if (typeof step.content === 'string' && step.content.trim()) {
          const text = step.content.trim()
          lastText = snippet(text)
          afterWork = true
          const item = { id: `${line}#${sub++}`, seq, role: 'assistant', kind: 'text', text, ts }
          items.push(opts.full ? item : light(item))
        }
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : []
        if (calls.length) afterWork = true
        for (let k = 0; k < calls.length; k++) {
          const tc = calls[k]
          if (!tc || typeof tc !== 'object') continue
          const callId = `call_${line}_${k}`
          const { toolName, toolInput } = mapToolCall(tc.name || 'tool', tc.args)
          pendingCalls.push({ callId, idx })
          const item = {
            id: `${line}#${sub++}`,
            seq,
            role: 'assistant',
            kind: 'tool_use',
            tool_name: toolName,
            tool_input: toolInput,
            tool_use_id: callId,
            ts,
          }
          items.push(opts.full ? item : light(item))
        }
        break
      }
      case 'GENERIC': {
        afterWork = true
        const paired = pendingCalls.shift()
        const callId = paired ? paired.callId : `call_${line}_0`
        let rawOut = step.error || step.content || ''
        if (opts.full && opts.brainDir && Array.isArray(step.truncated_fields) && step.truncated_fields.includes('content')) {
          const outFile = join(opts.brainDir, '.system_generated', 'steps', String(idx), 'output.txt')
          if (existsSync(outFile)) {
            try {
              rawOut = readFileSync(outFile, 'utf8')
            } catch {}
          }
        }
        const text = step.error ? String(step.error) : cleanGenericOutput(rawOut)
        const isError = Boolean(step.error) || step.status === 'ERROR'
        const resItem = {
          id: `${line}#0`,
          seq,
          role: 'user',
          kind: 'tool_result',
          tool_use_id: callId,
          text,
          is_error: isError,
          ts,
        }
        items.push(opts.full ? resItem : light(resItem))
        // No session.image handler can resolve step.media. Read/view_file images use ViewedImages instead.
        break
      }
      case 'ERROR_MESSAGE': {
        const text = step.error || step.content || 'Error'
        turnError = { turn_error: String(text), ...step.turn_error, turn_error_after_work: afterWork }
        // Clients display this shared API-error format outside the collapsed work summary.
        const message = String(text).startsWith('API Error:') ? String(text) : `API Error: ${text}`
        items.push({ id: `${line}#0`, seq, role: 'assistant', kind: 'text', text: message, ts })
        break
      }
      default:
        break
    }
  }

  const result = { items, toSeq: maxSeq, lastText, turnError }
  if (canWeakCache) {
    let byOpt = weakItemsCache.get(steps)
    if (!byOpt) {
      byOpt = new Map()
      weakItemsCache.set(steps, byOpt)
    }
    byOpt.set(weakOptKey, result)
  }
  return result
}

const transcriptCache = new Map()
const transcriptRevisions = new Map()
const MAX_CACHED_TRANSCRIPTS = 128
const MAX_TRANSCRIPT_REVISIONS = 256
const MAX_TRANSCRIPT_CACHE_BYTES = 64 * 1024 * 1024
let transcriptCacheBytes = 0

function readRange(fd, offset, length) {
  if (length <= 0) return Buffer.alloc(0)
  const buf = Buffer.allocUnsafe(length)
  let done = 0
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, offset + done)
    if (n <= 0) return buf.subarray(0, done)
    done += n
  }
  return buf
}

function hashPrefix(fd, size) {
  const hasher = createHash('sha256')
  const chunk = Buffer.allocUnsafe(Math.min(Math.max(size, 1), 65536))
  let pos = 0
  while (pos < size) {
    const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos)
    if (n <= 0) break
    hasher.update(n === chunk.length ? chunk : chunk.subarray(0, n))
    pos += n
  }
  return { hasher, hash: hasher.copy().digest('hex'), bytesRead: pos }
}

function applyTranscriptText(text, out, state) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const step = JSON.parse(trimmed)
      const previous = out.at(-1)
      const index = step?.step_index
      if (Number.isInteger(index) && Number.isInteger(previous?.step_index) && index <= previous.step_index) {
        // Native exports append replacement steps after a rewind. A status update keeps the step's identity.
        if (index < previous.step_index || step.type !== previous.type || step.created_at !== previous.created_at) {
          state.branch = createHash('sha256').update(state.branch).update('\n').update(trimmed).digest('hex').slice(0, 20)
          state.revision = ''
        } else if (JSON.stringify(previous) !== JSON.stringify(step)) {
          // A planner step can gain its completed response while keeping its index and branch.
          state.revision = createHash('sha256').update(JSON.stringify(step)).digest('hex').slice(0, 20)
        }
        while (out.length && out.at(-1).step_index >= index) out.pop()
      }
      // Compute once with the parsed record, rather than rehashing every step on each session-list pass.
      if (step && typeof step === 'object') Object.defineProperty(step, STEP_IDENTITY, { value: stepIdentity(step, state.branch) })
      out.push(step)
    } catch {}
  }
}

function parseTranscriptBuffer(buf, baseSteps, baseBranch, baseNativeRevision) {
  const lastNl = buf.lastIndexOf(10)
  const completeLen = lastNl >= 0 ? lastNl + 1 : 0
  const committedSteps = baseSteps ? baseSteps.slice() : []
  const committedState = { branch: baseBranch || '', revision: baseNativeRevision || '' }
  if (completeLen > 0) applyTranscriptText(buf.subarray(0, completeLen).toString('utf8'), committedSteps, committedState)
  let out = committedSteps
  let state = committedState
  if (completeLen < buf.length) {
    out = committedSteps.slice()
    state = { ...committedState }
    applyTranscriptText(buf.subarray(completeLen).toString('utf8'), out, state)
  }
  Object.defineProperty(out, IMMUTABLE_STEPS, { value: true })
  return {
    out,
    branch: state.branch,
    nativeRevision: state.revision,
    committedSteps,
    committedBranch: committedState.branch,
    committedNativeRevision: committedState.revision,
    completeLen,
  }
}

function storeTranscriptCache(target, entry) {
  const existing = transcriptCache.get(target)
  if (existing) {
    transcriptCache.delete(target)
    transcriptCacheBytes -= existing.size
  }
  if (entry.size > MAX_TRANSCRIPT_CACHE_BYTES) return
  while (transcriptCache.size >= MAX_CACHED_TRANSCRIPTS || transcriptCacheBytes + entry.size > MAX_TRANSCRIPT_CACHE_BYTES) {
    const oldest = transcriptCache.keys().next().value
    transcriptCacheBytes -= transcriptCache.get(oldest).size
    transcriptCache.delete(oldest)
  }
  transcriptCache.set(target, entry)
  transcriptCacheBytes += entry.size
}

export function readTranscriptSteps(brainDir, full = false) {
  return readTranscript(brainDir, full).steps
}

export function readTranscript(brainDir, full = false) {
  const file = join(brainDir, '.system_generated', 'logs', full ? 'transcript_full.jsonl' : 'transcript.jsonl')
  const fallback = full ? join(brainDir, '.system_generated', 'logs', 'transcript.jsonl') : null
  const target = existsSync(file) ? file : fallback && existsSync(fallback) ? fallback : null
  if (!target) return { steps: [], branch: '', revision: '', compact: false }
  const compact = Boolean(full && target !== file)
  try {
    const info = statSync(target, { bigint: true })
    const size = Number(info.size)
    const fileMeta = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
    // Fast same-size native rewrites can share a filesystem timestamp tick.
    const settled = Math.max(Number(info.mtimeMs), Number(info.ctimeMs)) <= Date.now() - 1000
    const remembered = transcriptRevisions.get(target)
    if (remembered) {
      transcriptRevisions.delete(target)
      transcriptRevisions.set(target, remembered)
    }
    const cached = transcriptCache.get(target)
    const returnCached = (entry) => {
      transcriptCache.delete(target)
      transcriptCache.set(target, entry)
      return entry.transcript.compact === compact ? entry.transcript : { ...entry.transcript, compact }
    }
    if (cached && settled && cached.fileMeta === fileMeta) return returnCached(cached)
    if (cached && cached.dev === info.dev && cached.ino === info.ino && cached.byteLength === size) {
      let fd
      try {
        fd = openSync(target, 'r')
        const { hash: hash2, bytesRead } = hashPrefix(fd, size)
        if (bytesRead === size && hash2 === cached.hash) {
          cached.fileMeta = fileMeta
          return returnCached(cached)
        }
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    }
    if (cached && cached.dev === info.dev && cached.ino === info.ino && size > cached.byteLength) {
      let fd
      try {
        fd = openSync(target, 'r')
        const { hasher, hash: prefixHash, bytesRead } = hashPrefix(fd, cached.byteLength)
        if (bytesRead === cached.byteLength && prefixHash === cached.hash) {
          const deltaLen = size - cached.parsedOffset
          const deltaBuf = readRange(fd, cached.parsedOffset, deltaLen)
          if (deltaBuf.length === deltaLen) {
            const newBytes = deltaBuf.subarray(cached.byteLength - cached.parsedOffset)
            const hash2 = hasher.update(newBytes).digest('hex')
            const parsed2 = parseTranscriptBuffer(deltaBuf, cached.committedSteps, cached.committedBranch, cached.committedNativeRevision)
            let revision2 = parsed2.nativeRevision
            if (remembered && remembered.branch === parsed2.branch && parsed2.nativeRevision === remembered.nativeRevision) {
              revision2 = remembered.revision
            }
            transcriptRevisions.set(target, { byteLength: size, hash: hash2, branch: parsed2.branch, nativeRevision: parsed2.nativeRevision, revision: revision2 })
            while (transcriptRevisions.size > MAX_TRANSCRIPT_REVISIONS) transcriptRevisions.delete(transcriptRevisions.keys().next().value)
            const transcript2 = { steps: parsed2.out, branch: parsed2.branch, revision: revision2, compact }
            storeTranscriptCache(target, {
              dev: info.dev, ino: info.ino, fileMeta, byteLength: size,
              parsedOffset: cached.parsedOffset + parsed2.completeLen, size, hash: hash2,
              branch: parsed2.branch, committedSteps: parsed2.committedSteps,
              committedBranch: parsed2.committedBranch, committedNativeRevision: parsed2.committedNativeRevision,
              transcript: transcript2,
            })
            return transcript2
          }
        }
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
    }
    const buf = readFileSync(target)
    const parsed = parseTranscriptBuffer(buf)
    const hash = createHash('sha256').update(buf).digest('hex')
    let revision = parsed.nativeRevision
    if (remembered && remembered.branch === parsed.branch) {
      const appended = buf.length >= remembered.byteLength &&
        createHash('sha256').update(buf.subarray(0, remembered.byteLength)).digest('hex') === remembered.hash
      if (!appended) revision = hash.slice(0, 20)
      else if (parsed.nativeRevision === remembered.nativeRevision) revision = remembered.revision
    }
    transcriptRevisions.set(target, { byteLength: buf.length, hash, branch: parsed.branch, nativeRevision: parsed.nativeRevision, revision })
    while (transcriptRevisions.size > MAX_TRANSCRIPT_REVISIONS) transcriptRevisions.delete(transcriptRevisions.keys().next().value)
    const transcript = { steps: parsed.out, branch: parsed.branch, revision, compact }
    if (buf.length === size) {
      storeTranscriptCache(target, {
        dev: info.dev, ino: info.ino, fileMeta, byteLength: buf.length,
        parsedOffset: parsed.completeLen, size: buf.length, hash,
        branch: parsed.branch, committedSteps: parsed.committedSteps,
        committedBranch: parsed.committedBranch, committedNativeRevision: parsed.committedNativeRevision,
        transcript,
      })
    } else if (cached) {
      transcriptCache.delete(target)
      transcriptCacheBytes -= cached.size
    }
    return transcript
  } catch {
    return full ? { ...readTranscript(brainDir, false), compact: true } : { steps: [], branch: '', revision: '', compact: false }
  }
}

export function nativeWorking(summary) {
  return !summary?.killed && (summary?.status === 'CASCADE_RUN_STATUS_RUNNING' || Boolean(summary?.not_fully_idle))
}

/** Working requires live execution evidence. A completed planner message can be progress narration. */
export function transcriptStatus(steps, summary) {
  if (summary?.killed) return 'idle'
  if (nativeWorking(summary)) return 'working'
  const last = steps.findLast((step) => ['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'ERROR_MESSAGE'].includes(step?.type))
  if (!last) return 'unknown'
  if (last.type === 'ERROR_MESSAGE' || ['ERROR', 'CANCELLED', 'CANCELED'].includes(last.status)) return 'idle'
  // A summary from before a newly exported step cannot close that newer work.
  const idle = summary?.status === 'CASCADE_RUN_STATUS_IDLE' && Number.isInteger(last.step_index) && summary.step_count > last.step_index
  const reply = last.type === 'PLANNER_RESPONSE' && last.status === 'DONE' && typeof last.content === 'string' && last.content.trim() && !last.tool_calls?.length
  if (idle) return reply ? 'done' : 'idle'
  return 'unknown'
}

export function workspacePathOf(summary, fallbackCwd = '', skip = null) {
  if (Array.isArray(summary?.WorkspaceURIs) && summary.WorkspaceURIs.length > 0) {
    for (const raw of summary.WorkspaceURIs) {
      const u = String(raw)
      let p = u
      if (u.startsWith('file://')) {
        try {
          p = decodeURIComponent(new URL(u).pathname)
        } catch {
          p = u.slice('file://'.length)
        }
      }
      if (skip && skip(p)) continue
      return p
    }
  }
  return fallbackCwd
}

export function personaModeToAgy(mode) {
  switch (mode) {
    case 'plan':
      return 'plan'
    case 'acceptEdits':
      return 'accept-edits'
    case 'auto':
      return 'auto'
    case 'bypassPermissions':
      return 'accept-edits'
    case 'default':
    default:
      return 'default'
  }
}

export function agyModeToPersona(mode) {
  switch (mode) {
    case 'auto':
      return 'auto'
    case 'plan':
      return 'plan'
    case 'accept-edits':
      return 'acceptEdits'
    default:
      return 'default'
  }
}
