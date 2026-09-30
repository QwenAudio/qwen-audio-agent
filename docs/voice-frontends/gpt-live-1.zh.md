# GPT-Live 1（OpenAI Live API）

qwen-audio-agent 可以把 OpenAI 的 GPT-Live 1 作为云端语音前台。GPT-Live 1 是全双工模型，
走 Live API，与 `gpt-live` 前台使用的 Realtime API 是两套不同的线协议：语音模型边听边说，
把推理和工具调用委托给后端。Gateway 仍负责前台工具、记忆、提醒、任务委派和后台 Agent
编排；Provider Adapter 只把 Live API 的事件流映射到项目内统一的运行时。

## 配置

编辑 `qwenaudio config` 显示的用户配置文件：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=gpt-live-1
OPENAI_API_KEY=your-openai-key
```

| 可选配置 | 默认值 | 说明 |
| --- | --- | --- |
| `GPT_LIVE_1_REALTIME_URL` / `OPENAI_LIVE_URL` | `wss://api.openai.com/v1/live/sessions` | Live API WebSocket 端点 |
| `GPT_LIVE_1_REALTIME_MODEL` | `gpt-live-1` | 语音模型；经 Azure 时填部署名 |
| `GPT_LIVE_1_REALTIME_VOICE` | 空 | 使用服务默认音色（`marin`），或填写模型支持的音色 |
| `GPT_LIVE_1_API_KEY` | 空 | 当 Live 前台需要独立凭据时，优先于 `OPENAI_API_KEY`；桌面端写的是这个变量，且只要它存在（即使为空）就不再回退到 `OPENAI_API_KEY` |
| `GPT_LIVE_1_DELEGATION_MODEL` | `gpt-6-luna` | 负责推理并调用 Gateway 工具的 Responses 模型；Live 委托指南的推荐起点（经 Azure 时填部署名） |
| `GPT_LIVE_1_DELEGATION_INSTRUCTIONS` | 内置 | 替换后端提示词的框架部分；Gateway 的任务指令和注入消息处理规则始终追加在后面 |
| `GPT_LIVE_1_VOICE_INSTRUCTIONS` | 内置 | 替换语音层提示词（人设与交接规则） |
| `GPT_LIVE_1_OUTPUT_IDLE_MS` | `800` | 输出静默多久后视为一段语音结束 |
| `GPT_LIVE_1_TRACE_EVENTS` | 空 | 设为 `1` 时把双向的每个 Live API 事件以结构、id、错误码和大小的形式打到 stderr；对话内容（提示词、转写、工具输出、音频）只记长度，服务端错误消息保留并截到 200 字符（接入排障用） |
| `GPT_LIVE_1_TOOL_OUTPUT_MAX_BYTES` | 空 | 单条后端输入项（工具结果、文字输入）的硬上限。默认一条最多用掉会话剩余后端输入额度的一半，剩余够时不低于 2 KiB；另保留 1 KiB 以便仍能回答待处理的工具调用 |

桌面端在 **语音前台 → GPT-Live 1** 下暴露服务地址、API Key、模型、音色四个字段。
终端 Gateway 修改文件后需重启；若是已安装的后台服务，执行 `qwenaudio gateway restart`。

### 经网关或 Azure 接入

端点和凭据是配置，不是代码。要经 Azure OpenAI 或其前面的 API 网关使用 GPT-Live 1，
把 `GPT_LIVE_1_REALTIME_URL` 指向该服务的 `/openai/v1/live/sessions` 路径，
`GPT_LIVE_1_API_KEY` 填它发放的 key，`GPT_LIVE_1_REALTIME_MODEL` 填部署名。
Azure 对被委托的 Responses 模型同样按部署名解析，所以 `GPT_LIVE_1_DELEGATION_MODEL`
要填同一资源上某个文字模型的部署名。两种情况下 Adapter 发出的 `session.start` 和
`Authorization: Bearer` 头完全一样。

## 集成边界

- Adapter 通过 WebSocket 连接并发送 `session.start`；模型写在会话配置里，不作为 URL 参数。
  认证使用 `Authorization: Bearer ...`。
- 输入和输出都是单声道 24 kHz PCM16 原始音频，分别放在 `session.input_audio.append`
  和 `session.output_audio.delta` 里。客户端音频进入 Provider 之前会由 Gateway Client 重采样。
- 工具调用走 Responses 委托。Gateway 把自己的 function tools 注册到
  `delegation.responses.tools`；被委托模型的函数调用装在 `response.event` 信封里到达，
  Gateway 执行后用 `response.item.create` 回传结果，再发 `response.create` 继续。
- 提示词按官方提示指南拆分：语音层拿人设加 Backchannel / Interruption / Delegation 三段 policy
  （含后端能力清单）；被委托模型在文档给的后端提示骨架里拿完整前台指令。
- 近期对话历史在启动时通过 `session.input` 注入：取最近的文字消息，总量控制在文档上限
  8,192 token 之下留有余量；若服务端在启动时拒收这段历史，下一次连接会省略它。之后工具或
  后端提示词变化只发带 `delegation` 块的 `session.update`，且仅在有变化时发；启动期字段不会重发。
- 任务结果、权限请求和文字输入以 `response.item.create` 项送到被委托模型，随后发
  `response.create`，由它消化后经语音层作答。Gateway 对这类注入项的固定处理规则写在后端
  提示词里，因此每次注入只占一条 item。Gateway 的简短播报直接用 `session.commentary.append`
  说出，该事件最多接受 500 token；播报请求在收到 `session.commentary.appended` 确认时即算完成，
  这是协议上唯一的完成信号。用户口头回答权限后，若短暂宽限期内没有后端 response 接手（例如语音层
  自行应声、未移交后端），Gateway 会像对其他 Provider 一样自己补发 `response.create` 请求后端作答：
  权限只能由后端裁决。这个回答不会被用户随后的一句话作废：后端的工具调用比说话晚几秒。Live API
  不支持按响应禁用工具，Gateway 注入的任务结果由委托模型带着工具处理；权限工具由「本轮必须有用户
  发言」这一道门把守。
- Live API 没有「本轮说完」或 response 结束事件，输出音频流也不间断：回答之间发的是数字静音帧。
  Adapter 在第一个带语音能量的帧上打开语音段，段内停顿照常透传，连续
  `GPT_LIVE_1_OUTPUT_IDLE_MS` 没有语音帧和转写片段（或输出时间轴跳跃）时收掉该段，收段前先补发
  转写完成事件，运行时据此像 GA Provider 一样把助手这轮记入对话历史。
  打断由模型自己处理，没有 `response.cancel`；Gateway 侧的取消只把正在播放的段标为被打断：
  运行时已经静音了它，模型下一次停顿时这段以 cancelled 收掉。转写比音频晚几百毫秒，被打断的字幕
  会继续补到模型停下的位置再收尾（`transcriptTrailsAudio`）：切断前已播放的字不丢，模型让步前多说的几个字也会显示；
  新一段开头不会带上上一段的句末标点。
- 用户轮次由带时间戳的转写片段按 GA 顺序合成。只有「起点晚于当前或上一次回答的开口时刻、
  且比上一片段终点晚 1.2 s 以上」的语音才开新一轮（`speech_started`）；若回答仍在播放，这就是
  打断：运行时清掉播放，模型停下前多说的几个字仍归这条被打断的回答，模型停下后它以 cancelled
  收掉；若打断后模型继续说了 1 s 以上，说明用户只是插了句话，回答按 completed 正常收掉。
  其他片段不论多晚到达都属于
  提问本身：仍开着就续写，已经 completed 的就静默重开、只让字幕变长而不开新轮（运行时对每个 `speech_started` 都会清空播放）。
  助手一开口或输入静默 1.5 s 即提交本轮（`speech_stopped`、`committed`），转写在静默后
  completed。转写把句末标点放在停顿后的第一个片段里发：上一句还开着就补到它尾上，已经 completed
  的就不再显示在下一条字幕开头；`[clear throat]` 这类方括号标注不算说话，不开轮次。回答开口时刻优先取输出音频的时间戳，传输层不带时取输出转写
  的时间戳；两者都没有时按到达顺序判断。`session.delegation.created` 也会提交本轮（服务端已接手），
  这样后端 response 及其工具调用都归属这一轮；转写仍在静默后 completed。
- 用户说话不会顶掉后端工作：Gateway 侧的取消只收掉语音播放记录，被委托的后端 response 及等待它的
  Gateway 请求照旧运行；后端的函数调用在用户开了新一轮之后也照样回传结果，因为有未回传的调用时
  服务端会拒绝 `response.create`。
- 除上述启动历史外不注入连接前的上下文；本 Provider 不协商实时视觉帧。

## 验证边界

本地协议测试覆盖会话配置、客户端事件编码、语音输出分段、合成的用户轮次、委托的函数调用
闭环、后端输入额度及其修复路径、全双工轮次规则（晚到片段、打断、取消与函数调用存活）、播报
确认、静默收尾，以及一次 mock 服务连接。线上模型行为、音色、延迟、配额及地域可用性需要
有效账号验证，并以 OpenAI 当前 Live API 文档为准。

## 继续阅读

- [GPT-Live / OpenAI Realtime](gpt-live.zh.md)
- [前台配置参考](../configuration/frontend.zh.md)
- [自定义 Provider](custom-provider.zh.md)
