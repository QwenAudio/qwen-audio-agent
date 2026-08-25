# 前台知识库与 RAG

qwen-audio-agent 将文档知识放在语音前台，而不是后台 Agent workspace、ACP Session
或用户任务队列中。因此即使后台选择 `none`，或之后更换后台，已保存的知识仍可使用。

Realtime 模型只会看到一个按能力启用的 `knowledge` 工具：

- `index`：仅在用户明确要求时保存文本附件。
- `search`：从已保存文档中检索相关片段。
- `read`：将一份有界文档完整放入当前上下文。
- `list` 和 `remove`：管理当前用户保存的文档。

上传附件不会自动入库。索引不会读取任意本地路径或远程 URL。不支持的格式会明确失败，
不会猜测格式，也不会自动发送给其他服务。知识文本始终是不可信的事实材料，不能覆盖
系统指令或用户当前要求。

## 处理链路与 Port

```text
用户明确选择的附件
    → DocumentExtractor
    → 有界文本分块
    → KnowledgeStore
    → KnowledgeRetrievalProvider
    → 检索结果或有界 Full Context
```

这一层定义三个与供应商无关的 Port：

- `DocumentExtractor`：声明支持的格式并提取有界文本。
- `KnowledgeStore`：按用户隔离地保存、列出、读取和删除文档，并报告健康状态。
- `KnowledgeRetrievalProvider`：检索已保存文档，返回有界、规范化的文本片段。

内置抽取器支持 UTF-8 纯文本、Markdown、HTML、CSV、JSON 和 NDJSON。单个来源最大
5 MiB，抽取文本最多 500,000 个字符，索引时单文档最多 256 个分块。HTML 中的脚本、
样式、注释和标签会在保存前移除。

默认 Retrieval Provider 是轻量的本地词法检索，不调用模型，也不依赖外部服务，只作为
稳定可用的基础实现。更强的 RAG 服务只需实现 `KnowledgeRetrievalProvider`，并在 Gateway
组合边界注入，无需修改工具、客户端或后台 Adapter。

`read` 会先消除分块重叠，再返回完整文档。Full Context 最多 48,000 个字符且不超过
48 KiB UTF-8 文本；更大的文档必须使用 `search`。一次检索最多返回 8 个有界片段。

## System Job、存储与隐私

索引通过 `knowledge_index` System Job 执行。System Job 使用独立于用户任务的资源池，
不会显示任务卡片、分配 `job_id`、触发播报或进入任务通知。单个用户的写入会串行执行，
避免桌面版与 CLI 同时更新时静默覆盖。

默认 Store 按用户写入经过哈希命名的独立文件，目录为：

```text
~/.config/qwaudio/knowledge/
```

桌面版与 CLI 共享这个目录。文件仅当前用户可读写，有容量上限，采用原子替换，并通过
共享的跨进程事务锁保护。知识库只保留抽取后的文本和来源元数据，不会复制原始附件，
也不会持久化附件的本地路径。

可通过 `QWEN_AUDIO_AGENT_KNOWLEDGE_DIR` 更改目录。自定义 Store、Extractor 和 Retrieval
Provider 都是 Gateway 组合期依赖，不会扩张公开 Gateway 协议或后台协议。
