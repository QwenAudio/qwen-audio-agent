import assert from 'node:assert/strict'
import test from 'node:test'
import { FrontendKnowledgeRuntime } from '../src/frontend/knowledge/knowledge-runtime.mjs'
import {
  LocalKnowledgeProvider,
} from '../src/app/knowledge/local-knowledge-provider.mjs'

const manual = {
  id: 'doc1',
  title: '信用卡业务手册',
  gist: '覆盖开卡与年费两类流程',
  sections: ['开卡与激活', '年费规则'],
  path: '/data/workspace/domain/信用卡业务手册.md',
  filename: '信用卡业务手册.md',
  body: '# 信用卡业务手册\n\n## 开卡与激活\n收到卡片后完成身份校验。\n\n## 年费规则\n普卡首年免年费。',
}

function library({ entries = [manual], configured = true } = {}) {
  return {
    configured: () => configured,
    list: ownerId => ownerId === 'owner' ? entries : [],
    readHead: entry => entry.body || '',
  }
}

test('conforms to the knowledge retrieval provider contract', () => {
  // 通过 FrontendKnowledgeRuntime 构造即等于跑了一遍 assertKnowledgeRetrievalProvider
  const runtime = new FrontendKnowledgeRuntime({
    provider: new LocalKnowledgeProvider({ library: library() }),
  })
  assert.deepEqual(runtime.capabilities(), ['knowledge'])
  const described = runtime.describe()
  assert.equal(described.configured, true)
  assert.equal(described.provider.protocolVersion, 1)
  assert.equal(described.provider.key, 'local-domain')
})

test('returns source text instead of routing retrieval through the backend', async () => {
  const runtime = new FrontendKnowledgeRuntime({
    provider: new LocalKnowledgeProvider({ library: library() }),
  })
  const output = await runtime.search('年费', { ownerId: 'owner' })
  const [result] = output.results

  assert.match(result.content, /普卡首年免年费/)
  assert.match(result.content, /年费规则/)
  assert.doesNotMatch(result.content, /spawn_thinking|objective/)
})

test('returns bounded document chunks with private source locators', async () => {
  const runtime = new FrontendKnowledgeRuntime({
    provider: new LocalKnowledgeProvider({ library: library() }),
  })
  const output = await runtime.search('年费', { ownerId: 'owner' })

  assert.equal(output.status, 'ok')
  const [result] = output.results
  assert.match(result.content, /信用卡业务手册/)
  assert.match(result.content, /普卡首年免年费/)
  assert.ok(result.content.length < 2000, `片段必须有界，实际 ${result.content.length} 字符`)

  assert.equal(result.source.locator, '年费规则')
  assert.equal(result.source.uri, undefined)
  assert.equal(result.citation_id, undefined)
  assert.deepEqual(output.citations, [])
})

test('takes the owner from trusted context and never from the model', async () => {
  // 协议明确要求 Provider 不得从模型参数接受租户身份 —— 否则模型报一个别人的
  // ownerId 就能读到别人的资料。
  let seenOwner
  const provider = new LocalKnowledgeProvider({ library: library() })
  const original = provider.library.list.bind(provider.library)
  provider.library.list = ownerId => {
    seenOwner = ownerId
    return original(ownerId)
  }
  const runtime = new FrontendKnowledgeRuntime({ provider })

  await runtime.search('年费', { ownerId: 'owner' })
  assert.equal(seenOwner, 'owner')

  // 换一个 owner 就查不到同一份资料
  const other = await runtime.search('年费', { ownerId: 'someone-else' })
  assert.equal(other.status, 'not_found')
  assert.deepEqual(other.results, [])
})

test('reports unconfigured instead of pretending to be ready', async () => {
  // 目录没配置时如实报 unconfigured，而不是假装 ready 然后每次检索都空手而归。
  const runtime = new FrontendKnowledgeRuntime({
    provider: new LocalKnowledgeProvider({ library: library({ configured: false }) }),
  })
  assert.deepEqual(await runtime.health(), {
    status: 'unconfigured',
    ok: false,
    message: '资料库未配置存放目录。',
  })
  const output = await runtime.search('年费', { ownerId: 'owner' })
  assert.equal(output.status, 'not_found')
})

test('reports not_found when nothing matches', async () => {
  const runtime = new FrontendKnowledgeRuntime({
    provider: new LocalKnowledgeProvider({ library: library() }),
  })
  const output = await runtime.search('完全无关的东西', { ownerId: 'owner' })
  assert.equal(output.status, 'not_found')
  assert.deepEqual(output.results, [])
})

test('rejects rich documents clearly when no isolated converter is configured', async () => {
  const provider = new LocalKnowledgeProvider({ library: library() })
  await assert.rejects(
    provider.ingest({ source: { path: '/docs/manual.pdf' } }, { ownerId: 'owner' }),
    error => error.code === 'document_converter_unavailable',
  )
})

test('refuses a library-less construction instead of failing at retrieval time', () => {
  assert.throws(
    () => new LocalKnowledgeProvider({}),
    /requires a document library/,
  )
})
