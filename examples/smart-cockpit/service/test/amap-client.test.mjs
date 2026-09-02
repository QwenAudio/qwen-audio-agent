import assert from 'node:assert/strict'
import test from 'node:test'
import { geocode } from '../integrations/amap/client.mjs'

test('retries a transient map service response once', async t => {
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    if (requests === 1) return new Response('unavailable', { status: 503 })
    return Response.json({
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            geocodes: [{ location: '120.1,30.2' }],
          }),
        }],
      },
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  assert.equal(await geocode('西湖', '杭州'), '120.1,30.2')
  assert.equal(requests, 2)
})
