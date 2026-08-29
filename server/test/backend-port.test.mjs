import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertBackendPort,
  BACKEND_PORT_METHODS,
  BackendPortContractError,
} from '../src/backend/backend-port.mjs'

function completePort() {
  return Object.fromEntries(BACKEND_PORT_METHODS.map(method => [
    method,
    () => {},
  ]))
}

test('defines the complete protocol-neutral backend boundary', () => {
  assert.deepEqual(BACKEND_PORT_METHODS, [
    'describe',
    'start',
    'health',
    'submit',
    'status',
    'cancel',
    'respondAuthorization',
    'respondInput',
    'subscribe',
    'close',
  ])
  assert.equal(Object.isFrozen(BACKEND_PORT_METHODS), true)
  const port = completePort()
  assert.equal(assertBackendPort(port), port)
})

test('rejects missing methods as one actionable contract error', () => {
  const port = completePort()
  delete port.submit
  delete port.respondAuthorization

  assert.throws(
    () => assertBackendPort(port, { name: 'Test adapter' }),
    error => {
      assert.equal(error instanceof BackendPortContractError, true)
      assert.equal(error.code, 'INVALID_BACKEND_PORT')
      assert.deepEqual(error.missing, ['submit', 'respondAuthorization'])
      assert.match(error.message, /Test adapter/)
      return true
    },
  )
})

test('does not accept non-callable method placeholders', () => {
  const port = completePort()
  port.subscribe = true
  assert.throws(
    () => assertBackendPort(port),
    error => error.missing.length === 1 && error.missing[0] === 'subscribe',
  )
})
