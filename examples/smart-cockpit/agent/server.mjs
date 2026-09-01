// Replaceable cockpit Agent example. It demonstrates the
// A2A boundary and delegates business operations to the backend MCP surface;
// it is intentionally not a second conversation runtime or a generic Agent SDK.
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
} from '@a2a-js/sdk'
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
} from '@a2a-js/sdk/server'
import {
  UserBuilder,
  agentCardHandler,
  jsonRpcHandler,
} from '@a2a-js/sdk/server/express'
import express from 'express'
import { pathToFileURL } from 'node:url'
import { CockpitAgentExecutor } from './executor.mjs'
import { CockpitMcpTools } from './mcp-client.mjs'
import { DashScopeCockpitModel } from './model.mjs'
import { loadCockpitEnvironment } from '../bootstrap/environment.mjs'

function agentCard(origin) {
  return {
    name: 'Qwen Smart Cockpit Agent',
    description: 'Replaceable model-powered A2A Agent for cockpit operations.',
    supportedInterfaces: [{
      url: `${origin}/`,
      protocolBinding: 'JSONRPC',
      tenant: '',
      protocolVersion: A2A_PROTOCOL_VERSION,
    }],
    provider: {
      organization: 'Qwen Audio Agent Examples',
      url: 'https://github.com/QwenAudio/qwen-audio-agent',
    },
    version: '1.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [{
      id: 'cockpit_operations',
      name: 'Cockpit operations',
      description: 'Cockpit controls, navigation, music, flash-buy and user-defined cockpit workflows.',
      tags: ['cockpit', 'vehicle', 'navigation', 'music', 'custom-workflows'],
      examples: ['空调调到二十二度', '导航到西湖', '播放晴天', '创建一个下班回家技能'],
      inputModes: ['text/plain'],
      outputModes: ['text/plain', 'application/json'],
      securityRequirements: [],
    }],
    documentationUrl: '',
    signatures: [],
  }
}

export async function startCockpitAgentServer({
  host = '127.0.0.1',
  port = 3020,
  serviceOrigin = 'http://127.0.0.1:3010',
  cockpitId = 'default',
  tools = new CockpitMcpTools({ origin: serviceOrigin, cockpitId }),
  model = new DashScopeCockpitModel(),
} = {}) {
  const card = agentCard(`http://${host}:${port}`)
  const executor = new CockpitAgentExecutor({ tools, model })
  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    executor,
  )
  const app = express()
  app.get('/health', (_request, response) => {
    response.json({ ok: true, service: 'cockpit-agent', protocol: 'a2a' })
  })
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({
    agentCardProvider: requestHandler,
  }))
  app.use(jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  }))
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener))
    listener.once('error', reject)
  })
  const address = server.address()
  const origin = `http://${host}:${address.port}`
  card.supportedInterfaces[0].url = `${origin}/`
  return {
    app,
    server,
    origin,
    agentCardUrl: `${origin}/${AGENT_CARD_PATH}`,
    close: async () => {
      await tools.close?.()
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadCockpitEnvironment()
  const runtime = await startCockpitAgentServer({
    host: process.env.COCKPIT_AGENT_HOST || '127.0.0.1',
    port: Number(process.env.COCKPIT_AGENT_PORT) || 3020,
    serviceOrigin: process.env.COCKPIT_SERVICE_ORIGIN || 'http://127.0.0.1:3010',
    cockpitId: process.env.COCKPIT_ID || 'default',
  })
  console.log(`Cockpit A2A Agent listening on ${runtime.origin}`)
  const close = async () => {
    await runtime.close()
    process.exit(0)
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
