#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Parse `npm pack --dry-run --json` stdout into a list of package entries.
 *
 * npm <=10 emits an array:      [ { id, name, files, ... }, ... ]
 * npm >=11 emits an object map: { "<pkgName>": { id, name, files, ... }, ... }
 * Both shapes carry identical per-package fields, so we normalise to an array
 * and let callers treat them uniformly.
 *
 * @param {string} stdout Raw stdout from `npm pack --dry-run --json`.
 * @returns {Array<object>} Package entries (one per packed package).
 */
export function parsePackOutput(stdout) {
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new Error('npm pack 输出为空')
  }
  const jsonText = extractLastJsonBlock(trimmed)
  if (!jsonText) {
    throw new Error('无法解析 npm pack 输出的 JSON：未找到 JSON 块')
  }
  let parsed
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    throw new Error(`无法解析 npm pack 输出的 JSON：${error.message}`)
  }
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed)
  return entries.filter(Boolean)
}

// npm 10 在 `npm pack` 时会触发 `prepare` 生命周期脚本,构建工具(vite 等)的
// 日志会混入 stdout,污染 pack 的 JSON 输出(`--ignore-scripts` 不阻止 prepare)。
// 这里从 stdout 末尾按括号配对提取最后一个 JSON 块,以兼容前导/尾部噪声,同时
// 兼容 npm <=10 的数组与 npm >=11 的对象两种结构。
function extractLastJsonBlock(text) {
  let end = -1
  let endChar = ''
  for (let i = text.length - 1; i >= 0; i--) {
    const char = text[i]
    if (char === '}' || char === ']') {
      end = i
      endChar = char
      break
    }
  }
  if (end === -1) return null
  const startChar = endChar === '}' ? '{' : '['
  let depth = 1
  let start = -1
  for (let i = end - 1; i >= 0; i--) {
    const char = text[i]
    if (char === endChar) depth++
    else if (char === startChar) {
      depth--
      if (depth === 0) {
        start = i
        break
      }
    }
  }
  if (start === -1) return null
  return text.slice(start, end + 1)
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const npmExecutable = process.env.npm_execpath
  const command = npmExecutable ? process.execPath : (
    process.platform === 'win32' ? 'npm.cmd' : 'npm'
  )
  const args = [
    ...(npmExecutable ? [npmExecutable] : []),
    'pack',
    '--dry-run',
    '--json',
    '--ignore-scripts',
  ]
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    shell: !npmExecutable && process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    throw new Error('npm pack 自检失败')
  }

  let packages
  try {
    packages = parsePackOutput(result.stdout)
  } catch (error) {
    process.stderr.write(result.stdout)
    throw error
  }
  if (packages.length !== 1) throw new Error('npm pack 返回了意外的包数量')
  const files = new Set(packages[0].files.map(file => file.path))
  const required = [
    'cli/bin/qwenaudio.mjs',
    'config/openclaw/workspace/AGENTS.md',
    'config/hermes/workspace/AGENTS.md',
    'config/codebuddy/workspace/AGENTS.md',
    'config/codebuddy/workspace/.codebuddy/models.json',
    'config/codex/workspace/AGENTS.md',
    'config/claude/workspace/AGENTS.md',
    'config/acp/workspace/AGENTS.md',
    'config/opencode/workspace/AGENTS.md',
    'config/qoder/workspace/AGENTS.md',
    'config/kimi/workspace/AGENTS.md',
    'CONTRIBUTING.md',
    'docs/architecture.md',
    'docs/architecture-overview.png',
    'NOTICE',
    'PRIVACY.md',
    'SECURITY.md',
    'THIRD_PARTY_NOTICES.md',
    'scripts/audit-dependencies.mjs',
    'scripts/check-desktop-release-env.mjs',
    'scripts/codex-acp',
    'scripts/claude-code-acp',
    'scripts/install-global.mjs',
    'scripts/opencode-acp',
    'scripts/prepare-build.mjs',
    'server/src/agent/acp-backend-adapter.mjs',
    'server/src/agent/acp-process-client.mjs',
    'server/src/agent/acp-session-registry.mjs',
    'server/src/agent/acp-session-tools.mjs',
    'server/src/core/package-version.mjs',
    'server/src/index.mjs',
    'shared/runtime-environment.mjs',
    'tui/src/index.mjs',
    'web/dist/index.html',
  ]
  const missing = required.filter(file => !files.has(file))
  if (missing.length) {
    throw new Error(`npm 成品缺少必要文件：${missing.join(', ')}`)
  }
  const forbidden = [...files].filter(file => (
    file.includes('/__pycache__/')
    || file.endsWith('.pyc')
    || file.includes('/node_modules/')
    || file.startsWith('desktop/src/')
  ))
  if (forbidden.length) {
    throw new Error(`npm 成品包含不应发布的文件：${forbidden.join(', ')}`)
  }
  const brokenMarkdownLinks = []
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const content = readFileSync(resolve(root, file), 'utf8')
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].trim().replace(/^<|>$/g, '').split('#')[0]
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target)) continue
      const packagedTarget = posix.normalize(posix.join(posix.dirname(file), target))
      if (!files.has(packagedTarget)) {
        brokenMarkdownLinks.push(`${file} -> ${packagedTarget}`)
      }
    }
  }
  if (brokenMarkdownLinks.length) {
    throw new Error(
      `npm 成品包含失效的 Markdown 链接：${brokenMarkdownLinks.join(', ')}`,
    )
  }

  process.stdout.write(
    `npm 成品自检通过：${packages[0].filename}，共 ${files.size} 个文件。\n`,
  )
}
