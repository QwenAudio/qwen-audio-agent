// Locks the contract surface to its documentation: every capability the
// Gateway advertises must be documented in docs/contract.md (and the Chinese
// mirror), and the version must stay parseable SemVer. A capability renamed
// or added without touching the contract document fails here — the document
// is the promise, this test is what keeps it honest.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
} from '../server/src/core/gateway-protocol.mjs'
import {
  GatewayClientEvent,
  GatewayServerEvent,
  GatewayTaskEvent,
} from '../shared/realtime-events.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contractEn = readFileSync(resolve(projectRoot, 'docs/contract.md'), 'utf8')
const contractZh = readFileSync(resolve(projectRoot, 'docs/contract.zh.md'), 'utf8')

test('the protocol version is SemVer and the capability list is frozen', () => {
  assert.match(GATEWAY_PROTOCOL_VERSION, /^\d+\.\d+\.\d+$/)
  assert.ok(Object.isFrozen(GATEWAY_CAPABILITIES))
  assert.ok(GATEWAY_CAPABILITIES.length > 0)
  // Names are namespaced dot/kebab identifiers, and unique.
  for (const capability of GATEWAY_CAPABILITIES) {
    assert.match(capability, /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/)
  }
  assert.equal(new Set(GATEWAY_CAPABILITIES).size, GATEWAY_CAPABILITIES.length)
})

test('every advertised capability is documented in both contract documents', () => {
  for (const capability of GATEWAY_CAPABILITIES) {
    assert.ok(
      contractEn.includes(`\`${capability}\``),
      `docs/contract.md must document ${capability}`,
    )
    assert.ok(
      contractZh.includes(`\`${capability}\``),
      `docs/contract.zh.md must document ${capability}`,
    )
  }
})

test('the contract documents no capability the Gateway does not advertise', () => {
  // Capability-shaped tokens in the capability tables must all be real.
  const documented = [...contractEn.matchAll(/^\| `([a-z0-9.-]+)` \|/gm)]
    .map(match => match[1])
  assert.ok(documented.length >= GATEWAY_CAPABILITIES.length)
  for (const name of documented) {
    assert.ok(
      GATEWAY_CAPABILITIES.includes(name),
      `docs/contract.md documents ${name}, which the Gateway does not advertise`,
    )
  }
})

test('the contracted realtime events exist as shared constants', () => {
  assert.equal(GatewayServerEvent.INPUT_SUSPEND, 'input.suspend')
  assert.equal(GatewayServerEvent.INPUT_RESUME, 'input.resume')
  assert.equal(GatewayClientEvent.INPUT_SUSPEND_ACK, 'input.suspend.ack')
  assert.equal(GatewayTaskEvent.UPDATED, 'task.updated')
  for (const event of ['input.suspend', 'input.resume', 'input.suspend.ack']) {
    assert.ok(
      contractEn.includes(`\`${event}\``),
      `docs/contract.md must document the ${event} event`,
    )
  }
})
