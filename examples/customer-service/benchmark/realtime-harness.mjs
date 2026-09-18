import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { CUSTOMER_SERVICE_SPAWN_THINKING_DESCRIPTION } from '../gateway/spawn-thinking-tool.mjs'

export function assistantText(event) {
  if (event.type === 'response.text.done') return event.text || ''
  if (['response.audio_transcript.done', 'response.output_audio_transcript.done'].includes(event.type)) {
    return event.transcript || ''
  }
  if (event.type === 'transcript.final' && event.role === 'assistant') return event.text || event.content || ''
  return ''
}

export function toolCall(event) {
  if (event.type !== 'response.function_call_arguments.done') return null
  return { name: event.name, callId: event.call_id, args: JSON.parse(event.arguments || '{}') }
}

export function isTaskBlocking(task) {
  if (task.inputRequest?.status === 'pending' || task.authorization?.status === 'pending') return false
  return ['queued', 'running', 'delegated', 'finalizing', 'cancelling'].includes(task.status)
}

export function safeEvent(event) {
  const copy = structuredClone(event)
  if (/audio.*delta/u.test(copy.type || '') && copy.delta) copy.delta = '<audio>'
  if (copy.audio) copy.audio = '<audio>'
  return copy
}

export function affectsTurnSettlement(event) {
  // A2A polls can emit progress every second while waiting for the user.
  // Those heartbeats must not postpone the user's opportunity to answer.
  return event.type !== 'task.progress' && !['task.snapshot', 'voice.connection', 'agent.activity'].includes(event.type)
}

export function withTauPolicy(provider, { policy, mode, definitions, onResponse = () => {} }) {
  const transportState = { activeResponses: new Set(), responseCreates: 0 }
  const role = mode === 'realtime-only'
    ? 'You are the customer service agent. Use the supplied official tools to complete the customer request, following the policy. Get explicit confirmation before database updates.'
    : 'You are the customer-facing service agent. Use frontend MCP tools for simple read-only inquiries. Delegate ALL database updates and complex workflows to spawn_thinking, providing all relevant public customer dialogue and identifiers. Looking through multiple orders/reservations is a complex workflow: delegate it rather than iterating beyond the frontend safety budget. If a frontend tool reaches its safety limit, the backend can continue the investigation; do not claim that the business service is unavailable. A delegated task is NOT a human escalation. When an input request is pending, use respond_agent_input to return the customer decision to that SAME task. Never start a new task just to approve a pending operation. Do not approve on behalf of the customer. Clearly convey task questions and final results.'
  return {
    ...provider,
    benchmarkState: transportState,
    buildSession(options) {
      const session = provider.buildSession(options)
      session.instructions = [
        mode === 'harness' ? session.instructions : '',
        role,
        ...(mode === 'harness' ? ['Delegating work, customer confirmation, an operation preview, and task completion are NOT proof of a database update. Until a committed operation result arrives, never say submitted, processed, refunded, exchanged, or modified. Backend input requests are questions for the CUSTOMER, not questions for you to answer as the customer. Read the proposed action naturally, then WAIT for a new customer answer before calling respond_agent_input. If the customer already confirmed before a runtime preview was created, do not silently treat that as authorization of the new preview. Do not announce completion while a request is pending. When a read tool hits its budget, actually call spawn_thinking; saying you will delegate is not a tool call.'] : []),
        'Respond in English. Do not invent facts. The following is the complete authoritative business policy; it replaces demo business rules. For the airline benchmark, the current time is fixed at 2024-05-15 15:00:00. Do not use the host date for eligibility.',
        '<official_policy>', policy, '</official_policy>',
      ].filter(Boolean).join('\n\n')
      if (mode === 'realtime-only') {
        session.tools = definitions.map(tool => ({ type: 'function', function: {
          name: tool.name, description: tool.description, parameters: tool.inputSchema,
        } }))
      }
      if (!options.configured) {
        session.modalities = ['text']
        session.turn_detection = null
        delete session.voice
        delete session.output_audio_format
      }
      return session
    },
    buildResultInjection(content, options) {
      const injection = provider.buildResultInjection(content, options)
      injection.response.modalities = ['text']
      return injection
    },
    buildSpeakResponse(content) {
      return { ...provider.buildSpeakResponse(content), modalities: ['text'] }
    },
    createProtocol() {
      // Instrument the actual transport without changing event semantics.
      const protocol = { ...provider.protocol }
      const encode = protocol.responseCreate
      if (encode) protocol.responseCreate = (...args) => {
        transportState.responseCreates += 1
        onResponse()
        return encode(...args)
      }
      protocol.normalizeIncoming = event => {
        if (event.type === 'response.created') transportState.activeResponses.add(event.response.id)
        if (event.type === 'response.done') transportState.activeResponses.delete(event.response.id)
        return provider.protocol.normalizeIncoming(event)
      }
      return protocol
    },
  }
}

async function waitUntil(predicate, { signal, timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    signal?.throwIfAborted()
    if (Date.now() >= deadline) throw new Error('Realtime harness turn timed out')
    await delay(50, undefined, { signal })
  }
}

export async function createRealtimeOnly({ provider, scenarios, sessionId, signal, events }) {
  const { RealtimeFrontend } = await import('../../../server/src/voice/realtime-provider.mjs')
  let frontend, failure, lastEventAt = Date.now(), responses = 0
  const pending = new Set(), texts = []
  frontend = new RealtimeFrontend({ provider, onError(error) { failure = error }, onEvent(event) {
    events.push(safeEvent(event))
    lastEventAt = Date.now()
    if (event.type === 'response.created') responses += 1
    const text = assistantText(event)
    if (text) texts.push(text)
    if (event.type === 'error' && !event.__voiceRetried) failure = new Error(event.error?.message || 'Realtime error')
    let call
    try { call = toolCall(event) } catch (error) { failure = error; return }
    if (!call) return
    const operation = (async () => {
      try {
        signal.throwIfAborted()
        const output = await scenarios.request('raw-call', sessionId, { name: call.name, args: call.args })
        await frontend.sendFunctionOutput(call.callId, output, {}, { response: { modalities: ['text'] } })
      } catch (error) { failure = error }
    })()
    pending.add(operation)
    operation.finally(() => pending.delete(operation))
  } })
  try { await frontend.connect() } catch (error) { frontend.close(); throw error }
  return {
    async turn(text) {
      const start = texts.length
      await frontend.sendUserText(text, {}, { modalities: ['text'] })
      await waitUntil(() => {
        if (failure) throw failure
        return texts.length > start && !pending.size && !frontend.activeResponses.size
          && !frontend.pendingResponses.length && Date.now() - lastEventAt >= 800
      }, { signal })
      return texts.slice(start).join('\n')
    },
    counts() { return { realtimeResponses: responses } },
    async close() { frontend.close(); await Promise.allSettled(pending) },
  }
}

export async function createFullHarness({ provider, agentServer, serviceOrigin, sessionId,
  definitions, directory, signal, events, config }) {
  const [
    { createGatewayApplication }, { createA2ABackendAdapter }, { createBackendAgentHost },
    { createRealtimeProviderRegistry }, { FrontendMcpClient },
    { normalizeFrontendMcpConfiguration }, { ConversationSync },
  ] = await Promise.all([
    import('../../../server/src/app/gateway-application.mjs'),
    import('../../../server/src/backend/adapters/a2a/backend-adapter.mjs'),
    import('../../../server/src/backend/backend-adapter-sdk.mjs'),
    import('../../../server/src/voice/providers/provider-registry.mjs'),
    import('../../../server/src/frontend/tools/mcp/frontend-mcp-client.mjs'),
    import('../../../server/src/frontend/tools/mcp/frontend-mcp-config.mjs'),
    import('../../../server/src/conversation/conversation-sync.mjs'),
  ])
  const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this } }
  const backend = createA2ABackendAdapter({ agentCardUrl: agentServer.agentCardUrl, pollIntervalMs: 25 })
  const host = createBackendAgentHost(backend)
  const url = new URL('/mcp/frontend', serviceOrigin)
  url.searchParams.set('sessionId', sessionId)
  const frontendMcp = new FrontendMcpClient({ logger, configuration: normalizeFrontendMcpConfiguration({
    version: 1, servers: { customer: { enabled: true, url: url.toString(), tools: Object.fromEntries(
      definitions.filter(tool => tool.annotations.readOnlyHint).map(tool => [tool.name, { enabled: true }]),
    ) } },
  }) })
  const application = createGatewayApplication({
    config: { ...config, host: '127.0.0.1', port: 0, identityMode: 'personal', personalOwnerId: 'tau-harness',
      authSecret: randomUUID() + randomUUID(), gatewayAccessToken: '', gatewayAccessKeys: '',
      stateDirectory: directory, taskStatePath: resolve(directory, 'tasks.json'),
      gatewayDeviceStatePath: resolve(directory, 'devices.json'), memoryAuditPath: resolve(directory, 'audit.jsonl'),
      sessionDigestEnabled: false, memoryAutoEnabled: false,
      frontendDisabledTools: ['schedule_reminder', 'web_search', 'fetch_url', 'knowledge', 'notes', 'recall', 'get_current_time', 'enter_sleep'],
    },
    agent: host, autoStart: false, logger, frontendMcp, frontendOpenApi: null,
    realtimeProvider: provider.key, realtimeProviderRegistry: createRealtimeProviderRegistry({ providers: [provider] }),
    conversationSync: new ConversationSync(), memoryProvider: null,
    knowledgeRetrievalProvider: null, webSearchProvider: null, urlFetcher: null,
    spawnThinkingDescription: CUSTOMER_SERVICE_SPAWN_THINKING_DESCRIPTION,
  })
  let ws, failure, lastEventAt = Date.now(), ready = false, responses = 0
  const texts = [], activeResponses = new Set(), tasks = new Map()
  try {
    await frontendMcp.initialize()
    if (!frontendMcp.health().ok || !frontendMcp.tools().length) throw new Error('Frontend MCP tools failed to initialize')
    const server = application.start({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/realtime?sessionId=${sessionId}`)
    ws.on('error', error => { failure = error })
    ws.on('message', raw => {
      const event = JSON.parse(raw)
      events.push(safeEvent(event))
      if (affectsTurnSettlement(event)) lastEventAt = Date.now()
      if (event.type === 'voice.ready') ready = true
      if (event.type === 'error') failure = new Error(event.message || 'Gateway error')
      if (event.task?.id) tasks.set(event.task.id, event.task)
      if (event.type === 'response.started') { activeResponses.add(event.responseId); responses += 1 }
      if (['audio.done', 'response.interrupted'].includes(event.type)) activeResponses.delete(event.responseId)
      const text = assistantText(event)
      if (text) texts.push(text)
    })
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'connect', textOnly: true, provider: provider.key,
      inputEnabled: false, outputEnabled: true, clientType: 'web', locale: 'en-US', timeZone: 'UTC' }))
    await waitUntil(() => { if (failure) throw failure; return ready }, { signal, timeoutMs: 30_000 })
  } catch (error) {
    ws?.terminate()
    await host.close()
    await application.close()
    throw error
  }
  return {
    async turn(text) {
      const start = texts.length
      ws.send(JSON.stringify({ type: 'text.message', text }))
      await waitUntil(() => {
        if (failure) throw failure
        return texts.length > start && !provider.benchmarkState.activeResponses.size
          && ![...tasks.values()].some(isTaskBlocking) && Date.now() - lastEventAt >= 1500
      }, { signal, timeoutMs: 120_000 })
      return texts.slice(start).join('\n')
    },
    counts() { return { realtimeResponses: responses, backendTasks: tasks.size,
      failedBackendTasks: [...tasks.values()].filter(task => task.status === 'failed').length } },
    async close() { ws.terminate(); await host.close(); await application.close() },
  }
}
