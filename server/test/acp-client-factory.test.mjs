import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACP_CONNECTION_PROCESS,
  createAcpClient,
} from '../src/backend/adapters/acp/client-factory.mjs'
import { AcpProcessClient } from '../src/backend/adapters/acp/process-client.mjs'

test('creates the local stdio ACP client from a process connection', () => {
  const prepare = () => {}
  const client = createAcpClient({
    label: 'Example',
    connection: {
      kind: ACP_CONNECTION_PROCESS,
      command: 'example-agent',
      args: ['--acp'],
      cwd: '/workspace',
      env: { TEST: '1' },
      prepare,
    },
  })

  assert.ok(client instanceof AcpProcessClient)
  assert.equal(client.command, 'example-agent')
  assert.deepEqual(client.args, ['--acp'])
  assert.equal(client.cwd, '/workspace')
  assert.deepEqual(client.env, { TEST: '1' })
  assert.equal(client.prepare, prepare)
})

test('rejects unknown ACP connection kinds at the factory boundary', () => {
  assert.throws(
    () => createAcpClient({
      label: 'Remote Example',
      connection: { kind: 'websocket', url: 'wss://example.test/acp' },
    }),
    /不支持的 ACP 连接方式：websocket/,
  )
})
