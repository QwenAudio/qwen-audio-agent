# GPT-Live / OpenAI Realtime

qwen-audio-agent 可以把 OpenAI GPT-Live / Realtime WebSocket API 作为云端语音前台。
Gateway 仍负责前台工具、记忆、提醒、任务委派和后台 Agent 编排；Provider Adapter
只把 OpenAI GA Realtime 协议转换成项目内统一的运行时事件。

## 配置

编辑 `qwenaudio config` 显示的用户配置文件：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=gpt-live
OPENAI_API_KEY=your-openai-key
```

| 可选配置 | 默认值 | 说明 |
| --- | --- | --- |
| `GPT_LIVE_REALTIME_URL` / `OPENAI_REALTIME_URL` | `wss://api.openai.com/v1/realtime` | WebSocket 端点 |
| `GPT_LIVE_REALTIME_MODEL` / `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` | 当前内置模型档案 |
| `GPT_LIVE_REALTIME_VOICE` / `OPENAI_REALTIME_VOICE` | 空 | 使用服务默认音色，或填写模型支持的音色 ID |
| `GPT_LIVE_API_KEY` | 空 | 当实时语音前台需要独立凭据时，作为 `OPENAI_API_KEY` 的别名 |

桌面端在 **语音前台 -> GPT-Live** 下暴露同样字段。终端 Gateway 修改文件后需重启；
若是已安装的后台服务，执行 `qwenaudio gateway restart`。

## 集成边界

- Adapter 使用 OpenAI GA Realtime WebSocket 协议；模型通过 URL 的 `model`
  query 参数传入，认证使用 `Authorization: Bearer ...`。
- 输入和输出都使用单声道 24 kHz PCM。客户端音频进入 Provider 之前会由 Gateway
  Client 重采样。
- Gateway 会把自己的 function tools 注册给模型；本 Adapter 不启用 OpenAI 内置工具。
- 已启用响应元数据关联，Gateway 主动创建的回复可以和服务端自动回复区分开。
- 当前内置模型档案支持文本/音频输入和文本/音频输出；此 Provider 不协商实时视觉帧。

## 验证边界

本地协议测试覆盖 URL 构造、Session 配置、模型能力上报和 Provider 注册。线上模型行为、
音色、延迟、配额及地域可用性需要有效 OpenAI 账号验证，并以 OpenAI 当前 Realtime API
文档为准。

## 继续阅读

- [Google Gemini Live](google-live.zh.md)
- [前台配置参考](../configuration/frontend.zh.md)
- [自定义 Provider](custom-provider.zh.md)
