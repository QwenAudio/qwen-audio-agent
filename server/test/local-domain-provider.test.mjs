import assert from 'node:assert/strict'
import test from 'node:test'
import { FrontendKnowledgeRuntime } from '../src/frontend/knowledge/knowledge-runtime.mjs'
import {
  LocalDomainKnowledgeProvider,
} from '../src/frontend/knowledge/local-domain-provider.mjs'

const manual = {
  id: 'doc1',
  title: '信用卡业务手册',
  gist: '覆盖开卡与年费两类流程',
  sections: ['开卡与激活', '年费规则'],
  path: '/data/workspace/domain/信用卡业务手册.md',
  filename: '信用卡业务手册.md',
}

// 只实现 provider 用到的两个读接口，其余管理动作（导入、删除）不属于协议 V1。
function library({ entries = [manual], configured = true } = {}) {
  return {
    configured: () => configured,
    search({ ownerId, keyword = '', limit }) {
      if (ownerId !== 'owner') return []
      const pool = entries.slice(0, limit || 5)
      if (!keyword) return pool
      const needle = keyword.toLowerCase()
      return pool.filter(entry => [
        entry.title,
        entry.gist,
        ...entry.sections,
      ].join(' ').toLowerCase().includes(needle))
    },
  }
}

test('conforms to the knowledge retrieval provider contract', () => {
  // 通过 FrontendKnowledgeRuntime 构造即等于跑了一遍 assertKnowledgeRetrievalProvider
  const runtime = new FrontendKnowledgeRuntime({
    provider: new LocalDomainKnowledgeProvider({ library: library() }),
  })
  assert.deepEqual(runtime.capabilities(), ['knowledge'])
  const described = runtime.describe()
  assert.equal(described.configured, true)
  assert.equal(described.provider.protocolVersion, 1)
  assert.equal(described.provider.key, 'local-domain')
})

test('tells the model to hand the path to the backend', async () => {
  // 前端只知道这份资料是什么，不知道里面写了什么，而模型手上没有读文件的工具。
  // 只说「正文在某个路径」的话，模型会以为自己能读 —— 要么凭标题猜内容，要么让
  // 用户自己去看文件。这条移交指令是「细节交给后端」这个分工的最后一环，
  // 而它不能写进 knowledge 工具的 description（那是主线的通用工具）。
  const runtime = new FrontendKnowledgeRuntime({
    provider: new LocalDomainKnowledgeProvider({ library: library() }),
  })
  const output = await runtime.search('年费', { ownerId: 'owner' })
  const [result] = output.results

  assert.match(result.content, /spawn_thinking/, '必须点名交给哪个工具')
  assert.match(result.content, /objective/, '要说清路径写进哪里')
  assert.ok(result.content.includes(manual.path), '路径要出现在正文里，不只在 locator')
  assert.match(result.content, /不要凭标题/, '要挡住凭标题猜内容')
  // 章节标题作为定位锚点一并交出去，让 objective 能说准查哪一节
  assert.match(result.content, /年费规则/)
})

test('describes a document without carrying its body', async () => {
  const runtime = new FrontendKnowledgeRuntime({
    provider: new LocalDomainKnowledgeProvider({ library: library() }),
  })
  const output = await runtime.search('年费', { ownerId: 'owner' })

  assert.equal(output.status, 'ok')
  const [result] = output.results
  // 前端只交「有没有、是什么、在哪」，正文由后端自己去读 —— 这条判据是
  // 整套方案的核心：一份 3 页备忘与一份 300 页手册在这里占同样大小。
  assert.match(result.content, /信用卡业务手册/)
  assert.match(result.content, /覆盖开卡与年费两类流程/)
  assert.match(result.content, /年费规则/, '章节标题要照抄原文，它是后端 grep 的锚点')
  assert.ok(result.content.length < 400, `摘要必须有界，实际 ${result.content.length} 字符`)

  // 路径走 locator：本机路径是私有地址，协议会丢弃 uri 且不生成引用
  assert.equal(result.source.locator, manual.path)
  assert.equal(result.source.uri, undefined)
  assert.equal(result.citation_id, undefined)
  assert.deepEqual(output.citations, [])
})

test('takes the owner from trusted context and never from the model', async () => {
  // 协议明确要求 Provider 不得从模型参数接受租户身份 —— 否则模型报一个别人的
  // ownerId 就能读到别人的资料。
  let seenRequest
  const provider = new LocalDomainKnowledgeProvider({ library: library() })
  const original = provider.library.search.bind(provider.library)
  provider.library.search = args => {
    seenRequest = args
    return original(args)
  }
  const runtime = new FrontendKnowledgeRuntime({ provider })

  await runtime.search('年费', { ownerId: 'owner' })
  assert.equal(seenRequest.ownerId, 'owner')

  // 换一个 owner 就查不到同一份资料
  const other = await runtime.search('年费', { ownerId: 'someone-else' })
  assert.equal(other.status, 'not_found')
  assert.deepEqual(other.results, [])
})

test('reports unconfigured instead of pretending to be ready', async () => {
  // 目录没配置时如实报 unconfigured，而不是假装 ready 然后每次检索都空手而归。
  const runtime = new FrontendKnowledgeRuntime({
    provider: new LocalDomainKnowledgeProvider({ library: library({ configured: false }) }),
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
    provider: new LocalDomainKnowledgeProvider({ library: library() }),
  })
  const output = await runtime.search('完全无关的东西', { ownerId: 'owner' })
  assert.equal(output.status, 'not_found')
  assert.deepEqual(output.results, [])
})

test('refuses a library-less construction instead of failing at retrieval time', () => {
  assert.throws(
    () => new LocalDomainKnowledgeProvider({}),
    /requires a domain library/,
  )
})
