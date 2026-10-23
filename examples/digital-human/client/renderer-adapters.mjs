import { AvatarPlaybackController } from './avatar-playback.mjs'
import { createBrowserAvatarPlayer } from './browser-avatar-player.mjs'
import { createDhavRenderer } from './renderers/dhav.mjs'
import { viduAdapter } from './renderers/vidu.mjs'

// Example-local adapters only: adding a commercial RTC renderer does not add a
// digital-human hook or protocol to the audio-agent core. Its own createPlayer
// can use <video>; createController injects its real playback lifecycle.
const adapters = new Map([
  ['vidu', viduAdapter],
  ['dhav', {
    createPlayer: options => createBrowserAvatarPlayer(options),
    createController: ({ player, sendRenderer, ...options }) => new AvatarPlaybackController({
      ...options, fallbackPlayer: player, renderer: createDhavRenderer({ player, sendRenderer }),
    }),
  }],
])

export function getRendererAdapter(id = 'dhav') {
  const adapter = adapters.get(id)
  if (!adapter) throw new Error(`Unsupported renderer adapter: ${id}`)
  return adapter
}

export function registerRendererAdapter(id, adapter) {
  if (typeof id !== 'string' || !id || adapters.has(id)
    || typeof adapter?.createPlayer !== 'function' || typeof adapter?.createController !== 'function') {
    throw new Error('Renderer adapter requires a unique id, createPlayer and createController')
  }
  adapters.set(id, Object.freeze({ ...adapter }))
}
