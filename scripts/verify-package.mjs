#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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

const jsonStart = result.stdout.lastIndexOf('[\n  {\n    "id":')
if (jsonStart < 0) {
  process.stderr.write(result.stdout)
  throw new Error('npm pack 输出中缺少成品 JSON')
}
const packages = JSON.parse(result.stdout.slice(jsonStart))
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
