import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { usageAccountFromQuota } from '../lib/usage.js'

describe('antigravity quota usage mapping', () => {
  it('maps RetrieveUserQuotaSummary groups with named 5h and weekly windows', () => {
    const now = new Date('2026-11-26T11:54:00.000Z')
    const native = {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.977, resetTime: '2026-12-03T07:13:55Z' },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.922, resetTime: '2026-11-26T12:13:55Z' },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1 },
              { bucketId: '3p-5h', window: '5h', remainingFraction: 1 },
            ],
          },
        ],
      },
    }
    const account = usageAccountFromQuota(native, now, { plan: 'Pro' })
    assert.deepEqual(account, {
      provider: 'agy',
      name: 'Antigravity',
      plan: 'Pro',
      sampled_at: '2026-11-26T11:54:00.000Z',
      windows: [
        { label: '5h', window_minutes: 300, used_percent: 7.8, resets_at: '2026-11-26T12:13:55.000Z', model: 'Gemini Models' },
        { label: '5h', window_minutes: 300, used_percent: 0, model: 'Claude and GPT models' },
        { label: '7d', window_minutes: 10080, used_percent: 2.3, resets_at: '2026-12-03T07:13:55.000Z', model: 'Gemini Models' },
        { label: '7d', window_minutes: 10080, used_percent: 0, model: 'Claude and GPT models' },
      ],
    })
  })

  it('supports duration windows, bucketId fallback, and drops disabled or expired buckets', () => {
    const now = new Date('2026-11-26T12:00:00.000Z')
    const account = usageAccountFromQuota({
      response: {
        buckets: [
          { bucketId: 'opaque-1', window: '18000s', remainingFraction: 0.75, modelId: 'gemini-pro', resetTime: '2026-11-26T15:00:00Z' },
          { bucketId: 'opaque-2', window: 'daily', remainingFraction: 0.5, modelId: 'daily-model', resetTime: '2026-11-27T00:00:00Z' },
          { bucketId: 'team_weekly', remainingFraction: 0.25, resetTime: '2026-12-01T00:00:00Z' },
          { bucketId: 'expired-5h', window: '5h', remainingFraction: 0.2, resetTime: '2026-11-26T11:00:00Z' },
          { bucketId: 'disabled-5h', window: '5h', remainingFraction: 0.2, disabled: true },
          { bucketId: 'monthly-ignored', window: 'monthly', remainingFraction: 0.2 },
        ],
      },
    }, now)
    assert.deepEqual(account.windows, [
      { label: '5h', window_minutes: 300, used_percent: 25, resets_at: '2026-11-26T15:00:00.000Z', model: 'gemini-pro' },
      { label: '1d', window_minutes: 1440, used_percent: 50, resets_at: '2026-11-27T00:00:00.000Z', model: 'daily-model' },
      { label: '7d', window_minutes: 10080, used_percent: 75, resets_at: '2026-12-01T00:00:00.000Z' },
    ])
  })

  it('rejects malformed native quota containers', () => {
    const now = new Date('2026-11-26T12:00:00.000Z')
    assert.throws(() => usageAccountFromQuota(null, now), TypeError)
    assert.throws(() => usageAccountFromQuota({ response: { groups: 'bad' } }, now), TypeError)
    assert.throws(() => usageAccountFromQuota({ response: { groups: [{ buckets: 'bad' }] } }, now), TypeError)
  })
})
