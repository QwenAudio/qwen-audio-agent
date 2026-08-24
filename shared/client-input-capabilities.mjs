const PROFILES = Object.freeze({
  web: Object.freeze({ text: true, audio: true, image: true, resource: true }),
  cli: Object.freeze({ text: true, audio: true, image: true, resource: true }),
  // The desktop orb and conversation panel are two presentations of the same
  // client connection. Advertise the panel's inputs for the whole connection
  // so expanding the window never requires a Realtime reconnect.
  desktop: Object.freeze({ text: true, audio: true, image: true, resource: true }),
})

export function clientInputCapabilities(clientType = 'web') {
  const profile = PROFILES[clientType] || PROFILES.web
  return { ...profile }
}

export function supportsComposerInput(clientType = 'web') {
  const capabilities = clientInputCapabilities(clientType)
  return capabilities.text || capabilities.image || capabilities.resource
}
