import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SESSION_DIGEST_LIMITS,
  SessionDigestPool,
  describeWhen,
  normaliseTopics,
  normaliseWork,
} from '../src/conversation/session-digest.mjs'

const OWNER = 'user_personal'
const NOW = Date.parse('2026-08-25T12:00:00Z')
const DAY = 86_400_000

function pool(overrides = {}) {
  return new SessionDigestPool({ now: () => NOW, ...overrides })
}

function withFile(run) {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-digest-'))
  try {
    return run(join(directory, 'digests.json'), directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('records a session and finds it again by topic', () => {
  const digests = pool()
  digests.record({
    ownerId: OWNER,
    sessionId: 's_a',
    topics: ['LOCOMO', '压缩评测'],
    gist: '对比五个压缩方案，two_tier+V2 最优',
    turns: 42,
  })
  const [found] = digests.search({ ownerId: OWNER, keyword: 'LOCOMO' })
  assert.equal(found.session, 's_a')
  assert.equal(found.turns, 42)
  assert.deepEqual(found.topics, ['LOCOMO', '压缩评测'])
})

test('matches a topic despite punctuation and case drift in the query', () => {
  const digests = pool()
  digests.record({ ownerId: OWNER, sessionId: 's_a', topics: ['LOCOMO 评测'], gist: '跑了一轮' })
  // ASR 转写的标点和大小写很随意，用户说出口的词不会和记录逐字相同
  for (const keyword of ['locomo', 'LOCOMO，', 'locomo 评测', '评测']) {
    assert.equal(
      digests.search({ ownerId: OWNER, keyword }).length,
      1,
      `关键词「${keyword}」应当命中`,
    )
  }
})

test('ranks a topic hit above a gist-only hit', () => {
  const digests = pool()
  digests.record({
    ownerId: OWNER,
    sessionId: 's_gist',
    topics: ['记忆架构'],
    gist: '顺带提了一下 LOCOMO',
  })
  digests.record({
    ownerId: OWNER,
    sessionId: 's_topic',
    topics: ['LOCOMO'],
    gist: '专门跑了一轮',
  })
  const found = digests.search({ ownerId: OWNER, keyword: 'LOCOMO' })
  // 用户说出口的词更可能是话题名，命中 topics 的更相关
  assert.deepEqual(found.map(item => item.session), ['s_topic', 's_gist'])
})

test('returns the most recent sessions when no keyword is given', () => {
  const digests = pool()
  for (const [index, session] of ['s_old', 's_mid', 's_new'].entries()) {
    digests.record({
      ownerId: OWNER,
      sessionId: session,
      topics: [`话题${index}`],
      gist: '聊过',
    })
  }
  const found = digests.search({ ownerId: OWNER, limit: 2 })
  assert.equal(found.length, 2)
  assert.ok(found[0].at >= found[1].at, '按时间倒序')
})

test('caps the gist length and the topic count', () => {
  const digests = pool()
  const recorded = digests.record({
    ownerId: OWNER,
    sessionId: 's_a',
    topics: ['一', '二', '三', '四', '五', '六', '七'],
    gist: '很长的要点'.repeat(40),
  })
  assert.equal(recorded.topics.length, SESSION_DIGEST_LIMITS.MAX_TOPICS)
  assert.equal(
    [...recorded.gist].length,
    SESSION_DIGEST_LIMITS.MAX_GIST_CHARS,
    '只存档 1 的一句要点，绝不能变成完整摘要留存',
  )
})

test('never stores sensitive content', () => {
  const digests = pool()
  assert.equal(
    digests.record({
      ownerId: OWNER,
      sessionId: 's_a',
      topics: ['登录'],
      gist: '密码是 hunter2',
    }),
    null,
  )
  assert.equal(digests.count(OWNER), 0)
  // 敏感话题被剔掉，其余照常保留
  const recorded = digests.record({
    ownerId: OWNER,
    sessionId: 's_b',
    topics: ['api_key 配置', '部署'],
    gist: '讨论了部署流程',
  })
  assert.deepEqual(recorded.topics, ['部署'])
})

test('overwrites instead of appending when the same session is recorded twice', () => {
  const digests = pool()
  digests.record({ ownerId: OWNER, sessionId: 's_a', topics: ['第一次'], gist: '早先的' })
  digests.record({ ownerId: OWNER, sessionId: 's_a', topics: ['第二次'], gist: '后来的' })
  // 重连会让同一场触发两次关闭钩子，不能把列表灌满
  assert.equal(digests.count(OWNER), 1)
  assert.deepEqual(digests.search({ ownerId: OWNER })[0].topics, ['第二次'])
})

test('has() lets the summariser skip a session it already recorded', () => {
  const digests = pool()
  assert.equal(digests.has({ ownerId: OWNER, sessionId: 's_a' }), false)
  digests.record({ ownerId: OWNER, sessionId: 's_a', topics: ['话题'], gist: '要点' })
  assert.equal(digests.has({ ownerId: OWNER, sessionId: 's_a' }), true)
})

test('drops a session with neither topics nor gist', () => {
  const digests = pool()
  assert.equal(
    digests.record({ ownerId: OWNER, sessionId: 's_a', topics: [], gist: '  ' }),
    null,
  )
  assert.equal(
    digests.record({ ownerId: OWNER, sessionId: '', topics: ['话题'], gist: '要点' }),
    null,
  )
})

test('keeps only the newest sessions per owner', () => {
  const digests = pool({ maxPerOwner: 3 })
  for (let index = 0; index < 8; index += 1) {
    digests.record({
      ownerId: OWNER,
      sessionId: `s_${index}`,
      topics: [`话题${index}`],
      gist: '聊过',
    })
  }
  assert.equal(digests.count(OWNER), 3)
})

test('forgets sessions past the retention window', () => {
  let clock = NOW - 100 * DAY
  const digests = new SessionDigestPool({ now: () => clock })
  digests.record({ ownerId: OWNER, sessionId: 's_old', topics: ['很久以前'], gist: '聊过' })
  clock = NOW
  digests.record({ ownerId: OWNER, sessionId: 's_new', topics: ['最近'], gist: '聊过' })
  assert.deepEqual(
    digests.search({ ownerId: OWNER }).map(item => item.session),
    ['s_new'],
  )
})

test('keeps owners apart', () => {
  const digests = pool()
  digests.record({ ownerId: 'a', sessionId: 's_a', topics: ['甲的话题'], gist: '甲' })
  digests.record({ ownerId: 'b', sessionId: 's_b', topics: ['乙的话题'], gist: '乙' })
  assert.deepEqual(digests.search({ ownerId: 'a', keyword: '乙的话题' }), [])
  assert.equal(digests.search({ ownerId: 'b', keyword: '乙的话题' }).length, 1)
})

test('clamps the requested limit', () => {
  const digests = pool()
  for (let index = 0; index < 20; index += 1) {
    digests.record({
      ownerId: OWNER,
      sessionId: `s_${index}`,
      topics: ['话题'],
      gist: '聊过',
    })
  }
  assert.equal(digests.search({ ownerId: OWNER, limit: 999 }).length, SESSION_DIGEST_LIMITS.MAX_LIMIT)
  assert.equal(digests.search({ ownerId: OWNER, limit: 0 }).length, SESSION_DIGEST_LIMITS.DEFAULT_LIMIT)
  assert.equal(digests.search({ ownerId: OWNER, limit: 2 }).length, 2)
})

test('survives a restart through the snapshot file', () => {
  withFile(filePath => {
    const first = pool({ filePath })
    first.record({
      ownerId: OWNER,
      sessionId: 's_a',
      topics: ['LOCOMO'],
      gist: '跑了一轮',
      turns: 12,
    })
    const restored = pool({ filePath }).search({ ownerId: OWNER, keyword: 'LOCOMO' })
    assert.equal(restored.length, 1)
    assert.equal(restored[0].turns, 12)
    assert.match(readFileSync(filePath, 'utf8'), /"version": 1/)
  })
})

test('discards individual malformed entries instead of the whole file', () => {
  withFile(filePath => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      owners: {
        [OWNER]: [
          { session: 's_ok', at: NOW - DAY, topics: ['好的'], gist: '要点' },
          { session: 's_no_at', topics: ['缺时间'], gist: '要点' },
          { session: '', at: NOW, topics: ['缺会话'], gist: '要点' },
          'not-an-object',
        ],
      },
    }))
    const restored = pool({ filePath })
    assert.deepEqual(
      restored.search({ ownerId: OWNER }).map(item => item.session),
      ['s_ok'],
    )
  })
})

test('quarantines a corrupt file and keeps serving an empty pool', () => {
  withFile(filePath => {
    writeFileSync(filePath, '{ not json')
    const warnings = []
    const digests = pool({ filePath, onWarning: warning => warnings.push(warning) })
    assert.deepEqual(digests.search({ ownerId: OWNER }), [])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].message, /会话摘要/)
    // 隔离后仍能继续记录
    assert.ok(digests.record({ ownerId: OWNER, sessionId: 's_a', topics: ['话题'], gist: '要点' }))
  })
})

test('works with no file configured at all', () => {
  const digests = pool()
  assert.ok(digests.record({ ownerId: OWNER, sessionId: 's_a', topics: ['话题'], gist: '要点' }))
  assert.equal(digests.search({ ownerId: OWNER }).length, 1)
  assert.equal(digests.health().persistenceEnabled, false)
})

test('normaliseTopics tolerates junk input', () => {
  assert.deepEqual(normaliseTopics(null), [])
  assert.deepEqual(normaliseTopics('不是数组'), [])
  assert.deepEqual(normaliseTopics([null, '', '  ', '有效']), ['有效'])
  // 同一话题的不同写法只留一个
  assert.deepEqual(normaliseTopics(['LOCOMO', 'locomo', 'LOCOMO！']), ['LOCOMO'])
})

test('describeWhen degrades to coarser wording and keeps the exact date', () => {
  const at = days => describeWhen(NOW - days * DAY, { now: NOW, timeZone: 'Asia/Shanghai' })
  assert.equal(at(0).when, '今天')
  assert.equal(at(1).when, '昨天')
  assert.equal(at(4).when, '4 天前')
  assert.equal(at(9).when, '上周')
  assert.equal(at(20).when, '2 周前')
  assert.equal(at(70).when, '2 个月前')
  assert.equal(at(1).days_ago, 1)
  assert.match(at(1).date, /^\d{4}-\d{2}-\d{2}$/)
})

test('describeWhen uses the client time zone, not the server one', () => {
  // 同一对时间戳：上海跨了午夜（23:00 → 次日 01:00），洛杉矶没跨（08:00 → 10:00）
  const at = Date.parse('2026-08-25T15:00:00Z')
  const now = Date.parse('2026-08-25T17:00:00Z')
  assert.equal(describeWhen(at, { now, timeZone: 'Asia/Shanghai' }).when, '昨天')
  assert.equal(describeWhen(at, { now, timeZone: 'America/Los_Angeles' }).when, '今天')
})

test('describeWhen falls back to UTC on an invalid time zone', () => {
  const described = describeWhen(NOW - DAY, { now: NOW, timeZone: 'Not/AZone' })
  assert.equal(described.when, '昨天')
})

test('stores the work dispatched in a session', () => {
  const digests = pool()
  const recorded = digests.record({
    ownerId: OWNER,
    sessionId: 's_a',
    topics: ['压缩评测'],
    gist: '让助手跑一轮',
    work: [{ id: 't1', objective: '把压缩评测跑一遍' }],
  })
  assert.deepEqual(recorded.work, [{ id: 't1', objective: '把压缩评测跑一遍' }])
})

test('never stores a work status —— it would freeze', () => {
  const digests = pool()
  const recorded = digests.record({
    ownerId: OWNER,
    sessionId: 's_a',
    topics: ['话题'],
    gist: '要点',
    // 调用方就算传了 status 也必须被丢掉：摘要是冻结的，状态是活的。
    // 存下来的 running 过几天就是错的，而且不报错。
    work: [{ id: 't1', objective: '那件事', status: 'running' }],
  })
  assert.deepEqual(Object.keys(recorded.work[0]).sort(), ['id', 'objective'])
})

test('a session with only work and no topics is still worth recording', () => {
  const digests = pool()
  // 用户只说「帮我跑一下那个」，模型摘不出话题，但活确实派了
  const recorded = digests.record({
    ownerId: OWNER,
    sessionId: 's_a',
    topics: [],
    gist: '',
    work: [{ id: 't1', objective: '把压缩评测跑一遍' }],
  })
  assert.ok(recorded)
  assert.equal(digests.count(OWNER), 1)
})

test('finds a session by the objective of its work', () => {
  const digests = pool()
  digests.record({
    ownerId: OWNER,
    sessionId: 's_a',
    topics: ['闲聊'],
    gist: '随便聊聊',
    work: [{ id: 't1', objective: '整理季度报表' }],
  })
  // 「季度报表」既不在 topics 也不在 gist 里
  assert.equal(digests.search({ ownerId: OWNER, keyword: '季度报表' }).length, 1)
})

test('ranks a topic hit above a work hit above a gist-only hit', () => {
  const digests = pool()
  digests.record({ ownerId: OWNER, sessionId: 's_gist', topics: ['甲'], gist: '提了下报表' })
  digests.record({
    ownerId: OWNER,
    sessionId: 's_work',
    topics: ['乙'],
    gist: '无关',
    work: [{ id: 't1', objective: '整理报表' }],
  })
  digests.record({ ownerId: OWNER, sessionId: 's_topic', topics: ['报表'], gist: '无关' })
  assert.deepEqual(
    digests.search({ ownerId: OWNER, keyword: '报表' }).map(item => item.session),
    ['s_topic', 's_work', 's_gist'],
  )
})

test('caps and sanitises the work list', () => {
  const digests = pool()
  const recorded = digests.record({
    ownerId: OWNER,
    sessionId: 's_a',
    topics: ['话题'],
    gist: '要点',
    work: [
      ...Array.from({ length: 9 }, (_, index) => ({ id: `t${index}`, objective: `活${index}` })),
      { id: 'dup', objective: '重复的' },
      { id: 'dup', objective: '重复的' },
      { objective: '  ' },
      { id: 'secret', objective: '密码是 hunter2' },
    ],
  })
  assert.equal(recorded.work.length, SESSION_DIGEST_LIMITS.MAX_WORK_ITEMS)
  assert.ok(!recorded.work.some(item => item.objective.includes('hunter2')))
})

test('normaliseWork tolerates junk input', () => {
  assert.deepEqual(normaliseWork(null), [])
  assert.deepEqual(normaliseWork('不是数组'), [])
  assert.deepEqual(normaliseWork([null, {}, { objective: '' }]), [])
  // 没有 id 也收，只是日后查不到状态
  assert.deepEqual(normaliseWork([{ objective: '那件事' }]), [{ objective: '那件事' }])
})

test('reads back a digest written before the work field existed', () => {
  withFile(filePath => {
    // v1 的老文件没有 work 字段，不该被判为无效整条丢掉
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      owners: { [OWNER]: [{ session: 's_old', at: NOW - DAY, topics: ['旧话题'], gist: '旧要点' }] },
    }))
    const [restored] = pool({ filePath }).search({ ownerId: OWNER })
    assert.equal(restored.session, 's_old')
    assert.deepEqual(restored.work, [])
  })
})
