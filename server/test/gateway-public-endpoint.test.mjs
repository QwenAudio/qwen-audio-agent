import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  GatewayPublicEndpointService,
} from '../src/access/gateway-public-endpoint.mjs'
import {
  TailscaleServePublisher,
  endpointFromOutput,
  confirmsServeEndpoint,
  tailscaleCommand,
} from '../src/access/tailscale-serve.mjs'

function serveStatus(target = 'http://127.0.0.1:3101') {
  return { Foreground: { session: {
    TCP: { 443: { HTTPS: true } },
    Web: { 'voice.example.ts.net:443': { Handlers: { '/': { Proxy: target } } } },
  } } }
}

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
  assert.equal(endpointFromOutput('To authenticate: https://login.tailscale.com/a/secret'), null)
  assert.equal(endpointFromOutput('https://login.tailscale.com'), null)
  assert.equal(endpointFromOutput('https://tailscale.com/docs'), null)
})

test('readiness requires a private foreground HTTPS root proxy to the right target', () => {
  const endpoint = 'https://voice.example.ts.net'
  const target = 'http://127.0.0.1:3101'
  assert.equal(confirmsServeEndpoint(serveStatus(), endpoint, target), true)
  assert.equal(confirmsServeEndpoint(serveStatus('http://127.0.0.1:9999'), endpoint, target), false)
  assert.equal(confirmsServeEndpoint(serveStatus().Foreground.session, endpoint, target), false)
  for (const field of ['TCP', 'Web']) {
    const status = serveStatus()
    delete status.Foreground.session[field]
    assert.equal(confirmsServeEndpoint(status, endpoint, target), false)
  }
  const funnel = serveStatus()
  funnel.AllowFunnel = { 'voice.example.ts.net:443': true }
  assert.equal(confirmsServeEndpoint(funnel, endpoint, target), false)
})

test('a consent URL cannot make the publisher ready', async () => {
  const child = fakeChild()
  let queried = false
  const publisher = new TailscaleServePublisher({
    spawnImpl: () => child, readStatus: async () => { queried = true; return serveStatus() },
  })
  const starting = publisher.start('http://127.0.0.1:3101')
  const cancelled = assert.rejects(starting, { code: 'tailscale_serve_cancelled' })
  child.stderr.write('https://login.tailscale.com/a/secret\n')
  await delay(1)
  assert.equal(publisher.status().state, 'starting')
  assert.equal(queried, false)
  await publisher.close()
  await cancelled
})

test('closing a pending start cancels its deadline and ignores late status replies', async () => {
  const child = fakeChild()
  let resolveStatus
  const publisher = new TailscaleServePublisher({
    spawnImpl: () => child, timeoutMs: 15,
    readStatus: () => new Promise(resolve => { resolveStatus = resolve }),
  })
  const starting = publisher.start('http://127.0.0.1:3101')
  const cancelled = assert.rejects(starting, { code: 'tailscale_serve_cancelled' })
  child.stdout.write('https://voice.example.ts.net\n')
  await publisher.close()
  await cancelled
  resolveStatus(serveStatus())
  await delay(30)
  assert.deepEqual(publisher.status(), { state: 'stopped', endpoint: null, error: null })
})

test('timeout preserves the original error and terminates an unresponsive Serve child', async () => {
  const child = fakeChild()
  const signals = []
  child.kill = signal => {
    signals.push(signal)
    if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, signal))
    return true
  }
  const publisher = new TailscaleServePublisher({
    spawnImpl: () => child, timeoutMs: 10, shutdownMs: 10,
    readStatus: async () => serveStatus('http://127.0.0.1:9999'),
  })
  const rejected = assert.rejects(publisher.start('http://127.0.0.1:3101'), { code: 'tailscale_serve_timeout' })
  child.stdout.write('https://voice.example.ts.net\n')
  await Promise.all([rejected, delay(40)])
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(publisher.status().error.code, 'tailscale_serve_timeout')
  await publisher.close()
})

test('retries transient status failures within one startup and stops probing after ready', async () => {
  const child = fakeChild()
  let calls = 0
  const publisher = new TailscaleServePublisher({
    spawnImpl: () => child, probeIntervalMs: 1,
    readStatus: async () => {
      if (++calls === 1) throw new Error('temporarily unavailable')
      return serveStatus()
    },
  })
  const starting = publisher.start('http://127.0.0.1:3101')
  child.stdout.write('https://voice.example.ts.net\n')
  const [endpoint] = await Promise.all([starting, delay(20)])
  assert.equal(endpoint, 'https://voice.example.ts.net')
  assert.equal(calls, 2)
  await publisher.close()
})

test('the endpoint service cannot resurrect after closing during startup', async () => {
  let resolveStart
  const service = new GatewayPublicEndpointService({ tailnet: true, publisher: {
    start: () => new Promise(resolve => { resolveStart = resolve }), close: async () => {},
  } })
  const starting = service.start('http://127.0.0.1:3101')
  await service.close()
  resolveStart('https://voice.example.ts.net')
  await starting
  assert.equal(service.status().state, 'stopped')
  assert.equal(service.status().endpoint, null)
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
    readStatus: async () => serveStatus(),
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
  const publisher = new TailscaleServePublisher({ spawnImpl: () => child, readStatus: async () => serveStatus() })
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
