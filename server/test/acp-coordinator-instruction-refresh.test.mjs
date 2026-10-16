import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AcpBackendAdapter } from '../src/backend/adapters/acp/backend-adapter.mjs'
import { coordinatorKey } from '../src/backend/adapters/acp/backend-session-utils.mjs'
import {
  COORDINATOR_MCP_INSTRUCTIONS_MAX_BYTES,
  COORDINATOR_PROMPT_REFRESH_INTERVAL,
  COORDINATOR_STABLE_INSTRUCTIONS,
} from '../src/backend/adapters/acp/coordinator-instructions.mjs'
import { backendIds } from '../src/backend/adapters/acp/drivers/registry.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const completed = () => ({ content: 'done', response: { stopReason: 'end_turn' } })
const promptText = prompt => typeof prompt === 'string'
  ? prompt : prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
const hasRules = call => promptText(call.prompt).includes(
  call.stableInstructions ?? COORDINATOR_STABLE_INSTRUCTIONS,
)
const progress = call => call.input.onUpdate({
  sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' },
})
let harnessId = 0

function harness(t, {
  protocol = 'codex',
  sessionStatePath = null,
  steeringMode = 'extension',
  profileOverrides = {},
} = {}) {
  const prefix = `refresh-${++harnessId}`
  const h = { calls: [], registrations: [], sessions: new Map(), resumed: [], steering: [] }
  const client = {
    connectionGeneration: 1,
    async start() { return { agentCapabilities: { mcpCapabilities: { http: true } } } },
    async newSession(input) {
      const session = { sessionId: `${prefix}-${h.sessions.size + 1}`, cwd: input.cwd,
        connectionGeneration: 1, response: {}, input }
      h.sessions.set(session.sessionId, session)
      return session
    },
    async resumeSession(sessionId, input) {
      h.resumed.push(sessionId)
      if (h.failResume) throw new Error('stored session unavailable')
      const session = { sessionId, cwd: input.cwd, connectionGeneration: 1, response: {}, input }
      h.sessions.set(sessionId, session)
      return session
    },
    async prompt(sessionId, prompt, input = {}) {
      const call = { sessionId, prompt, input, session: h.sessions.get(sessionId),
        stableInstructions: h.backend.stableCoordinatorInstructions() }
      h.calls.push(call)
      let abort
      const aborted = new Promise((resolve, reject) => {
        abort = () => reject(input.signal.reason || new Error('cancelled'))
        if (input.signal?.aborted) abort()
        else input.signal?.addEventListener('abort', abort, { once: true })
      })
      try {
        return await Promise.race([
          Promise.resolve().then(() => h.handlePrompt ? h.handlePrompt(call) : completed()),
          aborted,
        ])
      } finally {
        input.signal?.removeEventListener('abort', abort)
      }
    },
    steeringMode() { return steeringMode },
    async steerSession(sessionId, prompt) {
      h.steering.push({ sessionId, prompt })
      return { outcome: 'injected' }
    },
    async cancelSession() {},
    async close() {},
  }
  const sessionToolServer = {
    async register(context, options) {
      const registration = { context, options,
        descriptor: { type: 'http', name: 'fake-session-tools',
          url: `http://test.invalid/${prefix}/${h.registrations.length}`, headers: [] },
        update(next) { this.context = next }, release() {},
      }
      h.registrations.push(registration)
      return registration
    },
    async close() {},
  }
  // Exercise real driver profiles; neither fake can launch a process or connect MCP.
  h.backend = new AcpBackendAdapter({ protocol, directory: '/test-project',
    cliPath: '/test-acp', baseUrl: 'http://127.0.0.1:3999',
    client, sessionToolServer, sessionStatePath, builtinMcp: [] })
  Object.assign(h.backend.profile, profileOverrides)
  h.client = client
  h.submit = (id, ownerId = 'owner') => h.backend.submit({ id, ownerId, objective: `work ${id}` })
  h.session = (ownerId = 'owner') => h.backend.coordinatorSessions.get(coordinatorKey(ownerId, protocol))
  h.saved = (ownerId = 'owner') => h.backend.registry.get(coordinatorKey(ownerId, protocol))
  h.turns = (ownerId = 'owner') => h.saved(ownerId)?.coordinatorPromptTurns ?? 0
  t.after(() => h.backend.close())
  return h
}

function registryPath(t) {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-instruction-refresh-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'acp-sessions.json')
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await tick()
  }
  assert.ok(check(), 'fake ACP operation did not reach the expected boundary')
}

for (const protocol of backendIds()) {
  test(`${protocol} refreshes full coordinator rules on accepted rounds 1, 21 and 41`, async t => {
    const h = harness(t, { protocol })
    const instructions = h.backend.stableCoordinatorInstructions()
    assert.equal(COORDINATOR_PROMPT_REFRESH_INTERVAL, 20)
    assert.equal(Object.hasOwn(h.backend.profile, 'coordinatorPromptRefreshInterval'), false)
    for (let round = 1; round <= 41; round += 1) {
      await h.submit(`round-${round}`)
      assert.equal(h.turns(), round)
      const shouldRefresh = [1, 21, 41].includes(round)
      const text = promptText(h.calls.at(-1).prompt)
      assert.equal(hasRules(h.calls.at(-1)), shouldRefresh, `round ${round}`)
      assert.equal(text.includes('<qwen_audio_agent_backend_profile>'), shouldRefresh)
      assert.equal(text.split(instructions).length - 1, shouldRefresh ? 1 : 0)
      if (h.backend.profile.sessionInstructions) {
        assert.equal(text.includes(h.backend.profile.sessionInstructions), shouldRefresh)
      }
    }
    assert.equal(h.sessions.size, 1)
    assert.equal(h.registrations.length, h.backend.profile.externalMcp ? 1 : 0)
    if (h.registrations.length) {
      assert.equal(h.registrations[0].options.instructions,
        h.backend.profile.coordinatorMcpInstructions ? instructions : '')
      assert.equal(h.calls[0].session.input.mcpServers.length, 1)
    }
    if (h.backend.profile.delegation === false) {
      assert.doesNotMatch(instructions, /Project Session routing:|Use a project Session|After a start or continue action succeeds/u)
      assert.ok(instructions.includes(h.backend.profile.sessionInstructions))
    }
  })
}

for (const protocol of ['codex', 'opencode', 'qoder', 'qwen', 'claude']) {
  test(`${protocol} falls back to the same prefix cadence when MCP instructions exceed the byte budget`, async t => {
    const h = harness(t, { protocol, profileOverrides: {
      sessionInstructions: `Driver-specific rules: ${'规则'.repeat(COORDINATOR_MCP_INSTRUCTIONS_MAX_BYTES)}`,
    } })
    assert.equal(h.backend.coordinatorUsesMcpInstructions(), false)
    for (let round = 1; round <= 41; round += 1) {
      await h.submit(`oversized-${round}`)
      assert.equal(hasRules(h.calls.at(-1)), [1, 21, 41].includes(round), `round ${round}`)
      assert.equal(h.turns(), round)
    }
    assert.equal(h.registrations.length, 1)
    assert.equal(h.registrations[0].options.instructions, '')
  })
}

for (const protocol of backendIds()) {
  for (const textBlocks of [true, false]) {
    test(`${protocol} preserves ${textBlocks ? 'multiple text and media' : 'media-only'} ContentBlocks during refresh`, async t => {
      const h = harness(t, { protocol })
      const image = Object.freeze({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' })
      const audio = Object.freeze({ type: 'audio', mimeType: 'audio/wav', data: 'd29ybGQ=' })
      const blocks = Object.freeze(textBlocks
        ? [image, Object.freeze({ type: 'text', text: 'first instruction', annotations: { audience: ['assistant'] } }),
            audio, Object.freeze({ type: 'text', text: 'second instruction' })]
        : [image, audio])
      const original = structuredClone(blocks)
      await h.backend.coordinatorTurn(blocks, { ownerId: 'owner', coordinationRunId: 'content-first' })
      const refreshed = h.calls[0].prompt
      assert.equal(Array.isArray(refreshed), true)
      assert.equal(refreshed.length, blocks.length + (textBlocks ? 0 : 1))
      assert.equal(hasRules(h.calls[0]), true)
      assert.equal(promptText(refreshed).split(h.backend.stableCoordinatorInstructions()).length - 1, 1)
      assert.deepEqual(refreshed.filter(block => block.type !== 'text'), [image, audio])
      if (textBlocks) {
        assert.deepEqual(refreshed[1].annotations, blocks[1].annotations)
        assert.match(refreshed[1].text, /first instruction$/u)
        assert.strictEqual(refreshed[3], blocks[3])
      } else {
        assert.equal(refreshed[0].type, 'text')
      }
      assert.deepEqual(blocks, original, 'refresh must not mutate the caller\'s ContentBlocks')
      await h.backend.coordinatorTurn(blocks, { ownerId: 'owner', coordinationRunId: 'content-second' })
      assert.deepEqual(h.calls[1].prompt, blocks)
      assert.equal(hasRules(h.calls[1]), false)
      assert.equal(h.turns(), 2)
    })
  }
}

for (const protocol of backendIds()) {
  test(`${protocol} preserves accepted round counts and the coordinator Session across restart`, async t => {
    const sessionStatePath = registryPath(t)
    const first = harness(t, { protocol, sessionStatePath })
    for (let round = 1; round <= 20; round += 1) await first.submit(`before-restart-${round}`)
    const sessionId = first.session().sessionId
    const stored = JSON.parse(readFileSync(sessionStatePath, 'utf8'))
    assert.equal(stored.version, 1)
    assert.equal(stored.coordinators[coordinatorKey('owner', protocol)].contractVersion, 8)
    assert.equal(stored.coordinators[coordinatorKey('owner', protocol)].coordinatorPromptTurns, 20)
    await first.backend.close()

    const restored = harness(t, { protocol, sessionStatePath })
    await restored.submit('after-restart-21')
    assert.deepEqual(restored.resumed, [sessionId])
    assert.equal(restored.calls[0].sessionId, sessionId)
    assert.equal(hasRules(restored.calls[0]), true)
    assert.equal(restored.turns(), 21)
    await restored.submit('after-restart-22')
    assert.equal(hasRules(restored.calls[1]), false)
    assert.equal(restored.turns(), 22)
  })
}

test('a compatible stored Session without a counter gets its first refresh on restore', async t => {
  const sessionStatePath = registryPath(t)
  const first = harness(t, { sessionStatePath })
  const session = await first.backend.ensureCoordinatorSession('owner')
  assert.equal(Object.hasOwn(first.saved(), 'coordinatorPromptTurns'), false)
  await first.backend.close()

  const restored = harness(t, { sessionStatePath })
  await restored.submit('legacy-first')
  assert.deepEqual(restored.resumed, [session.sessionId])
  assert.equal(hasRules(restored.calls[0]), true)
  assert.equal(restored.turns(), 1)
  await restored.submit('legacy-second')
  assert.equal(hasRules(restored.calls[1]), false)
  assert.equal(restored.turns(), 2)
})

test('a replacement coordinator Session resets the saved refresh counter', async t => {
  const sessionStatePath = registryPath(t)
  const first = harness(t, { sessionStatePath })
  const old = await first.backend.ensureCoordinatorSession('owner')
  first.backend.registry.set(coordinatorKey('owner', 'codex'), { ...old, coordinatorPromptTurns: 19 })
  await first.backend.close()

  const replacement = harness(t, { sessionStatePath })
  replacement.failResume = true
  await replacement.submit('new-session')
  assert.deepEqual(replacement.resumed, [old.sessionId])
  assert.notEqual(replacement.calls[0].sessionId, old.sessionId)
  assert.equal(hasRules(replacement.calls[0]), true)
  assert.equal(replacement.turns(), 1)
})

test('failure before ACP acceptance preserves the first refresh and ignores stale updates', async t => {
  const h = harness(t)
  h.handlePrompt = () => { throw new Error('failed before acceptance') }
  await assert.rejects(h.submit('not-accepted'), /failed before acceptance/u)
  assert.equal(h.turns(), 0)
  assert.equal(hasRules(h.calls[0]), true)
  progress(h.calls[0])
  assert.equal(h.turns(), 0, 'a closed failed round must not accept a late callback')
  h.handlePrompt = null
  await h.submit('accepted')
  assert.equal(h.calls[1].sessionId, h.calls[0].sessionId)
  assert.equal(hasRules(h.calls[1]), true)
  assert.equal(h.turns(), 1)
  progress(h.calls[0])
  assert.equal(h.turns(), 1, 'the stale round must not overwrite the live counter')
  await h.submit('next')
  assert.equal(hasRules(h.calls[2]), false)
  assert.equal(h.turns(), 2)
})

test('multiple ACP updates and the final result acknowledge one logical coordinator round only once', async t => {
  const h = harness(t)
  h.handlePrompt = call => {
    assert.equal(h.turns(), 0)
    progress(call)
    assert.equal(h.turns(), 1, 'the first update persists acceptance before the result')
    progress(call)
    assert.equal(h.turns(), 1)
    return completed()
  }
  await h.submit('streamed')
  assert.equal(h.turns(), 1)
  h.handlePrompt = null
  await h.submit('next')
  assert.equal(h.turns(), 2)
  assert.equal(hasRules(h.calls[1]), false)
})

for (const outcome of ['error-after-update', 'cancelled', 'max_tokens']) {
  test(`accepted ${outcome} still consumes exactly one coordinator round`, async t => {
    const h = harness(t)
    h.handlePrompt = call => {
      if (outcome === 'error-after-update') {
        progress(call)
        progress(call)
        throw new Error('failed after acceptance')
      }
      return { content: 'partial', response: { stopReason: outcome } }
    }
    await assert.rejects(h.submit('interrupted'))
    assert.equal(h.turns(), 1)
    h.handlePrompt = null
    await h.submit('following')
    assert.equal(hasRules(h.calls[1]), false)
    assert.equal(h.turns(), 2)
  })
}

for (const steeringMode of ['extension', 'pull']) {
  test(`${steeringMode} steering inside one coordinator round does not advance its refresh counter`, async t => {
    const h = harness(t, { steeringMode })
    const gate = Promise.withResolvers()
    h.handlePrompt = call => { progress(call); return gate.promise }
    const running = h.submit('steered')
    running.catch(() => {})
    await waitFor(() => h.turns() === 1)
    for (let update = 1; update <= 2; update += 1) {
      const receipt = h.backend.update('steered', { instruction: `adjustment ${update}` }, { ownerId: 'owner' })
      if (steeringMode === 'pull') {
        const drained = h.calls[0].input.onMidTurnDrain()
        assert.equal(drained.items.length, 1)
        assert.equal(promptText(drained.items[0].content).includes(COORDINATOR_STABLE_INSTRUCTIONS), false)
      }
      await receipt.completion
      assert.equal(h.turns(), 1)
    }
    assert.equal(h.calls.length, 1)
    if (steeringMode === 'extension') {
      assert.equal(h.steering.length, 2)
      assert.ok(h.steering.every(call => !hasRules(call)))
    }
    gate.resolve(completed())
    await running
    assert.equal(h.turns(), 1)
    h.handlePrompt = null
    await h.submit('after-steering')
    assert.equal(h.turns(), 2)
    assert.equal(hasRules(h.calls[1]), false)
  })
}

test('execute, update and result coordinator phases all contribute to the same refresh cadence', async t => {
  const h = harness(t)
  const phases = ['execute', 'update', 'result']
  for (let round = 1; round <= 21; round += 1) {
    await h.backend.coordinatorTurn(`phase round ${round}`, {
      ownerId: 'owner', coordinationRunId: `phase-${round}`, phase: phases[(round - 1) % phases.length],
    })
    assert.equal(h.turns(), round)
    assert.equal(hasRules(h.calls.at(-1)), round === 1 || round === 21)
  }
})

test('project prompts neither contain coordinator rules nor advance the coordinator counter', async t => {
  const h = harness(t)
  let delegated = false
  h.handlePrompt = async call => {
    if (call.session.input.role === 'coordinator' && !delegated) {
      delegated = true
      await h.registrations[0].context.startSession({ prompt: 'independent project work' })
    }
    return completed()
  }
  await h.submit('delegated')
  const coordinatorCalls = h.calls.filter(call => call.session.input.role === 'coordinator')
  const projectCalls = h.calls.filter(call => call.session.input.role === 'project')
  assert.equal(coordinatorCalls.length, 2, 'execute and final synthesis each count as one round')
  assert.equal(projectCalls.length, 1)
  assert.equal(promptText(projectCalls[0].prompt), 'independent project work')
  assert.equal(hasRules(projectCalls[0]), false)
  assert.equal(projectCalls[0].session.coordinatorPromptTurns, undefined)
  assert.equal(h.turns(), 2)
  assert.deepEqual(coordinatorCalls.map(hasRules), [true, false])
})

test('coordinator refresh counters are isolated per owner', async t => {
  const h = harness(t)
  for (let round = 1; round <= 20; round += 1) await h.submit(`a-${round}`, 'owner-a')
  await h.submit('b-first', 'owner-b')
  assert.equal(hasRules(h.calls.at(-1)), true)
  assert.equal(h.turns('owner-a'), 20)
  assert.equal(h.turns('owner-b'), 1)
  await h.submit('a-21', 'owner-a')
  assert.equal(hasRules(h.calls.at(-1)), true)
  await h.submit('b-second', 'owner-b')
  assert.equal(hasRules(h.calls.at(-1)), false)
  assert.equal(h.turns('owner-a'), 21)
  assert.equal(h.turns('owner-b'), 2)
  assert.notEqual(h.session('owner-a').sessionId, h.session('owner-b').sessionId)
  assert.equal(h.registrations.length, 2)
  assert.ok(h.registrations.every(item => item.options.instructions === COORDINATOR_STABLE_INSTRUCTIONS))
})
