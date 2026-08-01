import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ActiveVoiceClients,
  clientVoiceCapabilities,
} from '../src/voice/active-voice-clients.mjs'

test('does not implicitly replace the active voice client', () => {
  const clients = new ActiveVoiceClients()
  let deactivated = 0
  const first = { deactivate: () => { deactivated += 1 } }
  const second = {}

  assert.equal(clients.activate('owner-one', first).granted, true)
  const denied = clients.activate('owner-one', second)

  assert.equal(denied.granted, false)
  assert.equal(denied.previous, first)
  assert.equal(deactivated, 0)
  assert.equal(clients.isActive('owner-one', first), true)
  assert.equal(clients.isActive('owner-one', second), false)
})

test('replaces the active voice client only through explicit takeover', () => {
  const clients = new ActiveVoiceClients()
  let replacement
  const first = { deactivate: client => { replacement = client } }
  const second = {}

  clients.activate('owner-one', first)
  const result = clients.activate('owner-one', second, { takeover: true })

  assert.equal(result.granted, true)
  assert.equal(result.previous, first)
  assert.equal(replacement, second)
  assert.equal(clients.active('owner-one'), second)
})

test('a stale client cannot release the newer active client', () => {
  const clients = new ActiveVoiceClients()
  const first = {}
  const second = {}

  clients.activate('owner-one', first)
  clients.activate('owner-one', second, { takeover: true })
  clients.release('owner-one', first)

  assert.equal(clients.isActive('owner-one', second), true)
  clients.release('owner-one', second)
  assert.equal(clients.isActive('owner-one', second), false)
})

test('a dead previous owner does not block a new claim without takeover', () => {
  const clients = new ActiveVoiceClients()
  let deactivatedWith
  // An unclean disconnect leaves the previous owner registered but its socket
  // is no longer open, so isAlive() reports false.
  const dead = { isAlive: () => false, deactivate: client => { deactivatedWith = client } }
  const fresh = { isAlive: () => true }

  clients.activate('owner-one', dead)
  const result = clients.activate('owner-one', fresh)

  assert.equal(result.granted, true)
  assert.equal(result.previous, dead)
  assert.equal(deactivatedWith, fresh)
  assert.equal(clients.isActive('owner-one', fresh), true)
})

test('a live previous owner still blocks a non-takeover claim', () => {
  const clients = new ActiveVoiceClients()
  const live = { isAlive: () => true }
  const other = { isAlive: () => true }

  clients.activate('owner-one', live)
  const denied = clients.activate('owner-one', other)

  assert.equal(denied.granted, false)
  assert.equal(denied.previous, live)
  assert.equal(clients.isActive('owner-one', live), true)
})

test('text-only clients receive output without taking voice ownership', () => {
  assert.deepEqual(clientVoiceCapabilities({
    voiceEnabled: true,
    textOnly: true,
  }), {
    inputEnabled: false,
    outputEnabled: true,
    participatesInVoiceArbitration: false,
  })
})

test('muted clients neither capture nor receive voice output', () => {
  assert.deepEqual(clientVoiceCapabilities({
    voiceEnabled: false,
    textOnly: false,
  }), {
    inputEnabled: false,
    outputEnabled: false,
    participatesInVoiceArbitration: false,
  })
})

test('input-muted desktop clients keep voice output and ownership', () => {
  assert.deepEqual(clientVoiceCapabilities({
    voiceEnabled: true,
    inputEnabled: false,
    outputEnabled: true,
    textOnly: false,
  }), {
    inputEnabled: false,
    outputEnabled: true,
    participatesInVoiceArbitration: true,
  })
})
