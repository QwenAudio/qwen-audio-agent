import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { TOOLS, runTool, summarize } from '../extract-probe.mjs'
import { extractPolicy } from '../extract.mjs'

const retailDb = JSON.parse(
  readFileSync(new URL('../../domains/retail/db.json', import.meta.url), 'utf8'),
)
const airlineDb = JSON.parse(
  readFileSync(new URL('../../domains/airline/db.json', import.meta.url), 'utf8'),
)
const policyPath = new URL('../../domains/retail/policy.md', import.meta.url)

// ── 取数逻辑 ──

test('list_data_values 只返回库里实际出现过的取值', () => {
  const result = runTool(retailDb, 'list_data_values', { field: 'category' })
  assert.deepEqual(result.values, ['accessory', 'apparel', 'appliance', 'digital', 'furniture'])
  // 库里没有的不该出现
  assert.ok(!result.values.includes('fresh_food'))
})

test('category 额外返回「有客户买过的」', () => {
  // 【这两个不是一回事】「库里有没有家具商品」和「有没有客户买过家具」——
  // 后者才是能演示的。规则要在通话里走到，就得有客户名下的订单。
  const result = runTool(retailDb, 'list_data_values', { field: 'category' })
  assert.ok(Array.isArray(result.purchased))
  for (const category of result.purchased) {
    assert.ok(result.values.includes(category), `买过的 ${category} 不在商品表里`)
  }
})

test('订单状态跨 orders 与 reservations 两个集合找', () => {
  assert.deepEqual(
    runTool(retailDb, 'list_data_values', { field: 'status' }).values,
    ['cancelled', 'delivered', 'pending', 'shipped'],
  )
  // 航空的 status 在 reservations 上
  const airline = runTool(airlineDb, 'list_data_values', { field: 'status' })
  assert.ok(airline.values.length > 0, '航空域取不到 status')
})

test('航空域能查到舱位与会员等级', () => {
  assert.deepEqual(
    runTool(airlineDb, 'list_data_values', { field: 'cabin' }).values,
    ['basic_economy', 'business', 'economy'],
  )
  assert.deepEqual(
    runTool(airlineDb, 'list_data_values', { field: 'memberTier' }).values,
    ['gold', 'regular', 'silver'],
  )
})

test('不认识的字段给出可查清单，而不是空结果', () => {
  const result = runTool(retailDb, 'list_data_values', { field: 'nonsense' })
  assert.ok(result.error)
  assert.match(result.error, /category/)
})

test('count_samples 返回签收天数并带结论', () => {
  const result = runTool(retailDb, 'count_samples', { category: 'digital' })
  assert.ok(result.deliveredDays.length > 0)
  // 【结论也要给】只给一串天数的话模型要自己比较，而它算错了我们看不出来
  assert.match(result.note, /笔已签收订单/)
  // 升序，便于看边界
  const sorted = result.deliveredDays.slice().sort((a, b) => a - b)
  assert.deepEqual(result.deliveredDays, sorted)
})

test('count_samples 对没有样本的类别明说没有', () => {
  const result = runTool(retailDb, 'count_samples', { category: 'fresh_food' })
  assert.deepEqual(result.deliveredDays, [])
  assert.match(result.note, /库里没有/)
})

test('不认识的工具名不抛错，返回 error', () => {
  // 抽取过程中模型可能编一个工具名。抛错会中断整轮抽取，
  // 而返回 error 能让它自己纠正。
  const result = runTool(retailDb, 'drop_table', {})
  assert.ok(result.error)
})

// ── 摘要 ──

test('摘要列出四类字段的取值', () => {
  const text = summarize(retailDb)
  assert.match(text, /category:/)
  assert.match(text, /status:/)
  assert.match(text, /有客户买过的 category:/)
})

test('摘要不包含库里没有的取值', () => {
  const text = summarize(retailDb)
  assert.ok(!text.includes('fresh_food'))
  assert.ok(!text.includes('refunding'))
})

test('空库的摘要是空串，不是一堆空标题', () => {
  assert.equal(summarize({}), '')
})

// ── 工具定义 ──

test('每个工具的描述都说清了什么时候用它', () => {
  for (const tool of TOOLS) {
    const description = tool.function.description
    assert.ok(description.length > 40, `${tool.function.name} 的描述太短`)
    // 描述里要说清「查完之后做什么」——
    // 只说「查某个字段的取值」的话模型不知道为什么要查
    assert.match(description, /gaps|演示不出来|确认/)
  }
})

test('field 参数用 enum 约束，不让模型自由填', () => {
  const listTool = TOOLS.find(tool => tool.function.name === 'list_data_values')
  const field = listTool.function.parameters.properties.field
  assert.ok(Array.isArray(field.enum))
  assert.ok(field.enum.includes('category'))
})

// ── 三种模式的装配 ──

// 假 client：记录收到的请求，按脚本回。不打真实 API。
function fakeClient({ toolCalls = [], final = {} } = {}) {
  const seen = []
  let step = 0
  return {
    seen,
    chat: {
      completions: {
        create: async request => {
          seen.push(request)
          // 带 tools 的是探查轮
          if (request.tools) {
            const batch = toolCalls[step]
            step += 1
            if (batch) {
              return {
                choices: [{
                  message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: batch.map((call, index) => ({
                      id: `call_${step}_${index}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.args) },
                    })),
                  },
                }],
              }
            }
            return { choices: [{ message: { role: 'assistant', content: '查完了' } }] }
          }
          return { choices: [{ message: { content: JSON.stringify(final) } }] }
        },
      },
    },
  }
}

const EMPTY_RESULT = {
  order_rules: [], category_windows: [], thresholds: [],
  enums: [], escalation_triggers: [], gaps: [], lookup_tables: [],
}

test('blind 模式不带工具，也不改 system prompt', async () => {
  const client = fakeClient({ final: EMPTY_RESULT })
  await extractPolicy(policyPath, { client, probe: 'blind', db: retailDb })
  assert.equal(client.seen.length, 1, 'blind 应该只调一次')
  assert.equal(client.seen[0].tools, undefined)
  assert.ok(!client.seen[0].messages[0].content.includes('数据库里实际存在的取值'))
})

test('summary 模式把摘要拼进 system prompt', async () => {
  const client = fakeClient({ final: EMPTY_RESULT })
  await extractPolicy(policyPath, { client, probe: 'summary', db: retailDb })
  assert.equal(client.seen.length, 1, 'summary 也只调一次')
  assert.match(client.seen[0].messages[0].content, /数据库里实际存在的取值/)
  assert.match(client.seen[0].messages[0].content, /furniture/)
})

test('tools 模式先探查再要结果', async () => {
  const client = fakeClient({
    toolCalls: [[{ name: 'list_data_values', args: { field: 'category' } }]],
    final: EMPTY_RESULT,
  })
  const result = await extractPolicy(policyPath, { client, probe: 'tools', db: retailDb })
  // 探查轮 + 「查完了」那轮 + 收尾轮
  assert.ok(client.seen.length >= 2, `实际只调了 ${client.seen.length} 次`)
  assert.deepEqual(client.seen[0].tools, TOOLS)
  // 【收尾那一轮不能带 tools】实测过：强制 json_object 时模型不发工具调用，
  // 所以两者不能同时上。收尾轮要强制 JSON，就不能带 tools。
  const last = client.seen.at(-1)
  assert.equal(last.tools, undefined, '收尾轮带了 tools')
  assert.deepEqual(last.response_format, { type: 'json_object' })
  // 工具真的被执行了，结果进了对话
  assert.equal(result.probeCalls.length, 1)
  assert.equal(result.probeCalls[0].name, 'list_data_values')
  assert.ok(result.probeCalls[0].output.values.includes('furniture'))
})

test('探查记录带在返回值里', async () => {
  // 【不带的话分不清「它没查」和「它查了但没用」】
  // 这两种要改的地方完全不同：前者改工具描述，后者改 prompt。
  const client = fakeClient({
    toolCalls: [[
      { name: 'list_data_values', args: { field: 'category' } },
      { name: 'count_samples', args: { category: 'digital' } },
    ]],
    final: EMPTY_RESULT,
  })
  const result = await extractPolicy(policyPath, { client, probe: 'tools', db: retailDb })
  assert.equal(result.probe, 'tools')
  assert.equal(result.probeCalls.length, 2)
  assert.match(result.probeCalls[1].output.note, /已签收订单/)
})

test('没给 db 时 tools 模式退化成 blind，不报错', async () => {
  // 有些调用方（旧代码、测试）不传 db。那时不该崩，也不该假装探查过。
  const client = fakeClient({ final: EMPTY_RESULT })
  const result = await extractPolicy(policyPath, { client, probe: 'tools' })
  assert.equal(client.seen.length, 1)
  assert.equal(client.seen[0].tools, undefined)
  assert.equal(result.probeCalls.length, 0)
})

test('探查轮有上限，模型一直调工具也会停', async () => {
  // 无上限的话模型可以把预算烧光。
  const forever = Array.from({ length: 50 }, () => [
    { name: 'list_data_values', args: { field: 'category' } },
  ])
  const client = fakeClient({ toolCalls: forever, final: EMPTY_RESULT })
  await extractPolicy(policyPath, { client, probe: 'tools', db: retailDb, maxRounds: 3 })
  // 3 轮探查 + 1 轮收尾
  assert.equal(client.seen.length, 4)
})

test('工具参数是坏 JSON 时不中断整轮抽取', async () => {
  const client = {
    seen: [],
    chat: {
      completions: {
        create: async request => {
          client.seen.push(request)
          if (request.tools) {
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  tool_calls: [{
                    id: 'c1',
                    type: 'function',
                    function: { name: 'list_data_values', arguments: '{坏JSON' },
                  }],
                },
              }],
            }
          }
          return { choices: [{ message: { content: JSON.stringify(EMPTY_RESULT) } }] }
        },
      },
    },
  }
  const result = await extractPolicy(policyPath, {
    client, probe: 'tools', db: retailDb, maxRounds: 1,
  })
  // 参数解析失败当成空参数，工具返回 error，抽取继续
  assert.equal(result.probeCalls.length, 1)
  assert.ok(result.probeCalls[0].output.error)
})
