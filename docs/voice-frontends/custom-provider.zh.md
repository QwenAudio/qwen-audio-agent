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
- `visibility: 'gateway-only'` 可让 Provider 仅供宿主选择，不出现在桌面设置和公共 Provider 列表中。

Provider 必须实现完整契约——`model()`、`voice()`、`isConfigured()`、`url()`、`headers()`、`classifyError()`、`buildSession()`、`buildSpeakResponse()`、`buildResultInjection()`、`buildPermissionInjection()`——并提供数值字段 `inputSampleRate` 与 `outputSampleRate`；缺少任一成员会在注册时抛错。

Provider 和 Protocol 会在注册与建连时校验；缺少方法或返回无效结构会立即报错。
