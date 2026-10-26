# GPT-Live 1（OpenAI Live API）

qwen-audio-agent 可以把 OpenAI 的 GPT-Live 1 作为云端语音前台。它是走 Live API 的全双工语音模型，
与 `gpt-live` 使用的 Realtime API 是两套协议：边听边说，把推理和工具调用委托给一个 Responses 模型。
Gateway 仍负责前台工具、记忆、提醒、任务委派和后台 Agent 编排。

## 配置

编辑 `qwenaudio config` 显示的用户配置文件：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=gpt-live-1
QWEN_AUDIO_REALTIME_API_KEY=your-openai-key
QWEN_AUDIO_REALTIME_MODEL=gpt-live-1
QWEN_AUDIO_REALTIME_URL=
QWEN_AUDIO_REALTIME_VOICE=
```

| 可选配置 | 默认值 | 说明 |
| --- | --- | --- |
| `QWEN_AUDIO_REALTIME_URL` | `wss://api.openai.com/v1/live/sessions` | Live API WebSocket 端点 |
| `QWEN_AUDIO_REALTIME_MODEL` | `gpt-live-1` | 语音模型；其他模型 ID 需先以 `"api": "gpt-live-1"` [登记](../configuration/frontend.zh.md#登记额外模型) |
| `QWEN_AUDIO_REALTIME_VOICE` | 空 | 使用服务默认音色（`marin`），或填写模型支持的音色 |
| `GPT_LIVE_1_DELEGATION_MODEL` | `gpt-6-luna` | 负责推理并调用 Gateway 工具的 Responses 模型 |

Live API 不标出轮次和 response 边界，Adapter 按下列时间参数划分。默认值是依据真实会话定的暂定值，
可按部署调整。单位为毫秒，取值限制在 100–10,000；非数字的值会被忽略。

| 时间参数 | 默认值 | 说明 |
| --- | --- | --- |
| `GPT_LIVE_1_OUTPUT_IDLE_MS` | `1500` | 模型的语音和文字安静多久算一段回答说完 |
| `GPT_LIVE_1_WORD_GAP_MS` | `600` | 打断后，模型的字之间隔多久算开始下一段回答 |
| `GPT_LIVE_1_INPUT_SEGMENT_GAP_MS` | `1200` | 用户语音间隔超过它，后面的话算新的一句 |
| `GPT_LIVE_1_INPUT_IDLE_MS` | `2000` | 安静多久算用户这句话说完 |

桌面端在 **语音前台 → GPT-Live 1** 下暴露服务地址、API Key、模型、音色四个字段。
终端 Gateway 修改文件后需重启；若是已安装的后台服务，执行 `qwenaudio gateway restart`。

## 集成边界

- Adapter 经 WebSocket 使用 Live API：先发 `session.start`，Bearer 认证，单声道 24 kHz PCM16。
  按 OpenAI Live 提示指南的建议，语音模型拿简短人设和 policy，被委托模型拿前台指令和 Gateway 工具。
  近期文字历史以 `session.input` 注入。不协商实时视觉帧。
- 工具结果用 `response.item.create` 回传，发起调用的 response 在之后的 `response.create` 上续一次。
  执行失败的调用或被拒收的结果，以失败输出作答。
- 简短播报经 `session.commentary.append` 说出；任务结果、权限请求和文字输入送到被委托模型。
- 回答和用户轮次按上面的时间参数分组，用户第一个字转写出来才开新一轮。
- 语音边说边发，客户端先缓冲再播放，连本机 Gateway（例如桌面版）时也一样。
- 打断不切断播放：OpenAI 的服务端控制指南把是否拦截模型音频交给应用决定，本 Adapter 不拦截。插话、打字或点停止后，
  模型已经生成的语音继续播完，模型随即停下，后端工作照常进行。
  模型说话时打字、或点停止，模型听不到，因此还会发 `session.instructions.append` 让它停止说话。
- 是否回复某一轮由语音模型决定；没有得到回复的轮次在回复超时后释放，不报错。权限请求和后台追问
  只能由 Gateway 询问之后才开始的轮次回答。
- 被打断的回答，字幕随它播完继续补全。用户字幕定稿后才到的字不再显示。提问的字晚于它的回答开始才到时，
  这一轮从那里开始，回答的其余部分作为它的回复。
- 点停止后，回答播放到模型安静为止。之后模型说的内容不播放，直到用户开口或打字，或 Gateway 有新内容要说；
  这时模型若还在说，就从当前位置接着播，按被打断的回答处理。
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
- **停止依赖模型配合。**点停止会让模型停止说话；被停的回答播放到模型安静为止，所以模型如果继续说下去，
  在它停顿之前都会听到。
- **打断后播完。**模型停下前已经生成的语音（一两秒）仍会播出：插话时与用户的话重叠，打字或点停止时
  在其后播出。用户只插一句很短的话时，说完后可能还会听到一点。
- **语音触发的桌面操作。**语音模型手里没有工具，由它决定是否交给后台。用语音要求桌面操作（例如休眠），它可能只口头答应而不执行，
  在它说话时尤其如此。直接说出要做什么（如"把悬浮球关掉""隐藏一下"）比"你可以退下了"更容易生效，但不保证每次都行；
  用文字输入则会调用对应工具。
- **后台一次只答一件。**后台回答进行中时，打字输入和播报要等它完成才发出；Live API 也逐个执行委派，
  所以在一段很长的后台回答期间提的问题，即使先点了停止，也要等它结束才得到回答。
- **开麦前打字。**Live API 需要持续的输入音频。麦克风还没发出过任何音频时（例如一打开就闭麦）打字提问，闭麦期间不会说出回答，
  开麦后一般几秒内说出来；只要之前有过麦克风音频，闭麦时打字会立即回答。
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
