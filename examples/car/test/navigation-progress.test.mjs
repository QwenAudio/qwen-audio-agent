import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isTerminalNavigationProgress,
  navigationProgressFromActivity,
} from '../react-app/src/navigation-progress.js'

test('projects only valid navigation activity into UI animation progress', () => {
  assert.deepEqual(navigationProgressFromActivity({
    category: 'navigation',
    status: 'planning_route',
    message: '正在规划路线',
  }), {
    domain: 'navigation',
    stage: 'planning_route',
    message: '正在规划路线',
    source: 'cockpit-domain',
  })
  assert.equal(navigationProgressFromActivity({
    category: 'weather',
    status: 'weather_querying',
    message: '正在查询天气',
  }), null)
  assert.equal(navigationProgressFromActivity({
    category: 'navigation',
    status: '',
    message: '缺少阶段',
  }), null)
})

test('recognizes terminal navigation animation stages', () => {
  assert.equal(isTerminalNavigationProgress({ stage: 'planning_route' }), false)
  assert.equal(isTerminalNavigationProgress({ stage: 'navigation_started' }), true)
  assert.equal(isTerminalNavigationProgress({ stage: 'route_failed' }), true)
})
