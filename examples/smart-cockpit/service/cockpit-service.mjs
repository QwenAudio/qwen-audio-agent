import { CockpitStateStore } from './state-store.mjs'
import { CustomSkillStore } from './custom-skills/store.mjs'
import {
  COCKPIT_TOOL_NAMES,
  executeCockpitTool,
} from './tools/registry.mjs'
import { normalizeVehicleLocation } from './vehicle-location.mjs'

function clean(value) {
  return String(value || '').trim()
}

const LOCATION_AWARE_TOOLS = new Set([
  'vehicle_location_query',
  'navigation_start',
  'navigation_route_query',
  'navigation_add_waypoint',
  'navigation_remove_waypoint',
  'navigation_change_destination',
  'navigation_set_route_strategy',
  'navigation_search_place',
  'navigation_to_favorite',
  'navigation_set_favorite',
])

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
    customSkills = new CustomSkillStore(),
    services = emptyServices(),
    now = Date.now,
    random = Math.random,
  } = {}) {
    this.store = store
    this.customSkills = customSkills
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

  listSkills(cockpitId = 'default') {
    return this.customSkills.list(cockpitId)
  }

  getSkill(cockpitId = 'default', reference) {
    return this.customSkills.get(cockpitId, reference)
  }

  async deleteSkill(cockpitId = 'default', reference) {
    const skill = await this.customSkills.delete(cockpitId, reference)
    if (skill) {
      this.#publishActivity(cockpitId, {
        kind: 'status',
        category: 'custom_skills',
        status: 'skills_changed',
        message: `已删除自定义技能“${skill.name}”`,
      })
    }
    return skill
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
    if (LOCATION_AWARE_TOOLS.has(name)) {
      await this.#refreshVehicleLocation(cockpitId)
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
      customSkills: this.customSkills,
      now: this.now,
      onActivity: reportActivity,
      random: this.random,
      services: this.services,
      snapshot: () => this.snapshot(cockpitId),
      store: this.store,
    })
  }

  async #refreshVehicleLocation(cockpitId) {
    if (typeof this.services.vehicleLocation !== 'function') return
    let location = null
    try {
      location = normalizeVehicleLocation(await this.services.vehicleLocation())
    } catch {
      return
    }
    if (!location) return
    const current = this.snapshot(cockpitId).location
    if (JSON.stringify(current) === JSON.stringify(location)) return
    this.store.update(cockpitId, ['location'], next => {
      next.location = location
    })
  }
}
