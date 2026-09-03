// 前台的组装入口。只做场景选择，不搬框架逻辑，也不把客服业务状态放进 Gateway。
//
// 四进程里它是最薄的一层：把「用哪份人设、哪些前台工具、后台 Agent 在哪」
// 三件事拼起来，剩下的都是框架的。
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadServiceEnvironment } from '../bootstrap/environment.mjs'
import { CUSTOMER_SERVICE_SPAWN_THINKING_DESCRIPTION } from './spawn-thinking-tool.mjs'

loadServiceEnvironment()
process.env.QWAUDIO_CONFIG_DIR ||= fileURLToPath(new URL('../.runtime', import.meta.url))
process.env.QWAUDIO_DATA_DIR ||= process.env.QWAUDIO_CONFIG_DIR

// frontend-mcp.json 里的 url 写成占位符，在这里补成真实地址 ——
// 导出的配置不该把本机端口写死，否则换环境就得改配置文件。
//
// 【sessionId 在进程启动时定下来，这是个已知限制】
// 核实过 server/src/providers/mcp/frontend-mcp-client.mjs:132：MCP 客户端用的是
// 配置里的静态 transport.headers，框架【不会】按语音会话注入参数。
// 所以这里不带 sessionId 的话，所有通话的前台工具都会打到 service 的 default
// 会话上 —— 而且是隐蔽的：会话隔离看起来支持，实际全串在一起。
//
// 座舱那样写是对的，它的 cockpitId 是「哪台车」，一台车一个固定值。
// 客服的 sessionId 语义上是「哪通电话」，本该每通不同。
// 真要做到那样，需要框架支持按会话注入 MCP 请求参数 —— 那是框架的事，
// 不该在示例里用一个假的隔离层糊过去。
//
// 当前形态：单通话演示。多通并发时它们共享同一份客服会话状态。
if (!process.env.CS_FRONTEND_MCP_URL) {
  const url = new URL(
    '/mcp/frontend',
    process.env.CS_SERVICE_ORIGIN || 'http://127.0.0.1:3110',
  )
  url.searchParams.set('sessionId', process.env.CS_SESSION_ID || 'default')
  process.env.CS_FRONTEND_MCP_URL = url.toString()
}
process.env.QWEN_AUDIO_FRONTEND_PROFILE ||= fileURLToPath(
  new URL('./frontend-profile.json', import.meta.url),
)

const [
  { createGatewayApplication },
  { createBackendAgentHost },
  { createA2ABackendAdapter },
] = await Promise.all([
  import('qwen-audio-agent/gateway-application'),
  import('qwen-audio-agent/backend-adapter-sdk'),
  import('qwen-audio-agent/a2a-backend-adapter'),
])

function port(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535
    ? parsed
    : fallback
}

// Gateway 起来时 Service 可能还没就绪。等它，而不是让第一通电话失败 ——
// 前台工具全都打在 Service 上，它没起来等于没有工具。
export async function waitForCustomerService({
  origin = process.env.CS_SERVICE_ORIGIN || 'http://127.0.0.1:3110',
  timeoutMs = 8_000,
  intervalMs = 100,
  fetchImpl = fetch,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(new URL('/health', origin))
      if (response.ok) return
      lastError = new Error(`Customer Service health returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Customer Service is not ready: ${lastError?.message || origin}`)
}

export function startCustomerServiceGateway({
  host = process.env.CS_GATEWAY_HOST || '127.0.0.1',
  port: listenPort = port(process.env.CS_GATEWAY_PORT, 18_889),
  agentCardUrl = process.env.CS_AGENT_CARD_URL
    || 'http://127.0.0.1:3120/.well-known/agent-card.json',
} = {}) {
  const backend = createA2ABackendAdapter({
    agentCardUrl,
    label: 'Customer Service Agent',
  })
  const agent = createBackendAgentHost(backend, {
    name: 'Customer Service A2A Agent',
  })
  const application = createGatewayApplication({
    agent,
    autoStart: false,
    spawnThinkingDescription: CUSTOMER_SERVICE_SPAWN_THINKING_DESCRIPTION,
  })
  const server = application.start({ host, port: listenPort })
  let closePromise = null

  return {
    application,
    agent,
    server,
    close() {
      if (closePromise) return closePromise
      closePromise = (async () => {
        try {
          await application.close()
        } finally {
          await agent.close()
        }
      })()
      return closePromise
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await waitForCustomerService()
  const runtime = startCustomerServiceGateway()
  runtime.server.once('listening', () => {
    const address = runtime.server.address()
    console.log(`Customer Service Gateway listening on http://${address.address}:${address.port}`)
  })
  const close = async () => {
    await runtime.close()
    process.exit(0)
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
