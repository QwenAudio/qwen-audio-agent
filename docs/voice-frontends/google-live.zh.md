# Google Gemini Live

qwen-audio-agent 可以把 Google Gemini Live WebSocket API 作为云端语音前台。
Gateway 仍保持同一套前台工具、记忆、提醒、任务委派和后台 Agent 编排；Provider
Adapter 只把 Gemini Live 的双向流协议转换成项目内统一的 Realtime 运行时。

## 配置

编辑 `qwenaudio config` 显示的用户配置文件：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=google-live
GOOGLE_API_KEY=your-google-api-key
```

| 可选配置 | 默认值 | 说明 |
| --- | --- | --- |
| `GOOGLE_LIVE_REALTIME_URL` / `GEMINI_LIVE_REALTIME_URL` | `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` | WebSocket 端点 |
| `GOOGLE_LIVE_REALTIME_MODEL` / `GEMINI_LIVE_REALTIME_MODEL` | `gemini-3.8-live` | 当前内置模型档案 |
| `GOOGLE_LIVE_REALTIME_VOICE` / `GEMINI_LIVE_REALTIME_VOICE` | 空 | 使用服务默认音色，或填写 Gemini Live 预置音色名 |
| `GEMINI_API_KEY` / `GOOGLE_LIVE_API_KEY` | 空 | `GOOGLE_API_KEY` 的别名 |

桌面端在 **语音前台 -> Google Live** 下暴露同样字段。终端 Gateway 修改文件后需重启；
若是已安装的后台服务，执行 `qwenaudio gateway restart`。

## 集成边界

- Adapter 使用 Gemini Live 原生 WebSocket 端点；若 URL 中没有 `key` 或
  `access_token`，会把 API Key 追加为 `key` query 参数。
- 音频输入使用单声道 16 kHz PCM，音频输出使用 24 kHz PCM。
- Gateway 会把自己的 function declarations 注册给 Gemini Live，工具结果通过
  `toolResponse` 返回。
- Gemini Live 不按 OpenAI 风格确认 conversation item，因此 Gateway 在写入输入或工具结果
  frame 后即视为发送成功。
- 此 Provider 关闭会话历史恢复，因为注入的历史文本会被 Gemini Live 视为实时输入。
- 当前传输可在客户端协商 image-buffer capability 后，把实时 JPEG 帧作为 Gemini Live
  `video` realtime input 发送。

## 验证边界

本地协议测试覆盖 URL 构造、Session 配置、音频和图像帧、工具调用、转写事件、模型能力上报
和 Provider 注册。线上模型行为、可用音色、配额、延迟及地域可用性需要有效 Google AI
账号验证，并以 Google 当前 Gemini Live API 文档为准。

## 继续阅读

- [GPT-Live / OpenAI Realtime](gpt-live.zh.md)
- [前台配置参考](../configuration/frontend.zh.md)
- [自定义 Provider](custom-provider.zh.md)
