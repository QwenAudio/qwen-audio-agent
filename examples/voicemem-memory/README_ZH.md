# Qwen Audio Agent VoiceMem 记忆 Provider 示例

[English](README.md) | 中文

这是一个可运行的 qwen-audio-agent 记忆扩展示例，使用
[VoiceMem](https://github.com/xzf-thu/VoiceMem) 替换完整的用户记忆系统。用户可以在
自然对话中表达偏好和长期事实，并在新的语音 Session 中继续召回这些信息。

`PROMPT.md` 与 `ASSISTANT.md` 仍属于系统指令；用户偏好、长期事实、语义召回、
自动学习和会话结束整理均由该 Provider 负责。

## 核心特点

- **记忆系统可替换：**Gateway 只依赖带版本的 `MemoryProvider` 接口，不包含 VoiceMem
  专用逻辑。
- **明确偏好即时更新：**原有 `memory` 工具继续支持精确读取、新增、替换和删除。
- **自动学习：**语音 Session 断开后，完整用户轮次会合并为一个观察批次，由 VoiceMem
  在后台抽取和整理。
- **语义召回：**自然语言记忆查询使用 VoiceMem 检索，不要求与原文精确匹配。
- **用户隔离：**每个 Gateway owner 使用独立哈希标识的偏好快照和 VoiceMem 记忆空间。
- **单一学习链路：**VoiceMem 接管会话观察后，框架内置抽取器和偏好学习器自动停用，
  避免同一段对话被重复学习。

## 架构

| 组件 | 职责 |
|---|---|
| qwen-audio-agent Gateway | 实时语音对话、记忆工具和 Provider 生命周期。 |
| [`voicemem-memory-provider.mjs`](voicemem-memory-provider.mjs) | Node.js `MemoryProvider`、同步偏好快照、用户隔离和子进程管理。 |
| [`sidecar/server.py`](sidecar/server.py) | 基于 JSONL 的轻量进程边界，调用 VoiceMem 公开 Python API。 |
| VoiceMem | 记忆抽取、整理、结构化存储和语义检索。 |
| 阿里云百炼 | 推荐推理服务：Qwen3.8-Flash 处理记忆，text-embedding-v4 生成检索向量。 |

Node.js Gateway 按需启动一个长期运行的 Python Sidecar，通过标准输入输出传递逐行
JSON 请求和响应。Python 依赖不会进入 Gateway 的 npm 依赖和公共扩展接口。

## 快速开始

需要使用仓库要求的 Node.js 版本和 Python 3.10 或更高版本。在仓库根目录执行：

```bash
npm ci
python3 --version # 需要 3.10 或更高版本
python3.12 -m venv examples/voicemem-memory/.venv
examples/voicemem-memory/.venv/bin/pip install \
  --index-url https://mirrors.aliyun.com/pypi/simple/ \
  -r examples/voicemem-memory/sidecar/requirements.txt
cp examples/voicemem-memory/.env.example \
  examples/voicemem-memory/.env.local
```

在 `.env.local` 中填写百炼 API Key，然后启动。默认配置使用仅前台模式和隔离的本地
运行数据，不会修改用户日常使用的 Gateway 配置：

```bash
cd examples/voicemem-memory
node --env-file=.env.local gateway.mjs
```

浏览器打开 `http://127.0.0.1:3101`。如果该端口已有 Gateway，可以使用 `PORT=3102`
启动，并打开 `http://127.0.0.1:3102`。
Adapter 会自动发现示例目录中的 `.venv`；只有使用其他 Python 环境时才需要设置
`VOICEMEM_PYTHON`。

## 推荐配置

示例检测到 `DASHSCOPE_API_KEY` 后，会自动映射给 VoiceMem 的 OpenAI 兼容客户端，
并采用以下默认配置：

```dotenv
DASHSCOPE_API_KEY=your_dashscope_api_key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VOICEMEM_CHAT_MODEL=qwen3.8-flash
VOICEMEM_EMBEDDING_MODEL=text-embedding-v4
VOICEMEM_EMBED_DIM=1024
VOICEMEM_MEMORY_LANGUAGE=zh
```

[`qwen3.8-flash`](https://help.aliyun.com/zh/model-studio/qwen3-8-flash) 用于记忆抽取和整理，
[`text-embedding-v4`](https://help.aliyun.com/zh/model-studio/embedding) 用于语义检索。
`OPENAI_*` 是 VoiceMem 兼容客户端采用的变量名；这套配置使用的密钥、服务地址和模型
均来自百炼。用户显式设置的 `OPENAI_*` 和 `VOICEMEM_*` 配置优先。

## 体验方法

1. 对助手说：“我住在杭州，喜欢打羽毛球，以后叫我船长。”
2. 关闭或刷新 WebUI，让已完成的 Session 触发记忆整理。
3. 新建 Session 后询问：“我住在哪里、喜欢什么，你应该怎么称呼我？”

明确偏好在下一个 Session 中即可使用。VoiceMem 自动抽取在断开连接后运行，可能需要
几十秒，但不会阻塞前台语音对话。后台观察和整理最多等待 120 秒，交互式召回仍使用
较短的 30 秒超时。如果同一用户的后台整理尚未完成，查询会立即返回同步偏好快照，
不会继续排在后台任务之后等待。

## 数据存储

默认数据保存在当前工作目录的 `.qwen-audio/voicemem/`：

| 路径 | 内容 |
|---|---|
| `profiles/<owner-hash>.json` | 明确偏好和事实的有界同步快照。 |
| `memory-spaces/<owner-hash>/` | VoiceMem SQLite 数据、元信息和本地 Qdrant 向量。 |
| `observed-messages.json` | 防止重连后重复写入的有界消息指纹。 |

不要提交该目录。生产部署应使用持久化存储、托管 Sidecar 进程，并自行制定凭据和租户
映射策略。

## 替换和扩展

| 需求 | 修改位置 |
|---|---|
| 使用其他 OpenAI 兼容推理服务 | 设置 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和对应的 `VOICEMEM_*` 模型变量。 |
| 修改记忆持久化位置 | 创建 `VoiceMemMemoryProvider` 时传入 `stateDirectory`。 |
| 替换为其他记忆系统 | 实现同一版本的 `MemoryProvider` 接口，并注入 `createGatewayApplication`。 |
| 增加 VoiceMem 原生音频处理 | 扩展 Adapter 与 Sidecar，无需修改 Gateway 接口。 |

当前示例只向 VoiceMem 发送用户语音的转写文本，不发送原始麦克风音频流。

## 作者与致谢

- [Xie Zhifei](https://github.com/xzf-thu)：创建并开源 VoiceMem，为本示例提供记忆抽取、
  整理和检索能力。
- [Li Xu](https://github.com/x-lixu)：设计可替换的 `MemoryProvider` 边界，并实现
  Node.js/Python 接入示例。
