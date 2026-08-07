import assert from 'node:assert/strict'
import test from 'node:test'
import { BackendAvailability } from '../src/agent/backend-availability.mjs'

test('answers optimistically before the first probe completes', async () => {
  let resolveProbe
  const availability = new BackendAvailability({
    probe: () => new Promise(resolve => { resolveProbe = resolve }),
  })

  assert.deepEqual(availability.snapshot(), {
    configured: true,
    ok: true,
    known: false,
  })
  // The snapshot kicked one background probe (started on a microtask).
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof resolveProbe, 'function')
})

test('reports the cached probe result synchronously until the TTL expires', async () => {
  let now = 0
  let probes = 0
  const availability = new BackendAvailability({
    ttlMs: 1000,
    now: () => now,
    probe: async () => {
      probes += 1
      return { configured: true, ok: probes === 1 }
    },
  })

  await availability.refresh()
  assert.deepEqual(availability.snapshot(), {
    configured: true,
    ok: true,
    known: true,
  })
  // Within the TTL the snapshot never re-probes.
  now = 999
  availability.snapshot()
  assert.equal(probes, 1)

  now = 2000
  availability.snapshot()
  await availability.refreshing
  assert.equal(probes, 2)
  assert.equal(availability.snapshot().ok, false)
})

test('treats a failing probe as an unreachable backend without rejecting', async () => {
  const availability = new BackendAvailability({
    probe: async () => {
      throw new Error('probe exploded')
    },
  })

  await availability.refresh()
  assert.deepEqual(availability.snapshot(), {
    configured: true,
    ok: false,
    known: true,
  })
})

test('shares one in-flight probe between concurrent refreshes', async () => {
  let probes = 0
  const availability = new BackendAvailability({
    probe: async () => {
      probes += 1
      return { configured: true, ok: true }
    },
  })

  await Promise.all([
    availability.refresh(),
    availability.refresh(),
    availability.refresh(),
  ])
  assert.equal(probes, 1)
})

test('remembers that the backend is not configured', async () => {
  const availability = new BackendAvailability({
    probe: async () => ({ configured: false, ok: false }),
  })
  await availability.refresh()
  assert.deepEqual(availability.snapshot(), {
    configured: false,
    ok: false,
    known: true,
  })
})
