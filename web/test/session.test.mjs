import assert from 'node:assert/strict'
import test from 'node:test'
import { requestedSessionId } from '../src/session.js'

test('reads an explicit CLI session from the WebUI address', () => {
  assert.equal(
    requestedSessionId('?session=project%20one'),
    'project one',
  )
})

test('rejects empty or unreasonably long session identifiers', () => {
  assert.equal(requestedSessionId('?session=%20'), '')
  assert.equal(requestedSessionId(`?session=${'x'.repeat(201)}`), '')
  assert.equal(requestedSessionId('?session=bad%0Asession'), '')
})
