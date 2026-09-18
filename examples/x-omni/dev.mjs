import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { startXOmni } from './gateway.mjs'

let gateway
let client
let closing = false
async function close() {
  if (closing) return
  closing = true
  await client?.close()
  await gateway?.close()
}
try {
  gateway = await startXOmni()
  client = await createServer({ configFile: fileURLToPath(new URL('./vite.config.mjs', import.meta.url)) })
  await client.listen()
  console.log('X-Omni: http://127.0.0.1:5178 (isolated Gateway :18890)')
} catch (error) { await close(); console.error(error.message); process.exitCode = 1 }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await close(); process.exit(0) })
