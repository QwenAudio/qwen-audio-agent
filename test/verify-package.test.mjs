import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findForbiddenPackageFiles,
  findMissingRuntimeFiles,
  parsePackOutput,
} from '../scripts/verify-package.mjs'

// npm <=10 emits `npm pack --json` as an array of package entries.
const ARRAY_FORMAT = JSON.stringify([
  {
    id: 'qwen-audio-agent@1.0.0',
    name: 'qwen-audio-agent',
    version: '1.0.0',
    filename: 'qwen-audio-agent-1.0.0.tgz',
    files: [
      { path: 'cli/bin/qwenaudio.mjs', size: 273, mode: 420 },
      { path: 'package.json', size: 100, mode: 420 },
    ],
  },
])

// npm >=11 emits `npm pack --json` keyed by package name.
const OBJECT_FORMAT = JSON.stringify({
  'qwen-audio-agent': {
    id: 'qwen-audio-agent@1.0.0',
    name: 'qwen-audio-agent',
    version: '1.0.0',
    filename: 'qwen-audio-agent-1.0.0.tgz',
    files: [{ path: 'cli/bin/qwenaudio.mjs', size: 273, mode: 420 }],
  },
})

// npm 10 runs the `prepare` lifecycle script during `npm pack`, and tools like
// vite write coloured build logs to stdout — polluting the JSON payload.
const BUILD_LOG_NOISE = [
  '[36mvite v7.3.6 building client environment for production...[39m',
  'transforming...',
  '[32m✓[39m 292 modules transformed.',
  'rendering chunks...',
  '',
].join('\n')

test('parses legacy npm <=10 array pack output', () => {
  const packages = parsePackOutput(ARRAY_FORMAT)
  assert.equal(packages.length, 1)
  assert.equal(packages[0].filename, 'qwen-audio-agent-1.0.0.tgz')
  assert.deepEqual(
    packages[0].files.map(file => file.path),
    ['cli/bin/qwenaudio.mjs', 'package.json'],
  )
})

test('parses npm >=11 object pack output', () => {
  const packages = parsePackOutput(OBJECT_FORMAT)
  assert.equal(packages.length, 1)
  assert.equal(packages[0].id, 'qwen-audio-agent@1.0.0')
  assert.equal(packages[0].filename, 'qwen-audio-agent-1.0.0.tgz')
  assert.deepEqual(
    packages[0].files.map(file => file.path),
    ['cli/bin/qwenaudio.mjs'],
  )
})

test('tolerates leading and trailing whitespace', () => {
  const packages = parsePackOutput(`\n${OBJECT_FORMAT}\n`)
  assert.equal(packages.length, 1)
})

test('parses npm 10 array output polluted by prepare-script build logs', () => {
  const packages = parsePackOutput(`${BUILD_LOG_NOISE}\n${ARRAY_FORMAT}`)
  assert.equal(packages.length, 1)
  assert.equal(packages[0].filename, 'qwen-audio-agent-1.0.0.tgz')
  assert.deepEqual(
    packages[0].files.map(file => file.path),
    ['cli/bin/qwenaudio.mjs', 'package.json'],
  )
})

test('parses object output even when preceded by build-log noise', () => {
  const packages = parsePackOutput(`${BUILD_LOG_NOISE}\n${OBJECT_FORMAT}`)
  assert.equal(packages.length, 1)
  assert.equal(packages[0].filename, 'qwen-audio-agent-1.0.0.tgz')
})

test('parses output with trailing noise after the JSON block', () => {
  const stdout = `${ARRAY_FORMAT}\n> qwen-audio-agent prepare\n> node scripts/prepare-build.mjs`
  const packages = parsePackOutput(stdout)
  assert.equal(packages.length, 1)
  assert.equal(packages[0].id, 'qwen-audio-agent@1.0.0')
})

test('throws on empty output', () => {
  assert.throws(() => parsePackOutput(''), /为空/)
})

test('throws on non-JSON output', () => {
  assert.throws(() => parsePackOutput('this is not json'), /JSON/)
})

test('requires every CLI and shared runtime source in the package', () => {
  const packaged = new Set([
    'cli/src/desktop-host.mjs',
    'shared/desktop-host-protocol.mjs',
  ])
  const sourceFiles = [
    'cli/src/desktop-host.mjs',
    'cli/src/new-runtime-module.mjs',
    'shared/desktop-host-protocol.mjs',
  ]
  assert.deepEqual(findMissingRuntimeFiles(packaged, sourceFiles), [
    'cli/src/new-runtime-module.mjs',
  ])
})

test('rejects desktop sources, tests, and documentation from npm output', () => {
  assert.deepEqual(findForbiddenPackageFiles(new Set([
    'cli/src/desktop-host.mjs',
    'desktop/src/windows-preferences.mjs',
    'desktop/test/windows-preferences.test.mjs',
    'test/verify-package.test.mjs',
    'docs/architecture.md',
  ])), [
    'desktop/src/windows-preferences.mjs',
    'desktop/test/windows-preferences.test.mjs',
    'test/verify-package.test.mjs',
    'docs/architecture.md',
  ])
})
