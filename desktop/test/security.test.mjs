import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BAILIAN_API_KEY_URL,
  desktopOrbUrl,
  getWindowsSupportUrl,
  isLoopbackUrl,
  isSafeExternalUrl,
  isSameOrigin,
  WINDOWS_MICROPHONE_SETTINGS_URL,
  validateAppUrl,
} from '../src/security.mjs'

test('allows local HTTP and remote HTTPS qwen-audio-agent origins', () => {
  assert.equal(validateAppUrl('http://127.0.0.1:3101'), 'http://127.0.0.1:3101')
  assert.equal(validateAppUrl('http://localhost:3101'), 'http://localhost:3101')
  assert.equal(validateAppUrl('https://voice.example.com/app'), 'https://voice.example.com')
  assert.throws(
    () => validateAppUrl('http://voice.example.com'),
    /must use HTTPS/,
  )
})

test('limits in-app navigation and external protocols', () => {
  assert.equal(
    isSameOrigin('http://127.0.0.1:3101/api/health', 'http://127.0.0.1:3101'),
    true,
  )
  assert.equal(
    isSameOrigin('https://example.com', 'http://127.0.0.1:3101'),
    false,
  )
  assert.equal(isSafeExternalUrl('https://example.com'), true)
  assert.equal(isSafeExternalUrl('file:///etc/passwd'), false)
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false)
})

test('distinguishes loopback gateway targets from remote ones', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:3101'), true)
  assert.equal(isLoopbackUrl('http://localhost:3101'), true)
  assert.equal(isLoopbackUrl('http://[::1]:3101'), true)
  assert.equal(isLoopbackUrl('https://voice.example.com'), false)
  assert.equal(isLoopbackUrl('not a url'), false)
})

test('builds a dedicated desktop orb URL without losing existing parameters', () => {
  assert.equal(
    desktopOrbUrl('http://127.0.0.1:3101/?channel=desktop', {
      orbStyle: 'goo',
    }),
    'http://127.0.0.1:3101/?channel=desktop&desktop=orb&orbStyle=goo',
  )
})

test('maps only fixed desktop support targets', () => {
  assert.equal(
    getWindowsSupportUrl('wsl-install'),
    'https://learn.microsoft.com/windows/wsl/install',
  )
  assert.equal(
    getWindowsSupportUrl('wsl-networking'),
    'https://learn.microsoft.com/windows/wsl/networking',
  )
  assert.equal(
    getWindowsSupportUrl('node-download'),
    'https://nodejs.org/en/download',
  )
  assert.equal(getWindowsSupportUrl('https://attacker.example'), null)
  assert.equal(getWindowsSupportUrl('__proto__'), null)
  assert.equal(
    WINDOWS_MICROPHONE_SETTINGS_URL,
    'ms-settings:privacy-microphone',
  )
  assert.equal(
    BAILIAN_API_KEY_URL,
    'https://bailian.console.aliyun.com/?tab=model#/api-key',
  )
})
