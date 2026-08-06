#!/usr/bin/env node
// End-to-end check of the session-end memory extraction pipeline against the
// real DashScope endpoint (issue #92 P0). Not part of `npm test`: it needs
// network access and a DASHSCOPE_API_KEY, and is run manually:
//
//   node scripts/test/memory-extractor-e2e.mjs
//
// The key is read from the environment or ~/.config/qwaudio/config.env and is
// never printed. Every scenario uses temporary stores; nothing touches the
// real user data directory.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { ConversationSync } from '../../server/src/conversation/conversation-sync.mjs'
import { FrontendMemoryStore } from '../../server/src/conversation/frontend-memory.mjs'
import { MemoryAudit } from '../../server/src/conversation/memory-audit.mjs'
import {
  MemoryExtractor,
  createExtractorLlmCall,
} from '../../server/src/conversation/memory-extractor.mjs'

function resolveApiKey() {
  if (process.env.QWEN_AUDIO_MEMORY_API_KEY) return process.env.QWEN_AUDIO_MEMORY_API_KEY
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY
  const configPath = join(homedir(), '.config/qwaudio/config.env')
  if (!existsSync(configPath)) return ''
  const match = readFileSync(configPath, 'utf8')
    .match(/^DASHSCOPE_API_KEY=(.+)$/m)
  return match?.[1]?.trim() || ''
}

function session(turns) {
  const sync = new ConversationSync()
  turns.forEach(([role, content], index) => {
    sync.record({
      ownerId: 'owner-e2e',
      sessionId: 'main',
      id: `${role}-${index}`,
      role,
      content,
      source: role === 'user' ? 'voice-user' : 'realtime-direct',
    })
  })
  return sync
}

const SCENARIOS = [
  {
    name: '陈述型个人事实应沉淀（stated → facts, source=inferred）',
    turns: [
      ['user', '早上好'],
      ['assistant', '早上好，今天有什么安排吗'],
      ['user', '我最近每天早上六点起来跑五公里'],
      ['assistant', '很自律，坚持得怎么样'],
      ['user', '坚持三周了，我还把咖啡戒了，现在只喝豆浆'],
      ['assistant', '不错的改变'],
      ['user', '对了我下个月要去大阪出差一周'],
      ['assistant', '需要我到时候提醒你准备行李吗'],
    ],
    expect: store => {
      const memories = store.list('owner-e2e', { limit: 64 })
      const contents = memories.map(memory => memory.content).join(' / ')
      return {
        pass: memories.length >= 1
          && memories.length <= 5
          && memories.every(memory => memory.source === 'inferred' && memory.scope === 'facts')
          && /跑|晨跑|运动/.test(contents),
        detail: `${memories.length} 条: ${contents}`,
      }
    },
  },
  {
    name: '敏感信息绝不入库（密码/密钥双闸）',
    turns: [
      ['user', '帮我记一下事情'],
      ['assistant', '你说'],
      ['user', '我的服务器密码是 hunter2，API Key 是 sk-abc123def456ghi789'],
      ['assistant', '涉及密码和密钥我不能保存'],
      ['user', '好吧，那记住我喜欢吃辣'],
      ['assistant', '记住了'],
    ],
    expect: store => {
      const memories = store.list('owner-e2e', { limit: 64 })
      const contents = memories.map(memory => memory.content).join(' / ')
      return {
        pass: !/hunter2|sk-|密码|API Key/i.test(contents),
        detail: `${memories.length} 条: ${contents || '(空)'}`,
      }
    },
  },
  {
    name: '纯任务型对话零沉淀（宁漏勿错）',
    turns: [
      ['user', '帮我查一下明天北京的天气'],
      ['assistant', '好的，正在查'],
      ['user', '再帮我看看后台那个构建任务跑完没有'],
      ['assistant', '构建还在进行中'],
      ['user', '好的完成了叫我'],
      ['assistant', '没问题'],
      ['user', '对了顺便把日志文件清一下'],
      ['assistant', '已安排'],
    ],
    expect: store => {
      const memories = store.list('owner-e2e', { limit: 64 })
      return {
        pass: memories.length === 0,
        detail: memories.length
          ? `多余写入: ${memories.map(memory => memory.content).join(' / ')}`
          : '零写入',
      }
    },
  },
  {
    name: '已有记忆去重（不重复写入）',
    seed: ['用户每天早上六点跑五公里'],
    turns: [
      ['user', '我今天照常六点起来跑了五公里'],
      ['assistant', '坚持得真好'],
      ['user', '跑完顺便买了菜'],
      ['assistant', '一举两得'],
      ['user', '我每天早上都跑五公里这事你记得吧'],
      ['assistant', '记得，你坚持很久了'],
    ],
    expect: store => {
      const memories = store.list('owner-e2e', { limit: 64 })
      const running = memories.filter(memory => /跑/.test(memory.content))
      return {
        pass: running.length <= 1,
        detail: `跑步相关 ${running.length} 条: ${memories.map(memory => memory.content).join(' / ')}`,
      }
    },
  },
]

const apiKey = resolveApiKey()
if (!apiKey) {
  console.error('未找到 DASHSCOPE_API_KEY（环境变量或 ~/.config/qwaudio/config.env），无法运行端到端测试。')
  process.exit(1)
}
const model = process.env.QWEN_AUDIO_MEMORY_MODEL || 'qwen-flash'
console.log(`模型: ${model}  端点: DashScope compatible-mode\n`)

let failures = 0
for (const scenario of SCENARIOS) {
  const directory = mkdtempSync(join(tmpdir(), 'qwenaudio-memory-e2e-'))
  const store = new FrontendMemoryStore({
    filePath: join(directory, 'frontend-memory.json'),
  })
  for (const content of scenario.seed || []) {
    store.remember('owner-e2e', content, { scope: 'facts', source: 'inferred' })
  }
  const auditPath = join(directory, 'memory-audit.jsonl')
  const extractor = new MemoryExtractor({
    memoryStore: store,
    conversationSync: session(scenario.turns),
    audit: new MemoryAudit({ filePath: auditPath }),
    llmCall: createExtractorLlmCall({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey,
      model,
      timeoutMs: 30_000,
    }),
    logger: { warn: (...args) => console.warn('  [warn]', ...args), debug: () => {} },
    minUserMessages: 3,
  })

  const startedAt = Date.now()
  await extractor.maybeRun({ ownerId: 'owner-e2e', sessionId: 'main' })
  const elapsed = Date.now() - startedAt
  const verdict = scenario.expect(store)
  const auditLines = existsSync(auditPath)
    ? readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean)
    : []
  console.log(`${verdict.pass ? '✅' : '❌'} ${scenario.name}（${elapsed}ms）`)
  console.log(`   结果: ${verdict.detail}`)
  console.log(`   审计: ${auditLines.map(line => {
    const event = JSON.parse(line)
    return `${event.op}${event.reason ? `(${event.reason})` : ''}`
  }).join(', ') || '(无)'}\n`)
  if (!verdict.pass) failures += 1
  rmSync(directory, { recursive: true, force: true })
}

console.log(failures ? `${failures} 个场景未达预期` : '全部场景符合预期')
process.exit(failures ? 1 : 0)
