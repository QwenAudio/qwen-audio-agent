# 知识检索 Provider

qwen-audio-agent 只定义轻量的知识检索边界，不内置一套具体 RAG。仓库不替用户选择
向量数据库、Embedding 模型、文档解析器、切分策略、索引或入库流程；应用可以接入自己
已经使用的知识系统。

知识检索是可选能力。没有注入 Provider 时，Gateway 不创建知识库目录、不注册
`knowledge` 工具，并将该能力报告为未配置。CLI、TUI、WebUI 和桌面版遵循同一行为。

## 架构边界

```text
Realtime Voice Agent
        │ knowledge(query)
        ▼
FrontendKnowledgeRuntime
  - 能力门控
  - 超时和取消
  - 结果限制与规范化
  - 引用和不可信数据提示
        │ 与供应商无关的请求
        ▼
KnowledgeRetrievalProvider
        │
        ├─ LangChain / LlamaIndex Adapter
        ├─ Haystack Adapter
        ├─ OpenAI File Search Adapter
        ├─ MCP 或 HTTP Adapter
        └─ 企业私有知识服务
```

核心层负责检索安全；Provider 负责连接凭证、租户映射、文档管理、索引、排序和供应商
API。两者不互相侵入。

## Provider 协议

从公开入口导入协议版本：

```js
import {
  KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
} from 'qwen-audio-agent/knowledge-provider'
```

Provider 只强制要求 `describe()` 和 `retrieve()`：

```js
const provider = {
  describe() {
    return {
      protocolVersion: KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
      key: 'company-search',
      label: '企业知识库',
      capabilities: {
        filters: true,
        scores: true,
        citations: true,
      },
    }
  },

  async retrieve(request, context) {
    return { results: [] }
  },

  // 可选生命周期接口。
  async health({ signal }) {
    return { status: 'ready' }
  },

  async close() {},
}
```

`key` 只能使用小写字母、数字和连字符。必须声明协议版本 `1`，不兼容的 Provider 会在
组装阶段失败，而不是等到语音对话时才报错。`capabilities` 是描述性布尔值，不改变核心
请求和响应结构。

`health()` 可选，可返回 `ready`、`unconfigured`、`degraded` 或 `unavailable`；省略时
视为 ready。`close()` 也可选，Gateway 关闭时调用一次。

## 请求与可信上下文

两个参数刻意分离：

```js
request = {
  query: '发布审批规则是什么？',
  topK: 5,
  knowledgeBaseIds: ['engineering'],
  filters: {},
}

context = {
  ownerId,
  sessionId,
  turnId,
  traceId,
  signal,
}
```

模型可以提出查询、结果数量以及此前由系统公开的知识库 ID。owner、Session、Turn、
Trace、超时和取消上下文只能由 Gateway 注入。Provider 不能从模型参数中接受租户身份。

`topK` 限制在 `1..8`，`knowledgeBaseIds` 最多八项。宿主程序可以传入 Provider 专用
过滤条件；默认 Realtime 工具不会把任意 filters 开放给模型。

## 响应

返回数组或 `{ results: [...] }`：

```js
{
  results: [{
    id: 'chunk-42',
    content: '发布需要两位审核人批准。',
    score: 0.91,
    source: {
      id: 'release-handbook',
      title: '发布手册',
      uri: 'https://docs.example.com/releases',
      mimeType: 'text/markdown',
      locator: 'section=approvals',
    },
    metadata: {
      department: 'engineering',
    },
  }],
}
```

只有 `id` 和 `content` 必填。Gateway 统一截断文本、丢弃空结果、按 ID 去重、限制基础
类型 metadata，并规范化其余字段。公开 HTTP(S) 来源会转换成同一 Turn 内稳定的引用；
私有地址和带凭证 URI 会被丢弃；非公开位置应使用有界的 `source.id` 与
`source.locator` 表达。

知识内容始终是不可信数据，只能提供事实，不能新增工具或覆盖系统和用户指令。

## 组装方式

在应用 Composition Root 注入：

```js
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'

const gateway = createGatewayApplication({
  knowledgeProvider: provider,
})
```

这是唯一必须的接入点。Runtime 会发布 `knowledge` 能力、注册检索工具，并随 Gateway
关闭 Provider。Provider 的专用配置继续放在宿主应用或 Adapter 内。

## Adapter 映射建议

主流方案都能自然映射到这个边界：

| 系统 | Adapter 映射 |
| --- | --- |
| LangChain | 用 `request.query` 调用 Retriever，把 Documents 映射为 results。 |
| LlamaIndex | 调用 Retriever，映射 Node、Score 和 Node Metadata。 |
| Haystack | 运行 Retriever Component，映射带分数的 Documents 和过滤条件。 |
| OpenAI File Search | 映射 Query、Vector Store 范围、结果数、文件引用和正文。 |
| MCP | 调用一个检索工具，把 Structured Output 转换成标准响应。 |
| HTTP | POST 标准请求，再转换服务响应。 |

参考：[LangChain Retrievers](https://docs.langchain.com/oss/python/integrations/retrievers)、
[LlamaIndex Retrievers](https://developers.llamaindex.ai/python/framework/module_guides/querying/retriever/)、
[Haystack Retrievers](https://docs.haystack.deepset.ai/docs/retrievers) 和
[OpenAI File Search](https://developers.openai.com/api/docs/guides/tools-file-search)。

Adapter 应当在自己的边界完成供应商字段转换；供应商 Client 和原始响应对象不能泄漏到
Gateway、语音层或客户端代码。

## 内置的本机资料库 Provider

仓库自带一个可选实现 `LocalDomainKnowledgeProvider`，用途是「用户指一份本机文件，
助手以后能查到它」。设 `QWEN_AUDIO_DOMAIN_LIBRARY=on` 即启用；此时若宿主没有另外
注入 Provider，它会自动成为那一个。

它按本文的分层拆成两半：

| 部分 | 归属 |
| --- | --- |
| 检索 | `LocalDomainKnowledgeProvider`，实现本协议 |
| 导入 / 列出 / 删除 / PDF 与 Word 转换 | `DomainLibrary`，属于下一节说的独立管理扩展 |

### 它返回什么

刻意不返回正文。`content` 是「标题 + 一句说明 + 章节标题 + 正文在哪」，文件路径放在
`source.locator`（本机路径是私有地址，Gateway 会丢弃 `uri` 且不生成引用）。

这样每份资料在前端的占用与文档大小无关 —— 一份 3 页备忘与一份 300 页手册占同样大小。
需要原文时把 `locator` 交给后端去读，前端不搬运内容。

章节标题**照抄原文**，因为它是后端定位的锚点；改写过的标题对不上原文。

### 与外部 RAG Provider 不能并存

一个 Gateway 只挂一个 Provider（装配处是
`knowledgeProvider || knowledgeRetrievalProvider || 本机资料库兜底`）。用户配了企业
知识服务，说明他已有更完整的方案，那时不该用这个轻量实现去覆盖它。

需要两者并存时，宿主自己包一层即可，不需要核心支持：

```js
const composite = {
  describe: () => enterprise.describe(),
  async retrieve(request, context) {
    const [remote, local] = await Promise.all([
      enterprise.retrieve(request, context),
      localDomain.retrieve(request, context),
    ])
    return { results: [...remote.results, ...local.results] }
  },
}
```

### 两个已知限制

- **没配记忆凭据时只能按文件名或标题检索。** 章节与说明由一次模型调用产出，
  没有 `QWEN_AUDIO_MEMORY_API_KEY` 时它们为空。此时搜「年费」（只出现在正文里）
  找不到，搜文件名里的词能找到。
- **答不了「我有哪些资料」。** 检索要求 `query` 非空且始终作为过滤条件，列出属于
  管理扩展的职责（Web 面板已提供列表与删除）。

## 文档管理属于独立扩展

入库、列出、完整读取、更新和删除不属于协议 V1。这些操作在不同服务中的差异很大，
通常也需要比检索更严格的授权。应用可以提供独立管理界面，或自行定义
`KnowledgeManagementProvider`，但不应向模型可见的检索工具加入供应商专用动作。

这样既保持检索接口轻量，也允许每种实现继续使用自己的原生管理和配置流程。
