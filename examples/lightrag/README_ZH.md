# Qwen Audio Agent LightRAG 接入示例

[English](README.md) | 中文

这个示例展示如何把用户独立部署的
[LightRAG](https://github.com/HKUDS/LightRAG) 接入 qwen-audio-agent。LightRAG
拥有文档解析、切分、Embedding、索引和检索；Gateway 只通过通用
`KnowledgeProvider` 接口使用它，不安装、不启动，也不修改 LightRAG。

## 核心特点

- **知识库可替换：**通用知识运行时只依赖带版本的 `KnowledgeProvider` 接口，
  LightRAG 专用逻辑全部留在本示例中。
- **原始材料检索：**使用 `/query/data` 获取检索片段，最终回答仍由语音前台生成。
- **完整资料管理：**支持文件上传、异步索引、分页列表和异步删除。
- **独立模型配置：**LightRAG 自行管理 LLM、Embedding 模型、索引和存储，
  不与语音前台共享隐式配置。
- **供应商对象隔离：**图谱对象、远程 `track_id` 和原始 HTTP 响应不会穿过
  Provider 边界。

## 架构

| 组件 | 职责 |
|---|---|
| qwen-audio-agent Gateway | 实时语音对话、知识工具和入库任务生命周期。 |
| [`LightRagKnowledgeProvider`](lightrag-provider.mjs) | 把 LightRAG API 映射为通用 `KnowledgeProvider`。 |
| [`LightRagClient`](lightrag-client.mjs) | LightRAG URL、认证、workspace、超时和 HTTP 错误。 |
| 用户运行的 LightRAG Server | 文档解析、切分、Embedding、图谱、索引和检索。 |

Provider 使用 LightRAG 的 `/query/data` 获取原始检索片段，最终回答仍由语音前台组织。
LightRAG 的图谱对象、远程 `track_id` 和原始 HTTP 响应不会穿过 Provider 边界。

## 快速开始

需要使用仓库要求的 Node.js 版本，并提前安装 `uv`。在 qwen-audio-agent 仓库根目录执行：

```bash
npm ci
```

### 安装并配置 LightRAG

推荐使用 `uv` 独立安装：

```bash
uv tool install "lightrag-hku[api]"
mkdir -p ~/lightrag-runtime
cd ~/lightrag-runtime
```

LightRAG 必须配置一个 LLM 和一个 Embedding 模型。它们可以来自本地 Ollama，也可以来自
OpenAI 兼容服务；具体模型、维度和服务地址由用户决定。下面只展示必要字段，保存为当前
目录的 `.env`：

```dotenv
LLM_BINDING=openai
LLM_BINDING_HOST=https://your-openai-compatible-service.example/v1
LLM_BINDING_API_KEY=your_llm_key
LLM_MODEL=your_llm_model

EMBEDDING_BINDING=openai
EMBEDDING_BINDING_HOST=https://your-openai-compatible-service.example/v1
EMBEDDING_BINDING_API_KEY=your_embedding_key
EMBEDDING_MODEL=your_embedding_model
EMBEDDING_DIM=1024

# 推荐为本机 API 设置独立访问密钥
LIGHTRAG_API_KEY=your_lightrag_api_key
```

Embedding 维度必须与所选模型一致。首次索引后不要直接更换 Embedding 模型或维度；需要
更换时，请按照 LightRAG 文档清理并重新建立索引。

启动仅监听本机的服务：

```bash
cd ~/lightrag-runtime
lightrag-server --host 127.0.0.1 --port 9621
```

打开 `http://127.0.0.1:9621/webui`，确认服务正常。完整模型、解析器和存储配置见
[LightRAG Server 官方文档](https://github.com/HKUDS/LightRAG/blob/main/docs/LightRAG-API-Server.md)。

### 启动示例 Gateway

在 qwen-audio-agent 仓库根目录执行：

```bash
cp examples/lightrag/.env.example examples/lightrag/.env.local
```

编辑 `.env.local`：

```dotenv
DASHSCOPE_API_KEY=your_dashscope_api_key
AGENT_PROTOCOL=none

LIGHTRAG_URL=http://127.0.0.1:9621
LIGHTRAG_API_KEY=your_lightrag_api_key
LIGHTRAG_WORKSPACE=
LIGHTRAG_QUERY_MODE=mix
```

这里的 `DASHSCOPE_API_KEY` 只供 qwen-audio-agent 语音前台使用；LightRAG 使用它自己
进程中的模型配置。两者即使连接同一家模型服务，也不会自动共享配置。

启动示例：

```bash
node --env-file=examples/lightrag/.env.local examples/lightrag/gateway.mjs
```

打开 `http://127.0.0.1:3101`。示例使用仅前台模式，目的是单独验证知识库 Provider，
不会启动后台 Agent。

## 体验方法

1. 在 WebUI 打开“资料库”。
2. 粘贴一个本机文件的绝对路径并导入。
3. 等待 LightRAG 完成解析和索引。
4. 询问：“根据资料库，概括这份文档的发布审批规则。”

上传是异步的：LightRAG 返回 `track_id` 后仍会继续索引。Provider 会在内部轮询到
`PROCESSED` 或 `FAILED`，Gateway 只在真实终态后更新入库任务。删除也会等待远端实际
完成，不会把 `deletion_started` 提前显示成“已删除”。

## 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LIGHTRAG_URL` | `http://127.0.0.1:9621` | LightRAG Server 地址 |
| `LIGHTRAG_API_KEY` | 空 | 通过 `X-API-Key` 发送的 LightRAG 访问密钥 |
| `LIGHTRAG_WORKSPACE` | 空 | 可选的 workspace 选择器，通过 `LIGHTRAG-WORKSPACE` 发送；除运维已开通外请留空 |
| `LIGHTRAG_QUERY_MODE` | `mix` | `local`、`global`、`hybrid`、`naive` 或 `mix` |
| `LIGHTRAG_RETRIEVAL_TIMEOUT_MS` | `60000` | Gateway 等待一次检索的最长时间 |
| `LIGHTRAG_REQUEST_TIMEOUT_MS` | `30000` | 单次 HTTP 请求超时 |
| `LIGHTRAG_INGESTION_TIMEOUT_MS` | `900000` | 等待索引完成的最长时间 |
| `LIGHTRAG_DELETION_TIMEOUT_MS` | `120000` | 等待删除完成的最长时间 |
| `LIGHTRAG_POLL_INTERVAL_MS` | `1000` | 远端作业轮询间隔 |

Gateway 取消入库任务时，Provider 会停止本地等待，但不会调用 LightRAG 的全局
`cancel_pipeline`，以免取消同一实例中的其他文档。

除 LightRAG 运维已为该密钥开通 workspace 外，`LIGHTRAG_WORKSPACE` 请留空。当前 LightRAG 只在
状态路由读取 `LIGHTRAG-WORKSPACE`，检索与文档端点并不读取，因此在此填值不会带来数据隔离，数据
仍会落到服务端配置的那个 workspace。等服务端多 workspace 支持落地后，未登记 catalog 记录、或
成员表中不含该密钥的选择器会被直接拒绝而非静默回退，所以留空在改动前后都是正确配置。

## 替换和扩展

| 需求 | 修改位置 |
|---|---|
| 使用已有 LightRAG 服务 | 设置 `LIGHTRAG_URL` 和 `LIGHTRAG_API_KEY`。 |
| 调整检索策略 | 设置 `LIGHTRAG_QUERY_MODE` 和检索超时。 |
| 在其他宿主中接入 | 创建 Provider 后，通过 `knowledgeProvider` 注入 `createGatewayApplication`。 |
| 替换为其他知识系统 | 实现同一版本的 `KnowledgeProvider` 接口。 |

要接入其他知识系统，只替换 Provider；Realtime 工具、Gateway Task 和客户端不需要加入
供应商专属代码。完整接口见[知识库 Provider](../../docs/reference/knowledge.zh.md)。

## 作者与致谢

- [LightRAG 项目及其贡献者](https://github.com/HKUDS/LightRAG)：创建并开源 LightRAG，
  为本示例提供文档处理、知识图谱和检索能力。
- [Li Xu](https://github.com/x-lixu)：设计可替换的 `KnowledgeProvider` 边界，并实现
  LightRAG 接入示例。
