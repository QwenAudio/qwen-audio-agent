// 人工坐席界面 —— 一个「有响应」的最小实现。
//
// 【它是什么，不是什么】
// 是：转接发生时这一页立刻亮起来，坐席能看到是谁、为什么转、之前办了什么。
// 不是：真的人工客服。它【不回复客户】—— 回复要接回语音会话，
//      而那需要「人接管语音通道」的机制，不在这个 demo 的范围内。
//
// 为什么值得单独做一页：转人工是四个「出口」里唯一没有可见结果的。
// 退货看得到订单状态变、退票看得到余额回来，而转人工在客服界面上
// 只留一句「已转接」—— 演示时看不出到底转到哪去了。有这一页就能说清：
// 转接是真的把上下文交出去了，不是一句话敷衍。
//
// 数据从 service 的 SSE 来，和客服工作台同一个源 —— 不新增后端。

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadServiceEnvironment } from '../bootstrap/environment.mjs'

const PAGE = fileURLToPath(new URL('./index.html', import.meta.url))

// 和 client/server.mjs 同样的理由：不能让浏览器直连 service ——
// 跨端口会被 DNS rebinding 防护拦下（origin host 必须等于请求 host）。
// 所以这里也做一层同源代理。
function proxyTarget(url) {
  if (url.pathname.startsWith('/api/service/')) {
    return process.env.CS_SERVICE_ORIGIN || 'http://127.0.0.1:3110'
  }
  return null
}

async function forward(request, response, url, origin) {
  const target = new URL(url.pathname + url.search, origin)
  const headers = {}
  for (const [key, value] of Object.entries(request.headers)) {
    // 不转发 host / origin —— 转了就等于把跨源问题原样带给 service。
    if (['host', 'origin', 'referer', 'connection'].includes(key)) continue
    headers[key] = value
  }
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request,
    duplex: 'half',
  })
  response.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
    ...(upstream.headers.get('cache-control')
      ? { 'cache-control': upstream.headers.get('cache-control') }
      : {}),
  })
  if (!upstream.body) {
    response.end()
    return
  }
  // SSE 要逐块转发，不能等 body 读完 —— 它永远不会结束。
  //
  // 【转发循环的错误必须在这里就地处理】headers 在上面已经发出去了，
  // 一旦坐席关掉标签页，write 就写到已断开的 socket 上、reader.read() 抛错。
  // 如果让它冒泡到外层 catch，那里会再 writeHead(502) —— 而 headers 已发送，
  // 于是抛 ERR_HTTP_HEADERS_SENT，这一次没人接，整个进程退出。
  // 实测就是这样死的：打开航空坐席台再关掉，4730 就没了（cs-both.log 里
  // 「[airline/desk] 退出，code=1」）。演示中途坐席台会突然打不开。
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      response.write(value)
    }
    response.end()
  } catch {
    // 客户端走了，没有对象可以回报错误，掐断连接就是全部要做的事。
    response.destroy()
  }
}

export function createDeskServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
    try {
      const origin = proxyTarget(url)
      if (origin) {
        await forward(request, response, url, origin)
        return
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(readFileSync(PAGE))
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
    } catch (error) {
      // 【必须先看 headersSent】兜底的 502 只有在还没回过任何东西时才发得出去。
      // 上面 forward 已经就地吞掉了转发中途的错误，但代理之外还有别的路径，
      // 这一层保证任何漏网的异常都不会把进程带走。
      if (response.headersSent) {
        response.destroy()
        return
      }
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`upstream error: ${error.message}`)
    }
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  loadServiceEnvironment()
  const port = Number(process.env.CS_DESK_PORT || 4630)
  createDeskServer().listen(port, () => {
    console.log(`人工坐席台  http://127.0.0.1:${port}`)
    console.log(`  service → ${process.env.CS_SERVICE_ORIGIN || 'http://127.0.0.1:3110'}`)
  })
}
