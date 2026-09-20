# 语音前台

语音前台负责实时交流；后台 Agent 负责执行工作。二者可独立选择。

本页配置写入 `qwenaudio config` 显示的 `config.env`。桌面版也可在“语音前台”设置中选择服务并填写凭据。

## 选择服务

| 服务 | Provider 值 | 必填或首次使用配置 | 使用说明 |
| --- | --- | --- | --- |
| Qwen Audio / Omni | `dashscope`（默认） | `DASHSCOPE_API_KEY` | [Audio 语音](../voice-frontends/qwen-audio-realtime.zh.md) / [Omni 视觉](../voice-frontends/qwen-omni-realtime.zh.md) |
| StepAudio 3 | `stepfun` | `STEPFUN_API_KEY` | [StepFun](../voice-frontends/stepfun.zh.md) |
| OpenAI Realtime | `gpt-live` | `OPENAI_API_KEY` | [GPT-Live](../voice-frontends/gpt-live.zh.md) |
| Gemini Live | `google-live` | `GOOGLE_API_KEY` | [Google Live](../voice-frontends/google-live.zh.md) |
| Hugging Face speech-to-speech | `speech-to-speech` | 先启动服务；默认 `ws://127.0.0.1:8765/v1/realtime` | [本地模型链路](../voice-frontends/speech-to-speech.zh.md) |
| MiniCPM-o 4.5 | `minicpm-o` | 先启动服务；默认 `ws://127.0.0.1:8006/v1/realtime?mode=audio` | [音频 / 视频模式及限制](../voice-frontends/minicpm-o.zh.md) |

例如，使用默认前台：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
```

切换到 StepFun 时，改选服务并填写它自己的凭据：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=stepfun
STEPFUN_API_KEY=your-stepfun-key
```

各家的配置可以同时保留，切换只需改 `QWEN_AUDIO_REALTIME_PROVIDER`。Gateway 不会把另一家的 Key、模型或音色拿来使用。

## 模型、音色与地址

| Provider | 模型 | 音色 | 服务地址 |
| --- | --- | --- | --- |
| DashScope | `QWEN_AUDIO_REALTIME_MODEL` | Audio：`QWEN_AUDIO_REALTIME_VOICE`；Omni：`QWEN_OMNI_REALTIME_VOICE` | `QWEN_AUDIO_REALTIME_BASE_URL` |
| StepFun | `STEPFUN_REALTIME_MODEL` | `STEPFUN_REALTIME_VOICE` | `STEPFUN_REALTIME_URL` |
| GPT-Live | `GPT_LIVE_REALTIME_MODEL` | `GPT_LIVE_REALTIME_VOICE` | `GPT_LIVE_REALTIME_URL` |
| Google Live | `GOOGLE_LIVE_REALTIME_MODEL` | `GOOGLE_LIVE_REALTIME_VOICE` | `GOOGLE_LIVE_REALTIME_URL` |
| speech-to-speech | 在上游服务设置 | 在上游服务设置 | `SPEECH_TO_SPEECH_REALTIME_URL` |
| MiniCPM-o | 在上游服务设置 | 在上游服务设置 | `MINICPM_O_REALTIME_URL` |

地址和模型留空使用该 Provider 的默认值。自建服务如需 Bearer 认证，分别设置 `SPEECH_TO_SPEECH_AUTH_TOKEN` 或 `MINICPM_O_AUTH_TOKEN`。可用别名与协议细节见各服务页面。

DashScope 当前内置以下模型档案：

| 模型 ID | 实时输入 |
| --- | --- |
| `qwen-audio-3.0-realtime-plus`（默认） | 文字、语音 |
| `qwen-audio-3.0-realtime-flash` | 文字、语音 |
| `qwen3.5-omni-flash-realtime` | 文字、语音、实时视觉帧 |
| `qwen3.5-omni-plus-realtime` | 文字、语音、实时视觉帧 |

这些档案均支持工具调用。模型能否接收视觉帧，还取决于客户端和传输通道，见[视觉输入](../guides/vision.zh.md)。

## 应用并验证

1. 桌面版修改后点击“应用”。终端 Gateway 退出后重新启动；已安装的后台服务执行 `qwenaudio gateway restart`。
2. 连接客户端，确认“语音前台”已连接。
3. 说一句话，确认能听到回答。需要工具时，再测试搜索或一个简单后台请求。

CLI 可查看当前配置及支持的模型：

```bash
qwenaudio config show
qwenaudio config set --realtime-model qwen-audio-3.0-realtime-flash
```

`config set` 修改当前 Provider 的模型，不切换 Provider，也不自动重启 Gateway。远程客户端沿用远端配置；不能通过本机配置切换远端模型。

## 服务差异

- **MiniCPM-o** 当前适配不支持文字输入、结构化工具调用、主动播报或会话上下文恢复；适合语音 / 视觉聊天，不用于后台编排。
- **speech-to-speech** 的语言识别、音色、工具调用质量取决于你配置的 STT、LLM 与 TTS。
- **Google Live** 当前不向重连后的上游会话恢复历史上下文；界面保留记录不等于模型已收到历史。
- 其他服务的已支持能力和限制，以各自接入页面为准。

前台扩展工具另行配置：[搜索](../guides/web-search.zh.md)、[MCP](../reference/frontend-mcp.zh.md)、[OpenAPI](../reference/frontend-openapi.zh.md)。

## 旧配置排查

新配置只使用上面的供应商字段。`QWEN_AUDIO_REALTIME_API_KEY` 和 `QWEN_AUDIO_REALTIME_ENDPOINT` 不再作为进程环境覆盖项。旧文件读取时会转换；若提示迁移冲突，保留正确的供应商字段并移除旧字段。更多优先级规则见[配置总览](../configuration.zh.md#配置优先级)。
