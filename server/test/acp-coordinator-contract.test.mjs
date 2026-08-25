import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acpCoordinatorResponseState,
  buildAcpCoordinatorPrompt,
  parseAcpCoordinatorDecision,
} from '../src/agent/acp-coordinator-contract.mjs'
import { BACKEND_AGENT_INSTRUCTIONS } from '../src/agent/backend-agent-instructions.mjs'
import {
  COORDINATOR_MCP_INSTRUCTIONS_MAX_BYTES,
  COORDINATOR_STABLE_INSTRUCTIONS,
} from '../src/agent/acp-coordinator-instructions.mjs'

test('builds the ACP coordinator envelope from Work context', () => {
  const prompt = buildAcpCoordinatorPrompt({
    originalRequest: '继续改刚才那个页面',
    objective: '继续修改此前讨论的页面',
    workId: 'work-one',
    jobId: 'job_7',
    workingDirectory: '/Users/me/codes/current-project',
    conversationContext: [
      { role: 'user', content: '我们在改首页' },
      { role: 'assistant', content: '标题已调整' },
    ],
    userMemories: [{
      id: 'user_model',
      scope: 'profile',
      content: '# USER\n\n- 称呼：老大',
      editable: false,
    }],
  })
  assert.match(prompt, /继续改刚才那个页面/)
  assert.match(prompt, /继续修改此前讨论的页面/)
  assert.match(prompt, /我们在改首页/)
  assert.match(prompt, /qwen-audio-agent\.coordination\.v2/)
  assert.match(prompt, /job_7/)
  assert.match(prompt, /"job_id":"request_id"/)
  assert.doesNotMatch(prompt, /work_id|work-one/)
  assert.match(prompt, /current-project/)
  assert.match(prompt, /working_directory is the frontend directory/)
  assert.match(prompt, /称呼：老大/)
  assert.match(prompt, /Call session_start iff the user explicitly asks/)
  assert.match(prompt, /Use session_send to continue an existing independent task/)
  assert.match(prompt, /<user_preferences>/)
  assert.doesNotMatch(prompt, /owner_scope|voice_session_id|turn_id/)
})

test('omits empty optional ACP coordinator context sections', () => {
  const prompt = buildAcpCoordinatorPrompt({
    originalRequest: '你好',
    objective: '自然回应',
    jobId: 'job_9',
  })
  assert.doesNotMatch(prompt, /<user_memory>/)
  assert.doesNotMatch(prompt, /<recent_voice_context>/)
})

test('can omit stable instructions when coordinator MCP supplies them', () => {
  const prompt = buildAcpCoordinatorPrompt({
    originalRequest: '查询内存',
    objective: '查询当前电脑内存',
    jobId: 'job_10',
    includeStableInstructions: false,
  })
  assert.match(prompt, /qwen_audio_agent_request/)
  assert.match(prompt, /查询当前电脑内存/)
  assert.doesNotMatch(prompt, /Session routing:/)
  assert.doesNotMatch(prompt, /Return exactly one JSON object/)
})

test('keeps Session routing out of generic backend instructions', () => {
  assert.doesNotMatch(BACKEND_AGENT_INSTRUCTIONS, /new independent work/)
  assert.doesNotMatch(BACKEND_AGENT_INSTRUCTIONS, /session_(?:start|send|status)/)
})

test('keeps shared MCP coordinator instructions within the host budget', () => {
  assert.ok(
    Buffer.byteLength(COORDINATOR_STABLE_INSTRUCTIONS, 'utf8')
      <= COORDINATOR_MCP_INSTRUCTIONS_MAX_BYTES,
  )
})

test('separates user preferences from durable memory', () => {
  const prompt = buildAcpCoordinatorPrompt({
    originalRequest: '帮我写个函数',
    objective: '编写一个函数',
    workId: 'work-rules',
    userMemories: [
      { scope: 'rules', content: '代码注释一律用中文', editable: true },
      { scope: 'memory', content: '用户喜欢苹果', editable: true },
    ],
  })
  assert.match(prompt, /<user_preferences>\n- 代码注释一律用中文/)
  const memories = prompt.match(/<user_memory>([\s\S]*?)<\/user_memory>/)?.[1] || ''
  assert.doesNotMatch(memories, /代码注释一律用中文/)
  assert.match(memories, /用户喜欢苹果/)
})

test('includes attachment metadata without embedding binary data in JSON', () => {
  const prompt = buildAcpCoordinatorPrompt({
    originalRequest: '分析这张图片',
    objective: '分析参考图片',
    jobId: 'job-image',
    inputParts: [{
      type: 'file',
      mime: 'image/png',
      filename: 'reference.png',
      url: 'data:image/png;base64,aGVsbG8=',
    }],
  })
  assert.match(prompt, /"attachments"/)
  assert.match(prompt, /reference\.png/)
  assert.doesNotMatch(prompt, /aGVsbG8=/)
})

test('normalizes final coordinator presentation and encoded JSON', () => {
  const payload = {
    job_id: 'job-one',
    state: 'completed',
    mode: 'respond',
    presentation: {
      speech: '页面已经修改并通过检查。',
      inline: { title: '修改说明', format: 'markdown', content: '## 完成' },
    },
  }
  const direct = parseAcpCoordinatorDecision(JSON.stringify(payload))
  const encoded = parseAcpCoordinatorDecision(JSON.stringify(JSON.stringify(payload)))
  assert.equal(direct.presentation.inline.content, '## 完成')
  assert.equal(encoded.presentation.speech, '页面已经修改并通过检查。')
  assert.equal(acpCoordinatorResponseState(JSON.stringify(payload)), 'completed')
})
