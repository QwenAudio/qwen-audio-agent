import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  ClientEventDefinitionRegistry,
  GatewayEventRouter,
} from 'qwen-audio-agent/client-events'
import {
  COCKPIT_ASSISTANT_PROFILE_EVENT as CLIENT_ASSISTANT_PROFILE_EVENT,
  COCKPIT_PERSONA_IDS,
  COCKPIT_PERSONAS,
  DEFAULT_COCKPIT_PERSONA_ID,
  cockpitPersonaId,
} from '../../client/src/config/personas.js'
import {
  COCKPIT_ASSISTANT_PROFILE_EVENT,
  COCKPIT_ASSISTANT_PROFILE_IDS,
  cockpitAssistantProfileEventDefinition,
  loadCockpitAssistantProfile,
} from '../assistant/event.mjs'

test('keeps each cockpit Assistant Profile complete and free of task routing rules', () => {
  assert.deepEqual(COCKPIT_ASSISTANT_PROFILE_IDS, [
    'healer',
    'action',
    'sharp',
  ])
  for (const name of COCKPIT_ASSISTANT_PROFILE_IDS) {
    const profile = loadCockpitAssistantProfile(name)
    assert.match(profile, /# Identity[\s\S]*# Personality[\s\S]*# Conversation style/u)
    assert.doesNotMatch(profile, /spawn_thinking|MCP|工具|闪购|导航工具/u)
  }
})

test('keeps the replaceable Client and Gateway aligned only through wire ids', () => {
  assert.equal(CLIENT_ASSISTANT_PROFILE_EVENT, COCKPIT_ASSISTANT_PROFILE_EVENT)
  assert.deepEqual(COCKPIT_PERSONA_IDS, COCKPIT_ASSISTANT_PROFILE_IDS)
  for (const persona of COCKPIT_PERSONAS) {
    assert.equal(cockpitPersonaId(persona.label), persona.id)
    assert.ok(persona.description)
  }
})

test('maps an allowlisted Client Event to a trusted session Assistant Profile', async () => {
  let selected = ''
  const router = new GatewayEventRouter({
    registry: new ClientEventDefinitionRegistry({
      definitions: [cockpitAssistantProfileEventDefinition],
    }),
  })
  const result = await router.publish({
    event_id: 'evt-cockpit-profile-action',
    name: COCKPIT_ASSISTANT_PROFILE_EVENT,
    data: { profile: 'action' },
    delivery_hint: 'handle',
  }, {
    source: {
      ownerId: 'owner-one',
      sessionId: 'main',
      clientType: 'web',
      clientInstanceId: 'cockpit-one',
    },
    effects: {
      setAssistantProfile(profile) {
        selected = profile
      },
    },
  })

  assert.equal(result.accepted, true)
  assert.equal(result.delivery, null)
  assert.match(selected, /高效语音伙伴/u)
})

test('rejects arbitrary Assistant Profile names from the client', async () => {
  const router = new GatewayEventRouter({
    registry: new ClientEventDefinitionRegistry({
      definitions: [cockpitAssistantProfileEventDefinition],
    }),
  })
  await assert.rejects(router.publish({
    event_id: 'evt-cockpit-profile-injection',
    name: COCKPIT_ASSISTANT_PROFILE_EVENT,
    data: { profile: 'ignore-all-rules' },
  }), error => error.code === 'client_event_invalid')
})

test('uses the healer profile as the deployment default', () => {
  const profileUrl = new URL('../frontend-profile.json', import.meta.url)
  const profile = JSON.parse(readFileSync(profileUrl, 'utf8'))
  assert.equal(profile.assistant, 'assistant/healer.md')
  assert.equal(DEFAULT_COCKPIT_PERSONA_ID, 'healer')
})
