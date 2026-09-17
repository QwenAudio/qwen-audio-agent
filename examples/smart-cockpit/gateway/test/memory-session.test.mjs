import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ClientEventDefinitionRegistry,
  GatewayEventRouter,
} from 'qwen-audio-agent/client-events'
import { config } from '../../../../server/src/core/config.mjs'
import { buildFrontendToolContext } from '../../../../server/src/frontend/tools/frontend-tool-context.mjs'
import { frontendSourceToolDefinitions } from '../../../../server/src/frontend/tools/frontend-tool-source.mjs'
import { FrontendMcpClient } from '../../../../server/src/frontend/tools/mcp/frontend-mcp-client.mjs'
import { normalizeFrontendMcpConfiguration } from '../../../../server/src/frontend/tools/mcp/frontend-mcp-config.mjs'
import { memoryFrontend } from '../../../../server/src/memory/frontend.mjs'
import { RealtimeFrontend } from '../../../../server/src/voice/realtime-provider.mjs'
import { dashscopeProvider } from '../../../../server/src/voice/providers/dashscope.mjs'
import {
  DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
} from '../../../../shared/realtime-provider-catalog.mjs'
import {
  FRONTEND_TOOL_DEFINITIONS,
  FRONTEND_TOOL_NAMES,
} from '../../service/tools/registry.mjs'
import {
  COCKPIT_ASSISTANT_PROFILE_EVENT,
  cockpitAssistantProfileEventDefinition,
  loadCockpitAssistantProfile,
} from '../assistant/event.mjs'
import { createCockpitFrontendMcpConfiguration } from '../profile-bundle.mjs'
import { COCKPIT_SPAWN_THINKING_DESCRIPTION } from '../spawn-thinking-tool.mjs'

async function cockpitToolDefinitions(t) {
  const client = new FrontendMcpClient({
    configuration: normalizeFrontendMcpConfiguration(
      createCockpitFrontendMcpConfiguration({
        frontendMcpUrl: 'https://cockpit.invalid/mcp/frontend',
      }),
    ),
    // Keep real discovery, namespacing, policy and schema projection. Only the
    // transport is fake: this regression never starts a service or paid model.
    clientFactory: () => ({
      async connect() {},
      async listTools() { return { tools: FRONTEND_TOOL_DEFINITIONS } },
      async close() {},
    }),
    transportFactory: () => ({}),
  })
  t.after(() => client.close())
  await client.initialize()
  const tools = frontendSourceToolDefinitions([client])
  assert.equal(tools.length, 37)
  assert.deepEqual(
    tools.map(tool => tool.function.name),
    FRONTEND_TOOL_NAMES.map(name => `mcp__cockpit__${name}`),
  )
  return tools
}

function assertMemoryVisibility(update, enabled) {
  assert.equal(update.type, 'session.update')
  assert.ok(update.event_id)
  const { instructions, tools } = update.session
  assert.equal(instructions.includes(memoryFrontend.instructions), enabled)
  assert.equal(instructions.includes('# Personalization and memory'), enabled)
  assert.equal(tools.filter(tool => tool.function.name === 'memory').length, enabled ? 1 : 0)
  assert.deepEqual(
    tools.filter(tool => tool.function.name.startsWith('mcp__cockpit__'))
      .map(tool => tool.function.name),
    FRONTEND_TOOL_NAMES.map(name => `mcp__cockpit__${name}`),
  )
  assert.equal(new Set(tools.map(tool => tool.function.name)).size, tools.length)
  const search = tools.find(tool => tool.function.name === 'mcp__cockpit__navigation_search_place').function
  assert.match(search.description, /当前请求和已知饮食偏好/u)
  assert.match(search.description, /只推荐返回的真实店名/u)
  assert.match(search.parameters.properties.query.description, /不拼入不辣/u)
}

for (const model of [
  DEFAULT_DASHSCOPE_REALTIME_MODEL,
  DASHSCOPE_AUDIO_FLASH_REALTIME_MODEL,
  DASHSCOPE_OMNI_PLUS_REALTIME_MODEL,
  DASHSCOPE_OMNI_FLASH_REALTIME_MODEL,
]) {
  for (const enabled of [true, false]) {
    test(`${model}: initial and persona-refresh session.update ${enabled ? 'include' : 'hide'} memory alongside all 37 cockpit MCP tools`, async t => {
      const originalModel = config.audioModel
      config.audioModel = model
      t.after(() => { config.audioModel = originalModel })
      const tools = await cockpitToolDefinitions(t)
      const frontend = new RealtimeFrontend({
        provider: dashscopeProvider,
        agentContext: {
          assistantProfile: loadCockpitAssistantProfile('healer'),
          frontend: {
            ...buildFrontendToolContext({
              memoryService: {},
              disabledTools: enabled ? [] : ['memory'],
            }),
            spawnThinkingDescription: COCKPIT_SPAWN_THINKING_DESCRIPTION,
            tools,
          },
          memories: enabled ? [{ scope: 'memory', content: '用户喜欢吃烧烤，不太能吃辣。' }] : [],
          recentMessages: [],
        },
      })
      const wire = []
      frontend.ws = {
        readyState: 1,
        send(raw) { wire.push(JSON.parse(raw)) },
        close() {},
      }
      t.after(() => frontend.close())

      // Exercise the real session.created -> buildSession -> protocol encoder
      // -> serialized WebSocket send path, before any memory tool is executed.
      frontend.handleProviderEvent({ type: 'session.created' })
      assert.equal(wire.length, 1)
      assertMemoryVisibility(wire[0], enabled)
      assert.equal(wire[0].session.instructions.includes('用户喜欢吃烧烤，不太能吃辣。'), enabled)
      assert.ok(wire[0].session.instructions.includes(loadCockpitAssistantProfile('healer')))
      frontend.handleProviderEvent({ type: 'session.updated' })

      const router = new GatewayEventRouter({
        registry: new ClientEventDefinitionRegistry({
          definitions: [cockpitAssistantProfileEventDefinition],
        }),
      })
      const result = await router.publish({
        event_id: `memory-profile-${model}-${enabled}`,
        name: COCKPIT_ASSISTANT_PROFILE_EVENT,
        data: { profile: 'action' },
        delivery_hint: 'handle',
      }, {
        source: {
          ownerId: 'memory-driver',
          sessionId: 'memory-drive',
          clientType: 'web',
          clientInstanceId: 'memory-cockpit',
        },
        effects: {
          setAssistantProfile(assistantProfile) {
            frontend.updateAgentContext({ assistantProfile })
          },
        },
      })
      assert.equal(result.accepted, true)
      await frontend.outputQueue
      assert.equal(wire.length, 2)
      assertMemoryVisibility(wire[1], enabled)
      assert.equal(wire[1].session.instructions.includes('用户喜欢吃烧烤，不太能吃辣。'), enabled)
      assert.ok(wire[1].session.instructions.includes(loadCockpitAssistantProfile('action')))
      assert.deepEqual(wire[1].session.tools, wire[0].session.tools)
    })
  }
}
