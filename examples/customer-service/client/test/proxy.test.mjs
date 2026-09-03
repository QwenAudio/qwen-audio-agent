import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createClientServer } from '../server.mjs'

// 工作台的代理层测试。页面本身是静态 HTML，没什么可测的；
// 代理有逻辑，而且它的存在理由是个安全边界（网关的 DNS rebinding 防护），
// 所以这几条断言值得写。

async function listen(server) {
  await new Promise(resolve => server.listen(0, resolve))
  return `http://127.0.0.1:${server.address().port}`
}

// 假上游：记录收到的请求，好断言代理转发了什么。
function fakeUpstream() {
  const seen = []
  const server = createServer((request, response) => {
    seen.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
    })
    if (request.url.startsWith('/api/service/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"tick":1}\n\n')
      // 不 end —— SSE 是长连接，代理要能逐块转发
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, saw: request.url }))
  })
  return { server, seen }
}

async function withProxy(probe) {
  const gateway = fakeUpstream()
  const service = fakeUpstream()
  const gatewayOrigin = await listen(gateway.server)
  const serviceOrigin = await listen(service.server)
  const saved = [process.env.CS_GATEWAY_ORIGIN, process.env.CS_SERVICE_ORIGIN]
  process.env.CS_GATEWAY_ORIGIN = gatewayOrigin
  process.env.CS_SERVICE_ORIGIN = serviceOrigin

  // server.mjs 在模块顶层读环境变量，所以要重新导入才生效。
  const fresh = await import(`../server.mjs?t=${Date.now()}`)
  const client = fresh.createClientServer()
  const clientOrigin = await listen(client)
  try {
    await probe({ clientOrigin, gateway, service })
  } finally {
    await new Promise(resolve => client.close(resolve))
    await new Promise(resolve => gateway.server.close(resolve))
    await new Promise(resolve => service.server.close(resolve))
    process.env.CS_GATEWAY_ORIGIN = saved[0]
    process.env.CS_SERVICE_ORIGIN = saved[1]
    if (saved[0] === undefined) delete process.env.CS_GATEWAY_ORIGIN
    if (saved[1] === undefined) delete process.env.CS_SERVICE_ORIGIN
  }
}

test('首页返回 HTML，且不缓存', async () => {
  const server = createClientServer()
  const origin = await listen(server)
  try {
    const response = await fetch(origin)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/html/)
    // 【no-store 是必须的】实测浏览器拿着旧版 index.html 不放，
    // 硬刷新都没换掉 —— 那一版还写着直连 18889，于是一直报 403。
    assert.match(response.headers.get('cache-control'), /no-store/)
    assert.match(await response.text(), /客服工作台/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('任意路径都发同一页，刷新不 404', async () => {
  const server = createClientServer()
  const origin = await listen(server)
  try {
    const response = await fetch(`${origin}/whatever/deep/path`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /客服工作台/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('/api/service/* 走 service，其余 /api/* 走网关', async () => {
  await withProxy(async ({ clientOrigin, gateway, service }) => {
    await fetch(`${clientOrigin}/api/service/state?sessionId=default`)
    await fetch(`${clientOrigin}/api/conversations/default/messages`)

    assert.equal(service.seen.length, 1, 'service 应收到 1 个请求')
    assert.match(service.seen[0].url, /^\/api\/service\/state/)
    assert.equal(gateway.seen.length, 1, '网关应收到 1 个请求')
    assert.match(gateway.seen[0].url, /^\/api\/conversations/)
  })
})

test('查询串被完整带过去', async () => {
  await withProxy(async ({ clientOrigin, service }) => {
    await fetch(`${clientOrigin}/api/service/state?sessionId=abc&domain=retail`)
    // sessionId 丢了的话，面板会显示别的会话的状态 —— 那种错很难看出来
    assert.match(service.seen[0].url, /sessionId=abc/)
    assert.match(service.seen[0].url, /domain=retail/)
  })
})

test('Origin 头不转发给上游', async () => {
  // 【代理存在的全部理由】网关做 DNS rebinding 防护，判据是
  // 「origin 的 host 必须等于请求的 host」（core/request-security.mjs）。
  // 把浏览器的 Origin 原样转过去，上游照样拒 —— 代理就白做了。
  await withProxy(async ({ clientOrigin, gateway }) => {
    await fetch(`${clientOrigin}/api/health`, {
      headers: { Origin: 'http://127.0.0.1:4620' },
    })
    assert.equal(gateway.seen[0].headers.origin, undefined,
      `Origin 被转发了：${gateway.seen[0].headers.origin}`)
  })
})

test('POST 的 body 被转发', async () => {
  await withProxy(async ({ clientOrigin, service }) => {
    const response = await fetch(`${clientOrigin}/api/service/reset?sessionId=x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'retail' }),
    })
    assert.equal(response.status, 200)
    assert.equal(service.seen[0].method, 'POST')
  })
})

test('SSE 逐块转发，不等 body 结束', async () => {
  // 【这条容易写错】按普通请求处理会 await 整个 body ——
  // 而 SSE 永远不结束，页面就一直等着，面板永远空白。
  await withProxy(async ({ clientOrigin }) => {
    const response = await fetch(`${clientOrigin}/api/service/events?sessionId=default`)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const reader = response.body.getReader()
    const { value } = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE 首块超时')), 3_000)),
    ])
    assert.match(new TextDecoder().decode(value), /data: \{"tick":1\}/)
    await reader.cancel()
  })
})

test('上游挂掉时返回 502 并说明是哪个上游', async () => {
  const saved = process.env.CS_GATEWAY_ORIGIN
  process.env.CS_GATEWAY_ORIGIN = 'http://127.0.0.1:1'
  try {
    const fresh = await import(`../server.mjs?down=${Date.now()}`)
    const server = fresh.createClientServer()
    const origin = await listen(server)
    try {
      const response = await fetch(`${origin}/api/health`)
      assert.equal(response.status, 502)
      const body = await response.json()
      // 只说「代理失败」的话，排查要从头再来一遍
      assert.match(body.error, /127\.0\.0\.1:1/)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  } finally {
    if (saved === undefined) delete process.env.CS_GATEWAY_ORIGIN
    else process.env.CS_GATEWAY_ORIGIN = saved
  }
})

test('页面用同源相对路径，不写死上游端口', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  // 直连 18889 会被网关的同源保护拒掉 —— 这是实测踩过的，
  // 而且症状很误导：状态灯是绿的，消息发得出去，只是永远没有回复。
  assert.ok(!html.includes('127.0.0.1:18889/api'), '页面里不该出现直连网关的地址')
  assert.ok(!html.includes('127.0.0.1:3110/api'), '页面里不该出现直连 service 的地址')
  assert.match(html, /const API = ''/)
})

test('页面处理了「网关已被占用」这个错误', () => {
  // 网关一次只接一个客户端（realtime-gateway.mjs:241）。
  // 不显式处理的话，页面看起来一切正常 —— 状态灯绿的、消息发得出去 ——
  // 只是永远等不到回复。第一次实测就卡在这里。
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /client_occupied/)
  assert.match(html, /只接一个客户端/)
})
