import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CANDIDATE_DEFAULTS,
  PROFILE_FIELDS,
  PreferenceCandidatePool,
  evaluateSlot,
  isSameFieldLabel,
  renderLabel,
} from '../src/conversation/preference-candidates.mjs'

const DAY = 24 * 60 * 60_000

function build({ startAt = Date.parse('2026-08-01T09:00:00Z') } = {}) {
  let clock = startAt
  const pool = new PreferenceCandidatePool({ now: () => clock })
  return {
    pool,
    advance(ms) { clock += ms },
    at() { return clock },
  }
}

test('records a first observation as tentative and not yet promotable', () => {
  const { pool } = build()
  const slot = pool.observe({
    ownerId: 'u1',
    sessionId: 's1',
    field: 'response_length',
    value: 'brief',
    quote: '你说简短点',
  })
  assert.equal(slot.field, 'response_length')
  assert.equal(slot.value, 'brief')
  assert.equal(slot.confirm, 1)
  assert.equal(slot.state, 'tentative')
  assert.equal(pool.promotable('u1').length, 0)
})

test('confirms across sessions until the slot is promotable', () => {
  const { pool } = build()
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'response_length', value: 'brief' })
  // 同一会话内再说一次：确认次数涨，但会话数不涨
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'response_length', value: 'brief' })
  let [slot] = pool.list('u1')
  assert.equal(slot.confirm, 2)
  assert.deepEqual(slot.sessions, ['s1'])
  assert.deepEqual(slot.missing, ['sessions'])
  assert.equal(pool.promotable('u1').length, 0)

  // 换一个会话才凑齐
  pool.observe({ ownerId: 'u1', sessionId: 's2', field: 'response_length', value: 'brief' })
  ;[slot] = pool.list('u1')
  assert.equal(slot.confirm, 3)
  assert.deepEqual(slot.sessions, ['s1', 's2'])
  assert.deepEqual(slot.missing, [])
  assert.equal(pool.promotable('u1').length, 1)
})

// 枚举字段的取值空间是封闭的，观察器给出词表外的值说明分类失败，
// 宁可丢掉这次观察也不要让脏值进槽位。
test('rejects an out-of-vocabulary value for an enumerated field', () => {
  const { pool } = build()
  assert.equal(
    pool.observe({
      ownerId: 'u1',
      sessionId: 's1',
      field: 'response_length',
      value: '短一点吧',
    }),
    null,
  )
  assert.equal(pool.list('u1').length, 0)
})

test('normalises enumerated values case-insensitively', () => {
  const { pool } = build()
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'response_length', value: 'BRIEF' })
  pool.observe({ ownerId: 'u1', sessionId: 's2', field: 'response_length', value: ' brief ' })
  const [slot] = pool.list('u1')
  assert.equal(slot.value, 'brief')
  assert.equal(slot.confirm, 2)
})

// 自由文本字段不做归一化，因为单槽 in-place 本来就不需要跨措辞合并。
test('accepts free-text values for open-ended fields', () => {
  const { pool } = build()
  const slot = pool.observe({
    ownerId: 'u1',
    sessionId: 's1',
    field: 'occupation',
    value: '中学语文老师',
  })
  assert.equal(slot.value, '中学语文老师')
})

// 「老师 → 语文老师」是同一件事变精确，确认次数必须保留，否则每次说得更细
// 都要从头攒，永远也生效不了。
test('refine replaces the value in place and keeps the confirm count', () => {
  const { pool } = build()
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'occupation', value: '老师' })
  pool.observe({
    ownerId: 'u1',
    sessionId: 's2',
    field: 'occupation',
    value: '中学语文老师',
    relation: 'refine',
  })
  const slots = pool.list('u1')
  assert.equal(slots.length, 1, '精化不能产生第二个槽位')
  assert.equal(slots[0].value, '中学语文老师')
  assert.equal(slots[0].confirm, 2)
  assert.deepEqual(slots[0].sessions, ['s1', 's2'])
  assert.equal(pool.promotable('u1').length, 1)
})

test('contradiction replaces the value and restarts the confirm count', () => {
  const { pool } = build()
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'occupation', value: '老师' })
  pool.observe({ ownerId: 'u1', sessionId: 's2', field: 'occupation', value: '老师' })
  assert.equal(pool.promotable('u1').length, 1)

  pool.observe({
    ownerId: 'u1',
    sessionId: 's3',
    field: 'occupation',
    value: '算法工程师',
    relation: 'contradict',
  })
  const slots = pool.list('u1')
  assert.equal(slots.length, 1)
  assert.equal(slots[0].value, '算法工程师')
  assert.equal(slots[0].confirm, 1)
  assert.deepEqual(slots[0].sessions, ['s3'])
  assert.equal(pool.promotable('u1').length, 0)
})

// 观察器没给 relation 时保守处理：值相同算确认，值不同算矛盾。
test('infers the relation from the value when none is supplied', () => {
  const { pool } = build()
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'occupation', value: '老师' })
  pool.observe({ ownerId: 'u1', sessionId: 's2', field: 'occupation', value: '医生' })
  const [slot] = pool.list('u1')
  assert.equal(slot.value, '医生')
  assert.equal(slot.confirm, 1, '未声明关系的不同取值按矛盾处理')
})

test('an already active slot returns to tentative after a contradiction', () => {
  const { pool } = build()
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'occupation', value: '老师' })
  pool.observe({ ownerId: 'u1', sessionId: 's2', field: 'occupation', value: '老师' })
  const [ready] = pool.promotable('u1')
  pool.markPromoted('u1', ready.key)
  assert.equal(pool.list('u1', { state: 'active' }).length, 1)

  pool.observe({ ownerId: 'u1', sessionId: 's3', field: 'occupation', value: '医生' })
  assert.equal(pool.list('u1', { state: 'active' }).length, 0)
  assert.equal(pool.list('u1', { state: 'tentative' }).length, 1)
})

test('list fields keep multiple values side by side', () => {
  const { pool } = build()
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'special_skills', value: 'AEC 回声消除' })
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'special_skills', value: 'SDK 接入' })
  const skills = pool.list('u1', { field: 'special_skills' })
  assert.equal(skills.length, 2)
  assert.deepEqual(
    skills.map(slot => slot.value).sort(),
    ['AEC 回声消除', 'SDK 接入'],
  )
})

// FIFO 会淘汰掉反复确认过的核心项、留下偶然提过一次的，所以按强度淘汰。
test('evicts the weakest skill rather than the oldest one', () => {
  const { pool, advance } = build()
  // 最早进来的 AEC 被确认两次
  pool.observe({ ownerId: 'u1', sessionId: 's0', field: 'special_skills', value: 'AEC' })
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'special_skills', value: 'AEC' })
  advance(DAY)
  for (const value of ['SDK', '前端', '运维', '测试', '算法']) {
    pool.observe({ ownerId: 'u1', sessionId: 's2', field: 'special_skills', value })
  }
  assert.equal(pool.list('u1', { field: 'special_skills' }).length, CANDIDATE_DEFAULTS.MAX_LIST_ITEMS)

  advance(DAY)
  pool.observe({ ownerId: 'u1', sessionId: 's3', field: 'special_skills', value: '新技能' })
  const values = pool.list('u1', { field: 'special_skills' }).map(slot => slot.value)
  assert.equal(values.length, CANDIDATE_DEFAULTS.MAX_LIST_ITEMS)
  assert.equal(values.includes('AEC'), true, '确认两次的技能不能因为最早就被淘汰')
  assert.equal(values.includes('新技能'), true)
  assert.equal(values.includes('SDK'), false, '最弱且最旧的那条才该被淘汰')
})

test('a rejected slot goes on the blocklist and stops accepting evidence', () => {
  const { pool } = build()
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'response_length', value: 'brief' })
  pool.reject({ ownerId: 'u1', field: 'response_length', value: 'brief' })

  assert.equal(pool.blocked('u1', 'response_length', 'brief'), true)
  assert.equal(
    pool.observe({ ownerId: 'u1', sessionId: 's2', field: 'response_length', value: 'brief' }),
    null,
  )
  assert.equal(pool.promotable('u1').length, 0)
  // 单槽字段的否决是字段级的：用户删掉「回答简短」表达的是「别猜我的回复长度」，
  // 而不是「改猜详细」。多值字段才是取值级，见下一个用例。
  assert.equal(
    pool.observe({
      ownerId: 'u1',
      sessionId: 's2',
      field: 'response_length',
      value: 'detailed',
    }),
    null,
  )
})

test('rejecting one skill leaves the other skills alone', () => {
  const { pool } = build()
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'special_skills', value: 'AEC' })
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'special_skills', value: 'SDK' })
  pool.reject({ ownerId: 'u1', field: 'special_skills', value: 'AEC' })

  assert.equal(pool.blocked('u1', 'special_skills', 'AEC'), true)
  assert.equal(pool.blocked('u1', 'special_skills', 'SDK'), false)
  assert.equal(pool.list('u1', { state: 'tentative' }).length, 1)
})

test('caps evidence at three quotes of fifty characters', () => {
  const { pool } = build()
  for (let index = 0; index < 5; index += 1) {
    pool.observe({
      ownerId: 'u1',
      sessionId: `s${index}`,
      field: 'response_length',
      value: 'brief',
      quote: `第${index}次原话`.repeat(30),
    })
  }
  const [slot] = pool.list('u1')
  assert.equal(slot.evidence.length, CANDIDATE_DEFAULTS.MAX_EVIDENCE_ITEMS)
  for (const item of slot.evidence) {
    assert.equal([...item.quote].length <= CANDIDATE_DEFAULTS.MAX_EVIDENCE_CHARS, true)
  }
})

test('stale evidence resets the confirm count instead of promoting an outdated value', () => {
  const { pool, advance } = build()
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'occupation', value: '老师' })
  advance(CANDIDATE_DEFAULTS.STALE_MS + DAY)
  pool.observe({ ownerId: 'u1', sessionId: 's2', field: 'occupation', value: '老师' })

  const [slot] = pool.list('u1')
  assert.equal(slot.confirm, 1)
  assert.deepEqual(slot.sessions, ['s2'])
  assert.equal(pool.promotable('u1').length, 0)
})

test('ignores unknown fields, blank values and blank owners', () => {
  const { pool } = build()
  assert.equal(pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'nope', value: 'x' }), null)
  assert.equal(pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'occupation', value: '  ' }), null)
  assert.equal(pool.observe({ ownerId: '', sessionId: 's1', field: 'occupation', value: '老师' }), null)
  assert.equal(pool.list('u1').length, 0)
})

// OpenClaw #64068 的零晋升可以静默持续数周：cron 正常跑、日志无异常，只是
// 候选强度永远不够。diagnose 要能区分「用户确实没有稳定偏好」和「链路坏了」。
test('diagnose reports per-field progress and never-observed fields', () => {
  const { pool } = build()
  const empty = pool.diagnose('u1')
  assert.deepEqual(
    empty.neverObserved.sort(),
    Object.keys(PROFILE_FIELDS).sort(),
    '生产者没接上时所有字段都应报告为从未观察',
  )
  assert.equal(empty.ready, 0)

  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'occupation', value: '老师' })
  const partial = pool.diagnose('u1')
  assert.equal(partial.fields.occupation.length, 1)
  assert.equal(partial.fields.occupation[0].confirm, 1)
  assert.equal(partial.fields.occupation[0].confirmTarget, CANDIDATE_DEFAULTS.CONFIRM_TARGET)
  assert.equal(partial.fields.occupation[0].sessions, 1)
  assert.deepEqual(partial.fields.occupation[0].missing, ['confirm', 'sessions'])
  assert.equal(partial.fields.occupation[0].ready, false)
  assert.equal(partial.fields.response_length, null)
  assert.equal(partial.neverObserved.includes('occupation'), false)

  pool.observe({ ownerId: 'u1', sessionId: 's2', field: 'occupation', value: '老师' })
  const done = pool.diagnose('u1')
  assert.deepEqual(done.fields.occupation[0].missing, [])
  assert.equal(done.fields.occupation[0].ready, true)
  assert.equal(done.ready, 1)
  assert.equal(done.tentative, 1)
})

test('stats counts slots by state', () => {
  const { pool } = build()
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'occupation', value: '老师' })
  pool.observe({ ownerId: 'u1', sessionId: 's2', field: 'occupation', value: '老师' })
  const [ready] = pool.promotable('u1')
  pool.markPromoted('u1', ready.key)
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'special_skills', value: 'AEC' })
  pool.reject({ ownerId: 'u1', field: 'special_skills', value: 'AEC' })

  const stats = pool.stats('u1')
  assert.equal(stats.active, 1)
  assert.equal(stats.rejected, 1)
  assert.equal(stats.blocked, 1)
})

// 枚举字段的措辞查表得到，不由模型生成 —— 否则同一取值每次写出来都不一样，
// 用户会以为系统学了好几条。
test('renderLabel looks up enumerated wording and prefixes free text', () => {
  assert.equal(renderLabel('response_length', 'brief'), '回答简短，直接说要点')
  assert.equal(renderLabel('response_length', 'detailed'), '回答详细，展开说明')
  assert.equal(renderLabel('occupation', '中学语文老师'), '职业：中学语文老师')
  assert.equal(renderLabel('special_skills', 'AEC'), '熟悉的领域或技术：AEC')
})

test('isSameFieldLabel identifies the mutually exclusive rows of one slot field', () => {
  // 枚举字段：所有取值的措辞都算同一字段
  assert.equal(isSameFieldLabel('response_length', '回答简短，直接说要点'), true)
  assert.equal(isSameFieldLabel('response_length', '回答详细，展开说明'), true)
  assert.equal(isSameFieldLabel('response_length', '职业：老师'), false)
  // 自由文本单槽：比前缀
  assert.equal(isSameFieldLabel('occupation', '职业：中学语文老师'), true)
  assert.equal(isSameFieldLabel('occupation', '职业：算法工程师'), true)
  assert.equal(isSameFieldLabel('occupation', '回答简短，直接说要点'), false)
  // 多值字段本就允许共存，不参与替换
  assert.equal(isSameFieldLabel('special_skills', '熟悉的领域或技术：AEC'), false)
})

test('evaluateSlot exposes which gate is missing', () => {
  assert.deepEqual(
    evaluateSlot({ confirm: 1, sessions: ['s1'] }).missing,
    ['confirm', 'sessions'],
  )
  assert.deepEqual(evaluateSlot({ confirm: 2, sessions: ['s1'] }).missing, ['sessions'])
  assert.deepEqual(evaluateSlot({ confirm: 2, sessions: ['s1', 's2'] }).missing, [])
  assert.equal(evaluateSlot({ confirm: 2, sessions: ['s1', 's2'] }).ready, true)
  assert.equal(evaluateSlot({ confirm: 2, sessions: ['s1', 's2'] }).sessionCount, 2)
})
