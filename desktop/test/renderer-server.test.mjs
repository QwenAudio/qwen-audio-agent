import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import {
  startDesktopRendererServer,
} from '../src/renderer-server.mjs'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server) {
  await new Promise(resolveClose => server.close(resolveClose))
}

test('serves bundled assets and proxies only the protected API path', async t => {
  const webRoot = await mkdtemp(resolve(tmpdir(), 'qwaudio-renderer-'))
  await mkdir(resolve(webRoot, 'assets'))
  await writeFile(
    resolve(webRoot, 'index.html'),
    '<!doctype html><script src="./assets/app.js"></script>',
  )
  await writeFile(resolve(webRoot, 'assets/app.js'), 'globalThis.ready = true')
  t.after(() => rm(webRoot, { recursive: true, force: true }))

  let proxyRequest
  const gateway = createServer((request, response) => {
    proxyRequest = {
      host: request.headers.host,
      origin: request.headers.origin,
      url: request.url,
    }
    response.setHeader('content-type', 'application/json')
    response.end('{"ok":true}')
  })
  const gatewayOrigin = await listen(gateway)
  t.after(() => closeServer(gateway))

  const renderer = await startDesktopRendererServer({
    webRoot,
    target: gatewayOrigin,
    token: 'test-token',
  })
  t.after(() => renderer.close())

  const indexResponse = await fetch(`${renderer.baseUrl}?desktop=orb`)
  assert.equal(indexResponse.status, 200)
  assert.match(await indexResponse.text(), /assets\/app\.js/)
  assert.match(
    indexResponse.headers.get('content-security-policy'),
    /connect-src 'self'/,
  )

  const assetResponse = await fetch(`${renderer.baseUrl}assets/app.js`)
  assert.equal(assetResponse.status, 200)
  assert.match(assetResponse.headers.get('content-type'), /text\/javascript/)

  const healthResponse = await fetch(`${renderer.baseUrl}api/health`)
  assert.deepEqual(await healthResponse.json(), { ok: true })
  assert.deepEqual(proxyRequest, {
    host: new URL(gatewayOrigin).host,
    origin: gatewayOrigin,
    url: '/api/health',
  })

  const unprotectedResponse = await fetch(`${renderer.origin}/api/health`)
  assert.equal(unprotectedResponse.status, 404)
})

test('serves imported skin assets without falling back to index.html', async t => {
  const webRoot = await mkdtemp(resolve(tmpdir(), 'qwaudio-renderer-'))
  await writeFile(resolve(webRoot, 'index.html'), '<!doctype html>')
  const skinsRoot = await mkdtemp(resolve(tmpdir(), 'qwaudio-skins-'))
  await mkdir(resolve(skinsRoot, 'firefly--lingxiaotian'))
  await writeFile(
    resolve(skinsRoot, 'firefly--lingxiaotian/pet.json'),
    '{"id":"firefly--lingxiaotian"}',
  )
  await writeFile(
    resolve(skinsRoot, 'firefly--lingxiaotian/spritesheet.webp'),
    Buffer.from('RIFFxxxxWEBP', 'latin1'),
  )
  t.after(() => rm(webRoot, { recursive: true, force: true }))
  t.after(() => rm(skinsRoot, { recursive: true, force: true }))

  const renderer = await startDesktopRendererServer({
    webRoot,
    target: 'http://127.0.0.1:9',
    skinsRoot,
    token: 'test-token',
  })
  t.after(() => renderer.close())

  const manifestResponse = await fetch(
    `${renderer.baseUrl}skins/firefly--lingxiaotian/pet.json`,
  )
  assert.equal(manifestResponse.status, 200)
  assert.match(
    manifestResponse.headers.get('content-type'),
    /application\/json/,
  )
  assert.equal(manifestResponse.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await manifestResponse.json(), {
    id: 'firefly--lingxiaotian',
  })

  const sheetResponse = await fetch(
    `${renderer.baseUrl}skins/firefly--lingxiaotian/spritesheet.webp`,
  )
  assert.equal(sheetResponse.status, 200)
  assert.match(sheetResponse.headers.get('content-type'), /image\/webp/)

  // 皮肤资源缺失直接 404，不回退 index.html。
  const missingResponse = await fetch(
    `${renderer.baseUrl}skins/missing/pet.json`,
  )
  assert.equal(missingResponse.status, 404)

  // 路径穿越被拒绝。
  const traversalResponse = await fetch(
    `${renderer.baseUrl}skins/%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
  )
  assert.equal(traversalResponse.status, 404)

  // 非 GET/HEAD 拒绝。
  const postResponse = await fetch(
    `${renderer.baseUrl}skins/firefly--lingxiaotian/pet.json`,
    { method: 'POST' },
  )
  assert.equal(postResponse.status, 405)

  // 未配置 skinsRoot 时皮肤路由不可用。
  const bare = await startDesktopRendererServer({
    webRoot,
    target: 'http://127.0.0.1:9',
    token: 'bare-token',
  })
  t.after(() => bare.close())
  const disabledResponse = await fetch(
    `${bare.baseUrl}skins/firefly--lingxiaotian/pet.json`,
  )
  assert.equal(disabledResponse.status, 404)
})

test('relays the protected realtime WebSocket to the Gateway', async t => {
  let upgradeRequest
  const gateway = createServer()
  const gatewaySockets = new WebSocketServer({ noServer: true })
  gateway.on('upgrade', (request, socket, head) => {
    upgradeRequest = {
      origin: request.headers.origin,
      url: request.url,
    }
    gatewaySockets.handleUpgrade(request, socket, head, websocket => {
      websocket.on('message', message => websocket.send(`echo:${message}`))
    })
  })
  const gatewayOrigin = await listen(gateway)
  t.after(async () => {
    gatewaySockets.close()
    await closeServer(gateway)
  })

  const webRoot = await mkdtemp(resolve(tmpdir(), 'qwaudio-renderer-'))
  await writeFile(resolve(webRoot, 'index.html'), '<!doctype html>')
  t.after(() => rm(webRoot, { recursive: true, force: true }))
  const renderer = await startDesktopRendererServer({
    webRoot,
    target: gatewayOrigin,
    token: 'test-token',
  })
  t.after(() => renderer.close())

  const websocketUrl = (
    `${renderer.baseUrl}api/realtime?sessionId=desktop-test`
  ).replace('http:', 'ws:')
  const websocket = new WebSocket(websocketUrl, {
    origin: renderer.origin,
  })
  await once(websocket, 'open')
  websocket.send('hello')
  const [message] = await once(websocket, 'message')
  assert.equal(message.toString(), 'echo:hello')
  assert.deepEqual(upgradeRequest, {
    origin: gatewayOrigin,
    url: '/api/realtime?sessionId=desktop-test',
  })
  websocket.close()
  await once(websocket, 'close')
})
