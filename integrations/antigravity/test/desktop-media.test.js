import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkModelMedia, inputMedia } from '../lib/desktop-media.js'
import messages from '../lib/desktop-media-locales.js'

// Synthetic one-pixel PNG; no user attachments in fixtures.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='

test('desktop media validates and converts both Persona MIME spellings', () => {
  assert.deepEqual(inputMedia(undefined), [])
  assert.deepEqual(inputMedia([]), [])
  for (const image of [{ mime: 'image/png', data: png }, { media_type: 'image/png', data: png }, { data: png.replace(/=+$/, '') }]) {
    assert.deepEqual(inputMedia([image]), [{ mimeType: 'image/png', inlineData: png }])
  }
  assert.equal(inputMedia(Array(4).fill({ data: png })).length, 4)
  for (const images of [{}, 'image', [{}], [null], [{ data: '' }], [{ data: 'not base64' }], [{ data: 'AAAA' }],
    [{ data: png + '=' }], [{ data: 'data:image/png;base64,' + png }], [{ mime: 'image/jpeg', data: png }], Array(5).fill({ data: png })]) {
    assert.throws(() => inputMedia(images), { code: 'bad_request' })
  }
  for (const mime of ['image/svg+xml', 'application/pdf', 'image/heic']) {
    assert.throws(() => inputMedia([{ mime, data: png }]), { code: 'unsupported' })
  }
  // Mixed messages fail as a whole; a bad image must not turn into a text-only send.
  assert.throws(() => inputMedia([{ data: png }, { data: '%' }]), { code: 'bad_request' })
})

test('desktop media enforces the existing per-image size limit before sending', () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024)
  Buffer.from(png, 'base64').copy(bytes)
  assert.equal(inputMedia([{ data: bytes.toString('base64') }]).length, 1)
  assert.throws(() => inputMedia([{ data: Buffer.concat([bytes, Buffer.from([0])]).toString('base64') }]), { code: 'bad_request' })
})

test('desktop media checks the effective model without guessing absent capabilities', () => {
  const media = inputMedia([{ data: png }])
  for (const model of [undefined, {}, { supportsImages: true }, { supportedMimeTypes: { 'image/png': true } },
    { supportsImages: false, supportedMimeTypes: { 'image/png': true } }]) {
    assert.doesNotThrow(() => checkModelMedia(model, media))
  }
  for (const model of [{ supportsImages: false }, { supportsImages: true, supportedMimeTypes: { 'image/png': false } },
    { supportsImages: true, supportedMimeTypes: { 'image/jpeg': true } }]) {
    assert.throws(() => checkModelMedia(model, media), { code: 'unsupported' })
  }
})

test('desktop media errors ship all supported translations', () => {
  for (const lang of ['en', 'zh-Hans', 'ja']) {
    assert.deepEqual(Object.keys(messages[lang]), Object.keys(messages.en))
    assert.ok(Object.values(messages[lang]).every(text => typeof text === 'string' && text.trim()))
  }
})
