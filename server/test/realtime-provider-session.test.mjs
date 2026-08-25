import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeProviderSession } from '../src/voice/realtime-provider-session.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function harness({
  connectMode = 'manual',
  shouldReconnect = false,
  maxPendingAudioChunks = 2,
} = {}) {
  const calls = []
  const frontends = []
  const profiles = {
    dashscope: {
      key: 'dashscope',
      label: 'DashScope',
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      classifyError: message => String(message).includes('invalid')
        ? 'fatal'
        : String(message).includes('busy') ? 'capacity_busy' : 'other',
    },
    s2s: {
      key: 's2s',
      label: 'Speech-to-Speech',
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      classifyError: () => 'other',
    },
  }
  const providerRegistry = {
    resolve(name) {
      const profile = profiles[name]
      if (!profile) throw new Error(`unknown provider: ${name}`)
      return profile
    },
  }
  const createFrontend = options => {
    const connection = deferred()
    const frontend = {
      provider: profiles[options.providerName],
      ready: false,
      connect: () => {
        calls.push(['connect', options.providerName])
        if (connectMode === 'resolve') connection.resolve()
        if (connectMode === 'reject') connection.reject(new Error('connect failed'))
        return connection.promise.then(() => {
          frontend.ready = true
        })
      },
      appendAudio: audio => calls.push(['appendAudio', audio]),
      cancel: () => calls.push(['cancel']),
      close: () => calls.push(['close', options.providerName]),
      updateAgentContext: context => calls.push(['updateAgentContext', context]),
      triggerError: error => options.onError(error),
      triggerClose: () => {
        frontend.ready = false
        options.onClose()
      },
      resolveConnect: connection.resolve,
      rejectConnect: connection.reject,
    }
    frontends.push(frontend)
    return frontend
  }
  const runtime = new RealtimeProviderSession({
    providerRegistry,
    defaultProvider: 'dashscope',
    getAgentContext: () => ({ client: { locale: 'zh-CN' } }),
    shouldReconnect: () => shouldReconnect,
    onEvent: event => calls.push(['event', event]),
    onDiagnostic: value => calls.push(['diagnostic', value]),
    onConnected: () => calls.push(['onConnected']),
    onReady: () => calls.push(['onReady']),
    onDisconnected: () => calls.push(['onDisconnected']),
    onReconnected: () => calls.push(['onReconnected']),
    onConnectionState: state => calls.push(['state', state]),
    onError: error => calls.push(['error', error.message]),
    onReconnectError: error => calls.push(['reconnectError', error.message]),
    logger: {
      info: (...args) => calls.push(['log.info', ...args]),
      warn: (...args) => calls.push(['log.warn', ...args]),
      error: (...args) => calls.push(['log.error', ...args]),
    },
    maxPendingAudioChunks,
    stableConnectionMs: 10_000,
    createFrontend,
    reconnectBackoff: {
      next: () => 1,
      reset: () => calls.push(['backoff.reset']),
    },
  })
  return { runtime, calls, frontends }
}

test('shares one connection attempt and flushes bounded audio before ready', async () => {
  const { runtime, calls, frontends } = harness()

  runtime.appendAudio('oldest')
  runtime.appendAudio('middle')
  runtime.appendAudio('latest')
  const shared = runtime.ensure()
  assert.equal(shared, runtime.connectPromise)
  assert.equal(frontends.length, 1)

  frontends[0].resolveConnect()
  await shared

  assert.equal(runtime.ready, true)
  assert.deepEqual(
    calls.filter(([name]) => name === 'appendAudio'),
    [['appendAudio', 'middle'], ['appendAudio', 'latest']],
  )
  assert.ok(
    calls.findIndex(([name]) => name === 'onConnected')
      < calls.findIndex(([name]) => name === 'appendAudio'),
  )
  assert.ok(
    calls.findIndex(([name]) => name === 'appendAudio')
      < calls.findIndex(([name]) => name === 'onReady'),
  )
})

test('unexpected close reconnects once through the shared backoff', async () => {
  const { runtime, calls, frontends } = harness({
    connectMode: 'resolve',
    shouldReconnect: true,
  })
  await runtime.ensure()

  frontends[0].triggerClose()
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(frontends.length, 2)
  assert.equal(runtime.ready, true)
  assert.equal(
    calls.filter(([name]) => name === 'onReconnected').length,
    1,
  )
  assert.equal(
    calls.some(([, state]) => state?.state === 'unavailable'),
    true,
  )
})

test('fatal errors block later connection attempts and clear buffered audio', async () => {
  const { runtime, frontends } = harness({ connectMode: 'resolve' })
  await runtime.ensure()
  runtime.appendAudio('buffered-directly')

  runtime.block('invalid api key')

  assert.equal(runtime.ready, false)
  assert.equal(runtime.pendingAudio.length, 0)
  await assert.rejects(runtime.ensure(), /invalid api key/)
  assert.deepEqual(runtime.status(), {
    provider: 'dashscope',
    state: 'unavailable',
    error: 'invalid api key',
  })
  assert.equal(frontends.length, 1)
})

test('switching providers detaches the old frontend without losing queued audio', async () => {
  const { runtime, frontends } = harness()
  const connecting = runtime.ensure()
  runtime.pendingAudio.push('queued')

  assert.equal(runtime.switchProvider('s2s'), true)
  assert.equal(runtime.providerKey, 's2s')
  assert.deepEqual(runtime.pendingAudio, ['queued'])
  assert.equal(runtime.ready, false)

  frontends[0].resolveConnect()
  await connecting
  const replacement = runtime.ensure()
  frontends[1].resolveConnect()
  await replacement
  assert.equal(frontends[1].provider.key, 's2s')
})

test('capacity-busy connection failures stay silent and retryable', async () => {
  const { runtime, calls, frontends } = harness()
  const connection = runtime.ensure()
  frontends[0].rejectConnect(new Error('pipeline busy'))

  await assert.rejects(connection, /pipeline busy/)

  assert.equal(runtime.blockedError, '')
  assert.equal(
    calls.some(([, state]) => state?.state === 'unavailable'),
    false,
  )
})

test('explicit close can notify disconnection without a duplicate close callback', async () => {
  const { runtime, calls, frontends } = harness({ connectMode: 'resolve' })
  await runtime.ensure()

  runtime.close({ notifyDisconnected: true })
  frontends[0].triggerClose()

  assert.equal(runtime.ready, false)
  assert.equal(
    calls.filter(([name]) => name === 'onDisconnected').length,
    1,
  )
})
