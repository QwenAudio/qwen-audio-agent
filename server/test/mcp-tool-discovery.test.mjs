import assert from 'node:assert/strict'
import test from 'node:test'
import { listMcpTools } from '../src/frontend/mcp-tool-discovery.mjs'

test('MCP discovery follows cursors, including empty pages, with one signal', async () => {
  const signal = AbortSignal.timeout(1_000)
  const calls = []
  const pages = [
    { tools: [{ name: 'first' }], nextCursor: 'two' },
    { tools: [], nextCursor: 'three' },
    { tools: [{ name: 'last' }] },
  ]
  const client = { listTools: async (params, options) => {
    calls.push(params)
    assert.equal(options.signal, signal)
    return pages.shift()
  } }
  assert.deepEqual(await listMcpTools(client, { signal }), [{ name: 'first' }, { name: 'last' }])
  assert.deepEqual(calls, [undefined, { cursor: 'two' }, { cursor: 'three' }])
})

test('MCP discovery rejects loops and bounds pages/tools', async () => {
  await assert.rejects(listMcpTools({ listTools: async () => ({ tools: [], nextCursor: 'repeat' }) }), /repeated/)
  let page = 0
  await assert.rejects(listMcpTools({ listTools: async () => ({ tools: [], nextCursor: String(++page) }) }, { maxPages: 2 }), /page limit/)
  assert.equal(page, 2)
  await assert.rejects(listMcpTools({ listTools: async () => ({ tools: [{}, {}] }) }, { maxTools: 1 }), /tool limit/)
})

test('MCP discovery stops on abort and propagates later-page failure', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(listMcpTools({ listTools: async () => {
    calls++
    controller.abort(new Error('deadline'))
    return { tools: [], nextCursor: 'next' }
  } }, { signal: controller.signal }), /deadline/)
  assert.equal(calls, 1)
  await assert.rejects(listMcpTools({ listTools: async params => {
    if (params) throw new Error('page failed')
    return { tools: [], nextCursor: 'next' }
  } }), /page failed/)
})
