# GPT-Live 1（OpenAI Live API）

qwen-audio-agent 可以把 OpenAI 的 GPT-Live 1 作为云端语音前台。它是走 Live API 的全双工语音模型，
与 `gpt-live` 使用的 Realtime API 是两套协议：边听边说，把推理和工具调用委托给一个 Responses 模型。
Gateway 仍负责前台工具、记忆、提醒、任务委派和后台 Agent 编排。

## 配置

编辑 `qwenaudio config` 显示的用户配置文件：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=gpt-live-1
GPT_LIVE_1_API_KEY=your-openai-key
```

| 可选配置 | 默认值 | 说明 |
| --- | --- | --- |
| `GPT_LIVE_1_REALTIME_URL` / `OPENAI_LIVE_URL` | `wss://api.openai.com/v1/live/sessions` | Live API WebSocket 端点；经 Azure OpenAI 时填该资源的 `/openai/v1/live/sessions` 地址 |
| `GPT_LIVE_1_REALTIME_MODEL` | `gpt-live-1` | 语音模型；经 Azure OpenAI 时填部署名 |
| `GPT_LIVE_1_REALTIME_VOICE` | 空 | 使用服务默认音色（`marin`），或填写模型支持的音色 |
| `GPT_LIVE_1_DELEGATION_MODEL` | `gpt-6-luna` | 负责推理并调用 Gateway 工具的 Responses 模型；经 Azure OpenAI 时填同一资源上的部署名 |

Live API 不标出轮次和 response 边界，Adapter 按下列时间参数切分语音。默认值是依据真实会话定的暂定值，
可按部署调整。单位为毫秒，取值限制在 100–10,000（等待提问还可设为 0，即关闭）；非数字的值会被忽略。

| 时间参数 | 默认值 | 说明 |
| --- | --- | --- |
| `GPT_LIVE_1_ANSWER_GAP_MS` | `1500` | 转写间隔超过它就分成两段回答 |
| `GPT_LIVE_1_OUTPUT_IDLE_MS` | 同回答间隔 | 安静多久算一段回答说完 |
| `GPT_LIVE_1_INPUT_SEGMENT_GAP_MS` | `1200` | 用户语音间隔超过它，后面的话算新的一句 |
| `GPT_LIVE_1_INPUT_IDLE_MS` | `2000` | 安静多久算用户这句话说完 |
| `GPT_LIVE_1_QUESTION_WAIT_MS` | `1000` | 回答先于提问的字到达时，最多等提问多久 |
| `GPT_LIVE_1_LATE_QUESTION_MS` | `1200` | 这类回答开始后多久内开始的话算它的提问，不算插话 |
| `GPT_LIVE_1_BARGE_IN_YIELD_MS` | `1000` | 插话后模型继续说超过它，后面的话作为新回答播放 |
| `GPT_LIVE_1_TRANSCRIPT_LAG_MS` | `600` | 回答刚结束后多久内迟到的转写仍归这段回答 |
| `GPT_LIVE_1_STOPPED_ANSWER_PAUSE_MS` | `600` | 用户点停后，模型停顿多久算这段回答结束 |

桌面端在 **语音前台 → GPT-Live 1** 下暴露服务地址、API Key、模型、音色四个字段。
终端 Gateway 修改文件后需重启；若是已安装的后台服务，执行 `qwenaudio gateway restart`。

## 集成边界

- Adapter 经 WebSocket 使用 Live API：先发 `session.start`，Bearer 认证，单声道 24 kHz PCM16。
  按 OpenAI Live 提示指南的建议，语音模型拿简短人设和 policy，被委托模型拿前台指令和 Gateway 工具。
  近期文字历史以 `session.input` 注入。不协商实时视觉帧。
- 工具结果用 `response.item.create` 回传，发起调用的 response 在之后的 `response.create` 上续一次。
  执行失败的调用或被拒收的结果，以失败输出作答。
- 简短播报经 `session.commentary.append` 说出；任务结果、权限请求和文字输入送到被委托模型。
- 回答和用户轮次按上面的时间参数分组，用户第一个字转写出来才开新一轮。打断只打断播放，后端工作照常进行。
- 是否回复某一轮由语音模型决定；没有得到回复的轮次在回复超时后释放，不报错。权限请求和后台追问
  只能由 Gateway 询问之后才开始的轮次回答。
- 插话后字幕会继续补到模型停下为止。用户字幕定稿后、或回答已开始播放后才到的字不再显示。
- 主动停止时发 `session.instructions.append` 让模型停止说话；之后模型说的内容不播放，直到用户开口
  或 Gateway 有新内容要说。
- 握手返回 429 或达到并发会话上限按容量繁忙处理；Key 无效或找不到模型时语音连接被阻断。服务端
  因内容关闭会话后，Gateway 重连并把这一轮排除出历史；其他错误只让当前这一轮失败。

## 语言

GPT-Live 1 倾向于说指令所用的语言；OpenAI 的 Live 提示词指南要求用希望助手说的语言来写提示词。
共享的前台提示词、人设和 Gateway 工具描述都是中文，所以助手默认说中文，用户说英文时也是如此。
要面向英文用户，需要把它们全部翻译成英文：

- 前台提示词和人设（`config/frontend-agent/PROMPT.md`、`ASSISTANT.md`）；
- `server/src/frontend/tools/`、`server/src/memory/tools.mjs` 和 `server/src/knowledge/tools.mjs`
  中的工具描述；
- 模型收到的 Gateway 文本，例如任务和播报文本；
- 并把客户端 locale 设为 `en-US`。

以上全部换成英文后，用英文语音提问，语音回答和后端回答都是英文。

## 已知限制

- **插话延迟。**用户第一个字转写出来才能得知插话，比开口晚约 1 秒；在此之前上一段回答会继续播放。
- **闭麦时打字。**Live API 需要持续的输入音频。麦克风开关发送 `session.input_audio.mute` 并停止发送
  输入音频，所以闭麦时打字提问，要在开麦后才得到回答。
- **播报送达。**播报在收到确认或后端 response 完成时算送达；Live API 没有更晚的信号与这段语音对应。
- **空闲会话。**Live API 按秒计费直到会话关闭，后端用量另计。闭麦和休眠不会关闭会话，关闭页面或
  应用才会。空闲会话自动关闭是后续工作。

## 验证边界

本地测试用注入时钟驱动 Adapter；共享行为测试用原生 Live fixture 运行它，合成的用户轮次也经真实的
输入运行时验证。线上模型行为、音色、延迟、配额及地域可用性以 OpenAI 当前 Live API 文档为准。

## 继续阅读

- [GPT-Live / OpenAI Realtime](gpt-live.zh.md)
- [前台配置参考](../configuration/frontend.zh.md)
- [自定义 Provider](custom-provider.zh.md)
