import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startFakeNode } from '../../runtime-sdk/testing/fake-node.js'
import { createDesktopRuntime } from '../lib/desktop.js'
import { readUserImage, userImage } from '../lib/desktop-media.js'

const key = '11111111-2222-4333-8444-555555555555'
const session_id = 'desktop-agy-' + key
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
const media = uri => ({ mime_type: 'image/png', uri })

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-images-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const brain = join(dir, 'brain', key)
  const uploads = join(brain, '.user_uploaded')
  const transcript = join(brain, '.system_generated', 'logs', 'transcript.jsonl')
  mkdirSync(uploads, { recursive: true })
  mkdirSync(dirname(transcript), { recursive: true })
  return { dir, brain, uploads, transcript }
}

async function connect(t, dir) {
  const node = await startFakeNode(t)
  const runtime = createDesktopRuntime({ dir, socketPath: node.path, discover: async () => undefined })
  t.after(() => runtime.stop())
  await runtime.start()
  await node.ready
  return { node, runtime }
}

test('desktop images survive runtime reload and stream image-only inputs without RPC or inline history bytes', async t => {
  const f = fixture(t)
  const a = join(f.uploads, 'image.png'), b = join(f.uploads, 'mislabeled.png')
  writeFileSync(a, png)
  writeFileSync(b, jpeg)
  const first = { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: '2026-01-01T00:00:00Z',
    content: 'Look at these', client_msg_id: 'message-one', media: [media(a), media(b), media('https://example.com/not-fetched.png')] }
  writeFileSync(f.transcript, JSON.stringify(first) + '\n')
  const { node, runtime } = await connect(t, f.dir)
  const page = await node.peer.call('session.items', { session_id })
  assert.match(page.history, /user-media-v1/)
  assert.deepEqual(page.items.map(i => i.kind), ['text', 'image', 'image'])
  assert.ok(page.items.every(i => i.seq === 1 && i.client_msg_id === 'message-one'))
  assert.deepEqual(page.items[1].image, { mime: 'image/png', data: '', lazy: true })
  assert.equal(JSON.stringify(page).includes(f.dir), false, 'private native paths never enter the response')
  assert.deepEqual(await node.peer.call('session.image', { session_id, item_id: page.items[1].id }), { mime: 'image/png', data: png.toString('base64') })
  assert.deepEqual(await node.peer.call('session.image', { session_id, item_id: page.items[2].id }), { mime: 'image/jpeg', data: jpeg.toString('base64') })
  await assert.rejects(node.peer.call('session.image', { session_id, item_id: page.items[0].id }), { code: 'not_found' })
  await assert.rejects(node.peer.call('session.image', { session_id: 'agy-' + key, item_id: page.items[1].id }), { code: 'not_found' })
  await node.peer.call('session.watch', { session_id })
  appendFileSync(f.transcript, JSON.stringify({ ...first, step_index: 1, content: '', client_msg_id: 'image-only', media: [media(a)] }) + '\n')
  for (let i = 0; i < 100 && !node.last('session.items'); i++) await delay(25)
  const pushed = node.last('session.items')
  assert.deepEqual(pushed?.items.map(i => i.kind), ['image'])
  assert.equal(pushed.items[0].seq, 2)
  assert.equal(pushed.items[0].client_msg_id, 'image-only')
  assert.equal(pushed.items[0].image.data, '')
  const before = await node.peer.call('session.items', { session_id })
  runtime.stop()
  const cold = await connect(t, f.dir)
  const after = await cold.node.peer.call('session.items', { session_id })
  assert.deepEqual(after, before, 'all image references come from native disk, not send-time memory')
  assert.deepEqual(await cold.node.peer.call('session.image', { session_id, item_id: after.items.at(-1).id }), { mime: 'image/png', data: png.toString('base64') })
  const incremental = await cold.node.peer.call('session.items', { session_id, after_seq: 1 })
  assert.equal(incremental.items.length, 1)
  assert.equal(incremental.items[0].kind, 'image')
})

test('desktop image reads reject traversal, cross-session paths, links, missing and oversized files', async t => {
  const f = fixture(t)
  const inside = join(f.uploads, 'inside.png')
  writeFileSync(inside, png)
  const other = join(f.dir, 'brain', 'other', '.user_uploaded', 'other.png')
  mkdirSync(dirname(other), { recursive: true })
  writeFileSync(other, png)
  const link = join(f.uploads, 'link.png')
  symlinkSync(other, link)
  const alias = join(f.dir, 'brain', 'alias')
  symlinkSync(f.brain, alias)
  await assert.rejects(readUserImage(media(join(alias, '.user_uploaded', 'inside.png')), alias), { code: 'not_found' })
  const empty = join(f.uploads, 'empty.png'), directory = join(f.uploads, 'directory.png')
  writeFileSync(empty, '')
  mkdirSync(directory)
  const invalid = join(f.uploads, 'invalid.png')
  writeFileSync(invalid, 'not an image')
  const large = join(f.uploads, 'large.png')
  writeFileSync(large, png)
  truncateSync(large, 8 * 1024 * 1024 + 1)
  const references = [other, link, invalid, empty, directory, large, join(f.uploads, 'missing.png'), f.uploads,
    f.uploads + '/../.user_uploaded/inside.png', 'file://' + inside, 'https://example.com/image.png', 'relative.png']
  for (const uri of references) {
    await assert.rejects(readUserImage(media(uri), f.brain), err => err.code === 'not_found' && !err.message.includes(f.dir))
  }
  assert.equal(userImage(media(other), f.brain), undefined)
  assert.equal(userImage({ uri: inside, mime_type: 1 }, f.brain), undefined)
  // A symlinked upload directory cannot turn an in-cascade reference into access to another cascade.
  rmSync(f.uploads, { recursive: true })
  symlinkSync(dirname(other), f.uploads)
  await assert.rejects(readUserImage(media(join(f.uploads, 'other.png')), f.brain), { code: 'not_found' })
})
