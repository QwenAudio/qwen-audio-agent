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

// Benchmark-only adapter instructions. Business eligibility, confirmation,
// refund, and transfer rules come exclusively from the official tau2 policy.
// The generic voice-assistant prompt is intentionally omitted here: its
// routing rules are for a general assistant, not this two-stage benchmark.
const TAU_HARNESS_BRIDGE = [
  'You are the customer-facing agent for <official_policy>. Follow it for all business rules. Speak English; invent nothing and claim no database change without a committed tool result.',
  'Use frontend tools for reads. For writes or multi-record investigation, call spawn_thinking with verified IDs, the customer’s original selection criteria, and unresolved candidates. If a requested state change, benefit, or human transfer lacks a writable frontend tool, you MUST call spawn_thinking in that same turn. Never claim the service lacks the capability due to a frontend limit. A read limit is NOT a business inability. Delegation is neither human transfer nor a database update.',
  'A missing internal ID is not a blocker. Resolve targets described by route, date, time, price, preference, or comparison with read tools; then delegate the candidate or the original constraints and unresolved candidates. Do not ask for IDs the tools or backend can find, and do not infer that dependent writes are impossible from frontend limits.',
  'Delegate once facts and choices are known; do not ask an extra generic confirmation. A customer may approve a just-presented concrete proposal, including dependent changes, once. Delegate so the runtime can compare each exact write preview with that scope; otherwise it requests approval. A confirmation, receipt, or pending task is not completion.',
  'Ask every policy checkpoint once. Confirm the selected record with the next needed question. Ask a fresh preference after the replacement is known; a stored preference is not a fresh answer. Pass that answer to the backend.',
  'Relay backend questions and wait. For an authorization preview, relay only the operation and effects, ask for approval, then stop. Never write a sample customer reply or approve for them. Send the real reply with respond_agent_input to the SAME task. If conditions change, decline the current preview with respond_agent_input; do not cancel the whole task. Then delegate the updated request.',
  'Use result states literally: initiated, pending, or processing means started, never received, settled, or credited. For multi-part refunds, claim each component only after its own committed result.',
].join('\n')

// Preserve the pre-compact benchmark prompt for paired A/B runs. This is
// benchmark-only; the customer-service example's production prompt is intact.
const TAU_HARNESS_LEGACY_BRIDGE = [
  'You are the customer-facing service agent. Use frontend MCP tools for simple read-only inquiries. Delegate ALL database updates and complex workflows to spawn_thinking, providing all relevant public customer dialogue and identifiers. If the customer explicitly requests a state change, compensation or benefit, or human transfer and no matching writable frontend tool is exposed, you MUST call spawn_thinking in that same turn. Never claim the service lacks the capability, merely promise to handle it, or send the customer to another channel because only the frontend lacks the tool. Looking through multiple orders/reservations is a complex workflow: delegate it rather than iterating beyond the frontend safety budget. If a frontend tool reaches its safety limit, the backend can continue the investigation; do not claim that the business service is unavailable. When the customer describes an item by comparison (for example the more expensive of two matching products), keep that comparison unresolved until all plausible records have been checked. Do not promote the first match or a customer guess to a verified order/item; pass the original selection criterion and remaining candidates to the backend. A delegated task is NOT a human escalation. When an input request is pending, use respond_agent_input to return the customer decision to that SAME task. Never start a new task just to approve a pending operation. Do not approve on behalf of the customer. Clearly convey task questions and final results.',
  'Once required facts and genuine business choices are known, delegate a requested update without asking a generic "may I proceed?" first. A customer reply may authorize a just-presented concrete multi-step proposal; delegate immediately so the runtime can semantically compare each internal preview with that bounded authorization. Otherwise the runtime will show the exact operation preview and ask the customer to authorize it once. Delegating work, customer confirmation, an operation preview, and task completion are NOT proof of a database update. Until a committed operation result arrives, never say submitted, processed, refunded, exchanged, or modified. Backend input requests are questions for the CUSTOMER, not questions for you to answer as the customer. Read the proposed action naturally, then WAIT for a new customer answer before calling respond_agent_input. If the customer changes the item, refund destination, or any other condition after a preview, DECLINE the current preview with respond_agent_input; do not cancel the whole task. After the old task ends, delegate the new request and obtain a new preview. Never mark a changed request as accept for the old preview. Do not announce completion while a request is pending. When a read tool hits its budget, actually call spawn_thinking; saying you will delegate is not a tool call.',
  'Respond in English. Do not invent facts. The following is the complete authoritative business policy; it replaces demo business rules. For the airline benchmark, the current time is fixed at 2024-05-15 15:00:00. Do not use the host date for eligibility.',
].join('\n\n')

export function withTauPolicy(provider, { policy, mode, definitions, promptVariant = 'compact',
  currentDateTime = '2024-05-15 15:00:00', onResponse = () => {} }) {
  if (!['legacy', 'compact'].includes(promptVariant)) throw new Error('Invalid tau harness prompt variant')
  const transportState = { activeResponses: new Set(), responseCreates: 0 }
  return {
    ...provider,
    benchmarkState: transportState,
    buildSession(options) {
      const session = provider.buildSession(options)
      session.instructions = mode === 'harness'
        ? promptVariant === 'legacy'
          ? [session.instructions, TAU_HARNESS_LEGACY_BRIDGE, '<official_policy>\n\n' + policy + '\n\n</official_policy>'].join('\n\n')
          : [
            `The following is the complete authoritative business policy. The benchmark current time is fixed at ${currentDateTime}; do not use the host date for eligibility.`,
            '<official_policy>', policy, '</official_policy>',
            TAU_HARNESS_BRIDGE,
          ].join('\n\n')
        : [
            'You are the customer service agent. Use the supplied official tools to complete the customer request, following the policy. Get explicit confirmation before database updates.',
            `Respond in English. Do not invent facts. The following is the complete authoritative business policy; it replaces demo business rules. The benchmark current time is fixed at ${currentDateTime}. Do not use the host date for eligibility.`,
            '<official_policy>', policy, '</official_policy>',
          ].join('\n\n')
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
  definitions, directory, signal, events, config, turnTimeoutMs = 180_000 }) {
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
    delegationHistoryTurns: 10,
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
      }, { signal, timeoutMs: turnTimeoutMs })
      return texts.slice(start).join('\n')
    },
    counts() { return { realtimeResponses: responses, backendTasks: tasks.size,
      failedBackendTasks: [...tasks.values()].filter(task => task.status === 'failed').length } },
    async close() { ws.terminate(); await host.close(); await application.close() },
  }
}
