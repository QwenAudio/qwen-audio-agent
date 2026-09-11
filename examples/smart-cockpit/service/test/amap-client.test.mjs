import assert from 'node:assert/strict'
import test from 'node:test'
import { geocode, searchPlaces, searchNearbyPlaces } from '../integrations/amap/client.mjs'

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

const flush = () => new Promise(resolve => setImmediate(resolve))

async function timedDrivingClient(t, fetchImpl) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  t.mock.method(globalThis, 'fetch', fetchImpl)
  // Each test owns the adapter's process-local request queue.
  return import(`../integrations/amap/client.mjs?test=${encodeURIComponent(t.name)}`)
}

function routeResponse() {
  return Response.json({
    status: '1',
    route: { paths: [{ distance: '1000', duration: '120', steps: [] }] },
  })
}

test('spaces five concurrent driving queries by at least 600 ms without delaying the first', async t => {
  const starts = []
  const destinations = []
  const { drivingRoute } = await timedDrivingClient(t, async url => {
    starts.push(Date.now())
    destinations.push(new URL(url).searchParams.get('destination'))
    return routeResponse()
  })
  const pending = Array.from({ length: 5 }, (_, index) => (
    drivingRoute('120.0,30.0', `120.${index + 1},30.0`)
  ))
  await flush()
  assert.deepEqual(starts, [0])
  for (let index = 1; index < 5; index += 1) {
    t.mock.timers.tick(599)
    await flush()
    assert.equal(starts.length, index)
    t.mock.timers.tick(1)
    await flush()
    assert.equal(starts.length, index + 1)
  }
  assert.deepEqual(starts, [0, 600, 1200, 1800, 2400])
  assert.deepEqual(destinations, ['120.1,30.0', '120.2,30.0', '120.3,30.0', '120.4,30.0', '120.5,30.0'])
  for (const route of await Promise.all(pending)) assert.equal(route.distance, 1000)
})

test('does not add a fixed delay when the previous driving query was already long enough ago', async t => {
  const starts = []
  const { drivingRoute } = await timedDrivingClient(t, async () => {
    starts.push(Date.now())
    return routeResponse()
  })
  await drivingRoute('120.0,30.0', '120.1,30.0')
  t.mock.timers.tick(900)
  await drivingRoute('120.1,30.0', '120.2,30.0')
  assert.deepEqual(starts, [0, 900])
})

test('spaces retries and leaves unrelated map queries independent of the driving queue', async t => {
  const starts = []
  const { drivingRoute, geocode: encode } = await timedDrivingClient(t, async url => {
    if (new URL(url).hostname === 'mcp.amap.com') {
      return Response.json({ result: { content: [{ type: 'text', text: '{"geocodes":[{"location":"120.1,30.2"}]}' }] } })
    }
    starts.push(Date.now())
    return starts.length === 1 ? new Response('busy', { status: 429 }) : routeResponse()
  })
  const pending = drivingRoute('120.0,30.0', '120.1,30.0')
  await flush()
  assert.deepEqual(starts, [0])
  assert.equal(await encode('西湖', '杭州'), '120.1,30.2')
  assert.equal(Date.now(), 0)
  t.mock.timers.tick(600)
  await flush()
  assert.equal((await pending).distance, 1000)
  assert.deepEqual(starts, [0, 600])
})

test('a failed driving request does not block later queued requests', async t => {
  const starts = []
  const { drivingRoute } = await timedDrivingClient(t, async () => {
    starts.push(Date.now())
    return starts.length <= 2 ? new Response('unavailable', { status: 503 }) : routeResponse()
  })
  const failed = assert.rejects(drivingRoute('120.0,30.0', '120.1,30.0'), /HTTP 503/u)
  await flush()
  t.mock.timers.tick(600)
  await flush()
  await failed
  const next = drivingRoute('120.1,30.0', '120.2,30.0')
  await flush()
  assert.deepEqual(starts, [0, 600])
  t.mock.timers.tick(600)
  await flush()
  assert.equal((await next).distance, 1000)
  assert.deepEqual(starts, [0, 600, 1200])
})

function mcpResponse(payload, { stream = false, isError = false } = {}) {
  const envelope = {
    result: {
      isError,
      content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    },
  }
  return stream
    ? new Response(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
    : Response.json(envelope)
}

const poiSearches = [
  {
    name: 'text search',
    run: (options = {}) => searchPlaces('附近餐厅', { city: '杭州', ...options }),
    tool: 'maps_text_search',
  },
  {
    name: 'nearby search',
    run: (options = {}) => searchNearbyPlaces({
      keywords: '附近餐厅', location: '120.1,30.2', radius: 1000, ...options,
    }),
    tool: 'maps_around_search',
  },
]

for (const search of poiSearches) {
  for (const stream of [false, true]) {
    const transport = stream ? 'SSE' : 'JSON'

    test(`${search.name} preserves named POIs and zero distance over ${transport}`, async t => {
      const requests = []
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        requests.push(JSON.parse(init.body).params)
        return mcpResponse({
          pois: [
            null,
            { id: 'missing-name', location: '120.2,30.3' },
            { id: 'blank-name', name: '  ', location: '120.2,30.3' },
            { id: 'invalid-name', name: ['餐厅'], location: '120.2,30.3' },
            {
              id: 'B001', name: '知味观（仁和路店）', type: '餐饮服务',
              address: ['仁和路', '83号'], location: '120.162,30.251', distance: 0,
            },
            {
              id: 'B002', name: '外婆家（西湖店）', typecode: '050100',
              address: '湖滨路3号', location: '120.16,30.25', distance: '0',
            },
            {
              id: 'B003', name: '楼外楼', address: '孤山路30号',
              location: '120.137,30.253', distance: '250',
            },
          ],
        }, { stream })
      })
      assert.deepEqual(await search.run({ limit: 3 }), [
        {
          id: 'B001', name: '知味观（仁和路店）', type: '餐饮服务',
          address: '仁和路83号', location: '120.162,30.251', distance: 0,
        },
        {
          id: 'B002', name: '外婆家（西湖店）', type: '050100',
          address: '湖滨路3号', location: '120.16,30.25', distance: 0,
        },
        {
          id: 'B003', name: '楼外楼', type: '',
          address: '孤山路30号', location: '120.137,30.253', distance: 250,
        },
      ])
      assert.equal(requests.length, 1)
      assert.equal(requests[0].name, search.tool)
      assert.equal(requests[0].arguments.keywords, '附近餐厅')
    })

    test(`${search.name} recognizes a genuine empty POI list over ${transport}`, async t => {
      t.mock.method(globalThis, 'fetch', async () => mcpResponse({ status: '1', pois: [] }, { stream }))
      assert.deepEqual(await search.run(), [])
    })

    const invalidPayloads = [
      ['invalid text JSON', '{"credential":"secret-key"'],
      ['missing POI list', {}],
      ['non-array POI list', { pois: { name: '不是列表' } }],
      ['null payload', null],
      ['AMap API failure', { status: '0', info: 'secret-key', infocode: '10001', pois: [] }],
      ['embedded error', { error: { message: 'secret-key' }, pois: [] }],
      ['embedded tool error', { isError: true, pois: [] }],
      ['only nameless POIs', { pois: [null, {}, { id: 'B001', name: ' ' }] }],
    ]
    for (const [scenario, payload] of invalidPayloads) {
      test(`${search.name} rejects ${scenario} over ${transport} without exposing payloads`, async t => {
        t.mock.method(globalThis, 'fetch', async () => mcpResponse(payload, { stream }))
        await assert.rejects(search.run(), { message: '地点搜索服务返回异常，请稍后重试' })
      })
    }

    test(`${search.name} rejects an MCP isError result even if it contains POIs over ${transport}`, async t => {
      t.mock.method(globalThis, 'fetch', async () => mcpResponse({
        pois: [{ id: 'error', name: 'secret-key', location: '120.1,30.2' }],
      }, { stream, isError: true }))
      await assert.rejects(search.run(), { message: '地点搜索服务返回异常，请稍后重试' })
    })

    test(`${search.name} rejects JSON-RPC errors over ${transport} without exposing payloads`, async t => {
      const envelope = { error: { code: -32603, message: 'secret-key' } }
      t.mock.method(globalThis, 'fetch', async () => stream
        ? new Response(`data: ${JSON.stringify(envelope)}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        })
        : Response.json(envelope))
      await assert.rejects(search.run(), { message: '地点搜索服务返回异常，请稍后重试' })
    })
  }

  test(`${search.name} does not turn malformed HTTP bodies or transport errors into empty results`, async t => {
    let scenario = 'invalid JSON'
    t.mock.method(globalThis, 'fetch', async () => {
      if (scenario === 'network') throw new Error('failed https://mcp.amap.com/mcp?key=secret-key')
      if (scenario === 'HTTP') return new Response('secret-key', { status: 403 })
      return new Response('secret-key', { headers: { 'Content-Type': 'application/json' } })
    })
    for (scenario of ['invalid JSON', 'HTTP', 'network']) {
      await assert.rejects(search.run(), { message: '地点搜索服务返回异常，请稍后重试' })
    }
  })
}

test('text search fills only a real named POI location using its returned ID', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { params } = JSON.parse(init.body)
    requests.push(params)
    return params.name === 'maps_search_detail'
      ? mcpResponse({ location: '120.162,30.251' })
      : mcpResponse({ pois: [
        { id: 'nameless' },
        { id: 'B001', name: '知味观（仁和路店）', address: '仁和路83号' },
      ] })
  })
  const places = await searchPlaces('附近餐厅', { city: '杭州', limit: 1 })
  assert.equal(places[0].name, '知味观（仁和路店）')
  assert.equal(places[0].location, '120.162,30.251')
  assert.equal(places[0].distance, null)
  assert.deepEqual(requests.map(request => request.name), ['maps_text_search', 'maps_search_detail'])
  assert.deepEqual(requests[1].arguments, { id: 'B001' })
})

test('geocoding also ignores an SSE isError result containing apparent coordinates', async t => {
  t.mock.method(globalThis, 'fetch', async () => mcpResponse({
    geocodes: [{ location: '120.1,30.2' }],
  }, { stream: true, isError: true }))
  assert.equal(await geocode('西湖', '杭州'), null)
})
