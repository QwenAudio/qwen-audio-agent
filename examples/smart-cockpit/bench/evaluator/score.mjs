function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function getPath(object, path) {
  return String(path).split('.').reduce((value, segment) => {
    if (value == null) return undefined
    const match = /^([^\[]+)(?:\[(\d+)\])?$/u.exec(segment)
    if (!match) return undefined
    const next = value[match[1]]
    return match[2] === undefined ? next : next?.[Number(match[2])]
  }, object)
}

function deepSubset(expected, actual) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false
    return expected.every((item, index) => deepSubset(item, actual[index]))
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false
    return Object.entries(expected).every(([key, value]) => deepSubset(value, actual[key]))
  }
  return Object.is(expected, actual)
}

function deepEqual(expected, actual) {
  return deepSubset(expected, actual) && deepSubset(actual, expected)
}

function normalizedArguments(toolName, args = {}) {
  const normalized = isPlainObject(args) ? { ...args } : {}
  if (toolName === 'vehicle_closure_control') {
    const targetAliases = {
      trunk: 'rear_trunk',
      rear_trunk: 'rear_trunk',
      fuel_port: 'charge_port',
      charge_port: 'charge_port',
    }
    if (normalized.target in targetAliases) normalized.target = targetAliases[normalized.target]
  }
  return normalized
}

function toolDomain(name) {
  if (name === 'weather') return 'weather'
  return String(name || '').split('_')[0] || 'unknown'
}

function callCountsByDomain(calls) {
  const counts = {}
  for (const call of calls || []) {
    const domain = toolDomain(call.name)
    counts[domain] = (counts[domain] || 0) + 1
  }
  return counts
}

function mergeCounts(items, key) {
  const merged = {}
  for (const item of items) {
    for (const [domain, count] of Object.entries(item[key] || {})) {
      merged[domain] = (merged[domain] || 0) + count
    }
  }
  return merged
}

export function scoreTrace(caseItem, trace) {
  const actualCalls = trace?.calls || []
  const expectedCalls = caseItem.expected_calls || []
  const expectedByIndex = expectedCalls.map((expected, index) => {
    const actual = actualCalls[index]
    const expectedArgs = normalizedArguments(expected.name, expected.arguments || {})
    const actualArgs = normalizedArguments(actual?.name || expected.name, actual?.arguments || {})
    return {
      expected,
      actual,
      name: actual?.name === expected.name,
      path: actual?.path === expected.path,
      turn: actual?.turn_index === expected.turn_index,
      arguments: expected.exact_arguments
        ? deepEqual(expectedArgs, actualArgs)
        : deepSubset(expectedArgs, actualArgs),
    }
  })
  const forbiddenBoundary = caseItem.forbidden_calls_before_turn
  const noSpuriousBeforeInstruction = forbiddenBoundary === undefined
    ? true
    : actualCalls.every(call => call.turn_index >= forbiddenBoundary)
  const noExtraCalls = actualCalls.length === expectedCalls.length
  const state = trace?.final_state || {}
  const stateMatches = Object.entries(caseItem.expected_final_state || {})
    .every(([path, expected]) => deepSubset(expected, getPath(state, path)))
  const callScores = expectedByIndex.map(item => (
    item.name && item.path && item.turn && item.arguments
  ))
  const passed = callScores.every(Boolean)
    && noExtraCalls
    && noSpuriousBeforeInstruction
    && stateMatches
  const responseQuality = caseItem.response_quality
    ? {
        evaluated: false,
        passed: null,
        type: caseItem.response_quality.type || null,
        rubric: caseItem.response_quality.rubric || '',
      }
    : null
  return {
    id: caseItem.id,
    domain: caseItem.domain || 'unknown',
    passed,
    expectedCallCount: expectedCalls.length,
    actualCallCount: actualCalls.length,
    toolSelection: expectedByIndex.filter(item => item.name).length,
    path: expectedByIndex.filter(item => item.path).length,
    turn: expectedByIndex.filter(item => item.turn).length,
    arguments: expectedByIndex.filter(item => item.arguments).length,
    noExtraCalls,
    noSpuriousBeforeInstruction,
    state: stateMatches,
    responseQuality,
    expectedToolCallsByDomain: callCountsByDomain(expectedCalls),
    actualToolCallsByDomain: callCountsByDomain(actualCalls),
    calls: expectedByIndex,
  }
}

function summarizeScoreList(scores) {
  const total = scores.length || 1
  const sum = key => scores.filter(score => score[key]).length
  const expectedCalls = scores.reduce((count, score) => count + score.expectedCallCount, 0) || 1
  const rawExpectedCalls = scores.reduce((count, score) => count + score.expectedCallCount, 0)
  const actualCalls = scores.reduce((count, score) => count + score.actualCallCount, 0)
  const aggregate = key => scores.reduce((count, score) => count + score[key], 0) / expectedCalls
  const responseQualityScores = scores
    .map(score => score.responseQuality)
    .filter(score => score?.evaluated)
  return {
    total_cases: scores.length,
    pass_rate: sum('passed') / total,
    total_expected_tool_calls: rawExpectedCalls,
    total_actual_tool_calls: actualCalls,
    expected_tool_calls_by_domain: mergeCounts(scores, 'expectedToolCallsByDomain'),
    actual_tool_calls_by_domain: mergeCounts(scores, 'actualToolCallsByDomain'),
    no_extra_call_rate: sum('noExtraCalls') / total,
    state_success_rate: sum('state') / total,
    no_spurious_rate: sum('noSpuriousBeforeInstruction') / total,
    tool_selection_accuracy: aggregate('toolSelection'),
    argument_accuracy: aggregate('arguments'),
    path_accuracy: aggregate('path'),
    turn_accuracy: aggregate('turn'),
    response_quality_evaluated: responseQualityScores.length,
    response_quality_rate: responseQualityScores.length
      ? responseQualityScores.filter(score => score.passed).length / responseQualityScores.length
      : null,
  }
}

export function summarizeScores(scores) {
  const summary = summarizeScoreList(scores)
  const domains = [...new Set(scores.map(score => score.domain || 'unknown'))].sort()
  return {
    ...summary,
    domains: Object.fromEntries(
      domains.map(domain => [
        domain,
        summarizeScoreList(scores.filter(score => (score.domain || 'unknown') === domain)),
      ]),
    ),
  }
}
