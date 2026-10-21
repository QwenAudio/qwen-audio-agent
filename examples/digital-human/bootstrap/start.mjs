// One-command demo launcher: preflight -> (optional) local Mock renderer ->
// Gateway with avatar video downlink -> printed URL. Pass --renderer=<url> to
// attach to a remote renderer (e.g. the GPU OpenAvatarChat service) instead of
// starting the Mock. Nothing here logs renderer tokens or provider keys.
//
// The avatar UI is this example's own SPA (client/), served by the Gateway from
// /skins, so the demo opens `/skins/digital-human/index.html?persona=<id>`.
// Voice uses the REAL Realtime upstream, so DASHSCOPE_API_KEY must be present in
// examples/digital-human/.env.local.

import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { EXAMPLE_ROOT, loadDemoEnv, readConfig } from './env.mjs'
import { preflight } from './preflight.mjs'
import { startDigitalHumanGateway } from './compose-gateway.mjs'

function parseArgs(argv) {
  const args = { renderer: null, persona: null, port: null, fault: null, help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg.startsWith('--renderer=')) args.renderer = arg.slice(11)
    else if (arg.startsWith('--persona=')) args.persona = arg.slice(10)
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice(7))
    else if (arg.startsWith('--fault=')) args.fault = arg.slice(8)
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

const USAGE = `Usage: node bootstrap/start.mjs [--renderer=<url>] [--persona=<id>] [--port=<n>] [--fault=<name>]
  --renderer    attach to a remote DHAV renderer instead of starting the local Mock
  --persona     avatar persona id (must be in the server allowlist; default mock-default)
  --port        Gateway port (default DH_GATEWAY_PORT or 18895)
  --fault       Mock renderer fault injection: first_media_timeout | media_stall | protocol_error | mid_turn_failure | channel_drop

Requires DASHSCOPE_API_KEY in examples/digital-human/.env.local (or the repo-root .env.local) and a built avatar client (npm run build:client).`

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) { console.log(USAGE); return null }
  const apiKey = loadDemoEnv()
  const config = readConfig()
  const persona = args.persona || config.persona
  const port = args.port || config.gatewayPort
  const fault = args.fault || config.mockFault

  // Fail fast before allocating any media resource: the demo serves this
  // example's own built SPA and drives voice from the real Realtime upstream.
  if (!existsSync(`${EXAMPLE_ROOT}skins/digital-human/index.html`)) {
    throw new Error('skins/digital-human not found; run `npm run build:client` first so the Gateway can serve the avatar UI')
  }
  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY is required; add it to examples/digital-human/.env.local or the repo-root .env.local (the demo uses the real Realtime upstream)')
  }

  let renderer = null
  let rendererUrl = args.renderer || config.rendererUrl
  if (!rendererUrl) {
    const { startMockRendererServer } = await import('../providers/mock/mock-renderer-server.mjs')
    renderer = await startMockRendererServer({
      host: config.mockRendererHost, port: config.mockRendererPort, fault,
      log: (name, fields) => console.log(`[mock-renderer] ${name}`, fields ?? ''),
    })
    rendererUrl = renderer.url
    console.log(`[start] Mock renderer listening on ${rendererUrl}${fault ? ` (fault: ${fault})` : ''}`)
  } else {
    console.log(`[start] using remote renderer at ${rendererUrl}`)
  }

  const report = await preflight({ gatewayHost: config.gatewayHost, gatewayPort: port, rendererUrl })
  for (const result of report.results) {
    if (result.ok) console.log(`[preflight] ${result.name}: ok${result.version ? ` (${result.version})` : ''}`)
    else console.error(`[preflight] ${result.name}: FAILED (${result.code}) ${result.message}`)
  }
  if (!report.ok) {
    await renderer?.close()
    throw new Error('preflight failed; see messages above')
  }

  const application = await startDigitalHumanGateway({
    host: config.gatewayHost, port, rendererUrl, persona,
    mediaAdapterPath: config.mediaAdapterPath, authToken: config.rendererToken,
  })
  const origin = `http://${config.gatewayHost}:${port}`
  const demoUrl = `${origin}/skins/digital-human/index.html?persona=${persona}`
  console.log('')
  console.log(`[start] Gateway ready at ${origin}`)
  console.log(`[start] Open ${demoUrl} in a browser, allow the microphone, and speak.`)
  console.log(`[start] Persona: ${persona} | Renderer: ${rendererUrl}`)
  console.log('[start] Press Ctrl-C to stop.')

  const shutdown = async () => {
    console.log('\n[start] shutting down...')
    try { await application.close() } catch { /* best effort */ }
    try { await renderer?.close() } catch { /* best effort */ }
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return { application, renderer, origin }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`[start] ${error.message}`); process.exitCode = 1 })
}
