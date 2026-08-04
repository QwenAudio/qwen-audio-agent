import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { runDesktopHost } from '../src/desktop-host.mjs'

const SESSION_TOKEN = '41'.repeat(32)

class FakeGateway extends EventEmitter {
  constructor() {
    super()
    this.calls = []
    this.status = {
      state: 'stopping',
      origin: null,
      retry: 0,
      delayMs: null,
      reason: null,
    }
    this.restartResults = []
  }

  async start() {
    this.calls.push(['start'])
    this.status = {
      state: 'ready',
      origin: 'http://127.0.0.1:43127',
      retry: 0,
      delayMs: null,
      reason: null,
    }
    this.emit('status', { ...this.status })
    return this.status.origin
  }

  async restart() {
    this.calls.push(['restart'])
    if (this.restartResults.length) {
      const result = this.restartResults.shift()
      if (result instanceof Error) throw result
      return result
    }
    this.status = {
      ...this.status,
      state: 'ready',
      origin: 'http://127.0.0.1:43128',
    }
    this.emit('status', { ...this.status })
    return this.status.origin
  }

  async stop() {
    this.calls.push(['stop'])
    this.status = {
      ...this.status,
      state: 'stopping',
      origin: null,
    }
    this.emit('status', { ...this.status })
  }

  tailLogs({ limit }) {
    this.calls.push(['logs', limit])
    return [{ stream: 'stderr', message: 'Bearer [REDACTED]' }]
  }
}

function lineInbox(stream) {
  let buffered = ''
  const queued = []
  const waiters = []
  const seen = []
  const deliver = message => {
    seen.push(message)
    const waiter = waiters.shift()
    if (waiter) waiter.resolve(message)
    else queued.push(message)
  }
  stream.on('data', chunk => {
    buffered += chunk.toString('utf8')
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line) deliver(JSON.parse(line))
      newline = buffered.indexOf('\n')
    }
  })
  return {
    seen,
    next(timeoutMs = 2_000) {
      if (queued.length) return Promise.resolve(queued.shift())
      return new Promise((resolvePromise, rejectPromise) => {
        const waiter = {
          resolve: value => {
            clearTimeout(timer)
            resolvePromise(value)
          },
        }
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          rejectPromise(new Error('Timed out waiting for desktop-host output'))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    async nextMatching(predicate, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const message = await this.next(Math.max(1, deadline - Date.now()))
        if (predicate(message)) return message
      }
      throw new Error('Timed out waiting for matching desktop-host output')
    },
  }
}

function createHarness({ gateway = new FakeGateway() } = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  const signalSource = new EventEmitter()
  const inbox = lineInbox(output)
  const diagnostics = []
  errorOutput.on('data', chunk => diagnostics.push(chunk.toString('utf8')))
  const state = {
    content: [
      '# existing comment',
      'DASHSCOPE_API_KEY=old-secret',
      'SPEECH_TO_SPEECH_AUTH_TOKEN=s2s-secret',
      'AGENT_PROTOCOL=opencode',
      '',
    ].join('\n'),
    runtimeLoads: 0,
    writes: [],
    inspections: [],
  }
  const hostEnvironment = {
    QWEN_AUDIO_DESKTOP_SESSION_TOKEN: SESSION_TOKEN,
    WSL_DISTRO_NAME: 'Ubuntu',
  }
  state.hostEnvironment = hostEnvironment
  const running = runDesktopHost({
    input,
    output,
    errorOutput,
    dependencies: {
      env: hostEnvironment,
      root: '/runtime',
      signalSource,
      packageVersion: '1.2.0',
      nodeVersion: '22.22.2',
      loadRuntimeEnvironment() {
        state.runtimeLoads += 1
        return {
          configDirectory: '/home/user/.config/qwaudio',
          configPath: '/home/user/.config/qwaudio/config.env',
        }
      },
      createGateway: () => gateway,
      readFile: async path => {
        assert.equal(path, '/home/user/.config/qwaudio/config.env')
        return state.content
      },
      writeFileAtomic: async (path, content, options) => {
        state.writes.push({ path, content, options })
        state.content = content
      },
      inspectBackendSetups: options => {
        state.inspections.push(options)
        return {
          selected: options.backend,
          readOnly: true,
          backends: [{ id: 'opencode', ready: true }],
        }
      },
    },
  })
  let requestNumber = 0
  return {
    input,
    output,
    signalSource,
    inbox,
    diagnostics,
    gateway,
    state,
    running,
    async request(method, params = {}) {
      const id = `request-${++requestNumber}`
      input.write(`${JSON.stringify({ id, method, params })}\n`)
      return inbox.nextMatching(message => message.id === id)
    },
  }
}

test('serves every desktop-host RPC method without exposing settings secrets', async () => {
  const target = createHarness()
  assert.deepEqual(await target.inbox.next(), {
    event: 'hello',
    data: {
      protocol: 1,
      packageVersion: '1.2.0',
      nodeVersion: '22.22.2',
      distribution: 'Ubuntu',
    },
  })
  assert.equal(target.state.runtimeLoads, 1)
  assert.equal(
    Object.hasOwn(
      target.state.hostEnvironment,
      'QWEN_AUDIO_DESKTOP_SESSION_TOKEN',
    ),
    false,
  )

  const runtime = await target.request('runtime.status')
  assert.equal(runtime.ok, true)
  assert.equal(runtime.result.gateway.state, 'stopping')
  assert.equal(runtime.result.distribution, 'Ubuntu')

  const settings = await target.request('settings.read')
  assert.deepEqual(settings.result.settings.dashscopeApiKey, {
    configured: true,
  })
  assert.deepEqual(settings.result.settings.speechToSpeechAuthToken, {
    configured: true,
  })
  assert.doesNotMatch(JSON.stringify(settings), /old-secret|s2s-secret/)

  const backends = await target.request('backends.inspect', {
    backend: 'opencode',
  })
  assert.equal(backends.result.backends[0].ready, true)
  assert.equal(target.state.inspections[0].backend, 'opencode')

  const started = await target.request('gateway.start', {
    sessionToken: SESSION_TOKEN,
  })
  assert.deepEqual(started.result, {
    origin: 'http://127.0.0.1:43127',
  })
  assert.equal(target.inbox.seen.some(message => (
    message.event === 'gateway.ready'
    && message.data.origin === 'http://127.0.0.1:43127'
  )), true)

  const restarted = await target.request('gateway.restart', {
    sessionToken: SESSION_TOKEN,
  })
  assert.equal(restarted.result.origin, 'http://127.0.0.1:43128')

  const logs = await target.request('logs.tail', { limit: 12 })
  assert.deepEqual(logs.result.logs, [{
    stream: 'stderr',
    message: 'Bearer [REDACTED]',
  }])

  const saved = await target.request('settings.write', {
    sessionToken: SESSION_TOKEN,
    settings: {
      agentProtocol: 'codex',
      dashscopeApiKey: 'new-secret',
      speechToSpeechAuthToken: { configured: true },
    },
  })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.result.settings.dashscopeApiKey, {
    configured: true,
  })
  assert.deepEqual(saved.result.settings.speechToSpeechAuthToken, {
    configured: true,
  })
  assert.match(target.state.content, /AGENT_PROTOCOL=codex/)
  assert.match(target.state.content, /DASHSCOPE_API_KEY=new-secret/)
  assert.match(target.state.content, /SPEECH_TO_SPEECH_AUTH_TOKEN=s2s-secret/)
  assert.equal(target.state.writes.at(-1).options.mode, 0o600)
  assert.doesNotMatch(JSON.stringify(saved), /new-secret|s2s-secret/)

  const stopped = await target.request('gateway.stop', {
    sessionToken: SESSION_TOKEN,
  })
  assert.deepEqual(stopped.result, { stopped: true })

  const shutdown = await target.request('host.shutdown', {
    sessionToken: SESSION_TOKEN,
  })
  assert.deepEqual(shutdown.result, { shuttingDown: true })
  assert.equal(await target.running, 0)
  assert.equal(target.state.runtimeLoads, 1)
  assert.doesNotMatch(target.diagnostics.join(''), /old-secret|new-secret|s2s-secret/)
})

test('returns request errors with the same id and keeps the host alive', async () => {
  const target = createHarness()
  await target.inbox.next()

  target.input.write(
    '{"id":"unknown-method","method":"shell.execute","params":{}}\n',
  )
  const unknown = await target.inbox.nextMatching(
    message => message.id === 'unknown-method',
  )
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'invalid_request')

  const invalid = await target.request('logs.tail', { limit: 0 })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'invalid_params')

  const unauthorized = await target.request('gateway.start', {
    sessionToken: '00'.repeat(32),
  })
  assert.equal(unauthorized.ok, false)
  assert.equal(unauthorized.error.code, 'unauthorized')

  const healthy = await target.request('runtime.status')
  assert.equal(healthy.ok, true)

  await target.request('host.shutdown', { sessionToken: SESSION_TOKEN })
  assert.equal(await target.running, 0)
  assert.doesNotMatch(
    JSON.stringify(target.inbox.seen) + target.diagnostics.join(''),
    new RegExp(SESSION_TOKEN),
  )
})

test('rolls back settings and retries the previous Gateway after restart failure', async () => {
  const gateway = new FakeGateway()
  gateway.restartResults.push(
    new Error('restart failed with Bearer rollback-secret'),
    'http://127.0.0.1:43127',
  )
  const target = createHarness({ gateway })
  await target.inbox.next()
  const previous = target.state.content

  const response = await target.request('settings.write', {
    sessionToken: SESSION_TOKEN,
    settings: { agentProtocol: 'codex' },
  })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'settings_restart_failed')
  assert.equal(target.state.content, previous)
  assert.equal(target.state.writes.length, 2)
  assert.deepEqual(
    gateway.calls.filter(call => call[0] === 'restart'),
    [['restart'], ['restart']],
  )
  assert.doesNotMatch(JSON.stringify(response), /rollback-secret/)

  assert.equal((await target.request('runtime.status')).ok, true)
  await target.request('host.shutdown', { sessionToken: SESSION_TOKEN })
  assert.equal(await target.running, 0)
})

test('uses one idempotent shutdown path for EOF and termination signals', async t => {
  for (const trigger of ['EOF', 'SIGHUP', 'SIGINT', 'SIGTERM']) {
    await t.test(trigger, async () => {
      const target = createHarness()
      await target.inbox.next()
      if (trigger === 'EOF') target.input.end()
      else target.signalSource.emit(trigger)
      assert.equal(await target.running, 0)
      assert.equal(
        target.gateway.calls.filter(call => call[0] === 'stop').length,
        1,
      )
    })
  }
})

test('terminates when the client sends a message in the wrong direction', async () => {
  const target = createHarness()
  await target.inbox.next()
  target.input.write(
    '{"event":"gateway.status","data":{"state":"ready"}}\n',
  )

  assert.equal(await target.running, 0)
  assert.equal(
    target.gateway.calls.filter(call => call[0] === 'stop').length,
    1,
  )
  assert.match(target.diagnostics.join(''), /request envelope/i)
})

test('rejects the no-Gateway override before loading production state', async () => {
  let runtimeLoads = 0
  await assert.rejects(runDesktopHost({
    input: new PassThrough(),
    output: new PassThrough(),
    errorOutput: new PassThrough(),
    dependencies: {
      root: '/runtime',
      env: {
        QWEN_AUDIO_DESKTOP_SESSION_TOKEN: SESSION_TOKEN,
        QWEN_AUDIO_DESKTOP_HOST_DISABLE_GATEWAY: '1',
        NODE_ENV: 'production',
      },
      loadRuntimeEnvironment() {
        runtimeLoads += 1
        return {}
      },
    },
  }), /requires NODE_ENV=test/)
  assert.equal(runtimeLoads, 0)
})
