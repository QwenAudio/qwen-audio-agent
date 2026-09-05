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
- 话轮检测为 `semantic_vad`，由运行时配置。

## 能力边界

这个系列正是"模型能力 ≠ 传输通道"差别体现的地方：

| | 模型层 | 当前客户端传输层 |
| --- | --- | --- |
| 输入 | 文本、音频、**图像** | 文本、音频、JPEG 观察 |
| 输出 | 文本、音频 | 文本、音频 |

模型本身接受图像输入，WebUI 还支持用户显式开启摄像头连续观察：每秒最多
发送一帧有界 JPEG，内存中最多保留最近 8 帧，观察本身不会创建模型回复。
原生视频以及旧版 Audio 系列的画面观察仍不可用。上表与网关通过健康检查
接口下发给客户端的能力完全一致，UI 呈现的是同一个边界。

## 两个系列怎么选？

- **Audio**（`qwen-audio-3.0-realtime-*`）——默认选择；语音优先的对话，
  无其他依赖。
- **Omni**（`qwen3.5-omni-*-realtime`）——需要图像能力和 WebUI 摄像头显式
  观察时选择它。

## 继续阅读

- [Qwen Audio 3.0 Realtime](qwen-audio-realtime.zh.md)——默认系列
- [前台配置参考](../configuration/frontend.zh.md)
