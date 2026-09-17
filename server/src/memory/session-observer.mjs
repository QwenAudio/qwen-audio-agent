// Learning and provider observation belong to memory, not the audio transport.
export class MemorySessionObserver {
  constructor({ memoryService, memoryExtractor, preferencePromoter, profileObserver,
    conversationSync } = {}) {
    Object.assign(this, { memoryService, memoryExtractor, preferencePromoter,
      profileObserver, conversationSync })
  }

  onAudio({ ownerId, sessionId, event, logger }) {
    if (!this.memoryService?.ownsAudioStreamObservation?.()) return
    return this.#run(logger, 'memory.provider_audio_hook_failed', () => (
      this.memoryService.observeAudio(ownerId, event, { source: 'voice-input', sessionId })
    ))
  }

  onSessionClosed({ ownerId, sessionId, logger }) {
    const batch = this.conversationSync?.pendingRecords?.({ ownerId, sessionId }, this)
    const hasNewUserMessages = batch?.messages.some(message => message.role === 'user') === true
    if (hasNewUserMessages) batch.consume()
    const pending = [this.#run(logger, 'memory.extract_hook_failed', () => (
      this.memoryExtractor?.maybeRun({ ownerId, sessionId })
    ))]
    if (this.memoryService?.ownsSessionObservation?.()) {
      pending.push(this.#run(logger, 'memory.provider_observe_hook_failed', async () => {
        if (hasNewUserMessages) {
          await this.memoryService.observe(ownerId, {
            messages: this.conversationSync.frontendContext({ ownerId, sessionId }, batch.messages),
          }, { source: 'session-close', sessionId })
        }
        // Streaming/audio providers may still need to flush an ended session,
        // even when there is no new text to observe.
        await this.memoryService.flush(ownerId, { source: 'session-close', sessionId })
      }))
    }
    // Promote only after observation, including when observation fails: older
    // candidates may still be ready. Each learning path fails independently.
    const observing = this.#run(logger, 'preference.observe_hook_failed', () => (
      this.profileObserver?.maybeRun({ ownerId, sessionId })
    ))
    const promote = () => hasNewUserMessages && batch.isCurrent()
      ? this.#run(logger, 'preference.promote_hook_failed', () => (
          this.preferencePromoter?.run({ ownerId })
        ))
      : undefined
    pending.push(observing?.then ? observing.then(promote) : promote())
    return Promise.all(pending)
  }

  #run(logger, code, operation) {
    const failed = error => logger?.warn(code, {
      error: String(error?.message || error),
    })
    try {
      const result = operation()
      return result?.then ? Promise.resolve(result).catch(failed) : result
    } catch (error) {
      failed(error)
      return undefined
    }
  }
}
