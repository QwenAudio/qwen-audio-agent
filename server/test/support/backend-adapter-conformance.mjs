import assert from 'node:assert/strict'
import { assertBackendPort } from '../../src/backend/backend-port.mjs'

async function usingFixture(createFixture, options, operation) {
  const fixture = await createFixture(options)
  const backend = assertBackendPort(fixture.backend, {
    name: `${fixture.name || 'Backend'} conformance adapter`,
  })
  try {
    return await operation({ ...fixture, backend })
  } finally {
    await backend.close()
  }
}

function assertOutcome(outcome) {
  assert.equal(typeof outcome?.content, 'string')
  assert.ok(Array.isArray(outcome?.artifacts))
  assert.ok(
    outcome?.presentation == null
      || typeof outcome.presentation === 'object',
  )
  for (const privateField of [
    'metadata',
    'raw',
    'protocol',
    'sessionId',
    'delegationId',
  ]) {
    assert.equal(privateField in outcome, false)
  }
}

/**
 * Verify the observable contract every backend adapter must implement.
 *
 * createFixture({ hold }) returns:
 *   backend: a fresh BackendPort
 *   work: a valid Work value
 *   started: optional Promise resolved once held work reaches execution
 */
export async function verifyBackendAdapterConformance({ createFixture }) {
  await usingFixture(createFixture, { hold: false }, async ({ backend }) => {
    const description = backend.describe()
    assert.ok(description && typeof description === 'object')
    assert.ok(
      description.capabilities == null
        || typeof description.capabilities === 'object',
    )
    const first = await backend.start()
    const second = await backend.start()
    assert.equal(first?.ok, true)
    assert.equal(second?.ok, true)
    assert.equal((await backend.health())?.ok, true)
    assert.equal(backend.status('missing-work')?.state, 'not_found')
    await assert.rejects(backend.submit({}), /requires work id, owner and input/i)
    await backend.close()
  })

  await usingFixture(
    createFixture,
    { hold: false },
    async ({ backend, work, nextWork }) => {
      const events = []
      const unsubscribe = backend.subscribe(event => events.push(event))
      const unsubscribeThrowing = backend.subscribe(() => {
        throw new Error('observer failure')
      })
      const outcome = await backend.submit(work)
      assertOutcome(outcome)
      assert.ok(events.length > 0)
      assert.ok(events.every(event => event.workId === work.id))
      assert.ok(events.every(event => event.ownerId === work.ownerId))
      assert.equal(backend.status(work.id).state, 'not_found')

      unsubscribe()
      unsubscribeThrowing()
      const eventCount = events.length
      assertOutcome(await backend.submit(nextWork))
      assert.equal(events.length, eventCount)
    },
  )

  await usingFixture(
    createFixture,
    { hold: true },
    async ({ backend, work, started }) => {
      const pending = backend.submit(work)
      await started
      assert.equal(backend.status(work.id, {
        ownerId: work.ownerId,
      }).state, 'working')
      assert.equal(backend.status(work.id, {
        ownerId: 'another-owner',
      }).state, 'not_found')
      await assert.rejects(backend.submit(work), /already active/)
      await assert.rejects(backend.cancel(work.id, {
        ownerId: 'another-owner',
      }))
      assert.deepEqual(await backend.cancel(work.id, {
        ownerId: work.ownerId,
      }), {
        workId: work.id,
        state: 'cancelled',
      })
      await assert.rejects(pending)
      assert.equal((await backend.cancel(work.id, {
        ownerId: work.ownerId,
      })).state, 'not_found')
    },
  )
}
