import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { startSharedGateway } from './gateway-host.mjs'
import { createComponentServer } from './component-server.mjs'

let client
let component
let gateway
let closing = false
async function close() {
  if (closing) return
  closing = true
  await component?.shutdown()
  await client?.close()
  await gateway?.close()
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await close(); process.exit(0) })
}
try {
  gateway = await startSharedGateway()
  process.env.VIDU_GATEWAY_ORIGIN = gateway.origin
  component = createComponentServer({
    viduKey: process.env.VIDU_API_KEY,
    appId: process.env.ARTC_APP_ID,
    appKey: process.env.ARTC_APP_KEY,
    host: process.env.VIDU_HOST || 'api.vidu.cn',
  })
  component.listen(5182, '127.0.0.1')
  await once(component, 'listening')
  client = await createServer({ configFile: fileURLToPath(new URL('./vite.config.mjs', import.meta.url)) })
  await client.listen()
  console.log(`Vidu digital human: http://127.0.0.1:5181 (Gateway ${gateway.origin})`)
} catch (error) {
  await close()
  console.error(`Vidu example: ${error.message}. Start/configure the Gateway first (npm start from the repository root).`)
  process.exitCode = 1
}
