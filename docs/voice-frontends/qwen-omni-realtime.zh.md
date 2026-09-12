# Qwen Omni Realtime

多模态语音前台：DashScope 的 Qwen3.5 Omni Realtime 系列。与 Audio 系列
相同的全双工对话体验，模型层具备图像理解能力。

## 模型

| 模型 | 说明 |
| --- | --- |
| `qwen3.5-omni-flash-realtime` | 延迟更低 |
| `qwen3.5-omni-plus-realtime` | 质量更高 |

两个模型都支持 Function Calling，网关的前台工具（任务委派、记忆、提醒）
照常工作。

## 配置

```dotenv
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen3.5-omni-flash-realtime
```

凭据与端点配置与 [Qwen Audio 3.0 Realtime](qwen-audio-realtime.zh.md)
完全一致——无论哪个系列，一个 Gateway 同一时刻只生效一个模型；在桌面版
设置页或 `qwenaudio config set --realtime-model <id>` 切换后重启 Gateway。

## 音色与话轮检测

- 默认音色 `Ethan`，可用 `QWEN_OMNI_REALTIME_VOICE` 覆盖。
- 当前支持 `Tina`、`Cindy`、`Liora Mira`、`Sunnybobi`、`Raymond`、`Ethan`、
  `Theo Calm` 和 `Serena`。音色必须与所选模型匹配；不兼容的显式配置会在连接
  上游 Session 前直接报错，不会静默替换。
- 话轮检测为 `semantic_vad`，由运行时配置。

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
- **Omni**（`qwen3.5-omni-*-realtime`）——需要前台结合实时画面与语音时选择。

## 继续阅读

- [Qwen Audio 3.0 Realtime](qwen-audio-realtime.zh.md)——默认系列
- [前台配置参考](../configuration/frontend.zh.md)
