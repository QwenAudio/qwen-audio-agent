import { createReadStream, existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { defaultLogDirectory, LOG_SCHEMA } from '../../shared/logger.mjs'
import { resolveRealtimeFrontendConfiguration } from '../../shared/realtime-provider-catalog.mjs'
import { readGatewayLease } from '../../shared/gateway/lease.mjs'
import { GatewayUrlSchema } from '../../shared/gateway/remote-access.mjs'
import { loadFrontendMcpConfiguration } from '../../server/src/providers/mcp/frontend-mcp-config.mjs'
import { inspectSessionJournals } from '../../server/src/session/session-journal-inspection.mjs'

function localUrl(value) {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname)
}

// Diagnostics contain only event identity and timing, never transcripts,
// prompts, tool arguments/results, credentials or raw provider errors.
function traceEvent(record) {
  if (record.schema !== LOG_SCHEMA || !Number.isFinite(Date.parse(record.time))) return null
  const result = { time: record.time }
  for (const key of ['event', 'level', 'turnId', 'sessionId', 'responseId', 'callId', 'taskId', 'code']) {
    if (typeof record[key] === 'string' && /^[\w.:/-]{1,160}$/.test(record[key])) result[key] = record[key]
  }
  for (const key of ['durationMs', 'elapsedMs', 'pid']) {
    if (Number.isFinite(record[key])) result[key] = record[key]
  }
  return result
}

export async function readTurnTimeline(directory, turnId, { maxFileBytes = 2 * 1024 * 1024 } = {}) {
  let names
  try { names = await readdir(directory) } catch { return { events: [], partial: true } }
  const candidates = names.filter(name => /^gateway\.log(?:\.\d+)?$/.test(name))
    .sort((a, b) => (Number(a.split('.')[2]) || 0) - (Number(b.split('.')[2]) || 0))
  const events = []
  let partial = candidates.length > 5
  for (const name of candidates.slice(0, 5)) {
    try {
      const path = resolve(directory, name)
      const { size } = await stat(path)
      const start = Math.max(0, size - maxFileBytes)
      partial ||= start > 0
      const stream = createReadStream(path, { start, end: Math.max(0, size - 1) })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      let skipFirst = start > 0
      try {
        for await (const line of lines) {
          if (skipFirst) { skipFirst = false; continue }
          try {
            const record = JSON.parse(line)
            if (record.turnId !== turnId) continue
            const event = traceEvent(record)
            if (event) events.push(event)
            if (events.length >= 500) { partial = true; break }
          } catch { /* A live log may end in a partially written record. */ }
        }
      } finally {
        lines.close()
        stream.destroy()
      }
      if (events.length >= 500) break
    } catch { partial = true }
  }
  events.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  const first = Date.parse(events[0]?.time)
  return { partial, events: events.map(event => ({ ...event, offsetMs: Date.parse(event.time) - first })) }
}

export async function collectDiagnostics({ options, environment, env = process.env, fetchImpl = fetch } = {}) {
  const checks = []
  const add = (id, status, summary, details) => checks.push({ id, status, summary, ...(details ? { details } : {}) })
  const lease = !options.urlSpecified ? readGatewayLease(environment.configDirectory) : null
  const url = GatewayUrlSchema.parse(lease?.origin || options.url)
  const local = localUrl(url)
  if (local) {
    add('config', existsSync(environment.configPath) ? 'ok' : 'warning',
      existsSync(environment.configPath) ? '找到配置文件' : '尚未创建配置文件')
    try {
      const realtime = resolveRealtimeFrontendConfiguration(env)
      add('realtime.configuration', realtime.configured ? 'ok' : 'error',
        realtime.configured ? '语音前台配置已填写；此检查不验证密钥额度' : '语音前台缺少必要配置')
    } catch { add('realtime.configuration', 'error', '语音前台配置无效') }
    try {
      loadFrontendMcpConfiguration({ filePath: env.QWEN_AUDIO_FRONTEND_MCP_CONFIG || '', env })
      add('mcp.configuration', 'ok', '前台 MCP 配置结构有效；未启动 MCP 进程')
    } catch { add('mcp.configuration', 'error', '前台 MCP 配置或引用的环境变量无效') }
    const journals = await inspectSessionJournals(resolve(environment.configDirectory, 'sessions'))
    add('session.journals', journals.damaged || journals.unreadable ? 'error' : journals.tornTails || journals.skipped || journals.partial ? 'warning' : 'ok',
      '会话历史检查（只读，不修改文件）', journals)
  }
  let health
  try {
    const response = await fetchImpl(`${url}/api/health`, {
      headers: options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {},
      signal: AbortSignal.timeout(3_000), redirect: 'error',
    })
    if (!response.ok) {
      add('gateway', 'error', response.status === 401 || response.status === 403
        ? 'Gateway 拒绝访问，请检查配对或访问凭据' : 'Gateway 健康检查失败', { httpStatus: response.status })
    } else {
      health = await response.json()
      if (!health?.backend || !health?.protocolVersion) throw new Error('invalid health')
      add('gateway', 'ok', 'Gateway 可达')
    }
  } catch { add('gateway', 'error', '无法读取 Gateway 状态，请检查是否启动、地址、网络与证书') }
  if (health?.backend) {
    add('backend', health.backend.enabled === false ? 'skipped' : health.backend.ok ? 'ok' : 'warning',
      health.backend.enabled === false ? '仅前台模式' : health.backend.ok ? '后台 Agent 已就绪' : '后台 Agent 尚未就绪')
    const voice = health.voiceClients?.realtime
    add('realtime.connection', voice?.unavailable ? 'error' : voice?.connected ? 'ok' : 'warning',
      voice?.unavailable ? '语音服务连接异常' : voice?.connected ? '语音服务已连接' : '当前没有已连接的语音会话；配置有效不代表服务连接成功')
    if (health.frontendMcp) add('mcp.connection', health.frontendMcp.ok === false ? 'error' : health.frontendMcp.initialized ? 'ok' : 'warning',
      health.frontendMcp.ok === false ? '前台 MCP 连接异常' : health.frontendMcp.initialized ? '前台 MCP 初始化完成' : '前台 MCP 正在初始化')
    const endpoint = health.publicEndpoint
    if (endpoint && endpoint.mode !== 'none') add('gateway.endpoint', endpoint.state === 'ready' ? 'ok' : endpoint.state === 'error' ? 'error' : 'warning',
      endpoint.state === 'ready' ? '远程发布已就绪；尚未验证客户端到此地址的连通性' : '远程发布尚未就绪')
  }
  const timeline = options.turnId && local
    ? await readTurnTimeline(defaultLogDirectory({ ...env, QWAUDIO_CONFIG_DIR: environment.configDirectory }), options.turnId)
    : null
  if (options.turnId && !local) add('timeline', 'skipped', '远程 Gateway 的日志需在对应主机上检查')
  return { schema: 'qwaudio.diagnostics/v1', ok: checks.every(check => check.status !== 'error'), checks, ...(timeline ? { timeline } : {}) }
}

export function formatDiagnostics(report) {
  const lines = report.checks.map(check => `[${check.status}] ${check.id}: ${check.summary}${check.details ? ` ${JSON.stringify(check.details)}` : ''}`)
  if (report.timeline) {
    lines.push('交互时间线（仅已有日志事件；不包含对话正文）：')
    lines.push(...report.timeline.events.map(event => `+${event.offsetMs}ms ${event.event || 'event'}${event.taskId ? ` ${event.taskId}` : ''}`))
    if (!report.timeline.events.length) lines.push('没有找到匹配的日志事件。')
    if (report.timeline.partial) lines.push('仅检查了有限的日志片段，结果可能不完整。')
  }
  return lines.join('\n')
}
