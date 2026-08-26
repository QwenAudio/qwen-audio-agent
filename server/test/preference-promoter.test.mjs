import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PreferenceCandidatePool,
  renderLabel,
} from '../src/conversation/preference-candidates.mjs'
import {
  PROMOTER_MARKERS,
  PreferencePromoter,
  splitObservedSection,
} from '../src/conversation/preference-promoter.mjs'

// 最小可用的 memoryService 替身：只实现晋升器用到的 list / apply
function memoryStub(initial = '') {
  return {
    content: initial,
    applied: [],
    list(_ownerId, { scope } = {}) {
      if (scope && scope !== 'user') return []
      if (!this.content) return []
      return [{ scope: 'user', content: this.content, revision: 'rev1' }]
    },
    apply(_ownerId, changes) {
      this.applied.push(changes)
      const change = changes[0]
      if (change.edits?.length) this.content = change.edits[0].new_text
      else if (change.append) this.content = change.append
      return { changed: 1 }
    },
  }
}

function harness({ initial = '', auditRecords = [] } = {}) {
  let clock = Date.parse('2026-08-01T09:00:00Z')
  const pool = new PreferenceCandidatePool({ now: () => clock })
  const memory = memoryStub(initial)
  const promoter = new PreferencePromoter({
    memoryService: memory,
    candidatePool: pool,
    audit: { record(entry) { auditRecords.push(entry) } },
    logger: { warn() {} },
    now: () => clock,
  })
  return {
    pool,
    memory,
    promoter,
    auditRecords,
    advance(ms) { clock += ms },
  }
}

// 攒到可晋升：确认 confirm 次、会话在 s0/s1 之间交替以满足跨会话要求。
// confirm 可调是为了让候选出队顺序（confirm 降序）在多候选用例里完全确定。
function qualify(pool, { field, value, confirm = 2 } = {}) {
  for (let index = 0; index < confirm; index += 1) {
    pool.observe({
      ownerId: 'u1',
      sessionId: `s${index % 2}`,
      field,
      value,
      quote: `第${index}次`,
    })
  }
}

const skill = value => renderLabel('special_skills', value)

test('parses an empty document as having no observed section', () => {
  const parsed = splitObservedSection('')
  assert.deepEqual(parsed, { before: '', items: [], after: '' })
})

test('round-trips the observed section', () => {
  const content = [
    '# USER',
    '',
    '## 用户明确要求',
    '- 回答用中文',
    '',
    PROMOTER_MARKERS.OBSERVED_HEADING,
    PROMOTER_MARKERS.OBSERVED_NOTICE,
    '- 职业：中学语文老师',
    '- 回答简短，直接说要点',
  ].join('\n')
  const { before, items, after } = splitObservedSection(content)
  assert.match(before, /用户明确要求/)
  assert.match(before, /回答用中文/)
  assert.deepEqual(items, ['职业：中学语文老师', '回答简短，直接说要点'])
  assert.equal(after, '')
})

test('writes a qualified slot into the observed section only', () => {
  const { pool, memory, promoter } = harness({
    initial: '# USER\n\n## 用户明确要求\n- 回答用中文\n',
  })
  qualify(pool, { field: 'occupation', value: '中学语文老师' })

  const promoted = promoter.run({ ownerId: 'u1' })
  assert.equal(promoted.length, 1)
  // 明说区一字不动
  assert.match(memory.content, /## 用户明确要求\n- 回答用中文/)
  // 新内容只出现在观察区，且带优先级声明
  assert.match(memory.content, /## 观察推断/)
  assert.match(memory.content, /权威低于上方用户明确要求/)
  assert.match(memory.content, /- 职业：中学语文老师/)
  // 观察区必须在明说区之后
  assert.equal(
    memory.content.indexOf('## 用户明确要求') < memory.content.indexOf('## 观察推断'),
    true,
  )
})

test('never rewrites the explicit section even when it contradicts the observation', () => {
  const explicit = '# USER\n\n## 用户明确要求\n- 回答要详细一点\n'
  const { pool, memory, promoter } = harness({ initial: explicit })
  qualify(pool, { field: 'response_length', value: 'brief' })

  promoter.run({ ownerId: 'u1' })
  // 用户明说的「详细」原封不动 —— 这是本用例的核心不变量
  assert.match(memory.content, /- 回答要详细一点/)
  // 观察结果只是并列写在下面，不覆盖
  assert.match(memory.content, /- 回答简短，直接说要点/)
})

// 单槽字段互斥：观察区里不能并存「简短」和「详细」两条相反的推断，
// 否则模型只能瞎猜。晋升新取值必须同时移除同字段的旧行。
test('replaces the previous row of the same slot field', () => {
  const { pool, memory, promoter } = harness({ initial: '# USER\n' })
  qualify(pool, { field: 'response_length', value: 'detailed' })
  promoter.run({ ownerId: 'u1' })
  assert.match(memory.content, /- 回答详细，展开说明/)

  // 用户改主意了：同字段换取值，重新攒够
  pool.observe({
    ownerId: 'u1',
    sessionId: 's5',
    field: 'response_length',
    value: 'brief',
    relation: 'contradict',
  })
  pool.observe({
    ownerId: 'u1',
    sessionId: 's6',
    field: 'response_length',
    value: 'brief',
  })
  promoter.run({ ownerId: 'u1' })

  const { items } = splitObservedSection(memory.content)
  assert.deepEqual(items, ['回答简短，直接说要点'], '旧取值必须被替换而不是并存')
})

// 多值字段本就允许共存，不参与替换。
test('keeps multiple skills side by side in the observed section', () => {
  const { pool, memory, promoter } = harness({ initial: '# USER\n' })
  qualify(pool, { field: 'special_skills', value: 'AEC 回声消除', confirm: 3 })
  qualify(pool, { field: 'special_skills', value: 'SDK 接入', confirm: 2 })
  promoter.run({ ownerId: 'u1' })

  const { items } = splitObservedSection(memory.content)
  assert.equal(items.length, 2)
  assert.equal(items.includes(skill('AEC 回声消除')), true)
  assert.equal(items.includes(skill('SDK 接入')), true)
})

test('does nothing when no slot has enough confirmation', () => {
  const { pool, memory, promoter } = harness({ initial: '# USER\n' })
  pool.observe({ ownerId: 'u1', sessionId: 's1', field: 'occupation', value: '偶尔提过' })
  assert.deepEqual(promoter.run({ ownerId: 'u1' }), [])
  assert.equal(memory.applied.length, 0)
})

test('marks slots promoted so a second run is a no-op', () => {
  const { pool, memory, promoter } = harness({ initial: '# USER\n' })
  qualify(pool, { field: 'occupation', value: '算法工程师' })

  assert.equal(promoter.run({ ownerId: 'u1' }).length, 1)
  const writes = memory.applied.length
  assert.deepEqual(promoter.run({ ownerId: 'u1' }), [])
  assert.equal(memory.applied.length, writes)
})

test('skips a slot the explicit section already covers', () => {
  const auditRecords = []
  const { pool, memory, promoter } = harness({
    initial: '# USER\n\n## 用户明确要求\n- 回答简短，直接说要点\n',
    auditRecords,
  })
  qualify(pool, { field: 'response_length', value: 'brief' })

  assert.deepEqual(promoter.run({ ownerId: 'u1' }), [])
  assert.equal(memory.applied.length, 0)
  assert.equal(
    auditRecords.some(entry => entry.reason === 'already_explicit'),
    true,
  )
  // 已被明说覆盖的候选也应结案，避免每次扫描都重复判断
  assert.equal(pool.promotable('u1').length, 0)
})

test('does not duplicate a row already present in the observed section', () => {
  const { pool, memory, promoter } = harness({
    initial: [
      '# USER',
      '',
      PROMOTER_MARKERS.OBSERVED_HEADING,
      PROMOTER_MARKERS.OBSERVED_NOTICE,
      '- 回答简短，直接说要点',
    ].join('\n'),
  })
  qualify(pool, { field: 'response_length', value: 'brief' })

  assert.deepEqual(promoter.run({ ownerId: 'u1' }), [])
  assert.equal(memory.applied.length, 0)
  const { items } = splitObservedSection(memory.content)
  assert.deepEqual(items, ['回答简短，直接说要点'])
})

test('caps how many slots are promoted in a single run', () => {
  const { pool, promoter } = harness({ initial: '# USER\n' })
  for (const [index, value] of ['一', '二', '三', '四', '五'].entries()) {
    qualify(pool, { field: 'special_skills', value, confirm: 6 - index })
  }
  const promoted = promoter.run({ ownerId: 'u1' })
  assert.equal(promoted.length, 3) // maxPerRun
  assert.equal(pool.promotable('u1').length, 2)
})

test('bounds the observed section, dropping the oldest entries', () => {
  const { pool, memory } = harness({ initial: '# USER\n' })
  const promoter = new PreferencePromoter({
    memoryService: memory,
    candidatePool: pool,
    logger: { warn() {} },
    maxObservedItems: 4,
    maxPerRun: 2,
  })
  // confirm 递减保证出队顺序确定：A > B > C > D > E > F
  for (const [index, value] of ['A', 'B', 'C', 'D', 'E', 'F'].entries()) {
    qualify(pool, { field: 'special_skills', value, confirm: 7 - index })
  }
  for (let round = 0; round < 3; round += 1) promoter.run({ ownerId: 'u1' })

  const { items } = splitObservedSection(memory.content)
  assert.equal(items.length, 4)
  // 每轮 2 条、新晋升插到最前，所以三轮后是最后一轮的 E/F 在前，
  // 最早晋升的 A/B 已被挤出上限。
  assert.deepEqual(items, [skill('E'), skill('F'), skill('C'), skill('D')])
  assert.equal(items.includes(skill('A')), false)
})

test('records the confirmation detail so a promotion can be explained', () => {
  const auditRecords = []
  const { pool, promoter } = harness({ initial: '# USER\n', auditRecords })
  qualify(pool, { field: 'occupation', value: '中学语文老师', confirm: 3 })
  promoter.run({ ownerId: 'u1' })

  const entry = auditRecords.find(item => item.reason === 'promoted')
  assert.ok(entry)
  assert.equal(entry.scope, 'user')
  assert.equal(entry.detail.field, 'occupation')
  assert.equal(entry.detail.value, '中学语文老师')
  assert.equal(entry.detail.label, '职业：中学语文老师')
  assert.equal(entry.detail.confirm, 3)
  assert.equal(entry.detail.sessions, 2)
})

test('rejecting removes the row from the document and blocklists it', () => {
  const { pool, memory, promoter } = harness({ initial: '# USER\n' })
  qualify(pool, { field: 'response_length', value: 'brief' })
  promoter.run({ ownerId: 'u1' })
  assert.match(memory.content, /- 回答简短，直接说要点/)

  assert.equal(
    promoter.reject({ ownerId: 'u1', field: 'response_length', value: 'brief' }),
    true,
  )
  assert.doesNotMatch(memory.content, /- 回答简短，直接说要点/)
  assert.equal(pool.blocked('u1', 'response_length', 'brief'), true)

  // 再攒证据也不会回来
  qualify(pool, { field: 'response_length', value: 'brief' })
  assert.deepEqual(promoter.run({ ownerId: 'u1' }), [])
})

// 管理界面上用户看到的是那行文本，未必带得回 field/value。
test('rejecting by the displayed label resolves back to the slot', () => {
  const { pool, memory, promoter } = harness({ initial: '# USER\n' })
  qualify(pool, { field: 'occupation', value: '算法工程师' })
  promoter.run({ ownerId: 'u1' })

  assert.equal(
    promoter.reject({ ownerId: 'u1', label: '职业：算法工程师' }),
    true,
  )
  assert.doesNotMatch(memory.content, /职业：算法工程师/)
  assert.equal(pool.blocked('u1', 'occupation', '算法工程师'), true)
})

test('rejecting an unknown row is a no-op on the document', () => {
  const { memory, promoter } = harness({ initial: '# USER\n' })
  assert.equal(promoter.reject({ ownerId: 'u1', label: '不存在的偏好' }), false)
  assert.equal(memory.applied.length, 0)
})

test('lists observed rows with confirmation detail and a reject key', () => {
  const { pool, promoter } = harness({ initial: '# USER\n' })
  qualify(pool, { field: 'occupation', value: '中学语文老师', confirm: 3 })
  promoter.run({ ownerId: 'u1' })

  const listed = promoter.listObserved('u1')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].label, '职业：中学语文老师')
  assert.equal(listed[0].field, 'occupation')
  assert.equal(listed[0].value, '中学语文老师')
  assert.equal(listed[0].confirm, 3)
  assert.equal(listed[0].sessions, 2)
  assert.ok(listed[0].key, '界面需要 key 才能稳定地回传否决')
})

test('stays disabled and silent without its dependencies', () => {
  const promoter = new PreferencePromoter({})
  assert.equal(promoter.enabled(), false)
  assert.deepEqual(promoter.run({ ownerId: 'u1' }), [])
  assert.equal(promoter.reject({ ownerId: 'u1', label: 'x' }), false)
  assert.deepEqual(promoter.listObserved('u1'), [])
})

test('never throws when the memory service fails', () => {
  const auditRecords = []
  const clock = Date.parse('2026-08-01T09:00:00Z')
  const pool = new PreferenceCandidatePool({ now: () => clock })
  const promoter = new PreferencePromoter({
    memoryService: {
      list() { return [{ scope: 'user', content: '# USER', revision: 'r' }] },
      apply() { throw new Error('document changed') },
    },
    candidatePool: pool,
    audit: { record(entry) { auditRecords.push(entry) } },
    logger: { warn() {} },
    now: () => clock,
  })
  qualify(pool, { field: 'occupation', value: '中学语文老师' })

  assert.deepEqual(promoter.run({ ownerId: 'u1' }), [])
  assert.equal(auditRecords.some(entry => entry.op === 'error'), true)
  // 失败不消耗候选，下次还能重试
  assert.equal(pool.promotable('u1').length, 1)
})
