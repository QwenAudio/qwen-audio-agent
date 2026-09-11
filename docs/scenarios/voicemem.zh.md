# VoiceMem

qwen-audio-agent 提供 [VoiceMem](https://github.com/xzf-thu/VoiceMem) 的 Node.js
连接器；本示例把 VoiceMem 与 Python Sidecar 安装在核心框架之外，再配置 Gateway 使用。
语音前台继续使用相同的 `memory` 工具和上下文语义，VoiceMem 负责存储、自动学习、
整理和语义检索。

`PROMPT.md` 与 `ASSISTANT.md` 仍属于助手定义，不在替换范围内。

## 核心特点

- 同时替换用户偏好和长期事实两种逻辑记忆。
- 通过现有 `memory` 工具保留明确读取、追加、替换和删除能力。
- 在语音 Session 结束后观察对话，并在后台整理转写文本或原生音频。
- 增加语义召回；VoiceMem 专用逻辑集中在独立 Provider 内，不进入通用记忆运行时。
- 按 Gateway owner 使用独立哈希空间隔离用户数据。
- 自动停用内置抽取器和偏好学习器，避免一段对话被重复学习。

## 架构

| 组件 | 职责 |
|---|---|
| qwen-audio-agent Gateway | Realtime 对话、记忆工具和 Provider 生命周期 |
| Node.js 连接器 | 框架内的 `MemoryProvider` 接口、有界同步快照、用户隔离和进程托管 |
| 示例 Python Sidecar | 通过 JSONL 对接 VoiceMem 的公开 Python API |
| VoiceMem | 记忆抽取、整理、结构化存储和语义检索 |
| 模型服务 | VoiceMem 使用的文本模型与 Embedding 模型 |

Gateway 连接器按需启动配置的外部 Python Sidecar，并通过标准输入输出传输逐行 JSON。
核心 npm 包不包含任何 VoiceMem Python 代码或依赖。

输入由 `VOICEMEM_INPUT_MODE` 切换：`text`（默认）复用 Realtime 转写；`audio`
按有效用户轮次截取 PCM16 音频并调用 VoiceMem 的 `ingest(audio=...)`，使用 VoiceMem
自己的 ASR、情绪、环境感知及可选声纹。键盘输入在两种模式下都按文本处理。

## 安装与运行

需要仓库支持的 Node.js 版本，以及 Python 3.10 或更高版本。

```bash
npm ci
```

请先按照 [VoiceMem 官方说明](https://github.com/xzf-thu/VoiceMem)完成安装。
本示例推荐使用独立 Python 环境和经过验证的依赖版本：

```bash
python3.12 -m venv examples/voicemem/.venv
examples/voicemem/.venv/bin/pip install \
  --index-url https://mirrors.aliyun.com/pypi/simple/ \
  -r examples/voicemem/sidecar/requirements.txt
cp examples/voicemem/.env.example \
  examples/voicemem/.env.local
```

在 `.env.local` 中填写 `DASHSCOPE_API_KEY`，然后运行：

```dotenv
QWEN_AUDIO_MEMORY_PROVIDER=voicemem
VOICEMEM_SIDECAR=/absolute/path/to/examples/voicemem/sidecar/server.py
VOICEMEM_INPUT_MODE=text
```

```bash
cd examples/voicemem
node --env-file=.env.local gateway.mjs
```

打开 `http://127.0.0.1:3101`。端口已被占用时可设置 `PORT=3102`。示例启动器优先使用
本目录的 `.venv`，否则使用 `PATH` 中的 `python3`，并自动发现 Sidecar。若要让日常
Gateway 使用 VoiceMem，把二者的绝对路径分别
以 `VOICEMEM_PYTHON` 和 `VOICEMEM_SIDECAR` 写入 `config.env`。

要体验原生音频记忆，在 `.env.local` 设置：

```dotenv
VOICEMEM_INPUT_MODE=audio
VOICE_ENABLE_VOICEPRINT=false
```

首次调用会下载和加载 VoiceMem 的本地音频模型，耗时明显长于后续调用。临时 WAV 在
Sidecar 处理结束后删除；VoiceMem 默认不保留原始音频，但会生成声纹等派生数据，生产
部署应按隐私要求配置 `VOICE_SCENE` 和保留策略。声纹需要 VoiceMem 独立提供的 speaker
model；未安装时保持关闭，不影响 ASR 和记忆抽取。

百炼推荐配置使用 `qwen3.8-flash` 进行记忆抽取与整理，使用维度为 `1024` 的
`text-embedding-v4` 进行语义检索。全部环境变量见示例的
[完整配置说明](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/voicemem)。

## 体验方法

1. 对助手说：“我住在杭州，喜欢打羽毛球，以后叫我船长。”
2. 关闭或刷新 WebUI，让已完成的 Session 触发记忆整理。
3. 新建 Session 后询问：“我住在哪里、喜欢什么，你应该怎么称呼我？”

明确修改会立即进入同步快照。会话观察在后台执行，不阻塞前台语音对话。

## 数据存储

隔离示例将数据保存在 `.qwen-audio/runtime/memory/voicemem/`：

| 路径 | 内容 |
|---|---|
| `profiles/<owner-hash>.json` | 明确偏好和事实的有界同步快照 |
| `memory-spaces/<owner-hash>/` | VoiceMem SQLite 数据、元信息和本地 Qdrant 向量 |
| `observed-messages.json` | 防止重连后重复写入的有界消息指纹 |
| `audio-staging/` | 原生音频模式的临时 WAV，处理后删除 |

生产部署应把该目录放在持久化存储中，并自行制定凭据、保留期限、删除和租户映射策略。

## 替换和扩展

接入其他记忆系统时，实现同一版本的 `MemoryProvider` 并注入
`createGatewayApplication` 即可；Gateway 与 Realtime 工具层不需要供应商专用修改。
完整接口见[长期记忆](../reference/memory.zh.md)。

## 作者与致谢

- [Xie Zhifei](https://github.com/xzf-thu)：创建并开源 VoiceMem。
- [Li Xu](https://github.com/x-lixu)：设计可替换的 `MemoryProvider` 边界，并实现
  内置 Node.js/Python 接入。
