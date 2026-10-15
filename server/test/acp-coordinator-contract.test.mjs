import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAcpCoordinatorInstruction } from '../src/backend/adapters/acp/coordinator-contract.mjs'
import {
  COORDINATOR_MCP_INSTRUCTIONS_MAX_BYTES,
  COORDINATOR_STABLE_INSTRUCTIONS,
} from '../src/backend/adapters/acp/coordinator-instructions.mjs'

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
  assert.match(prompt, /Use a project Session for work with a distinct goal that benefits from sustained, independent execution/u)
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

test('coordinator routes distinct goals that benefit from sustained independent execution', () => {
  assert.match(COORDINATOR_STABLE_INSTRUCTIONS, /Use a project Session for work with a distinct goal that benefits from sustained, independent execution/u)
  assert.match(COORDINATOR_STABLE_INSTRUCTIONS, /Handle brief operations, clarification, and result synthesis in this Session/u)
  assert.match(COORDINATOR_STABLE_INSTRUCTIONS, /The user does not need to request a separate Session/u)
  assert.doesNotMatch(COORDINATOR_STABLE_INSTRUCTIONS, /only when the user explicitly asks|never infer this from the objective|execute all other requests here/u)
})

test('coordinator routing respects backend Session capabilities without fixed tool names', () => {
  assert.match(COORDINATOR_STABLE_INSTRUCTIONS, /Use available capabilities/u)
  assert.doesNotMatch(COORDINATOR_STABLE_INSTRUCTIONS, /qwen_audio_agent_session_|sessions_spawn/u)
})

test('coordinator preserves continuity and releases its turn after delegating', () => {
  assert.match(COORDINATOR_STABLE_INSTRUCTIONS, /Continue related follow-ups in the original project Session rather than creating another/u)
  assert.match(COORDINATOR_STABLE_INSTRUCTIONS, /After a start or continue action succeeds, end the turn without querying, repeating, or claiming completion/u)
  assert.match(COORDINATOR_STABLE_INSTRUCTIONS, /Updates continue the referenced work using its history and completed actions/u)
  assert.match(COORDINATOR_STABLE_INSTRUCTIONS, /Recent conversation is reference context, not additional work/u)
})
