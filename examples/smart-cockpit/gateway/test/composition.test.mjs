import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startCockpitAgentServer } from '../../agent/server.mjs'
import { startCockpitServiceServer } from '../../service/server.mjs'

test('composes the public Gateway API with the replaceable A2A Agent', async t => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'qwaudio-cockpit-'))
  process.env.QWAUDIO_CONFIG_DIR = runtimeDirectory
  process.env.QWAUDIO_DATA_DIR = runtimeDirectory
  process.env.DASHSCOPE_API_KEY ||= 'test-only-placeholder'
  t.after(() => rm(runtimeDirectory, { recursive: true, force: true }))

  const service = await startCockpitServiceServer({ port: 0 })
  t.after(() => service.close())
  process.env.COCKPIT_SERVICE_ORIGIN = service.origin
  process.env.COCKPIT_ID = 'composition-car'
  delete process.env.COCKPIT_FRONTEND_MCP_URL
  const cockpitAgent = await startCockpitAgentServer({
    port: 0,
    serviceOrigin: service.origin,
  })
  t.after(() => cockpitAgent.close())

  const { startCockpitGateway } = await import('../server.mjs')
  assert.equal(
    process.env.COCKPIT_FRONTEND_MCP_URL,
    `${service.origin}/mcp/frontend?cockpitId=composition-car`,
  )
  const gateway = startCockpitGateway({
    port: 0,
    agentCardUrl: cockpitAgent.agentCardUrl,
  })
  t.after(() => gateway.close())

  await gateway.agent.start()
  const address = gateway.server.address()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`)
  const health = await response.json()

  assert.equal(response.status, 200)
  assert.equal(health.ok, true)
  assert.equal(health.protocolVersion, '5.6.0')
  assert.equal(health.frontendProfile.name, 'cockpit-example')
  assert.equal(health.backend.protocol, 'a2a')
  assert.equal(health.backend.status, 'ready')
})
