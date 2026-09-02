import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import { createGatewayApplication } from '../src/app/gateway-application.mjs'
import { config } from '../src/core/config.mjs'
import { createRealtimeProviderRegistry } from '../src/voice/providers/provider-registry.mjs'
import { openAiCompatibleProtocol } from '../src/voice/providers/openai-compatible-protocol.mjs'

function disabledBackend() {
  return {
    enabled: false,
    describe: () => ({
      configured: false,
      enabled: false,
      protocol: 'none',
      label: 'No backend',
      capabilities: {},
    }),
    start: async () => ({ ok: false, configured: false }),
    health: async () => ({ ok: false, configured: false }),
    submit: async () => { throw new Error('Backend is disabled') },
    status: async () => null,
    cancel: async () => ({ state: 'not_found' }),
    respondAuthorization: async () => ({ state: 'not_found' }),
    respondInput: async () => ({ state: 'not_found' }),
    subscribe: () => () => {},
    close: async () => {},
    canRecoverDelegatedWork: () => false,
    recoverDelegatedWork: async () => null,
  }
}

function customTaskAnnouncementRuntime() {
  const methods = names => Object.fromEntries(
    names.map(name => [name, () => {}]),
  )
  return {
    results: methods([
      'completed',
      'failed',
      'dismissActive',
      'confirmMany',
      'retryMany',
      'flush',
      'pause',
      'close',
    ]),
    progress: methods(['offer', 'remove', 'clear', 'flush', 'close']),
  }
}

test('passes the Task announcement factory through the application composition root', async () => {
  const calls = []
  const application = createGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    frontendMcp: null,
    frontendOpenApi: null,
    taskAnnouncementFactory: options => {
      calls.push(options)
      return customTaskAnnouncementRuntime()
    },
  })
  application.start()
  if (!application.server.listening) await once(application.server, 'listening')
  const { port } = application.server.address()
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/realtime?sessionId=announcement-factory`,
  )
  try {
    await once(socket, 'open')
    assert.equal(calls.length, 1)
    assert.equal(typeof calls[0].resultOptions.getFrontend, 'function')
    assert.equal(typeof calls[0].progressOptions.isTaskActive, 'function')
  } finally {
    socket.close()
    await application.close()
  }
})

test('constructs an injectable Gateway without binding a port on import', async () => {
  const inputAssets = { kind: 'test-input-assets' }
  const privateProvider = {
    key: 'private-realtime',
    label: 'Private Realtime',
    visibility: 'gateway-only',
    inputSampleRate: 16000,
    outputSampleRate: 24000,
    protocol: openAiCompatibleProtocol,
    model: () => 'private-model',
    voice: () => null,
    isConfigured: () => true,
    url: () => 'wss://private.example/realtime',
    headers: () => ({}),
    classifyError: () => 'other',
    buildSession: () => ({}),
    buildSpeakResponse: () => ({}),
    buildResultInjection: () => ({}),
    buildPermissionInjection: () => ({}),
  }
  const realtimeProviderRegistry = createRealtimeProviderRegistry({
    providers: [privateProvider],
  })
  const frontendProfile = {
    configured: true,
    name: 'test-profile',
    description: 'Test frontend composition',
  }
  let mcpClosed = false
  let openApiClosed = false
  const frontendMcp = {
    describe: () => ({ key: 'mcp', label: 'Test MCP' }),
    initialize: async () => [],
    tools: () => [],
    execute: async () => ({}),
    health: () => ({
      ok: true,
      initialized: true,
      tools: 0,
      servers: [],
    }),
    close: async () => { mcpClosed = true },
  }
  const frontendOpenApi = {
    describe: () => ({ key: 'openapi', label: 'Test OpenAPI' }),
    initialize: async () => [],
    tools: () => [],
    execute: async () => ({}),
    health: () => ({
      ok: true,
      initialized: true,
      tools: 0,
      apis: [],
    }),
    close: async () => { openApiClosed = true },
  }
  const application = createGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
      frontendProfile,
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    inputAssets,
    realtimeProviderRegistry,
    realtimeProvider: privateProvider.key,
    frontendMcp,
    frontendOpenApi,
  })
  assert.equal(application.server.listening, false)
  assert.equal(application.services.taskManager != null, true)
  assert.equal(application.services.backendRuntime != null, true)
  assert.equal(application.services.inputAssets, inputAssets)
  assert.equal(application.services.knowledgeProvider, null)
  assert.equal(application.services.frontendKnowledge, null)
  assert.equal(application.services.frontendMcp, frontendMcp)
  assert.equal(application.services.frontendOpenApi, frontendOpenApi)

  application.start()
  if (!application.server.listening) {
    await once(application.server, 'listening')
  }
  assert.equal(application.server.listening, true)
  const address = application.server.address()
  const health = await fetch(`http://127.0.0.1:${address.port}/api/health`)
    .then(response => response.json())
  assert.equal(health.realtimeProvider, privateProvider.key)
  assert.deepEqual(health.frontendRetrieval.capabilities, ['url-fetch'])
  assert.equal(health.frontendRetrieval.searchProvider, null)
  assert.deepEqual(health.frontendKnowledge, {
    configured: false,
    capabilities: [],
    provider: null,
  })
  assert.deepEqual(health.frontendProfile, frontendProfile)
  assert.deepEqual(health.frontendMcp, {
    ok: true,
    initialized: true,
    tools: 0,
    servers: [],
  })
  assert.deepEqual(health.frontendOpenApi, {
    ok: true,
    initialized: true,
    tools: 0,
    apis: [],
  })
  assert.equal(
    health.realtimeProviders.some(provider => provider.key === privateProvider.key),
    false,
  )
  await application.close()
  assert.equal(mcpClosed, true)
  assert.equal(openApiClosed, true)
})

test('serves the bounded conversation projection without exposing journal records', async () => {
  const calls = []
  let closed = false
  const conversationHistory = {
    start: () => 0,
    messages: async context => {
      calls.push(context)
      return [{
        id: 'message-1',
        role: 'user',
        content: 'restored',
        source: 'voice-user',
      }]
    },
    close: () => { closed = true },
  }
  const application = createGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    conversationHistory,
    frontendMcp: null,
    frontendOpenApi: null,
  })
  application.start()
  if (!application.server.listening) await once(application.server, 'listening')
  const { port } = application.server.address()
  const response = await fetch(
    `http://127.0.0.1:${port}/api/conversations/desktop-session/messages`,
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    messages: [{
      id: 'message-1',
      role: 'user',
      content: 'restored',
      source: 'voice-user',
    }],
  })
  assert.deepEqual(calls, [{
    ownerId: config.personalOwnerId,
    sessionId: 'desktop-session',
  }])
  await application.close()
  assert.equal(closed, true)
})

test('enables knowledge only when an external provider is injected', async () => {
  let closed = false
  const knowledgeProvider = {
    describe: () => ({
      protocolVersion: 1,
      key: 'external-rag',
      label: 'External RAG',
      capabilities: { filters: true },
    }),
    retrieve: async () => ({ results: [] }),
    close: async () => { closed = true },
  }
  const application = createGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    knowledgeProvider,
    frontendMcp: null,
    frontendOpenApi: null,
  })

  assert.equal(application.services.knowledgeProvider, knowledgeProvider)
  assert.deepEqual(application.services.frontendKnowledge.describe(), {
    configured: true,
    capabilities: ['knowledge'],
    provider: {
      protocolVersion: 1,
      key: 'external-rag',
      label: 'External RAG',
      capabilities: { filters: true },
    },
  })
  await application.close()
  assert.equal(closed, true)
})

test('replaces Markdown memory through the public provider boundary', async () => {
  let closed = false
  const memoryProvider = {
    describe: () => ({
      protocolVersion: 1,
      key: 'external-memory',
      label: 'External Memory',
    }),
    list: ownerId => [{
      id: `memory_${ownerId}`,
      scope: 'memory',
      content: '- External fact',
      format: 'markdown',
      revision: 'revision-one',
    }],
    apply: async () => ({ changed: 0, documents: [] }),
    health: () => ({ ok: true, external: true }),
    close: async () => { closed = true },
  }
  const application = createGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    memoryProvider,
    frontendMcp: null,
    frontendOpenApi: null,
  })

  assert.equal(application.services.memoryProvider, memoryProvider)
  assert.equal(application.services.frontendMemoryService, memoryProvider)
  assert.deepEqual(application.services.frontendMemory.describe(), {
    configured: true,
    provider: {
      protocolVersion: 1,
      key: 'external-memory',
      label: 'External Memory',
    },
  })
  assert.match(
    application.services.frontendMemory.list('owner')[0].content,
    /External fact/,
  )
  assert.deepEqual(application.services.frontendMemory.health(), {
    ok: true,
    external: true,
    configured: true,
    provider: {
      protocolVersion: 1,
      key: 'external-memory',
      label: 'External Memory',
    },
  })
  await application.close()
  assert.equal(closed, true)
})

test('can disable memory without constructing the default provider', async () => {
  const application = createGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    memoryProvider: null,
    frontendMcp: null,
    frontendOpenApi: null,
  })

  assert.equal(application.services.memoryProvider, null)
  assert.equal(application.services.frontendMemory, null)
  assert.equal(application.services.frontendMemoryService, null)
  await application.close()
})

test('serves and edits frontend memory through the generic client control plane', async () => {
  const calls = []
  const documents = [{
    id: 'memory_document',
    scope: 'memory',
    content: '# MEMORY\n\n- 用户喜欢茶',
    format: 'markdown',
    revision: 'revision-one',
    editable: true,
  }]
  const frontendMemory = {
    list: ownerId => {
      calls.push({ kind: 'list', ownerId })
      return documents
    },
    apply: async (ownerId, changes, context) => {
      calls.push({ kind: 'apply', ownerId, changes, context })
      if (changes[0]?.expectedRevision === 'stale') {
        throw Object.assign(new Error('memory document changed'), {
          code: 'stale_document',
        })
      }
      return { changed: 1, documents: [] }
    },
    health: () => ({ ok: true, configured: true, provider: { key: 'test' } }),
    close: async () => {},
  }
  const application = createGatewayApplication({
    config: {
      ...config,
      port: 0,
      memoryAutoEnabled: false,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    frontendMemory,
    frontendMcp: null,
    frontendOpenApi: null,
  })
  application.start()
  if (!application.server.listening) await once(application.server, 'listening')
  const { port } = application.server.address()
  const origin = `http://127.0.0.1:${port}`
  try {
    const listed = await fetch(`${origin}/api/memory`)
    assert.equal(listed.status, 200)
    assert.deepEqual(await listed.json(), { documents })

    const invalid = await fetch(`${origin}/api/memory`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes: [] }),
    })
    assert.equal(invalid.status, 400)

    const stale = await fetch(`${origin}/api/memory`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        changes: [{
          document: 'memory',
          expectedRevision: 'stale',
          edits: [{ old_text: '- 用户喜欢茶', new_text: '' }],
        }],
      }),
    })
    assert.equal(stale.status, 409)
    assert.deepEqual(await stale.json(), {
      error: 'memory document changed',
      code: 'stale_document',
    })

    const changes = [{
      document: 'memory',
      expectedRevision: 'revision-one',
      edits: [{ old_text: '- 用户喜欢茶', new_text: '' }],
    }]
    const edited = await fetch(`${origin}/api/memory`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changes }),
    })
    assert.equal(edited.status, 200)
    assert.deepEqual(await edited.json(), { changed: 1, documents: [] })
    assert.deepEqual(calls.at(-1), {
      kind: 'apply',
      ownerId: config.personalOwnerId,
      changes,
      context: { source: 'gateway-memory-api' },
    })
  } finally {
    await application.close()
  }
})

// 接线契约：新增的记忆模块默认关闭，显式开启时才装配。
// config 是模块级单例（import 时已读完 env），所以这里注入伪 config
// 而不是改 process.env —— 后者在同一进程内无效。
test('leaves the new memory modules unwired unless explicitly enabled', async () => {
  const app = createGatewayApplication({
    config: { ...config, reminderSchedulerEnabled: false },
    autoStart: false,
  })
  try {
    assert.equal(app.services.preferenceCandidates, null)
    assert.equal(app.services.preferencePromoter, null)
    assert.equal(app.services.sessionDigests, null)
    assert.equal(app.services.sessionSummariser, null)
    assert.equal(app.services.domainLibrary, null)
    assert.equal(app.services.domainSummariser, null)
  } finally {
    await app.close()
  }
})

// 资料库是独立开关，而且资料本体必须落在后端读得到的目录里。
test('wires the domain library on its own switch and imports a local file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-domain-wire-'))
  const source = join(directory, '手册.md')
  writeFileSync(source, '# 信用卡业务手册\n\n## 年费规则\n普卡首年免年费。\n')
  const documents = join(directory, 'workspace', 'domain')
  const app = createGatewayApplication({
    config: {
      ...config,
      reminderSchedulerEnabled: false,
      domainLibraryEnabled: true,
      domainDocumentDirectory: documents,
      domainIndexPath: join(directory, 'domain-index.json'),
    },
    autoStart: false,
  })
  try {
    const { domainLibrary } = app.services
    assert.ok(domainLibrary)
    // 会话摘要没开，两者互不牵连
    assert.equal(app.services.sessionDigests, null)

    const entry = domainLibrary.import({ ownerId: 'user_personal', sourcePath: source })
    // 落盘位置就是交给后端的地址
    assert.equal(entry.path, join(documents, '手册.md'))
    assert.match(readFileSync(entry.path, 'utf8'), /年费规则/)
    assert.equal(
      domainLibrary.search({ ownerId: 'user_personal', keyword: '手册' }).length,
      1,
    )
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

// PDF / Word 走后台转换，而这条路径此前没有任何测试执行过 —— 它曾经调用一个
// 早已不存在的 coordinator 变量，运行时必抛 ReferenceError，而全套测试照样全绿。
// 所以这条测试要真的把 runner 跑起来，不能只断言接线。
test('converts a PDF through the BackendPort and ingests what the backend wrote', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-domain-convert-'))
  const source = join(directory, 'manual.pdf')
  writeFileSync(source, '%PDF-1.7 pretend this is a PDF')
  const documents = join(directory, 'workspace', 'domain')
  const submitted = []
  const application = createGatewayApplication({
    config: {
      ...config,
      port: 0,
      webSearchProvider: 'none',
      webSearchMcpUrl: '',
      reminderSchedulerEnabled: false,
      domainLibraryEnabled: true,
      domainDocumentDirectory: documents,
      domainIndexPath: join(directory, 'domain-index.json'),
    },
    parentPort: null,
    autoStart: false,
    agent: disabledBackend(),
    frontendMcp: null,
    frontendOpenApi: null,
    // 最小 BackendPort 替身：把「提取文字」做成真的写文件 —— 收录那一步是以
    // 文件系统为准、不看后端的回话，所以只回一句话的替身过不了这条测试。
    backendRuntime: {
      run: async (input, options) => {
        submitted.push({ input, options })
        const target = input.objective.match(/原样写入「(.+?)」/)[1]
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, '# Manual\n\n## Warranty\nOne year.\n')
        return { content: 'done' }
      },
      cancel: async taskId => ({ taskId, state: 'cancelled' }),
    },
  })
  try {
    application.start()
    if (!application.server.listening) await once(application.server, 'listening')
    const { port } = application.server.address()

    const accepted = await fetch(`http://127.0.0.1:${port}/api/domain/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: source }),
    }).then(response => response.json())
    assert.ok(accepted.task_id, `导入应当派出后台任务，实际返回 ${JSON.stringify(accepted)}`)

    await application.services.taskManager.wait(accepted.task_id)

    // 关键断言：请求真的经过了 BackendPort，而不是某个具体后台实现
    assert.equal(submitted.length, 1)
    const [{ input, options }] = submitted
    assert.match(input.objective, /原样写入/, '目标路径要在 objective 里')
    assert.ok(options.ownerId, 'ownerId 必须透传')
    assert.ok(options.taskId, 'taskId 必须透传，取消与状态查询都靠它')
    assert.ok(options.signal, 'signal 必须透传，否则取消传不到后端')
    assert.equal(typeof options.onEvent, 'function', 'onEvent 必须透传，否则没有进度')

    // 后端写下的文件被收录了
    const [entry] = application.services.domainLibrary.list(options.ownerId)
    assert.equal(entry.path, join(documents, 'manual.md'))
    assert.match(readFileSync(entry.path, 'utf8'), /Warranty/)
  } finally {
    await application.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('defaults the domain document directory into the shared backend workspace', () => {
  // 后端默认 cwd 是 ${configDirectory}/workspace，资料放它下面后端才读得到
  assert.match(config.domainDocumentDirectory, /workspace[/\\]domain$/)
})

// 会话摘要是独立开关：它不依赖偏好自更新，也不该被后者带起来。
test('wires session digests and the summariser on their own switch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-digest-wire-'))
  const app = createGatewayApplication({
    config: {
      ...config,
      reminderSchedulerEnabled: false,
      memoryAutoEnabled: true,
      memoryApiKey: 'test-key',
      sessionDigestEnabled: true,
      sessionDigestPath: join(directory, 'session-digests.json'),
      memoryAuditPath: join(directory, 'audit.jsonl'),
    },
    autoStart: false,
  })
  try {
    const { sessionDigests, sessionSummariser } = app.services
    assert.ok(sessionDigests)
    assert.ok(sessionSummariser)
    assert.equal(sessionSummariser.enabled(), true)
    // 偏好自更新没开，两者互不牵连
    assert.equal(app.services.preferenceCandidates, null)

    // 端到端：记一场会话 → 能按话题查回来
    sessionDigests.record({
      ownerId: 'user_personal',
      sessionId: 's_a',
      topics: ['LOCOMO'],
      gist: '跑了一轮压缩评测',
      turns: 9,
    })
    const found = sessionDigests.search({ ownerId: 'user_personal', keyword: 'LOCOMO' })
    assert.equal(found.length, 1)
    assert.equal(found[0].gist, '跑了一轮压缩评测')
    // 必须落盘，否则重启即清零、「前几天聊的」永远答不上
    assert.match(
      readFileSync(join(directory, 'session-digests.json'), 'utf8'),
      /LOCOMO/,
    )
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('wires rolling summary and preference learning when enabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-wire-'))
  const app = createGatewayApplication({
    config: {
      ...config,
      reminderSchedulerEnabled: false,
      memoryAutoEnabled: true,
      memoryApiKey: 'test-key',
      preferenceLearningEnabled: true,
      preferenceCandidatePath: join(directory, 'candidates.json'),
      userModelPath: join(directory, 'USER.md'),
      frontendMemoryPath: join(directory, 'MEMORY.md'),
      memoryAuditPath: join(directory, 'audit.jsonl'),
    },
    autoStart: false,
  })
  try {
    const {
      preferenceCandidates,
      preferencePromoter,
      profileObserver,
      frontendMemoryService,
    } = app.services
    assert.ok(preferenceCandidates)
    assert.equal(preferenceCandidates.health().persistenceEnabled, true)
    assert.ok(preferencePromoter)
    assert.equal(preferencePromoter.enabled(), true)
    // 观察器是槽位池的生产者；没有它整条链没有输入，晋升永远是 0
    assert.ok(profileObserver)
    assert.equal(profileObserver.enabled(), true)

    // 端到端：确认 2 次且跨 2 会话 → 晋升器写入 USER.md 的观察推断段
    for (const sessionId of ['s0', 's1']) {
      preferenceCandidates.observe({
        ownerId: 'user_personal',
        sessionId,
        field: 'occupation',
        value: '中学语文老师',
      })
    }
    assert.equal(preferenceCandidates.promotable('user_personal').length, 1)
    const promoted = await preferencePromoter.run({ ownerId: 'user_personal' })
    assert.deepEqual(promoted.map(item => item.label), ['职业：中学语文老师'])

    const [document] = frontendMemoryService.list('user_personal', { scope: 'user' })
    assert.match(document.content, /## 观察推断/)
    assert.match(document.content, /- 职业：中学语文老师/)
    // 观察区必须排在原有内容之后 —— 晋升只追加，不改写既有段落。
    // 这里的初始文档是空模板 '# USER'，所以断言它仍在最前。
    assert.match(document.content, /^# USER/)
    assert.equal(
      document.content.indexOf('# USER') < document.content.indexOf('## 观察推断'),
      true,
    )
  } finally {
    await app.close()
  }
})
