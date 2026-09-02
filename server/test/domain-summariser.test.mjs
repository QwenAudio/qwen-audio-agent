import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DomainLibrary } from '../src/domain/domain-library.mjs'
import { DomainSummariser } from '../src/domain/domain-summariser.mjs'

const OWNER = 'user_personal'
const MANUAL = [
  '# 信用卡业务手册',
  '',
  '## 开卡与激活',
  '柜面开卡需核验身份证原件。',
  '',
  '## 年费规则',
  '普卡首年免年费。',
].join('\n')

function harness({
  content = MANUAL,
  reply = '{"title":"信用卡业务手册","gist":"覆盖开卡与年费两类流程","sections":["开卡与激活","年费规则"]}',
  audit = [],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-domsum-'))
  const source = join(root, 'manual.md')
  writeFileSync(source, content)
  const library = new DomainLibrary({
    documentDirectory: join(root, 'docs'),
    onWarning: () => {},
  })
  const entry = library.import({ ownerId: OWNER, sourcePath: source })
  const calls = []
  const summariser = new DomainSummariser({
    library,
    audit: { record: item => audit.push(item) },
    llmCall: async payload => {
      calls.push(payload)
      return typeof reply === 'function' ? reply(payload) : reply
    },
    logger: { warn() {}, debug() {} },
  })
  return {
    library,
    summariser,
    entry,
    calls,
    audit,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('summarises a document into a title, a gist and section anchors', async () => {
  const kit = harness()
  try {
    const updated = await kit.summariser.maybeRun({ ownerId: OWNER, id: kit.entry.id })
    assert.equal(updated.title, '信用卡业务手册')
    assert.equal(updated.gist, '覆盖开卡与年费两类流程')
    // 章节标题是日后写进 objective 的锚点，必须留住
    assert.deepEqual(updated.sections, ['开卡与激活', '年费规则'])
    assert.equal(updated.summarised, true)
  } finally {
    kit.cleanup()
  }
})

test('only sends the head of the document to the model', async () => {
  const kit = harness({ content: `${MANUAL}\n${'尾部内容'.repeat(4000)}` })
  try {
    kit.summariser.maxHeadChars = 200
    await kit.summariser.maybeRun({ ownerId: OWNER, id: kit.entry.id })
    assert.ok(kit.calls[0].user.length < 1000, '不该把整份手册喂进去')
    assert.match(kit.calls[0].user, /信用卡业务手册/)
  } finally {
    kit.cleanup()
  }
})

test('does not summarise the same document twice', async () => {
  const kit = harness()
  try {
    await kit.summariser.maybeRun({ ownerId: OWNER, id: kit.entry.id })
    assert.equal(kit.calls.length, 1)
    assert.equal(await kit.summariser.maybeRun({ ownerId: OWNER, id: kit.entry.id }), null)
    assert.equal(kit.calls.length, 1, '已有摘要就不该再花一次模型调用')
  } finally {
    kit.cleanup()
  }
})

test('swallows a malformed model reply and leaves the document usable', async () => {
  const kit = harness({ reply: '这不是 JSON' })
  try {
    assert.equal(await kit.summariser.maybeRun({ ownerId: OWNER, id: kit.entry.id }), null)
    // 摘要失败不影响资料本身：路径仍然可用，仍然能交给后端
    const entry = kit.library.get(OWNER, kit.entry.id)
    assert.equal(entry.summarised, false)
    assert.ok(entry.path)
    assert.ok(kit.audit.some(item => item.op === 'error'))
  } finally {
    kit.cleanup()
  }
})

test('tolerates a fenced json reply', async () => {
  const kit = harness({
    reply: '```json\n{"title":"手册","gist":"说明","sections":["一节"]}\n```',
  })
  try {
    const updated = await kit.summariser.maybeRun({ ownerId: OWNER, id: kit.entry.id })
    assert.equal(updated.title, '手册')
  } finally {
    kit.cleanup()
  }
})

test('a rejecting model call never escapes', async () => {
  const kit = harness({ reply: () => { throw new Error('模型不可用') } })
  try {
    assert.equal(await kit.summariser.maybeRun({ ownerId: OWNER, id: kit.entry.id }), null)
    assert.ok(kit.audit.some(item => item.op === 'error'))
  } finally {
    kit.cleanup()
  }
})

test('refuses a summary that leaked a credential', async () => {
  const kit = harness({
    reply: '{"title":"配置说明","gist":"示例 api_key 是 sk-abcdefgh12345678","sections":[]}',
  })
  try {
    // 资料本体不过敏感闸门（手册里写「重置密码流程」是正常的），
    // 但摘要是模型产出的自由文本，可能把示例凭据抄进来
    assert.equal(await kit.summariser.maybeRun({ ownerId: OWNER, id: kit.entry.id }), null)
    assert.equal(kit.library.get(OWNER, kit.entry.id).summarised, false)
    assert.ok(kit.audit.some(item => item.reason === 'sensitive_summary'))
  } finally {
    kit.cleanup()
  }
})

test('skips a document whose bytes turned out to be binary', async () => {
  const kit = harness({ content: '# 标题\u0000\u0001二进制' })
  try {
    assert.equal(await kit.summariser.maybeRun({ ownerId: OWNER, id: kit.entry.id }), null)
    assert.ok(kit.audit.some(item => item.reason === 'unreadable_document'))
    assert.equal(kit.calls.length, 0, '读不出文本就不该白花一次调用')
  } finally {
    kit.cleanup()
  }
})

test('stays disabled without an llm call or a library', () => {
  assert.equal(new DomainSummariser({ library: {} }).enabled(), false)
  assert.equal(new DomainSummariser({ llmCall: async () => '' }).enabled(), false)
  assert.equal(
    new DomainSummariser({ library: {}, llmCall: null })
      .maybeRun({ ownerId: OWNER, id: 'x' }),
    null,
  )
})

test('ignores an unknown document id', async () => {
  const kit = harness()
  try {
    assert.equal(await kit.summariser.maybeRun({ ownerId: OWNER, id: 'nope' }), null)
    assert.equal(kit.calls.length, 0)
  } finally {
    kit.cleanup()
  }
})

test('catchUp summarises what a previous run left pending', async () => {
  const kit = harness()
  try {
    const second = kit.library.import({
      ownerId: OWNER,
      sourcePath: (() => {
        const extra = join(mkdtempSync(join(tmpdir(), 'qwaudio-extra-')), 'other.md')
        writeFileSync(extra, '# 另一份\n\n## 某节\n内容\n')
        return extra
      })(),
    })
    assert.equal(kit.library.pendingSummary(OWNER).length, 2)
    const done = await kit.summariser.catchUp({ ownerId: OWNER })
    assert.equal(done.length, 2)
    assert.equal(kit.library.pendingSummary(OWNER).length, 0)
    assert.ok(kit.library.get(OWNER, second.id).summarised)
  } finally {
    kit.cleanup()
  }
})
