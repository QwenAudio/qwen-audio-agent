import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PreferenceCandidateStore } from '../src/conversation/preference-candidate-store.mjs'
import { PreferenceCandidatePool } from '../src/conversation/preference-candidates.mjs'

const DAY = 24 * 60 * 60_000

// 与 managed-backend.test.mjs 同一个判据：Windows 用 ACL 管权限，不暴露 POSIX
// mode 位，chmod(0o600) 之后 mode & 0o777 仍是 0o666，写死断言必挂。
function assertPrivateMode(filePath) {
  if (process.platform !== 'win32') {
    assert.equal(statSync(filePath).mode & 0o777, 0o600)
  }
}

function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-candidates-'))
  return join(directory, 'candidates.json')
}

function build(filePath, { startAt = Date.parse('2026-08-01T09:00:00Z') } = {}) {
  let clock = startAt
  const warnings = []
  const store = new PreferenceCandidateStore({
    filePath,
    now: () => clock,
    onWarning: warning => warnings.push(warning),
  })
  const pool = new PreferenceCandidatePool({ store, now: () => clock })
  return {
    pool,
    store,
    warnings,
    advance(ms) { clock += ms },
    at() { return clock },
  }
}

// 攒够生效条件：确认 2 次且跨 2 个会话
function qualify(pool, { field = 'response_length', value = 'brief' } = {}) {
  pool.observe({ ownerId: 'u1', sessionId: 's0', field, value, quote: '简短点' })
  pool.observe({ ownerId: 'u1', sessionId: 's1', field, value, quote: '别啰嗦' })
}

test('basis 一并穿越重启，否则重启后就答不出这条画像的来历', () => {
  // 和落盘漏字段是同一类错：不写进序列化，机制照常跑，只是判据静默消失，
  // 用户追问「你怎么知道我是老师的」时无从回答。
  const filePath = scratch()
  const first = build(filePath)
  first.pool.observe({
    ownerId: 'u1',
    sessionId: 's0',
    field: 'occupation',
    value: '高中语文老师',
    quote: '我在市一中教高中语文',
    basis: '用户自述在中学教语文，属于职业陈述',
  })

  const second = build(filePath, { startAt: first.at() })
  const [restored] = second.pool.list('u1')
  assert.equal(restored.evidence[0].quote, '我在市一中教高中语文')
  assert.match(restored.evidence[0].basis, /职业陈述/)
})

test('早先落盘的证据没有 basis 时给空串，不作废已攒的确认', () => {
  // basis 是后加的字段。把缺它的旧记录判为无效会把用户攒了几周的确认全部清零。
  const filePath = scratch()
  writeFileSync(filePath, JSON.stringify({
    version: 2,
    updatedAt: Date.parse('2026-08-01T09:00:00Z'),
    owners: {
      u1: [{
        key: 'occupation',
        field: 'occupation',
        value: '老师',
        confirm: 2,
        sessions: ['s0', 's1'],
        firstAt: Date.parse('2026-08-01T09:00:00Z'),
        lastAt: Date.parse('2026-08-01T09:00:00Z'),
        // 旧格式：只有 sessionId 与 quote
        evidence: [{ sessionId: 's0', quote: '我教语文' }],
        state: 'tentative',
      }],
    },
  }))

  const { pool } = build(filePath)
  const [slot] = pool.list('u1')
  assert.ok(slot, '缺 basis 的旧记录必须照常读回来')
  assert.equal(slot.confirm, 2, '已攒的确认不得被作废')
  assert.equal(slot.evidence[0].basis, '')
  assert.equal(pool.promotable('u1').length, 1, '旧记录该晋升还是要晋升')
})

test('survives a restart so cross-session evidence keeps accumulating', () => {
  const filePath = scratch()

  // 第一段进程：只有一个会话，还差跨会话那一项
  const first = build(filePath)
  first.pool.observe({
    ownerId: 'u1',
    sessionId: 's0',
    field: 'response_length',
    value: 'brief',
  })
  assert.equal(first.pool.promotable('u1').length, 0)

  // 进程重启：新建 store 与 pool，读同一个文件
  const second = build(filePath, { startAt: first.at() })
  const [restored] = second.pool.list('u1')
  assert.ok(restored, '重启后槽位必须还在')
  assert.equal(restored.field, 'response_length')
  assert.equal(restored.value, 'brief')
  assert.equal(restored.confirm, 1)
  assert.deepEqual(restored.sessions, ['s0'])

  // 接着在第 2 个会话确认 —— 这正是纯内存实现永远做不到的
  second.pool.observe({
    ownerId: 'u1',
    sessionId: 's1',
    field: 'response_length',
    value: 'brief',
  })
  assert.equal(second.pool.promotable('u1').length, 1)
})

test('persists active state so a restart does not re-promote', () => {
  const filePath = scratch()
  const first = build(filePath)
  qualify(first.pool)
  const [slot] = first.pool.promotable('u1')
  first.pool.markPromoted('u1', slot.key)
  assert.equal(first.pool.promotable('u1').length, 0)

  const second = build(filePath, { startAt: first.at() })
  assert.equal(second.pool.promotable('u1').length, 0)
  assert.equal(second.pool.list('u1', { state: 'active' }).length, 1)
})

test('persists the blocklist so a rejected slot stays rejected', () => {
  const filePath = scratch()
  const first = build(filePath)
  qualify(first.pool)
  first.pool.reject({ ownerId: 'u1', field: 'response_length', value: 'brief' })

  const second = build(filePath, { startAt: first.at() })
  assert.equal(second.pool.blocked('u1', 'response_length', 'brief'), true)
  // 重启后再观察同一取值仍然被忽略
  assert.equal(
    second.pool.observe({
      ownerId: 'u1',
      sessionId: 's9',
      field: 'response_length',
      value: 'brief',
    }),
    null,
  )
  assert.equal(second.pool.promotable('u1').length, 0)
})

test('keeps owners separate on disk', () => {
  const filePath = scratch()
  const first = build(filePath)
  first.pool.observe({
    ownerId: 'u1',
    sessionId: 's1',
    field: 'occupation',
    value: '中学语文老师',
  })
  first.pool.observe({
    ownerId: 'u2',
    sessionId: 's1',
    field: 'occupation',
    value: '算法工程师',
  })

  const second = build(filePath, { startAt: first.at() })
  assert.equal(second.pool.list('u1')[0].value, '中学语文老师')
  assert.equal(second.pool.list('u2')[0].value, '算法工程师')
  assert.equal(second.pool.list('u3').length, 0)
})

test('writes the file with owner-only permissions', () => {
  const filePath = scratch()
  const { pool } = build(filePath)
  pool.observe({
    ownerId: 'u1',
    sessionId: 's1',
    field: 'response_length',
    value: 'brief',
  })
  assertPrivateMode(filePath)
})

test('does not leak evidence beyond the cap onto disk', () => {
  const filePath = scratch()
  const { pool } = build(filePath)
  for (let index = 0; index < 10; index += 1) {
    pool.observe({
      ownerId: 'u1',
      sessionId: `s${index}`,
      field: 'response_length',
      value: 'brief',
      quote: `很长的一句原话${index}`.repeat(20),
    })
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  const [slot] = parsed.owners.u1
  assert.equal(slot.evidence.length, 3)
  for (const item of slot.evidence) {
    assert.equal([...item.quote].length <= 50, true)
  }
})

test('quarantines a corrupt file and keeps running on an empty pool', () => {
  const filePath = scratch()
  writeFileSync(filePath, '{ this is not json', 'utf8')
  const { pool, store, warnings } = build(filePath)

  assert.equal(pool.list('u1').length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].message, /不是有效的 JSON/)
  assert.ok(warnings[0].quarantinePath)
  assert.equal(readFileSync(warnings[0].quarantinePath, 'utf8'), '{ this is not json')
  // 隔离之后仍然可以正常写入
  pool.observe({
    ownerId: 'u1',
    sessionId: 's1',
    field: 'response_length',
    value: 'brief',
  })
  assert.equal(pool.list('u1').length, 1)
  assert.equal(store.enabled(), true)
})

test('quarantines a file with an unexpected shape', () => {
  const filePath = scratch()
  writeFileSync(filePath, JSON.stringify({ version: 99, owners: {} }), 'utf8')
  const { warnings } = build(filePath)
  assert.match(warnings[0].message, /格式无效/)
})

// v1 是自由文本 trait + 计数模型，与 v2 的槽位模型不兼容。若版本号没跟着升，
// v1 文件会被当成 v2 逐条校验、全部丢弃，静默变成空池 —— 必须走隔离并告警。
test('quarantines a v1 candidate file instead of silently emptying the pool', () => {
  const filePath = scratch()
  writeFileSync(filePath, JSON.stringify({
    version: 1,
    owners: {
      u1: [{
        trait: '回答简短一点',
        count: 4,
        sessions: ['s1', 's2', 's3'],
        uniqueDays: ['2026-07-01'],
        lastAt: Date.parse('2026-07-01T09:00:00Z'),
        state: 'pending',
      }],
    },
  }), 'utf8')

  const { pool, warnings } = build(filePath)
  assert.match(warnings[0].message, /格式无效/)
  assert.ok(warnings[0].quarantinePath, 'v1 文件必须被隔离而不是丢弃')
  assert.equal(pool.list('u1').length, 0)
})

test('drops individual malformed slots without losing the rest', () => {
  const filePath = scratch()
  writeFileSync(filePath, JSON.stringify({
    version: 2,
    owners: {
      u1: [
        { field: 'response_length', value: '' }, // 无取值，整条丢弃
        { field: 'not_a_field', value: 'x' }, // 未知字段，丢弃
        { field: 'response_length', value: 'somehow_invalid' }, // 枚举外取值，丢弃
        null, // 非对象，丢弃
        {
          field: 'occupation',
          value: '中学语文老师',
          confirm: 3,
          sessions: ['s1', 's1', 's2'], // 重复会话需去重
          lastAt: Date.parse('2026-08-01T09:00:00Z'),
          state: 'weird', // 非法状态回落 tentative
          evidence: [{ quote: 'x'.repeat(200) }], // 超长原话需截断
        },
      ],
    },
  }), 'utf8')

  const { pool } = build(filePath)
  const items = pool.list('u1')
  assert.equal(items.length, 1)
  assert.equal(items[0].value, '中学语文老师')
  assert.deepEqual(items[0].sessions, ['s1', 's2'])
  assert.equal(items[0].state, 'tentative')
  assert.equal([...items[0].evidence[0].quote].length <= 50, true)
})

test('recomputes the key from field and value so hand edits cannot desync it', () => {
  const filePath = scratch()
  writeFileSync(filePath, JSON.stringify({
    version: 2,
    owners: {
      u1: [{
        key: 'bogus-key',
        field: 'special_skills',
        value: 'AEC 回声消除',
        confirm: 2,
        sessions: ['s1', 's2'],
        lastAt: Date.parse('2026-08-01T09:00:00Z'),
        state: 'tentative',
      }],
    },
  }), 'utf8')

  const { pool } = build(filePath)
  const [slot] = pool.list('u1')
  assert.notEqual(slot.key, 'bogus-key')
  // key 重算后，markPromoted 用重算的 key 才能命中
  assert.ok(pool.markPromoted('u1', slot.key))
})

test('keeps serving from memory when the disk write fails', () => {
  // 用普通文件占住父目录的位置，确保 Windows / macOS / Linux 都会稳定触发
  // 写失败。不要依赖 /proc 或 POSIX 权限位：Windows 上这些路径和权限语义不同。
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-candidates-write-failure-'))
  const parentFile = join(directory, 'not-a-directory')
  writeFileSync(parentFile, 'blocks directory creation', 'utf8')
  const filePath = join(parentFile, 'candidates.json')
  const warnings = []
  const store = new PreferenceCandidateStore({
    filePath,
    now: () => Date.now(),
    onWarning: warning => warnings.push(warning),
  })
  const pool = new PreferenceCandidatePool({ store })

  pool.observe({
    ownerId: 'u1',
    sessionId: 's1',
    field: 'response_length',
    value: 'brief',
  })
  // 内存里照常工作
  assert.equal(pool.list('u1').length, 1)
  // 持久化被关掉并给出告警，但服务没崩
  assert.equal(store.enabled(), false)
  assert.equal(warnings.length >= 1, true)
  assert.equal(pool.health().persistenceEnabled, false)
  assert.equal(pool.health().ok, false)
})

test('runs purely in memory when no store is injected', () => {
  const pool = new PreferenceCandidatePool({})
  pool.observe({
    ownerId: 'u1',
    sessionId: 's1',
    field: 'response_length',
    value: 'brief',
  })
  assert.equal(pool.list('u1').length, 1)
  const health = pool.health()
  assert.equal(health.ok, true)
  assert.equal(health.persistenceConfigured, false)
  assert.equal(health.persistenceEnabled, false)
})

// 职业本身稳定，但「半年前只观察到一次」这种残留证据不能一直等着被凑满，
// 否则用户换了工作、偶然再匹配一次就会让过时的值直接生效。
test('stale evidence resets the confirm count across a restart', () => {
  const filePath = scratch()
  const first = build(filePath)
  first.pool.observe({
    ownerId: 'u1',
    sessionId: 's1',
    field: 'occupation',
    value: '中学语文老师',
    quote: '我在学校教语文',
  })

  // 91 天后再观察一次：确认次数必须从头算，不能直接凑成 2 就生效
  const second = build(filePath, { startAt: first.at() + 91 * DAY })
  second.pool.observe({
    ownerId: 'u1',
    sessionId: 's2',
    field: 'occupation',
    value: '中学语文老师',
  })
  const [slot] = second.pool.list('u1')
  assert.equal(slot.confirm, 1)
  assert.deepEqual(slot.sessions, ['s2'])
  assert.equal(second.pool.promotable('u1').length, 0)
})

test('detects an external write through mtime and content hash', () => {
  const filePath = scratch()
  const { pool, store, at } = build(filePath)
  pool.observe({
    ownerId: 'u1',
    sessionId: 's1',
    field: 'occupation',
    value: '本进程写的职业',
  })
  assert.equal(store.hasChanged(), false)

  // 模拟另一个 Gateway 改了同一个文件
  writeFileSync(filePath, JSON.stringify({
    version: 2,
    owners: {
      u1: [{
        field: 'occupation',
        value: '别的进程写的职业',
        confirm: 2,
        sessions: ['sx'],
        lastAt: at(),
        state: 'tentative',
      }],
    },
  }), 'utf8')
  assert.equal(store.hasChanged(), true)

  pool.reload()
  assert.equal(pool.list('u1')[0].value, '别的进程写的职业')
})
