import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CustomerService } from '../service.mjs'

// 工具调用日志的测试。
//
// 【它守的是排查能力，不是业务功能】audit 只记工具返回的那句话，
// 排查「模型说了会员号，客服却还在问身份」时，缺的恰恰是【模型传了什么参数】。
// 这份日志补的就是那一段，所以"参数被完整记下来"是它唯一不能丢的性质。

// 【必须 async + await】第一版写成同步 return probe(path)，于是 finally
// 在 probe 的 promise 还没跑完时就把环境变量删了 —— 只有第一次调用被记下来，
// 后面的静默丢失。测试因此报"日志被覆盖了"，而实现压根没问题。
async function withLog(probe) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-toollog-'))
  const path = join(dir, 'nested', 'tools.jsonl')
  const saved = process.env.CS_TOOL_LOG
  process.env.CS_TOOL_LOG = path
  try {
    return await probe(path)
  } finally {
    if (saved === undefined) delete process.env.CS_TOOL_LOG
    else process.env.CS_TOOL_LOG = saved
  }
}

const lines = path => readFileSync(path, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line))

test('默认不写日志 —— 单测跑上千次工具调用不该在磁盘上留东西', async () => {
  const saved = process.env.CS_TOOL_LOG
  delete process.env.CS_TOOL_LOG
  try {
    const service = new CustomerService()
    // 没有环境变量就什么都不做，这里只要不抛错、不建文件即可。
    const result = await service.execute('verify_identity', { memberId: 'CY10023841' },
      { sessionId: 'off', surface: 'frontend', domain: 'airline' })
    assert.equal(result.data.verified, true)
  } finally {
    if (saved !== undefined) process.env.CS_TOOL_LOG = saved
  }
})

test('记下模型传进来的完整参数', async () => {
  await withLog(async (path) => {
    const service = new CustomerService()
    await service.execute('verify_identity', { memberId: 'CY10023841' },
      { sessionId: 'sess-1', surface: 'frontend', domain: 'airline' })
    const [entry] = lines(path)
    // 【参数是这份日志的全部意义】只记工具名和结果的话，
    // 「工具被调了却说缺参数」这种问题依然查不出来。
    assert.deepEqual(entry.args, { memberId: 'CY10023841' })
    assert.equal(entry.tool, 'verify_identity')
    assert.equal(entry.domain, 'airline')
    // 前台=模型直接调，后台=A2A Agent 调。混在一起就分不清是谁的问题。
    assert.equal(entry.surface, 'frontend')
    assert.equal(entry.session, 'sess-1')
    // 核验成功的真实信号在 data 里。日志【不记 ok】——
    // 工具返回值里没有那个字段，推一个出来会是假信号。
    assert.equal(entry.data.verified, true)
    assert.equal(entry.ok, undefined, '不该伪造 ok 字段')
  })
})

test('参数为空的调用也要记下来 —— 那正是最需要看见的一种', async () => {
  await withLog(async (path) => {
    const service = new CustomerService()
    // 模型没把会员号填进参数时就是这样：工具被调了，但两手空空。
    // 实测遇到过，而 audit 里只看得到"核验需要客户的会员号"这句回复，
    // 看不出是模型没传，还是传错了字段名。
    await service.execute('verify_identity', {},
      { sessionId: 'sess-2', surface: 'frontend', domain: 'airline' })
    const [entry] = lines(path)
    assert.deepEqual(entry.args, {})
    assert.match(entry.content, /会员号/)
    // 失败的真实信号：verified 为 false。
    assert.equal(entry.data.verified, false)
  })
})

test('目录不存在时自己建出来', async () => {
  await withLog(async (path) => {
    assert.equal(existsSync(path), false)
    const service = new CustomerService()
    await service.execute('verify_identity', { memberId: 'CY10023841' },
      { sessionId: 'sess-3', surface: 'frontend', domain: 'airline' })
    assert.equal(existsSync(path), true, '嵌套目录没建出来，日志就静默丢了')
  })
})

test('多次调用是追加，不是覆盖', async () => {
  await withLog(async (path) => {
    const service = new CustomerService()
    const call = (name, args) => service.execute(name, args,
      { sessionId: 'sess-4', surface: 'frontend', domain: 'airline' })
    await call('verify_identity', { memberId: 'CY10023841' })
    await call('list_reservations', {})
    await call('get_reservation', { reservationId: 'CYR8801' })
    const entries = lines(path)
    assert.equal(entries.length, 3, '日志被覆盖了，只剩最后一条')
    assert.deepEqual(entries.map(entry => entry.tool),
      ['verify_identity', 'list_reservations', 'get_reservation'])
  })
})

test('调了本域不该有的工具，也要在日志里留下痕迹', async () => {
  await withLog(async (path) => {
    const service = new CustomerService()
    await assert.rejects(
      // 零售的工具在航空域不存在 —— registry 会抛。
      () => service.execute('return_items', {},
        { sessionId: 'sess-5', surface: 'frontend', domain: 'airline' }),
      /airline 域没有这个工具/,
    )
    // 【这条查表阶段就抛】第一版实现把日志放在查表之后，
    // 于是这种调用在日志里完全没有痕迹 —— 而它恰恰说明工具面配错了
    // 或者模型在凭印象猜工具名。
    const [entry] = lines(path)
    assert.equal(entry.failed, true)
    assert.equal(entry.tool, 'return_items')
    assert.match(entry.error, /airline 域没有这个工具/)
  })
})

test('长返回被截断，但标出原长度', async () => {
  await withLog(async (path) => {
    const service = new CustomerService()
    const call = (name, args) => service.execute(name, args,
      { sessionId: 'sess-6', surface: 'frontend', domain: 'airline' })
    await call('verify_identity', { memberId: 'CY10091455' })
    // 40 班航班里 CAN→CTU 那条线列出来会很长。
    await call('search_flights', { from: 'CAN', to: 'CTU' })
    const entry = lines(path).at(-1)
    // 【日志不该无限长】要看全文去 audit；这里只要够认出是哪次调用。
    if (entry.content.includes('截断')) {
      assert.match(entry.content, /共 \d+ 字/)
    }
    assert.ok(entry.content.length < 600, `content 太长了：${entry.content.length}`)
  })
})
