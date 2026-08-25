# 前台知识库基础层

qwen-audio-agent 将文档知识放在语音前台，而不是后台 Agent workspace、ACP Session 或
用户任务队列中。因此即使后台选择 `none`，或之后更换后台，前台仍可使用同一份知识。

当前版本只建立存储和索引基础，不会自动索引上传附件，也尚未向 Realtime 模型开放文档
检索工具。检索、上下文选择和 RAG 工具将在下一阶段基于这一层实现。

## 处理链路

```text
文档来源
    → DocumentExtractor
    → 有界文本分块
    → KnowledgeStore
```

索引通过 `knowledge_index` System Job 执行。System Job 使用独立于用户任务的资源池，
不会显示任务卡片、分配 `job_id`、触发播报或进入任务通知。单个用户的写入会串行执行，
避免桌面版与 CLI 同时更新时静默覆盖。

这一层定义两个与供应商无关的 Port：

- `DocumentExtractor`：声明支持的格式并提取有界文本。
- `KnowledgeStore`：按用户隔离地保存、列出、读取和删除文档，并报告健康状态。

内置抽取器支持 UTF-8 纯文本、Markdown、HTML、CSV、JSON 和 NDJSON。单个来源最大
5 MiB，抽取文本最多 500,000 个字符，索引时单文档最多 256 个分块。HTML 中的脚本、
样式、注释和标签会在保存前移除。不支持的二进制格式会明确失败，不猜测格式，也不会
自动发送给其他服务。

## 本地存储与隐私

默认 Store 按用户写入经过哈希命名的独立文件，目录为：

```text
~/.config/qwaudio/knowledge/
```

桌面版与 CLI 共享这个资产目录。文件仅当前用户可读写，有容量上限，采用原子替换，并
通过与其他共享资产一致的跨进程事务锁保护。知识库只保留抽取后的文本和来源元数据，
不会复制原始二进制文件。

可通过 `QWEN_AUDIO_AGENT_KNOWLEDGE_DIR` 更改目录。也可以在 Gateway 组合边界注入自定义
Store 或 Extractor，无需改动前台和后台协议。
