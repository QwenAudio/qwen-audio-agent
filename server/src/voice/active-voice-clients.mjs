export class ActiveVoiceClients {
  constructor() {
    this.clients = new Map()
  }

  activate(ownerId, client, { takeover = false } = {}) {
    const key = String(ownerId || '')
    const previous = this.clients.get(key)
    if (previous === client) {
      return { granted: true, previous: null }
    }
    // A previous owner whose socket already died (e.g. an unclean disconnect
    // after a network drop that never fired ws close) must not hold the slot
    // forever. Only a still-live owner can refuse a non-takeover claim; a dead
    // one is treated as absent. isAlive() is optional, so callers/tests that
    // omit it keep the original "previous always blocks" behaviour.
    const previousAlive = previous ? previous.isAlive?.() !== false : false
    if (previous && previousAlive && !takeover) {
      return { granted: false, previous }
    }
    previous?.deactivate?.(client)
    this.clients.set(key, client)
    return { granted: true, previous: previous || null }
  }

  release(ownerId, client) {
    const key = String(ownerId || '')
    if (this.clients.get(key) !== client) return false
    this.clients.delete(key)
    return true
  }

  isActive(ownerId, client) {
    return this.clients.get(String(ownerId || '')) === client
  }

  active(ownerId) {
    return this.clients.get(String(ownerId || '')) || null
  }

  get size() {
    return this.clients.size
  }
}

export function clientVoiceCapabilities({
  voiceEnabled = false,
  inputEnabled,
  outputEnabled,
  textOnly = false,
} = {}) {
  const canOutput = outputEnabled === undefined
    ? voiceEnabled === true
    : outputEnabled === true
  const canInput = inputEnabled === undefined
    ? canOutput && textOnly !== true
    : inputEnabled === true && textOnly !== true
  const participatesInVoiceArbitration = canOutput && textOnly !== true
  return {
    inputEnabled: canInput,
    outputEnabled: canOutput,
    participatesInVoiceArbitration,
  }
}
