# Gateway Client Protocol Roadmap

> 状态：提案
>
> GitHub 跟踪：[#251](https://github.com/QwenAudio/qwen-audio-agent/issues/251)
>
> 协议：[Gateway Client Protocol](../gateway-protocol.zh.md)

## 目标

完成 qwen-audio-agent 尚未固化的公开架构边界。`BackendPort` 已经把 Gateway 与 ACP、A2A、自定义 Backend Agent 隔离；本 Roadmap 继续把 Gateway Core 与 TUI、WebUI、桌面悬浮球及未来 Client Environment 隔离。

最终形成三个可替换边界：

```text
Client Environment
        ↕ Gateway Client Protocol / ClientPort
Gateway Core
        ├─ RealtimeProvider
        ↕ BackendPort
Backend Agent
```

## 当前基础

仓库已经具备：

- 一条 WebSocket 承载语音、文本、播放回执、Task 与状态；
- 共享事件常量和 Zod 消息 Schema；
- 独立用户输入 Runtime；
- 规范化 BackendPort Event 与 Task Projection；
- Provider 无关的结果和权限注入基础；
- Task 播报排队、重试和播放确认；
- 第一方 WebUI、TUI 和 Desktop Client。

尚未解决：

- Client 分发仍集中在 `realtime-gateway.mjs`；
- Desktop capability 与休眠仍然存在特殊分支；
- 缺少通用 Client-to-Gateway 语义事件 API；
- 缺少通用 Gateway-to-Client Action/Result 契约；
- 用户输入、Task 播报、权限和 Gateway Trigger 尚未共享统一语义 Event/Delivery 边界；
- 缺少 6.0 握手、事件关联和完整 Client conformance suite。

## 架构规则

1. 每个 Gateway 只保留一个活动 Client。
2. 原始媒体不进入语义 Event Router。
3. 用户输入、Client Event、Task Event 与 Client Action 保持不同权限语义。
4. 模型是否感知、何时回复由 Gateway Policy 决定。
5. 语义事件先投影成 Provider 无关 Agent Delivery，再编码成 Provider 协议。
6. 模型可见的 Client 工具来自协商后的 Client Action capability。
7. 所有第一方 Client 完成迁移前，每个阶段保持向后兼容。
8. 每个阶段使用独立可审查 PR，并关联 issue #251。

## GCP0 — 固化契约

- [ ] 合并中英文协议和本 Roadmap。
- [ ] 记录当前 5.x 别名与 characterization coverage。
- [ ] 将协议文档加入公开契约索引。

完成条件：术语、单 Client 所有权、Event/Action 语义、路由模式、休眠汇合与迁移策略可以在一个位置完整评审。

## GCP1 — 信封、握手与能力

- [ ] 增加包含 `event_id`、`request_event_id`、回放 `sequence` 的 6.0 Schema。
- [ ] 增加 `session.hello` / `session.ready` 协商。
- [ ] 增加 Client Event、Client Action 和回放 capability。
- [ ] 通过归一化层继续支持 5.x `connect` 和旧事件别名。
- [ ] 发布共享 Parser 与 Client SDK Helper。

完成条件：5.x 与 6.0 参考 Client 可以连接同一个 Gateway，且不分叉业务逻辑。

## GCP2 — Client Event Ingress

- [ ] 增加 Client Event Definition Registry。
- [ ] 增加 `GatewayEventRouter` 与 `client.event.publish/result`。
- [ ] 在连接边界填写可信来源身份。
- [ ] 执行 Schema、大小、频率、保存、去重与合并 Policy。
- [ ] 以 `desktop.presence.sleep_requested` 完成首个端到端事件。

完成条件：Client 可以发布已注册的环境或用户行为事件，不需要伪装成用户文本，也不需要给 Gateway 增加新的条件分支。

## GCP3 — Agent Delivery

- [ ] 定义 Provider 无关 `AgentDelivery` 以及 `handle`、`context`、`respond`、`interrupt`。
- [ ] 为全部 Realtime Provider 增加 context-only 注入。
- [ ] 从当前 Task 播报链路抽取可复用的串行化、阻塞、重试和播放确认。
- [ ] 让有意义的 Task、权限、Gateway 与 Client Event 使用共享 Delivery Runtime。
- [ ] 高频进展和媒体不进入模型路径。

完成条件：同一个事件可以只更新 Gateway/UI、静默更新模型上下文，或只产生一次安全的 Realtime 回复，并且 Gateway 不包含 Provider 专属逻辑。

## GCP4 — Client Action Port

- [ ] 增加 `ClientActionPort` 与 `client.action.request/result`。
- [ ] 在握手中声明 Client Action capability。
- [ ] 只有 Client 支持时才暴露 Action 派生的 Realtime 工具。
- [ ] 将 `enter_sleep` 从 `requestClientState()` 迁移到共享 Action 链路。
- [ ] 以一个幂等 `PresenceController` 处理用户主动、自动、超时与重复休眠请求。
- [ ] Client Action 成功后才标记 sleeping。

完成条件：Realtime Tool Call 与 Gateway 兜底共用一个 Action/状态机，Gateway Core 不再知道 Desktop 如何隐藏窗口。

## GCP5 — 参考 Client、回放与稳定

- [ ] WebUI、TUI、Desktop 迁移到共享参考 Client SDK。
- [ ] 增加有界回放与重连恢复。
- [ ] 对所有第一方 Client 运行同一套 conformance suite。
- [ ] 在 `docs/contract.md` 及中文版记录有测试锁定的 capability。
- [ ] 旧别名至少经过一个明确废弃版本后再删除。
- [ ] 替代链路验证完成后，才将 6.0 Spec 标记为稳定。

完成条件：第一方 Client 只包含 Presentation 与环境行为，不自行重建 Gateway 状态机；Gateway 不包含第一方 Client 实现分支。

## PR 规则

- 协议版本迁移、Event Ingress、Agent Delivery 与 Client Action 不能合并成一个 PR。
- 每个 PR 关联 issue #251，并注明所属 GCP 阶段。
- 每个公开事件同时提交 Schema、Parser、反例测试、capability 行为与文档。
- 删除兼容别名前，现有第一方行为必须持续通过测试。
- 任何阶段都不能让 Realtime Provider、ACP、A2A、Electron、React 或 CoreAudio 对象跨越公开 Port。
