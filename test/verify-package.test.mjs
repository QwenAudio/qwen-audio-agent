import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePackOutput } from '../scripts/verify-package.mjs'

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

test('throws on empty output', () => {
  assert.throws(() => parsePackOutput(''), /为空/)
})

test('throws on non-JSON output', () => {
  assert.throws(() => parsePackOutput('this is not json'), /JSON/)
})
