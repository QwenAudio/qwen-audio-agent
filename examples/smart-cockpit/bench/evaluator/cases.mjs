import { readFileSync } from 'node:fs'

export const NAVIGATION_CASES_URL = new URL('../cases/navigation.jsonl', import.meta.url)
export const VEHICLE_CASES_URL = new URL('../cases/vehicle.jsonl', import.meta.url)
export const MUSIC_CASES_URL = new URL('../cases/music.jsonl', import.meta.url)
export const WEATHER_CASES_URL = new URL('../cases/weather.jsonl', import.meta.url)
export const MIXED_LONG_CONTEXT_CASES_URL = new URL('../cases/mixed-long-context.jsonl', import.meta.url)

export const SHORT_BENCHMARK_CASE_URLS = Object.freeze({
  vehicle: VEHICLE_CASES_URL,
  music: MUSIC_CASES_URL,
  navigation: NAVIGATION_CASES_URL,
  weather: WEATHER_CASES_URL,
})

export const BENCHMARK_CASE_URLS = SHORT_BENCHMARK_CASE_URLS
export const BENCHMARK_DOMAINS = Object.freeze(Object.keys(BENCHMARK_CASE_URLS))
export const MIXED_DOMAIN = 'mixed'
export const BENCHMARK_SUITES = Object.freeze(['short', 'long', 'all'])

export function parseJsonl(text, source = 'jsonl') {
  return text
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, number }) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`${source}:${number}: ${error.message}`)
      }
    })
}

export function loadNavigationCases(url = NAVIGATION_CASES_URL) {
  return parseJsonl(readFileSync(url, 'utf8'), url.pathname)
}

export function loadBenchmarkCases({
  domains = BENCHMARK_DOMAINS,
  suite = 'short',
  urls = SHORT_BENCHMARK_CASE_URLS,
  longContextUrl = MIXED_LONG_CONTEXT_CASES_URL,
} = {}) {
  if (!BENCHMARK_SUITES.includes(suite)) {
    throw new Error(`Unknown benchmark suite: ${suite}`)
  }
  const selected = Array.isArray(domains) && domains.length ? domains : BENCHMARK_DOMAINS
  const cases = []
  if (suite === 'short' || suite === 'all') {
    cases.push(...selected.flatMap(domain => {
      const url = urls[domain]
      if (!url) throw new Error(`Unknown benchmark domain: ${domain}`)
      return parseJsonl(readFileSync(url, 'utf8'), url.pathname)
    }))
  }
  if (suite === 'long' || suite === 'all') {
    cases.push(...parseJsonl(readFileSync(longContextUrl, 'utf8'), longContextUrl.pathname))
  }
  return cases
}

export function routeCaseExpectedPaths(caseItem, routing) {
  if (!routing?.surfaceForTool) return structuredClone(caseItem)
  return {
    ...structuredClone(caseItem),
    expected_calls: (caseItem.expected_calls || []).map(call => ({
      ...call,
      path: routing.surfaceForTool(call.name) || call.path,
    })),
  }
}

export function routeCasesExpectedPaths(cases, routing) {
  return cases.map(caseItem => routeCaseExpectedPaths(caseItem, routing))
}

export function toolDomain(name) {
  if (name === 'weather') return 'weather'
  return String(name || '').split('_')[0] || ''
}

export function assertBenchmarkCase(caseItem, {
  frontendToolNames = new Set(),
  toolNames = new Set(),
  surfaceForTool,
} = {}) {
  if (!caseItem || typeof caseItem !== 'object') throw new TypeError('case must be an object')
  if (!caseItem.id || typeof caseItem.id !== 'string') throw new TypeError('case.id is required')
  const allowedCaseDomains = [...BENCHMARK_DOMAINS, MIXED_DOMAIN]
  if (!allowedCaseDomains.includes(caseItem.domain)) {
    throw new TypeError(`${caseItem.id}: domain must be one of ${allowedCaseDomains.join(', ')}`)
  }
  if (!Array.isArray(caseItem.turns) || caseItem.turns.length === 0) {
    throw new TypeError(`${caseItem.id}: turns must be a non-empty array`)
  }
  if (!Array.isArray(caseItem.expected_calls)) {
    throw new TypeError(`${caseItem.id}: expected_calls must be an array`)
  }
  for (const [index, turn] of caseItem.turns.entries()) {
    if (!turn || typeof turn.user !== 'string' || turn.user.trim().length === 0) {
      throw new TypeError(`${caseItem.id}: turns[${index}].user is required`)
    }
    if (turn.expect_no_tool !== undefined && typeof turn.expect_no_tool !== 'boolean') {
      throw new TypeError(`${caseItem.id}: turns[${index}].expect_no_tool must be a boolean`)
    }
  }
  for (const [index, call] of caseItem.expected_calls.entries()) {
    if (!toolNames.has(call.name)) {
      throw new TypeError(`${caseItem.id}: expected_calls[${index}].name is not a benchmark tool`)
    }
    const callDomain = toolDomain(call.name)
    if (caseItem.domain === MIXED_DOMAIN) {
      if (!BENCHMARK_DOMAINS.includes(callDomain)) {
        throw new TypeError(`${caseItem.id}: expected_calls[${index}].name is not a benchmark domain tool`)
      }
    } else if (callDomain !== caseItem.domain) {
      throw new TypeError(`${caseItem.id}: expected_calls[${index}].name does not match case domain`)
    }
    if (!Number.isInteger(call.turn_index) || call.turn_index < 0 || call.turn_index >= caseItem.turns.length) {
      throw new TypeError(`${caseItem.id}: expected_calls[${index}].turn_index is invalid`)
    }
    const expectedPath = surfaceForTool?.(call.name)
      || (frontendToolNames.has(call.name) ? 'frontend' : 'backend')
    if (call.path !== expectedPath) {
      throw new TypeError(`${caseItem.id}: ${call.name} should use ${expectedPath} path`)
    }
    if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
      throw new TypeError(`${caseItem.id}: expected_calls[${index}].arguments must be an object`)
    }
    if (call.exact_arguments !== undefined && typeof call.exact_arguments !== 'boolean') {
      throw new TypeError(`${caseItem.id}: expected_calls[${index}].exact_arguments must be a boolean`)
    }
  }
  if (caseItem.forbidden_calls_before_turn !== undefined) {
    const boundary = caseItem.forbidden_calls_before_turn
    if (!Number.isInteger(boundary) || boundary < 0 || boundary > caseItem.turns.length) {
      throw new TypeError(`${caseItem.id}: forbidden_calls_before_turn is invalid`)
    }
  }
  if (caseItem.state_checkpoints !== undefined) {
    if (!Array.isArray(caseItem.state_checkpoints)) {
      throw new TypeError(`${caseItem.id}: state_checkpoints must be an array`)
    }
    for (const [index, checkpoint] of caseItem.state_checkpoints.entries()) {
      if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
        throw new TypeError(`${caseItem.id}: state_checkpoints[${index}] must be an object`)
      }
      if (
        !Number.isInteger(checkpoint.turn_index)
        || checkpoint.turn_index < 0
        || checkpoint.turn_index >= caseItem.turns.length
      ) {
        throw new TypeError(`${caseItem.id}: state_checkpoints[${index}].turn_index is invalid`)
      }
      if (!checkpoint.expected_state || typeof checkpoint.expected_state !== 'object' || Array.isArray(checkpoint.expected_state)) {
        throw new TypeError(`${caseItem.id}: state_checkpoints[${index}].expected_state must be an object`)
      }
    }
  }
  if (caseItem.expected_response !== undefined) {
    throw new TypeError(`${caseItem.id}: expected_response is deprecated; use response_quality`)
  }
  if (caseItem.response_quality !== undefined) {
    const quality = caseItem.response_quality
    if (!quality || typeof quality !== 'object' || Array.isArray(quality)) {
      throw new TypeError(`${caseItem.id}: response_quality must be an object`)
    }
    if (!quality.type || typeof quality.type !== 'string') {
      throw new TypeError(`${caseItem.id}: response_quality.type is required`)
    }
    if (!quality.rubric || typeof quality.rubric !== 'string') {
      throw new TypeError(`${caseItem.id}: response_quality.rubric is required`)
    }
    if (
      quality.missing_slots !== undefined
      && (
        !Array.isArray(quality.missing_slots)
        || quality.missing_slots.some(slot => typeof slot !== 'string' || !slot.trim())
      )
    ) {
      throw new TypeError(`${caseItem.id}: response_quality.missing_slots must be a string array`)
    }
  }
  return true
}

export function assertNavigationCase(caseItem, {
  frontendToolNames = new Set(),
  navigationToolNames = new Set(),
  surfaceForTool,
} = {}) {
  if (caseItem.domain !== 'navigation') throw new TypeError(`${caseItem.id}: domain must be navigation`)
  return assertBenchmarkCase(caseItem, {
    frontendToolNames,
    toolNames: navigationToolNames,
    surfaceForTool,
  })
}
