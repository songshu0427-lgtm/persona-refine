function windowLabel(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function parseWindowMinutes(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/^daily$/, '1d').replace(/^weekly$/, '7d')
  const m = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(s)
  if (!m) return 0
  const factor = { s: 1 / 60, m: 1, h: 60, d: 1440, w: 10080 }[m[2]]
  const minutes = Number(m[1]) * factor
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : 0
}

function bucketWindowMinutes(bucket) {
  const fromWindow = parseWindowMinutes(bucket.window)
  if (fromWindow) return fromWindow
  const id = typeof bucket.bucketId === 'string' ? bucket.bucketId.toLowerCase().replaceAll('_', '-') : ''
  const compact = id.replaceAll('-', '')
  if (compact.includes('fivehour') || id.split('-').includes('5h')) return 300
  if (compact.includes('weekly') || id.split('-').some(part => part === 'week' || part === '7d')) return 10080
  return 0
}

function parseResetTime(raw, now) {
  if (raw === undefined || raw === null || raw === '') return {}
  const parsed = new Date(raw)
  if (!Number.isFinite(parsed.getTime())) return {}
  if (parsed <= now) return null
  return { resets_at: parsed.toISOString() }
}

/**
 * Maps Antigravity's native RetrieveUserQuotaSummary response to Persona's runtime usage.windows payload.
 */
export function usageAccountFromQuota(native, now, { plan } = {}) {
  if (!native || typeof native.response !== 'object' || native.response === null || Array.isArray(native.response) ||
      !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('quota needs a native response and a valid sample time')
  }
  const res = native.response
  if ((res.buckets !== undefined && !Array.isArray(res.buckets)) || (res.groups !== undefined && !Array.isArray(res.groups))) {
    throw new TypeError('quota bucket collections must be arrays')
  }
  const entries = []
  for (const bucket of res.buckets || []) entries.push({ bucket, group: '' })
  for (const grp of res.groups || []) {
    if (grp?.buckets !== undefined && !Array.isArray(grp.buckets)) {
      throw new TypeError('quota group buckets must be an array')
    }
    const group = typeof grp?.displayName === 'string' ? grp.displayName.trim() : ''
    for (const bucket of grp?.buckets || []) entries.push({ bucket, group })
  }
  const byKey = new Map()
  for (const { bucket, group } of entries) {
    if (!bucket || typeof bucket !== 'object' || typeof bucket.remainingFraction !== 'number' ||
        !Number.isFinite(bucket.remainingFraction) || bucket.disabled === true) {
      continue
    }
    const minutes = bucketWindowMinutes(bucket)
    if (!minutes) continue
    const reset = parseResetTime(bucket.resetTime, now)
    if (reset === null) continue
    const model = typeof bucket.modelId === 'string' && bucket.modelId.trim() ? bucket.modelId.trim() : group
    const key = `${minutes}|${model}`
    if (byKey.has(key)) continue
    const used = Math.min(100, Math.max(0, Math.round((1 - bucket.remainingFraction) * 100 * 1e9) / 1e9))
    byKey.set(key, {
      label: windowLabel(minutes),
      window_minutes: minutes,
      used_percent: used,
      ...reset,
      ...(model ? { model } : {}),
    })
  }
  const cleanPlan = typeof plan === 'string' ? plan.trim() : ''
  return {
    provider: 'agy',
    name: 'Antigravity',
    ...(cleanPlan ? { plan: cleanPlan } : {}),
    sampled_at: now.toISOString(),
    windows: [...byKey.values()].sort((a, b) => a.window_minutes - b.window_minutes),
  }
}
