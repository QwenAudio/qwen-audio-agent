import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BENCHMARK_DOMAINS,
  loadBenchmarkCases,
  loadNavigationCases,
  assertBenchmarkCase,
  assertNavigationCase,
  routeCaseExpectedPaths,
  routeCasesExpectedPaths,
} from '../evaluator/cases.mjs'
import { scoreTrace, summarizeScores } from '../evaluator/score.mjs'
import {
  COCKPIT_SURFACE_ROUTING,
  COCKPIT_TOOL_NAMES,
  surfaceForCockpitTool,
} from '../../service/tools/registry.mjs'

const navigationToolNames = new Set(
  COCKPIT_TOOL_NAMES.filter(name => name.startsWith('navigation_')),
)
const benchmarkToolNames = new Set(
  COCKPIT_TOOL_NAMES.filter(name => (
    name === 'weather'
    || name.startsWith('vehicle_')
    || name.startsWith('music_')
    || name.startsWith('navigation_')
  )),
)

test('cockpit benchmark cases are valid and cover all configured domains', () => {
  const cases = routeCasesExpectedPaths(loadBenchmarkCases(), COCKPIT_SURFACE_ROUTING)
  assert.equal(cases.length, 86)
  assert.deepEqual([...new Set(cases.map(item => item.domain))].sort(), [...BENCHMARK_DOMAINS].sort())
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length)

  for (const caseItem of cases) {
    assertBenchmarkCase(caseItem, {
      toolNames: benchmarkToolNames,
      surfaceForTool: surfaceForCockpitTool,
    })
  }

  const coveredTools = new Set(cases.flatMap(item => item.expected_calls.map(call => call.name)))
  for (const name of benchmarkToolNames) {
    assert.ok(coveredTools.has(name), `${name} should be covered`)
  }

  assert.ok(cases.every(item => item.expected_response === undefined))
  assert.equal(cases.filter(item => item.response_quality).length, 6)
})

test('navigation benchmark cases are valid and cover the navigation surface', () => {
  const cases = routeCasesExpectedPaths(loadNavigationCases(), COCKPIT_SURFACE_ROUTING)
  assert.equal(cases.length, 36)
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length)

  for (const caseItem of cases) {
    assertNavigationCase(caseItem, {
      navigationToolNames,
      surfaceForTool: surfaceForCockpitTool,
    })
  }

  const coveredTools = new Set(cases.flatMap(item => item.expected_calls.map(call => call.name)))
  for (const name of navigationToolNames) {
    assert.ok(coveredTools.has(name), `${name} should be covered`)
  }

  const preChitchatCases = cases.filter(item => item.tags.includes('pre_chitchat'))
  assert.equal(preChitchatCases.length, 8)
  assert.ok(preChitchatCases.every(item => item.forbidden_calls_before_turn === 1))
  assert.ok(cases.some(item => item.tags.includes('negative')))
  assert.ok(cases.every(item => item.expected_calls.every(call => call.path === 'frontend')))
  assert.ok(cases.every(item => item.expected_response === undefined))
  const responseQualityCases = cases.filter(item => item.response_quality)
  assert.equal(responseQualityCases.length, 4)
  assert.ok(responseQualityCases.every(item => item.tags.includes('negative')))
})

test('routes expected call paths from the current surface configuration', () => {
  const routed = routeCaseExpectedPaths({
    id: 'route_probe',
    expected_calls: [{
      turn_index: 0,
      path: 'backend',
      name: 'navigation_stop',
      arguments: {},
    }],
  }, {
    surfaceForTool(name) {
      return name === 'navigation_stop' ? 'frontend' : 'backend'
    },
  })
  assert.equal(routed.expected_calls[0].path, 'frontend')
})

test('scores traces across calls arguments paths state and chitchat guardrails', () => {
  const caseItem = {
    id: 'score_probe',
    expected_calls: [{
      turn_index: 1,
      path: 'backend',
      name: 'navigation_start',
      arguments: { destination: '西湖', waypoints: ['黄龙体育中心'] },
    }],
    forbidden_calls_before_turn: 1,
    expected_final_state: {
      'navigation.status': 'navigating',
      'navigation.destination': '西湖',
      'navigation.waypoints[0]': '黄龙体育中心',
    },
  }
  const good = scoreTrace(caseItem, {
    calls: [{
      turn_index: 1,
      path: 'backend',
      name: 'navigation_start',
      arguments: { destination: '西湖', waypoints: ['黄龙体育中心'], strategy: 0 },
    }],
    final_state: {
      navigation: {
        status: 'navigating',
        destination: '西湖',
        waypoints: ['黄龙体育中心'],
      },
    },
  })
  assert.equal(good.passed, true)

  const bad = scoreTrace(caseItem, {
    calls: [
      { turn_index: 0, path: 'backend', name: 'navigation_search_place', arguments: { query: '西湖' } },
      { turn_index: 1, path: 'backend', name: 'navigation_start', arguments: { destination: '西湖' } },
    ],
    final_state: { navigation: { status: 'navigating', destination: '西湖', waypoints: [] } },
  })
  assert.equal(bad.passed, false)
  assert.equal(bad.noSpuriousBeforeInstruction, false)
  assert.equal(bad.noExtraCalls, false)
  assert.equal(bad.arguments, 0)
  assert.equal(bad.state, false)
})

test('keeps response quality separate from action scoring', () => {
  const caseItem = {
    id: 'response_quality_probe',
    expected_calls: [],
    response_quality: {
      type: 'clarification',
      missing_slots: ['destination'],
      rubric: '助手应追问具体目的地。',
    },
    expected_final_state: {
      'navigation.status': 'idle',
    },
  }
  const score = scoreTrace(caseItem, {
    calls: [],
    assistant_messages: ['我没听懂。'],
    final_state: { navigation: { status: 'idle' } },
  })
  assert.equal(score.passed, true)
  assert.equal(score.responseQuality.evaluated, false)
  assert.equal(score.responseQuality.passed, null)
})

test('normalizes equivalent tool arguments before scoring', () => {
  const score = scoreTrace({
    id: 'alias_probe',
    domain: 'vehicle',
    expected_calls: [{
      turn_index: 0,
      path: 'frontend',
      name: 'vehicle_closure_control',
      arguments: { target: 'trunk', action: 'open' },
    }],
  }, {
    calls: [{
      turn_index: 0,
      path: 'frontend',
      name: 'vehicle_closure_control',
      arguments: { target: 'rear_trunk', action: 'open' },
    }],
    final_state: {},
  })
  assert.equal(score.passed, true)
  assert.equal(score.arguments, 1)
})

test('summarizes benchmark scores as rates', () => {
  const summary = summarizeScores([
    {
      passed: true,
      domain: 'navigation',
      state: true,
      noSpuriousBeforeInstruction: true,
      noExtraCalls: true,
      expectedCallCount: 1,
      actualCallCount: 1,
      expectedToolCallsByDomain: { navigation: 1 },
      actualToolCallsByDomain: { navigation: 1 },
      toolSelection: 1,
      arguments: 1,
      path: 1,
      turn: 1,
      responseQuality: null,
    },
    {
      passed: false,
      domain: 'music',
      state: false,
      noSpuriousBeforeInstruction: true,
      noExtraCalls: true,
      expectedCallCount: 1,
      actualCallCount: 1,
      expectedToolCallsByDomain: { music: 1 },
      actualToolCallsByDomain: { music: 1 },
      toolSelection: 0,
      arguments: 0,
      path: 1,
      turn: 1,
      responseQuality: {
        evaluated: true,
        passed: false,
      },
    },
  ])

  assert.equal(summary.total_cases, 2)
  assert.equal(summary.pass_rate, 0.5)
  assert.equal(summary.total_expected_tool_calls, 2)
  assert.equal(summary.total_actual_tool_calls, 2)
  assert.deepEqual(summary.expected_tool_calls_by_domain, {
    navigation: 1,
    music: 1,
  })
  assert.deepEqual(summary.actual_tool_calls_by_domain, {
    navigation: 1,
    music: 1,
  })
  assert.equal(summary.no_extra_call_rate, 1)
  assert.equal(summary.state_success_rate, 0.5)
  assert.equal(summary.no_spurious_rate, 1)
  assert.equal(summary.tool_selection_accuracy, 0.5)
  assert.equal(summary.argument_accuracy, 0.5)
  assert.equal(summary.path_accuracy, 1)
  assert.equal(summary.response_quality_evaluated, 1)
  assert.equal(summary.response_quality_rate, 0)
  assert.equal(summary.domains.navigation.total_cases, 1)
  assert.equal(summary.domains.music.total_cases, 1)
})
