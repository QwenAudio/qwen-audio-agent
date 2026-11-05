import assert from 'node:assert/strict'
import test from 'node:test'
import { gaRealtimeProtocol } from '../src/voice/providers/ga-protocol.mjs'

test('GA conversation item ids preserve type prefixes within the 32-character limit', () => {
  const ids = new Set()
  for (const [type, prefix] of [
    ['message', 'msg'],
    ['function_call', 'fc'],
    ['function_call_output', 'fco'],
    ['unknown', 'item'],
  ]) {
    const id = gaRealtimeProtocol.conversationItemId({ type })
    assert.ok(id.startsWith(`${prefix}_`))
    assert.ok(id.length <= 32, `${type} id exceeds the service limit: ${id.length}`)
    assert.match(id.slice(prefix.length + 1), /^[0-9a-f]+$/)
    ids.add(id)
  }
  assert.equal(ids.size, 4)
})

test('GA added receipts normalize to the shared acknowledgement without losing item identity', () => {
  const event = {
    type: 'conversation.item.added',
    event_id: 'event_receipt',
    previous_item_id: 'msg_previous',
    item: { id: 'fco_server', type: 'function_call_output', call_id: 'call_1', output: '{}' },
  }
  assert.deepEqual(gaRealtimeProtocol.normalizeIncoming(event), {
    ...event, type: 'conversation.item.created',
  })
  assert.equal(event.type, 'conversation.item.added')
})

test('GA legacy receipts and finalization events pass through unchanged', () => {
  for (const type of ['conversation.item.created', 'conversation.item.done']) {
    const event = { type, item: { id: 'msg_server' } }
    assert.equal(gaRealtimeProtocol.normalizeIncoming(event), event)
  }
})
