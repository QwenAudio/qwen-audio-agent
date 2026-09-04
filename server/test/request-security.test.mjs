import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedOrigin } from '../src/core/request-security.mjs'

test('allows loopback same-origin and non-browser requests', () => {
  assert.equal(isAllowedOrigin({ headers: { host: 'localhost:3101' } }), true)
  assert.equal(isAllowedOrigin({
    headers: {
      host: 'localhost:3101',
      origin: 'http://localhost:3101',
    },
  }), true)
  assert.equal(isAllowedOrigin({
    headers: {
      host: 'localhost:3101',
      origin: 'https://attacker.example',
    },
  }), false)
})

test('rejects DNS rebinding and direct network access by default', () => {
  assert.equal(isAllowedOrigin({
    headers: {
      host: 'attacker.example:3101',
      origin: 'http://attacker.example:3101',
    },
  }), false)
  assert.equal(isAllowedOrigin({
    headers: { host: '192.168.1.20:3101' },
  }), false)
  assert.equal(isAllowedOrigin({
    headers: { host: '192.168.1.20:3101' },
  }, { authenticatedRemote: true }), true)
})

test('allows only an explicitly configured reverse-proxy origin', () => {
  const options = { allowedOrigins: ['https://voice.example.com'] }
  assert.equal(isAllowedOrigin({
    headers: {
      host: 'voice.example.com',
      origin: 'https://voice.example.com',
    },
  }, options), true)
  assert.equal(isAllowedOrigin({
    headers: { host: 'voice.example.com' },
  }, options), true)
  assert.equal(isAllowedOrigin({
    headers: {
      host: 'other.example.com',
      origin: 'https://other.example.com',
    },
  }, options), false)
  assert.equal(isAllowedOrigin({
    headers: {
      host: 'voice.example.com',
      origin: 'http://voice.example.com',
    },
  }, {
    allowedOrigins: ['http://voice.example.com'],
  }), false)
})

test('allows secure same-origin requests only for authenticated or pairing paths', () => {
  const request = {
    headers: {
      host: 'voice.example.ts.net',
      origin: 'https://voice.example.ts.net',
    },
  }
  assert.equal(isAllowedOrigin(request), false)
  assert.equal(isAllowedOrigin(request, { authenticatedRemote: true }), true)
  assert.equal(isAllowedOrigin(request, { allowSecureSameOrigin: true }), true)
  assert.equal(isAllowedOrigin({
    headers: {
      host: 'voice.example.ts.net',
      origin: 'http://voice.example.ts.net',
    },
  }, { allowSecureSameOrigin: true }), false)
})

test('allows the fixed mobile app origin only for an authenticated mobile device', () => {
  const req = {
    headers: {
      host: 'gateway.example.test',
      origin: 'https://qwaudio.local',
    },
  }
  assert.equal(isAllowedOrigin(req, {
    authenticatedRemote: true,
    trustedNativeClient: true,
  }), true)
  assert.equal(isAllowedOrigin(req, {
    authenticatedRemote: true,
    trustedNativeClient: false,
  }), false)
})
