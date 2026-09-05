import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  GatewayRemoteAccessService,
  ensureTsnetComponent,
} from '../src/access/gateway-remote-access-service.mjs'

function fakeResponse(body, { status = 200 } = {}) {
  const bytes = Buffer.from(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-length': String(bytes.length) }),
    arrayBuffer: async () => bytes,
  }
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

test('downloads, verifies, and installs the platform tsnet component once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwa-tsnet-download-'))
  const executable = Buffer.from('test executable')
  const archive = gzipSync(executable)
  const checksum = createHash('sha256').update(archive).digest('hex')
  const requested = []
  const fetchImpl = async url => {
    requested.push(url)
    return url.endsWith('.sha256')
      ? fakeResponse(`${checksum}  component.gz\n`)
      : fakeResponse(archive)
  }
  const first = await ensureTsnetComponent({
    configDirectory: directory,
    version: '9.9.9',
    platform: 'linux',
    arch: 'x64',
    env: { QWEN_AUDIO_TSNET_DOWNLOAD_BASE_URL: 'https://components.example.test/v9.9.9' },
    fetchImpl,
  })
  assert.equal(first.source, 'downloaded')
  assert.equal(readFileSync(first.path, 'utf8'), 'test executable')
  assert.equal(requested.length, 2)

  const second = await ensureTsnetComponent({
    configDirectory: directory,
    version: '9.9.9',
    platform: 'linux',
    arch: 'x64',
    env: { QWEN_AUDIO_TSNET_DOWNLOAD_BASE_URL: 'https://unused.example.test' },
    fetchImpl: async () => { throw new Error('must not download twice') },
  })
  assert.equal(second.source, 'installed')
  assert.equal(second.path, first.path)
})

test('rejects a remote component whose published checksum does not match', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwa-tsnet-checksum-'))
  const archive = gzipSync('not trusted')
  await assert.rejects(
    ensureTsnetComponent({
      configDirectory: directory,
      version: '9.9.8',
      platform: 'linux',
      arch: 'x64',
      env: { QWEN_AUDIO_TSNET_DOWNLOAD_BASE_URL: 'https://components.example.test' },
      fetchImpl: async url => url.endsWith('.sha256')
        ? fakeResponse(`${'0'.repeat(64)}  component.gz\n`)
        : fakeResponse(archive),
    }),
    error => error.code === 'tsnet_checksum_mismatch',
  )
})

test('Gateway owns tsnet authorization, endpoint state, persistence, and shutdown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwa-tsnet-service-'))
  const child = fakeChild()
  let spawnCall
  const service = new GatewayRemoteAccessService({
    configDirectory: directory,
    spawnImpl: (command, args) => {
      spawnCall = { command, args }
      return child
    },
    ensureComponent: async () => ({ path: '/tmp/qwaudio-tsnet', source: 'test' }),
  })
  const enabling = service.enable('http://127.0.0.1:3101')
  await new Promise(resolve => setImmediate(resolve))
  child.stdout.write(`${JSON.stringify({
    type: 'auth_required',
    url: 'https://login.tailscale.com/a/example',
  })}\n`)
  const awaitingAuth = await enabling
  assert.equal(awaitingAuth.state, 'auth_required')
  assert.equal(awaitingAuth.published, false)
  assert.match(spawnCall.args.join(' '), /127\.0\.0\.1:3101/)
  assert.equal(
    JSON.parse(readFileSync(join(directory, 'state', 'remote-access.json'))).enabled,
    true,
  )

  child.stdout.write(`${JSON.stringify({
    type: 'endpoint_ready',
    url: 'https://voice.example.ts.net',
  })}\n`)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.status().state, 'connected')
  assert.equal(service.status().endpoint.url, 'https://voice.example.ts.net')

  const disabled = await service.disable()
  assert.equal(disabled.state, 'disabled')
  assert.equal(disabled.published, false)
  assert.equal(
    JSON.parse(readFileSync(join(directory, 'state', 'remote-access.json'))).enabled,
    false,
  )
  assert.equal(existsSync(join(directory, 'state', 'tsnet')), false)
})

test('preserves actionable Funnel setup errors after the component exits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwa-tsnet-action-'))
  const child = fakeChild()
  const service = new GatewayRemoteAccessService({
    configDirectory: directory,
    spawnImpl: () => child,
    ensureComponent: async () => ({ path: '/tmp/qwaudio-tsnet', source: 'test' }),
  })
  const enabling = service.enable('http://127.0.0.1:3101')
  await new Promise(resolve => setImmediate(resolve))
  child.stdout.write(`${JSON.stringify({
    type: 'error',
    code: 'funnel_start_failed',
    message: 'Funnel requires HTTPS',
    action_url: 'https://tailscale.com/s/https',
  })}\n`)
  child.emit('exit', 1, null)

  const failed = await enabling
  assert.equal(failed.state, 'error')
  assert.equal(failed.error.code, 'funnel_start_failed')
  assert.equal(failed.actionUrl, 'https://tailscale.com/s/https')
})
