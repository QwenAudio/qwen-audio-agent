# Qwen Audio Realtime

DashScope 的 Qwen Audio 3.0 和 3.1 Realtime 模型，专为语音直通语音的对话而生。
装好 qwen-audio-agent、只填一个 API Key 时，默认仍使用 Qwen Audio 3.0 Realtime Plus。

## 模型

| 模型 | 说明 |
| --- | --- |
| `qwen-audio-3.0-realtime-plus` | **默认。** 质量更高 |
| `qwen-audio-3.0-realtime-flash` | 延迟更低、成本更低 |
| `qwen-audio-3.1-realtime-plus` | 可选的 3.1 Plus 模型 |

这些模型都接受文本和音频输入、产出文本和音频，并支持 Function Calling
（网关的前台工具——任务委派、记忆、提醒——正是通过它到达模型）。

## 配置

```dotenv
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
```


一个 Gateway 同一时刻只生效一个模型。在桌面版设置页或 CLI 切换后，
重启 Gateway 生效：

```bash
qwenaudio config set --realtime-model qwen-audio-3.1-realtime-plus
# 以下仅用于已安装的用户后台服务：
qwenaudio gateway restart
```

3.1 Plus 复用 `dashscope` Provider 和现有 WebSocket 事件协议。如果已显式配置音色，
请改用与模型匹配的音色，或清除覆盖值以使用模型默认音色。详见[官方迁移说明](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides)。

WebUI 和 TUI 只展示当前生效模型，不单独覆盖。

## 音色与话轮检测

- 3.0 Plus / Flash 默认音色为 `longanqian`，3.1 Plus 为 `longanqian_v3.1`。
  可用 `QWEN_AUDIO_REALTIME_VOICE` 覆盖，但须选择当前模型支持的音色。
- GCP 客户端可在首次 `session.hello` 的 `connection.output_voice` 中提供会话级音色；
  它优先于环境变量。运行时调用 `GatewayClient.updateOutputVoice(voice)`，Gateway 会
  重建上游 Realtime Session，客户端连接和 Gateway 会话保持不变。
- 话轮检测为 `smart_turn`（语义判停），由运行时配置，不暴露手动 VAD 调参。

## 端点覆盖

用于私有化部署或代理：

| 配置项 | 作用 |
| --- | --- |
| `QWEN_AUDIO_REALTIME_BASE_URL` / `QWEN_AUDIO_REALTIME_URL` | 替换 DashScope Realtime 端点 |
| `DASHSCOPE_WORKSPACE_ID` | 切换到百炼专属工作区端点（`wss://<workspace-id>.cn-beijing.maas.aliyuncs.com/...`） |

如通过专属工作区接入，继续使用现有工作区配置或基础地址覆盖，填写对应地域、工作区提供的端点。

传输层在单条 WebSocket 上跑 16 kHz PCM 输入、24 kHz PCM 输出。

## 能力边界

| | 模型层 | 当前客户端传输层 |
| --- | --- | --- |
| 输入 | 文本、音频 | 文本、音频 |
| 输出 | 文本、音频 | 文本、音频 |

模型能力与已实现的传输通道是被刻意分开跟踪的；这个系列没有图像模态，
因此没有落差。需要模型层图像输入时，见 [Qwen Omni Realtime](qwen-omni-realtime.zh.md)。

## 继续阅读

- [GPT-Live / OpenAI Realtime](gpt-live.zh.md)——OpenAI 云端实时语音前台
- [Google Gemini Live](google-live.zh.md)——Google 云端实时语音前台
- [Speech-to-Speech](speech-to-speech.zh.md)——全本地前台，无需云端 Key
- [MiniCPM-o 4.5](minicpm-o.zh.md)——本地端到端实时语音前台
- [自定义 Provider](custom-provider.zh.md)——接入其他实时语音服务
- [前台配置参考](../configuration/frontend.zh.md)
