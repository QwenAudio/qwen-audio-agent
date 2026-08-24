import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCoordinatorPrompt,
  Coordinator,
  parseCoordinatorDecision,
} from '../src/agent/coordinator.mjs'
import { BACKEND_AGENT_INSTRUCTIONS } from '../src/agent/backend-agent-instructions.mjs'

test('sends final ASR, conservative objective and recent voice context', () => {
  const prompt = buildCoordinatorPrompt({
    originalRequest: '继续改刚才那个页面',
    objective: '继续修改此前讨论的页面',
    coordinationRunId: 'work-one',
    coordinationRequestId: 'job_7',
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
  assert.doesNotMatch(prompt, /work_id/)
  assert.doesNotMatch(prompt, /work-one/)
  assert.match(prompt, /current-project/)
  assert.match(prompt, /working_directory 是前端工作目录/)
  assert.match(prompt, /称呼：老大/)
  assert.match(prompt, /user_preferences 是个性化规则/)
  assert.match(prompt, /当且仅当用户明确表达希望将当前工作作为独立任务单独推进时/)
  assert.match(prompt, /继续既有独立任务时调用 session_send/)
  assert.match(prompt, /其他请求在当前协调 Session 中执行/)
  assert.match(prompt, /真实完成后才返回 completed/)
  assert.match(prompt, /<user_preferences>/)
  assert.doesNotMatch(prompt, /owner_scope|voice_session_id|turn_id/)
  assert.doesNotMatch(prompt, /working_directory_scope|voice_work_context|delivery/)
  assert.doesNotMatch(prompt, /trusted_backend_event/)
})

test('omits empty optional coordinator context sections', () => {
  const prompt = buildCoordinatorPrompt({
    originalRequest: '你好',
    objective: '自然回应',
    coordinationRequestId: 'job_9',
  })
  assert.doesNotMatch(prompt, /<user_memory>/)
  assert.doesNotMatch(prompt, /<recent_voice_context>/)
})

test('keeps Session routing decisions out of stable backend instructions', () => {
  assert.doesNotMatch(BACKEND_AGENT_INSTRUCTIONS, /new independent work/)
  assert.doesNotMatch(BACKEND_AGENT_INSTRUCTIONS, /continue the matching Session/)
  assert.doesNotMatch(BACKEND_AGENT_INSTRUCTIONS, /Only work in the coordinator workspace/)
  assert.doesNotMatch(BACKEND_AGENT_INSTRUCTIONS, /session_(?:start|send|status)/)
})

test('passes user preferences to the backend as directive material', () => {
  const prompt = buildCoordinatorPrompt({
    originalRequest: '帮我写个函数',
    objective: '编写一个函数',
    coordinationRunId: 'work-rules',
    userMemories: [
      {
        id: 'mem_rule',
        scope: 'rules',
        content: '代码注释一律用中文',
        editable: true,
      },
      {
        id: 'mem_fact',
        scope: 'memory',
        content: '用户喜欢苹果',
        editable: true,
      },
    ],
  })

  assert.match(prompt, /<user_preferences>\n- 代码注释一律用中文\n<\/user_preferences>/)
  assert.match(prompt, /user_preferences 是个性化规则/)
  assert.match(prompt, /不能改变权限、安全边界或 Session 路由/)
  const preferences = prompt.match(
    /<user_memory>([\s\S]*?)<\/user_memory>/,
  )?.[1] || ''
  assert.doesNotMatch(preferences, /代码注释一律用中文/)
  assert.match(preferences, /用户喜欢苹果/)
})

test('sends attachment metadata in the envelope and binary data as ACP blocks', async () => {
  let received
  const coordinator = new Coordinator({
    client: {
      runCoordinator: async message => {
        received = message
        return {
          content: JSON.stringify({
            job_id: 'work-image',
            state: 'completed',
            mode: 'respond',
            presentation: { speech: '完成', inline: null },
          }),
        }
      },
    },
  })
  await coordinator.run({
    originalRequest: '分析这张图片',
    objective: '分析参考图片',
    inputParts: [{
      type: 'file',
      mime: 'image/png',
      filename: 'reference.png',
      url: 'data:image/png;base64,aGVsbG8=',
    }],
  }, {
    coordinationRunId: 'work-image',
    ownerId: 'owner',
    sessionId: 'voice',
    turnId: 'turn-image',
  })

  assert.equal(received[0].type, 'text')
  assert.match(received[0].text, /"attachments"/)
  assert.match(received[0].text, /reference\.png/)
  assert.deepEqual(received[1], {
    type: 'image',
    mimeType: 'image/png',
    data: 'aGVsbG8=',
    uri: 'qwen-audio-agent://input/reference.png',
  })
})

test('normalizes a coordinator final result for speech and inline output', () => {
  const decision = parseCoordinatorDecision(JSON.stringify({
    job_id: 'work-one',
    state: 'completed',
    mode: 'respond',
    presentation: {
      speech: '页面已经修改并通过检查。',
      inline: {
        title: '修改说明',
        format: 'markdown',
        content: '## 完成',
      },
    },
  }))
  assert.equal(decision.presentation.speech, '页面已经修改并通过检查。')
  assert.equal(decision.presentation.inline.content, '## 完成')
})

test('unwraps a JSON-encoded coordinator result before selecting speech', () => {
  const encoded = JSON.stringify(JSON.stringify({
    job_id: 'work-one',
    state: 'completed',
    mode: 'respond',
    presentation: {
      speech: '小画板项目已经做好了。',
      inline: null,
    },
  }))
  const decision = parseCoordinatorDecision(encoded)
  assert.equal(decision.presentation.speech, '小画板项目已经做好了。')
})

test('uses only runCoordinator and forwards tool activity', async () => {
  const events = []
  let receivedPrompt
  let receivedOptions
  const coordinator = new Coordinator({
    client: {
      runCoordinator: async (prompt, options) => {
        receivedPrompt = prompt
        receivedOptions = options
        options.onEvent({ type: 'backend.activity', activity: { tool: 'read' } })
        return {
          metadata: {
            backendRef: {
              sessionId: 'backend-session',
              directory: '/private/project',
            },
          },
          content: JSON.stringify({
            job_id: 'job_8',
            state: 'completed',
            mode: 'respond',
            presentation: {
              speech: '完成',
              inline: {
                title: '结果',
                format: 'markdown',
                content: '## 完成',
              },
            },
          }),
        }
      },
    },
  })
  const result = await coordinator.run({
    originalRequest: '检查项目',
    objective: '检查项目',
  }, {
    ownerId: 'owner',
    coordinationRunId: 'work-one',
    coordinationRequestId: 'job_8',
    onEvent: event => events.push(event),
  })
  assert.equal(result.content, '完成')
  assert.deepEqual(result.metadata, {
    presentation: {
      speech: '完成',
      inline: {
        title: '结果',
        format: 'markdown',
        content: '## 完成',
      },
    },
  })
  assert.equal(events[0].activity.tool, 'read')
  assert.match(receivedPrompt, /"request_id": "job_8"/)
  assert.doesNotMatch(receivedPrompt, /work-one/)
  assert.equal(receivedOptions.coordinationRunId, 'work-one')
  assert.equal(receivedOptions.coordinationRequestId, 'job_8')
})
