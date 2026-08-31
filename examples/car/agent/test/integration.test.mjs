import assert from 'node:assert/strict'
import test from 'node:test'
import {
  A2ABackendAdapter,
} from '../../../../server/src/backend/a2a-backend-adapter.mjs'
import {
  CockpitDomainServer,
} from '../../domain/server.mjs'
import { startCockpitAgentServer } from '../server.mjs'

test('runs a cockpit command through A2A and MCP without UI actions', async t => {
  const domain = new CockpitDomainServer({ port: 0 })
  await domain.start()
  t.after(() => domain.close())
  const agent = await startCockpitAgentServer({
    port: 0,
    domainOrigin: domain.origin,
  })
  t.after(() => agent.close())
  const backend = new A2ABackendAdapter({
    agentCardUrl: agent.agentCardUrl,
    pollIntervalMs: 10,
  })
  t.after(() => backend.close())

  const output = await backend.submit({
    id: 'gateway-task',
    ownerId: 'owner',
    objective: '打开主驾车窗',
  })
  assert.match(output.content, /已打开主驾车窗/u)
  assert.equal(output.presentation, undefined)

  const state = await fetch(`${domain.origin}/api/cockpit/state?cockpitId=default`)
    .then(response => response.json())
  assert.equal(state.vehicle.windowFL, 1)
})
