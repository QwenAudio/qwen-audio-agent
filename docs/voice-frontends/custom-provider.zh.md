# 扩展 Realtime Provider

业务宿主可以注入自定义 Realtime Provider，而不必修改 Gateway 的语音会话与后台 Agent 逻辑。

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
- `connectionMessages()` 在 WebSocket 打开后、`session.update` 之前发送原始握手帧。
- 其余事件通过 `encodeOutgoing()` 与 `normalizeIncoming()` 转换，Gateway 的工具调用、任务和客户端协议保持不变。
- 不支持临时回复指令的协议可实现 `responseInstructionsItem(response)`，将内部回复指令转为普通对话项。Gateway 等待确认后调用 `responseCreate(response)`，后者负责去掉上游不支持的参数。此时 `perResponseInstructions` 为 `false`，指令会进入会话历史。
- 只表示响应仍在进行的事件可转换为带 `response_id` 的 `response.activity`，无需转发原始思考内容。
- 服务端确认对话项时会重分配 ID 的 Provider，应声明 `conversationItemIdEcho: false`；网关按唯一待确认项关联，无需增加延时或跳过确认。
- 服务接受输入或工具结果但不返回 conversation-item 确认事件时，应声明 `acknowledgesConversationItems: false`；Gateway 写出 frame 后即完成本次发送。
- 注入的历史会被服务解释为实时用户输入而非被动上下文时，应声明 `restoreConversationContext: false`。
- `visibility: 'gateway-only'` 可让 Provider 仅供宿主选择，不出现在桌面设置和公共 Provider 列表中。

Provider 必须实现完整契约——`model()`、`voice()`、`isConfigured()`、`url()`、`headers()`、`classifyError()`、`buildSession()`、`buildSpeakResponse()`、`buildResultInjection()`、`buildPermissionInjection()`——并提供数值字段 `inputSampleRate` 与 `outputSampleRate`；缺少任一成员会在注册时抛错。

Provider 和 Protocol 会在注册与建连时校验；缺少方法或返回无效结构会立即报错。

## 桌面设置

仓库内置前台的设置统一定义在 `shared/realtime-provider-definitions.mjs`，它不依赖 Node.js，也不包含密钥值或连接实现。新增内置前台时，在这里声明名称、字段、环境变量映射和默认值；有可选模型时，同时维护 `shared/realtime-model-catalog.mjs`。桌面选择器、表单、配置读写和状态名称会消费这些定义，无需新增供应商 HTML 面板。

界面固定显示“服务地址、API Key、模型、音色”四行，分别对应 `endpoint`、`credential`、`model`、`voice` 配置槽位。Provider 只声明可配置槽位的绑定；未绑定的行仍显示，但禁用且不写入配置。Bearer 令牌统一显示在 API Key 行，保留原有配置键。`activeDefault` 用于选中自部署服务时填入建议地址；`modelFamily` 用于保留不同模型系列的独立音色配置。已有配置键及别名不变，未选中前台的草稿不参与当前地址校验。连接远端 Gateway 时，仍由远端管理前台配置。

这份设置定义与运行时适配器分离；宿主注入的自定义 Provider 不会自动注册到桌面设置页。
