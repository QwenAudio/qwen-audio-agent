# 知识库 Provider

qwen-audio-agent 只定义一个轻量的 JavaScript Provider 接口。它不是网络协议，也不规定
向量数据库、Embedding 模型、解析器、切分策略或索引实现。应用可以使用仓库内置的本机
资料库，也可以用少量 Adapter 代码接入已有的 RAG 或企业知识系统。

没有注入 Provider 时，Gateway 不注册 `knowledge` 工具，并将知识能力报告为未配置。

## 边界

```text
Realtime Voice Agent
        │ knowledge(query)
        ▼
FrontendKnowledgeRuntime
  - 能力门控、超时和取消
  - 结果限制、引用和不可信数据提示
        │
        ▼
KnowledgeProvider
  - retrieve（前台模型使用）
  - ingest / list / remove（客户端管理使用，可选）
        │
        ├─ 内置 LocalKnowledgeProvider
        ├─ LlamaIndex / LangChain / Haystack Adapter
        ├─ MCP / HTTP Adapter
        └─ 企业知识服务 Adapter
```

模型只能访问 `retrieve()`。导入、列出和删除由独立的 `KnowledgeLibraryService` 暴露给
客户端，不能因为 Provider 同时实现了管理方法就变成模型工具。

## 最小接口

Provider 必须实现 `describe()` 和 `retrieve()`：

```js
import {
  KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
} from 'qwen-audio-agent/knowledge-provider'

const provider = {
  describe() {
    return {
      protocolVersion: KNOWLEDGE_PROVIDER_PROTOCOL_VERSION,
      key: 'company-knowledge',
      label: '企业知识库',
      capabilities: {
        scores: true,
        citations: true,
        filters: true,
      },
    }
  },

  async retrieve(request, context) {
    return { results: [] }
  },

  // 可选：实现完整资料管理时提供。
  async ingest(request, context) {},
  async list(request, context) {},
  async remove(request, context) {},

  // 可选生命周期方法。
  async health({ signal }) {
    return { status: 'ready' }
  },
  async close() {},
}
```

这里的版本常量只是 npm 代码接口的快速兼容性检查，不定义独立传输协议。Provider 的
HTTP、MCP 或 SDK 连接细节全部留在 Adapter 内。

只接入检索时不需要实现 `ingest/list/remove`。三者全部存在时，Gateway 才开放资料库
管理入口。

## 检索

模型可控请求和 Gateway 可信上下文分开传递：

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

Provider 返回可直接用于回答的正文片段，而不是让前台再调用后台读取的指令：

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
    metadata: { department: 'engineering' },
  }],
}
```

只有 `id` 和 `content` 必填。Gateway 会限制数量和正文长度、去重、规范化公开引用，并
把知识内容标为不可信数据。Provider 不能从模型参数中接受 owner 身份。

## 入库和管理

完整 Provider 使用同一组简单语义：

```js
await provider.ingest({
  source: {
    type: 'file',
    path: '/Users/me/manual.pdf',
    name: 'manual.pdf',
  },
}, { ownerId, taskId, signal, onEvent })

await provider.list({}, { ownerId })
await provider.remove({ documentId: 'doc-42' }, { ownerId })
```

`ingest()` 返回 Promise。Gateway 使用自己的 TaskManager 提供排队、取消和状态，不要求
Provider 再实现一套入库 Job 协议。远程知识服务自身若异步建索引，其 Adapter 在
`ingest()` 内等待或轮询，收到 `signal` 后停止即可。

## 内置基础实现

仓库内部提供 `LocalKnowledgeProvider`，通过 `QWEN_AUDIO_DOMAIN_LIBRARY=on` 启用。
它是一个可直接使用的基础实现，不是完整 RAG：

- Markdown、TXT 等文本直接复制进本机资料目录；
- PDF、Word、PPT 等复杂文档由唯一的 `AgentDocumentConverter` 转成 Markdown；
- 按 Markdown 标题和有界正文块执行简单关键词检索；
- `retrieve()` 直接返回命中的原文片段；
- 支持导入、列出和删除，不内置向量数据库或 Embedding。

复杂文档转换复用已配置后台 Agent 的进程、模型、登录和工具环境，但每次创建一个新的
隔离执行 Session。它不使用协调 Session 或委托 Session，不继承语音任务上下文，也不
进入自动播报队列。转换结束或失败后，该 Session 会被关闭或取消，并释放本地记录；
Gateway 不会随着入库次数累积活跃 Session。Agent 只是这个基础 Provider 的内部转换组件。

没有后台 Agent 或隔离执行不可用时，文本文件仍可正常入库；复杂文档会明确报告当前
没有可用转换器。

## 切换到其他知识系统

在应用 Composition Root 注入 Provider：

```js
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'

const gateway = createGatewayApplication({ knowledgeProvider: provider })
```

Adapter 只做字段和调用方式转换：

| 系统 | Adapter 的工作 |
| --- | --- |
| LangChain | 调用 Retriever，把 Document 映射为 results。 |
| LlamaIndex | 调用 Retriever，把 Node、Score 和 Metadata 映射为 results。 |
| Haystack | 运行 Retriever；若开放管理，再运行自己的 indexing pipeline。 |
| RAGFlow / 企业服务 | 映射查询、上传、资料列表和删除 API。 |
| MCP / HTTP | 调用对应工具或端点，并转换为本接口对象。 |

供应商 Client、远程 Job ID、向量库 Collection ID 和原始响应对象都留在 Adapter 内，
不能泄漏到 Gateway、Realtime 或客户端。

主流框架的对应概念可参考 [LlamaIndex Ingestion Pipeline](https://developers.llamaindex.ai/python/framework/module_guides/loading/ingestion_pipeline/)
与 [Haystack DocumentWriter](https://docs.haystack.deepset.ai/docs/documentwriter)。
