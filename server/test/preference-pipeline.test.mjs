// 偏好自更新的全链路集成测试。
//
// 各模块的单测已经分别覆盖了内部分支，这里只验证它们「拼在一起还能跑」——
// 而且刻意用真实的落盘文件而非替身，因为整条链最容易断的三处接缝都在真实
// I/O 上：观察器输出的字段名要对得上槽位池的入参、落盘格式要能被下个进程
// 读回来、晋升器要真的把内容写进 USER.md。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FrontendMemoryService } from '../src/conversation/frontend-memory-service.mjs'
import { MarkdownContextStore } from '../src/conversation/markdown-context-store.mjs'
import { PreferenceCandidateStore } from '../src/conversation/preference-candidate-store.mjs'
import { PreferenceCandidatePool } from '../src/conversation/preference-candidates.mjs'
import { PreferencePromoter } from '../src/conversation/preference-promoter.mjs'
import { ProfileObserver } from '../src/conversation/profile-observer.mjs'

const OWNER = 'user_personal'

// 一场满足 minUserMessages 的会话，助手轮也在里面 —— 观察器要能读到上下文，
// 但 quote 校验只认用户轮。
function transcript(userLines) {
  return userLines.flatMap(content => [
    { role: 'user', content },
    { role: 'assistant', content: '好的，我记住了。' },
  ])
}

// 每次调用都重新装配全部模块，等价于一次进程重启：只有落盘文件是共享的。
function boot(directory, { messages, reply }) {
  const userStore = new MarkdownContextStore({
    filePath: join(directory, 'USER.md'),
    scope: 'user',
    personalOwnerId: OWNER,
    maxChars: 6000,
    template: '# USER',
    onWarning: () => {},
  })
  const memoryService = new FrontendMemoryService({
    userStore,
    memoryStore: new MarkdownContextStore({
      filePath: join(directory, 'MEMORY.md'),
      scope: 'memory',
      personalOwnerId: OWNER,
      maxChars: 8000,
      template: '# MEMORY',
      onWarning: () => {},
    }),
  })
  const pool = new PreferenceCandidatePool({
    store: new PreferenceCandidateStore({
      filePath: join(directory, 'candidates.json'),
      onWarning: () => {},
    }),
  })
  const audit = []
  const observer = new ProfileObserver({
    candidatePool: pool,
    conversationSync: { list: () => messages },
    audit: { record: entry => audit.push(entry) },
    llmCall: async () => reply,
    logger: { warn() {}, debug() {} },
  })
  const promoter = new PreferencePromoter({
    memoryService,
    candidatePool: pool,
    audit: { record: entry => audit.push(entry) },
    logger: { warn() {} },
  })
  return { memoryService, pool, observer, promoter, audit }
}

const OCCUPATION_REPLY = JSON.stringify({
  observations: [
    {
      field: 'occupation',
      value: '中学语文老师',
      relation: 'same',
      quote: '我在学校教语文',
    },
  ],
})

test('observation accumulates across a restart and only then reaches USER.md', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-pipeline-'))
  try {
    const messages = transcript([
      '我在学校教语文，最近在备课',
      '帮我想几个作文题目',
      '再具体一点',
      '这个方向可以',
    ])

    // ── 第一场会话：证据只够 confirm=1，晋升必须按住不动
    const first = boot(directory, { messages, reply: OCCUPATION_REPLY })
    const accepted = await first.observer.maybeRun({ ownerId: OWNER, sessionId: 's_a' })
    assert.equal(accepted.length, 1, '观察器应当收下这条画像信号')
    assert.equal(accepted[0].confirm, 1)
    assert.deepEqual(first.pool.promotable(OWNER), [], '单场证据不得晋升')
    assert.deepEqual(await first.promoter.run({ ownerId: OWNER }), [])

    // ── 重启：新对象只能从 candidates.json 恢复证据
    const second = boot(directory, { messages, reply: OCCUPATION_REPLY })
    const restored = second.pool.list(OWNER)
    assert.equal(restored.length, 1, '槽位必须穿越重启存活')
    assert.equal(restored[0].confirm, 1)
    assert.equal(restored[0].value, '中学语文老师')

    // ── 第二场会话：跨会话条件达成，这次应当写进 USER.md
    const again = await second.observer.maybeRun({ ownerId: OWNER, sessionId: 's_b' })
    assert.equal(again[0].confirm, 2)
    assert.equal(second.pool.promotable(OWNER).length, 1)

    const promoted = await second.promoter.run({ ownerId: OWNER })
    assert.deepEqual(promoted.map(item => item.label), ['职业：中学语文老师'])

    // 断言落到真实文件上，而不是只看服务返回值
    const onDisk = readFileSync(join(directory, 'USER.md'), 'utf8')
    assert.match(onDisk, /## 观察推断/)
    assert.match(onDisk, /- 职业：中学语文老师/)

    // ── 幂等：同一条不该被写第二遍
    assert.deepEqual(await second.promoter.run({ ownerId: OWNER }), [])
    const afterRerun = readFileSync(join(directory, 'USER.md'), 'utf8')
    assert.equal(
      afterRerun.match(/职业：中学语文老师/g).length,
      1,
      '重复扫描不得追加重复行',
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a fabricated quote is dropped before it can reach the pool', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-pipeline-fake-'))
  try {
    const { observer, pool, audit } = boot(directory, {
      messages: transcript(['帮我看看这段代码', '再改改', '可以了', '谢谢']),
      // 用户从没说过这句话 —— 模型凭印象编的
      reply: JSON.stringify({
        observations: [{
          field: 'occupation',
          value: '程序员',
          relation: 'same',
          quote: '我是个程序员',
        }],
      }),
    })
    const accepted = await observer.maybeRun({ ownerId: OWNER, sessionId: 's_a' })
    assert.deepEqual(accepted, [], '编造的证据不得进池')
    assert.deepEqual(pool.list(OWNER), [])
    assert.ok(
      audit.some(entry => entry.reason === 'quote_not_from_user'),
      '审计里要能看出模型在哪一步不听话',
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a value already promoted cannot be re-confirmed from the injected profile', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwaudio-pipeline-loop-'))
  try {
    // 这一场用户完全没提职业，只有 instructions 里注入过「中学语文老师」。
    // 若观察器把注入内容当新证据，就会形成自我强化循环。
    const { observer, pool } = boot(directory, {
      messages: transcript(['今天天气不错', '嗯', '那就这样', '再见']),
      reply: OCCUPATION_REPLY,
    })
    const accepted = await observer.maybeRun({ ownerId: OWNER, sessionId: 's_c' })
    assert.deepEqual(accepted, [], '没有本场用户证据就不得再确认一次')
    assert.deepEqual(pool.list(OWNER), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a short session never reaches the model', () => {
  let calls = 0
  const observer = new ProfileObserver({
    candidatePool: new PreferenceCandidatePool(),
    conversationSync: { list: () => transcript(['一', '二']) },
    llmCall: async () => { calls += 1; return OCCUPATION_REPLY },
    logger: { warn() {}, debug() {} },
  })
  assert.equal(observer.maybeRun({ ownerId: OWNER, sessionId: 's_a' }), null)
  assert.equal(calls, 0, '短会话不该白花一次模型调用')
})
