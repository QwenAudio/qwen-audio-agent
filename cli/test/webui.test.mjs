import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  browserCommand,
  openBrowser,
  webUiUrl,
} from '../src/webui.mjs'
import {
  isLocalGateway,
  readGatewayHealth,
} from '../src/runtime.mjs'

test('builds a WebUI address with the CLI voice session', () => {
  assert.equal(
    webUiUrl('http://127.0.0.1:3101', '项目一'),
    'http://127.0.0.1:3101/?session=%E9%A1%B9%E7%9B%AE%E4%B8%80',
  )
})

test('recognizes only loopback Gateway addresses as locally startable', () => {
  assert.equal(isLocalGateway('http://127.0.0.1:3101'), true)
  assert.equal(isLocalGateway('http://localhost:3101'), true)
  assert.equal(isLocalGateway('https://voice.example.com'), false)
})

test('uses each platform browser launcher', () => {
  assert.deepEqual(browserCommand('http://localhost', 'darwin'), {
    command: 'open',
    args: ['http://localhost'],
  })
  assert.equal(browserCommand('http://localhost', 'linux').command, 'xdg-open')
  assert.equal(browserCommand('http://localhost', 'win32').command, 'rundll32')
})

test('waits until the browser launcher starts successfully', async () => {
  let unreferenced = false
  const spawnImpl = () => {
    const child = new EventEmitter()
    child.unref = () => {
      unreferenced = true
    }
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  await openBrowser('http://localhost', { platform: 'darwin', spawnImpl })
  assert.equal(unreferenced, true)
})

test('reads a reachable Gateway even when its backend is unhealthy', async () => {
  const health = await readGatewayHealth('http://localhost:3101', async () => ({
    json: async () => ({ ok: false, backend: { ok: false } }),
  }))
  assert.equal(health.backend.ok, false)
})
