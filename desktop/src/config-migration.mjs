import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

// 桌面版与 CLI（~/.config/qwaudio）使用相互独立的数据目录。桌面版默认
// 使用 Electron 应用数据目录；仅以下文件会在首次启动时从旧目录复制过来，
// 运行时状态（gateway.lock、state/、logs/ 等）各自重建、互不共享。
const MIGRATED_FILES = [
  'config.env',
  'state.env',
  'USER.md',
  'frontend-memory.json',
  'frontend-notes.json',
  'tasks.json',
]
const MIGRATION_MARKER = 'migrated-from.json'

export function resolveDesktopConfigDirectory({ env, userDataDirectory }) {
  if (env.QWAUDIO_CONFIG_DIR) return resolve(env.QWAUDIO_CONFIG_DIR)
  return resolve(userDataDirectory)
}

export function migrateLegacyConfig({ legacyDir, targetDir }) {
  if (!legacyDir || !targetDir) return { migrated: false, reason: 'missing-directories' }
  const legacy = resolve(legacyDir)
  const target = resolve(targetDir)
  if (legacy === target) return { migrated: false, reason: 'same-directory' }
  if (!existsSync(resolve(legacy, 'config.env'))) {
    return { migrated: false, reason: 'no-legacy-config' }
  }
  if (existsSync(resolve(target, 'config.env'))) {
    return { migrated: false, reason: 'target-configured' }
  }
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const copied = []
  for (const name of MIGRATED_FILES) {
    const source = resolve(legacy, name)
    if (!existsSync(source)) continue
    copyFileSync(source, resolve(target, name))
    copied.push(name)
  }
  writeFileSync(
    resolve(target, MIGRATION_MARKER),
    `${JSON.stringify({
      legacyDir: legacy,
      migratedAt: new Date().toISOString(),
      files: copied,
    }, null, 2)}\n`,
    'utf8',
  )
  return { migrated: true, copied, legacyDir: legacy }
}
