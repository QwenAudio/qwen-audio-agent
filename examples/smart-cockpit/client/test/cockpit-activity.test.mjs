import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cockpitProgressFromActivity,
  cockpitScreenForProgress,
  isTerminalCockpitProgress,
} from '../src/projections/cockpit-activity.js'

test('projects supported scenario activity into UI progress', () => {
  assert.deepEqual(cockpitProgressFromActivity({
    category: 'navigation',
    status: 'planning_route',
    message: '正在规划路线',
  }), {
    domain: 'navigation',
    stage: 'planning_route',
    message: '正在规划路线',
    source: 'cockpit-service',
  })
  assert.deepEqual(cockpitProgressFromActivity({
    category: 'flashbuy',
    status: 'flashbuy_searching',
    message: '正在查找附近可送商品',
  }), {
    domain: 'flashbuy',
    stage: 'flashbuy_searching',
    message: '正在查找附近可送商品',
    source: 'cockpit-service',
  })
  assert.equal(cockpitProgressFromActivity({
    category: 'weather',
    status: 'weather_querying',
    message: '正在查询天气',
  }), null)
  assert.equal(cockpitProgressFromActivity({
    category: 'navigation',
    status: '',
    message: '缺少阶段',
  }), null)
})

test('recognizes terminal scenario progress stages', () => {
  assert.equal(isTerminalCockpitProgress({ stage: 'planning_route' }), false)
  assert.equal(isTerminalCockpitProgress({ stage: 'navigation_started' }), true)
  assert.equal(isTerminalCockpitProgress({ stage: 'flashbuy_preview_ready' }), true)
  assert.equal(isTerminalCockpitProgress({ stage: 'music_started' }), true)
})

test('maps scenario activity to the same screens as the original cockpit interaction', () => {
  assert.equal(cockpitScreenForProgress({ domain: 'navigation' }), 'main')
  assert.equal(cockpitScreenForProgress({ domain: 'flashbuy' }), 'flashbuy')
  assert.equal(cockpitScreenForProgress({
    domain: 'music',
    stage: 'music_started',
  }), 'music')
  assert.equal(cockpitScreenForProgress({
    domain: 'music',
    stage: 'music_started',
  }, { navigationActive: true }), null)
  assert.equal(cockpitScreenForProgress({
    domain: 'music',
    stage: 'music_paused',
  }), null)
})
