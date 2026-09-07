import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  GatewayPublicEndpointService,
  TailscaleServePublisher,
  endpointFromOutput,
  tailscaleCommand,
} from '../src/access/gateway-public-endpoint.mjs'

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = signal => {
    queueMicrotask(() => {
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', 0, signal)
    })
    return true
  }
  return child
}

test('extracts the HTTPS origin printed by Tailscale Serve', () => {
  assert.equal(
    endpointFromOutput('Available within your tailnet:\nhttps://voice.example.ts.net\n'),
    'https://voice.example.ts.net',
  )
  assert.equal(endpointFromOutput('http://127.0.0.1:3101'), null)
})

test('finds the CLI bundled in the official macOS Tailscale app', () => {
  assert.equal(tailscaleCommand({
    env: {},
    platform: 'darwin',
    homeDirectory: '/Users/test',
    fileExists: path => path === '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  }), '/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  assert.equal(tailscaleCommand({
    env: { QWEN_AUDIO_TAILSCALE_BINARY: '/custom/tailscale' },
    platform: 'linux',
  }), '/custom/tailscale')
})

test('publishes a loopback Gateway through the installed Tailscale CLI', async () => {
  const child = fakeChild()
  let invocation
  const publisher = new TailscaleServePublisher({
    command: '/usr/local/bin/tailscale',
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options }
      return child
    },
  })
  const starting = publisher.start('http://127.0.0.1:3101')
  child.stderr.write('Available within your tailnet:\n')
  child.stderr.write('https://voice.example.ts.net\n')
  assert.equal(await starting, 'https://voice.example.ts.net')
  assert.equal(invocation.command, '/usr/local/bin/tailscale')
  assert.deepEqual(invocation.args, [
    'serve', '--yes', 'http://127.0.0.1:3101',
  ])
  await publisher.close()
})

test('projects an unexpected Tailscale exit through the endpoint boundary', async () => {
  const child = fakeChild()
  const publisher = new TailscaleServePublisher({ spawnImpl: () => child })
  const endpoint = new GatewayPublicEndpointService({
    tailnet: true,
    publisher,
  })
  const starting = endpoint.start('http://127.0.0.1:3101')
  child.stdout.write('https://voice.example.ts.net\n')
  assert.equal((await starting).state, 'ready')
  child.emit('exit', 1, null)
  assert.equal(endpoint.status().state, 'error')
  assert.equal(endpoint.status().error.code, 'tailscale_serve_exited')
})

test('reports a missing system Tailscale installation clearly', async () => {
  const child = fakeChild()
  const publisher = new TailscaleServePublisher({
    spawnImpl: () => {
      queueMicrotask(() => {
        const error = new Error('spawn tailscale ENOENT')
        error.code = 'ENOENT'
        child.emit('error', error)
      })
      return child
    },
  })
  await assert.rejects(
    publisher.start('http://127.0.0.1:3101'),
    error => error.code === 'tailscale_not_installed'
      && /请先安装并登录/.test(error.message),
  )
})

test('uses an explicit HTTPS endpoint without owning its proxy', async () => {
  const endpoint = new GatewayPublicEndpointService({
    publicUrl: 'https://voice.example.com',
  })
  assert.deepEqual(await endpoint.start('http://127.0.0.1:3101'), {
    mode: 'external',
    state: 'ready',
    endpoint: { url: 'https://voice.example.com', secure: true },
    error: null,
  })
})

test('normalizes Tailnet publication behind the public endpoint boundary', async () => {
  let closed = false
  const endpoint = new GatewayPublicEndpointService({
    tailnet: true,
    publisher: {
      start: async localUrl => {
        assert.equal(localUrl, 'http://127.0.0.1:3101')
        return 'https://voice.example.ts.net'
      },
      close: async () => { closed = true },
    },
  })
  assert.equal((await endpoint.start('http://127.0.0.1:3101')).state, 'ready')
  assert.equal(endpoint.status().endpoint.url, 'https://voice.example.ts.net')
  await endpoint.close()
  assert.equal(closed, true)
  assert.equal(endpoint.status().state, 'stopped')
})
