import assert from 'node:assert/strict'
import { basename, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'

test('production build emits the microphone worklet as a same-origin script asset', async () => {
  const { output } = await build({
    root: resolve(import.meta.dirname, '..'),
    logLevel: 'silent',
    build: { write: false },
  })
  const processor = output.find(item => (
    item.type === 'asset'
    && /\/microphone-audio-worklet-processor-[^/]+\.js$/.test(item.fileName)
  ))
  assert.ok(processor,
    'The worklet must be emitted as a file; data: URLs are blocked by desktop CSP')
  assert.match(String(processor.source), /registerProcessor\(\s*['"]qwen-audio-microphone['"]/)
  assert.ok(output.some(item => (
    item.type === 'chunk' && item.code.includes(basename(processor.fileName))
  )), 'The application bundle must reference the emitted processor asset')
})
