import express from 'express'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { attachRealtimeGateway } from '../../src/voice/realtime-gateway.mjs'
import { registerWebRtcIngress } from '../../src/transport/webrtc/routes.mjs'
import { ProcessWebRtcMedia } from '../../src/transport/webrtc/media-process.mjs'

export const OFFER = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

export function testProvider(video = false) {
  return {
    key: 'dashscope', label: 'Test Realtime', inputSampleRate: 16000, outputSampleRate: 24000,
    capabilities: { sessionOutputVoice: true },
    isConfigured: () => true,
    model: () => video ? 'qwen3.5-omni-plus-realtime' : 'qwen-audio-3.0-realtime-plus',
    voice: () => 'Ethan',
    modelProfile: () => ({ family: video ? 'omni' : 'audio', transportCapabilities: { imageBufferInput: video }, sessionDefaults: { turnDetection: { type: 'server_vad' } } }),
    classifyError: message => /DataInspectionFailed/.test(message) ? 'content_safety' : 'other',
  }
}

export class FakeMedia {
  events = []
  chunks = []
  closed = false
  clearCount = 0
  async answer() { return 'v=0\r\ns=test-answer\r\n' }
  send(event) { this.events.push(event) }
  append(event) { this.chunks.push(event) }
  finish() {}
  clear() { this.clearCount++ }
  connected() { return !this.closed }
  close() { this.closed = true }
}

export async function waitUntil(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

export async function rtcHarness(t, { video = false, options = {}, realMedia = false } = {}) {
  const provider = testProvider(video)
  const media = []
  const frontends = []
  const registry = { resolve: () => provider }
  const ownerId = `rtc-${randomUUID()}`
  const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this } }
  const app = express()
  // Test-only auth fixture. Production routes use the unchanged application
  // GatewayAccessManager and same-origin middleware, covered by app tests.
  app.use((req, res, next) => {
    if (req.headers.authorization !== 'Bearer test-only-credential') return res.sendStatus(401)
    req.identity = { ownerId: req.headers['x-test-owner'] || ownerId, access: 'remote', credentialId: 'rtc-credential', clientType: 'client' }
    next()
  })
  const server = createServer(app)
  const gateway = attachRealtimeGateway(server, {
    identityManager: { resolveUpgrade: req => req.headers.authorization === 'Bearer test-only-credential'
      ? { ownerId: req.headers['x-test-owner'] || ownerId, access: 'remote', credentialId: 'rtc-credential', clientType: 'client' }
      : null },
    memoryService: { list: () => [] }, notesStore: null, backendRuntime: null,
    backendAvailability: { snapshot: () => ({ configured: false, ok: false, known: true }) },
    respondAuthorization: async () => ({}),
    permissionPolicy: { resolveDecision: () => null, rememberDecision() {} },
    logger, realtimeProviderRegistry: registry, defaultRealtimeProvider: 'dashscope',
    realtimeFrontendFactory: factoryOptions => {
      const frontend = {
        provider, capabilities: provider.capabilities, ready: false, audio: [], images: [], inputs: [],
        async connect() { this.ready = true },
        close() { this.ready = false },
        appendAudio(audio) { this.audio.push(audio) },
        appendImage(image) { this.images.push(image) },
        clearPendingImage() {}, cancel() {}, updateAgentContext() {},
        async ensureResponse() {}, async injectContext() {}, async whenIdle() {},
        async injectDelivery() { return { completed: true } },
        async sendUserInput(parts, context) { this.inputs.push({ parts, context }); return {} },
        emit: event => factoryOptions.onEvent(event),
        agentContext: factoryOptions.agentContext,
      }
      frontends.push(frontend)
      return frontend
    },
  })
  const ingress = registerWebRtcIngress(app, {
    options: {
      enabled: true,
      mediaFactory: settings => {
        const instance = realMedia ? new ProcessWebRtcMedia(settings) : new FakeMedia()
        media.push(instance)
        return instance
      },
      ...options,
    },
    getGateway: () => gateway, providerRegistry: registry, providerName: 'dashscope',
  })
  app.use((_req, res) => res.sendStatus(404))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { Authorization: 'Bearer test-only-credential', 'Content-Type': 'application/sdp' }
  const offer = (body = OFFER, query = '', customHeaders = {}) => fetch(`${base}/api/v1/webrtc/realtime${query}`, {
    method: 'POST', headers: { ...headers, ...customHeaders }, body,
  })
  t.after(async () => {
    await ingress?.close()
    await gateway.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return { gateway, ingress, provider, media, frontends, base, headers, offer, ownerId }
}
