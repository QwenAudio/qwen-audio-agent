import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Role,
  TaskState,
} from '@a2a-js/sdk'
import { CockpitAgentExecutor } from '../executor.mjs'
import { CockpitAgentTools } from '../tools.mjs'
import { createWebRetrieval } from 'qwen-audio-agent/web-retrieval'

const TEMPERATURE_TOOL = {
  name: 'vehicle_temperature_control',
  description: '控制座舱温度',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      temperature: { type: 'number' },
    },
  },
}

function requestContext(text) {
  return {
    taskId: 'remote-task',
    contextId: 'remote-context',
    userMessage: {
      messageId: 'message-1',
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [{
        content: { $case: 'text', value: text },
        mediaType: 'text/plain',
        filename: '',
      }],
      extensions: [],
      referenceTaskIds: [],
    },
  }
}

test('lets the model plan an MCP call and publishes the A2A lifecycle', async () => {
  const calls = []
  const events = []
  let round = 0
  const executor = new CockpitAgentExecutor({
    model: {
      async complete({ messages, tools }) {
        assert.equal(tools[0].function.name, TEMPERATURE_TOOL.name)
        if (round++ === 0) {
          assert.match(messages[0].content, /必须使用提供的工具/u)
          assert.match(messages[0].content, /后续指令中明确确认/u)
          assert.match(messages[0].content, /导航到.*navigation_start/u)
          assert.match(messages[0].content, /不向前台或用户提及预算/u)
          assert.match(messages[0].content, /不把简短请求自动升级为深度研究/u)
          return {
            content: null,
            tool_calls: [{
              id: 'call-climate',
              function: {
                name: TEMPERATURE_TOOL.name,
                arguments: JSON.stringify({ action: 'set', temperature: 22 }),
              },
            }],
          }
        }
        assert.equal(messages.at(-1).role, 'tool')
        return { content: messages.at(-1).content }
      },
    },
    tools: {
      async list() { return [TEMPERATURE_TOOL] },
      async call(name, args) {
        calls.push({ name, args })
        return { content: '空调当前开启，制冷，22°C，3档', data: { vehicle: { acTemp: 22 } } }
      },
    },
  })
  await executor.execute(requestContext('空调调到二十二度'), {
    publish(event) { events.push(event) },
  })

  assert.deepEqual(calls, [{
    name: 'vehicle_temperature_control',
    args: { action: 'set', temperature: 22 },
  }])
  assert.deepEqual(events.map(event => event.kind), [
    'task',
    'statusUpdate',
    'statusUpdate',
    'artifactUpdate',
    'statusUpdate',
  ])
  assert.equal(events[1].data.status.state, TaskState.TASK_STATE_WORKING)
  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED)
  assert.equal(
    events.at(-2).data.artifact.parts[0].content.value,
    '空调当前开启，制冷，22°C，3档',
  )
})

test('returns a model clarification without inventing a tool call', async () => {
  let called = false
  const events = []
  const executor = new CockpitAgentExecutor({
    model: {
      async complete() {
        return { content: '您最后要去萧山的哪个位置？' }
      },
    },
    tools: {
      async list() { return [TEMPERATURE_TOOL] },
      async call() { called = true },
    },
  })
  await executor.execute(requestContext('最后再回到萧山那个'), {
    publish(event) { events.push(event) },
  })

  assert.equal(called, false)
  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED)
  assert.match(
    events.at(-1).data.status.message.parts[0].content.value,
    /萧山的哪个位置/u,
  )
})

test('discovers a custom skill, loads it, and then executes its real tools', async () => {
  const calls = []
  const events = []
  let round = 0
  const tools = [
    {
      name: 'custom_skill_list',
      description: '列出自定义技能',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'custom_skill_load',
      description: '加载自定义技能',
      inputSchema: {
        type: 'object',
        properties: { skill_name: { type: 'string' } },
        required: ['skill_name'],
      },
    },
    {
      name: 'navigation_start',
      description: '开始导航',
      inputSchema: {
        type: 'object',
        properties: { destination: { type: 'string' } },
        required: ['destination'],
      },
    },
  ]
  const executor = new CockpitAgentExecutor({
    model: {
      async complete({ messages }) {
        if (round++ === 0) {
          assert.match(messages[0].content, /下班回家/u)
          assert.match(messages[0].content, /执行前必须调用 custom_skill_load/u)
          return {
            tool_calls: [{
              id: 'load-skill',
              function: {
                name: 'custom_skill_load',
                arguments: JSON.stringify({ skill_name: '下班回家' }),
              },
            }],
          }
        }
        if (round === 2) {
          assert.match(messages.at(-1).content, /导航到家/u)
          return {
            tool_calls: [{
              id: 'start-navigation',
              function: {
                name: 'navigation_start',
                arguments: JSON.stringify({ destination: '家' }),
              },
            }],
          }
        }
        return { content: '已开始导航回家。' }
      },
    },
    tools: {
      async list() { return tools },
      async call(name, args) {
        calls.push({ name, args })
        if (name === 'custom_skill_list') {
          return {
            content: '下班回家：导航回家',
            data: { skills: [{ name: '下班回家', description: '导航回家' }] },
          }
        }
        if (name === 'custom_skill_load') {
          return { content: '<custom_skill_instructions>导航到家。</custom_skill_instructions>' }
        }
        return { content: '已开始导航到家', data: { navigation: { status: 'navigating' } } }
      },
    },
  })
  await executor.execute(requestContext('执行下班回家'), {
    publish(event) { events.push(event) },
  })

  assert.deepEqual(calls.map(call => call.name), [
    'custom_skill_list',
    'custom_skill_load',
    'navigation_start',
  ])
  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED)
  assert.equal(events.at(-1).data.status.message.parts[0].content.value, '已开始导航回家。')
})

test('researches multiple sources and returns a full artifact with a separate spoken summary', async () => {
  const searches = []
  const pages = []
  const events = []
  const urls = ['https://first.example/news', 'https://second.example/release']
  const retrieval = createWebRetrieval({ env: {}, searchProvider: {
    describe: () => ({ key: 'mock', label: 'Mock' }),
    isConfigured: () => true,
    search: async query => {
      const index = searches.length
      searches.push(query)
      return { results: [{ title: `原始来源${index + 1}`, url: urls[index], snippet: `来源${index + 1}的摘要`, ...(index === 0 ? { publishedAt: '2026-09-11' } : {}) }] }
    },
  }, urlFetcher: {
    fetch: async url => { pages.push(url); return { status: 'ok', url, title: '原始正文', content: `事实来自 ${url}` } },
  } })
  let round = 0
  const plan = [
    ['web_search', { query: 'AI 原始公告 2026-09-11' }],
    ['web_search', { query: 'AI 新闻 独立来源 2026-09-11' }],
    ['fetch_url', { url: urls[0] }],
    ['fetch_url', { url: urls[1] }],
  ]
  const executor = new CockpitAgentExecutor({
    tools: new CockpitAgentTools({ cockpit: { list: async () => [], call: async () => { throw new Error('Unexpected cockpit action') } }, retrieval }),
    model: { complete: async ({ messages }) => {
      assert.match(messages[0].content, /当前时间（UTC）/)
      assert.match(messages[0].content, /不得补造新闻/)
      const call = plan[round++]
      if (call) return { tool_calls: [{ id: `call-${round}`, function: { name: call[0], arguments: JSON.stringify(call[1]) } }] }
      return { content: `<cockpit_report># AI 新闻研究\n\n截至 2026-09-11。\n\n第一条 [来源](${urls[0]})。第二条发布日期未核实 [来源](${urls[1]})。</cockpit_report><cockpit_summary>找到两条相关消息，第二条的发布日期尚未核实，详见报告。</cockpit_summary>` }
    } },
  })
  await executor.execute(requestContext('深入整理今天的 AI 新闻报告并核对来源'), { publish: event => events.push(event) })
  assert.equal(searches.length, 2)
  assert.deepEqual(pages, urls)
  const artifact = events.find(event => event.kind === 'artifactUpdate').data.artifact
  assert.match(artifact.parts[0].content.value, /# AI 新闻研究/)
  assert.match(artifact.parts[0].content.value, /## 实际检索来源/)
  assert.match(artifact.parts[0].content.value, /发布日期：2026-09-11/)
  assert.match(artifact.parts[0].content.value, /发布日期：未核实/)
  assert.equal(artifact.metadata.sources.length, 2)
  assert.ok(artifact.metadata.sources.every(source => source.read))
  const final = events.at(-1).data.status
  assert.equal(final.state, TaskState.TASK_STATE_COMPLETED)
  assert.equal(final.message.parts[0].content.value, '找到两条相关消息，第二条的发布日期尚未核实，详见报告。')
  assert.doesNotMatch(final.message.parts[0].content.value, /https:/)
})

test('does not deliver an invented report when no retrieval succeeded', async () => {
  const events = []
  const executor = new CockpitAgentExecutor({
    tools: { list: async () => [], call: async () => {} },
    model: { complete: async () => ({ content: '<cockpit_report>今天虚构公司发布重大新闻</cockpit_report><cockpit_summary>新闻已核实</cockpit_summary>' }) },
  })
  await executor.execute(requestContext('今天新闻'), { publish: event => events.push(event) })
  const artifact = events.find(event => event.kind === 'artifactUpdate').data.artifact.parts[0].content.value
  assert.match(artifact, /未能取得可核验/)
  assert.doesNotMatch(artifact, /虚构公司|新闻已核实/)
})

test('keeps unread-source and retrieval-failure limitations in both report and speech', async () => {
  const events = []
  let round = 0
  const executor = new CockpitAgentExecutor({
    tools: new CockpitAgentTools({ cockpit: { list: async () => [], call: async () => {} }, retrieval: {
      capabilities: () => ['web-search', 'url-fetch'],
      search: async () => ({ status: 'ok', citations: [{ url: 'https://example.com/news', title: 'News' }] }),
      fetchUrl: async () => { throw new Error('unavailable') },
    } }),
    model: { complete: async () => {
      if (round++ === 0) return { tool_calls: [{ id: 'search', function: { name: 'web_search', arguments: '{"query":"news"}' } }] }
      if (round === 2) return { tool_calls: [{ id: 'fetch', function: { name: 'fetch_url', arguments: '{"url":"https://example.com/news"}' } }] }
      return { content: '<cockpit_report>仅取得摘要。</cockpit_report><cockpit_summary>找到一条消息。</cockpit_summary>' }
    } },
  })
  await executor.execute(requestContext('整理新闻'), { publish: event => events.push(event) })
  const artifact = events.find(event => event.kind === 'artifactUpdate').data.artifact
  assert.match(artifact.parts[0].content.value, /不能视为已核验/)
  assert.match(artifact.parts[0].content.value, /未完成的检索/)
  assert.equal(artifact.metadata.retrieval_failures.length, 1)
  assert.equal(artifact.metadata.sources[0].read, false)
  assert.match(events.at(-1).data.status.message.parts[0].content.value, /读取失败/)
})

test('allows research past three minutes and fails at exactly ten minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = []
  let taskSignal
  let started
  const ready = new Promise(resolve => { started = resolve })
  const executor = new CockpitAgentExecutor({
    tools: { list: async () => [], call: async () => {} },
    model: { complete: async ({ messages, signal }) => new Promise((_resolve, reject) => {
      assert.match(messages[0].content, /24 轮模型响应、32 次工具调用及 10 分钟/u)
      taskSignal = signal
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      started()
    }) },
  })
  const pending = executor.execute(requestContext('研究新闻'), { publish: event => events.push(event) })
  await ready

  t.mock.timers.tick(180_000)
  assert.equal(taskSignal.aborted, false)
  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_WORKING)
  t.mock.timers.tick(419_999)
  assert.equal(taskSignal.aborted, false)
  assert.equal(executor.controllers.size, 1)

  t.mock.timers.tick(1)
  await pending
  assert.equal(taskSignal.aborted, true)
  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_FAILED)
  assert.match(events.at(-1).data.status.message.parts[0].content.value, /达到 10 分钟执行上限/u)
  assert.ok(events.every(event => event.kind !== 'artifactUpdate'))
  assert.equal(executor.controllers.size, 0)
})

test('completes after the old deadline and clears the ten-minute timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = []
  let taskSignal
  let finish
  let started
  const ready = new Promise(resolve => { started = resolve })
  const executor = new CockpitAgentExecutor({
    tools: { list: async () => [], call: async () => {} },
    model: { complete: async ({ signal }) => new Promise(resolve => {
      taskSignal = signal
      finish = resolve
      started()
    }) },
  })
  const pending = executor.execute(requestContext('整理任务结果'), { publish: event => events.push(event) })
  await ready
  t.mock.timers.tick(180_001)
  finish({ content: '任务已完成。' })
  await pending

  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED)
  assert.equal(executor.controllers.size, 0)
  const eventCount = events.length
  t.mock.timers.tick(600_000)
  assert.equal(taskSignal.aborted, false)
  assert.equal(events.length, eventCount)
})

test('publishes working immediately and cancels an in-flight research request without a result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = []
  let started
  const ready = new Promise(resolve => { started = resolve })
  const executor = new CockpitAgentExecutor({
    tools: { list: async () => [], call: async () => {} },
    model: { complete: async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      started()
    }) },
  })
  const pending = executor.execute(requestContext('研究新闻'), { publish: event => events.push(event) })
  await ready
  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_WORKING)
  await executor.cancelTask('remote-task')
  await pending
  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_CANCELED)
  assert.ok(events.every(event => event.kind !== 'artifactUpdate'))
  assert.equal(executor.controllers.size, 0)
  const eventCount = events.length
  t.mock.timers.tick(600_000)
  assert.equal(events.length, eventCount)
})

test('stops offering tools at the scenario round budget and summarizes existing work', async () => {
  let completedRounds = 0
  let calls = 0
  const events = []
  const executor = new CockpitAgentExecutor({
    tools: { list: async () => [TEMPERATURE_TOOL], call: async () => { calls++; return { content: '操作结果' } } },
    model: { complete: async ({ tools }) => {
      completedRounds++
      if (!tools.length) return { content: '已完成的操作结果已整理。' }
      return { tool_calls: [{ id: `call-${completedRounds}`, function: { name: TEMPERATURE_TOOL.name, arguments: '{}' } }] }
    } },
  })
  await executor.execute(requestContext('一项持续任务'), { publish: event => events.push(event) })
  assert.equal(completedRounds, 24)
  assert.equal(calls, 23)
  assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED)
  assert.match(events.at(-1).data.status.message.parts[0].content.value, /操作结果已整理/u)
  assert.doesNotMatch(events.at(-1).data.status.message.parts[0].content.value, /预算|次数|轮次|失败|超时/u)
})

for (const invalidSummary of ['tool-calls', 'empty']) {
  test(`preserves cockpit results after a ${invalidSummary} summary at the tool limit`, async () => {
    let calls = 0
    let modelCalls = 0
    const events = []
    const executor = new CockpitAgentExecutor({
      tools: { list: async () => [TEMPERATURE_TOOL], call: async () => { calls++; return { content: '温度未调整：当前设置不可用。', data: {} } } },
      model: { complete: async () => {
        modelCalls++
        if (modelCalls > 1 && invalidSummary === 'empty') return { content: '   ' }
        return { tool_calls: Array.from({ length: 33 }, (_, index) => ({ id: `call-${index}`, function: { name: TEMPERATURE_TOOL.name, arguments: '{}' } })) }
      } },
    })
    await executor.execute(requestContext('有界执行'), { publish: event => events.push(event) })
    assert.equal(calls, 32)
    assert.equal(modelCalls, 2)
    assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED)
    assert.equal(events.find(event => event.kind === 'artifactUpdate').data.artifact.parts[0].content.value, '温度未调整：当前设置不可用。')
    assert.equal(events.at(-1).data.status.message.parts[0].content.value, '温度未调整：当前设置不可用。')
    assert.doesNotMatch(events.at(-1).data.status.message.parts[0].content.value, /预算|次数|轮次|失败|超时/u)
  })
}

const RESEARCH_TOOL = { name: 'web_search', inputSchema: { type: 'object' } }
function researchCall(id) {
  return { id, function: { name: 'web_search', arguments: '{}' } }
}
function researchResult(index) {
  return {
    content: `RAW_TOOL_JSON_${index}`,
    data: {
      status: 'ok',
      citations: [{ url: `https://example.com/news/${index}`, title: `新闻 ${index}` }],
      retrieval: { tool: 'web_search', retrieved_at: '2026-09-11T05:00:00Z' },
    },
  }
}

for (const batches of [[33], [31, 3], [32]]) {
  test(`finishes research with evidence after tool batches ${batches.join('+')} hit the limit`, async () => {
    let executed = 0
    let modelCalls = 0
    const issued = []
    const events = []
    const executor = new CockpitAgentExecutor({
      tools: { list: async () => [RESEARCH_TOOL], call: async () => researchResult(++executed) },
      model: { complete: async ({ messages, tools }) => {
        const round = modelCalls++
        if (round < batches.length) {
          assert.equal(tools.length, 1)
          const calls = Array.from({ length: batches[round] }, (_, index) => researchCall(`r${round}-${index}`))
          issued.push(...calls.map(call => call.id))
          return { tool_calls: calls }
        }
        assert.deepEqual(tools, [])
        assert.match(messages.at(-1).content, /停止工具调用/u)
        assert.match(messages.at(-1).content, /不向用户提及预算/u)
        const receipts = messages.filter(message => message.role === 'tool')
        assert.deepEqual(receipts.map(message => message.tool_call_id), issued)
        for (const receipt of receipts.slice(32)) {
          assert.equal(JSON.parse(receipt.content).executed, false)
          assert.equal(JSON.parse(receipt.content).error_code, 'tool_call_budget_exhausted')
        }
        return { content: '<cockpit_report>已取得部分新闻摘要。</cockpit_report><cockpit_summary>整理了已有线索。</cockpit_summary>' }
      } },
    })
    await executor.execute(requestContext('整理新闻报告'), { publish: event => events.push(event) })
    assert.equal(executed, 32)
    assert.equal(modelCalls, batches.length + 1)
    const artifact = events.find(event => event.kind === 'artifactUpdate').data.artifact
    assert.equal(artifact.metadata.sources.length, 32)
    assert.match(artifact.parts[0].content.value, /已取得部分新闻摘要/u)
    assert.doesNotMatch(artifact.parts[0].content.value, /预算|次数|轮次|超时/u)
    assert.match(artifact.parts[0].content.value, /https:\/\/example.com\/news\/32/u)
    assert.doesNotMatch(artifact.parts[0].content.value, /RAW_TOOL_JSON/u)
    const final = events.at(-1).data.status
    assert.equal(final.state, TaskState.TASK_STATE_COMPLETED)
    assert.match(final.message.parts[0].content.value, /整理了已有线索/u)
    assert.doesNotMatch(final.message.parts[0].content.value, /预算|次数|轮次|超时|时间.*限制/u)
  })
}

for (const invalidSummary of ['tool-calls', 'empty']) {
  test(`retains evidence after a ${invalidSummary} summary at the last model round`, async () => {
    let executed = 0
    let modelCalls = 0
    const events = []
    const executor = new CockpitAgentExecutor({
      tools: { list: async () => [RESEARCH_TOOL], call: async () => researchResult(++executed) },
      model: { complete: async ({ tools }) => {
        modelCalls++
        if (tools.length) return { tool_calls: [researchCall(`r${modelCalls}`)] }
        return invalidSummary === 'empty'
          ? { content: '   ' }
          : { content: '未经执行的操作已全部完成。', tool_calls: [researchCall('must-not-run')] }
      } },
    })
    await executor.execute(requestContext('整理新闻报告'), { publish: event => events.push(event) })
    assert.equal(modelCalls, 24)
    assert.equal(executed, 23)
    const artifact = events.find(event => event.kind === 'artifactUpdate').data.artifact
    assert.equal(artifact.metadata.sources.length, 23)
    assert.match(artifact.parts[0].content.value, /已整理检索到的来源/u)
    assert.doesNotMatch(artifact.parts[0].content.value, /预算|次数|轮次|超时/u)
    assert.doesNotMatch(artifact.parts[0].content.value, /RAW_TOOL_JSON|未经执行的操作已全部完成/u)
    assert.equal(events.at(-1).data.status.state, TaskState.TASK_STATE_COMPLETED)
    assert.match(events.at(-1).data.status.message.parts[0].content.value, /相关来源已整理/u)
    assert.doesNotMatch(events.at(-1).data.status.message.parts[0].content.value, /预算|次数|轮次|超时|完整报告/u)
  })
}

for (const stop of ['cancel', 'timeout']) {
  test(`does not convert ${stop} during budget finalization into a completed report`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let started
    const ready = new Promise(resolve => { started = resolve })
    const events = []
    const executor = new CockpitAgentExecutor({
      tools: { list: async () => [RESEARCH_TOOL], call: async () => researchResult(1) },
      model: { complete: async ({ tools, signal }) => {
        if (tools.length) return { tool_calls: Array.from({ length: 32 }, (_, index) => researchCall(`c${index}`)) }
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          started()
        })
      } },
    })
    const pending = executor.execute(requestContext('整理新闻报告'), { publish: event => events.push(event) })
    await ready
    if (stop === 'cancel') await executor.cancelTask('remote-task')
    else t.mock.timers.tick(600_000)
    await pending
    assert.ok(events.every(event => event.kind !== 'artifactUpdate'))
    assert.equal(events.at(-1).data.status.state, stop === 'cancel' ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED)
    if (stop === 'timeout') assert.match(events.at(-1).data.status.message.parts[0].content.value, /10 分钟执行上限/u)
    assert.equal(executor.controllers.size, 0)
  })
}
