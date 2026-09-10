import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Runs in the copied, physically pruned source tree, never the real checkout.
async function smoke() {
  const { default: assert } = await import('node:assert/strict')
  const { once } = await import('node:events')
  const { createServer } = await import('node:http')
  const { WebSocket, WebSocketServer } = await import('ws')
  const { createGatewayApplication } = await import('./server/src/app/gateway-application.mjs')
  const { config } = await import('./server/src/core/config.mjs')
  const { createRealtimeProviderRegistry } = await import('./server/src/voice/providers/provider-registry.mjs')
  const { dashscopeProvider } = await import('./server/src/voice/providers/dashscope.mjs')
  const { frontendToolRegistry, buildFrontendInstructions } = await import('./server/src/frontend/frontend-tools.mjs')
  const { createGatewaySessionHello } = await import('./shared/protocol/gateway-client-protocol.mjs')
  const removed = JSON.parse(process.argv[1])

  for (const feature of ['memory', 'knowledge']) {
    assert.equal(frontendToolRegistry.has(feature), !removed.includes(feature))
  }
  const instructions = buildFrontendInstructions({
    frontend: { capabilities: ['memory', 'knowledge'] },
    memories: [{ scope: 'memory', content: 'pruning-memory-marker' }],
  })
  if (removed.includes('memory')) {
    assert.doesNotMatch(instructions, /`memory`|# Personalization and memory|pruning-memory-marker/)
  } else {
    assert.match(instructions, /# Personalization and memory/)
    assert.match(instructions, /pruning-memory-marker/)
  }

  const providerServer = createServer()
  const providerSockets = new WebSocketServer({ server: providerServer })
  const received = []
  providerSockets.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'session.created', session: {} }))
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString())
      received.push(event)
      if (event.type === 'session.update') {
        socket.send(JSON.stringify({ type: 'session.updated', session: event.session }))
      }
      if (event.type === 'conversation.item.create') {
        socket.send(JSON.stringify({ type: 'conversation.item.created', item: event.item }))
      }
      if (event.type === 'response.create') {
        for (const reply of [
          { type: 'response.created', response: { id: 'response-pruned' } },
          { type: 'response.text.delta', response_id: 'response-pruned', delta: 'pruned gateway reply' },
          { type: 'response.text.done', response_id: 'response-pruned', text: 'pruned gateway reply' },
          { type: 'response.done', response: { id: 'response-pruned', status: 'completed', output: [] } },
        ]) socket.send(JSON.stringify(reply))
      }
    })
  })
  providerServer.listen(0, '127.0.0.1')
  await once(providerServer, 'listening')
  const provider = {
    ...dashscopeProvider,
    key: 'pruning-probe',
    aliases: [],
    isConfigured: () => true,
    url: () => `ws://127.0.0.1:${providerServer.address().port}`,
    headers: () => ({}),
  }
  let application
  let socket
  try {
    application = createGatewayApplication({
      config: {
        ...config, host: '127.0.0.1', port: 0,
        memoryAutoEnabled: false, preferenceLearningEnabled: false,
        domainLibraryEnabled: true, reminderSchedulerEnabled: false,
        gatewayAccessToken: '', gatewayAccessKeys: '',
      },
      autoStart: false, parentPort: null, publicEndpoint: null,
      frontendMcp: null, frontendOpenApi: null,
      realtimeProviderRegistry: createRealtimeProviderRegistry({ providers: [provider] }),
      realtimeProvider: provider.key,
    })
    application.start()
    await once(application.server, 'listening')
    const origin = `http://127.0.0.1:${application.server.address().port}`
    const health = await fetch(`${origin}/api/health`).then(response => response.json())
    assert.equal(health.ok, true)
    for (const [feature, path, key] of [
      ['memory', '/api/memory', 'frontendMemory'],
      ['knowledge', '/api/domain', 'frontendKnowledge'],
    ]) {
      assert.equal(health[key].configured, !removed.includes(feature))
      const response = await fetch(`${origin}${path}`)
      assert.equal(response.status, removed.includes(feature) ? 404 : 200)
    }
    const events = []
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/realtime?sessionId=pruning')
    socket.on('message', raw => events.push(JSON.parse(raw.toString())))
    await once(socket, 'open')
    const waitFor = async predicate => {
      const deadline = Date.now() + 5_000
      while (!events.some(predicate)) {
        assert.ok(Date.now() < deadline, `Gateway events: ${JSON.stringify(events)}`)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    socket.send(JSON.stringify(createGatewaySessionHello({
      clientType: 'web',
      connection: { text_only: true, input_enabled: false, output_enabled: true },
    })))
    await waitFor(event => event.type === 'session.ready')
    socket.send(JSON.stringify({
      type: 'conversation.item.create', event_id: 'evt_probe_input', text: 'hello',
    }))
    await waitFor(event => event.type === 'transcript.final' && event.content === 'pruned gateway reply')
    assert.ok(received.some(event => event.type === 'conversation.item.create'))
    const session = received.find(event => event.type === 'session.update')?.session
    assert.ok(session)
    for (const feature of removed) {
      assert.equal(session.tools.some(tool => (tool.function || tool).name === feature), false)
    }
    console.log('pruned gateway chat passed')
  } finally {
    socket?.terminate()
    await application?.close()
    for (const client of providerSockets.clients) client.terminate()
    await new Promise(resolve => providerSockets.close(resolve))
    await new Promise(resolve => providerServer.close(resolve))
  }
}

function omitEntry(path, name) {
  const source = readFileSync(path, 'utf8')
    .replace(new RegExp(`^import \\{ ${name} \\} from .+\\r?\\n`, 'm'), '')
    .replace(new RegExp(`\\b${name},?\\s*`), '')
  writeFileSync(path, source)
}

test('prunes composition imports and entries with LF and CRLF line endings', t => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-pruning-newlines-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'modules.mjs')
  for (const newline of ['\n', '\r\n']) {
    writeFileSync(path, [
      "import { createMemoryModule } from '../memory/module.mjs'",
      "import { createKnowledgeModule } from '../knowledge/module.mjs'",
      '',
      'export const optionalModuleFactories = [createMemoryModule, createKnowledgeModule]',
      '',
    ].join(newline))
    omitEntry(path, 'createMemoryModule')
    const remaining = readFileSync(path, 'utf8')
    assert.doesNotMatch(remaining, /memory|createMemoryModule/)
    assert.match(remaining, /import \{ createKnowledgeModule \} from/)
    assert.match(remaining, /\[createKnowledgeModule\]/)
    omitEntry(path, 'createKnowledgeModule')
    assert.equal(readFileSync(path, 'utf8').trim(), 'export const optionalModuleFactories = []')
  }
})

for (const removed of [['memory'], ['knowledge'], ['memory', 'knowledge']]) {
  test(`Gateway can chat after deleting ${removed.join(' + ')} directories`, { timeout: 25_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'qwaudio-pruned-source-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    for (const path of ['server/src', 'shared', 'config']) {
      cpSync(join(root, path), join(directory, path), { recursive: true })
    }
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'junction')
    for (const feature of removed) {
      const target = join(directory, 'server/src', feature)
      rmSync(target, { recursive: true })
      assert.equal(existsSync(target), false)
      omitEntry(join(directory, 'server/src/app/optional-modules.mjs'),
        feature === 'memory' ? 'createMemoryModule' : 'createKnowledgeModule')
      omitEntry(join(directory, 'server/src/frontend/optional-features.mjs'), `${feature}Frontend`)
    }
    const child = spawn(process.execPath, ['--input-type=module', '-e', `await (${smoke})()`, JSON.stringify(removed)], {
      cwd: directory,
      env: {
        ...process.env,
        QWEN_AUDIO_AGENT_RUNTIME_ROOT: directory,
        QWAUDIO_CONFIG_DIR: join(directory, 'settings'),
        QWAUDIO_DATA_DIR: join(directory, 'data'),
        QWAUDIO_STATE_DIR: join(directory, 'state'),
        AGENT_PROTOCOL: 'none',
        DASHSCOPE_API_KEY: '',
        QWEN_AUDIO_MEMORY_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk })
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    assert.equal(code, 0, output)
    assert.match(output, /pruned gateway chat passed/)
  })
}
