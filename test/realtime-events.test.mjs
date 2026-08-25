import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GATEWAY_CLIENT_EVENT_TYPES,
  GATEWAY_SERVER_EVENT_TYPES,
  GatewayClientEvent,
  GatewayServerEvent,
  GatewayTaskEvent,
  isGatewayClientEvent,
  isGatewayServerEvent,
} from '../shared/realtime-events.mjs'

test('keeps Gateway realtime event names unique within each direction', () => {
  assert.equal(
    GATEWAY_CLIENT_EVENT_TYPES.size,
    Object.keys(GatewayClientEvent).length,
  )
  assert.equal(
    GATEWAY_SERVER_EVENT_TYPES.size,
    Object.keys(GatewayServerEvent).length
      + Object.keys(GatewayTaskEvent).length,
  )
})

test('defines the shared playback acknowledgement lifecycle', () => {
  assert.deepEqual([
    GatewayServerEvent.AUDIO_DELTA,
    GatewayServerEvent.AUDIO_DONE,
    GatewayClientEvent.PLAYBACK_STARTED,
    GatewayClientEvent.PLAYBACK_ENDED,
    GatewayClientEvent.PLAYBACK_CANCELLED,
  ], [
    'audio.delta',
    'audio.done',
    'playback.started',
    'playback.ended',
    'playback.cancelled',
  ])
})

// 桌面隐藏用 sleep 显式进入仅唤醒词监听；快捷键/托盘唤起靠 wake
// 恢复前台连接，服务端用 voice.sleep 回报唤醒进展。
test('defines the shared sleep wake lifecycle', () => {
  assert.deepEqual([
    GatewayClientEvent.SLEEP,
    GatewayClientEvent.WAKE,
    GatewayServerEvent.VOICE_SLEEP,
  ], [
    'sleep',
    'wake',
    'voice.sleep',
  ])
})

test('defines every task event consumed by Gateway clients', () => {
  assert.deepEqual([
    GatewayTaskEvent.SNAPSHOT,
    GatewayTaskEvent.ACCEPTED,
    GatewayTaskEvent.NOTIFICATION_PENDING,
    GatewayTaskEvent.NOTIFICATION_DELIVERED,
  ], [
    'task.snapshot',
    'task.accepted',
    'task.notification.pending',
    'task.notification.delivered',
  ])
  for (const event of Object.values(GatewayTaskEvent)) {
    assert.equal(GATEWAY_SERVER_EVENT_TYPES.has(event), true)
  }
})

test('recognizes event direction without throwing on malformed input', () => {
  assert.equal(isGatewayClientEvent({ type: 'connect' }), true)
  assert.equal(isGatewayClientEvent({ type: 'voice.ready' }), false)
  assert.equal(isGatewayClientEvent(null), false)
  assert.equal(isGatewayServerEvent({ type: 'voice.ready' }), true)
  assert.equal(isGatewayServerEvent({ type: 'task.accepted' }), true)
  assert.equal(isGatewayServerEvent('voice.ready'), false)
})
