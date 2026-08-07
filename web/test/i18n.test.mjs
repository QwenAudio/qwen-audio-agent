import assert from 'node:assert/strict'
import test from 'node:test'
import { t } from '../src/i18n.js'

function withLang(lang, run) {
  const previous = globalThis.localStorage
  globalThis.localStorage = {
    getItem: key => (key === 'qwen-audio-lang' ? lang : null),
  }
  try {
    run()
  } finally {
    globalThis.localStorage = previous
  }
}

test('Chinese locales keep the original strings byte-identical', () => {
  for (const lang of ['zh', 'zh-CN', 'zh-Hans-CN', 'zh-TW']) {
    withLang(lang, () => {
      assert.equal(t('待命'), '待命')
      assert.equal(t('请求失败（{status}）', { status: 500 }), '请求失败（500）')
      assert.equal(
        t('等待{holder}释放语音', { holder: '桌面端' }),
        '等待桌面端释放语音',
      )
    })
  }
})

test('non-Chinese locales get English', () => {
  withLang('en-US', () => {
    assert.equal(t('待命'), 'Standby')
    assert.equal(t('开启语音'), 'Enable voice')
    assert.equal(t('请求失败（{status}）', { status: 500 }), 'Request failed (500)')
    assert.equal(
      t('等待{holder}释放语音', { holder: 'Desktop' }),
      'Waiting for Desktop to release voice',
    )
  })
})

test('unknown strings pass through unchanged', () => {
  withLang('en-US', () => {
    assert.equal(t('不在字典里的字符串'), '不在字典里的字符串')
    assert.equal(t('plain ascii'), 'plain ascii')
  })
})

test('localStorage override wins over navigator.language', () => {
  withLang('zh-CN', () => {
    assert.equal(t('开启语音'), '开启语音')
  })
  withLang('fr-FR', () => {
    assert.equal(t('开启语音'), 'Enable voice')
  })
})

test('falls back to navigator.language without an override', () => {
  const previous = globalThis.localStorage
  globalThis.localStorage = undefined
  try {
    const expected = /^zh(-|$)/i.test(globalThis.navigator?.language || 'zh-CN')
      ? '开启语音'
      : 'Enable voice'
    assert.equal(t('开启语音'), expected)
  } finally {
    globalThis.localStorage = previous
  }
})
