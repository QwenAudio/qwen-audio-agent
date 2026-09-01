import { CockpitStateStore } from './state-store.mjs'
import {
  COCKPIT_TOOL_NAMES,
  executeCockpitTool,
} from './tools/registry.mjs'

function clean(value) {
  return String(value || '').trim()
}

function emptyServices() {
  return {
    async resolvePlace() { return null },
    async searchPlaces() { return [] },
    async searchNearbyPlaces() { return [] },
    async drivingRoute() { return null },
    async weather() { return null },
  }
}

export class CockpitService {
  constructor({
    store = new CockpitStateStore(),
    services = emptyServices(),
    now = Date.now,
    random = Math.random,
  } = {}) {
    this.store = store
    this.services = services
    this.now = now
    this.random = random
    this.activityListeners = new Map()
  }

  snapshot(cockpitId = 'default') {
    return this.store.snapshot(cockpitId)
  }

  subscribe(cockpitId, listener) {
    return this.store.subscribe(cockpitId, listener)
  }

  subscribeActivity(cockpitId, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    const id = clean(cockpitId) || 'default'
    const listeners = this.activityListeners.get(id) || new Set()
    listeners.add(listener)
    this.activityListeners.set(id, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.activityListeners.delete(id)
    }
  }

  reset(cockpitId = 'default') {
    return this.store.reset(cockpitId)
  }

  #publishActivity(cockpitId, event) {
    const id = clean(cockpitId) || 'default'
    const published = Object.freeze({
      type: 'cockpit.activity',
      cockpitId: id,
      ...event,
    })
    for (const listener of this.activityListeners.get(id) || []) {
      try {
        listener(published)
      } catch {
        // Scenario observers cannot interrupt cockpit operations.
      }
    }
  }

  async execute(name, args = {}, {
    cockpitId = 'default',
    onActivity = null,
  } = {}) {
    if (!COCKPIT_TOOL_NAMES.includes(name)) {
      throw new Error(`Unknown cockpit tool: ${name}`)
    }
    const reportActivity = event => {
      try {
        onActivity?.(event)
      } catch {
        // Call-scoped observers cannot interrupt cockpit operations.
      }
      this.#publishActivity(cockpitId, event)
    }
    return executeCockpitTool(name, args, {
      cockpitId,
      now: this.now,
      onActivity: reportActivity,
      random: this.random,
      services: this.services,
      snapshot: () => this.snapshot(cockpitId),
      store: this.store,
    })
  }
}
