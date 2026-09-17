import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'

// Execute the production hooks without a browser, audio device, or new testing
// dependency. State/ref slots and effect dependency comparisons survive renders.
export function createHookHarness() {
  const slots = []
  let cursor = 0
  let effects = []
  const same = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((item, index) => Object.is(item, right[index]))
  const slot = initialize => {
    const index = cursor++
    if (!slots[index]) slots[index] = initialize()
    return slots[index]
  }
  const react = {
    useState(initial) {
      const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      state.set ||= value => { state.value = typeof value === 'function' ? value(state.value) : value }
      return [state.value, state.set]
    },
    useRef(initial) {
      return slot(() => ({ current: initial }))
    },
    useMemo(create, dependencies) {
      const memo = slot(() => ({}))
      if (!same(memo.dependencies, dependencies)) {
        memo.value = create()
        memo.dependencies = dependencies
      }
      return memo.value
    },
    useCallback(callback, dependencies) {
      return react.useMemo(() => callback, dependencies)
    },
    useEffect(create, dependencies) {
      const effect = slot(() => ({}))
      if (same(effect.dependencies, dependencies)) return
      effect.dependencies = dependencies
      effects.push(() => {
        effect.cleanup?.()
        effect.cleanup = create()
      })
    },
  }
  return {
    react,
    render(hook, props) {
      cursor = 0
      effects = []
      const result = hook(props)
      for (const effect of effects) effect()
      return result
    },
    unmount() {
      for (const entry of slots) entry.cleanup?.()
    },
  }
}

export function mockHookImports(t, mocks) {
  const id = randomUUID()
  const registry = globalThis.__cockpitHookTestModules ||= new Map()
  registry.set(id, mocks)
  const prefix = `cockpit-hook-test:${id}/`
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (Object.hasOwn(mocks, specifier)) {
        return { url: `${prefix}${encodeURIComponent(specifier)}`, shortCircuit: true }
      }
      if (specifier.startsWith('.') && !extname(specifier)) {
        const candidate = new URL(`${specifier}.js`, context.parentURL)
        if (candidate.protocol === 'file:' && existsSync(candidate)) return next(candidate.href, context)
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (!url.startsWith(prefix)) return next(url, context)
      const specifier = decodeURIComponent(url.slice(prefix.length))
      const source = [
        `const value = globalThis.__cockpitHookTestModules.get(${JSON.stringify(id)})[${JSON.stringify(specifier)}];`,
        ...Object.keys(mocks[specifier]).map(name => name === 'default'
          ? 'export default value.default;'
          : `export const ${name} = value.${name};`),
      ].join('\n')
      return { format: 'module', source, shortCircuit: true }
    },
  })
  t.after(() => {
    hooks.deregister()
    registry.delete(id)
  })
  return url => import(`${url.href}?hook-test=${id}`)
}

export function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
