#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import {
  GatewayClientEvent,
  GatewayServerEvent,
} from 'qwen-audio-agent/realtime-events'
import { parseGatewayServerMessage } from 'qwen-audio-agent/gateway-events'
import {
  GatewayClientCapability,
  GatewayClientProtocolEvent,
  createGatewayClientProtocolMessage,
  createGatewaySessionHello,
  parseGatewayServerProtocolMessage,
} from 'qwen-audio-agent/gateway-client-protocol'

export function conversationSocketUrl(origin, sessionId = 'custom-client') {
  const url = new URL('/api/realtime', origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('sessionId', sessionId)
  return url.toString()
}

export function createConnectionMessage({
  clientLabel = 'Custom Conversation Client',
  locale = 'zh-CN',
  timeZone = 'Asia/Shanghai',
} = {}) {
  return {
    type: GatewayClientEvent.CONNECT,
    clientType: 'web',
    clientLabel,
    textOnly: true,
    inputEnabled: false,
    outputEnabled: true,
    locale,
    timeZone,
    inputCapabilities: {
      text: true,
      audio: false,
      image: true,
      resource: true,
    },
  }
}

export function createTextInputMessage(text) {
  return {
    type: GatewayClientEvent.INPUT_MESSAGE,
    parts: [{ type: 'text', text: String(text || '').trim() }],
  }
}

export function createProtocolHello({
  eventId,
  clientInstanceId = 'custom-conversation-client',
} = {}) {
  return createGatewaySessionHello({
    eventId,
    clientType: 'web',
    clientInstanceId,
    clientLabel: 'Custom Conversation Client',
    locale: 'zh-CN',
    timeZone: 'Asia/Shanghai',
    capabilities: [
      GatewayClientCapability.INPUT_TEXT,
      GatewayClientCapability.INPUT_IMAGE,
      GatewayClientCapability.INPUT_FILE,
      GatewayClientCapability.PLAYBACK_RECEIPTS,
    ],
  })
}

export function createProtocolTextInputMessage(text, { eventId } = {}) {
  const content = String(text || '').trim()
  if (!content) throw new Error('text is required')
  return createGatewayClientProtocolMessage(
    GatewayClientProtocolEvent.CONVERSATION_ITEM_CREATE,
    { parts: [{ type: 'text', text: content }] },
    { eventId },
  )
}

export function displayServerMessage(value, write = console.log) {
  if (value?.type === GatewayClientProtocolEvent.SESSION_READY) {
    const ready = parseGatewayServerProtocolMessage(value)
    write(`session: ${ready.protocol_version}`)
    return ready
  }
  const event = parseGatewayServerMessage(value)
  if (
    event.type === GatewayServerEvent.TRANSCRIPT_DELTA
    || event.type === GatewayServerEvent.TRANSCRIPT_FINAL
  ) {
    write(`${event.role}: ${event.content}`)
  } else if (event.type === GatewayServerEvent.ERROR) {
    write(`error: ${event.message}`)
  } else if (event.type.startsWith('task.')) {
    write(`${event.type}: ${event.task.status}`)
  }
  return event
}

export function run({ origin, text, sessionId = 'custom-client', protocol = '6' }) {
  const socket = new WebSocket(conversationSocketUrl(origin, sessionId))
  socket.on('open', () => {
    if (protocol === '5') {
      socket.send(JSON.stringify(createConnectionMessage()))
      socket.send(JSON.stringify(createTextInputMessage(text)))
      return
    }
    socket.send(JSON.stringify(createProtocolHello()))
  })
  socket.on('message', raw => {
    try {
      const event = displayServerMessage(JSON.parse(raw.toString()))
      if (event.type === GatewayClientProtocolEvent.SESSION_READY) {
        socket.send(JSON.stringify(createProtocolTextInputMessage(text)))
      }
    } catch (error) {
      console.error(`invalid Gateway event: ${error.message}`)
    }
  })
  socket.on('error', error => console.error(error.message))
  return socket
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.argv[2] || 'http://127.0.0.1:18888'
  const text = process.argv.slice(3).join(' ') || '你好，请介绍一下自己。'
  run({ origin, text })
}
