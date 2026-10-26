import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startExampleServer } from '../server/server.mjs'

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('Usage: npm start\nStart an ordinary qwenaudio gateway first. Configure this client in .env.local; see .env.example.\nWithout DH_RENDERER_URL, a local synthetic DHAV renderer is started. No Gateway process or WebRTC extension is installed or started by this example.')
    return
  }
  if (argv.length) throw new Error(`Unknown option: ${argv[0]}; use .env.local configuration`)
  const root = fileURLToPath(new URL('../', import.meta.url))
  if (existsSync(`${root}.env.local`)) process.loadEnvFile(`${root}.env.local`)
  if (!existsSync(`${root}dist/index.html`)) throw new Error('Run npm run build:client first')
  const rendererId = process.env.DH_RENDERER_ADAPTER || 'dhav'
  let rendererUrl = process.env.DH_RENDERER_URL
  let mock, server
  try {
    if (!rendererUrl && rendererId === 'dhav') {
      const { startMockRendererServer } = await import('../providers/mock/mock-renderer-server.mjs')
      mock = await startMockRendererServer({ host: '127.0.0.1', port: 0, fault: process.env.DH_MOCK_FAULT || null })
      rendererUrl = mock.url
    }
    server = await startExampleServer({
      port: Number(process.env.DH_CLIENT_PORT || 5273),
      gatewayUrl: process.env.DH_GATEWAY_URL || 'ws://127.0.0.1:18888/api/realtime',
      gatewayToken: process.env.DH_GATEWAY_TOKEN,
      rendererId, rendererUrl, rendererToken: process.env.DH_RENDERER_TOKEN,
      persona: process.env.DH_PERSONA || 'mock-default',
    })
  } catch (error) { await mock?.close(); throw error }
  console.log(`Digital-human client: ${server.origin}\nRenderer adapter: ${rendererId}${mock ? ' (synthetic mock)' : ''}\nClick Connect to enable audio. Ctrl-C stops only this example, not your Gateway.`)
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await server.close()
    await mock?.close()
  }
  const shutdown = () => { void close().catch(error => { console.error(error.message); process.exitCode = 1 }) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return { ...server, close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
