import {
  DEFAULT_DELIVERY_ADDRESS,
} from './tools/flashbuy/catalog.mjs'
import { SONGS } from './tools/music/catalog.mjs'
import { DEFAULT_VEHICLE_LOCATION } from './vehicle-location.mjs'

const DEFAULT_COCKPIT_ID = 'default'

function clone(value) {
  return structuredClone(value)
}

function normalizeCockpitId(value) {
  const id = String(value || DEFAULT_COCKPIT_ID).trim()
  if (!id || id.length > 120) throw new TypeError('Invalid cockpit id')
  return id
}

export function createInitialCockpitState(now = Date.now()) {
  return {
    version: 1,
    updatedAt: now,
    vehicle: {
      windowFL: 0,
      windowFR: 0,
      windowRL: 0,
      windowRR: 0,
      sunroof: 0,
      headlights: 0,
      ac: 1,
      acTemp: 25,
      acMode: 'cool',
      acFan: 3,
    },
    location: clone(DEFAULT_VEHICLE_LOCATION),
    navigation: {
      status: 'idle',
      destination: null,
      destinationLocation: null,
      waypoints: [],
      waypointLocations: [],
      strategy: 0,
      route: null,
      map: { markers: [], polylines: [] },
      favorites: {
        home: null,
        office: null,
        school: null,
        custom: null,
      },
      voice: {
        muted: false,
        broadcastMode: 'standard',
      },
      viewMode: 'follow',
    },
    music: {
      playing: false,
      currentIndex: 0,
      results: [],
      playlist: clone(SONGS),
    },
    flashbuy: {
      status: 'idle',
      message: '',
      query: '',
      category: 'tea',
      items: [],
      cartItems: [],
      total: 0,
      preview: null,
      order: null,
      address: DEFAULT_DELIVERY_ADDRESS,
    },
    weather: {
      city: '杭州市',
      dayweather: '多云',
      daytemp: '28',
    },
  }
}

export class CockpitStateStore {
  constructor({ now = Date.now } = {}) {
    this.now = now
    this.records = new Map()
    this.listeners = new Map()
  }

  snapshot(cockpitId = DEFAULT_COCKPIT_ID) {
    return clone(this.#record(cockpitId))
  }

  update(cockpitId, changed, mutate) {
    const id = normalizeCockpitId(cockpitId)
    const previous = this.#record(id)
    const next = clone(previous)
    mutate(next)
    next.version = previous.version + 1
    next.updatedAt = this.now()
    this.records.set(id, next)
    const event = Object.freeze({
      type: 'cockpit.state.updated',
      cockpitId: id,
      version: next.version,
      changed: Object.freeze([...new Set(changed)]),
      state: this.snapshot(id),
    })
    for (const listener of this.listeners.get(id) || []) {
      try {
        listener(event)
      } catch {
        // State observers cannot interrupt cockpit operations.
      }
    }
    return event.state
  }

  subscribe(cockpitId, listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    const id = normalizeCockpitId(cockpitId)
    const listeners = this.listeners.get(id) || new Set()
    listeners.add(listener)
    this.listeners.set(id, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(id)
    }
  }

  reset(cockpitId = DEFAULT_COCKPIT_ID) {
    const id = normalizeCockpitId(cockpitId)
    const state = createInitialCockpitState(this.now())
    this.records.set(id, state)
    const event = Object.freeze({
      type: 'cockpit.state.updated',
      cockpitId: id,
      version: state.version,
      changed: Object.freeze(['vehicle', 'location', 'navigation', 'music', 'flashbuy', 'weather']),
      state: this.snapshot(id),
    })
    for (const listener of this.listeners.get(id) || []) {
      try {
        listener(event)
      } catch {
        // State observers cannot interrupt cockpit operations.
      }
    }
    return event.state
  }

  #record(cockpitId) {
    const id = normalizeCockpitId(cockpitId)
    if (!this.records.has(id)) {
      this.records.set(id, createInitialCockpitState(this.now()))
    }
    return this.records.get(id)
  }
}
