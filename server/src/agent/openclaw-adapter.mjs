import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { WebSocket } from 'ws'
import { PACKAGE_VERSION } from '../core/package-version.mjs'
import { AgentError, requestSignal } from './backend-adapter.mjs'

const WAIT_SLICE_MS = 30_000
const MIN_GATEWAY_PROTOCOL = 3
const MAX_GATEWAY_PROTOCOL = 4

function clean(value) {
  return String(value || '').trim()
}

function websocketUrl(baseUrl) {
  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function messageText(data) {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function assistantText(message) {
  if (Array.isArray(message?.content)) {
    return message.content
      .filter(part => part?.type === 'text')
      .map(part => part.text || '')
      .join('\n')
      .trim()
  }
  return clean(message?.content)
}

class OpenClawGatewayRpc {
  constructor({
    baseUrl,
    token = '',
    WebSocketImpl = WebSocket,
  } = {}) {
    this.url = websocketUrl(baseUrl)
    this.token = clean(token)
    this.WebSocket = WebSocketImpl
  }

  call(method, params = {}, { signal, timeoutMs = 35_000 } = {}) {
    const combined = requestSignal(signal, timeoutMs)
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocket(this.url)
      const pending = new Map()
      let connected = false
      let finished = false

      const close = () => {
        if (
          ws.readyState === this.WebSocket.OPEN
          || ws.readyState === this.WebSocket.CONNECTING
        ) ws.close()
      }
      const finish = (error, value) => {
        if (finished) return
        finished = true
        combined?.removeEventListener('abort', abort)
        close()
        if (error) reject(error)
        else resolve(value)
      }
      const request = (requestMethod, requestParams) => {
        const id = randomUUID()
        pending.set(id, requestMethod)
        ws.send(JSON.stringify({
          type: 'req',
          id,
          method: requestMethod,
          params: requestParams,
        }))
      }
      const abort = () => finish(
        combined?.reason || new Error('OpenClaw Gateway 请求已取消'),
      )

      combined?.addEventListener('abort', abort, { once: true })
      if (combined?.aborted) return abort()

      ws.on('message', data => {
        let frame
        try {
          frame = JSON.parse(messageText(data))
        } catch {
          return
        }
        if (frame.type === 'event') {
          if (frame.event === 'connect.challenge' && !connected) {
            connected = true
            request('connect', {
              minProtocol: MIN_GATEWAY_PROTOCOL,
              maxProtocol: MAX_GATEWAY_PROTOCOL,
              client: {
                id: 'gateway-client',
                displayName: 'qwen-audio-agent',
                version: PACKAGE_VERSION,
                platform: process.platform,
                mode: 'backend',
              },
              caps: ['tool-events'],
              role: 'operator',
              scopes: [
                'operator.read',
                'operator.write',
                'operator.admin',
              ],
              ...(this.token ? { auth: { token: this.token } } : {}),
            })
          }
          return
        }
        if (frame.type !== 'res' || !pending.has(frame.id)) return
        const requestMethod = pending.get(frame.id)
        pending.delete(frame.id)
        if (!frame.ok) {
          finish(new AgentError(
            `OpenClaw Gateway ${requestMethod} 失败：${
              frame.error?.message || '未知错误'
            }`,
            {
              body: JSON.stringify(frame.error || {}),
              protocol: 'openclaw-gateway',
            },
          ))
          return
        }
        if (requestMethod === 'connect') {
          request(method, params)
          return
        }
        finish(null, frame.payload)
      })
      ws.once('error', error => finish(new AgentError(
        `无法连接 OpenClaw Gateway：${error.message}`,
        { protocol: 'openclaw-gateway' },
      )))
      ws.once('close', () => {
        if (!finished) finish(new AgentError(
          'OpenClaw Gateway 连接意外关闭',
          { protocol: 'openclaw-gateway' },
        ))
      })
    })
  }
}

// ACP owns coordinator interaction. OpenClaw's Gateway RPC is used only for
// the native child-run lifecycle that its ACP bridge does not push after the
// coordinator prompt has ended.
export class OpenClawAcpDelegationAdapter {
  constructor({
    baseUrl,
    token = '',
    tokenFile = '',
    WebSocketImpl,
  } = {}) {
    this.options = {
      baseUrl,
      token: clean(token),
      tokenFile: clean(tokenFile),
      WebSocketImpl,
    }
    this.gatewayPromise = null
  }

  async gateway() {
    if (!this.gatewayPromise) {
      this.gatewayPromise = (async () => {
        let token = this.options.token
        if (!token && this.options.tokenFile) {
          token = await readFile(this.options.tokenFile, 'utf8')
            .then(clean)
            .catch(() => '')
        }
        return new OpenClawGatewayRpc({
          baseUrl: this.options.baseUrl,
          token,
          ...(this.options.WebSocketImpl
            ? { WebSocketImpl: this.options.WebSocketImpl }
            : {}),
        })
      })()
    }
    return this.gatewayPromise
  }

  async wait({ runId, sessionId, signal }) {
    const id = clean(runId)
    if (!id) {
      throw new AgentError('OpenClaw Session 工具没有返回 runId', {
        protocol: 'openclaw-gateway',
      })
    }
    const gateway = await this.gateway()
    while (true) {
      if (signal?.aborted) {
        throw signal.reason || new Error('任务已取消')
      }
      const completion = await gateway.call('agent.wait', {
        runId: id,
        timeoutMs: WAIT_SLICE_MS,
      }, {
        signal,
        timeoutMs: WAIT_SLICE_MS + 5000,
      })
      if (completion?.status === 'timeout') continue
      if (!['ok', 'completed'].includes(completion?.status)) {
        throw new AgentError(
          completion?.error || `OpenClaw 子任务结束状态异常：${
            completion?.status || 'unknown'
          }`,
          { protocol: 'openclaw-gateway' },
        )
      }
      const history = await gateway.call('chat.history', {
        sessionKey: clean(sessionId),
        limit: 20,
      }, { signal, timeoutMs: 15_000 })
      const assistant = [...(history?.messages || [])]
        .reverse()
        .find(message => message?.role === 'assistant')
      const content = assistantText(assistant)
      if (!content) {
        throw new AgentError('OpenClaw 子任务已完成，但没有返回文本', {
          protocol: 'openclaw-gateway',
        })
      }
      return { content, completion }
    }
  }

  async cancel({ runId, sessionId, signal }) {
    const gateway = await this.gateway()
    return gateway.call('chat.abort', {
      sessionKey: clean(sessionId),
      runId: clean(runId),
    }, { signal, timeoutMs: 10_000 })
  }
}
