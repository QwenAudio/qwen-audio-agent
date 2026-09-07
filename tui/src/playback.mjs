import { resamplePcm16 } from './pcm-audio.mjs'

const OUTPUT_SAMPLE_RATE = 24000

export function createPlayback({
  audioSink,
  onError,
  onStarted,
  onEnded,
  onCancelled,
  onIdle,
}) {
  const activeResponses = new Set()
  const startedResponses = new Set()
  const finishingResponses = new Set()
  const cancelledResponses = new Set()
  const cancelledResponseOrder = []
  const rememberCancelled = responseId => {
    if (!responseId || cancelledResponses.has(responseId)) return
    cancelledResponses.add(responseId)
    cancelledResponseOrder.push(responseId)
    while (cancelledResponseOrder.length > 200) {
      cancelledResponses.delete(cancelledResponseOrder.shift())
    }
  }
  const stop = (reason = '') => {
    for (const responseId of activeResponses) {
      rememberCancelled(responseId)
      onCancelled?.(responseId, reason)
    }
    activeResponses.clear()
    startedResponses.clear()
    finishingResponses.clear()
    audioSink.clear()
  }
  return {
    write(base64, rate = OUTPUT_SAMPLE_RATE, responseId = '') {
      if (responseId && cancelledResponses.has(responseId)) return false
      let buffer = Buffer.from(base64, 'base64')
      if (!buffer.length) return true
      try {
        buffer = resamplePcm16(buffer, rate, OUTPUT_SAMPLE_RATE)
      } catch (error) {
        onError?.(error.message)
        if (responseId) {
          rememberCancelled(responseId)
          onCancelled?.(responseId)
        }
        return false
      }
      if (!audioSink.write(buffer, OUTPUT_SAMPLE_RATE, responseId)) {
        onError?.('音频设备未接受播放数据')
        if (responseId) {
          rememberCancelled(responseId)
          onCancelled?.(responseId)
        }
        return false
      }
      if (responseId) activeResponses.add(responseId)
      return true
    },
    done(responseId = '') {
      if (
        !responseId
        || cancelledResponses.has(responseId)
        || !activeResponses.has(responseId)
        || finishingResponses.has(responseId)
      ) return
      if (audioSink.done?.(responseId)) {
        finishingResponses.add(responseId)
      } else {
        onError?.('音频设备未接受播放完成标记')
        rememberCancelled(responseId)
        activeResponses.delete(responseId)
        startedResponses.delete(responseId)
        finishingResponses.delete(responseId)
        onCancelled?.(responseId)
        if (activeResponses.size === 0) onIdle?.()
      }
    },
    started(responseId = '') {
      if (
        !responseId
        || cancelledResponses.has(responseId)
        || !activeResponses.has(responseId)
        || startedResponses.has(responseId)
      ) return
      startedResponses.add(responseId)
      onStarted?.(responseId)
    },
    ended(responseId = '') {
      if (
        !responseId
        || cancelledResponses.has(responseId)
        || !activeResponses.delete(responseId)
      ) return
      startedResponses.delete(responseId)
      finishingResponses.delete(responseId)
      onEnded?.(responseId)
      if (activeResponses.size === 0) onIdle?.()
    },
    clear: stop,
    close: stop,
  }
}
