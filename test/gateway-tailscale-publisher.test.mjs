import assert from 'node:assert/strict'
import test from 'node:test'
import { createTailscaleGatewayEndpointPublisher } from '../shared/gateway-tailscale-publisher.mjs'

function runner({ serve = {} } = {}) {
  const calls = []
  const run = async args => {
    calls.push(args)
    if (args[0] === 'status') {
      return { stdout: JSON.stringify({
        BackendState: 'Running',
        Self: { DNSName: 'voice.example.ts.net.' },
      }) }
    }
    if (args[0] === 'serve' && args[1] === 'status') {
      return { stdout: JSON.stringify(serve) }
    }
    return { stdout: '' }
  }
  return { calls, run }
}

test('Tailscale publisher exposes a dedicated HTTPS port without touching Gateway Core', async () => {
  const fake = runner()
  const publisher = createTailscaleGatewayEndpointPublisher({ run: fake.run })
  assert.deepEqual(await publisher.publish(), {
    url: 'https://voice.example.ts.net:8443',
    secure: true,
    publisher: 'tailscale',
  })
  assert.deepEqual(fake.calls.at(-1), [
    'serve', '--bg', '--yes', '--https=8443', 'http://127.0.0.1:3101',
  ])
})

test('Tailscale publisher reuses only its exact existing route', async () => {
  const serve = {
    TCP: { 8443: { HTTPS: true } },
    Web: {
      'voice.example.ts.net:8443': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:3101' } },
      },
    },
  }
  const fake = runner({ serve })
  const publisher = createTailscaleGatewayEndpointPublisher({ run: fake.run })
  assert.equal((await publisher.inspect()).published, true)
  await publisher.publish()
  assert.equal(fake.calls.filter(call => call.includes('--bg')).length, 0)
  assert.deepEqual(await publisher.unpublish(), { published: false, changed: true })
  assert.deepEqual(fake.calls.at(-1), ['serve', '--https=8443', 'off'])
})

test('Tailscale publisher refuses to overwrite unrelated Serve configuration', async () => {
  const fake = runner({
    serve: {
      Web: {
        'voice.example.ts.net:8443': {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } },
        },
      },
    },
  })
  const publisher = createTailscaleGatewayEndpointPublisher({ run: fake.run })
  await assert.rejects(
    publisher.publish(),
    error => error.code === 'tailscale_serve_port_occupied',
  )
})

test('Tailscale publisher reports missing and logged-out installations distinctly', async () => {
  const missing = createTailscaleGatewayEndpointPublisher({
    run: async () => { throw Object.assign(new Error('missing'), { code: 'tailscale_not_installed' }) },
  })
  assert.deepEqual(await missing.inspect(), {
    available: false,
    connected: false,
    published: false,
    error: 'tailscale_not_installed',
  })

  const loggedOut = createTailscaleGatewayEndpointPublisher({
    run: async () => ({ stdout: JSON.stringify({ BackendState: 'NeedsLogin' }) }),
  })
  assert.equal((await loggedOut.inspect()).backendState, 'NeedsLogin')
})
