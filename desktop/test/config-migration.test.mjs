import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  migrateLegacyConfig,
  resolveDesktopConfigDirectory,
} from '../src/config-migration.mjs'

function withDirectories(fn) {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-config-migration-'))
  const legacyDir = join(root, 'legacy')
  const targetDir = join(root, 'target')
  try {
    return fn({ legacyDir, targetDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function seedLegacy(legacyDir) {
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'config.env'), 'DASHSCOPE_API_KEY=sk-legacy\n', 'utf8')
  writeFileSync(join(legacyDir, 'state.env'), 'QWEN_AUDIO_AGENT_AUTH_SECRET=secret\n', 'utf8')
  writeFileSync(join(legacyDir, 'USER.md'), '# USER\n', 'utf8')
  writeFileSync(join(legacyDir, 'gateway.lock'), '{}\n', 'utf8')
}

test('prefers QWAUDIO_CONFIG_DIR over the Electron userData directory', () => {
  const override = '/tmp/qwaudio-profile'
  assert.equal(
    resolveDesktopConfigDirectory({
      env: { QWAUDIO_CONFIG_DIR: override },
      userDataDirectory: '/home/user/.config/Qwen Audio Agent',
    }),
    resolve(override),
  )
})

test('falls back to the Electron userData directory without override', () => {
  assert.equal(
    resolveDesktopConfigDirectory({
      env: {},
      userDataDirectory: '/home/user/.config/Qwen Audio Agent',
    }),
    resolve('/home/user/.config/Qwen Audio Agent'),
  )
})

test('copies user config files from the legacy CLI directory once', () => {
  withDirectories(({ legacyDir, targetDir }) => {
    seedLegacy(legacyDir)
    const result = migrateLegacyConfig({ legacyDir, targetDir })
    assert.equal(result.migrated, true)
    assert.deepEqual(result.copied, ['config.env', 'state.env', 'USER.md'])
    for (const name of ['config.env', 'state.env', 'USER.md']) {
      assert.ok(existsSync(join(targetDir, name)))
    }
    // 运行时状态不迁移，CLI 侧原件保留
    assert.equal(existsSync(join(targetDir, 'gateway.lock')), false)
    assert.ok(existsSync(join(legacyDir, 'config.env')))
    assert.equal(
      readFileSync(join(targetDir, 'config.env'), 'utf8'),
      'DASHSCOPE_API_KEY=sk-legacy\n',
    )
    const marker = JSON.parse(readFileSync(join(targetDir, 'migrated-from.json'), 'utf8'))
    assert.equal(marker.legacyDir, resolve(legacyDir))
    assert.deepEqual(marker.files, ['config.env', 'state.env', 'USER.md'])
    // 重复执行保持幂等，不覆盖已有配置
    const again = migrateLegacyConfig({ legacyDir, targetDir })
    assert.equal(again.migrated, false)
    assert.equal(again.reason, 'target-configured')
  })
})

test('skips migration when no legacy config exists', () => {
  withDirectories(({ legacyDir, targetDir }) => {
    const missing = migrateLegacyConfig({ legacyDir, targetDir })
    assert.equal(missing.migrated, false)
    assert.equal(missing.reason, 'no-legacy-config')
    assert.equal(existsSync(join(targetDir, 'migrated-from.json')), false)
  })
})

test('skips migration when legacy and target are the same directory', () => {
  withDirectories(({ legacyDir }) => {
    seedLegacy(legacyDir)
    const result = migrateLegacyConfig({ legacyDir, targetDir: legacyDir })
    assert.equal(result.migrated, false)
    assert.equal(result.reason, 'same-directory')
  })
})
