import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAcpCoordinatorInstruction } from '../src/agent/acp-coordinator-contract.mjs'
import {
  COORDINATOR_MCP_INSTRUCTIONS_MAX_BYTES,
  COORDINATOR_STABLE_INSTRUCTIONS,
} from '../src/agent/acp-coordinator-instructions.mjs'

test('projects Gateway Work into one natural ACP task instruction', () => {
  const prompt = buildAcpCoordinatorInstruction({
    originalRequest: '继续改刚才那个页面，保留现有配色',
    objective: '继续修改此前讨论的首页',
    taskId: 'task_7',
    ownerId: 'owner-one',
    timeZone: 'Asia/Shanghai',
    workingDirectory: '/Users/me/codes/current-project',
    conversationContext: [
      { role: 'user', content: '我们在改首页' },
      { role: 'assistant', content: '标题已调整' },
    ],
    userMemories: [{
      scope: 'profile',
      content: '称呼用户为老大',
    }],
  })

  assert.match(prompt, /^继续修改此前讨论的首页/u)
  assert.match(prompt, /Start a new project Session only when the user explicitly asks/u)
  assert.doesNotMatch(prompt, /qwen_audio_agent_request|coordination\.v2/u)
  assert.doesNotMatch(prompt, /task_7|owner-one/u)
  assert.doesNotMatch(prompt, /继续改刚才那个页面|current-project|Asia\/Shanghai/u)
  assert.doesNotMatch(prompt, /我们在改首页|标题已调整|称呼用户为老大/u)
  assert.doesNotMatch(prompt, /"(?:request_id|task_id|work_id)"/u)
})

test('sends only the dynamic natural instruction when MCP supplies stable rules', () => {
  const prompt = buildAcpCoordinatorInstruction({
    originalRequest: '查询内存',
    objective: '查询当前电脑的真实内存容量',
    includeStableInstructions: false,
  })

  assert.equal(prompt, '查询当前电脑的真实内存容量')
  assert.doesNotMatch(prompt, /Project Session routing:|Return exactly one JSON object/u)
})

test('keeps frontend memory, history, and attachment metadata out of model text', () => {
  const prompt = buildAcpCoordinatorInstruction({
    originalRequest: '分析这张图片',
    objective: '分析用户直接附带的参考图片',
    conversationContext: [{ role: 'user', content: '秘密历史内容' }],
    userMemories: [{ scope: 'memory', content: '用户喜欢苹果' }],
    inputParts: [{
      type: 'file',
      mime: 'image/png',
      filename: 'reference.png',
      url: 'data:image/png;base64,aGVsbG8=',
    }],
    includeStableInstructions: false,
  })

  assert.match(prompt, /分析用户直接附带的参考图片/u)
  assert.doesNotMatch(
    prompt,
    /秘密历史内容|用户喜欢苹果|reference\.png|aGVsbG8=/u,
  )
})

test('keeps shared MCP coordinator instructions within the host budget', () => {
  assert.ok(
    Buffer.byteLength(COORDINATOR_STABLE_INSTRUCTIONS, 'utf8')
      <= COORDINATOR_MCP_INSTRUCTIONS_MAX_BYTES,
  )
  assert.doesNotMatch(
    COORDINATOR_STABLE_INSTRUCTIONS,
    /request_id|task_id|target_session_id|user_memory|recent_voice_context/u,
  )
  assert.match(
    COORDINATOR_STABLE_INSTRUCTIONS,
    /supported ACP ContentBlocks/u,
  )
  assert.doesNotMatch(
    COORDINATOR_STABLE_INSTRUCTIONS,
    /"state"|presentation|response contract|Return exactly one JSON object/u,
  )
})
