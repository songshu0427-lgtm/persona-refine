import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { RpcError } from '../../runtime-sdk/index.js'
import messages from './desktop-media-locales.js'

// The runtime protocol carries no UI language; use the computer's locale, with English as the fallback.
const language = new Intl.DateTimeFormat().resolvedOptions().locale.split('-')[0]
const words = messages[language === 'zh' ? 'zh-Hans' : language] || messages.en
const maxImage = 8 * 1024 * 1024

export function mediaError(key, code = 'bad_request') {
  return new RpcError(words[key], code)
}

export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}

export function inputMedia(images) {
  if (images == null) return []
  if (!Array.isArray(images)) throw mediaError('invalid')
  if (images.length > 4) throw mediaError('count')
  return images.map(image => {
    const data = image?.data
    const mime = image?.mime || image?.media_type || 'image/png'
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) throw mediaError('type', 'unsupported')
    if (typeof data !== 'string' || !data) throw mediaError('invalid')
    if (data.length > Math.ceil(maxImage / 3) * 4) throw mediaError('large')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw mediaError('invalid')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > maxImage) throw mediaError('large')
    const encoded = bytes.toString('base64')
    if (!bytes.length || (data !== encoded && data !== encoded.replace(/=+$/, '')) || imageMime(bytes) !== mime) {
      throw mediaError('invalid')
    }
    // Media.inline_data is bytes in protobuf, hence base64 in the native JSON RPC. Do not use deprecated images.
    return { mimeType: mime, inlineData: encoded }
  })
}

// Native USER_INPUT exports store paths, not bytes. Never resolve remote URLs or references outside this cascade.
function uploadedPath(media, brainDir) {
  const path = media?.uri
  return typeof path === 'string' && isAbsolute(path) && normalize(path) === path &&
    dirname(path) === join(brainDir, '.user_uploaded') ? path : undefined
}

export function userImage(media, brainDir) {
  if (!uploadedPath(media, brainDir) || typeof media?.mime_type !== 'string' || !media.mime_type.startsWith('image/')) return
  return { mime: media.mime_type, data: '', lazy: true }
}

export async function readUserImage(media, brainDir) {
  const path = uploadedPath(media, brainDir)
  const missing = () => mediaError('missing', 'not_found')
  if (!path) throw missing()
  let file
  try {
    // Reject symlinked cascade/upload directories as well as symlinked files. The configured root may be canonicalized.
    const expectedBrain = join(await realpath(dirname(brainDir)), basename(brainDir))
    if (await realpath(brainDir) !== expectedBrain ||
        await realpath(dirname(path)) !== join(expectedBrain, '.user_uploaded')) throw missing()
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size < 1 || stat.size > maxImage) throw missing()
    const bytes = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size !== stat.size) throw missing()
    const content = bytes.subarray(0, size)
    // Native exports sometimes label JPEG bytes as PNG, even with a .png filename.
    const mime = imageMime(content)
    if (!mime) throw missing()
    return { mime, data: content.toString('base64') }
  } catch {
    throw missing() // Do not expose private file paths or OS errors through the image endpoint.
  } finally {
    await file?.close()
  }
}

export function checkModelMedia(model, media) {
  if (!model) return // Older catalogs can omit capabilities; the native server remains authoritative.
  const supported = model.supportedMimeTypes
  for (const image of media) {
    const explicit = supported?.[image.mimeType] ?? supported?.['image/*']
    if (explicit === false || (supported && Object.keys(supported).length && explicit !== true)) {
      throw mediaError('modelType', 'unsupported')
    }
    if (explicit !== true && model.supportsImages === false) throw mediaError('model', 'unsupported')
  }
}
