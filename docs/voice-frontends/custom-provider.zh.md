# 扩展 Realtime Provider

Realtime Provider 是运行时与实时模型服务之间的适配器，不是客户端，也不是编排运行时本身。业务宿主可以注入自定义 Provider，而不必修改通用会话与后台工作逻辑。下面通过 Gateway 应用入口进行装配。

```js
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'
import {
  createRealtimeProviderRegistry,
} from 'qwen-audio-agent/realtime-provider'
import { privateRealtimeProvider } from './private-realtime-provider.mjs'

const realtimeProviderRegistry = createRealtimeProviderRegistry({
  providers: [privateRealtimeProvider],
  defaultProvider: privateRealtimeProvider.key,
})

createGatewayApplication({
  realtimeProviderRegistry,
  realtimeProvider: privateRealtimeProvider.key,
})
```

扩展边界如下：

- 每个 Provider 都是独立适配器，完整拥有自己的 URL、认证、模型、Session 和错误分类语义；不要通过改造另一个 Provider 来承载业务差异。
- `url()`、`headers()`、`model()` 可从宿主配置闭包读取服务地址、令牌和模型；Gateway 不要求为业务 Provider 增加环境变量。
- `createProtocol()` 每条 Realtime 连接调用一次，适合生成连接级 ID 和隔离状态。
- 可选的同步 `validateSessionOptions({ sessionOptions })` 在上游连接前执行；只拒绝已确认无效的配置，未知值交给服务端验证。
- `connectionMessages()` 在 WebSocket 打开后、`session.update` 之前发送原始握手帧。
- 其余事件通过 `encodeOutgoing()` 与 `normalizeIncoming()` 转换，Gateway 的工具调用、任务和客户端协议保持不变。
- 不支持临时回复指令的协议可实现 `responseInstructionsItem(response)`，将内部回复指令转为普通对话项。Gateway 等待确认后调用 `responseCreate(response)`，后者负责去掉上游不支持的参数。此时 `perResponseInstructions` 为 `false`，指令会进入会话历史。
- `conversationItemCreate(item, { contextOnly })` 区分上下文投递和用户交互输入。对于消息项，`contextOnly: true` 必须写入上下文且不触发回复，不能只缓存到下一次 `responseCreate`；用户主动发送文本或文件时，Gateway 传入 `false`。工具回执仍遵循供应商原生的续答语义。
- 仅当工具结果会由服务原生续答时声明 `automaticToolResponses: true`（豆包 Seeduplex、Google Live）。运行时发送这类回执不等待当前响应结束；工具批次结束时通过 `ensureResponse(..., { afterToolResults: true })` 避免再次请求回复。`sendFunctionOutput` 返回 `{ delivered: true, automatic: true }` 只表示回执已投递，不表示播报完成。`createResponse: false` 不能禁止服务原生续答，单次回复指令也不能控制它。其他 Provider 保持显式请求回复和完成跟踪。
- 只表示响应仍在进行的事件可转换为带 `response_id` 的 `response.activity`，无需转发原始思考内容。
- 服务端确认对话项时会重分配 ID 的 Provider，应声明 `conversationItemIdEcho: false`；网关按唯一待确认项关联，无需增加延时或跳过确认。
- 仅当服务要求首帧视频之前必须先有音频时，声明 `imageRequiresAudioStart: true`；网关用 20 毫秒 PCM16 静音初始化时间线，视频输入无需开启麦克风。
- 服务接受输入或工具结果但不返回 conversation-item 确认事件时，应声明 `acknowledgesConversationItems: false`；Gateway 写出 frame 后即完成本次发送。
- 注入的历史会被服务解释为实时用户输入而非被动上下文时，应声明 `restoreConversationContext: false`。
- `visibility: 'gateway-only'` 可让 Provider 仅供宿主选择，不出现在桌面设置和公共 Provider 列表中。

Provider 必须实现完整契约——`model()`、`voice()`、`isConfigured()`、`url()`、`headers()`、`classifyError()`、`buildSession()`、`buildSpeakResponse()`、`buildResultInjection()`、`buildPermissionInjection()`——并提供数值字段 `inputSampleRate` 与 `outputSampleRate`；缺少任一成员会在注册时抛错。

Provider 和 Protocol 会在注册与建连时校验；缺少方法或返回无效结构会立即报错。

## 行为验证

在仓库根目录运行 `node --test server/test/realtime-provider-behavior.test.mjs`。同一套测试通过真实会话运行时和本地 WebSocket 服务，覆盖全部内置 Provider 的上下文投递、工具续答、授权、取消、异步播报排队与重连恢复。不支持的能力必须明确返回 unsupported 或报错，不能视作投递成功。

模拟服务按原生协议返回消息，不调用适配器生成模拟回复。新增协议时补充对应 fixture，再运行共享测试。这是可重复的契约验证，不能替代真实服务联调或音频设备测试。

`server/test/native-tool-continuation.test.mjs` 进一步覆盖 MCP 结果归一化、`ToolCallHandler` 和本地原生协议服务的完整链路，包括工具失败、请求异常与混合结果。[豆包 Seeduplex](https://docs.volcengine.com/docs/DoubaoVoice/endtoend-realtime-voice-full-duplex-version?lang=zh) 的工具调用可能先于 `response.done`，服务要收到匹配的工具结果后才结束该轮交互；测试不能为了发送回执而提前模拟终止事件。

[Google Live](https://ai.google.dev/api/live) 使用 `clientContent` 和 `turnComplete: false` 写入上下文，提交 turn 才触发回复。与部分协议的被动历史注入不同，Google 规定 `clientContent` 也会打断当前生成：排队投递会等待空闲，立即投递的授权或上下文则可能打断。工具结果由服务原生续答；`generationComplete` 不代表该轮结束，收到 `turnComplete` 后才释放回复槽位。

## 桌面设置

仓库内置前台的设置统一定义在 `shared/realtime-provider-definitions.mjs`，它不依赖 Node.js，也不包含密钥值或连接实现。新增内置前台时，在这里声明名称、字段、环境变量映射和默认值；有可选模型时，同时维护 `shared/realtime-model-catalog.mjs`。桌面选择器、表单、配置读写和状态名称会消费这些定义，无需新增供应商 HTML 面板。

界面固定显示“服务地址、API Key、模型、音色”四行，分别对应 `endpoint`、`credential`、`model`、`voice` 配置槽位。Provider 只声明可配置槽位的绑定；未绑定的行仍显示，但禁用且不写入配置。Bearer 令牌统一显示在 API Key 行，保留原有配置键。`activeDefault` 用于选中自部署服务时填入建议地址；`modelFamily` 用于保留不同模型系列的独立音色配置。已有配置键及别名不变，未选中前台的草稿不参与当前地址校验。连接远端 Gateway 时，仍由远端管理前台配置。

这份设置定义与运行时适配器分离；宿主注入的自定义 Provider 不会自动注册到桌面设置页。
