# ACP：让语音层与 Agent 彻底解耦的架构实践

> OpenCode、OpenClaw、Qoder、Qwen Code、MiniMax Code、Kimi Code、Hermes、
> CodeBuddy、Codex、Claude Code、DeepSeek、Pi，以及用户自带的通用 ACP Agent，
> 都通过同一边界接入。本文讲 qwen-audio-agent 是怎么做到的。

## 背景：Agent 生态快得离谱

做语音前台的第一天就面临一个现实：CLI Agent 生态每个月都在变。
新的 Agent 出现、协议演进、安装方式变化……如果语音层和某个 Agent
直接集成，维护成本会指数级上涨。

我们的选择是：**只对接协议，不对接产品**。这个协议就是
[ACP（Agent Client Protocol）](https://agentclientprotocol.com)——
一个基于 JSON-RPC 的 Agent 通信标准。

## 三层结构

```
语音运行时（voice/）
      │  只认识"任务"和"事件"，不认识任何 Agent
协议中立层（backend/ + task/）
      │  BackendPort、Task 生命周期
ACP 接入层（acp/backend-adapter + session-registry + process-client）
      │  JSON-RPC over stdio
后台 Agent 进程（opencode / claude / codex / …）
```

### 组件一：进程客户端

`AcpProcessClient`（`server/src/agent/acp/process-client.mjs`）负责
把任意 ACP Agent 当作子进程管理：spawn 进程、用 stdio 建立 JSON-RPC
双向通道、管理请求/响应/通知的生命周期。对上层来说，所有 Agent
都长一个样：一个可以收发消息的会话。

### 组件二：Backend Driver——一个 Agent 一个"驱动"

每个产品的连接方式和能力差异由 driver 对象
（`server/src/agent/acp/drivers/`）描述：

```js
export const openCodeBackendDriver = {
  id: 'opencode',
  label: 'OpenCode',
  capabilities: {
    delegation: true,
    permissions: true,
    backendUi: true,
    nativeSessionHistory: true,
    externalMcp: true,
    nativeDelegation: false,
    sessionMcp: true,
    coordinatorMcpInstructions: true,
  },
  createProfile({ root, directory }) {
    return {
      label: this.label,
      acpConnection: processAcpConnection({
        command: process.execPath,
        args: [resolve(root, 'scripts/runtime/opencode.mjs'), 'acp'],
        cwd: directory,
        env: { ...baseEnvironment('opencode'), ELECTRON_RUN_AS_NODE: '1' },
      }),
      externalMcp: true,
      nativeDelegation: false,
      backendUi: true,
      uiUrl({ baseUrl, sessionId }) { /* ... */ },
    }
  },
}
```

注册中心（`registry.mjs`）把所有 driver 放进一张 Map，按 id 取用：

```js
const drivers = new Map([
  openCodeBackendDriver,
  openClawBackendDriver,
  ...localAcpBackendDrivers,
  codeBuddyBackendDriver,
  codexBackendDriver,
  claudeBackendDriver,
  deepSeekHarnessBackendDriver,
  piBackendDriver,
  genericAcpBackendDriver,
].map(validateBackendDriver).map(driver => [driver.id, driver]))
```

新增 Agent 时扩展对应 driver，并在 registry 与 `shared/backend/catalog.mjs`
登记身份、安装和配置元数据；语音层、BackendPort 和 Task 生命周期不用改。

### 组件三：适配器统一事件流

通用 ACP 会话与事件处理收敛在 `AcpBackendAdapter`，产品的连接和能力差异留在
drivers；OpenClaw 的原生委托则封装在 `drivers/openclaw-delegation.mjs`。
协议事件进入 Task 系统前会依次归一化：

- `agent_message_chunk` → `backend.message` → `task.updated`；
- `tool_call` / `tool_call_update` → `backend.activity` →
  `task.progress` / `task.updated`；
- ACP 权限请求经 permission broker 转成 `backend.permission.requested`，再进入
  `task.permission.requested`，由前台自然询问用户。

## 四类接入方式

共享 catalog 用四个 integration 类型描述安装和连接方式：

1. **native**：OpenCode、Qoder、Qwen Code、MiniMax Code、Kimi Code、Hermes、
   CodeBuddy、DeepSeek；
2. **bridge**：OpenClaw 通过项目维护的桥接层对接 ACP；
3. **adapter**：Codex、Claude Code、Pi 通过独立 ACP 适配器接入；
4. **generic**：用户通过 `ACP_COMMAND` 连接任意兼容 Agent。

桌面端和 CLI 读取同一 catalog，提供统一的按需安装与配置流程；具体认证仍由
对应 Agent 自己完成。

对语音层来说，这些接入方式没有任何区别——这就是协议边界的价值。

## 解耦带来的实际收益

- **用户自由**：用户可以今天用 OpenCode，明天换 Claude Code，
  语音习惯、记忆、任务历史都不受影响；
- **跟进生态**：新 Agent 发布后，接入工作通常在一天内完成；
- **可测试**：协议层可以完全用 mock 进程做集成测试，
  不需要真实 Agent 环境（见 `server/test/acp-process-client.test.mjs`）。

## 给同行的建议

如果你也在做 Agent 外围工具（语音、UI、编排），三条建议：

1. **第一天就选协议边界**，先做通用层，再做特例；反过来做就回不去了。
2. **用能力标记描述差异**（如 `externalMcp`、`nativeDelegation`），
   不要在主流程里写 `if (agent === 'claude')`。
3. **把每个 Agent 的差异点文档化在 driver 里**，driver 就是最不会
   过期的文档。

---

qwen-audio-agent 是开源项目（Apache-2.0）。如果你维护的 Agent
支持 ACP，欢迎来接入：https://github.com/QwenAudio/qwen-audio-agent
