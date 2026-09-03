import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  helpText,
  parseArguments,
  selectCancellableTask,
  taskLine,
  websocketUrl,
} from '../src/text-cli.mjs'
import { isExitCommand } from '../src/terminal-commands.mjs'

test('parseArguments 默认值与覆盖', () => {
  const defaults = parseArguments([])
  assert.equal(defaults.url, process.env.QWEN_AUDIO_AGENT_URL || 'http://127.0.0.1:3101')
  assert.equal(defaults.sessionId, process.env.QWEN_AUDIO_AGENT_SESSION_ID || 'cli-main')

  const custom = parseArguments(['--url', 'http://host:9/', '--session', 's1'])
  assert.equal(custom.url, 'http://host:9')
  assert.equal(custom.sessionId, 's1')
  assert.equal(parseArguments([], {
    QWEN_AUDIO_AGENT_ACCESS_TOKEN: 'remote-token',
  }).accessToken, 'remote-token')

  assert.equal(parseArguments(['--help']).help, true)
})

test('websocketUrl 协议与参数', () => {
  assert.equal(
    websocketUrl('http://127.0.0.1:3101', 'cli-main'),
    'ws://127.0.0.1:3101/api/realtime?sessionId=cli-main',
  )
  assert.ok(websocketUrl('https://example.com', 'a b').startsWith('wss://'))
  assert.ok(websocketUrl('https://example.com', 'a b').includes('sessionId=a+b'))
})

test('taskLine 摘要格式', () => {
  const line = taskLine({
    id: 'job-1', status: 'running',
    elapsedMs: 4200, objective: '写一个页面',
  })
  assert.ok(line.includes('job-1'))
  assert.ok(line.includes('running'))
  assert.ok(line.includes('4s'))
  assert.ok(line.includes('写一个页面'))
})

test('helpText 覆盖全部命令', () => {
  const text = helpText()
  for (const command of ['/tasks', '/cancel', '/help', '/exit']) {
    assert.ok(text.includes(command), command)
  }
  assert.doesNotMatch(text, /\/bg/)
})

test('退出命令支持 /exit 并保留原有别名', () => {
  for (const command of ['/exit', '/quit', '/q']) {
    assert.equal(isExitCommand(command), true)
  }
})

test('取消命令识别 queued 和 running 任务', () => {
  const tasks = [
    { id: 'done', status: 'completed' },
    { id: 'queued', status: 'queued' },
    { id: 'running', status: 'running' },
  ]
  assert.equal(selectCancellableTask(tasks).id, 'queued')
  assert.equal(selectCancellableTask(tasks, 'running').id, 'running')
  assert.equal(selectCancellableTask(tasks, 'missing'), null)
})
