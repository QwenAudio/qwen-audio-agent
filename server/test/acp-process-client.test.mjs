import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpProcessClient } from '../src/agent/acp-process-client.mjs'
import { openClawBackendDriver } from '../src/agent/backends/openclaw.mjs'

test('keeps session object identity stable across re-registration', () => {
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
  })
  const first = client.rememberSession('sess-1', { role: 'coordinator' })
  // adapter 在同一引用上维护运行时路由字段（如权限事件回调）。
  const onEvent = () => {}
  first.onEvent = onEvent
  first.coordinationRunId = 'work_current'

  // resume 重新注册后必须仍是同一对象，否则权限请求会拿到
  // 旧闭包快照，被路由到已完成的旧任务上。
  const second = client.rememberSession('sess-1', { cwd: '/next' })
  assert.equal(second, first)
  assert.equal(client.sessions.get('sess-1'), first)
  assert.equal(second.onEvent, onEvent)
  assert.equal(second.coordinationRunId, 'work_current')
  assert.equal(second.cwd, '/next')
  assert.equal(second.role, 'coordinator')
})

test('shares an in-flight ACP initialization across concurrent callers', async () => {
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
  })
  let finishInitialization
  const initialized = {
    protocolVersion: 1,
    agentInfo: { name: 'test-agent' },
  }
  client.startProcess = () => {
    client.context = {}
    client.child = { exitCode: null }
    return new Promise(resolve => {
      finishInitialization = () => {
        client.initializeResult = initialized
        resolve(initialized)
      }
    })
  }

  const first = client.start()
  const second = client.start()
  finishInitialization()

  assert.equal(await first, initialized)
  assert.equal(await second, initialized)
})

test('applies backend-specific ACP error and output formatting hooks', async () => {
  const profile = openClawBackendDriver.createProfile({
    root: '/repo',
    directory: '/work',
    baseUrl: 'http://127.0.0.1:18789',
    tokenFile: '/state/gateway-token',
  })
  const client = new AcpProcessClient({
    label: profile.label,
    command: 'unused',
    sanitizeProcessOutput: profile.sanitizeProcessOutput,
    formatRequestError: profile.formatRequestError,
  })
  client.start = async () => {}
  client.context = {
    async request() {
      const error = new Error('Internal error')
      error.name = 'RequestError'
      error.code = -32603
      error.data = { details: 'missing scope: operator.write' }
      throw error
    },
  }
  client.appendStderr(
    '\u001b[1;36m🦞 [openclaw-bundle]\u001b[0m SafeMode Active\n',
  )

  await assert.rejects(
    client.request('session/prompt', {}),
    error => {
      assert.match(
        error.message,
        /需要在 OpenClaw 中批准 ACP 设备权限（缺少 operator\.write）/,
      )
      assert.doesNotMatch(error.message, /Internal error|openclaw-bundle|\u001b/)
      assert.equal(error.body, 'missing scope: operator.write')
      return true
    },
  )
})

test('pauses the prompt timeout while waiting for user permission', async () => {
  let resolvePermission
  let finishPrompt
  let promptSettled = false
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
    onPermission: () => new Promise(resolve => {
      resolvePermission = resolve
    }),
  })
  client.start = async () => {}
  client.context = {
    request: (_method, _params, { signal }) => new Promise(
      (resolve, reject) => {
        finishPrompt = () => resolve({ stopReason: 'end_turn' })
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      },
    ),
    notify: async () => {},
  }
  client.sessions.set('session-one', { sessionId: 'session-one' })

  const prompting = client.prompt('session-one', 'inspect project', {
    timeoutMs: 30,
  }).finally(() => {
    promptSettled = true
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  const permission = client.handlePermission({
    sessionId: 'session-one',
  }, new AbortController().signal)

  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(promptSettled, false)

  resolvePermission({ outcome: { outcome: 'selected', optionId: 'allow' } })
  await permission
  finishPrompt()
  assert.deepEqual(await prompting, {
    content: '',
    response: { stopReason: 'end_turn' },
  })
})

test('keeps Session metadata and supports the legacy model method', async () => {
  const calls = []
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
  })
  client.start = async () => {}
  client.context = {
    async request(method, params) {
      calls.push([method, params])
      if (method === 'session/new') return { sessionId: 'session-one' }
      return {}
    },
  }
  const meta = { sessionKey: 'agent:voice:coordinator' }

  const session = await client.newSession({
    cwd: '/workspace',
    meta,
  })
  await client.setLegacySessionModel('session-one', 'claude-sonnet')

  assert.equal(session.meta, meta)
  assert.deepEqual(calls.at(-1), [
    'session/set_model',
    {
      sessionId: 'session-one',
      modelId: 'claude-sonnet',
    },
  ])
})
