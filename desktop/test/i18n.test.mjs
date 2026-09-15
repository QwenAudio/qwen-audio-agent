import assert from 'node:assert/strict'
import test from 'node:test'
import {
  desktopTranslator,
  effectiveDesktopLanguage,
  localizeDesktopError,
  normalizeDesktopLanguage,
} from '../src/i18n.mjs'

test('normalizes desktop language settings and follows the system locale', () => {
  assert.equal(normalizeDesktopLanguage('en-US'), 'en')
  assert.equal(normalizeDesktopLanguage('zh-TW'), 'zh-CN')
  assert.equal(normalizeDesktopLanguage('unknown'), 'auto')
  assert.equal(effectiveDesktopLanguage('auto', 'zh-CN'), 'zh-CN')
  assert.equal(effectiveDesktopLanguage('auto', 'en-US'), 'en')
  assert.equal(effectiveDesktopLanguage('en', 'zh-CN'), 'en')
})

test('localizes common main-process errors for the English settings UI', () => {
  const english = desktopTranslator('en')
  assert.equal(
    localizeDesktopError('目录不存在：C:\\node', english),
    'Directory does not exist: C:\\node',
  )
  assert.equal(
    localizeDesktopError('请先填写 DashScope API Key', english),
    'Enter a DashScope API Key first',
  )
  assert.match(
    localizeDesktopError(
      'DashScope Realtime 启动失败（模型 qwen3.5-omni-flash-realtime，音色 Cherry）：音色 Cherry 不支持模型 qwen3.5-omni-flash-realtime（Qwen3.5 Omni Flash Realtime）；可选音色：Tina、Serena',
      english,
    ),
    /voice Cherry is not supported by model qwen3\.5-omni-flash-realtime/,
  )
  assert.match(
    localizeDesktopError(
      'DashScope Realtime 启动失败（模型 qwen3.5-omni-flash-realtime，音色 Tina）：不支持的 Realtime 模型：future（DashScope Realtime）；可选模型：qwen3.5-omni-flash-realtime',
      english,
    ),
    /unsupported Realtime model future\. Available models:/,
  )
})

test('translates desktop settings text while preserving product names', () => {
  const english = desktopTranslator('en')
  assert.equal(english('设置'), 'Settings')
  assert.equal(english('后台 Agent'), 'Backend Agent')
  assert.equal(english('面壁智能'), 'ModelBest')
  assert.equal(english('应用程序'), 'Application')
  assert.equal(english('应用'), 'Apply')
  assert.equal(english('Qwen Audio'), 'Qwen Audio')
  assert.equal(desktopTranslator('zh-CN')('设置'), '设置')
})
