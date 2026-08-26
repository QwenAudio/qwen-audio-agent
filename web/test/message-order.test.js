import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildConversationTimeline,
  buildConversationTurns,
  discardUserTranscript,
  finalAssistantContent,
  insertByTurn,
  normalizeTranscript,
  upsertAssistantTranscript,
  upsertUserTranscript,
} from '../src/message-order.js'

test('normalizes hard line breaks in final ASR text', () => {
  assert.equal(normalizeTranscript('查看下载目录\n下面有哪些文件  '), '查看下载目录 下面有哪些文件')
})

test('attaches citations to a final assistant transcript and preserves them', () => {
  let messages = upsertAssistantTranscript([], {
    id: 'voice:response-1',
    turnId: 'voice-100-1',
    content: '杭州',
  })
  messages = upsertAssistantTranscript(messages, {
    id: 'voice:response-1',
    turnId: 'voice-100-1',
    content: '今天晴。',
    citations: [{
      id: 'source_1',
      title: '杭州天气',
      url: 'https://example.com/weather',
    }],
    final: true,
  })

  assert.equal(messages[0].content, '今天晴。')
  assert.equal(messages[0].live, false)
  assert.equal(messages[0].citations[0].id, 'source_1')

  messages = upsertAssistantTranscript(messages, {
    id: 'voice:response-1',
    turnId: 'voice-100-1',
    content: '今天晴。',
    final: true,
  })
  assert.equal(messages[0].citations[0].url, 'https://example.com/weather')
})

test('replaces the mutable ASR preview and then settles the final transcript', () => {
  let messages = upsertUserTranscript([], {
    id: 'user:voice-100-1',
    turnId: 'voice-100-1',
    content: '帮我查今',
  })
  messages = upsertUserTranscript(messages, {
    id: 'user:voice-100-1',
    turnId: 'voice-100-1',
    content: '帮我查今天的天气',
  })

  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, '帮我查今天的天气')
  assert.equal(messages[0].live, true)
  assert.equal(messages[0].final, false)

  messages = upsertUserTranscript(messages, {
    id: 'user:voice-100-1',
    turnId: 'voice-100-1',
    content: '帮我查一下今天的天气。',
    final: true,
  })

  assert.equal(messages[0].content, '帮我查一下今天的天气。')
  assert.equal(messages[0].live, false)
  assert.equal(messages[0].final, true)
})

test('removes rejected ASR preview without deleting an already final transcript', () => {
  const preview = [{
    id: 'user:voice-100-1',
    role: 'user',
    turnId: 'voice-100-1',
    content: '未完成的临时识别',
    live: true,
    final: false,
  }]
  assert.deepEqual(discardUserTranscript(preview, 'voice-100-1'), [])

  const settled = [{ ...preview[0], live: false, final: true }]
  assert.deepEqual(discardUserTranscript(settled, 'voice-100-1'), settled)
})

test('preserves Markdown layout in final assistant transcripts', () => {
  const markdown = [
    '## 完成',
    '',
    '- 第一项',
    '- 第二项',
    '',
    '```js',
    'console.log("ok")',
    '```',
  ].join('\r\n')

  assert.equal(
    finalAssistantContent(markdown),
    markdown.replaceAll('\r\n', '\n'),
  )
  assert.equal(
    finalAssistantContent('', '## 流式内容\n\n- 保留排版'),
    '## 流式内容\n\n- 保留排版',
  )
})

test('keeps an asynchronous answer with its originating voice turn', () => {
  let messages = []
  messages = insertByTurn(messages, {
    id: 'user-1', role: 'user', turnId: 'voice-100-1', content: '第一个任务',
  })
  messages = insertByTurn(messages, {
    id: 'user-2', role: 'user', turnId: 'voice-200-2', content: '继续聊天',
  })
  messages = insertByTurn(messages, {
    id: 'answer-1', role: 'assistant', turnId: 'voice-100-1', content: '第一个任务完成',
  })

  assert.deepEqual(messages.map(item => item.id), ['user-1', 'answer-1', 'user-2'])
})

test('places a late user transcript before assistant messages in the same turn', () => {
  const messages = insertByTurn([
    { id: 'answer', role: 'assistant', turnId: 'voice-100-1', content: '处理中' },
  ], {
    id: 'user', role: 'user', turnId: 'voice-100-1', content: '检查目录',
  })
  assert.deepEqual(messages.map(item => item.id), ['user', 'answer'])
})

test('keeps concurrent work presentations in delivery order at the live tail', () => {
  let messages = [
    { id: 'old-user', role: 'user', turnId: 'voice-100-1', content: '任务一' },
    { id: 'new-user', role: 'user', turnId: 'voice-300-3', content: '当前对话' },
  ]
  messages = insertByTurn(messages, {
    id: 'result-2',
    role: 'assistant',
    turnId: 'voice-200-2',
    origin: 'announcement',
    deliverySequence: 2,
    content: '任务二结果',
  })
  messages = insertByTurn(messages, {
    id: 'result-1',
    role: 'assistant',
    turnId: 'voice-100-1',
    origin: 'announcement',
    deliverySequence: 1,
    content: '任务一结果',
  })

  assert.deepEqual(
    messages.map(item => item.id),
    ['old-user', 'new-user', 'result-1', 'result-2'],
  )
})

test('keeps a stale assistant reply with its original turn after user interrupts', () => {
  let messages = []
  messages = insertByTurn(messages, {
    id: 'user-1', role: 'user', turnId: 'voice-100-1', content: '第一个问题',
  })
  messages = insertByTurn(messages, {
    id: 'user-2', role: 'user', turnId: 'voice-200-2', content: '打断，新问题',
  })
  messages = insertByTurn(messages, {
    id: 'old-reply', role: 'assistant', turnId: 'voice-100-1', content: '旧回复（迟到）',
  })
  messages = insertByTurn(messages, {
    id: 'new-reply', role: 'assistant', turnId: 'voice-200-2', content: '新回复',
  })

  assert.deepEqual(
    messages.map(item => item.id),
    ['user-1', 'old-reply', 'user-2', 'new-reply'],
  )
})

test('keeps a late task update with its originating turn before newer ASR', () => {
  const turns = buildConversationTurns([
    { id: 'new-user', role: 'user', turnId: 'voice-200-2', content: '继续问一个问题' },
  ], [{
    id: 'old-task',
    turnId: 'voice-100-1',
    phase: 'running',
    createdAt: 100,
  }])
  assert.deepEqual(turns.map(turn => turn.id), ['voice-100-1', 'voice-200-2'])
  assert.equal(turns[0].tasks[0].id, 'old-task')
})

test('places an active task below its turn acknowledgement instead of above the conversation', () => {
  const messages = [
    { id: 'user-1', role: 'user', turnId: 'voice-100-1', content: '查一下天气' },
    { id: 'ack-1', role: 'assistant', turnId: 'voice-100-1', content: '我来查一下。' },
    { id: 'user-2', role: 'user', turnId: 'voice-200-2', content: '顺便看看时间' },
  ]
  const tasks = [{
    id: 'job-1',
    turnId: 'voice-100-1',
    phase: 'running',
    objective: '查一下天气',
  }]

  assert.deepEqual(
    buildConversationTimeline(messages, tasks).map(item => (
      item.type === 'message' ? item.value.id : item.value.id
    )),
    ['user-1', 'ack-1', 'job-1', 'user-2'],
  )
})

test('keeps the task card below the final task result in the same turn', () => {
  const messages = [
    { id: 'user', role: 'user', turnId: 'voice-100-1', content: '查一下天气' },
    { id: 'ack', role: 'assistant', turnId: 'voice-100-1', content: '我来查一下。' },
    {
      id: 'result',
      role: 'assistant',
      turnId: 'voice-100-1',
      taskId: 'job-1',
      content: '今天晴。',
    },
  ]
  const tasks = [{ id: 'job-1', turnId: 'voice-100-1', phase: 'responding' }]

  assert.deepEqual(
    buildConversationTimeline(messages, tasks).map(item => item.value.id),
    ['user', 'ack', 'result', 'job-1'],
  )
})

test('keeps one stable turn container while acknowledgement, activity and result arrive', () => {
  const messages = [
    { id: 'user', role: 'user', turnId: 'voice-100-1', content: '检查目录' },
    { id: 'ack', role: 'assistant', turnId: 'voice-100-1', content: '我来检查。' },
    {
      id: 'result',
      role: 'assistant',
      turnId: 'voice-100-1',
      taskId: 'job-1',
      content: '目录里有三个文件。',
    },
  ]
  const turns = buildConversationTurns(messages, [{
    id: 'job-1',
    turnId: 'voice-100-1',
    phase: 'completed',
  }])

  assert.equal(turns.length, 1)
  assert.deepEqual(
    turns[0].beforeActivities.map(message => message.id),
    ['user', 'ack', 'result'],
  )
  assert.deepEqual(turns[0].tasks.map(task => task.id), ['job-1'])
  assert.deepEqual(turns[0].afterActivities, [])
})

test('keeps asynchronous announcements as new live-tail turns', () => {
  const turns = buildConversationTurns([
    { id: 'user', role: 'user', turnId: 'voice-100-1', content: '旧任务' },
    {
      id: 'announcement',
      role: 'assistant',
      turnId: 'voice-100-1',
      origin: 'announcement',
      content: '后台任务完成',
    },
  ], [])

  assert.equal(turns.length, 2)
  assert.equal(turns[1].standalone, true)
  assert.equal(turns[1].messages[0].id, 'announcement')
})

test('appends voice messages after earlier text-turn history', () => {
  // 文字轮的 turnId（text_*）没有时间戳；此前会被误判为"最晚"，
  // 导致后续语音消息全部插到列表顶部而不可见。
  const afterText = [
    { id: 'user:text_a', role: 'user', turnId: 'text_a', content: '文字提问' },
    { id: 'voice:r1', role: 'assistant', turnId: 'text_a', content: '文字回复' },
  ]
  const withVoiceUser = insertByTurn(afterText, {
    id: 'user:voice-200-1',
    role: 'user',
    turnId: 'voice-200-1',
    content: '语音提问',
  })
  assert.equal(withVoiceUser.at(-1).id, 'user:voice-200-1')

  const withVoiceReply = insertByTurn(withVoiceUser, {
    id: 'voice:r2',
    role: 'assistant',
    turnId: 'voice-200-1',
    content: '语音回复',
  })
  assert.equal(withVoiceReply.at(-1).id, 'voice:r2')

  // 反向：语音轮之后的文字消息同样追加在末尾。
  const withText = insertByTurn(withVoiceReply, {
    id: 'user:text_b',
    role: 'user',
    turnId: 'text_b',
    content: '再发文字',
  })
  assert.equal(withText.at(-1).id, 'user:text_b')
})
