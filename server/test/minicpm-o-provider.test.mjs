import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { miniCpmOProvider } from '../src/voice/providers/minicpm-o.mjs'
import { describeActiveRealtime } from '../src/voice/providers/registry.mjs'
import {
  createMiniCpmOProtocol,
  float32Base64ToPcm16,
  pcm16Base64ToFloat32,
} from '../src/voice/providers/minicpm-o-protocol.mjs'

function pcm16Base64(samples) {
  const bytes = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2))
  return bytes.toString('base64')
}

function float32Base64(samples) {
  const bytes = Buffer.alloc(samples.length * 4)
  samples.forEach((sample, index) => bytes.writeFloatLE(sample, index * 4))
  return bytes.toString('base64')
}

test('converts MiniCPM-o PCM without changing sample order', () => {
  const source = [-32768, -16384, 0, 16384, 32767]
  const converted = Buffer.from(
    pcm16Base64ToFloat32(pcm16Base64(source)),
    'base64',
  )
  assert.deepEqual(
    Array.from({ length: source.length }, (_, index) => (
      converted.readFloatLE(index * 4)
    )),
    [-1, -0.5, 0, 0.5, 32767 / 32768],
  )

  const restored = Buffer.from(
    float32Base64ToPcm16(float32Base64([-2, -0.5, 0, 0.5, 2])),
    'base64',
  )
  assert.deepEqual(
    Array.from({ length: 5 }, (_, index) => restored.readInt16LE(index * 2)),
    [-32768, -16384, 0, 16384, 32767],
  )
})

test('buffers client audio into the one-second chunks used by MiniCPM-o', () => {
  const protocol = createMiniCpmOProtocol()
  const tenthSecond = pcm16Base64(new Array(1600).fill(8192))

  for (let index = 0; index < 9; index += 1) {
    assert.equal(
      protocol.encodeOutgoing(protocol.audioAppend(tenthSecond)),
      null,
    )
  }
  const message = protocol.encodeOutgoing(protocol.audioAppend(tenthSecond))
  assert.equal(message.type, 'input.append')
  assert.equal(message.input.force_listen, false)
  const audio = Buffer.from(message.input.audio, 'base64')
  assert.equal(audio.length, 16000 * 4)
  assert.equal(audio.readFloatLE(0), 0.25)
  assert.equal(audio.readFloatLE(audio.length - 4), 0.25)
})

test('maps the official MiniCPM-o lifecycle into the shared realtime runtime', () => {
  const protocol = createMiniCpmOProtocol()

  assert.equal(
    protocol.normalizeIncoming({ type: 'session.queue_done' }).type,
    'session.created',
  )
  assert.equal(
    protocol.normalizeIncoming({
      type: 'session.created',
      session_id: 'sess_1',
      mode: 'full_duplex',
    }).type,
    'session.updated',
  )

  const text = protocol.normalizeIncoming({
    type: 'response.output.delta',
    kind: 'text',
    text: '你好',
    response_id: 'resp_1',
  })
  assert.deepEqual(text.map(event => event.type), [
    'response.created',
    'response.text.delta',
  ])
  const audio = protocol.normalizeIncoming({
    type: 'response.output.delta',
    kind: 'audio',
    audio: float32Base64([0.5]),
    response_id: 'resp_1',
  })
  assert.equal(audio[0].type, 'response.audio.delta')
  assert.equal(
    Buffer.from(audio[0].delta, 'base64').readInt16LE(0),
    16384,
  )
  assert.equal(protocol.normalizeIncoming({
    type: 'response.output.delta',
    kind: 'listen',
    response_id: 'resp_1',
  })[0].type, 'response.done')

  const noId = protocol.normalizeIncoming({
    type: 'response.output.delta',
    kind: 'text',
    text: '兼容无 ID 输出',
  })
  assert.equal(noId[0].type, 'response.created')
  assert.match(noId[0].response.id, /^resp_/)
  assert.deepEqual(protocol.sessionClose('test_complete'), {
    type: 'session.close',
    reason: 'test_complete',
  })
})

test('publishes truthful MiniCPM-o model and transport capabilities', () => {
  const active = describeActiveRealtime('minicpm-o')

  assert.equal(active.label, 'ModelBest')
  assert.equal(active.model, 'openbmb/MiniCPM-o-4_5')
  assert.equal(active.modelCapabilities.audioInput, true)
  assert.equal(active.modelCapabilities.functionCalling, false)
  assert.equal(active.transportCapabilities.audioInput, true)
  assert.equal(active.transportCapabilities.textInput, false)
  assert.equal(active.transportCapabilities.nativeVideoInput, false)
})

test('connects to an official-protocol MiniCPM-o mock service', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  const received = []
  const events = []

  server.once('connection', socket => {
    socket.send(JSON.stringify({ type: 'session.queue_done' }))
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      received.push(message)
      if (message.type === 'session.init') {
        socket.send(JSON.stringify({
          type: 'session.created',
          session_id: 'sess_mock',
          mode: 'full_duplex',
        }))
      } else if (message.type === 'input.append') {
        socket.send(JSON.stringify({
          type: 'response.output.delta',
          kind: 'text',
          text: '本地回复',
          response_id: 'resp_mock',
        }))
        socket.send(JSON.stringify({
          type: 'response.output.delta',
          kind: 'audio',
          audio: float32Base64([0.25, -0.25]),
          response_id: 'resp_mock',
        }))
        socket.send(JSON.stringify({
          type: 'response.output.delta',
          kind: 'listen',
          response_id: 'resp_mock',
        }))
      }
    })
  })
  const address = server.address()
  const frontend = new RealtimeFrontend({
    provider: {
      ...miniCpmOProvider,
      isConfigured: () => true,
      url: () => `ws://127.0.0.1:${address.port}/v1/realtime?mode=audio`,
    },
    agentContext: { client: { locale: 'zh-CN' } },
    onEvent: event => events.push(event),
  })
  t.after(async () => {
    frontend.close()
    await new Promise(resolve => server.close(resolve))
  })

  await frontend.connect()
  assert.equal(frontend.ready, true)
  assert.equal(received[0].type, 'session.init')
  assert.match(received[0].payload.system_prompt, /语音/)

  const tenthSecond = pcm16Base64(new Array(1600).fill(0))
  for (let index = 0; index < 10; index += 1) {
    frontend.appendAudio(tenthSecond)
  }
  await new Promise(resolve => setTimeout(resolve, 30))

  assert.equal(received.filter(message => message.type === 'input.append').length, 1)
  assert.deepEqual(
    events.filter(event => event.type.startsWith('response.'))
      .map(event => event.type),
    [
      'response.created',
      'response.text.delta',
      'response.audio.delta',
      'response.done',
    ],
  )
  await assert.rejects(frontend.sendUserText('文本'), /不支持文本输入/)
  assert.deepEqual(await frontend.speak('播报'), {
    skipped: true,
    unsupported: true,
  })
})
