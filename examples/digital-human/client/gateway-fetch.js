// This page is served by the Gateway itself (QWEN_AUDIO_WEB_SKINS_DIR mounts it
// under /skins), so every request is same-origin and needs no gateway URL or
// bearer token — unlike web/src/gateway-transport.js, which also has to reach a
// remote Gateway configured from the desktop settings store.
export function gatewayFetch(path, init = {}, fetchImpl = globalThis.fetch) {
  return fetchImpl(path, { ...init, credentials: 'include' })
}
