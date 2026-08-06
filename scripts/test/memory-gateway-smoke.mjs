#!/usr/bin/env node
// Full-process smoke test for the invisible-memory pipeline: boots the real
// Gateway (bootstrap wiring included), drives a text conversation over a real
// WebSocket session, disconnects, and verifies that the session-end extractor
// wrote inferred facts and audit records through the production code path.
//
//   node scripts/test/memory-gateway-smoke.mjs
//
// Requires a DASHSCOPE_API_KEY (environment or ~/.config/qwaudio/config.env,
// never printed). All state lives in a temporary QWAUDIO_CONFIG_DIR; the real
// user data directory is untouched.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

function resolveApiKey() {
  if (process.env.QWEN_AUDIO_MEMORY_API_KEY) return process.env.QWEN_AUDIO_MEMORY_API_KEY
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY
  const configPath = join(homedir(), '.config/qwaudio/config.env')
  if (!existsSync(configPath)) return ''
  return readFileSync(configPath, 'utf8')
    .match(/^DASHSCOPE_API_KEY=(.+)$/m)?.[1]?.trim() || ''
}

const apiKey = resolveApiKey()
if (!apiKey) {
  console.error('未找到 DASHSCOPE_API_KEY，无法运行网关冒烟测试。')
  process.exit(1)
}

const configDir = mkdtempSync(join(tmpdir(), 'qwenaudio-smoke-'))
const port = 31000 + Math.floor(Math.random() * 4000)
const root = resolve(import.meta.dirname, '../..')
const child = spawn(process.execPath, ['server/src/index.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    QWAUDIO_CONFIG_DIR: configDir,
    DASHSCOPE_API_KEY: apiKey,
    PORT: String(port),
    HOST: '127.0.0.1',
    AGENT_PROTOCOL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let gatewayLog = ''
child.stdout.on('data', chunk => { gatewayLog += chunk })
child.stderr.on('data', chunk => { gatewayLog += chunk })

const cleanup = code => {
  child.kill('SIGTERM')
  rmSync(configDir, { recursive: true, force: true })
  process.exit(code)
}

const waitFor = async (predicate, { timeoutMs, label }) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300))
  }
  console.error(`❌ 超时: ${label}`)
  console.error(gatewayLog.split('\n').slice(-15).join('\n'))
  cleanup(1)
}

try {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      return response.status > 0
    } catch {
      return false
    }
  }, { timeoutMs: 15000, label: 'Gateway 启动' })
  console.log('✅ Gateway 已启动（隔离数据目录）')

  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()
  console.log(`✅ /api/health: frontendMemory.ok=${health.frontendMemory?.ok}, persistence=${health.frontendMemory?.persistenceEnabled}`)

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/realtime?sessionId=smoke`)
  await new Promise((resolvePromise, rejectPromise) => {
    ws.once('open', resolvePromise)
    ws.once('error', rejectPromise)
  })
  console.log('✅ WebSocket 会话已建立')

  const lines = [
    '早上好',
    '我最近每天早上六点起来跑五公里，坚持三周了',
    '我把咖啡也戒了，现在只喝豆浆',
    '对了我下个月要去大阪出差一周',
    '就先这样吧',
  ]
  for (const text of lines) {
    ws.send(JSON.stringify({ type: 'text.message', text }))
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
  }
  console.log(`✅ 已通过 text.message 注入 ${lines.length} 条用户消息`)

  const closed = new Promise(resolvePromise => ws.once('close', resolvePromise))
  ws.close()
  await closed
  console.log('✅ 会话已断开，等待后台提取…')

  const memoryPath = join(configDir, 'frontend-memory.json')
  const auditPath = join(configDir, 'memory-audit.jsonl')
  await waitFor(
    () => existsSync(memoryPath),
    { timeoutMs: 20000, label: '提取器写入 frontend-memory.json' },
  )

  const stored = JSON.parse(readFileSync(memoryPath, 'utf8'))
  const entries = Object.values(stored.users || {}).flatMap(user => Object.values(user))
  const inferred = entries.filter(entry => entry.source === 'inferred')
  console.log(`✅ 提取写入 ${inferred.length} 条 inferred 记忆:`)
  inferred.forEach(entry => console.log(`   - [${entry.scope}] ${entry.value}`))

  const auditOps = existsSync(auditPath)
    ? readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line).op)
    : []
  console.log(`✅ 审计日志: ${auditOps.join(', ') || '(无)'}`)

  const pass = inferred.length >= 1
    && inferred.every(entry => entry.scope === 'facts')
    && auditOps.includes('write')
  console.log(pass ? '\n全链路冒烟通过' : '\n❌ 断言未通过')
  cleanup(pass ? 0 : 1)
} catch (error) {
  console.error('❌ 冒烟测试异常:', error.message)
  console.error(gatewayLog.split('\n').slice(-15).join('\n'))
  cleanup(1)
}
