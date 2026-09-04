import assert from 'node:assert/strict'
import test from 'node:test'
import { ActiveClientLeases } from '../src/client/active-client-leases.mjs'

function client(alive = true) {
  return {
    active: alive,
    replacements: [],
    isAlive() { return this.active },
    deactivate(replacement) {
      this.replacements.push(replacement)
      this.active = false
    },
  }
}

test('scopes active Client leases by owner', () => {
  const leases = new ActiveClientLeases()
  const first = client()
  const second = client()
  assert.equal(leases.claim('user_one', first, { instanceId: 'desktop' }).granted, true)
  assert.equal(leases.claim('user_two', second, { instanceId: 'phone' }).granted, true)
  assert.equal(leases.size, 2)
})

test('requires explicit takeover for another live Client of the same owner', () => {
  const leases = new ActiveClientLeases()
  const desktop = client()
  const phone = client()
  const first = leases.claim('user_one', desktop, { instanceId: 'desktop' })
  const denied = leases.claim('user_one', phone, { instanceId: 'phone' })
  assert.equal(denied.granted, false)
  assert.equal(leases.isActive('user_one', desktop, first.lease.generation), true)

  const claimed = leases.claim('user_one', phone, {
    instanceId: 'phone',
    takeover: true,
  })
  assert.equal(claimed.granted, true)
  assert.equal(claimed.replaced, true)
  assert.equal(claimed.lease.generation, first.lease.generation + 1)
  assert.equal(desktop.replacements.length, 1)
  assert.equal(leases.isActive('user_one', phone, claimed.lease.generation), true)
})

test('automatically replaces a reconnect from the same logical Client', () => {
  const leases = new ActiveClientLeases()
  const staleSocket = client()
  const freshSocket = client()
  leases.claim('user_one', staleSocket, { instanceId: 'desktop' })
  const replacement = leases.claim('user_one', freshSocket, { instanceId: 'desktop' })
  assert.equal(replacement.granted, true)
  assert.equal(replacement.replaced, true)
})

test('generation fencing prevents a stale Client from releasing a new lease', () => {
  const leases = new ActiveClientLeases()
  const stale = client(false)
  const fresh = client()
  const first = leases.claim('user_one', stale, { instanceId: 'old' })
  const second = leases.claim('user_one', fresh, { instanceId: 'new' })
  assert.equal(leases.release('user_one', stale, first.lease.generation), false)
  assert.equal(leases.isActive('user_one', fresh, second.lease.generation), true)
})
