import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createClientServer } from '../server.mjs'
import { createMicrophoneStream, createPlaybackQueue, VOICE_DEFAULTS } from '../voice.mjs'

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
    // 【必须先掐断连接再 close】server.close() 只停止接受新连接，
    // 已建立的连接它会一直等。SSE 那条测试里假上游故意不 end，
    // 代理的转发循环因此永不结束 —— 于是 close 的回调永不触发，
    // 整个测试文件挂死在第 7 条上（实测：120 秒没有任何输出）。
    for (const server of [client, gateway.server, service.server]) {
      server.closeAllConnections?.()
    }
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

test('/voice.mjs 返回 JS 模块，不被兜底路由吃成 HTML', async () => {
  // 【上一条测试正是这条的隐患来源】"任意路径都发同一页"会把 /voice.mjs
  // 也回成 HTML，浏览器报 "Expected a JavaScript module but got text/html"，
  // 而页面其余部分照常工作 —— 只有语音按钮点了没反应。
  const server = createClientServer()
  const origin = await listen(server)
  try {
    const response = await fetch(`${origin}/voice.mjs`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /javascript/)
    assert.match(await response.text(), /export function pcmBase64/)
  } finally {
    await new Promise(resolve => server.close(resolve))
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

test('页面声明了语音能力，且客户选择器有自己的样式', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  // 语音形态只能在 connect 事件里声明，所以按钮必须走重连那条路。
  assert.match(html, /id="talk"/)
  assert.match(html, /voiceEnabled: voiceWanted/)
  assert.match(html, /audio: voiceWanted/)
  assert.match(html, /type: 'audio\.append'/)
  // 【客户选择器曾经完全没有样式】原先写的是 class="surface-toggle"，
  // 而那个类只定义在 console/index.html 里 —— 四个客户名字于是裸着挨在
  // 一起（"赵宇孙丽周涛吴敏"），实测被当成了一个人名。
  assert.ok(!html.includes("el('div', 'surface-toggle')"),
    '客户选择器不能再用 client 里没有定义的 surface-toggle 类')
  assert.match(html, /\.picker span \{/)
  // 【客户页不展示出口审计】维护者在 PR QwenAudio#301 明确提出：客户页不该
  // 出现工具调用、审批令牌、内部审计这类信息。出口审计原先会给每轮客服的话
  // 标一条「违规」红标（.turn.violation / .audit-flag），还会误报客服照实说出
  // 的真实金额 —— 客户根本看不懂，也不该看到。审计能力保留在后端
  // （/api/service/audit 仍在，测试仍覆盖），只是不再画到客户页上。
  assert.ok(!html.includes('auditTurn'), '客户页仍在逐轮调出口审计')
  assert.ok(!html.includes("'/api/service/audit'") && !html.includes('/api/service/audit?'),
    '客户页仍在请求 /api/service/audit')
  assert.ok(!html.includes('audit-flag') && !html.includes('turn.violation'),
    '客户页仍残留违规红标的样式或类')
  // 【客户页不能有文字输入框】维护者在 PR QwenAudio#301 明确提出：客户打电话
  // 不会打字，留着输入框会让演示走上"打字也能办成"的岔路。
  assert.ok(!html.includes('id="say"'), '客户页仍然有文字输入框')
  assert.ok(!html.includes("type: 'text.message'"), '客户页仍然能发文字消息')
})

test('页面处理了「网关已被占用」这个错误', () => {
  // 网关一次只接一个客户端（realtime-gateway.mjs:241）。
  // 不显式处理的话，页面看起来一切正常 —— 状态灯绿的、消息发得出去 ——
  // 只是永远等不到回复。第一次实测就卡在这里。
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /client_occupied/)
  assert.match(html, /只接一个客户端/)
})

// 直接执行页面的通话控制段，覆盖授权弹窗和按钮之间的异步竞态。
function voicePage() {
  const elements = new Map()
  const contexts = []
  const timers = new Map()
  let nextTimer = 0
  let grant
  let deny
  let requests = 0
  let stopped = 0
  const sandbox = {
    $: id => {
      if (!elements.has(id)) elements.set(id, {})
      return elements.get(id)
    },
    navigator: { mediaDevices: { getUserMedia: () => {
      requests += 1
      return new Promise((resolve, reject) => { grant = resolve; deny = reject })
    } } },
    AudioContext: class {
      constructor() { this.state = 'running'; contexts.push(this) }
      close() { this.closed = true }
      createMediaStreamSource() { return { connect() {}, disconnect() {} } }
      createScriptProcessor() { return { connect() {}, disconnect() {} } }
    },
    createMicrophoneStream, createPlaybackQueue, VOICE_DEFAULTS,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout: id => timers.delete(id),
  }
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const script = html.slice(html.indexOf('let socket = null'), html.indexOf("$('reset').onclick"))
  runInNewContext(`${script}\nglobalThis.controls = { wanted: () => voiceWanted };`, sandbox)
  return {
    click: () => sandbox.$('talk').onclick(),
    grant: () => grant({ getTracks: () => [{ stop() { stopped += 1 } }] }),
    deny: () => deny(new Error('旧通话授权被拒绝')),
    elements, contexts, timers,
    wanted: sandbox.controls.wanted,
    stats: () => ({ requests, stopped }),
  }
}

test('页面授权未返回时可挂断，迟到授权不能重新接通或恢复按钮', async () => {
  const page = voicePage()
  const pending = page.click()
  assert.equal(page.contexts.length, 1, '播放上下文必须在点击路径同步创建')
  assert.equal(page.wanted(), true)
  await page.click()
  assert.equal(page.wanted(), false)
  assert.equal(page.contexts[0].closed, true)
  page.grant()
  await pending
  assert.deepEqual(page.stats(), { requests: 1, stopped: 1 })
  assert.equal(page.contexts.length, 1, '挂断后不能再创建采集上下文')
  assert.equal(page.elements.get('talk').innerHTML, '开始语音通话')
  assert.equal(page.timers.size, 1, '只能留下退出语音模式的重连')
  assert.equal(page.wanted(), false)
})

test('页面旧通话授权失败不干扰已挂断状态', async () => {
  const page = voicePage()
  const pending = page.click()
  await page.click()
  const before = page.elements.get('status').textContent
  page.deny()
  await pending
  assert.equal(page.elements.get('status').textContent, before)
  assert.equal(page.wanted(), false)
  assert.equal(page.timers.size, 1)
})
