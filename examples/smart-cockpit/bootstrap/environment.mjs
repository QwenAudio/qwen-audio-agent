import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const ENVIRONMENT_FILES = Object.freeze([
  new URL('../.env.local', import.meta.url),
  new URL('../../../.env.local', import.meta.url),
])

export function loadCockpitEnvironment(env = process.env) {
  const loaded = []
  for (const url of ENVIRONMENT_FILES) {
    let values
    try {
      values = parseEnv(readFileSync(url, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const [key, value] of Object.entries(values)) {
      if (env[key] === undefined) env[key] = value
    }
    loaded.push(url)
  }
  return loaded
}
