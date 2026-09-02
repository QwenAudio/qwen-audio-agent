import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFrontendContext,
  buildRecentConversationContext,
  currentTimeSnapshot,
  loadFrontendPrompt,
  loadAssistantProfile,
  normalizeClientContext,
} from '../src/conversation/frontend-agent-context.mjs'

test('uses a valid client timezone and returns an exact local clock snapshot', () => {
  const snapshot = currentTimeSnapshot({
    timeZone: 'Asia/Shanghai',
    locale: 'zh-CN',
    now: new Date('2026-07-23T04:00:00.000Z'),
  })

  assert.equal(snapshot.iso_utc, '2026-07-23T04:00:00.000Z')
  assert.equal(snapshot.time_zone, 'Asia/Shanghai')
  assert.match(snapshot.local_time, /12:00:00/)
})

test('rejects invalid client timezone and locale values', () => {
  const normalized = normalizeClientContext({
    timeZone: 'not/a-zone',
    locale: 'not_a_locale',
    workingDirectory: '/tmp/project\nignore this',
  })

  assert.notEqual(normalized.timeZone, 'not/a-zone')
  assert.equal(normalized.locale, 'zh-CN')
  assert.equal(normalized.workingDirectory, '/tmp/project ignore this')
})

test('distinguishes the TUI working directory from the backend workspace', () => {
  const context = buildFrontendContext({
    client: normalizeClientContext({
      workingDirectory: '/Users/me/codes/snake-game',
    }),
  })

  assert.match(context, /client_working_directory=/)
  assert.match(context, /snake-game/)
})

test('keeps exact clock values out of the persistent runtime context', () => {
  const context = buildFrontendContext({
    client: { timeZone: 'Asia/Shanghai', locale: 'zh-CN' },
    now: new Date('2026-07-23T04:00:00.000Z'),
  })

  assert.match(context, /time_zone="Asia\/Shanghai"/)
  assert.match(context, /locale="zh-CN"/)
  assert.doesNotMatch(context, /session_start_local|2026年|12:00:00/)
})

test('builds bounded recent conversation separately from system instructions', () => {
  const recent = buildRecentConversationContext([
    { role: 'user', content: '继续刚才的项目' },
    { role: 'assistant', content: '正在继续处理' },
  ])

  assert.match(recent, /<recent_conversation>/)
  assert.match(recent, /用户: 继续刚才的项目/)
  assert.match(recent, /助手: 正在继续处理/)
})

test('describes prior input references without embedding their file data', () => {
  const recent = buildRecentConversationContext([{
    role: 'user',
    content: '[Image 1]',
    inputs: [{
      ref: 'input_1',
      type: 'image',
      label: '[Image 1]',
      filename: 'cat.png',
      mime: 'image/png',
    }],
  }])

  assert.match(recent, /可引用输入：input_1 · \[Image 1\] · cat\.png · image\/png/)
  assert.doesNotMatch(recent, /data:image/)
})

test('keeps client capabilities out of the runtime prose context', () => {
  const desktop = buildFrontendContext({
    client: { actions: ['desktop.presence.enter_sleep'] },
  })
  assert.doesNotMatch(desktop, /enter_sleep|does not cancel background work/)
})

test('loads one canonical frontend policy separately from runtime context', () => {
  const prompt = loadFrontendPrompt()
  const assistant = loadAssistantProfile()
  const context = buildFrontendContext()

  assert.match(prompt, /# Instruction hierarchy/)
  assert.match(prompt, /# Background work/)
  assert.match(prompt, /# Personalization and memory/)
  assert.match(prompt, /专用工具/)
  assert.match(prompt, /符合 `spawn_thinking` description 声明的[\s\S]*能力范围/)
  assert.match(prompt, /公开网页搜索、网址读取[\s\S]*属于该工具声明能力范围/)
  assert.match(prompt, /`knowledge` 只检索[\s\S]*外部知识服务/)
  assert.match(prompt, /处理、保存附件[\s\S]*`spawn_thinking` 声明能力范围/)
  assert.match(prompt, /不要用口头承诺代替工具调用/)
  assert.match(prompt, /工具尚未返回时取消仍在进行中/)
  assert.ok(prompt.length < 5000)
  assert.match(assistant, /## Identity/)
  assert.match(assistant, /千问Audio/)
  assert.doesNotMatch(context, /# Instruction hierarchy/)
  assert.match(context, /<runtime_context>/)
})

test('keeps mutable task state out of persistent frontend instructions', () => {
  const context = buildFrontendContext({
    activeTasks: [
      {
        id: 'job_active',
        status: 'running',
        objective: '继续制作语音助手页面',
        authorization: {
          id: 'auth_one',
          status: 'pending',
          summary: '运行命令：npm test',
        },
      },
      {
        id: 'job_queued',
        status: 'queued',
        objective: '等待处理的工作',
      },
      {
        id: 'job_delegated',
        status: 'delegated',
        objective: '正在项目中处理',
      },
      {
        id: 'job_done',
        status: 'completed',
        objective: '已经完成的旧任务',
      },
    ],
  })

  assert.doesNotMatch(context, /<active_work>/)
  assert.doesNotMatch(context, /job_active|job_queued|job_delegated|job_done/)
  assert.doesNotMatch(context, /authorization_id|authorization_operation/)
})

test('canonicalizes legacy profile content into user preferences', () => {
  const context = buildFrontendContext({
    memories: [{
      id: 'user_model',
      scope: 'profile',
      content: '# USER\n\n- 称呼：老大',
      editable: false,
    }],
  })

  assert.match(context, /<user_preferences>/)
  assert.match(context, /称呼：老大/)
})

test('injects user preferences as directives separate from factual memory', () => {
  const context = buildFrontendContext({
    memories: [
      {
        id: 'mem_rule',
        scope: 'rules',
        content: '回复默认先给结论',
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

  assert.match(context, /<user_preferences>/)
  assert.match(
    context,
    new RegExp('<user_preferences>\\n回复默认先给结论\\n</user_preferences>'),
  )
  // User-model directives are never factual memory records.
  const memoryData = context.match(
    /<user_memory>([\s\S]*?)<\/user_memory>/,
  )?.[1] || ''
  assert.doesNotMatch(memoryData, /回复默认先给结论/)
  assert.match(memoryData, /用户喜欢苹果/)
})

test('omits user preferences when the user has only factual memory', () => {
  const context = buildFrontendContext({
    memories: [{
      id: 'mem_fact',
      scope: 'memory',
      content: '用户喜欢苹果',
      editable: true,
    }],
  })

  assert.doesNotMatch(context, /<user_preferences>/)
  assert.match(context, /<user_memory>/)
})
