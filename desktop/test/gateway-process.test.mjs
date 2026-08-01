import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  desktopExecutablePath,
  desktopGatewayEnvironment,
  EmbeddedGateway,
  GATEWAY_READY_MESSAGE,
} from '../src/gateway-process.mjs'

function fakeChild({
  readyOrigin = 'http://127.0.0.1:3101',
  exitOnKill = true,
} = {}) {
  const child = new EventEmitter()
  child.killed = 0
  child.kill = () => {
    child.killed += 1
    if (exitOnKill) queueMicrotask(() => child.emit('exit', 0, null))
    return true
  }
  child.reportReady = origin => child.emit('message', {
    type: GATEWAY_READY_MESSAGE,
    origin,
  })
  if (readyOrigin) {
    queueMicrotask(() => child.reportReady(readyOrigin))
  }
  return child
}

function deferred() {
  let resolvePromise
  const promise = new Promise(resolve => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function harness({
  busy = false,
  childFactory = null,
  probeImpl = null,
  readyOrigin,
  stopTimeoutMs = 50,
} = {}) {
  const forks = []
  const gateway = new EmbeddedGateway({
    entry: '/app/server/src/index.mjs',
    probeImpl: probeImpl || (async () => busy),
    forkImpl: (entry, args, options) => {
      const child = childFactory
        ? childFactory(forks.length)
        : fakeChild({ readyOrigin })
      forks.push({ entry, args, options, child })
      return child
    },
    startupTimeoutMs: 200,
    stopTimeoutMs,
  })
  return { forks, gateway }
}

test('starts the embedded gateway on the preferred port and adopts the reported origin', async () => {
  const { forks, gateway } = harness()
  const origin = await gateway.start()
  assert.equal(origin, 'http://127.0.0.1:3101')
  assert.equal(forks.length, 1)
  assert.equal(forks[0].options.env.PORT, '3101')
  assert.equal(forks[0].options.env.HOST, '127.0.0.1')
  assert.equal(gateway.running, true)
  await gateway.stop()
})

test('falls back to a random port when the preferred port is busy', async () => {
  const { forks, gateway } = harness({
    busy: true,
    readyOrigin: 'http://127.0.0.1:53123',
  })
  const origin = await gateway.start({ preferredPort: 3101 })
  assert.equal(forks[0].options.env.PORT, '0')
  assert.equal(origin, 'http://127.0.0.1:53123')
  await gateway.stop()
})

test('shares one in-flight start promise and forks only one child', async () => {
  const probe = deferred()
  const { forks, gateway } = harness({
    probeImpl: () => probe.promise,
  })
  const first = gateway.start({ preferredPort: 3200 })
  const second = gateway.start({ preferredPort: 3300 })
  assert.equal(first, second)
  assert.equal(forks.length, 0)

  probe.resolve(false)
  assert.equal(await first, 'http://127.0.0.1:3101')
  assert.equal(forks.length, 1)
  assert.equal(forks[0].options.env.PORT, '3200')
  await gateway.stop()
})

test('clears a failed start so a later call can retry', async () => {
  const { forks, gateway } = harness({
    childFactory: index => fakeChild({
      readyOrigin: index === 0
        ? 'http://example.com'
        : 'http://127.0.0.1:3200',
    }),
  })

  await assert.rejects(gateway.start(), /must use HTTPS/)
  assert.equal(forks[0].child.killed, 1)
  assert.equal(gateway.running, false)

  assert.equal(await gateway.start(), 'http://127.0.0.1:3200')
  assert.equal(forks.length, 2)
  assert.equal(gateway.running, true)
  await gateway.stop()
})

test('stop cancels a start still probing without forking a child', async () => {
  const probe = deferred()
  const { forks, gateway } = harness({
    probeImpl: () => probe.promise,
  })
  const start = gateway.start()
  const cancelled = assert.rejects(start, /启动已取消/)
  const stopped = gateway.stop()

  probe.resolve(false)
  await Promise.all([cancelled, stopped])
  assert.equal(forks.length, 0)
  assert.equal(gateway.child, null)
  assert.equal(gateway.origin, null)
  assert.equal(gateway.running, false)
})

test('restart replaces an in-flight start and ignores stale child events', async () => {
  let staleChild
  let freshChild
  const { forks, gateway } = harness({
    childFactory: index => {
      const child = index === 0
        ? fakeChild({ readyOrigin: null, exitOnKill: false })
        : fakeChild({ readyOrigin: 'http://127.0.0.1:3200' })
      if (index === 0) staleChild = child
      else freshChild = child
      return child
    },
    stopTimeoutMs: 5,
  })
  let unexpectedExit = false
  gateway.onUnexpectedExit = () => {
    unexpectedExit = true
  }

  const firstStart = gateway.start()
  const cancelled = assert.rejects(firstStart, /启动已取消/)
  await Promise.resolve()
  assert.equal(forks.length, 1)

  const origin = await gateway.restart({ preferredPort: 3200 })
  await cancelled
  assert.equal(origin, 'http://127.0.0.1:3200')
  assert.equal(forks.length, 2)
  assert.equal(gateway.child, freshChild)

  staleChild.reportReady('http://127.0.0.1:3999')
  staleChild.emit('exit', 1, null)
  assert.equal(gateway.origin, 'http://127.0.0.1:3200')
  assert.equal(gateway.child, freshChild)
  assert.equal(gateway.running, true)
  assert.equal(unexpectedExit, false)
  await gateway.stop()
})

test('rejects and kills the child when the gateway exits before ready', async () => {
  const { forks, gateway } = harness({ readyOrigin: null })
  const start = gateway.start()
  queueMicrotask(() => forks[0].child.emit('exit', 1, null))
  await assert.rejects(start, /提前退出/)
  assert.equal(forks[0].child.killed, 1)
  assert.equal(gateway.running, false)
})

test('rejects when the gateway never reports readiness', async () => {
  const { forks, gateway } = harness({ readyOrigin: null })
  await assert.rejects(gateway.start(), /启动超时/)
  assert.equal(forks[0].child.killed, 1)
})

test('restart stops the old child and starts a fresh one', async () => {
  const { forks, gateway } = harness()
  await gateway.start()
  const origin = await gateway.restart({ preferredPort: 3200 })
  assert.equal(origin, 'http://127.0.0.1:3101')
  assert.equal(forks.length, 2)
  assert.equal(forks[0].child.killed, 1)
  assert.equal(forks[1].options.env.PORT, '3200')
  await gateway.stop()
})

test('notifies unexpected exits after a successful start', async () => {
  const { forks, gateway } = harness()
  await gateway.start()
  let exitSignal = null
  gateway.onUnexpectedExit = (code, signal) => {
    exitSignal = { code, signal }
  }
  forks[0].child.emit('exit', 1, null)
  assert.deepEqual(exitSignal, { code: 1, signal: null })
  assert.equal(gateway.running, false)
})

test('planned stops do not count as unexpected exits', async () => {
  const { forks, gateway } = harness()
  await gateway.start()
  let notified = false
  gateway.onUnexpectedExit = () => {
    notified = true
  }
  await gateway.stop()
  await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  assert.equal(notified, false)
  assert.equal(forks[0].child.killed, 1)
})

test('rebuilds the child environment for each gateway start', async () => {
  const forks = []
  let apiKey = 'first'
  const gateway = new EmbeddedGateway({
    entry: '/app/server/src/index.mjs',
    envFactory: () => ({ DASHSCOPE_API_KEY: apiKey }),
    probeImpl: async () => false,
    forkImpl: (entry, args, options) => {
      const child = fakeChild()
      forks.push({ entry, args, options, child })
      return child
    },
    startupTimeoutMs: 200,
    stopTimeoutMs: 50,
  })
  await gateway.start()
  apiKey = 'second'
  await gateway.restart()
  assert.equal(forks[0].options.env.DASHSCOPE_API_KEY, 'first')
  assert.equal(forks[1].options.env.DASHSCOPE_API_KEY, 'second')
  await gateway.stop()
})

test('desktop gateway environment applies saved settings and packaged roots', () => {
  const environment = desktopGatewayEnvironment({
    env: {
      PATH: '/usr/bin',
      QWEN_AUDIO_REALTIME_API_KEY: 'stale',
    },
    configured: {
      DASHSCOPE_API_KEY: 'saved',
      AGENT_PROTOCOL: 'none',
    },
    runtimeRoot: '/Applications/Qwen.app/Contents/Resources/runtime',
    sourceRoot: '/Applications/Qwen.app/Contents/Resources/app.asar',
    platform: 'linux',
  })
  assert.equal(environment.DASHSCOPE_API_KEY, 'saved')
  assert.equal(environment.QWEN_AUDIO_REALTIME_API_KEY, 'saved')
  assert.equal(environment.AGENT_PROTOCOL, 'none')
  assert.equal(environment.QWEN_AUDIO_AGENT_DESKTOP, '1')
  assert.equal(environment.QWEN_AUDIO_AGENT_DESKTOP_INSTALLED_ONLY, '1')
  assert.equal(
    environment.QWEN_AUDIO_AGENT_RUNTIME_ROOT,
    '/Applications/Qwen.app/Contents/Resources/runtime',
  )
  assert.equal(
    environment.QWEN_AUDIO_AGENT_SOURCE_ROOT,
    '/Applications/Qwen.app/Contents/Resources/app.asar',
  )
})

test('macOS desktop PATH inherits the expanded process PATH plus common locations', () => {
  // 主进程入口的 expandProcessPath 已把登录 shell PATH 合入 process.env
  // （此处用 /custom/bin 模拟），这里只叠加常见安装目录，不再调用 shell。
  const path = desktopExecutablePath({
    env: {
      PATH: '/custom/bin:/usr/bin',
      HOME: '/Users/tester',
      SHELL: '/bin/zsh',
    },
    platform: 'darwin',
  })
  assert.deepEqual(path.split(':'), [
    '/Users/tester/.local/bin',
    '/Users/tester/.npm-global/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/custom/bin',
    '/usr/bin',
  ])
})
