# LightRAG 知识库

qwen-audio-agent 可以把用户独立运行的
[LightRAG](https://github.com/HKUDS/LightRAG) 作为前台知识库。LightRAG 负责文档解析、
Embedding、索引和检索，Gateway 只通过 `KnowledgeProvider` 调用它。

## 适合什么场景

- 希望获得比内置关键词资料库更完整的语义与图谱检索。
- 已经在使用 LightRAG，希望语音前台复用现有文档和模型配置。
- 希望知识库可以独立升级或替换，不修改 Realtime 和客户端。

## 准备 LightRAG

LightRAG 必须独立配置一个 LLM 和一个 Embedding 模型。模型可以部署在本地，也可以使用
OpenAI 兼容服务。推荐通过 `uv` 安装 Server：

```bash
uv tool install "lightrag-hku[api]"
```

在 LightRAG 的运行目录创建 `.env`，填写以下类型的配置：

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

LIGHTRAG_API_KEY=your_lightrag_api_key
```

Embedding 维度必须与模型一致。完整配置以
[LightRAG 官方文档](https://github.com/HKUDS/LightRAG/blob/main/docs/LightRAG-API-Server.md)
为准。启动本机服务：

```bash
lightrag-server --host 127.0.0.1 --port 9621
```

## 运行接入示例

在 qwen-audio-agent 源码目录执行：

```bash
cp examples/lightrag/.env.example examples/lightrag/.env.local
```

填写语音前台和 LightRAG 连接信息：

```dotenv
DASHSCOPE_API_KEY=your_dashscope_api_key
LIGHTRAG_URL=http://127.0.0.1:9621
LIGHTRAG_API_KEY=your_lightrag_api_key
LIGHTRAG_WORKSPACE=
LIGHTRAG_QUERY_MODE=mix
```

启动：

```bash
node --env-file=examples/lightrag/.env.local examples/lightrag/gateway.mjs
```

打开 `http://127.0.0.1:3101`，在资料库面板中导入文件，等待索引完成后即可通过语音或
文字查询。这个示例使用仅前台模式，不会启动后台 Agent。

`DASHSCOPE_API_KEY` 只用于语音前台；LightRAG 的 LLM 和 Embedding 配置保留在它自己的
进程中。qwen-audio-agent 不会安装、启动或修改 LightRAG。

## 数据与任务边界

- Gateway 使用 `/query/data` 获取原始检索片段，最终回答由语音前台生成。
- LightRAG 的 `track_id`、图谱对象和 HTTP 响应不暴露给客户端或模型。
- 上传和删除虽然在 LightRAG 内部异步执行，但 Gateway 只在真实完成后报告成功。
- 取消 Gateway 入库任务会停止等待，不会调用可能影响其他文档的全局索引取消操作。
- LightRAG 的文档、索引、模型凭据和 workspace 均由用户自行保存和管理。

完整代码与全部配置项见
[`examples/lightrag`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/lightrag)。

## 作者与致谢

- 感谢 [LightRAG 项目及其贡献者](https://github.com/HKUDS/LightRAG)创建并开源文档处理、
  知识图谱和检索能力。
- [Li Xu](https://github.com/x-lixu) 设计可替换的 `KnowledgeProvider` 边界并实现本接入示例。
