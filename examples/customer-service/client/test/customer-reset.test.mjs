import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createServer } from 'node:http'
import { resetCustomer } from '../customer-reset.mjs'
import { createClientServer } from '../server.mjs'

function fakeReset(failingPath) {
  const seen = []
  return { seen, options: {
    gatewayOrigin: 'http://gateway', serviceOrigin: 'http://service', agentOrigin: 'http://agent',
    sessionId: 'default', conversationId: 'old-conversation', mode: 'new-customer', headers: { cookie: 'demo' },
    fetchImpl: async (url, options) => {
      seen.push({ url: url.href, method: options.method || 'GET', headers: options.headers })
      return { ok: url.pathname !== failingPath, status: url.pathname === failingPath ? 503 : 200,
        json: async () => url.pathname === '/api/tasks' ? { tasks: [{ id: 'old-task' }] } : { ok: true } }
    },
  } }
}

test('重置顺序为取消旧任务、清理 Agent、重置业务；新对话 ID 与业务 sessionId 分离', async () => {
  const h = fakeReset()
  const result = await resetCustomer(h.options)
  assert.deepEqual(h.seen.map(r => r.url), [
    'http://gateway/api/tasks?active=true&sessionId=old-conversation',
    'http://gateway/api/tasks/old-task', 'http://agent/api/customer-service/reset',
    'http://service/api/service/new-customer?sessionId=default',
  ])
  assert.equal(h.seen[1].method, 'DELETE')
  assert.equal(h.seen[0].headers.cookie, 'demo')
  assert.equal(h.seen[2].headers, undefined, '用户 Cookie 不应转发给 Agent')
  assert.notEqual(result.conversationId, 'old-conversation')
  assert.equal(result.conversationRetained, false)
})

test('任一清理步骤失败，都不能继续重置业务状态', async () => {
  for (const path of ['/api/tasks', '/api/tasks/old-task', '/api/customer-service/reset']) {
    const h = fakeReset(path)
    await assert.rejects(resetCustomer(h.options), /cleanup failed/)
    assert.equal(h.seen.some(r => r.url.startsWith('http://service/')), false)
  }
})

test('非法模式或缺少旧对话 ID 时，不触发任何上游调用', async () => {
  for (const invalid of [{ mode: 'delete' }, { conversationId: '' }]) {
    const h = fakeReset()
    await assert.rejects(resetCustomer({ ...h.options, ...invalid }), /Invalid customer reset request/)
    assert.deepEqual(h.seen, [])
  }
})

test('任务列表格式错误时停止清理，不重置业务', async () => {
  const h = fakeReset()
  await assert.rejects(resetCustomer({ ...h.options,
    fetchImpl: async () => ({ ok: true, json: async () => ({ tasks: null }) }),
  }), /Invalid task cleanup response/)
})

test('业务重置失败不会返回新对话 ID', async () => {
  const h = fakeReset('/api/service/new-customer')
  await assert.rejects(resetCustomer(h.options), /cleanup failed/)
  assert.equal(h.seen.at(-1).url, 'http://service/api/service/new-customer?sessionId=default')
})

test('客户页重置成功后才切换对话并重连；失败时暂停通话且保留旧 ID', async () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const script = html.slice(html.indexOf("$('reset').onclick"), html.lastIndexOf('subscribeState()'))
  for (const ok of [true, false]) {
    const elements = new Map()
    const messages = []
    let connections = 0
    const storage = new Map()
    const sandbox = {
      $: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id) },
      customerResetting: false, voiceRequest: 0, voiceWanted: true, mic: { stop() {} },
      playback: { close() {} }, reconnecting: false, reconnectTimer: null, socket: null,
      WebSocket: { CLOSED: 3 }, API: '', SESSION: 'default', conversationId: 'old',
      CONVERSATION_KEY: 'key', playing: {}, seenMessages: new Set(['old-message']),
      sessionStorage: { setItem: (k, v) => storage.set(k, v) },
      setTimeout, clearTimeout, renderTurn: m => messages.push(m), connect: () => { connections += 1 },
      fetch: async (_url, options) => {
        assert.equal(JSON.parse(options.body).conversationId, 'old')
        return { ok, json: async () => ok ? { conversationId: 'new' } : { error: 'cleanup failed' } }
      },
    }
    runInNewContext(script, sandbox)
    await sandbox.$('new-customer').onclick()
    assert.equal(sandbox.conversationId, ok ? 'new' : 'old')
    assert.equal(connections, ok ? 1 : 0)
    assert.equal(sandbox.$('talk').disabled, !ok)
    assert.equal(sandbox.customerResetting, false)
    assert.equal(storage.get('key'), ok ? 'new' : undefined)
    assert.ok(messages.length)
  }
})

test('工作台重置端点协调三个上游，并拒绝跨源重置', async t => {
  const seen = []
  const upstream = createServer((request, response) => {
    seen.push(request.url)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.url.startsWith('/api/tasks?') ? { tasks: [] } : { ok: true }))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${upstream.address().port}`
  const client = createClientServer({ gatewayOrigin: origin, serviceOrigin: origin, agentOrigin: origin })
  await new Promise(resolve => client.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    client.closeAllConnections()
    upstream.closeAllConnections()
    await new Promise(resolve => client.close(resolve))
    await new Promise(resolve => upstream.close(resolve))
  })
  const url = `http://127.0.0.1:${client.address().port}/api/customer-service/reset`
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: process.env.CS_SESSION_ID || 'default', conversationId: 'old', mode: 'reset' }) }
  const response = await fetch(url, request)
  assert.equal(response.status, 200)
  assert.match((await response.json()).conversationId, /^customer-/)
  assert.deepEqual(seen, ['/api/tasks?active=true&sessionId=old', '/api/customer-service/reset', '/api/service/reset?sessionId=default'])
  const forbidden = await fetch(url, { ...request, headers: { ...request.headers, Origin: 'http://other.example' } })
  assert.equal(forbidden.status, 403)
})

test('重置期间重复请求返回 409，上游失败后释放锁允许重试', async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let first = true
  const upstream = createServer(async (request, response) => {
    if (first) {
      first = false
      entered.resolve()
      await release.promise
      response.writeHead(503).end()
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.url.startsWith('/api/tasks?') ? { tasks: [] } : { ok: true }))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${upstream.address().port}`
  const client = createClientServer({ gatewayOrigin: origin, serviceOrigin: origin, agentOrigin: origin })
  await new Promise(resolve => client.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    release.resolve()
    client.closeAllConnections()
    upstream.closeAllConnections()
    await new Promise(resolve => client.close(resolve))
    await new Promise(resolve => upstream.close(resolve))
  })
  const url = `http://127.0.0.1:${client.address().port}/api/customer-service/reset`
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: process.env.CS_SESSION_ID || 'default', conversationId: 'old', mode: 'reset' }) }
  const pending = fetch(url, options)
  await entered.promise
  assert.equal((await fetch(url, options)).status, 409)
  release.resolve()
  assert.equal((await pending).status, 503)
  const retry = await fetch(url, options)
  assert.equal(retry.status, 200)
  assert.match((await retry.json()).conversationId, /^customer-/)
})
