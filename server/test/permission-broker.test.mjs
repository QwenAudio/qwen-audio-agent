import assert from 'node:assert/strict'
import test from 'node:test'
import { PermissionBroker } from '../src/backend/adapters/acp/permission-broker.mjs'

test('permission IDs stay short and distinct across independent broker lifetimes', async () => {
  const ids = new Set()
  const results = []
  for (let instance = 0; instance < 3; instance += 1) {
    const broker = new PermissionBroker({ protocol: 'test', permissionMode: 'native' })
    for (let request = 0; request < 100; request += 1) {
      results.push(broker.request({ toolCall: { title: 'Read a file' }, options: [] }, {
        session: { ownerId: 'owner', onEvent: event => {
          if (event.type !== 'backend.permission.requested') return
          assert.match(event.permission.id, /^auth_[A-Za-z0-9_-]{12}$/)
          assert.equal(ids.has(event.permission.id), false)
          ids.add(event.permission.id)
        } },
      }))
    }
    broker.cancelAll()
  }
  await Promise.all(results)
  assert.equal(ids.size, 300)
})

test('the short public ID resolves opaque ACP option IDs and duplicate decisions remain idempotent', async () => {
  const broker = new PermissionBroker({ protocol: 'test', permissionMode: 'native' })
  const events = []
  const pending = broker.request({
    toolCall: { toolCallId: 'private-acp-call', title: 'Read a file' },
    options: [{ kind: 'allow_once', optionId: 'private-acp-option' }],
  }, { session: { ownerId: 'owner', onEvent: event => events.push(event) } })
  const id = events[0].permission.id
  assert.throws(() => broker.respond(id, 'once', { ownerId: 'someone-else' }))
  const resolved = broker.respond(id, 'once', { ownerId: 'owner' })
  assert.equal(resolved.id, id)
  assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'private-acp-option' } })
  assert.deepEqual(broker.respond(id, 'reject', { ownerId: 'owner' }), resolved)
  assert.equal(events.filter(event => event.type === 'backend.permission.resolved').length, 1)
})
