import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const projectRoot = resolve(sourceRoot, '../..')
const sharedRoot = resolve(sourceRoot, '../../shared')
const allowedDependencies = {
  app: new Set(['agent', 'app', 'conversation', 'core', 'task', 'voice']),
  process: new Set(['process', 'shared']),
  core: new Set(['core', 'shared']),
  agent: new Set(['agent', 'core', 'shared']),
  conversation: new Set(['conversation', 'core', 'shared']),
  task: new Set(['agent', 'core', 'task']),
  voice: new Set(['conversation', 'core', 'shared', 'task', 'voice']),
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
  const first = relative(sourceRoot, path).split(sep)[0]
  return first.endsWith('.mjs') ? 'root' : first
}

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
    resolve(sourceRoot, 'agent/acp-process-client.mjs'),
    resolve(sourceRoot, 'agent/acp-backend-adapter.mjs'),
    resolve(sourceRoot, 'process/managed-backend.mjs'),
    resolve(projectRoot, 'cli/src/runtime.mjs'),
    resolve(projectRoot, 'cli/src/launcher.mjs'),
  ]
  const namedBackend = /\b(?:openclaw|opencode|qoder|qwen(?!-audio-agent)|kimi|hermes|codebuddy|codex|claude|pi)\b/i
  const violations = genericCoreFiles
    .filter(file => namedBackend.test(readFileSync(file, 'utf8')))
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

test('UI clients do not expose the removed background execution control', () => {
  const fullscreenTui = readFileSync(
    resolve(projectRoot, 'tui/fullscreen/app.py'),
    'utf8',
  )
  assert.doesNotMatch(fullscreenTui, /task\.background|action_background|\/bg/)
})
