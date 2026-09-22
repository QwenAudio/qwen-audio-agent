# Qwen Omni Realtime

多模态语音前台：DashScope 的 Qwen3.8 与 Qwen3.5 Omni Realtime 模型。与 Audio 系列
相同的全双工对话体验，模型层具备图像理解能力。

## 模型

| 模型 | 说明 |
| --- | --- |
| `qwen3.8-omni-flash-realtime` | 使用业务空间专属服务地址 |
| `qwen3.5-omni-flash-realtime` | 延迟更低 |
| `qwen3.5-omni-plus-realtime` | 质量更高 |

这些模型都支持 Function Calling，网关的前台工具（任务委派、记忆、提醒）
照常工作。

## 配置

两个系列均使用 `dashscope` Provider，在 Gateway 的 `config.env` 中通过
`QWEN_AUDIO_REALTIME_MODEL` 选择模型。

### Qwen3.8 Omni

3.8 必须填写百炼业务空间专属 WebSocket 地址，并使用对应地域、对应空间的 API Key：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen3.8-omni-flash-realtime
QWEN_AUDIO_REALTIME_BASE_URL=wss://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime
```

将 `<WorkspaceId>` 替换为真实业务空间 ID；新加坡地址使用
`<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com`。参见[官方连接说明](https://help.aliyun.com/zh/model-studio/realtime)。
桌面版仍选择 DashScope，在现有“服务地址”“API Key”“模型”中填写即可，无需新增 Provider。
该模型不能使用默认的 DashScope 公共服务地址。
一个 Gateway 同一时刻只生效一个模型；修改配置后应用设置或重启 Gateway。默认模型不变。

### Qwen3.5 Omni

3.5 系列沿用 [Qwen Audio 3.0 Realtime](qwen-audio-realtime.zh.md) 的凭据与服务地址配置。

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen3.5-omni-flash-realtime
```

## 音色与话轮检测

- 项目默认音色：3.8 为 `Tina`，3.5 为 `Ethan`；可用 `QWEN_OMNI_REALTIME_VOICE` 覆盖。
- 3.5 已确认不兼容的 `Cherry` 会在连接前被拒绝，并提示改用项目为该模型配置的默认音色。
  未知和复刻音色仍交给供应商验证，不使用完整白名单或 ID 前缀推断，不自动替换配置。
  参见[官方音色列表](https://help.aliyun.com/zh/model-studio/omni-voice-list)。
- 话轮检测为 `semantic_vad`，由运行时配置。
- 3.8 使用嵌套的 `session.audio` 配置；客户端音频契约不变：单声道 PCM16，输入 16 kHz、输出 24 kHz。
  工具回执续答、后台结果主动播报和打断复用现有 DashScope 链路，不启用上游托管 MCP 或多通道音频。

## 实时视觉

WebUI 可以把摄像头画面采样为有界 JPEG 帧，并通过协商后的 GCP
`input.image_buffer` 能力发送。Gateway 每秒最多接收一帧；Provider Adapter 会在
音频已经建立实时会话时间线之后，通过 Qwen Omni 的
`input_image_buffer.append` 发送，图像与音频缓冲区随正常话轮检测共同提交。

这条链路提供的是实时视觉上下文，不是回合附件：它不会创建用户消息、主动触发回复、
进入历史或成为后台 Agent 附件。普通上传图片仍使用 `conversation.item.create` 和既有
附件/委托链路。本版本的 Desktop 与 TUI 不采集实时视觉帧。

## 两个系列怎么选？

- **Audio**（`qwen-audio-3.0-realtime-*`）——默认选择；语音优先的对话，
  无其他依赖。
- **Omni**——需要前台结合实时画面与语音时选择；3.8 需额外配置业务空间服务地址。

## 继续阅读

- [Qwen Audio 3.0 Realtime](qwen-audio-realtime.zh.md)——默认系列
- [GPT-Live / OpenAI Realtime](gpt-live.zh.md)——OpenAI 云端实时语音前台
- [Google Gemini Live](google-live.zh.md)——Google 云端实时语音前台
- [前台配置参考](../configuration/frontend.zh.md)
