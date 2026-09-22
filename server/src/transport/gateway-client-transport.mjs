import { WebSocket, WebSocketServer } from 'ws'
import { ActiveVoiceClients } from '../client/active-voice-clients.mjs'
import { selectGatewayWebSocketProtocol } from '../../../shared/gateway/websocket-auth.mjs'
import { GatewayClientEvent } from '../../../shared/protocol/realtime-events.mjs'
import { logger as defaultLogger } from '../core/logger.mjs'
import { isAllowedOrigin } from '../core/request-security.mjs'
import { projectGatewayTaskEvent } from './gateway-task-event-projector.mjs'
import { GatewayClientProtocolSession } from './gateway-client-protocol-session.mjs'
import {
  GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES,
  GATEWAY_CLIENT_OCCUPIED_CLOSE_CODE,
  GATEWAY_CLIENT_REPLACED_CLOSE_CODE,
  GATEWAY_CLIENT_REVOKED_CLOSE_CODE,
  GatewayClientCapability,
  GatewayClientProtocolEvent,
  GatewaySessionPongSchema,
} from '../../../shared/protocol/gateway-client-protocol.mjs'
import { clientActionCapabilities as defineClientActionCapabilities } from '../client/client-action-port.mjs'
import { GatewayClientReplayBuffer } from './gateway-client-replay-buffer.mjs'
import { ActiveClientLeases } from '../client/active-client-leases.mjs'

const MAX_CLIENT_REPLAY_SESSIONS = 32
const CLIENT_HEARTBEAT_MS = 30_000
const clientProtocolSessions = new WeakMap()

function send(ws, event) {
  if (ws.readyState !== WebSocket.OPEN) return
  const protocol = clientProtocolSessions.get(ws)
  const wireEvent = protocol ? protocol.encode(event) : event
  if (wireEvent) ws.send(JSON.stringify(wireEvent))
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`)
  socket.destroy()
}

export function rejectUnsupportedRealtimeUpgrade(socket, pathname) {
  if (pathname === '/api/realtime') return false
  socket.destroy()
  return true
}

function clientDescriptor(event = {}) {
  // Client type is descriptive metadata. Runtime behavior is negotiated from
  // capabilities, so a new first- or third-party Client never needs a Gateway
  // allowlist entry before it can speak GCP.
  const type = String(event.clientType || '').trim().slice(0, 40) || 'unknown'
  const label = String(event.clientLabel || '').trim().slice(0, 40)
  return {
    type,
    ...(label ? { label } : {}),
    instanceId: String(event.clientInstanceId || '').trim().slice(0, 80) || null,
  }
}
export function attachGatewayClientTransport(server, {
  identityManager,
  frontendRuntime,
  inputArbitration = null,
  logger = defaultLogger,
  clientActionNames = [],
  clientCommandRuntime = null,
  clientEventRouter = null,
}) {
  if (typeof frontendRuntime?.createSession !== 'function') {
    throw new TypeError('frontendRuntime.createSession is required')
  }
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 20 * 1024 * 1024,
    handleProtocols: selectGatewayWebSocketProtocol,
  })
  const actionCapabilities = defineClientActionCapabilities(clientActionNames)
  const supportedClientCapabilities = [...new Set([
    ...GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES,
    ...Object.values(actionCapabilities),
  ])]
    .filter(capability => {
      if (capability === GatewayClientCapability.CLIENT_EVENTS) {
        return Boolean(clientEventRouter)
      }
      if ([
        GatewayClientCapability.TASK_COMMANDS,
        GatewayClientCapability.PERMISSION_RESPOND,
        GatewayClientCapability.INPUT_RESPOND,
        GatewayClientCapability.CONVERSATION_HISTORY,
      ].includes(capability)) return Boolean(clientCommandRuntime)
      return true
    })
  const activeVoiceClients = new ActiveVoiceClients()
  const attachedClients = new Set()
  const activeClientLeases = new ActiveClientLeases()
  const voiceConnections = new Map()
  const replayBuffers = new Map()
  // A suspension is global, not per owner: the host is taking the machine's
  // microphone, so every connected client has to let go of it. The subscription
  // lives as long as this WebSocket server.
  const unsubscribeInput = inputArbitration?.subscribe(status => {
    for (const clients of voiceConnections.values()) {
      for (const client of clients) {
        client.applyInputSuspension?.(status)
      }
    }
  })

  const broadcastVoiceOwnership = ownerId => {
    const active = activeVoiceClients.active(ownerId)
    const holder = active?.descriptor || null
    for (const client of voiceConnections.get(ownerId) || []) {
      send(client.ws, {
        type: 'voice.ownership',
        state: active === client
          ? 'active'
          : holder ? 'busy' : 'available',
        holder,
      })
    }
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost')
    if (rejectUnsupportedRealtimeUpgrade(socket, url.pathname)) return
    const identity = identityManager.resolveUpgrade(request)
    if (!identity) {
      rejectUpgrade(socket, '401 Unauthorized', 'identity required')
      return
    }
    if (!isAllowedOrigin(request, {
      authenticatedRemote: identity.access === 'remote',
      trustedNativeClient: ['client', 'mobile'].includes(identity.clientType),
    })) {
      rejectUpgrade(socket, '403 Forbidden', 'origin not allowed')
      return
    }
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, url, identity)
    })
  })

  const attachClient = (ws, url, identity) => {
    ws.isAlive = true
    ws.gatewayCredentialId = identity.access === 'remote'
      ? identity.credentialId
      : null
    ws.on('pong', () => { ws.isAlive = true })
    const ownerId = identity.ownerId
    const sessionId = url.searchParams.get('sessionId') || 'main'
    const replayKey = `${ownerId}\u0000${sessionId}`
    let replayBuffer = replayBuffers.get(replayKey)
    if (!replayBuffer) {
      while (replayBuffers.size >= MAX_CLIENT_REPLAY_SESSIONS) {
        replayBuffers.delete(replayBuffers.keys().next().value)
      }
      replayBuffer = new GatewayClientReplayBuffer()
      replayBuffers.set(replayKey, replayBuffer)
    } else {
      replayBuffers.delete(replayKey)
      replayBuffers.set(replayKey, replayBuffer)
    }
    const clientProtocol = new GatewayClientProtocolSession({
      sessionId,
      supportedCapabilities: hello => supportedClientCapabilities.filter(capability => (
        capability !== GatewayClientCapability.INPUT_IMAGE_BUFFER
        || frontendRuntime.supportsImageInput(hello.connection?.provider)
      )),
      replayBuffer,
    })
    clientProtocolSessions.set(ws, clientProtocol)
    const connectionLogger = logger.child({
      subsystem: 'realtime',
      ownerId,
      sessionId,
    })
    connectionLogger.info('voice_client.connected')
    let descriptor = clientDescriptor()
    let admitted = false
    let clientLease = null
    let runtimeMessageChain = Promise.resolve()
    const voiceClient = {
      ws,
      descriptor,
      applyInputSuspension: status => sessionRuntime.applyInputSuspension(status),
      realtimeStatus: () => sessionRuntime.status(),
      isAlive: () => ws.readyState === WebSocket.OPEN,
      deactivate: replacement => sessionRuntime.deactivate(replacement?.descriptor),
    }
    const sessionRuntime = frontendRuntime.createSession({
      actionCapabilities,
      ownerId,
      sessionId,
      send: event => send(ws, event),
      logger: connectionLogger,
      initialInputSuspension: inputArbitration?.status?.(),
      voiceAccess: {
        isActive: () => activeVoiceClients.isActive(ownerId, voiceClient),
        claim: () => {
          const result = activeVoiceClients.activate(ownerId, voiceClient, {
            replace: clientLease?.replaced === true,
          })
          if (result.granted && clientLease) clientLease.replaced = false
          return { granted: result.granted }
        },
        release: () => activeVoiceClients.release(ownerId, voiceClient),
        changed: () => broadcastVoiceOwnership(ownerId),
      },
      onTaskEvent: event => {
        const publicEvent = projectGatewayTaskEvent(event)
        if (publicEvent) send(ws, publicEvent)
      },
      onResponseDone: event => ws.onResponseDone?.(event),
    })
    if (!voiceConnections.has(ownerId)) voiceConnections.set(ownerId, new Set())
    voiceConnections.get(ownerId).add(voiceClient)
    sessionRuntime.start()
    const runtimeSource = () => ({
      ownerId,
      sessionId,
      clientType: descriptor.type,
      clientInstanceId: descriptor.instanceId,
    })
    const leaseParticipant = {
      isAlive: () => ws.readyState === WebSocket.OPEN,
      deactivate: replacement => {
        sessionRuntime.deactivate(replacement?.client?.descriptor)
        ws.close(GATEWAY_CLIENT_REPLACED_CLOSE_CODE, 'client_replaced')
      },
      descriptor,
    }
    const admitClientConnection = nextDescriptor => {
      leaseParticipant.descriptor = nextDescriptor
      const claimed = activeClientLeases.claim(ownerId, leaseParticipant, {
        instanceId: nextDescriptor.instanceId,
        takeover: nextDescriptor.takeoverRequested === true,
      })
      if (!claimed.granted) return null
      clientLease = { ...claimed.lease, replaced: claimed.replaced }
      admitted = true
      if (claimed.replaced) connectionLogger.info('voice_client.replaced', {
        clientType: nextDescriptor.type,
        clientInstanceId: nextDescriptor.instanceId,
        leaseGeneration: clientLease.generation,
        explicitTakeover: nextDescriptor.takeoverRequested === true,
      })
      return clientLease
    }
    const rejectOccupiedClient = () => {
      send(ws, {
        type: 'error',
        message: 'Gateway 已由另一个 Client 使用',
        error: {
          code: 'client_occupied',
          message: 'Gateway already has an active Client connection',
        },
      })
      ws.close(GATEWAY_CLIENT_OCCUPIED_CLOSE_CODE, 'client_occupied')
    }
    const sendRuntimeError = (message, error) => {
      connectionLogger.warn('client_runtime.command_failed', {
        type: String(message?.type || ''),
        requestEventId: String(message?.event_id || ''),
        code: String(error?.code || 'internal'),
        error: String(error?.message || error),
      })
      send(ws, {
        type: 'error',
        ...(message?.event_id
          ? { request_event_id: String(message.event_id) }
          : {}),
        error: {
          code: String(error?.code || 'internal').slice(0, 80),
          message: String(error?.message || error).slice(0, 500),
        },
      })
    }
    const handleRuntimeMessage = async message => {
      // A command can wait behind an earlier asynchronous command. Recheck the
      // owner lease when it actually executes so a replaced socket cannot
      // mutate Gateway state with work that was queued before takeover.
      if (
        admitted
        && !activeClientLeases.isActive(
          ownerId,
          leaseParticipant,
          clientLease?.generation,
        )
      ) return
      if (message.type === GatewayClientProtocolEvent.CLIENT_ACTION_RESULT) {
        if (!sessionRuntime.receiveActionResult(message)) {
          connectionLogger.debug('client_action.result_stale', {
            requestEventId: message.request_event_id,
          })
        }
        return
      }
      if (message.type === GatewayClientProtocolEvent.CLIENT_PRESENCE_UPDATE) {
        sessionRuntime.updateClientPresence(message.state)
        return
      }
      if (message.type === GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATE) {
        const result = sessionRuntime.updateOutputVoice(message.voice)
        send(ws, {
          type: GatewayClientProtocolEvent.SESSION_OUTPUT_VOICE_UPDATED,
          request_event_id: message.event_id,
          ...result,
        })
        return
      }
      if (message.type === GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH) {
        if (!clientEventRouter) {
          const error = new Error('Client Event runtime unavailable')
          error.code = 'internal'
          throw error
        }
        const result = await clientEventRouter.publish(message, {
          source: runtimeSource(),
          effects: {
            setAssistantProfile(profile) {
              // Only a server-registered Client Event handler can reach this
              // effect. The Client supplies a schema-validated identifier,
              // while the handler owns the actual profile content.
              sessionRuntime.setAssistantProfile(profile)
            },
          },
        })
        connectionLogger.info('client_event.received', {
          name: result.name,
          duplicate: result.duplicate === true,
        })
        send(ws, {
          type: GatewayClientProtocolEvent.CLIENT_EVENT_PUBLISH_RESULT,
          request_event_id: message.event_id,
          accepted: result.accepted === true,
          name: result.name,
          ...(result.duplicate ? { duplicate: true } : {}),
        })
        sessionRuntime.handleClientDelivery(result)
        return
      }
      if (!clientCommandRuntime) {
        const error = new Error('Gateway Client command runtime unavailable')
        error.code = 'internal'
        throw error
      }
      const result = await clientCommandRuntime.execute(message, {
        ownerId,
        sessionId,
        source: runtimeSource(),
      })
      send(ws, result)
    }

    ws.on('message', raw => {
      let event
      try {
        event = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (
        event.type === GatewayClientProtocolEvent.SESSION_PONG
        && clientProtocol.capabilities.includes(GatewayClientCapability.SESSION_HEARTBEAT)
        && GatewaySessionPongSchema.safeParse(event).success
      ) {
        ws.isAlive = true
        return
      }
      const protocolOutcome = clientProtocol.receive(event)
      // WebSocket control-frame pongs are not reliably observable after every
      // reverse proxy. Any accepted application frame proves the Client is alive.
      if (!protocolOutcome.close && (
        protocolOutcome.event
        || protocolOutcome.runtimeMessage
        || protocolOutcome.reply?.type === GatewayClientProtocolEvent.SESSION_READY
      )) ws.isAlive = true
      if (protocolOutcome.close) {
        if (protocolOutcome.reply) send(ws, protocolOutcome.reply)
        ws.close(1002, protocolOutcome.reply?.error?.code || 'protocol error')
        return
      }
      const negotiatedEvent = protocolOutcome.event
      if (
        negotiatedEvent?.type === GatewayClientEvent.CONNECT
        && !admitted
      ) {
        const nextDescriptor = clientDescriptor(negotiatedEvent)
        const lease = admitClientConnection({
          ...nextDescriptor,
          takeoverRequested: negotiatedEvent.takeoverRequested === true,
        })
        if (!lease) {
          rejectOccupiedClient()
          return
        }
        if (protocolOutcome.reply?.type === GatewayClientProtocolEvent.SESSION_READY) {
          protocolOutcome.reply.connection = {
            lease_generation: lease.generation,
            replaced: lease.replaced === true,
          }
        }
      }
      if (protocolOutcome.reply) send(ws, protocolOutcome.reply)
      for (const pendingEvent of protocolOutcome.pending || []) {
        send(ws, pendingEvent)
      }
      if (protocolOutcome.runtimeMessage) {
        const runtimeMessage = protocolOutcome.runtimeMessage
        runtimeMessageChain = runtimeMessageChain
          .then(() => handleRuntimeMessage(runtimeMessage))
          .catch(error => sendRuntimeError(runtimeMessage, error))
        return
      }
      event = negotiatedEvent
      if (!event) return
      if (
        admitted
        && !activeClientLeases.isActive(
          ownerId,
          leaseParticipant,
          clientLease?.generation,
        )
      ) {
        ws.close(GATEWAY_CLIENT_REPLACED_CLOSE_CODE, 'client_replaced')
        return
      }
      if (event.type === GatewayClientEvent.CONNECT) {
        descriptor = clientDescriptor(event)
        voiceClient.descriptor = descriptor
      }
      sessionRuntime.handleClientEvent(event, {
        descriptor,
        capabilities: clientProtocol.capabilities,
      })
    })

    ws.on('close', (code, reason) => {
      activeClientLeases.release(
        ownerId,
        leaseParticipant,
        clientLease?.generation,
      )
      clientProtocolSessions.delete(ws)
      connectionLogger.info('voice_client.disconnected', {
        clientType: descriptor.type,
        closeCode: Number(code),
        closeReason: reason?.toString() || undefined,
      })
      sessionRuntime.close()
      const connections = voiceConnections.get(ownerId)
      connections?.delete(voiceClient)
      if (!connections?.size) voiceConnections.delete(ownerId)
    })
  }
  wss.on('connection', attachClient)

  const heartbeat = setInterval(() => {
    for (const ws of [...wss.clients, ...attachedClients]) {
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      const protocol = clientProtocolSessions.get(ws)
      if (protocol?.capabilities.includes(GatewayClientCapability.SESSION_HEARTBEAT)) {
        send(ws, { type: GatewayClientProtocolEvent.SESSION_PING })
      } else {
        ws.ping()
      }
    }
  }, CLIENT_HEARTBEAT_MS)
  heartbeat.unref?.()

  return {
    // Internal authenticated transport port, never a public auth bypass.
    attachClient(connection, { identity, sessionId = 'main' }) {
      if (!identity?.ownerId) throw new TypeError('authenticated identity required')
      const url = new URL('http://localhost/api/realtime')
      url.searchParams.set('sessionId', sessionId)
      attachedClients.add(connection)
      connection.once('close', () => attachedClients.delete(connection))
      try {
        attachClient(connection, url, identity)
      } catch (error) {
        connection.close(1011, 'session initialization failed')
        throw error
      }
    },
    disconnectCredential(credentialId) {
      const target = String(credentialId || '').trim()
      if (!target) return 0
      let disconnected = 0
      for (const client of [...wss.clients, ...attachedClients]) {
        if (client.gatewayCredentialId !== target) continue
        disconnected += 1
        client.close(GATEWAY_CLIENT_REVOKED_CLOSE_CODE, 'credential_revoked')
      }
      return disconnected
    },
    async close() {
      clearInterval(heartbeat)
      unsubscribeInput?.()
      for (const client of [...wss.clients, ...attachedClients]) client.close()
      await new Promise(resolveClose => {
        wss.close(() => resolveClose())
      })
    },
    status() {
      const byType = { desktop: 0, cli: 0, web: 0 }
      const realtime = {
        connected: 0,
        connecting: 0,
        disconnected: 0,
        unavailable: 0,
        sleeping: 0,
        waking: 0,
        byProvider: {},
      }
      let connected = 0
      for (const clients of voiceConnections.values()) {
        for (const client of clients) {
          connected += 1
          const type = client.descriptor?.type || 'web'
          byType[type] = (byType[type] || 0) + 1
          const status = client.realtimeStatus?.()
          if (!status) continue
          realtime[status.state] = (realtime[status.state] || 0) + 1
          if (!realtime.byProvider[status.provider]) {
            realtime.byProvider[status.provider] = {
              connected: 0,
              connecting: 0,
              disconnected: 0,
              unavailable: 0,
              sleeping: 0,
              waking: 0,
            }
          }
          const provider = realtime.byProvider[status.provider]
          provider[status.state] = (provider[status.state] || 0) + 1
          if (status.error) provider.error = status.error
        }
      }
      return {
        connected,
        activeOwners: activeVoiceClients.size,
        activeClients: activeClientLeases.size,
        byType,
        realtime,
      }
    },
  }
}
