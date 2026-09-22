import assert from 'node:assert/strict'
import test from 'node:test'
import { setRuntimeLanguage, syncDocumentLanguage, t } from '../src/i18n.js'

function withLang(lang, run) {
  setRuntimeLanguage(lang)
  try {
    run()
  } finally {
    setRuntimeLanguage('')
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
    assert.equal(t('允许此任务'), 'Allow task')
    assert.equal(t('始终允许'), 'Always allow')
    assert.match(t('本会话后续权限请求自动允许'), /in this session$/)
  })
})

test('unknown strings pass through unchanged', () => {
  withLang('en-US', () => {
    assert.equal(t('不在字典里的字符串'), '不在字典里的字符串')
    assert.equal(t('plain ascii'), 'plain ascii')
  })
})

test('browser language wins over legacy storage, URL and desktop overrides remain explicit', tctx => {
  for (const [key, value] of Object.entries({
    navigator: { language: 'zh-CN', languages: ['en-US', 'zh-CN'] },
    localStorage: { getItem: () => 'zh-CN' },
    location: { search: '' },
    document: { documentElement: {} },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    tctx.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous)
      else delete globalThis[key]
    })
  }
  assert.equal(t('开启麦克风'), 'Enable microphone')
  syncDocumentLanguage()
  assert.equal(document.documentElement.lang, 'en')
  navigator.languages = ['zh-CN']
  syncDocumentLanguage()
  assert.equal(t('开启麦克风'), '开启麦克风')
  assert.equal(document.documentElement.lang, 'zh-CN')
  location.search = '?lang=en'
  assert.equal(t('开启麦克风'), 'Enable microphone')
  withLang('zh-CN', () => assert.equal(t('开启麦克风'), '开启麦克风'))
})
