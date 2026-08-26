import assert from 'node:assert/strict'
import test from 'node:test'
import { PreferenceCandidatePool } from '../src/conversation/preference-candidates.mjs'
import { ProfileObserver } from '../src/conversation/profile-observer.mjs'

function conversationStub(messages) {
  return { list() { return messages } }
}

// 四轮用户发言刚好达到 minUserMessages 门槛
function transcript(userLines, assistantLines = []) {
  const messages = []
  userLines.forEach((content, index) => {
    messages.push({ role: 'user', content })
    if (assistantLines[index]) {
      messages.push({ role: 'assistant', content: assistantLines[index] })
    }
  })
  return messages
}

function harness({
  messages = transcript(['一', '二', '三', '四']),
  reply = '{"observations":[]}',
  auditRecords = [],
} = {}) {
  const clock = Date.parse('2026-08-01T09:00:00Z')
  const pool = new PreferenceCandidatePool({ now: () => clock })
  const calls = []
  const observer = new ProfileObserver({
    candidatePool: pool,
    conversationSync: conversationStub(messages),
    audit: { record(entry) { auditRecords.push(entry) } },
    llmCall: async payload => {
      calls.push(payload)
      return typeof reply === 'function' ? reply(payload) : reply
    },
    logger: { warn() {}, debug() {} },
  })
  return { pool, observer, calls, auditRecords }
}

const reasons = records => records.filter(item => item.op === 'skip').map(item => item.reason)

test('writes an observation into the candidate pool', async () => {
  const { pool, observer } = harness({
    messages: transcript([
      '我在学校教语文',
      '帮我出一份阅读理解练习',
      '这个班的基础比较弱',
      '下周要用',
    ]),
    reply: JSON.stringify({
      observations: [{
        field: 'occupation',
        value: '中学语文老师',
        relation: 'same',
        quote: '我在学校教语文',
      }],
    }),
  })

  const accepted = await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.equal(accepted.length, 1)
  const [slot] = pool.list('u1')
  assert.equal(slot.field, 'occupation')
  assert.equal(slot.value, '中学语文老师')
  assert.equal(slot.confirm, 1)
  assert.equal(slot.evidence[0].quote, '我在学校教语文')
})

// 核心结构性防护：模型编造的证据必须被挡掉，不能靠 prompt 自觉。
test('rejects an observation whose quote is not in the user turns', async () => {
  const { pool, observer, auditRecords } = harness({
    messages: transcript(['一', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{
        field: 'occupation',
        value: '算法工程师',
        relation: 'same',
        quote: '我是做算法的',
      }],
    }),
  })

  const accepted = await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.deepEqual(accepted, [])
  assert.equal(pool.list('u1').length, 0)
  assert.deepEqual(reasons(auditRecords), ['quote_not_from_user'])
})

// 同一条防护顺带挡住「把助手的话当成用户偏好」——对标 OpenClaw 对
// untrusted/system 来源候选的结构性剔除。
test('rejects a quote taken from the assistant turns', async () => {
  const { pool, observer, auditRecords } = harness({
    messages: transcript(
      ['帮我看看', '继续', '好的', '就这样'],
      ['我建议你先说结论再展开细节', '好', '好', '好'],
    ),
    reply: JSON.stringify({
      observations: [{
        field: 'response_style',
        value: '先说结论再展开',
        relation: 'same',
        quote: '我建议你先说结论再展开细节',
      }],
    }),
  })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.equal(pool.list('u1').length, 0)
  assert.deepEqual(reasons(auditRecords), ['quote_not_from_user'])
})

// 自我强化循环：USER.md 里已生效的画像出现在 instructions 而不是对话轮里，
// 因此永远通不过 quote 校验，不会被当成新证据反复确认。
test('cannot re-confirm an already injected profile without fresh user evidence', async () => {
  const { pool, observer, auditRecords } = harness({
    messages: transcript(['今天天气不错', '嗯', '好', '知道了']),
    reply: JSON.stringify({
      observations: [{
        field: 'occupation',
        value: '中学语文老师',
        relation: 'same',
        // 模型从「当前已知画像」里抄回来的，不是用户本场说的
        quote: '职业：中学语文老师',
      }],
    }),
  })
  pool.observe({ ownerId: 'u1', sessionId: 's0', field: 'occupation', value: '中学语文老师' })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  const [slot] = pool.list('u1')
  assert.equal(slot.confirm, 1, '确认次数不能因为它已在画像里就再涨一次')
  assert.deepEqual(reasons(auditRecords), ['quote_not_from_user'])
})

test('tolerates punctuation drift between the quote and the transcript', async () => {
  const { pool, observer } = harness({
    messages: transcript(['你回答简短点，别啰嗦', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{
        field: 'response_length',
        value: 'brief',
        relation: 'same',
        quote: '回答简短点 别啰嗦',
      }],
    }),
  })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.equal(pool.list('u1')[0].value, 'brief')
})

test('drops unknown fields, empty values and missing quotes', async () => {
  const { pool, observer, auditRecords } = harness({
    messages: transcript(['我在学校教语文', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [
        { field: 'nickname', value: '老张', relation: 'same', quote: '我在学校教语文' },
        { field: 'occupation', value: '', relation: 'same', quote: '我在学校教语文' },
        { field: 'occupation', value: '老师', relation: 'same', quote: '' },
      ],
    }),
  })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.equal(pool.list('u1').length, 0)
  assert.deepEqual(reasons(auditRecords), ['unknown_field', 'empty_value', 'missing_quote'])
})

test('records pool_rejected when the pool refuses the value', async () => {
  const { pool, observer, auditRecords } = harness({
    messages: transcript(['说短点', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{
        // 枚举字段的词表外取值：模型分类失败，槽位池会拒
        field: 'response_length',
        value: '短一些',
        relation: 'same',
        quote: '说短点',
      }],
    }),
  })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.equal(pool.list('u1').length, 0)
  assert.deepEqual(reasons(auditRecords), ['pool_rejected'])
})

test('never stores sensitive content', async () => {
  const { pool, observer, auditRecords } = harness({
    messages: transcript(['我的密码是 hunter2333', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{
        field: 'special_skills',
        value: '密码 hunter2333',
        relation: 'same',
        quote: '我的密码是 hunter2333',
      }],
    }),
  })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.equal(pool.list('u1').length, 0)
  assert.deepEqual(reasons(auditRecords), ['sensitive'])
})

test('passes the relation through to the pool', async () => {
  const { pool, observer } = harness({
    messages: transcript(['我教的是高中语文', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{
        field: 'occupation',
        value: '高中语文老师',
        relation: 'refine',
        quote: '我教的是高中语文',
      }],
    }),
  })
  pool.observe({ ownerId: 'u1', sessionId: 's0', field: 'occupation', value: '老师' })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  const slots = pool.list('u1')
  assert.equal(slots.length, 1, 'refine 必须就地更新，不能产生第二个槽位')
  assert.equal(slots[0].value, '高中语文老师')
  assert.equal(slots[0].confirm, 2, 'refine 要保留已攒的确认次数')
})

// 不给现值，模型没法区分「精化」和「矛盾」。对标 LangMem 把 existing 一起喂回。
test('includes the known profile but never the assistant turns', async () => {
  const { pool, observer, calls } = harness({
    messages: transcript(['我教语文', '二', '三', '四'], ['要不要我列个提纲']),
  })
  pool.observe({ ownerId: 'u1', sessionId: 's0', field: 'occupation', value: '老师' })
  // 只有【已晋升】的值才算已知画像，所以这里要先转 active
  pool.markPromoted('u1', 'occupation')

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  const [{ system, user }] = calls
  assert.match(user, /## 当前已知画像/)
  assert.match(user, /occupation: 老师/)
  assert.match(user, /response_length: （未知）/)
  assert.match(user, /用户: 我教语文/)
  // 助手轮刻意不给：它是污染源，模型会从助手说了什么反推用户偏好。
  // 代价是「太长了」这类脱离上下文读不懂的话推不出来 —— 那本来就该答 unknown。
  assert.doesNotMatch(user, /助手:/, '助手轮不得进入观察器的输入')
  assert.doesNotMatch(user, /要不要我列个提纲/)
  assert.match(system, /答不出来就填 unknown/)
})

test('hides tentative slots from the prompt so confirmations can accumulate', async () => {
  // 这条锁死一个防死锁设计。把还在攒确认的候选当「已知画像」报给模型，模型就
  // 不再报同一个值，confirm 卡在 1 而门槛要 2 —— 晋升机制整体失效且不报错。
  // 实测：明明三场都说「我用 Rust」，四轮里只有一轮攒够；候选隐形后变 3/4。
  const { pool, observer, calls } = harness({
    messages: transcript(['我平时写 Rust', '二', '三', '四']),
  })
  pool.observe({ ownerId: 'u1', sessionId: 's0', field: 'special_skills', value: 'Rust' })
  assert.equal(pool.list('u1')[0].state, 'tentative')

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  const [{ user }] = calls
  // 只看画像那一段：转写里本来就有「我平时写 Rust」，整篇搜是搜不出结论的
  const snapshot = user.split('##').find(part => part.startsWith(' 当前已知画像'))
  assert.doesNotMatch(snapshot, /Rust/, 'tentative 候选不得出现在已知画像里')
  assert.match(user, /special_skills: （未知）/)
})

test('rejects a conclusion that cannot be anchored in its own quote', async () => {
  // quote 逐字校验只保证「这句话用户真说过」，不保证「从这句话推得出这个结论」。
  // 实测 4 场里 3 场栽在后者上，每条都有合法 quote。判据是「改写」与「跳跃」之分：
  // 结论的字面成分能在证据里找到落点才算改写。
  // 载体用 occupation 而不是 response_*：后者要先过「指向助手」那道门，
  // 会把这条测试短路成 quote_not_about_interaction，测不到锚定判据本身。
  const { pool, observer, auditRecords } = harness({
    messages: transcript(['所有权那块我不太确定', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{
        field: 'occupation',
        value: '程序员',
        relation: 'same',
        quote: '所有权那块我不太确定',
      }],
    }),
  })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.equal(pool.list('u1').length, 0)
  assert.deepEqual(reasons(auditRecords), ['value_not_anchored'])
})

test('accepts a conclusion whose wording is anchored in the quote', async () => {
  const { pool, observer } = harness({
    messages: transcript(['我在市一中教高中语文', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{
        field: 'occupation',
        // 「高中语文」在原话里 —— 这是改写，不是跳跃
        value: '高中语文老师',
        relation: 'same',
        quote: '我在市一中教高中语文',
      }],
    }),
  })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.deepEqual(pool.list('u1').map(slot => slot.value), ['高中语文老师'])
})

test('rejects a value that merely parrots the quote', async () => {
  // 同样用 occupation 做载体，避开「指向助手」的前置判据
  const { pool, observer, auditRecords } = harness({
    messages: transcript(['我在市一中教高中语文', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{
        field: 'occupation',
        // 值就是原话本身 —— 模型在复读，没有提取出特征
        value: '我在市一中教高中语文',
        relation: 'same',
        quote: '我在市一中教高中语文',
      }],
    }),
  })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.equal(pool.list('u1').length, 0)
  assert.deepEqual(reasons(auditRecords), ['value_parrots_quote'])
})

test('rejects an interaction preference inferred from talk about content', async () => {
  // 「题干别太长」说的是题目，不是助手的回话方式。枚举字段的值是英文标签，
  // 锚定判据对它无效，所以改判这句话是否冲着助手说。
  const { pool, observer, auditRecords } = harness({
    messages: transcript(['题干别太长，学生读着累', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{
        field: 'response_length',
        value: 'brief',
        relation: 'same',
        quote: '题干别太长，学生读着累',
      }],
    }),
  })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.equal(pool.list('u1').length, 0)
  assert.deepEqual(reasons(auditRecords), ['quote_not_about_interaction'])
})

test('accepts an imperative interaction directive without a second person', async () => {
  // 真实指令里大量是省略第二人称的祈使句。只匹配「说话 / 回答」这类长词会把
  // 它们全部误杀 —— 实测 17 个 case 里这么写只对 13 个。
  const { pool, observer } = harness({
    messages: transcript(['长话短说，别绕弯子', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{
        field: 'response_length',
        value: 'brief',
        relation: 'same',
        quote: '长话短说，别绕弯子',
      }],
    }),
  })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.deepEqual(pool.list('u1').map(slot => slot.value), ['brief'])
})

test('splits a merged list value so each item is anchored on its own', async () => {
  // list 字段的槽位 key 是 field::value，「Rust、Python」这样一条合并值会变成
  // 独立槽位，与「Rust」不是同一个，谁的 confirm 都攒不够。拆开后每项各自过
  // 锚定校验，于是本场没提到的那些会被自然滤掉。
  const { pool, observer } = harness({
    messages: transcript(['我平时主要写 Rust 和一点 Python', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{
        field: 'special_skills',
        value: 'Rust、Python、Haskell',
        relation: 'same',
        quote: '我平时主要写 Rust 和一点 Python',
      }],
    }),
  })

  await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  // Haskell 不在原话里，只有前两项落地
  assert.deepEqual(pool.list('u1').map(slot => slot.value), ['Rust', 'Python'])
})

// ── 问答形态：unknown / basis / vs_known ──

test('answers 形态：unknown 字段被静默丢弃，不记 skip', async () => {
  // 每场四个字段本来就有近一半是 unknown，逐条记 skip 会把审计刷满，
  // 真正的异常（empty_value、quote 对不上）反而看不见了。
  const { pool, observer, auditRecords } = harness({
    messages: transcript(['我在市一中教高中语文', '二', '三', '四']),
    reply: JSON.stringify({
      answers: [
        { field: 'occupation', value: '高中语文老师', quote: '我在市一中教高中语文', basis: '用户自述在中学教语文', vs_known: 'first_time' },
        { field: 'special_skills', value: 'unknown', quote: '', basis: '', vs_known: '' },
        { field: 'response_length', value: 'unknown', quote: '', basis: '', vs_known: '' },
        { field: 'response_style', value: 'Unknown', quote: '', basis: '', vs_known: '' },
      ],
    }),
  })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  assert.deepEqual(pool.list('u1').map(slot => slot.value), ['高中语文老师'])
  // 只有一条 observed，三条 unknown 不留痕
  assert.deepEqual(auditRecords.map(event => event.op), ['observe'])
})

test('answers 形态：空 value 仍然记 empty_value，不当作 unknown', async () => {
  // 空串是模型输出残缺，属于异常；和「主动认不知道」混为一谈会把异常藏掉。
  const { pool, observer, auditRecords } = harness({
    messages: transcript(['我在市一中教高中语文', '二', '三', '四']),
    reply: JSON.stringify({
      answers: [{ field: 'occupation', value: '', quote: '我在市一中教高中语文', basis: 'x', vs_known: 'first_time' }],
    }),
  })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  assert.equal(pool.list('u1').length, 0)
  assert.deepEqual(reasons(auditRecords), ['empty_value'])
})

test('basis 落进证据，供日后解释这条画像的来历', async () => {
  const { pool, observer } = harness({
    messages: transcript(['我平时主要写 Rust', '二', '三', '四']),
    reply: JSON.stringify({
      answers: [{
        field: 'special_skills',
        value: 'Rust',
        quote: '我平时主要写 Rust',
        basis: '用户说自己平时主要用它，属于已掌握而非正在学',
        vs_known: 'first_time',
      }],
    }),
  })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  const [slot] = pool.list('u1')
  assert.equal(slot.evidence.length, 1)
  assert.equal(slot.evidence[0].quote, '我平时主要写 Rust')
  assert.match(slot.evidence[0].basis, /已掌握/)
})

test('basis 超长被截断而不是整条丢弃', async () => {
  const { pool, observer } = harness({
    messages: transcript(['我平时主要写 Rust', '二', '三', '四']),
    reply: JSON.stringify({
      answers: [{
        field: 'special_skills',
        value: 'Rust',
        quote: '我平时主要写 Rust',
        basis: '啊'.repeat(300),
        vs_known: 'first_time',
      }],
    }),
  })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  const [slot] = pool.list('u1')
  assert.equal([...slot.evidence[0].basis].length, 80)
})

test('缺 basis 也照样收下 —— 判据是加分项不是准入条件', async () => {
  const { pool, observer } = harness({
    messages: transcript(['我平时主要写 Rust', '二', '三', '四']),
    reply: JSON.stringify({
      answers: [{ field: 'special_skills', value: 'Rust', quote: '我平时主要写 Rust', vs_known: 'first_time' }],
    }),
  })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  assert.deepEqual(pool.list('u1').map(slot => slot.value), ['Rust'])
  assert.equal(pool.list('u1')[0].evidence[0].basis, '')
})

test('vs_known 映射到槽位关系：first_time 与 same 都算又一次确认', async () => {
  const { pool, observer } = harness({
    messages: transcript(['我平时主要写 Rust', '二', '三', '四']),
    reply: JSON.stringify({
      answers: [{ field: 'special_skills', value: 'Rust', quote: '我平时主要写 Rust', basis: 'x', vs_known: 'same' }],
    }),
  })
  pool.observe({ ownerId: 'u1', sessionId: 's0', field: 'special_skills', value: 'Rust' })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  const [slot] = pool.list('u1')
  assert.equal(slot.confirm, 2, 'same 应当把确认次数推到 2')
  assert.equal(new Set(slot.sessions).size, 2)
})

test('vs_known=refine 换值但保住确认次数', async () => {
  const { pool, observer } = harness({
    messages: transcript(['我在市一中教高中语文', '二', '三', '四']),
    reply: JSON.stringify({
      answers: [{ field: 'occupation', value: '高中语文老师', quote: '我在市一中教高中语文', basis: 'x', vs_known: 'refine' }],
    }),
  })
  pool.observe({ ownerId: 'u1', sessionId: 's0', field: 'occupation', value: '老师' })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  const [slot] = pool.list('u1')
  assert.equal(slot.value, '高中语文老师')
  assert.equal(slot.confirm, 2)
})

test('vs_known=contradict 换值并把确认次数打回 1', async () => {
  const { pool, observer } = harness({
    messages: transcript(['我现在转行做程序员了', '二', '三', '四']),
    reply: JSON.stringify({
      answers: [{ field: 'occupation', value: '程序员', quote: '我现在转行做程序员了', basis: 'x', vs_known: 'contradict' }],
    }),
  })
  pool.observe({ ownerId: 'u1', sessionId: 's0', field: 'occupation', value: '老师' })
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'occupation', value: '老师' })
  pool.markPromoted('u1', 'occupation')

  await observer.run({ ownerId: 'u1', sessionId: 's2', messages: observer.conversationSync.list() })
  const [slot] = pool.list('u1')
  assert.equal(slot.value, '程序员')
  assert.equal(slot.confirm, 1, '矛盾等于重新开始')
  assert.equal(slot.state, 'tentative', '已生效的值遇到矛盾要退回待确认')
})

test('vs_known 写了不认识的词时按值本身推断关系', async () => {
  const { pool, observer } = harness({
    messages: transcript(['我现在做程序员', '二', '三', '四']),
    reply: JSON.stringify({
      answers: [{ field: 'occupation', value: '程序员', quote: '我现在做程序员', basis: 'x', vs_known: '换工作了' }],
    }),
  })
  pool.observe({ ownerId: 'u1', sessionId: 's0', field: 'occupation', value: '老师' })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  const [slot] = pool.list('u1')
  // relation 解析不出来 → 交给槽位池按「值变了就是矛盾」兜底
  assert.equal(slot.value, '程序员')
  assert.equal(slot.confirm, 1)
})

test('answers 与 observations 两种键名都能解析', async () => {
  // 旧键名留着是为了不让任何还在用旧格式的调用方硬失败
  const { pool, observer } = harness({
    messages: transcript(['我平时主要写 Rust', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{ field: 'special_skills', value: 'Rust', relation: 'same', quote: '我平时主要写 Rust' }],
    }),
  })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  assert.deepEqual(pool.list('u1').map(slot => slot.value), ['Rust'])
})

test('两种键名都没有时报错，且不会打断会话关闭', async () => {
  const { pool, observer, auditRecords } = harness({
    messages: transcript(['我平时主要写 Rust', '二', '三', '四']),
    reply: JSON.stringify({ result: 'ok' }),
  })

  await observer.maybeRun({ ownerId: 'u1', sessionId: 's1' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pool.list('u1').length, 0)
  assert.equal(auditRecords.at(-1).op, 'error')
})

test('response_style 也要过「指向助手」这道门，尽管它是自由文本', async () => {
  // 判据一开始按值形态（枚举/自由文本）分支，于是 response_style 绕过了这道门。
  // 实测漏进 response_style=「题干和选项精简」，证据是「题干别太长，学生读着累」
  // —— 说的明明是题目。两个 response_* 是同一类偏好，判据必须同一套。
  const { pool, observer, auditRecords } = harness({
    messages: transcript(['题干别太长，学生读着累', '选项也精简一些', '三', '四']),
    reply: JSON.stringify({
      answers: [{
        field: 'response_style',
        // 刻意让它过得了锚定（题干/选项/精简 都在原话里）也不是复读
        value: '题干和选项精简，避免冗长',
        quote: '题干别太长，学生读着累',
        basis: '用户要求精简',
        vs_known: 'first_time',
      }],
    }),
  })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  assert.equal(pool.list('u1').length, 0)
  assert.deepEqual(reasons(auditRecords), ['quote_not_about_interaction'])
})

test('response_style 由指向助手的话产生时照常收下', async () => {
  const { pool, observer } = harness({
    messages: transcript(['你回答的时候先说结论', '再展开细节', '三', '四']),
    reply: JSON.stringify({
      answers: [{
        field: 'response_style',
        value: '先说结论再展开',
        quote: '你回答的时候先说结论',
        basis: '用户直接要求助手先给结论',
        vs_known: 'first_time',
      }],
    }),
  })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  assert.deepEqual(pool.list('u1').map(slot => slot.value), ['先说结论再展开'])
})

test('事实类字段不受「指向助手」约束', async () => {
  // occupation / special_skills 是用户在陈述自己，没有理由要求他冲着助手说。
  const { pool, observer } = harness({
    messages: transcript(['我在市一中教高中语文', '二', '三', '四']),
    reply: JSON.stringify({
      answers: [{
        field: 'occupation',
        value: '高中语文老师',
        quote: '我在市一中教高中语文',
        basis: '用户自述任教科目',
        vs_known: 'first_time',
      }],
    }),
  })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  assert.deepEqual(pool.list('u1').map(slot => slot.value), ['高中语文老师'])
})

test('splits a quote the model stitched from several turns', async () => {
  // 模型常把多句话拼成一个 quote。拼接串本身可能通不过 quote 校验，
  // 那会让整条观察作废 —— 实测三场会话里第 1 场因此收下 0 条，
  // 跨会话确认从源头就断了。拆开之后每个值各自去找能支撑它的那一段。
  const { pool, observer } = harness({
    messages: transcript([
      '我平时主要写 Rust',
      '帮我看看这段 async 代码',
      '所有权那块我不太确定',
      '四',
    ]),
    reply: JSON.stringify({
      answers: [{
        field: 'special_skills',
        value: 'Rust、async 编程、所有权机制',
        quote: '我平时主要写 Rust\n帮我看看这段 async 代码\n所有权那块我不太确定',
        basis: 'x',
        vs_known: 'first_time',
      }],
    }),
  })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  const slots = pool.list('u1')
  // 真正修好的是「拼接不再让整条作废」：Rust 拿到了自述那一段
  const rust = slots.find(slot => slot.value === 'Rust')
  assert.ok(rust, '拼接的 quote 不该让整条观察作废')
  assert.equal(rust.evidence[0].quote, '我平时主要写 Rust', '应当拆回自述那一段')

  // 已知局限：锚定判据只看字面重合，挡不住「求助句被当成掌握的证据」——
  // 「帮我看看这段 async 代码」字面上含 async，于是 async 编程 也过得去。
  // 这一类已试过三种解法并全部否证（basis 推断词 3/4、quote 自述句式 4/6、
  // 排除求助句 5/6，都不如不加）。special_skills 的取向是宁错勿漏：
  // 档案里多一行不精确的技能，代价远小于学不到。
  const asyncSlot = slots.find(slot => slot.value === 'async 编程')
  if (asyncSlot) {
    assert.equal(asyncSlot.evidence[0].quote, '帮我看看这段 async 代码')
  }
})

test('leaves a single-sentence quote untouched', async () => {
  const { pool, observer } = harness({
    messages: transcript(['我平时主要写 Rust', '二', '三', '四']),
    reply: JSON.stringify({
      answers: [{
        field: 'special_skills',
        value: 'Rust',
        quote: '我平时主要写 Rust',
        basis: 'x',
        vs_known: 'first_time',
      }],
    }),
  })

  await observer.run({ ownerId: 'u1', sessionId: 's1', messages: observer.conversationSync.list() })
  const [slot] = pool.list('u1')
  assert.equal(slot.evidence[0].quote, '我平时主要写 Rust', '单句 quote 不该被改动')
})

test('skips a session with too few user turns', () => {
  const { observer, calls } = harness({ messages: transcript(['一', '二', '三']) })
  assert.equal(observer.maybeRun({ ownerId: 'u1', sessionId: 's1' }), null)
  assert.equal(calls.length, 0)
})

test('stays disabled without an llm call or a pool', () => {
  const bare = new ProfileObserver({})
  assert.equal(bare.enabled(), false)
  assert.equal(bare.maybeRun({ ownerId: 'u1', sessionId: 's1' }), null)
})

test('swallows a malformed model reply and records the error', async () => {
  const auditRecords = []
  const { pool, observer } = harness({
    reply: '这不是 JSON',
    auditRecords,
  })
  await observer.maybeRun({ ownerId: 'u1', sessionId: 's1' })
  assert.equal(pool.list('u1').length, 0)
  assert.equal(auditRecords.some(entry => entry.op === 'error'), true)
})

test('tolerates a fenced json reply', async () => {
  const { pool, observer } = harness({
    messages: transcript(['我在学校教语文', '二', '三', '四']),
    reply: '```json\n{"observations":[{"field":"occupation","value":"语文老师","relation":"same","quote":"我在学校教语文"}]}\n```',
  })
  await observer.maybeRun({ ownerId: 'u1', sessionId: 's1' })
  assert.equal(pool.list('u1')[0].value, '语文老师')
})

test('caps how many observations one run can accept', async () => {
  const { observer } = harness({
    messages: transcript(['我懂一二三四五六七', '二', '三', '四']),
    reply: JSON.stringify({
      observations: ['一', '二', '三', '四', '五', '六', '七'].map(value => ({
        field: 'special_skills',
        value,
        relation: 'same',
        quote: '我懂一二三四五六七',
      })),
    }),
  })
  const accepted = await observer.run({
    ownerId: 'u1',
    sessionId: 's1',
    messages: observer.conversationSync.list(),
  })
  assert.equal(accepted.length, 5)
})

test('records an observe audit entry with the accepted detail', async () => {
  const auditRecords = []
  const { observer } = harness({
    messages: transcript(['我在学校教语文', '二', '三', '四']),
    reply: JSON.stringify({
      observations: [{
        field: 'occupation',
        value: '语文老师',
        relation: 'same',
        quote: '我在学校教语文',
      }],
    }),
    auditRecords,
  })
  await observer.maybeRun({ ownerId: 'u1', sessionId: 's1' })

  const entry = auditRecords.find(item => item.op === 'observe')
  assert.ok(entry)
  assert.equal(entry.scope, 'user')
  assert.deepEqual(entry.detail, [{
    field: 'occupation',
    value: '语文老师',
    relation: 'same',
    confirm: 1,
  }])
})

test('records a skip when the model finds nothing', async () => {
  const auditRecords = []
  const { observer } = harness({ auditRecords })
  await observer.maybeRun({ ownerId: 'u1', sessionId: 's1' })
  assert.equal(
    auditRecords.some(entry => entry.op === 'skip' && entry.reason === 'no_observation'),
    true,
  )
})
