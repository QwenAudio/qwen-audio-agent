import express from 'express'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { webRtcOptions, rtcError } from './config.mjs'
import { ProcessWebRtcMedia } from './media-process.mjs'
import { WebRtcConnection } from './protocol.mjs'

const ROOT = '/api/v1/webrtc'
const EXAMPLE = new URL('../../../../examples/webrtc/', import.meta.url)

export function parseClientActions(value) {
  if (value === undefined) return []
  let actions
  try { if (typeof value === 'string' && value.length <= 2048) actions = JSON.parse(value) } catch {}
  if (!Array.isArray(actions) || actions.length > 16 || new Set(actions).size !== actions.length
    || actions.some(name => typeof name !== 'string' || name.length > 100 || !/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/.test(name))) {
    throw rtcError(400, 'client_actions', 'client_actions must be a JSON array of up to 16 distinct action names')
  }
  return actions
}

export function parseOfferMedia(sdp) {
  if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || Buffer.byteLength(sdp) > 65536) throw rtcError(400, 'invalid_sdp', 'SDP offer required (max 64 KiB)')
  const lines = sdp.split(/\r?\n/)
  const sections = []
  for (const line of lines) {
    if (/^m=/.test(line)) {
      // A port of 0 marks a rejected/disabled m-section; ignore it entirely.
      if (/^m=\S+ 0 /.test(line)) continue
      sections.push({ kind: line.slice(2).split(' ')[0], direction: 'sendrecv', lines: [] })
    } else if (sections.length) {
      sections[sections.length - 1].lines.push(line)
    }
  }
  for (const section of sections) {
    const direction = section.lines.find(line => /^a=(sendonly|recvonly|sendrecv|inactive)$/.test(line))
    // SDP defaults a media section to sendrecv when no direction attribute is
    // present; DataChannel sections carry no meaningful direction.
    section.direction = direction ? direction.slice(2) : 'sendrecv'
  }
  return sections
}

export function validateOffer(sdp, { video, videoOutput = false }) {
  const sections = parseOfferMedia(sdp)
  const count = kind => sections.filter(section => section.kind === kind).length
  const videos = sections.filter(section => section.kind === 'video')
  if (count('audio') !== 1 || count('application') !== 1 || sections.length !== 2 + videos.length) {
    throw rtcError(400, 'unsupported_media', 'Offer one audio track, one DataChannel transport and optionally video tracks')
  }
  const sendonly = videos.filter(section => section.direction === 'sendonly').length
  const recvonly = videos.filter(section => section.direction === 'recvonly').length
  if (sendonly + recvonly !== videos.length) throw rtcError(400, 'unsupported_media', 'Video tracks must be explicitly sendonly (camera input) or recvonly (avatar output)')
  if (sendonly > 1 || recvonly > 1) throw rtcError(400, 'unsupported_media', 'Offer at most one sendonly and one recvonly video track')
  if (sendonly && !video) throw rtcError(400, 'video_unsupported', 'The configured model does not support video input')
  if (recvonly && !videoOutput) throw rtcError(400, 'avatar_unsupported', 'Avatar video output is not enabled for this Gateway')
}

// Registered after the application's existing identity and origin middleware.
// Authentication precedes parsing SDP or allocating any native media resources.
export function registerWebRtcIngress(app, { options, getGateway, providerRegistry, providerName, logger, digitalHuman = null }) {
  options = options === undefined ? webRtcOptions() : options
  if (!options?.enabled) return null
  const connections = new Map()
  const retiring = new Set()
  const factory = options.mediaFactory || (settings => new ProcessWebRtcMedia(settings))
  const maxConnections = options.maxConnections || 4
  const personas = digitalHuman?.personas && typeof digitalHuman.personas === 'object' ? Object.keys(digitalHuman.personas) : []
  const avatarAvailable = personas.length > 0
  const adapterConfig = digitalHuman?.mediaAdapter
    ? { modulePath: digitalHuman.mediaAdapter.modulePath, adapterOptions: digitalHuman.mediaAdapter.adapterOptions }
    : null
  let closed = false
  const describe = () => {
    const provider = providerRegistry.resolve(providerName)
    const profile = provider.modelProfile?.()
    if (provider.key !== 'dashscope' || !['audio', 'omni'].includes(profile?.family)) throw rtcError(409, 'model_unsupported', 'WebRTC preview supports the configured DashScope Realtime Audio or Omni model')
    return { provider, video: profile.transportCapabilities?.imageBufferInput === true }
  }
  const errorResponse = (res, error) => {
    if (res.headersSent || res.destroyed) return
    res.status(error.status || 400).json({ error: { code: error.code || 'webrtc_failed', message: error.status ? error.message : 'WebRTC negotiation failed' } })
  }
  app.get(`${ROOT}/config`, (_req, res) => {
    try {
      const { provider, video } = describe()
      res.setHeader('cache-control', 'no-store')
      res.json({
        model: provider.model(),
        video_input: video,
        video_output: avatarAvailable,
        digital_human: { available: avatarAvailable, personas: avatarAvailable ? personas : [] },
        iceServers: options.iceServers || [],
        iceTransportPolicy: options.iceTransportPolicy || 'all',
      })
    } catch (error) { errorResponse(res, error) }
  })
  app.get('/api/realtime/webrtc/example', (_req, res) => res.sendFile(fileURLToPath(new URL('index.html', EXAMPLE))))
  app.get('/api/realtime/webrtc/example.mjs', (_req, res) => res.sendFile(fileURLToPath(new URL('client.mjs', EXAMPLE))))
  app.get('/api/realtime/webrtc/example.css', (_req, res) => res.sendFile(fileURLToPath(new URL('styles.css', EXAMPLE))))
  for (const name of ['webrtc-browser.mjs', 'webrtc-message.mjs']) {
    app.get(`/api/realtime/webrtc/${name}`, (_req, res) => res.sendFile(fileURLToPath(new URL(`../../../../shared/gateway/${name}`, import.meta.url))))
  }
  app.post(`${ROOT}/realtime`, express.text({ type: 'application/sdp', limit: '64kb' }), async (req, res) => {
    let connectionId
    let connection
    try {
      if (closed) throw rtcError(503, 'gateway_closing', 'Gateway is closing')
      if (!req.is('application/sdp')) throw rtcError(415, 'content_type', 'Use Content-Type: application/sdp')
      if (connections.size + retiring.size >= maxConnections) throw rtcError(429, 'connection_limit', 'WebRTC connection limit reached')
      const { provider, video } = describe()
      if (req.query.model && req.query.model !== provider.model()) throw rtcError(400, 'model_mismatch', 'model must match the Gateway configured model')
      const sessionId = req.query.sessionId || 'main'
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(sessionId)) throw rtcError(400, 'session_id', 'invalid sessionId')
      if (req.query.takeover && req.query.takeover !== 'true') throw rtcError(400, 'takeover', 'takeover must be true or omitted')
      const clientActions = parseClientActions(req.query.client_actions)
      const avatarPersonaId = req.query.avatarPersonaId === undefined ? null : String(req.query.avatarPersonaId)
      if (avatarPersonaId !== null) {
        if (!avatarAvailable) throw rtcError(400, 'avatar_unsupported', 'Avatar video output is not enabled for this Gateway')
        // Reject an unknown persona outright rather than silently falling back to
        // plain audio: the caller asked for a specific avatar.
        if (!personas.includes(avatarPersonaId)) throw rtcError(400, 'avatar_persona', 'avatarPersonaId is not in the server allowlist')
        // The dual-video m-line association order is unverified, so the first
        // version does not combine camera input with avatar output.
        if (video) throw rtcError(400, 'avatar_conflict', 'Avatar output cannot be combined with camera video input in this preview')
      }
      const videoOutput = avatarPersonaId !== null
      validateOffer(req.body, { video, videoOutput })
      if (!provider.isConfigured()) throw rtcError(503, 'provider_not_configured', 'Configure the Gateway provider credential first')
      const media = factory({
        ...options, video, videoOutput, inputSampleRate: provider.inputSampleRate,
        ...(videoOutput && adapterConfig ? { digitalHuman: adapterConfig } : {}),
        onDiagnostic: fields => logger?.warn('webrtc.media_worker_failed', fields),
      })
      connection = new WebRtcConnection({ media, sessionId, provider, takeover: req.query.takeover === 'true', clientActions, avatarPersonaId })
      connectionId = randomUUID()
      const record = { connection, ownerId: req.identity.ownerId }
      connections.set(connectionId, record)
      const timer = setTimeout(() => connection.close(1008, 'connection timeout'), options.connectTimeoutMs || 20000)
      const lifetime = setTimeout(() => connection.close(1000, 'session lifetime reached'), options.maxSessionMs || 30 * 60 * 1000)
      timer.unref?.()
      lifetime.unref?.()
      let rejectClosed
      const closedDuringNegotiation = new Promise((_resolve, reject) => { rejectClosed = reject })
      connection.once('close', () => {
        clearTimeout(timer)
        clearTimeout(lifetime)
        connections.delete(connectionId)
        const finished = media.whenClosed?.()
        if (finished) {
          retiring.add(finished)
          finished.finally(() => retiring.delete(finished))
        }
        rejectClosed(rtcError(503, 'connection_closed', 'WebRTC connection closed'))
      })
      // Handle rejection even if runtime attachment fails before Promise.race.
      closedDuringNegotiation.catch(() => {})
      media.onEvent = raw => connection.receive(raw)
      media.onAudio = audio => connection.audio(audio)
      media.onImage = image => connection.image(image)
      media.onDhEvent = payload => {
        if (!payload || payload.op === 'opened' || payload.op === 'closed' || payload.op === 'media_end') return
        connection.input({ type: 'digital_human.media', op: payload.op, responseId: payload.responseId, generation: payload.generation, code: payload.code })
      }
      media.onFail = error => logger?.warn('webrtc.media_failed', { code: error?.code || 'media_failed', message: error?.message || 'unknown' })
      media.onClose = () => connection.close(1006, 'media closed')
      media.onOpen = () => {
        clearTimeout(timer)
        if (closed || connection.readyState !== 1) return
        connection.start()
      }
      // Attach before ICE negotiation so credential revocation and shutdown
      // cover pending peers as well as fully established sessions. The persona
      // is injected through this internal port, never through the wire hello:
      // it is already resolved against the server-side allowlist above.
      getGateway().attachClient(connection, { identity: req.identity, sessionId, avatarPersonaId })
      res.once('close', () => { if (!res.writableFinished) connection.close(1000, 'request aborted') })
      const sdp = await Promise.race([media.answer(req.body), closedDuringNegotiation])
      if (closed || connection.readyState !== 1) throw rtcError(503, 'connection_closed', 'WebRTC connection closed')
      res.setHeader('cache-control', 'no-store')
      res.setHeader('Location', `${ROOT}/realtime/${connectionId}`)
      res.type('application/sdp').send(sdp)
    } catch (error) {
      connection?.close(1000, 'negotiation failed')
      if (connectionId) connections.delete(connectionId)
      errorResponse(res, error)
    }
  })
  app.delete(`${ROOT}/realtime/:id`, (req, res) => {
    const record = connections.get(req.params.id)
    if (!record || record.ownerId !== req.identity.ownerId) return res.status(404).json({ error: { code: 'not_found', message: 'connection not found' } })
    record.connection.close()
    res.status(204).end()
  })
  app.use(ROOT, (error, _req, res, _next) => errorResponse(res, error))
  return {
    async close() {
      closed = true
      for (const { connection } of connections.values()) connection.close()
      await Promise.all([...retiring])
    },
    status: () => ({ connections: connections.size, retiring: retiring.size, maxConnections }),
  }
}
