import { AvatarPlaybackController } from '../avatar-playback.mjs'
import { createArtcPlayer } from './artc-player.mjs'
const same = (a, b) => a && b && a.responseId === b.responseId && a.generation === b.generation

export function createViduRenderer({ player, sendRenderer, image = () => undefined, onError = () => {} }) {
  let current = null, closed = false
  return {
    startTurn(turn, callbacks) {
      if (closed) return false
      current = { ...turn, callbacks, inputEnded: false, sessionReceived: false }
      return sendRenderer({ type: 'turn.start', ...turn, image: image() })
    },
    appendAudio(turn, audio) {
      if (!same(current, turn) || current.inputEnded) return false
      return sendRenderer({ type: 'audio.append', ...turn, audio, sampleRate: 24000 })
    },
    endTurn(turn) {
      if (!same(current, turn) || current.inputEnded) return
      current.inputEnded = true
      return sendRenderer({ type: 'audio.end', ...turn })
    },
    cancelTurn(turn, reason) {
      if (!same(current, turn)) return
      // Synchronous local gate first; it may report a delayed actual start.
      // The common controller is the only owner of cancellation receipts.
      player.stop()
      current = null
      sendRenderer({ type: 'turn.cancel', ...turn, reason })
    },
    handleMessage(raw) {
      if (closed || typeof raw !== 'string') return
      let message
      try { message = JSON.parse(raw) } catch { current?.callbacks.onError(new Error('Invalid Vidu message')); return }
      const turn = current
      if (!same(turn, message)) return
      if (message.type === 'renderer.error') {
        const error = new Error(message.message || 'Vidu unavailable')
        turn.callbacks.onError(error); onError(error); return
      }
      if (message.type !== 'vidu.session' || turn.sessionReceived) return
      turn.sessionReceived = true
      // One live/channel per response binds an otherwise untagged RTC stream
      // to exactly one response/generation; retired callbacks cannot revive it.
      const currentCallbacks = Object.fromEntries(['onStarted', 'onError'].map(name => [name, value => {
        if (current === turn && !closed) {
          turn.callbacks[name](value)
          if (name === 'onError') onError(value)
        }
      }]))
      if (player.start(turn, message.rtc, currentCallbacks) === false) turn.callbacks.onError(new Error('ARTC unavailable'))
    },
    disconnected(reason) {
      player.stop()
      const turn = current
      current = null
      turn?.callbacks.onError(new Error(reason || 'Vidu disconnected'))
    },
    close() { player.stop(); current = null; closed = true; void player.close() },
  }
}
export const viduAdapter = {
  // A 4 MiB image becomes ~5.6 MiB base64; keep the shared sender bounded
  // without rejecting the first PCM packet while that image is in flight.
  maxBufferedBytes: 8 * 1024 * 1024,
  createPlayer: options => createArtcPlayer(options),
  createController: ({ player, sendRenderer, image, ...options }) => new AvatarPlaybackController({
    ...options, renderer: createViduRenderer({ player, sendRenderer, image,
      onError: error => options.onStatus?.({ state: 'error', reason: error.message }),
    }),
    // Without verifiable output boundary, replay can never be proven safe.
    fallbackPlayer: null, firstPlaybackTimeoutMs: 65000,
  }),
}
