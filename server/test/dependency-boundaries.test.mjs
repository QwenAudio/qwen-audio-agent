import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const projectRoot = resolve(sourceRoot, '../..')
const sharedRoot = resolve(sourceRoot, '../../shared')
const allowedDependencies = {
  app: new Set([
    'access',
    'app',
    'backend',
    'backend-adapter',
    'client',
    'conversation',
    'core',
    'delivery',
    'frontend',
    'frontend-provider',
    'optional-module-assembly',
    'session',
    'task',
    'transport',
    'voice',
  ]),
  access: new Set(['access', 'core', 'shared']),
  process: new Set(['process', 'shared']),
  core: new Set(['core', 'shared']),
  frontend: new Set([
    'client', 'conversation', 'core', 'frontend', 'optional-frontend-assembly',
    'tool-support', 'shared', 'task',
  ]),
  'frontend-provider': new Set(['core', 'frontend', 'frontend-provider', 'shared']),
  'tool-support': new Set(['tool-support']),
  'optional-module-assembly': new Set(['memory-entry', 'knowledge-entry']),
  'optional-frontend-assembly': new Set(['memory-entry', 'knowledge-entry']),
  'memory-entry': new Set(['memory', 'memory-entry', 'memory-provider', 'tool-support']),
  'knowledge-entry': new Set(['knowledge', 'knowledge-entry', 'knowledge-provider', 'knowledge-service', 'tool-support']),
  // Group by domain without allowing contracts/runtimes to import concrete
  // providers. Feature entry points assemble them; library service owns queuing.
  knowledge: new Set(['core', 'knowledge', 'shared']),
  'knowledge-provider': new Set(['core', 'knowledge', 'knowledge-provider', 'shared']),
  'knowledge-service': new Set(['knowledge', 'task']),
  memory: new Set(['core', 'memory', 'shared']),
  'memory-provider': new Set(['core', 'memory', 'memory-provider', 'shared']),
  'backend-adapter': new Set(['backend-adapter', 'backend', 'core', 'shared']),
  backend: new Set(['backend', 'core', 'shared']),
  client: new Set(['client', 'delivery', 'shared', 'task']),
  delivery: new Set(['delivery']),
  conversation: new Set(['conversation', 'core', 'shared']),
  session: new Set(['session', 'shared']),
  task: new Set(['backend', 'core', 'session', 'task']),
  transport: new Set(['shared', 'task', 'transport']),
  voice: new Set([
    'client',
    'conversation',
    'core',
    'delivery',
    'frontend',
    'shared',
    'task',
    'transport',
    'voice',
  ]),
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : [path]
  }).filter(path => /\.(?:[cm]?js|jsx)$/.test(path))
}

function layerFor(path) {
  const sharedPath = relative(sharedRoot, path)
  if (sharedPath !== '..' && !sharedPath.startsWith(`..${sep}`)) return 'shared'
  const local = relative(sourceRoot, path).split(sep).join('/')
  if (local === 'app/optional-modules.mjs') return 'optional-module-assembly'
  if (local === 'frontend/optional-features.mjs') return 'optional-frontend-assembly'
  if (local === 'frontend/tools/tool-result.mjs') return 'tool-support'
  if (/^memory\/(?:module|frontend|tools|provider-factory)\.mjs$/u.test(local)) return 'memory-entry'
  if (/^knowledge\/(?:module|frontend|tools)\.mjs$/u.test(local)) return 'knowledge-entry'
  if (local.startsWith('backend/adapters/')) return 'backend-adapter'
  if (local.startsWith('memory/providers/')) return 'memory-provider'
  if (local.startsWith('knowledge/providers/')) return 'knowledge-provider'
  if (local === 'knowledge/library-service.mjs') return 'knowledge-service'
  if (/^frontend\/(?:retrieval\/providers|tools\/(?:mcp|openapi))\//u.test(local)) {
    return 'frontend-provider'
  }
  const first = local.split('/')[0]
  return first.endsWith('.mjs') ? 'root' : first
}

test('server and shared source relative module imports resolve to files', () => {
  const missing = []
  for (const file of [
    ...sourceFiles(sourceRoot),
    ...sourceFiles(sharedRoot),
  ]) {
    const imports = [
      ...readFileSync(file, 'utf8').matchAll(
        /(?:from\s+|import\s+)['"](\.{1,2}\/[^'"]+\.mjs)['"]/g,
      ),
    ]
    for (const match of imports) {
      const target = resolve(dirname(file), match[1])
      if (!existsSync(target)) {
        missing.push(
          `${relative(projectRoot, file)} -> ${relative(projectRoot, target)}`,
        )
      }
    }
  }
  assert.deepEqual(missing, [])
})

test('server source dependencies follow the documented layer direction', () => {
  const violations = []
  for (const file of sourceFiles(sourceRoot)) {
    const sourceLayer = layerFor(file)
    const imports = [
      ...readFileSync(file, 'utf8').matchAll(
        /(?:from\s+|import\s+)['"](\.{1,2}\/[^'"]+\.mjs)['"]/g,
      ),
    ]
    for (const match of imports) {
      const target = resolve(dirname(file), match[1])
      const targetLayer = layerFor(target)
      if (
        sourceLayer === 'root'
          ? !new Set(['app', 'process', 'shared']).has(targetLayer)
          : !allowedDependencies[sourceLayer]?.has(targetLayer)
      ) {
        violations.push(
          `${relative(sourceRoot, file)} -> ${relative(sourceRoot, target)}`,
        )
      }
    }
  }
  assert.deepEqual(violations, [])
})

test('generic ACP and process cores do not bind to named backends', () => {
  const genericCoreFiles = [
    resolve(sourceRoot, 'backend/adapters/acp/process-client.mjs'),
    resolve(sourceRoot, 'backend/adapters/acp/backend-adapter.mjs'),
    resolve(sourceRoot, 'process/managed-backend.mjs'),
    resolve(projectRoot, 'cli/src/runtime.mjs'),
    resolve(projectRoot, 'cli/src/launcher.mjs'),
  ]
  const namedBackend = /\b(?:openclaw|opencode|qoder|qwen(?!-audio-agent)|minimax|kimi|hermes|codebuddy|codex|claude|pi)\b/i
  const violations = genericCoreFiles
    .filter(file => namedBackend.test(readFileSync(file, 'utf8')))
    .map(file => relative(projectRoot, file))
  assert.deepEqual(violations, [])
})

test('protocol-neutral backend core does not import Agent protocol SDKs', () => {
  const protocolSdk = /from\s+['"](?:@agentclientprotocol\/|@a2a-js\/)/
  const violations = sourceFiles(resolve(sourceRoot, 'backend'))
    .filter(file => layerFor(file) === 'backend')
    .filter(file => protocolSdk.test(readFileSync(file, 'utf8')))
    .map(file => relative(projectRoot, file))
  assert.deepEqual(violations, [])
})

test('domain grouping keeps provider implementations behind their contracts', () => {
  const cases = [
    ['backend/backend-port.mjs', 'backend/adapters/acp/process-client.mjs'],
    ['task/task-manager.mjs', 'backend/adapters/agent-client.mjs'],
    ['memory/runtime.mjs', 'memory/providers/voicemem/provider.mjs'],
    ['knowledge/runtime.mjs', 'knowledge/providers/local/provider.mjs'],
    ['knowledge/provider.mjs', 'frontend/frontend-tools.mjs'],
    ['app/gateway-application.mjs', 'memory/learning/extractor.mjs'],
    ['app/gateway-application.mjs', 'knowledge/providers/local/library.mjs'],
    ['conversation/frontend-agent-context.mjs', 'memory/scopes.mjs'],
    ['frontend/tools/tool-call-handler.mjs', 'memory/tools.mjs'],
    ['frontend/frontend-tools.mjs', 'knowledge/tools.mjs'],
    ['frontend/tools/tool-call-handler.mjs', 'voice/realtime-provider.mjs'],
    ['frontend/tools/tool-call-handler.mjs', 'backend/adapters/acp/backend-adapter.mjs'],
  ]
  for (const [consumer, implementation] of cases) {
    const sourceLayer = layerFor(resolve(sourceRoot, consumer))
    const targetLayer = layerFor(resolve(sourceRoot, implementation))
    assert.equal(allowedDependencies[sourceLayer].has(targetLayer), false,
      `${consumer} must not depend on ${implementation}`)
  }
})

test('Gateway Work consumers use BackendPort instead of ACP coordinator APIs', () => {
  const consumers = [
    resolve(sourceRoot, 'backend/backend-work-runtime.mjs'),
    resolve(sourceRoot, 'app/gateway-application.mjs'),
    resolve(sourceRoot, 'voice/realtime-gateway.mjs'),
    resolve(sourceRoot, 'frontend/tools/tool-call-handler.mjs'),
  ]
  const privateAcpApi = /\b(?:runCoordinator|cancelWork|queryDelegatedWork|coordinatorUsesMcpInstructions)\b|from\s+['"][^'"]*acp-/
  const violations = consumers
    .filter(file => privateAcpApi.test(readFileSync(file, 'utf8')))
    .map(file => relative(projectRoot, file))
  assert.deepEqual(violations, [])
})

test('UI source code does not import Gateway or another client implementation', () => {
  const roots = [
    resolve(projectRoot, 'web/src'),
    resolve(projectRoot, 'tui/src'),
    resolve(projectRoot, 'desktop/src'),
  ]
  const forbidden = [
    resolve(projectRoot, 'server/src'),
    resolve(projectRoot, 'cli/src'),
  ]
  const violations = []
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const imports = [
        ...readFileSync(file, 'utf8').matchAll(
          /(?:from\s+|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g,
        ),
      ]
      for (const match of imports) {
        const target = resolve(dirname(file), match[1])
        if (forbidden.some(directory => {
          const path = relative(directory, target)
          return path !== '..' && !path.startsWith(`..${sep}`)
        })) {
          violations.push(
            `${relative(projectRoot, file)} -> ${relative(projectRoot, target)}`,
          )
        }
      }
    }
  }
  assert.deepEqual(violations, [])
})

test('shipped UI clients do not expose the removed background execution control', () => {
  const roots = [
    resolve(projectRoot, 'web/src'),
    resolve(projectRoot, 'tui/src'),
    resolve(projectRoot, 'desktop/src'),
  ]
  const violations = roots.flatMap(root => sourceFiles(root))
    .filter(file => /task\.background|action_background|\/bg/.test(
      readFileSync(file, 'utf8'),
    ))
    .map(file => relative(projectRoot, file))
  assert.deepEqual(violations, [])
})
