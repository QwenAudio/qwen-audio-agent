import assert from 'node:assert/strict'
import test from 'node:test'
import { CockpitService } from '../service/cockpit-service.mjs'
import { CockpitServiceServer } from '../service/server.mjs'
import { FrontendMcpClient } from '../../../server/src/providers/mcp/frontend-mcp-client.mjs'
import {
  normalizeFrontendMcpConfiguration,
} from '../../../server/src/providers/mcp/frontend-mcp-config.mjs'

test('calls cockpit weather inline through the framework frontend MCP client', async t => {
  const service = new CockpitService({
    services: {
      async weather(city) {
        return { city, dayweather: '晴', daytemp: '27' }
      },
    },
  })
  const server = new CockpitServiceServer({ service, port: 0 })
  await server.start()
  t.after(() => server.close())
  const client = new FrontendMcpClient({
    configuration: normalizeFrontendMcpConfiguration({
      version: 1,
      servers: {
        cockpit: {
          enabled: true,
          url: `${server.origin}/mcp/frontend`,
          tools: {
            weather: { enabled: true, readOnly: true },
          },
        },
      },
    }),
  })
  t.after(() => client.close())

  const tools = await client.initialize()
  assert.deepEqual(tools.map(tool => tool.name), ['mcp__cockpit__weather'])
  const output = await client.execute('mcp__cockpit__weather', { city: '杭州' })
  assert.match(output.text, /杭州，晴，27°/u)
  assert.equal(service.snapshot().weather.daytemp, '27')
})
