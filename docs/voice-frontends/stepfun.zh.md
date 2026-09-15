# StepAudio 3 Realtime

通过 StepFun WebSocket Realtime 提供文本/音频输入输出、自定义 Function Calling
和服务端 VAD。后台 Agent 及工具执行仍由 Gateway 管理。

## 配置

在 `qwenaudio config` 显示的用户配置文件中填写：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=stepfun
STEPFUN_API_KEY=your-stepfun-key
```

| 可选设置 | 默认值 | 说明 |
| --- | --- | --- |
| `STEPFUN_REALTIME_URL` | `wss://api.stepfun.com/v1/realtime` | WebSocket 地址 |
| `STEPFUN_REALTIME_MODEL` | `stepaudio-3-realtime-preview` | 当前支持的模型档案 |
| `STEPFUN_REALTIME_VOICE` | 空 | 服务默认音色，或该模型支持的音色 ID |

使用独立凭据和音色，不继承 DashScope 配置。未知模型 ID 在建连前报错；支持
新模型需要添加能力档案。预览模型的可用性和后续替换以
[官方模型文档](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime)为准。

桌面端在“语音前台”选择 StepFun，填写 Key 后点击应用。终端 Gateway 需重启；
已安装后台服务使用 `qwenaudio gateway restart`。`config show` 和
`config set --realtime-model` 按当前 Provider 显示和修改模型。远程客户端沿用其 Gateway 配置。

## 交互边界

- 只注册 Gateway 的 `type: "function"` 工具，不注册 StepFun 内置
  `type: "web_search"` / `type: "retrieval"`。Gateway 自定义函数即使名为
  `web_search`，仍由 Gateway 执行。
- 输入输出均为单声道 24 kHz PCM16，通过 Gateway 与客户端协商；当前档案不提供图片/视频传输。
- 官方协议未完整约定单次回复指令。播报和回注指令通过普通对话项传入，再发送
  `response.create`；这些项会进入会话历史。依赖临时回复指令的自动纠正机制保持关闭。
- 思考增量只作为响应活跃信号；取消事件在 Provider 内转换为统一结束事件。

## 当前验证边界

已用真实服务验证语音输入/音频输出、自定义函数调用、工具结果回传，以及取消后继续对话。
这不代表预览模型在所有环境下的交互质量已经验收：桌面外放测试仍观察到容易触发打断，
以及模型未调用工具便口头询问授权的情况；后者没有创建后台任务，也不构成真实授权。
本接入没有增加自动授权、强制调用工具或自动续播规则。

排查播报中断时，可按 `responseId` / `turnId` 对照 Gateway 的
`realtime.provider.speech_started`、`realtime.provider.speech_stopped`、
`realtime.response.done` 和 `realtime.playback.started/ended/cancelled` 日志。
这些记录不包含原始音频或 API Key；修改后需重启 Gateway 才会使用新代码。

依据：[Realtime API](https://platform.stepfun.com/docs/zh/api-reference/realtime/chat)、
[开发指南](https://platform.stepfun.com/docs/zh/guides/developer/realtime)。
本地协议测试覆盖建连、工具回注、异步播报与取消；云端音色、模型行为和延迟需使用有效 Key 验证。
