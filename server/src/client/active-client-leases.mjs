export class ActiveClientLeases {
  constructor() {
    this.leases = new Map()
    this.generations = new Map()
  }

  claim(ownerId, client, {
    instanceId = null,
    takeover = false,
  } = {}) {
    const key = String(ownerId || '')
    const current = this.leases.get(key)
    if (current?.client === client) {
      return { granted: true, lease: current, previous: null, replaced: false }
    }
    const currentAlive = current?.client?.isAlive?.() !== false
    const sameInstance = Boolean(
      instanceId
      && current?.instanceId
      && current.instanceId === instanceId,
    )
    if (current && currentAlive && !sameInstance && !takeover) {
      return { granted: false, lease: null, previous: current, replaced: false }
    }

    const generation = (this.generations.get(key) || 0) + 1
    this.generations.set(key, generation)
    const lease = {
      ownerId: key,
      client,
      instanceId: instanceId || null,
      generation,
      acquiredAt: Date.now(),
    }
    this.leases.set(key, lease)
    if (current && current.client !== client) {
      current.client.deactivate?.(lease)
    }
    return {
      granted: true,
      lease,
      previous: current || null,
      replaced: Boolean(current),
    }
  }

  release(ownerId, client, generation) {
    const key = String(ownerId || '')
    const current = this.leases.get(key)
    if (
      !current
      || current.client !== client
      || (generation !== undefined && current.generation !== generation)
    ) return false
    this.leases.delete(key)
    return true
  }

  isActive(ownerId, client, generation) {
    const current = this.leases.get(String(ownerId || ''))
    return Boolean(
      current
      && current.client === client
      && (generation === undefined || current.generation === generation),
    )
  }

  active(ownerId) {
    return this.leases.get(String(ownerId || '')) || null
  }

  get size() {
    return this.leases.size
  }
}
