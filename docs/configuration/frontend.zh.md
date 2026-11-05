# 语音前台

语音前台负责实时交流；后台 Agent 负责执行工作。二者可独立选择。

供应商选择、凭据、服务地址和当前模型仍写入 `qwenaudio config` 显示的 `config.env`。桌面版“语音前台”设置修改这些连接信息，并从框架支持的模型中下拉选择。模型定义和适配参数由代码维护。

## 选择服务

| 服务 | Provider 值 | 必填或首次使用配置 | 使用说明 |
| --- | --- | --- | --- |
| Qwen Audio / Omni 3.5 / Omni 3.8 | `dashscope`（默认） | DashScope API Key；Omni 3.8 还需业务空间专属地址 | [Audio 语音](../voice-frontends/qwen-audio-realtime.zh.md) / [Omni 视觉](../voice-frontends/qwen-omni-realtime.zh.md) |
| StepAudio 3 | `stepfun` | StepFun API Key | [StepFun](../voice-frontends/stepfun.zh.md) |
| OpenAI Realtime | `gpt-live` | OpenAI API Key | [GPT-Live](../voice-frontends/gpt-live.zh.md) |
| Gemini Live | `google-live` | Google API Key | [Google Live](../voice-frontends/google-live.zh.md) |
| 豆包 Seeduplex | `doubao-seeduplex` | 豆包 API Key | 模型、音色与服务地址配置见下表 |
| Hugging Face speech-to-speech | `speech-to-speech` | 先启动服务；默认 `ws://127.0.0.1:8765/v1/realtime` | [本地模型链路](../voice-frontends/speech-to-speech.zh.md) |
| MiniCPM-o 4.5 | `minicpm-o` | 先启动服务；默认 `ws://127.0.0.1:8006/v1/realtime?mode=audio` | [音频 / 视频模式及限制](../voice-frontends/minicpm-o.zh.md) |

例如，使用默认前台：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
QWEN_AUDIO_REALTIME_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.1-realtime-plus
QWEN_AUDIO_REALTIME_URL=
QWEN_AUDIO_REALTIME_VOICE=
```

切换到 StepFun 时，改选服务并填写它自己的凭据：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=stepfun
QWEN_AUDIO_REALTIME_API_KEY=your-stepfun-key
QWEN_AUDIO_REALTIME_MODEL=stepaudio-3-realtime-preview
QWEN_AUDIO_REALTIME_URL=
QWEN_AUDIO_REALTIME_VOICE=
```

所有前台使用相同的五个字段，只描述当前连接，不分别保存每家供应商的配置。切换供应商时，同时替换 Key 和模型，清空或替换地址、音色。前台凭据与后台、搜索、记忆服务的凭据独立。

## 连接配置

| 字段 | 含义 |
| --- | --- |
| `QWEN_AUDIO_REALTIME_PROVIDER` | 供应商，默认 `dashscope` |
| `QWEN_AUDIO_REALTIME_MODEL` | 模型 ID；留空使用供应商默认模型 |
| `QWEN_AUDIO_REALTIME_API_KEY` | 当前服务的凭据 |
| `QWEN_AUDIO_REALTIME_URL` | WebSocket 服务地址；留空使用供应商默认值 |
| `QWEN_AUDIO_REALTIME_VOICE` | 指定音色；留空使用模型或服务默认值 |

各供应商的默认值：

| Provider | 默认模型 | 默认地址 |
| --- | --- | --- |
| `dashscope` | `qwen-audio-3.1-realtime-plus` | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` |
| `stepfun` | `stepaudio-3-realtime-preview` | `wss://api.stepfun.com/v1/realtime` |
| `gpt-live` | `gpt-realtime-2.1` | `wss://api.openai.com/v1/realtime` |
| `google-live` | `gemini-3.8-live` | `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` |
| `doubao-seeduplex` | `1.2.6.1` | `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue` |
| `speech-to-speech` | 上游配置 | `ws://127.0.0.1:8765/v1/realtime` |
| `minicpm-o` | 上游配置 | `ws://127.0.0.1:8006/v1/realtime?mode=audio` |

speech-to-speech 与 MiniCPM-o 的模型、音色由上游服务管理，应留空；服务启用 Bearer 认证时才需填写 API Key。Qwen3.8 Omni 必须填写[业务空间专属地址](../voice-frontends/qwen-omni-realtime.zh.md#配置)，不能使用 DashScope 公共默认地址。统一配置不改变各服务的协议和能力限制，这些差异仍由 Provider adapter 处理。

DashScope 当前内置以下模型档案：

| 模型 ID | 实时输入 |
| --- | --- |
| `qwen-audio-3.1-realtime-plus`（默认） | 文字、语音 |
| `qwen-audio-3.1-realtime-flash` | 文字、语音 |
| `qwen-audio-3.0-realtime-plus` | 文字、语音 |
| `qwen-audio-3.0-realtime-flash` | 文字、语音 |
| `qwen3.5-omni-flash-realtime` | 文字、语音、实时视觉帧 |
| `qwen3.5-omni-plus-realtime` | 文字、语音、实时视觉帧 |
| `qwen3.8-omni-flash-realtime` | 文字、语音、实时视觉帧 |

这些档案均支持工具调用。模型能否接收视觉帧，还取决于客户端和传输通道，见[视觉输入](../guides/vision.zh.md)。

Audio 3.1 Plus / Flash 复用现有 `dashscope` Provider，默认音色为 `longanqian_v3.1`；
Audio 3.0 Plus / Flash 保持 `longanqian`。显式配置 `QWEN_AUDIO_REALTIME_VOICE`
时，须选择与模型匹配的音色。Audio 模型不支持视觉输入。模型切换和工作区端点覆盖见
[Audio 使用说明](../voice-frontends/qwen-audio-realtime.zh.md)。

## 选择受支持模型

模型列表由框架维护，桌面版和 `qwenaudio config show` 使用同一份列表。在桌面版为当前供应商选择模型，或设置 `QWEN_AUDIO_REALTIME_MODEL`；留空使用供应商默认模型。例如，当前供应商为 `dashscope` 时，填写 `qwen-audio-3.1-realtime-flash` 即可切换到内置的 3.1 Flash，默认模型仍为 3.1 Plus。

未支持的模型 ID 会报配置错误。用户配置不能新增模型、重定义已有模型，也不能修改其 API 绑定、能力、话轮检测或接入约束；这些参数由框架的模型适配固定。现有 `QWEN_AUDIO_REALTIME_VOICE` 和会话级音色覆盖仍然有效，但须选择与当前模型兼容的音色。

列表表示代码已实现的支持，不代表线上服务可用性或账号授权。请确认所选模型的账号、地域、服务地址和音色，再按下文应用并验证连接。speech-to-speech 与 MiniCPM-o 的模型继续在外部服务中配置。

## 应用并验证

1. 桌面版修改后点击“应用”。终端 Gateway 退出后重新启动；已安装的后台服务执行 `qwenaudio gateway restart`。
2. 连接客户端，确认“语音前台”已连接。
3. 说一句话，确认能听到回答。需要工具时，再测试搜索或一个简单后台请求。

CLI 可查看当前配置及受支持模型列表：

```bash
qwenaudio config show
qwenaudio config set --realtime-model qwen-audio-3.1-realtime-flash
```

`config set` 修改当前 Provider 的模型，不切换 Provider，也不自动重启 Gateway。远程客户端沿用远端配置；不能通过本机配置切换远端模型。

## 服务差异

- **MiniCPM-o** 当前适配不支持文字输入、结构化工具调用、主动播报或会话上下文恢复；适合语音 / 视觉聊天，不用于后台编排。
- **speech-to-speech** 的语言识别、音色、工具调用质量取决于你配置的 STT、LLM 与 TTS。
- **Google Live** 当前不向重连后的上游会话恢复历史上下文；界面保留记录不等于模型已收到历史。
- 其他服务的已支持能力和限制，以各自接入页面为准。

前台扩展工具另行配置：[搜索](../guides/web-search.zh.md)、[MCP](../reference/frontend-mcp.zh.md)、[OpenAPI](../reference/frontend-openapi.zh.md)。

## 旧配置排查

供应商专属的旧前台变量仅兼容读取，上述五个统一字段优先，包括显式留空。旧文件若同时含有统一的模型/音色字段和其他供应商的模型/音色字段，需将当前所选供应商需要的值写入统一字段。Omni 原有的 `QWEN_OMNI_REALTIME_VOICE` 应移至 `QWEN_AUDIO_REALTIME_VOICE`。

现在只保存当前连接，不再分别持久化各供应商草稿。旧变量不会自动删除，因为后台 Agent、搜索或其他模块可能仍在使用；迁移后可自行清理仅用于前台的废弃覆盖项。更多优先级规则见[配置总览](../configuration.zh.md#配置优先级)。
