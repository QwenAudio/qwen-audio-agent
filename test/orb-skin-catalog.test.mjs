import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_ORB_SKINS,
  isBuiltinOrbSkin,
  normalizeOrbSkinId,
  ORB_SKIN_ID_PATTERN,
  resolveOrbSkinId,
} from '../shared/orb-skin-catalog.mjs'

test('exposes the builtin theme skins as first-class catalog entries', () => {
  assert.deepEqual(BUILTIN_ORB_SKINS.map(skin => skin.id), ['fluid', 'goo'])
  for (const skin of BUILTIN_ORB_SKINS) {
    assert.equal(skin.type, 'theme')
    assert.ok(skin.displayName)
    assert.match(skin.id, ORB_SKIN_ID_PATTERN)
  }
  assert.equal(isBuiltinOrbSkin('fluid'), true)
  assert.equal(isBuiltinOrbSkin('goo'), true)
  assert.equal(isBuiltinOrbSkin('firefly--lingxiaotian'), false)
  assert.equal(isBuiltinOrbSkin(''), false)
})

test('normalizes skin ids against the shared naming contract', () => {
  assert.equal(normalizeOrbSkinId('firefly--lingxiaotian'), 'firefly--lingxiaotian')
  assert.equal(normalizeOrbSkinId('  goo  '), 'goo')
  assert.equal(normalizeOrbSkinId('../escape'), '')
  assert.equal(normalizeOrbSkinId('bad id'), '')
  assert.equal(normalizeOrbSkinId('-leading-dash'), '')
  assert.equal(normalizeOrbSkinId(''), '')
  assert.equal(normalizeOrbSkinId(undefined), '')
  assert.equal(normalizeOrbSkinId('a'.repeat(65)), '')
})

test('resolves the effective skin through the unified fallback chain', () => {
  assert.equal(
    resolveOrbSkinId({ orbSkin: 'firefly--lingxiaotian', orbStyle: 'goo' }),
    'firefly--lingxiaotian',
  )
  assert.equal(resolveOrbSkinId({ orbSkin: '', orbStyle: 'goo' }), 'goo')
  assert.equal(resolveOrbSkinId({ orbSkin: '../bad', orbStyle: 'goo' }), 'goo')
  assert.equal(resolveOrbSkinId({}), 'fluid')
  assert.equal(resolveOrbSkinId(), 'fluid')
})
