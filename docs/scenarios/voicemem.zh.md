# VoiceMem

这是一个可运行的记忆扩展示例，使用 [VoiceMem](https://github.com/xzf-thu/VoiceMem)
替换 qwen-audio-agent 的完整用户记忆系统。语音前台继续使用相同的 `memory` 工具和
上下文语义，VoiceMem 则负责存储、自动学习、整理和语义检索。

`PROMPT.md` 与 `ASSISTANT.md` 仍属于助手定义，不在替换范围内。

## 核心特点

- 同时替换用户偏好和长期事实两种逻辑记忆。
- 通过现有 `memory` 工具保留明确读取、追加、替换和删除能力。
- 在语音 Session 结束后观察对话，并在后台整理转写文本或原生音频。
- 增加语义召回，Gateway 内不引入 VoiceMem 专用逻辑。
- 按 Gateway owner 使用独立哈希空间隔离用户数据。
- 自动停用内置抽取器和偏好学习器，避免一段对话被重复学习。

## 架构

| 组件 | 职责 |
|---|---|
| qwen-audio-agent Gateway | Realtime 对话、记忆工具和 Provider 生命周期 |
| Node.js Adapter | `MemoryProvider` 接口、有界同步快照、用户隔离和进程托管 |
| Python Sidecar | 通过 JSONL 对接 VoiceMem 的公开 Python API |
| VoiceMem | 记忆抽取、整理、结构化存储和语义检索 |
| 模型服务 | VoiceMem 使用的文本模型与 Embedding 模型 |

Gateway 按需启动一个长驻 Python Sidecar，并通过标准输入输出传输逐行 JSON。这样
Python 依赖不会进入 Node.js 运行时，也不会污染框架公开的扩展接口。

输入由 `VOICEMEM_INPUT_MODE` 切换：`text`（默认）复用 Realtime 转写；`audio`
按有效用户轮次截取 PCM16 音频并调用 VoiceMem 的 `ingest(audio=...)`，使用 VoiceMem
自己的 ASR、情绪、环境感知及可选声纹。键盘输入在两种模式下都按文本处理。

## 运行示例

需要仓库支持的 Node.js 版本，以及 Python 3.10 或更高版本。

```bash
npm ci
python3.12 -m venv examples/voicemem/.venv
examples/voicemem/.venv/bin/pip install \
  --index-url https://mirrors.aliyun.com/pypi/simple/ \
  -r examples/voicemem/sidecar/requirements.txt
cp examples/voicemem/.env.example \
  examples/voicemem/.env.local
```

在 `.env.local` 中填写 `DASHSCOPE_API_KEY`，然后运行：

```bash
cd examples/voicemem
node --env-file=.env.local gateway.mjs
```

打开 `http://127.0.0.1:3101`。端口已被占用时可设置 `PORT=3102`。Adapter 会自动发现
示例目录中的 `.venv`。

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

示例将数据保存在工作目录的 `.qwen-audio/voicemem/`：

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
  Node.js/Python 接入示例。
