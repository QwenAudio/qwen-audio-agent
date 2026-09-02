import { createServer } from 'node:net'
import { pathToFileURL } from 'node:url'
import { loadCockpitEnvironment } from './environment.mjs'

function port(env, name, fallback) {
  const source = String(env[name] || '').trim()
  if (!source) return fallback
  const value = Number(source)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} 必须是 1 到 65535 之间的端口号`)
  }
  return value
}

export function cockpitEndpoints(env = process.env) {
  return [
    {
      label: 'Service',
      host: env.COCKPIT_SERVICE_HOST || '127.0.0.1',
      port: port(env, 'COCKPIT_SERVICE_PORT', 3_010),
    },
    {
      label: 'Agent',
      host: env.COCKPIT_AGENT_HOST || '127.0.0.1',
      port: port(env, 'COCKPIT_AGENT_PORT', 3_020),
    },
    {
      label: 'Gateway',
      host: env.COCKPIT_GATEWAY_HOST || '127.0.0.1',
      port: port(env, 'COCKPIT_GATEWAY_PORT', 18_888),
    },
    {
      label: 'Client',
      host: env.COCKPIT_CLIENT_HOST || '127.0.0.1',
      port: port(env, 'COCKPIT_CLIENT_PORT', 5_173),
    },
  ]
}

export function assertRealtimeConfigured(env = process.env) {
  const provider = String(
    env.QWEN_AUDIO_REALTIME_PROVIDER || 'dashscope',
  ).trim().toLowerCase()
  if (provider === 'speech-to-speech') {
    if (env.SPEECH_TO_SPEECH_REALTIME_URL || env.S2S_REALTIME_URL) return
    throw new Error(
      '缺少 SPEECH_TO_SPEECH_REALTIME_URL。请配置 examples/smart-cockpit/.env.local。',
    )
  }
  if (env.QWEN_AUDIO_REALTIME_API_KEY || env.DASHSCOPE_API_KEY) return
  throw new Error(
    '缺少 DASHSCOPE_API_KEY。请复制 examples/smart-cockpit/.env.example 为 '
    + 'examples/smart-cockpit/.env.local，并填写 Key。',
  )
}

export function assertAgentConfigured(env = process.env) {
  if (env.DASHSCOPE_API_KEY) return
  throw new Error(
    '座舱后台 Agent 缺少 DASHSCOPE_API_KEY。请在 '
    + 'examples/smart-cockpit/.env.local 中填写 Key。',
  )
}

export function assertPortAvailable({ host, port, label }) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `${label} 端口 ${host}:${port} 已被占用。`
          + '请先关闭上一组座舱示例或占用该端口的程序。',
        ))
        return
      }
      reject(error)
    })
    server.listen({ host, port, exclusive: true }, () => {
      server.close(error => error ? reject(error) : resolve())
    })
  })
}

export async function preflightCockpitExample({
  env = process.env,
  probePort = assertPortAvailable,
} = {}) {
  assertRealtimeConfigured(env)
  assertAgentConfigured(env)
  const endpoints = cockpitEndpoints(env)
  for (const endpoint of endpoints) await probePort(endpoint)
  return endpoints
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    loadCockpitEnvironment()
    const endpoints = await preflightCockpitExample()
    console.log(
      `座舱启动检查通过：${endpoints.map(row => `${row.label}=${row.port}`).join('，')}`,
    )
  } catch (error) {
    console.error(`座舱示例无法启动：${error.message}`)
    process.exitCode = 1
  }
}
