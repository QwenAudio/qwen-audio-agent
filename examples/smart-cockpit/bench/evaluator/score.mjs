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

function matchesStateAssertions(assertions, state) {
  return Object.entries(assertions || {})
    .every(([path, expected]) => deepSubset(expected, getPath(state, path)))
}

function stateSnapshotAt(trace, turnIndex) {
  const snapshots = trace?.state_snapshots || []
  const exact = snapshots.find(snapshot => snapshot.turn_index === turnIndex)
  return exact?.state || null
}

function callComparison(expected, actual) {
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
}

function pairScore(comparison) {
  if (!comparison.name) return null
  return 100
    + (comparison.arguments ? 4 : 0)
    + (comparison.turn ? 2 : 0)
    + (comparison.path ? 1 : 0)
}

function alignCalls(expectedCalls, actualCalls) {
  const rows = expectedCalls.length
  const columns = actualCalls.length
  const dp = Array.from({ length: rows + 1 }, () => Array(columns + 1).fill(0))
  const choices = Array.from({ length: rows + 1 }, () => Array(columns + 1).fill(null))
  const comparisons = Array.from({ length: rows }, () => Array(columns).fill(null))

  for (let row = 1; row <= rows; row += 1) {
    for (let column = 1; column <= columns; column += 1) {
      const expected = expectedCalls[row - 1]
      const actual = actualCalls[column - 1]
      const comparison = callComparison(expected, actual)
      comparisons[row - 1][column - 1] = comparison

      let best = dp[row - 1][column]
      let choice = 'skip_expected'
      if (dp[row][column - 1] > best) {
        best = dp[row][column - 1]
        choice = 'skip_actual'
      }

      const matchScore = pairScore(comparison)
      if (matchScore !== null) {
        const candidate = dp[row - 1][column - 1] + matchScore
        if (candidate > best) {
          best = candidate
          choice = 'match'
        }
      }

      dp[row][column] = best
      choices[row][column] = choice
    }
  }

  const aligned = []
  const expectedIndexes = new Set()
  const actualIndexes = new Set()
  let row = rows
  let column = columns
  while (row > 0 || column > 0) {
    const choice = choices[row]?.[column]
    if (choice === 'match') {
      const expectedIndex = row - 1
      const actualIndex = column - 1
      aligned.push({
        expected_index: expectedIndex,
        actual_index: actualIndex,
        ...comparisons[expectedIndex][actualIndex],
      })
      expectedIndexes.add(expectedIndex)
      actualIndexes.add(actualIndex)
      row -= 1
      column -= 1
    } else if (choice === 'skip_actual' || row === 0) {
      column -= 1
    } else {
      row -= 1
    }
  }
  aligned.reverse()

  return {
    calls: aligned,
    toolSelection: aligned.length,
    arguments: aligned.filter(item => item.arguments).length,
    path: aligned.filter(item => item.path).length,
    turn: aligned.filter(item => item.turn).length,
    missingCallCount: expectedCalls.length - expectedIndexes.size,
    extraCallCount: actualCalls.length - actualIndexes.size,
    missingCalls: expectedCalls
      .map((call, index) => ({ index, call }))
      .filter(item => !expectedIndexes.has(item.index)),
    extraCalls: actualCalls
      .map((call, index) => ({ index, call }))
      .filter(item => !actualIndexes.has(item.index)),
  }
}

export function scoreTrace(caseItem, trace) {
  const actualCalls = trace?.calls || []
  const expectedCalls = caseItem.expected_calls || []
  const expectedByIndex = expectedCalls.map((expected, index) => (
    callComparison(expected, actualCalls[index])
  ))
  const alignment = alignCalls(expectedCalls, actualCalls)
  const forbiddenBoundary = caseItem.forbidden_calls_before_turn
  const noSpuriousBeforeInstruction = forbiddenBoundary === undefined
    ? true
    : actualCalls.every(call => call.turn_index >= forbiddenBoundary)
  const silentTurns = new Set(
    (caseItem.turns || [])
      .map((turn, index) => turn?.expect_no_tool ? index : null)
      .filter(index => index !== null),
  )
  const noToolOnSilentTurns = actualCalls.every(call => !silentTurns.has(call.turn_index))
  const noExtraCalls = actualCalls.length === expectedCalls.length
  const state = trace?.final_state || {}
  const finalStateMatches = matchesStateAssertions(caseItem.expected_final_state, state)
  const checkpointScores = (caseItem.state_checkpoints || []).map(checkpoint => {
    const checkpointState = stateSnapshotAt(trace, checkpoint.turn_index)
    return {
      turn_index: checkpoint.turn_index,
      state: Boolean(checkpointState) && matchesStateAssertions(checkpoint.expected_state, checkpointState),
      expected_state: checkpoint.expected_state,
    }
  })
  const stateMatches = finalStateMatches && checkpointScores.every(checkpoint => checkpoint.state)
  const callScores = expectedByIndex.map(item => (
    item.name && item.path && item.turn && item.arguments
  ))
  const passed = callScores.every(Boolean)
    && noExtraCalls
    && noSpuriousBeforeInstruction
    && noToolOnSilentTurns
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
    alignedToolSelection: alignment.toolSelection,
    alignedPath: alignment.path,
    alignedTurn: alignment.turn,
    alignedArguments: alignment.arguments,
    alignmentMissingCallCount: alignment.missingCallCount,
    alignmentExtraCallCount: alignment.extraCallCount,
    noExtraCalls,
    noSpuriousBeforeInstruction,
    noToolOnSilentTurns,
    state: stateMatches,
    finalState: finalStateMatches,
    stateCheckpoints: checkpointScores,
    responseQuality,
    expectedToolCallsByDomain: callCountsByDomain(expectedCalls),
    actualToolCallsByDomain: callCountsByDomain(actualCalls),
    calls: expectedByIndex,
    alignment,
  }
}

function summarizeScoreList(scores) {
  const total = scores.length || 1
  const sum = key => scores.filter(score => score[key]).length
  const expectedCalls = scores.reduce((count, score) => count + score.expectedCallCount, 0) || 1
  const rawExpectedCalls = scores.reduce((count, score) => count + score.expectedCallCount, 0)
  const actualCalls = scores.reduce((count, score) => count + score.actualCallCount, 0)
  const aggregate = key => scores.reduce((count, score) => count + (score[key] || 0), 0) / expectedCalls
  const totalAlignmentMissingCalls = scores
    .reduce((count, score) => count + (score.alignmentMissingCallCount || 0), 0)
  const totalAlignmentExtraCalls = scores
    .reduce((count, score) => count + (score.alignmentExtraCallCount || 0), 0)
  const responseQualityScores = scores
    .map(score => score.responseQuality)
    .filter(score => score?.evaluated)
  const checkpointScores = scores.flatMap(score => score.stateCheckpoints || [])
  return {
    total_cases: scores.length,
    pass_rate: sum('passed') / total,
    total_expected_tool_calls: rawExpectedCalls,
    total_actual_tool_calls: actualCalls,
    expected_tool_calls_by_domain: mergeCounts(scores, 'expectedToolCallsByDomain'),
    actual_tool_calls_by_domain: mergeCounts(scores, 'actualToolCallsByDomain'),
    no_extra_call_rate: sum('noExtraCalls') / total,
    state_success_rate: sum('state') / total,
    final_state_success_rate: sum('finalState') / total,
    state_checkpoint_success_rate: checkpointScores.length
      ? checkpointScores.filter(score => score.state).length / checkpointScores.length
      : null,
    no_spurious_rate: sum('noSpuriousBeforeInstruction') / total,
    no_tool_on_silent_turn_rate: sum('noToolOnSilentTurns') / total,
    tool_selection_accuracy: aggregate('toolSelection'),
    argument_accuracy: aggregate('arguments'),
    path_accuracy: aggregate('path'),
    turn_accuracy: aggregate('turn'),
    aligned_tool_selection_accuracy: aggregate('alignedToolSelection'),
    aligned_argument_accuracy: aggregate('alignedArguments'),
    aligned_path_accuracy: aggregate('alignedPath'),
    aligned_turn_accuracy: aggregate('alignedTurn'),
    alignment_missing_calls: totalAlignmentMissingCalls,
    alignment_extra_calls: totalAlignmentExtraCalls,
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
