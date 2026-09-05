import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentDocumentConverter } from '../src/app/knowledge/agent-document-converter.mjs'

test('converts through isolated backend execution without leaking implementation fields', async () => {
  let received
  const signal = new AbortController().signal
  const onEvent = () => {}
  const converter = new AgentDocumentConverter({
    backendRuntime: {
      async runIsolated(input, context) {
        received = { input, context }
        return { content: 'done' }
      },
    },
  })

  await converter.convert({
    sourcePath: '/docs/manual.pdf',
    targetPath: '/knowledge/manual.md',
  }, {
    ownerId: 'owner-one',
    taskId: 'ingest-one',
    signal,
    onEvent,
  })

  assert.match(received.input.instruction, /manual\.pdf/u)
  assert.match(received.input.instruction, /manual\.md/u)
  assert.deepEqual(received.context, {
    ownerId: 'owner-one',
    taskId: 'ingest-one',
    signal,
    onEvent,
  })
})

test('requires isolated backend execution', () => {
  assert.throws(
    () => new AgentDocumentConverter({ backendRuntime: { run() {} } }),
    /isolated backend execution/u,
  )
})
