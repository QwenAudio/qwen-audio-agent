import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(new URL('../..', import.meta.url).pathname)

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  })
}

test('builds an inert current-architecture Bridge and InputMethodKit bundle', () => {
  const output = mkdtempSync(join(tmpdir(), 'qwen-native-input-build-'))
  try {
    const build = run(process.execPath, [
      'scripts/build-native-input.mjs',
      '--configuration', 'Debug',
      '--arch', 'current',
      '--output', output,
    ])
    assert.equal(build.status, 0, build.stderr || build.stdout)

    const bridge = join(output, 'QwenInputBridge')
    const inputMethod = join(output, 'Qwen Input.app')
    const inputMethodInfo = join(inputMethod, 'Contents', 'Info.plist')
    assert.equal(existsSync(bridge), true, 'Bridge artifact is missing')
    assert.equal(existsSync(inputMethodInfo), true, 'Input method bundle is missing')

    const bundleID = run('plutil', [
      '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', inputMethodInfo,
    ])
    assert.equal(bundleID.status, 0, bundleID.stderr)
    assert.equal(bundleID.stdout.trim(), 'ai.qwenaudio.agent.inputmethod')

    const inputType = run('plutil', [
      '-extract', 'InputMethodType', 'raw', '-o', '-', inputMethodInfo,
    ])
    assert.equal(inputType.status, 0, inputType.stderr)
    assert.equal(inputType.stdout.trim(), 'Palette')

    const bridgeArchitectures = run('lipo', ['-archs', bridge])
    assert.equal(bridgeArchitectures.status, 0, bridgeArchitectures.stderr)
    assert.match(bridgeArchitectures.stdout, new RegExp(process.arch === 'arm64'
      ? '\\barm64\\b'
      : '\\bx86_64\\b'))

    const bridgeStrings = run('strings', [bridge])
    assert.equal(bridgeStrings.status, 0, bridgeStrings.stderr)
    assert.doesNotMatch(bridgeStrings.stdout, /QWEN_AUDIO_(?:API_KEY|IDENTITY_SECRET)/)
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
