// 客服工作台的服务器。发一个 index.html，并把网关与 service 的请求代理过去。
//
// 【为什么必须代理 —— 这一条我起先判断错了】
// 第一版写的是「不代理任何请求，页面直接打网关和 service，加一层代理只会多一个
// 可能挂掉的环节」。实测浏览器直接报：
//   WebSocket ws://127.0.0.1:18889/api/realtime → 403
//   fetch http://127.0.0.1:18889/api/... → {"error":"origin not allowed"}
//
// 追到 server/src/core/request-security.mjs：网关做的是 DNS rebinding 防护，
// 而且判据是【origin 的 host 必须等于请求的 host】—— 跨端口无论如何都过不了，
// 连 config.allowedOrigins 也绕不开这一条（它同样要求 host 相等）。
//
// 那不是可以配置放宽的东西，是有意的安全边界。框架自带的 web 界面挂在网关的
// / 路径上，天然同源，所以碰不到这个问题。我们的工作台是独立进程，
// 只能把自己变成同源入口 —— 也就是代理。
//
// service（3110）那边其实开了 Access-Control-Allow-Origin: *，本可以直连。
// 但两套请求走两个地址会让「工作台连不上是谁的问题」难以判断，所以一并代理。

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { connect } from 'node:net'

const PAGE = new URL('./index.html', import.meta.url)

const GATEWAY = process.env.CS_GATEWAY_ORIGIN || 'http://127.0.0.1:18889'
const SERVICE = process.env.CS_SERVICE_ORIGIN || 'http://127.0.0.1:3110'

// /api/service/* 归 service，其余 /api/* 与 WebSocket 归网关。
function upstreamFor(pathname) {
  return pathname.startsWith('/api/service/') ? SERVICE : GATEWAY
}

function isProxied(pathname) {
  return pathname.startsWith('/api/')
}

async function proxyHttp(request, response, url) {
  const target = new URL(url.pathname + url.search, upstreamFor(url.pathname))
  // 【不转发 Origin】转发了就等于把跨源问题原样带给网关。
  // 代理的作用正是让上游看到一个同源请求。
  const headers = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (['host', 'origin', 'referer', 'connection'].includes(key)) continue
    headers[key] = value
  }

  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await new Promise(resolve => {
        const chunks = []
        request.on('data', chunk => chunks.push(chunk))
        request.on('end', () => resolve(Buffer.concat(chunks)))
      })

  let upstream
  try {
    upstream = await fetch(target, { method: request.method, headers, body })
  } catch (error) {
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: `上游不可达：${target.origin} ${error.message}` }))
    return
  }

  const outHeaders = {}
  upstream.headers.forEach((value, key) => {
    // content-encoding 由 fetch 解过了，转发它会让浏览器二次解压失败。
    if (['content-encoding', 'content-length', 'transfer-encoding'].includes(key)) return
    outHeaders[key] = value
  })
  response.writeHead(upstream.status, outHeaders)

  // SSE 要逐块转发，不能等 body 读完 —— 它永远不会结束。
  if (!upstream.body) {
    response.end()
    return
  }
  const reader = upstream.body.getReader()
  const pump = async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      response.write(value)
    }
    response.end()
  }
  pump().catch(() => response.destroy())
}

// WebSocket 升级：直接在 TCP 层对接，不解析帧。
// 【去掉 Origin 头】和 HTTP 那边同一个理由。
function proxyUpgrade(request, socket, head) {
  const upstream = new URL(GATEWAY)
  const target = connect(
    { host: upstream.hostname, port: Number(upstream.port || 80) },
    () => {
      const lines = [`GET ${request.url} HTTP/1.1`]
      for (const [key, value] of Object.entries(request.headers)) {
        if (key === 'origin') continue
        if (key === 'host') {
          lines.push(`host: ${upstream.host}`)
          continue
        }
        lines.push(`${key}: ${value}`)
      }
      target.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length) target.write(head)
      target.pipe(socket)
      socket.pipe(target)
    },
  )
  target.on('error', () => socket.destroy())
  socket.on('error', () => target.destroy())
}

export function createClientServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)

    if (isProxied(url.pathname)) {
      await proxyHttp(request, response, url)
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    // 其余路径一律发同一页 —— 没有路由，刷新任何地址都能进。
    let html
    try {
      html = readFileSync(PAGE)
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(`读不到 index.html：${error.message}`)
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      // 改一行 HTML 刷新就生效。演示界面缓存只会碍事。
      'Cache-Control': 'no-store',
    })
    response.end(html)
  })

  server.on('upgrade', proxyUpgrade)
  return server
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.CS_CLIENT_PORT || 4620)
  createClientServer().listen(port, () => {
    console.log(`客服工作台  http://127.0.0.1:${port}`)
    console.log(`  代理 → 网关 ${GATEWAY} / service ${SERVICE}`)
  })
}
