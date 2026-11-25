import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const SYS_SENDER_RE = /\[Message\][^\n]*\bsender=([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b[^\n]*\bcontent=([\s\S]*)/i
const CREATED_ID_RE = /Created the following subagent:\s*\{[\s\S]*?"conversationId"\s*:\s*"([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})"/i
const MANAGED_SUB_RE = /"role"\s*:\s*"((?:[^"\\]|\\.)*)"[^}]*?"conversationId"\s*:\s*"([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})"/gi
const FIRST_LINE_BYTES = 16 * 1024
const MAX_MSG_BYTES = 256 * 1024
const PROMPT_KEY_LEN = 80
const TITLE_MAX = 60

function validParent(candidate, selfKey) {
  if (typeof candidate !== 'string') return ''
  const s = candidate.trim()
  return UUID_RE.test(s) && s.toLowerCase() !== selfKey.toLowerCase() ? s : ''
}

function unquoteArg(v) {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed = JSON.parse(s)
      if (typeof parsed === 'string') return parsed.trim()
    } catch {}
  }
  return s
}

function normalizePromptKey(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, PROMPT_KEY_LEN)
}

function firstPromptTitle(prompt) {
  const cleaned = String(prompt ?? '').replace(/<\/SYSTEM_MESSAGE>\s*$/i, '').trim()
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim()
    if (!line) continue
    return line.length > TITLE_MAX ? line.slice(0, TITLE_MAX - 1).trimEnd() + '…' : line
  }
  return ''
}

function readFirstLine(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.allocUnsafe(FIRST_LINE_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n <= 0) return ''
    const text = buf.subarray(0, n).toString('utf8')
    const nl = text.indexOf('\n')
    return (nl >= 0 ? text.slice(0, nl) : text).trim()
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }
}

function readParentFromMessages(brainDir, key) {
  const msgDir = join(brainDir, '.system_generated', 'messages')
  let entries
  try {
    entries = readdirSync(msgDir)
  } catch {
    return null
  }
  let best = null
  for (const name of entries) {
    if (!name.endsWith('.json') || name === 'read.json') continue
    const file = join(msgDir, name)
    try {
      const st = statSync(file)
      if (!st.isFile() || st.size > MAX_MSG_BYTES) continue
      const msg = JSON.parse(readFileSync(file, 'utf8'))
      const sender = validParent(msg?.sender, key)
      if (!sender) continue
      const title = msg?.renderDetails?.messageTitle
      if (title !== 'Message from Parent Agent') continue
      const ts = Date.parse(msg?.timestamp) || st.mtimeMs || 0
      if (!best || ts < best.ts) {
        best = { parentKey: sender, prompt: typeof msg.content === 'string' ? msg.content : '', ts }
      }
    } catch {}
  }
  return best ? { parentKey: best.parentKey, prompt: best.prompt } : null
}

function readParentFromTranscript(brainDir, key) {
  const file = join(brainDir, '.system_generated', 'logs', 'transcript.jsonl')
  const line = readFirstLine(file)
  if (!line) return { parentKey: '', prompt: '', settled: false }
  try {
    const step = JSON.parse(line)
    if (step?.type === 'USER_INPUT') return { parentKey: '', prompt: '', settled: true }
    if (step?.type === 'SYSTEM_MESSAGE' && typeof step.content === 'string') {
      const m = SYS_SENDER_RE.exec(step.content)
      const sender = m ? validParent(m[1], key) : ''
      if (sender) {
        const prompt = m[2].replace(/<\/SYSTEM_MESSAGE>\s*$/i, '').trim()
        return { parentKey: sender, prompt, settled: true }
      }
    }
    return { parentKey: '', prompt: '', settled: false }
  } catch {
    return { parentKey: '', prompt: '', settled: false }
  }
}

function inspectChild(dir, key, summary, cache) {
  const nativeParent = validParent(summary?.parentCascadeId || summary?.parentConversationId, key)
  const cached = cache.get(key)
  if (cached?.settled) {
    if (!cached.parentKey && nativeParent) return { parentKey: nativeParent, prompt: '', settled: true }
    return cached
  }
  const brainDir = join(dir, 'brain', key)
  const fromMsg = readParentFromMessages(brainDir, key)
  if (fromMsg) {
    const res = { ...fromMsg, settled: true }
    cache.set(key, res)
    return res
  }
  const fromLog = readParentFromTranscript(brainDir, key)
  if (fromLog.parentKey || fromLog.settled) {
    const res = fromLog.parentKey ? fromLog : { parentKey: nativeParent, prompt: '', settled: true }
    cache.set(key, res)
    return res
  }
  if (nativeParent) {
    const res = { parentKey: nativeParent, prompt: '', settled: true }
    cache.set(key, res)
    return res
  }
  return { parentKey: '', prompt: '', settled: false }
}

function readParentSubagentRoles(dir, parentKey, cache) {
  const file = join(dir, 'brain', parentKey, '.system_generated', 'logs', 'transcript.jsonl')
  let st
  try {
    st = statSync(file)
  } catch {
    return null
  }
  const version = `${st.size}:${st.mtimeMs}`
  const cached = cache.get(parentKey)
  if (cached && cached.version === version) return cached.roles

  const byManagedId = new Map()
  const byCallOrder = new Map()
  const byPrompt = new Map()
  const pendingRoles = []
  try {
    const raw = readFileSync(file, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line || (!line.includes('invoke_subagent') && !line.includes('Created the following subagent') && !line.includes('"conversationId"'))) {
        continue
      }
      let step
      try {
        step = JSON.parse(line)
      } catch {
        continue
      }
      if (step?.type === 'PLANNER_RESPONSE' && Array.isArray(step.tool_calls)) {
        for (const tc of step.tool_calls) {
          if (tc?.name !== 'invoke_subagent') continue
          const role = unquoteArg(tc.args?.Role ?? tc.args?.role)
          const promptKey = normalizePromptKey(unquoteArg(tc.args?.Prompt ?? tc.args?.prompt))
          pendingRoles.push(role)
          if (role && promptKey) byPrompt.set(promptKey, role)
        }
      } else if (step?.type === 'GENERIC' && typeof step.content === 'string') {
        const created = CREATED_ID_RE.exec(step.content)
        if (created) {
          const role = pendingRoles.shift() || ''
          if (role) byCallOrder.set(created[1].toLowerCase(), role)
          continue
        }
        if (step.content.includes('"role"') && step.content.includes('"conversationId"')) {
          MANAGED_SUB_RE.lastIndex = 0
          let m
          while ((m = MANAGED_SUB_RE.exec(step.content)) !== null) {
            const role = unquoteArg(`"${m[1]}"`)
            if (role) byManagedId.set(m[2].toLowerCase(), role)
          }
        }
      }
    }
  } catch {
    return null
  }
  const roles = { byManagedId, byPrompt, byCallOrder }
  cache.set(parentKey, { version, roles })
  return roles
}

function resolveSubagentTitle(key, info, dir, parentRolesCache) {
  const roles = readParentSubagentRoles(dir, info.parentKey, parentRolesCache)
  if (roles) {
    const id = key.toLowerCase()
    const managed = roles.byManagedId.get(id)
    if (managed) return managed
    const pKey = normalizePromptKey(info.prompt)
    if (pKey) {
      const matched = roles.byPrompt.get(pKey)
      if (matched) return matched
    }
    const ordered = roles.byCallOrder.get(id)
    if (ordered) return ordered
  }
  return firstPromptTitle(info.prompt)
}

export function createSubagentCaches() {
  return { children: new Map(), parentRoles: new Map() }
}

/**
 * Enrich Antigravity Desktop session rows with subagent parent/root links, resolved role titles,
 * ancestor pinning (so active parents are never dropped by recent() limits), and parent background tasks.
 */
export function selectDesktopSessions({ dir, prefix, label, allSummaries, rows, recent, caches }) {
  const rowByKey = new Map()
  for (const row of rows) {
    const key = row.session_id.slice(prefix.length)
    rowByKey.set(key, row)
    const created = allSummaries[key]?.createdTime
    if (created) row.started_at = created
  }
  for (const key of caches.children.keys()) {
    if (!rowByKey.has(key)) caches.children.delete(key)
  }
  for (const key of caches.parentRoles.keys()) {
    if (!rowByKey.has(key)) caches.parentRoles.delete(key)
  }

  const childMeta = new Map()
  for (const [key] of rowByKey) {
    const info = inspectChild(dir, key, allSummaries[key], caches.children)
    if (info.parentKey) childMeta.set(key, info)
  }

  const rootKeyOf = key => {
    const seen = new Set([key])
    let cur = childMeta.get(key)?.parentKey || ''
    while (cur && childMeta.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      cur = childMeta.get(cur).parentKey
    }
    return seen.has(cur) ? '' : cur
  }

  for (const [key, info] of childMeta) {
    const row = rowByKey.get(key)
    const rootKey = rootKeyOf(key)
    if (!row || !rootKey) continue
    row.is_subagent = true
    row.parent_session_id = prefix + info.parentKey
    row.root_session_id = prefix + rootKey
    const anchor = rowByKey.get(info.parentKey) || rowByKey.get(rootKey)
    if (!row.cwd && anchor?.cwd) {
      row.cwd = anchor.cwd
      row.space_id = anchor.space_id
      row.space_name = anchor.space_name || basename(anchor.cwd)
    }
    if (!allSummaries[key]?.summary) {
      const resolved = resolveSubagentTitle(key, info, dir, caches.parentRoles)
      if (resolved) row.title = resolved
      else row.title = label
    }
  }

  const pinnedIds = new Set()
  for (const row of rows) {
    if (row.status !== 'working') continue
    pinnedIds.add(row.session_id)
    let cur = row.parent_session_id ? row.parent_session_id.slice(prefix.length) : ''
    const seen = new Set([row.session_id.slice(prefix.length)])
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const parentRow = rowByKey.get(cur)
      if (!parentRow) break
      pinnedIds.add(parentRow.session_id)
      cur = parentRow.parent_session_id ? parentRow.parent_session_id.slice(prefix.length) : ''
    }
  }

  const kept = recent(rows, { days: 14, max: 80, pinned: row => pinnedIds.has(row.session_id) })
  const keptById = new Map(kept.map(r => [r.session_id, r]))

  // Ensure every kept subagent's listed ancestors stay present so the Hub can fold them cleanly.
  for (const row of [...kept]) {
    let cur = row.parent_session_id ? row.parent_session_id.slice(prefix.length) : ''
    const seen = new Set([row.session_id.slice(prefix.length)])
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const parentRow = rowByKey.get(cur)
      if (!parentRow) break
      if (!keptById.has(parentRow.session_id)) {
        kept.push(parentRow)
        keptById.set(parentRow.session_id, parentRow)
      }
      cur = parentRow.parent_session_id ? parentRow.parent_session_id.slice(prefix.length) : ''
    }
  }

  for (const row of kept) {
    if (!row.is_subagent || row.status !== 'working' || !row.parent_session_id) continue
    const parentRow = keptById.get(row.parent_session_id)
    if (!parentRow) continue
    if (!parentRow.background) parentRow.background = []
    parentRow.background.push({
      id: row.session_id.slice(prefix.length),
      kind: 'agent',
      description: row.title,
      ...(row.started_at ? { started_at: row.started_at } : {}),
    })
  }

  return kept
}
