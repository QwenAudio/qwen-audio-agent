function toolName(entry) {
  return String(entry?.definition?.function?.name || '').trim()
}

function clientStates(context) {
  return new Set(
    Array.isArray(context?.client?.states)
      ? context.client.states.map(String)
      : [],
  )
}

function policyAllows(policy = {}, context = {}) {
  const availableStates = clientStates(context)
  const requiredStates = Array.isArray(policy.requiredClientStates)
    ? policy.requiredClientStates
    : []
  return requiredStates.every(state => availableStates.has(state))
}

function normalizedPolicy(policy = {}) {
  const normalized = { ...policy }
  if (Array.isArray(policy.requiredClientStates)) {
    normalized.requiredClientStates = Object.freeze([
      ...policy.requiredClientStates.map(String),
    ])
  }
  return Object.freeze(normalized)
}

/**
 * Declarative catalog for tools exposed to the realtime frontend model.
 *
 * Registry policy controls tool visibility only. Tool implementations still
 * validate permissions and current runtime state at execution time.
 */
export class FrontendToolRegistry {
  #entriesByName

  constructor(entries = []) {
    this.#entriesByName = new Map()
    for (const entry of entries) {
      const name = toolName(entry)
      if (!name) throw new Error('Frontend tool definition requires a name')
      if (this.#entriesByName.has(name)) {
        throw new Error(`Duplicate frontend tool: ${name}`)
      }
      this.#entriesByName.set(name, Object.freeze({
        definition: entry.definition,
        policy: normalizedPolicy(entry.policy),
      }))
    }
  }

  has(name) {
    return this.#entriesByName.has(String(name || ''))
  }

  get(name) {
    return this.#entriesByName.get(String(name || '')) || null
  }

  isEnabled(name, context = {}) {
    const entry = this.get(name)
    return Boolean(entry && policyAllows(entry.policy, context))
  }

  definitions(context = {}) {
    return [...this.#entriesByName.entries()]
      .filter(([name]) => this.isEnabled(name, context))
      .map(([, entry]) => entry.definition)
  }
}
