import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyDesktopClientSettings,
  initialDesktopClientSettings,
} from '../src/desktop-client-settings.js'

test('desktop client settings initialize from the desktop URL', () => {
  assert.deepEqual(initialDesktopClientSettings(
    '?orbSkin=firefly&autoHideSeconds=300&wakeWordEnabled=true&lang=en',
  ), {
    orbSkinId: 'firefly',
    autoHideSeconds: 300,
    wakeWordEnabled: true,
    language: 'en',
  })
})

test('desktop client settings hot-apply without replacing unrelated state', () => {
  const current = {
    orbSkinId: 'fluid',
    autoHideSeconds: 60,
    wakeWordEnabled: false,
    language: 'zh-CN',
  }

  assert.deepEqual(applyDesktopClientSettings(current, {
    orbSkin: 'firefly',
    autoHideSeconds: 120,
    language: 'en',
  }), {
    orbSkinId: 'firefly',
    autoHideSeconds: 120,
    wakeWordEnabled: false,
    language: 'en',
  })
})
