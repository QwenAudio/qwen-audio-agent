# ACP：让语音层与 Agent 彻底解耦的架构实践

> 一个月内接入 9 个后台 Agent（OpenCode、OpenClaw、Qoder、Kimi Code、
> Hermes、CodeBuddy、Codex、Claude Code、通用 ACP），语音层零改动。
> 本文讲 qwen-audio-agent 是怎么做到的。

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
协调层（coordinator / session registry）
      │  统一的 ACP 会话抽象
ACP 进程客户端（acp-process-client）
      │  JSON-RPC over stdio
后台 Agent 进程（opencode / claude / codex / …）
```

### 第一层：进程客户端

`AcpProcessClient`（`server/src/agent/acp-process-client.mjs`）负责
把任意 ACP Agent 当作子进程管理：spawn 进程、用 stdio 建立 JSON-RPC
双向通道、管理请求/响应/通知的生命周期。对上层来说，所有 Agent
都长一个样：一个可以收发消息的会话。

### 第二层：Backend Driver——一个 Agent 一个"驱动"

接入一个新 Agent，只需要写一个 driver 对象（`server/src/agent/backends/`），
描述它的"身份信息"：

```js
export const openCodeBackendDriver = {
  id: 'opencode',
  label: 'OpenCode',
  createProfile({ root, directory }) {
    return {
      command: resolve(root, 'scripts/opencode-acp'),  // 启动命令
      args: [],
      env: baseEnvironment(),
      externalMcp: true,        // 能力差异标记
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
  openCodeBackendDriver, openClawBackendDriver, qoderBackendDriver,
  kimiBackendDriver, hermesBackendDriver, codeBuddyBackendDriver,
  codexBackendDriver, claudeBackendDriver, genericAcpBackendDriver,
].map(driver => [driver.id, driver]))
```

**新增一个 Agent = 新增一个文件 + 注册一行。** 语音层、会话管理、
任务系统全都不用动。

### 第三层：适配器统一事件流

不同 Agent 的行为差异（会话恢复规则、权限请求方式、工具调用格式）
收敛在 `AcpBackendAdapter`（约 1500 行）里。例如 ACP 的会话更新事件：

- `agent_message_chunk` → 转成前台的增量文本/语音流；
- `tool_call` / `tool_call_update` → 转成任务进度事件，
  驱动"正在查资料……"这类自然语言播报；
- 权限请求 → 转成语音确认（"它想修改 xx 文件，同意吗？"）。

## 两类接入方式

实践中 Agent 分两种情况：

1. **原生 ACP**（OpenCode、Qoder、Kimi Code 等）：Agent 自己说 ACP，
   直接连。我们提供一键安装脚本，`npm install -g` 之后开箱即用。
2. **外部适配**（Claude Code、Codex）：Agent 本身不说 ACP，
   通过社区适配器（如 claude-code-acp）桥接。driver 里把"适配器本体
   + 桥接进程"一起管理，对用户透明。

对语音层来说，这两种没有任何区别——这就是协议边界的价值。

## 解耦带来的实际收益

- **用户自由**：用户可以今天用 OpenCode，明天换 Claude Code，
  语音习惯、记忆、任务历史都不受影响；
- **跟进生态**：新 Agent 发布后，接入工作通常在一天内完成；
- **可测试**：协议层可以完全用 mock 进程做集成测试，
  不需要真实 Agent 环境（仓库里有完整的 acp-process-client 测试）。

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
