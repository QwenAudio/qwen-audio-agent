// 可替换的客服后台 Agent 示例。它演示 A2A 边界，把业务操作委托给后台 MCP 工具面；
// 它不是第二个对话运行时，也不是通用 Agent SDK。
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
import { ServiceAgentExecutor } from './executor.mjs'
import { ServiceMcpTools } from './mcp-client.mjs'
import { DashScopeServiceModel } from './model.mjs'
import { loadServiceEnvironment } from '../bootstrap/environment.mjs'

function agentCard(origin) {
  return {
    name: 'Qwen Audio Agent Customer Service Agent',
    description: 'Replaceable model-powered A2A Agent for retail customer service operations.',
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
    security: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [{
      id: 'retail_service_operations',
      name: 'Retail service operations',
      description: 'Cancel orders, process returns, change shipping addresses and escalate to a human.',
      tags: ['customer-service', 'retail', 'orders', 'returns'],
      examples: ['把这笔订单取消掉', '我要退那个恒温器', '收货地址改一下'],
      inputModes: ['text/plain'],
      outputModes: ['text/plain', 'application/json'],
      securityRequirements: [],
    }],
    documentationUrl: '',
    signatures: [],
  }
}

export async function startServiceAgentServer({
  host = '127.0.0.1',
  port = 3120,
  serviceOrigin = 'http://127.0.0.1:3110',
  sessionId = 'default',
  tools = new ServiceMcpTools({ origin: serviceOrigin, sessionId }),
  model = new DashScopeServiceModel(),
} = {}) {
  const card = agentCard(`http://${host}:${port}`)
  const executor = new ServiceAgentExecutor({ tools, model })
  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    executor,
  )
  const app = express()
  app.get('/health', (_request, response) => {
    response.json({ ok: true, service: 'customer-service-agent', protocol: 'a2a' })
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
    executor,
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
  loadServiceEnvironment()
  const runtime = await startServiceAgentServer({
    host: process.env.CS_AGENT_HOST || '127.0.0.1',
    port: Number(process.env.CS_AGENT_PORT) || 3120,
    serviceOrigin: process.env.CS_SERVICE_ORIGIN || 'http://127.0.0.1:3110',
    sessionId: process.env.CS_SESSION_ID || 'default',
  })
  console.log(`Customer service A2A Agent listening on ${runtime.origin}`)
  const close = async () => {
    await runtime.close()
    process.exit(0)
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
