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

  names() {
    return [...this.#entriesByName.keys()]
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

  createExecutor(handlers) {
    return new FrontendToolExecutor({ registry: this, handlers })
  }
}

/**
 * Exact dispatcher for the tools declared by one registry.
 *
 * Argument parsing, turn correlation and tool-specific policy remain outside
 * this generic boundary; the executor only guarantees that every registered
 * tool has exactly one callable implementation and unknown tools stay closed.
 */
export class FrontendToolExecutor {
  #handlersByName

  constructor({ registry, handlers = {} } = {}) {
    if (!(registry instanceof FrontendToolRegistry)) {
      throw new Error('FrontendToolExecutor requires a FrontendToolRegistry')
    }
    this.#handlersByName = new Map()
    for (const [name, handler] of Object.entries(handlers)) {
      if (!registry.has(name)) {
        throw new Error(`Executor handler is not registered: ${name}`)
      }
      if (typeof handler !== 'function') {
        throw new Error(`Executor handler must be a function: ${name}`)
      }
      this.#handlersByName.set(name, handler)
    }
    const missing = registry.names().filter(name => !this.#handlersByName.has(name))
    if (missing.length) {
      throw new Error(`Frontend tools lack executors: ${missing.join(', ')}`)
    }
  }

  async execute(name, context) {
    const handler = this.#handlersByName.get(String(name || ''))
    if (!handler) return { handled: false, value: undefined }
    return { handled: true, value: await handler(context) }
  }
}
