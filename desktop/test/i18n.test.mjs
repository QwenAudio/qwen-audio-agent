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
})

test('translates desktop settings text while preserving product names', () => {
  const english = desktopTranslator('en')
  assert.equal(english('设置'), 'Settings')
  assert.equal(english('后台 Agent'), 'Backend Agent')
  assert.equal(english('应用程序'), 'Application')
  assert.equal(english('应用'), 'Apply')
  assert.equal(english('Qwen Audio'), 'Qwen Audio')
  assert.equal(desktopTranslator('zh-CN')('设置'), '设置')
})
