// DigitalHumanOrchestrator: per-connection bridge between normalized
// presentation events (response.start / assistant.audio / response.finish /
// response.cancel / playback receipts) and one DigitalHumanProvider session.
//
// Ownership boundaries (design.zh.md §7):
// - generation is minted here; provider output must carry it back unchanged.
// - The provider never sees history, microphone audio, tools or prompts.
// - Provider turn.completed never impersonates the client playback receipt.
//
// Control plane only: media bytes flow renderer -> media worker directly.
// This module publishes intents (media_open / media_control) that the
// transport layer intercepts; nothing here touches raw A/V.

import { GatewayServerEvent } from '../../../shared/protocol/realtime-events.mjs'
import {
  AudioRoute,
  DIGITAL_HUMAN_CANCEL_REASONS,
  DigitalHumanState,
  SelectorState,
  assertCancelReason,
  createStatePayload,
} from './contracts.mjs'
import { createOutputSelector } from './output-selector.mjs'

// Wire event types are owned by the shared protocol module so the transport and
// the presentation layer can never drift on a string. Re-exported here for the
// callers and tests that already import them from the orchestrator.
export const DIGITAL_HUMAN_MEDIA_OPEN = GatewayServerEvent.DIGITAL_HUMAN_MEDIA_OPEN
export const DIGITAL_HUMAN_MEDIA_CONTROL = GatewayServerEvent.DIGITAL_HUMAN_MEDIA_CONTROL
export const DIGITAL_HUMAN_STATE = GatewayServerEvent.DIGITAL_HUMAN_STATE

const MAX_IN_FLIGHT_APPENDS = 64
// Reserved response id for the gateway-driven idle turn. It never enters
// #responses (idle is not a reply), so provider turn events for it are no-ops
// and playback receipts never reference it.
const IDLE_RESPONSE_ID = 'dh-idle'
// 40 ms silence blocks match the renderer's 24 kHz / 25 fps frame cadence.
const IDLE_FEED_INTERVAL_MS = 40
// Idle is cosmetic, so a failed idle turn is restarted rather than left dead —
// but boundedly and with backoff, so a renderer that rejects every idle turn
// cannot hot-loop the single session at the 40 ms feed cadence. The budget is
// re-armed only once an idle turn has survived long enough to count as healthy.
const MAX_IDLE_RESTARTS = 3
const IDLE_RESTART_BACKOFF_MS = 500
const IDLE_HEALTHY_MS = 5000

export class DigitalHumanOrchestrator {
  #provider
  #persona
  #format
  #publish
  #onFlushAudio
  #firstMediaTimeoutMs
  #maxBufferedAudioBytes
  #log
  #session = null
  #avatarSessionId = null
  #generation = 0
  #ready = false
  #readyWaiters = []
  #closed = false
  #mode = 'avatar' // 'avatar' | 'audio_only' after degradation
  #responses = new Map()
  // Response ids that were cancelled or degraded after commit. Their record is
  // deleted, so without this a still-streaming model delta would re-create the
  // record and re-divert the same audio — storming the renderer with retries of
  // a turn that already failed. A retired id passes through to plain audio.
  #retired = new Set()
  #activeResponseId = null
  #eventLoop = null
  #tail = Promise.resolve()
  // Gateway-driven idle turn: a silence-fed provider turn that keeps the
  // renderer producing idle animation between replies. #idle is the live turn
  // descriptor; #idleTimer is the deferred start (see #scheduleIdle).
  #idleEnabled = false
  #idle = null
  #idleTimer = null
  #idleFailures = 0

  constructor({
    provider,
    persona,
    format,
    publish,
    onFlushAudio = null,
    firstMediaTimeoutMs = 3000,
    maxBufferedAudioBytes = undefined,
    idle = false,
    log = () => {},
  }) {
    if (!provider || typeof provider.openSession !== 'function') {
      throw new Error('digital human orchestrator requires a provider with openSession()')
    }
    if (!persona || typeof persona !== 'object') throw new Error('digital human orchestrator requires a trusted persona')
    if (format?.encoding !== 'pcm_s16le' || !Number.isInteger(format.sampleRate) || format.channels !== 1) {
      throw new Error('digital human orchestrator requires a pcm_s16le mono input format')
    }
    if (typeof publish !== 'function') throw new Error('digital human orchestrator requires publish()')
    this.#provider = provider
    this.#persona = persona
    this.#format = format
    this.#publish = publish
    this.#onFlushAudio = onFlushAudio
    this.#firstMediaTimeoutMs = firstMediaTimeoutMs
    this.#maxBufferedAudioBytes = maxBufferedAudioBytes
    this.#idleEnabled = idle === true
    this.#log = log
  }

  get avatarSessionId() { return this.#avatarSessionId }
  get generation() { return this.#generation }
  get mode() { return this.#mode }
  get ready() { return this.#ready }

  selectorState(responseId) {
    return this.#responses.get(responseId)?.selector.state ?? null
  }

  completionSnapshot(responseId) {
    const record = this.#responses.get(responseId)
    if (!record) return null
    return {
      state: record.selector.state,
      modelDone: record.modelDone,
      providerDone: record.providerDone,
      mediaDrained: record.mediaDrained,
      playbackEnded: record.playbackEnded,
      totalSamples: record.totalSamples,
      generation: record.ref.generation,
    }
  }

  // Awaits every provider task enqueued for this response so far. Falls back
  // to the last enqueued chain when the record was already retired, so tests
  // and close paths can still observe interruptTurn/close ordering.
  async settled(responseId) {
    const record = this.#responses.get(responseId)
    await (record ? record.chain : this.#tail)
  }

  async start({ signal } = {}) {
    this.#session = await this.#provider.openSession({
      persona: this.#persona,
      format: this.#format,
      signal,
    })
    this.#avatarSessionId = this.#session.avatarSessionId
    this.#publish({
      type: DIGITAL_HUMAN_MEDIA_OPEN,
      avatarSessionId: this.#avatarSessionId,
      binding: this.#session.mediaBinding,
    })
    this.#eventLoop = this.#consumeEvents()
    this.#eventLoop.catch(error => this.#log('event_loop_error', { message: error.message }))
  }

  responseStart({ responseId, turnId = null, origin = 'model' }) {
    if (this.#closed || !responseId || this.#responses.has(responseId)) return null
    // A response already cancelled/degraded after commit must never re-divert:
    // its record was deleted, so without this guard a still-streaming delta
    // would recreate it and storm the renderer. Let it pass through as audio.
    if (this.#retired.has(responseId)) return null
    // A real reply supersedes any idle turn: stop the silence feeder and isolate
    // the idle generation before this turn mints its own.
    this.#stopIdle()
    if (this.#activeResponseId && this.#activeResponseId !== responseId) {
      // A new response supersedes the previous one; the user's new speech is
      // what displaced it, so this maps to user_interruption, never to a
      // provider failure.
      this.responseCancel({ responseId: this.#activeResponseId, reason: 'user_interruption' })
    }
    const ref = {
      avatarSessionId: this.#avatarSessionId,
      responseId,
      generation: this.#generation,
    }
    const record = {
      ref,
      turnId,
      origin,
      selector: null,
      chain: Promise.resolve(),
      pendingAppends: 0,
      turnStarted: false,
      inputSealed: false,
      cancelled: false,
      sequence: 0,
      sampleOffset: 0,
      totalSamples: 0,
      lastAudioSequence: -1,
      modelDone: false,
      providerDone: false,
      mediaDrained: false,
      playbackEnded: false,
      passThrough: false,
      providerFirstMedia: false,
      providerCancelled: false,
    }
    record.selector = createOutputSelector({
      responseId,
      firstMediaTimeoutMs: this.#firstMediaTimeoutMs,
      ...(this.#maxBufferedAudioBytes === undefined ? {} : { maxBufferedAudioBytes: this.#maxBufferedAudioBytes }),
      onFallback: ({ reason, code, flush }) => this.#handleSelectorFallback(record, reason, code, flush),
    })
    this.#responses.set(responseId, record)
    this.#activeResponseId = responseId
    if (this.#mode === 'avatar') {
      this.#publishState(DigitalHumanState.RENDERING, { responseId })
    }
    return record.ref
  }

  // Synchronous routing decision consumed by the presentation runtime's
  // audio-delta hook. Diverted deltas are appended to the provider in order
  // on the record's promise chain; flush lists must be published verbatim
  // and in order before the returned delta.
  routeAudio({ responseId, delta, sampleRate = null }) {
    const record = this.#responses.get(responseId)
    if (!record || record.cancelled || record.passThrough || this.#mode === 'audio_only') {
      return { route: AudioRoute.PASS, flush: null }
    }
    if (sampleRate && sampleRate !== this.#format.sampleRate) {
      // No hidden resampling in the gateway; a mismatched egress format
      // degrades this response to the normal audio path.
      record.passThrough = true
      return { route: AudioRoute.PASS, flush: null }
    }
    const bytes = Buffer.byteLength(delta, 'base64')
    const decision = record.selector.routeAudio(delta, bytes)
    if (decision.route === AudioRoute.DIVERT) {
      this.#enqueue(record, () => this.#appendAudio(record, delta))
    }
    return decision
  }

  responseFinish({ responseId, failed = false, hadAudio = true }) {
    const record = this.#responses.get(responseId)
    if (!record || record.cancelled) return
    record.modelDone = true
    if (failed) {
      // Model-side failure is not a user interruption: discard related media
      // and never replay from the start.
      this.responseCancel({ responseId, reason: 'provider_failure' })
      return
    }
    this.#enqueue(record, () => this.#finishTurn(record))
    if (!hadAudio) {
      // The response produced no reply audio, so the client will never send a
      // playback receipt. Retire it here instead of leaking a record that waits
      // for a terminal signal which cannot arrive.
      record.selector.markTerminal()
    }
    this.#maybeComplete(record)
  }

  responseCancel({ responseId, reason = 'user_interruption' }) {
    const record = this.#responses.get(responseId)
    if (!record || record.cancelled) return
    assertCancelReason(reason)
    record.cancelled = true
    record.selector.cancel()
    this.#retire(responseId)
    if (this.#activeResponseId === responseId) this.#activeResponseId = null
    const ref = record.ref
    const wasStarted = record.turnStarted
    if (wasStarted) {
      record.inputSealed = true
      this.#enqueue(record, () => this.#interruptTurn(ref, reason))
      this.#publish({ type: DIGITAL_HUMAN_MEDIA_CONTROL, op: 'clear', generation: ref.generation })
    }
    this.#generation++
    this.#publishState(DigitalHumanState.IDLE, { responseId, reason })
    this.#maybeComplete(record)
    // A user barge-in returns the avatar to idle animation. provider_failure
    // cancels flow through #degrade (audio_only), so they must not restart idle.
    if (reason === 'user_interruption') this.#scheduleIdle()
  }

  // Cancel whichever response currently owns the avatar turn. Lifecycle signals
  // such as a user interrupt or a session takeover do not carry a response id,
  // but the pre-emptive cancel must still win the race against a provider
  // response.done that would otherwise attribute it to provider_failure.
  cancelActive(reason = 'user_interruption') {
    if (this.#activeResponseId) {
      this.responseCancel({ responseId: this.#activeResponseId, reason })
    }
  }

  playbackEnded({ responseId }) {
    const record = this.#responses.get(responseId)
    if (!record) return
    record.playbackEnded = true
    record.selector.markTerminal()
    if (this.#activeResponseId === responseId) this.#activeResponseId = null
    this.#publishState(DigitalHumanState.IDLE, { responseId })
    this.#maybeComplete(record)
    this.#scheduleIdle()
  }

  // Worker published the first media unit to the client track (dh.first_media
  // over IPC). This — not the provider's turn.first_media — is the commit point.
  mediaPublished({ responseId, generation }) {
    const record = this.#responses.get(responseId)
    if (!record || record.ref.generation !== generation || this.#generation !== generation) return
    if (record.selector.commitAvatar()) {
      this.#log('avatar_first_media', { responseId, generation })
      this.#publishState(DigitalHumanState.SPEAKING, { responseId })
    } else {
      // Fallback already committed; quarantine the late avatar media.
      this.#publish({ type: DIGITAL_HUMAN_MEDIA_CONTROL, op: 'clear', generation })
    }
  }

  mediaDrained({ responseId, generation }) {
    const record = this.#responses.get(responseId)
    if (!record || record.ref.generation !== generation) return
    record.mediaDrained = true
    if (record.selector.state === SelectorState.COMMITTED_AVATAR) {
      record.selector.markDraining()
    }
    this.#maybeComplete(record)
  }

  async close(reason = 'session_closed') {
    if (this.#closed) return
    this.#closed = true
    // Stop the silence feeder. The op:'close' below + session.close() tear down
    // the renderer-side idle turn, so no interrupt/clear is published here.
    this.#clearIdleTimers()
    for (const responseId of [...this.#responses.keys()]) {
      const record = this.#responses.get(responseId)
      if (record && !record.cancelled && record.turnStarted) {
        record.cancelled = true
        record.selector.cancel()
        try { await this.#interruptTurn(record.ref, DIGITAL_HUMAN_CANCEL_REASONS.includes(reason) ? reason : 'session_closed') } catch {}
      }
    }
    this.#activeResponseId = null
    this.#retired.clear()
    this.#publish({ type: DIGITAL_HUMAN_MEDIA_CONTROL, op: 'close' })
    this.#failReadyWaiters(new Error('digital human session closed'))
    try { await this.#session?.close() } catch {}
    this.#session = null
    this.#ready = false
  }

  // -- internals ----------------------------------------------------------

  #enqueue(record, task) {
    record.pendingAppends++
    record.chain = record.chain
      .then(async () => {
        if (record.pendingAppends > MAX_IN_FLIGHT_APPENDS) {
          // Bounded orchestration: let the provider-side admission queue
          // drain instead of stacking unbounded pending promises.
          await new Promise(resolve => setImmediate(resolve))
        }
        await task()
      })
      .catch(error => {
        this.#log('turn_task_failed', { responseId: record.ref.responseId, message: error.message })
        this.#degrade(record, 'provider_failure', error.code || 'unavailable')
      })
      .finally(() => { record.pendingAppends-- })
    this.#tail = record.chain
  }

  async #waitReady() {
    if (this.#ready) return
    await new Promise((resolve, reject) => {
      this.#readyWaiters.push({ resolve, reject })
    })
  }

  #failReadyWaiters(error) {
    const waiters = this.#readyWaiters
    this.#readyWaiters = []
    for (const waiter of waiters) waiter.reject(error)
  }

  #resolveReadyWaiters() {
    const waiters = this.#readyWaiters
    this.#readyWaiters = []
    for (const waiter of waiters) waiter.resolve()
  }

  async #ensureTurn(record) {
    if (record.turnStarted || record.cancelled) return record.turnStarted
    await this.#waitReady()
    if (record.cancelled || this.#closed || this.#mode === 'audio_only') return false
    await this.#session.startTurn(record.ref)
    record.turnStarted = true
    // A real turn ran, so the session is healthy: re-arm idle restarts.
    this.#idleFailures = 0
    this.#publish({
      type: DIGITAL_HUMAN_MEDIA_CONTROL,
      op: 'begin',
      turn: record.ref,
      format: this.#format,
    })
    return true
  }

  async #appendAudio(record, delta) {
    if (record.cancelled || record.inputSealed) return
    if (!await this.#ensureTurn(record)) return
    if (record.cancelled || record.inputSealed) return
    const data = Buffer.from(delta, 'base64')
    // Account samples from the buffer actually transmitted, not from
    // Buffer.byteLength(delta, 'base64'): for non-canonical/unpadded base64 the
    // estimate can exceed the decoded length, which would make the gateway
    // declare a larger finish total than the renderer admitted (DHAV rejects the
    // turn). `bytes` stays a fine approximation for the selector's buffer bound.
    const samples = data.length / 2
    await this.#session.appendAudio({
      ...record.ref,
      sequence: record.sequence,
      sampleOffset: record.sampleOffset,
      data,
    })
    record.lastAudioSequence = record.sequence
    record.sequence++
    record.sampleOffset += samples
    record.totalSamples += samples
  }

  async #finishTurn(record) {
    if (!record.turnStarted || record.inputSealed) return
    record.inputSealed = true
    await this.#session.finishTurn({
      ...record.ref,
      lastAudioSequence: record.lastAudioSequence,
      totalSamples: record.totalSamples,
    })
    this.#publish({ type: DIGITAL_HUMAN_MEDIA_CONTROL, op: 'finish', turn: record.ref })
  }

  async #interruptTurn(ref, reason) {
    if (!this.#session) return
    try {
      await this.#session.interruptTurn({ ...ref, reason })
    } catch (error) {
      this.#log('interrupt_failed', { responseId: ref.responseId, message: error.message })
    }
  }

  // -- idle turn ------------------------------------------------------------
  // Between replies the gateway feeds the renderer a silent turn so it keeps
  // producing idle animation instead of freezing on the last spoken frame. The
  // idle turn is control-plane only: its frames publish straight to the video
  // track (see AvatarAvScheduler) and its silence never enters the audio queue,
  // so it cannot trip the browser's energy-gated playback receipts.

  #idleEligible() {
    return !this.#closed && this.#mode === 'avatar' && this.#ready
      && !this.#activeResponseId && !this.#idle && this.#idleEnabled
      && Boolean(this.#session)
  }

  // Deferred so the synchronous parts of a cancel/degrade (which set #mode and
  // #activeResponseId) settle before eligibility is re-checked. The delay also
  // carries the restart backoff.
  #scheduleIdle(delayMs = 0) {
    if (!this.#idleEnabled || this.#idleTimer) return
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null
      void this.#startIdle()
    }, delayMs)
    this.#idleTimer.unref?.()
  }

  async #startIdle() {
    if (!this.#idleEligible()) return
    const ref = {
      avatarSessionId: this.#avatarSessionId,
      responseId: IDLE_RESPONSE_ID,
      generation: this.#generation,
    }
    // Register before the await: a real turn landing while startTurn is in flight
    // must find this descriptor so #stopIdle() cancels the renderer turn and
    // isolates its generation, instead of leaving idle frames flowing under the
    // generation the real turn is about to mint.
    this.#idle = { ref, sequence: 0, sampleOffset: 0, timer: null, startedAt: Date.now() }
    try {
      await this.#session.startTurn(ref)
    } catch (error) {
      this.#log('idle_start_failed', { message: error.message })
      this.#stopIdle()
      this.#restartIdleBounded()
      return
    }
    // Superseded or torn down while startTurn was in flight: #stopIdle() already
    // cancelled the renderer turn and isolated the generation, so just bail.
    if (this.#idle?.ref !== ref || this.#closed || this.#activeResponseId || this.#mode !== 'avatar') return
    this.#publish({
      type: DIGITAL_HUMAN_MEDIA_CONTROL,
      op: 'begin',
      turn: ref,
      format: this.#format,
      idle: true,
    })
    this.#feedIdle()
  }

  #feedIdle() {
    const idle = this.#idle
    if (!idle) return
    const samples = Math.round(this.#format.sampleRate * IDLE_FEED_INTERVAL_MS / 1000)
    const data = Buffer.alloc(samples * 2) // silence
    const tick = async () => {
      if (this.#idle !== idle || this.#closed) return
      try {
        // Serialized: each block is acknowledged before the next is scheduled,
        // so the provider's strict per-turn sequence never sees a gap.
        await this.#session.appendAudio({
          ...idle.ref,
          sequence: idle.sequence,
          sampleOffset: idle.sampleOffset,
          data,
        })
        idle.sequence++
        idle.sampleOffset += samples
        // Re-arm the restart budget only once this idle turn has proven healthy.
        // Resetting on every block would make the bound useless against a
        // renderer that accepts a turn and then errors on it, which spins the
        // restart loop at the feed cadence and starves real replies.
        if (this.#idleFailures && Date.now() - idle.startedAt >= IDLE_HEALTHY_MS) this.#idleFailures = 0
      } catch (error) {
        this.#log('idle_feed_failed', { reasonCode: error.code, message: error.message })
        this.#stopIdle()
        this.#restartIdleBounded()
        return
      }
      if (this.#idle === idle && !this.#closed) {
        idle.timer = setTimeout(tick, IDLE_FEED_INTERVAL_MS)
        idle.timer.unref?.()
      }
    }
    idle.timer = setTimeout(tick, IDLE_FEED_INTERVAL_MS)
    idle.timer.unref?.()
  }

  #stopIdle() {
    const idle = this.#idle
    this.#clearIdleTimers()
    if (!idle) return
    void this.#interruptTurn(idle.ref, 'user_interruption')
    this.#publish({ type: DIGITAL_HUMAN_MEDIA_CONTROL, op: 'clear', generation: idle.ref.generation })
    this.#generation++
  }

  // A dead idle turn freezes the avatar on its last frame, which is exactly what
  // idle exists to prevent, so retry — but only a bounded number of consecutive
  // times, with exponential backoff. #idleEligible() still gates each attempt, so
  // a degraded or closed session never retries at all.
  #restartIdleBounded() {
    if (this.#idleFailures++ >= MAX_IDLE_RESTARTS) return
    this.#scheduleIdle(IDLE_RESTART_BACKOFF_MS * 2 ** (this.#idleFailures - 1))
  }

  #clearIdleTimers() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = null
    }
    if (this.#idle?.timer) clearTimeout(this.#idle.timer)
    this.#idle = null
  }

  async #consumeEvents() {
    for await (const event of this.#session.events()) {
      if (this.#closed) return
      this.#handleProviderEvent(event)
    }
  }

  #handleProviderEvent(event) {
    const generation = event.turn?.generation
    if (typeof generation === 'number' && generation < this.#generation) return // stale, isolated
    switch (event.type) {
      case 'session.ready':
        this.#ready = true
        this.#mode = 'avatar' // a rebuilt session restores avatar capability
        this.#resolveReadyWaiters()
        this.#publishState(DigitalHumanState.IDLE)
        this.#scheduleIdle()
        return
      case 'turn.first_media': {
        // Informational: publishable media exists, but the user has not
        // seen it yet. Commit happens in mediaPublished().
        const record = this.#responses.get(event.turn?.responseId)
        if (record) record.providerFirstMedia = true
        return
      }
      case 'turn.completed': {
        const record = this.#responses.get(event.turn?.responseId)
        if (record) {
          record.providerDone = true
          this.#maybeComplete(record)
        }
        return
      }
      case 'turn.cancelled': {
        const record = this.#responses.get(event.turn?.responseId)
        if (record) record.providerCancelled = true
        return
      }
      case 'provider.error': {
        // An idle-turn failure is cosmetic: stop the silence feeder and keep the
        // session for real turns. Only a genuinely dead session (socket closed)
        // degrades/rebuilds; a turn-level idle error (no first media, stalled)
        // must never drop avatar mode.
        if (event.turn?.responseId === IDLE_RESPONSE_ID) {
          this.#log('idle_provider_error', { reasonCode: event.code, message: event.message })
          this.#stopIdle()
          if (!this.#session || this.#session.state === 'closed') {
            this.#mode = 'audio_only'
            this.#publishState(DigitalHumanState.ERROR, { code: event.code || 'unavailable' })
            if (event.rebuild) this.#rebuild()
          } else {
            this.#restartIdleBounded()
          }
          return
        }
        const record = this.#responses.get(event.turn?.responseId)
        this.#log('provider_error', { reasonCode: event.code, message: event.message, rebuild: Boolean(event.rebuild) })
        if (record && !record.cancelled) {
          this.#degrade(record, event.code || 'provider_failure', event.code)
        } else {
          this.#mode = 'audio_only'
          this.#publishState(DigitalHumanState.ERROR, { code: event.code || 'unavailable' })
        }
        if (event.rebuild) this.#rebuild()
        return
      }
      default:
        return
    }
  }

  // Move one response to the plain audio egress without replaying anything
  // already published. Pre-commit failures flush the buffer in order;
  // post-commit failures cancel the turn (design.zh.md §6 degradation table).
  #degrade(record, reason, code) {
    if (record.cancelled) return
    const { responseId } = record.ref
    const { committed, flush } = record.selector.commitAudio(reason)
    if (committed) {
      if (record.turnStarted) {
        record.inputSealed = true
        this.#enqueue(record, () => this.#interruptTurn(record.ref, 'provider_failure'))
        // block:false — the flush below replays this response's own audio on the
        // plain egress, so quarantining the avatar media must not close it.
        this.#publish({ type: DIGITAL_HUMAN_MEDIA_CONTROL, op: 'clear', generation: record.ref.generation, block: false })
        this.#generation++
      }
      this.#mode = 'audio_only'
      this.#log('avatar_degraded', { responseId, reason, reasonCode: code, flushed: flush.length })
      this.#publishState(DigitalHumanState.AUDIO_ONLY, { responseId, reason, code })
      if (flush.length) this.#onFlushAudio?.({ responseId, deltas: flush })
      return
    }
    // Anything published may already have been heard: cancel, never replay.
    this.responseCancel({ responseId, reason: 'provider_failure' })
    this.#mode = 'audio_only'
    this.#log('avatar_degraded', { responseId, reason, reasonCode: code, flushed: 0 })
    this.#publishState(DigitalHumanState.AUDIO_ONLY, { responseId, reason, code })
  }

  #handleSelectorFallback(record, reason, code, flush) {
    if (record.cancelled) return
    if (record.turnStarted) {
      record.inputSealed = true
      this.#enqueue(record, () => this.#interruptTurn(record.ref, 'provider_failure'))
      // block:false — see #degrade. Without it the flush is dropped on arrival and
      // the whole reply goes silent, which also strands the gated transcript.
      this.#publish({ type: DIGITAL_HUMAN_MEDIA_CONTROL, op: 'clear', generation: record.ref.generation, block: false })
      this.#generation++
    }
    this.#mode = 'audio_only'
    this.#log('avatar_fallback', { responseId: record.ref.responseId, reason, reasonCode: code, flushed: flush.length })
    this.#publishState(DigitalHumanState.AUDIO_ONLY, { responseId: record.ref.responseId, reason, code })
    if (flush.length) this.#onFlushAudio?.({ responseId: record.ref.responseId, deltas: flush })
  }

  #rebuild() {
    if (this.#closed) return
    const previous = this.#session
    this.#ready = false
    this.#session = null
    this.#generation++
    ;(async () => {
      try { await previous?.close() } catch {}
      if (this.#closed) return
      this.#session = await this.#provider.openSession({ persona: this.#persona, format: this.#format })
      this.#avatarSessionId = this.#session.avatarSessionId
      this.#publish({
        type: DIGITAL_HUMAN_MEDIA_OPEN,
        avatarSessionId: this.#avatarSessionId,
        binding: this.#session.mediaBinding,
      })
      this.#eventLoop = this.#consumeEvents()
      this.#eventLoop.catch(error => this.#log('event_loop_error', { message: error.message }))
    })().catch(error => {
      this.#log('rebuild_failed', { message: error.message })
      this.#publishState(DigitalHumanState.ERROR, { code: 'unavailable', reason: 'rebuild_failed' })
    })
  }

  #maybeComplete(record) {
    if (
      record.selector.state === SelectorState.TERMINAL
      || record.selector.state === SelectorState.CANCELLED
    ) {
      if (record.modelDone || record.cancelled) {
        record.selector.close()
        this.#responses.delete(record.ref.responseId)
      }
    }
  }

  // Remember a cancelled/degraded response so a late model delta cannot revive
  // it. Bounded: response ids are unique, so the oldest entries are safe to drop.
  #retire(responseId) {
    this.#retired.add(responseId)
    while (this.#retired.size > 64) {
      this.#retired.delete(this.#retired.values().next().value)
    }
  }

  #publishState(state, { responseId = null, reason = null, code = null } = {}) {
    this.#publish({
      type: DIGITAL_HUMAN_STATE,
      ...createStatePayload({ state, responseId, reason, code }),
    })
  }
}
