#!/usr/bin/env node
// A bridge to the already-running desktop app; stopping this process never stops the app or its turns.
import { parseArgs } from 'node:util'
import { createDesktopRuntime } from './lib/desktop.js'

const { values } = parseArgs({ options: {
  socket: { type: 'string' },
  'desktop-dir': { type: 'string' },
  'parent-stdin': { type: 'boolean' },
} })
const runtime = createDesktopRuntime({ dir: values['desktop-dir'], socketPath: values.socket, log: console.error })
await runtime.start()
const keepAlive = setInterval(() => {}, 1 << 30)
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  clearInterval(keepAlive)
  runtime.stop()
  process.exit(0)
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop)
if (values['parent-stdin'] && !process.stdin.isTTY) {
  process.stdin.on('end', stop)
  process.stdin.on('error', stop)
  process.stdin.resume()
}
