# 接入新后台

接入哲学：**只走协议，不做产品级定制**。网关面向协议中立的
`BackendPort`，从不触碰后台内部实现。有四条路径可以把后台接到这个
端口之后，从零代码到一等公民支持。

## 路径一：通用 ACP（零代码）

动手之前先看目标 Agent 是否已经会说 ACP。如果会，用户只靠配置就能接入：

```dotenv
AGENT_PROTOCOL=acp
ACP_COMMAND=your-agent --acp
# 可选：逗号分隔、需要透传给 Agent 进程的环境变量名
QWEN_AUDIO_AGENT_ACP_FORWARD_ENV=MY_AGENT_API_KEY
```

对很多 Agent 来说这就是全部接入工作。

## 路径二：远程 A2A 智能体

如果目标 Agent 说的是 Google 的 A2A 协议而不是 ACP，可选的 A2A Backend
Adapter 会把它接到同一个 `BackendPort`——Agent Card 发现、协议协商、
Task、取消与 Artifact 都由适配器内的官方 A2A SDK 处理。这是面向自定义
网关启动器的编程式扩展，不新增 `AGENT_PROTOCOL` 取值。

→ [A2A Backend Adapter](../reference/a2a-backend-adapter.zh.md)

## 路径三：自定义 BackendPort 适配器

电话 Agent、硬件 Agent、HTTP 服务或任何非 ACP 的任务运行时，都可以用
Backend Adapter SDK（`qwen-audio-agent/backend-adapter-sdk`）直接实现
`BackendPort`。SDK 附带与内置适配器共用的公共一致性测试套件；
[`examples/backend-adapter/`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/backend-adapter)
是一个最小可运行实现。

→ [Backend Adapter SDK](../reference/backend-adapter-sdk.zh.md)

## 路径四：一等公民 ACP 后台

一等公民意味着一键安装、能力声明和桌面端引导。它由三样原料组装而成，
其中两样由注册中心在启动时和测试里强制校验。

### 原料一：目录条目（必填）

`shared/backend-catalog.mjs` 保存静态元数据——身份、存储与引导。
一个条目描述：

- `id` / `label`——`AGENT_PROTOCOL` 的取值与展示名。
- `setup`——CLI 如何定位（`command`、`executableEnvironment`）以及接入形态：
  `native`（自己会说 ACP）、`bridge`（内置桥接）、`adapter`
  （外部 ACP 适配器进程）、`generic`。
- `lifecycle.installation`——一键安装步骤（npm 包或平台脚本）；
  安装由用户自行管理时为 `null`。
- `onboarding`——用户执行的登录/授权命令，以及桌面端用来检测就绪状态的
  探针。
- `skills`——**强制声明**：skills.sh 安装器 id、显式的 `installer: null`
  （由共享的 `~/.agents/skills/` 约定被动覆盖），或 `skills: null`
  （没有技能约定）。缺失声明会导致注册失败——每个后台都必须对技能支持
  做出明确决定。
- `supportsFullPermission`、`baseUrlEnvironment`、`supportsExternalService`、
  透传环境变量名/前缀。

### 原料二：Agent Driver（必填）

`server/src/agent/backends/<id>.mjs`，外加 `registry.mjs` 里的一行
导入。Driver 声明能力契约并构建运行时档案：

```js
export const myBackendDriver = {
  id: 'myagent',
  label: 'My Agent',
  capabilities: {
    delegation: true,          // 能接收派发的异步任务
    permissions: true,         // 会上浮权限提示
    backendUi: false,          // 自带 UI 界面
    nativeSessionHistory: true,// 自己维护会话历史
    externalMcp: true,         // 从自己的配置加载 MCP 服务
    nativeDelegation: false,   // 有原生子代理机制
    sessionMcp: false,         // 接受按会话注入的 MCP
    coordinatorMcpInstructions: false, // 向协调器转发 MCP instructions
  },
  createProfile({ root, directory, model, modelUrl, permissionMode }) {
    return {
      label: this.label,
      acpConnection: processAcpConnection({
        command, args, cwd: directory, env: { /* 后台专属环境变量 */ },
      }),
    }
  },
}
```

八个能力标志都是必填布尔值——注册中心会校验契约，
`backend-driver-registry.test.mjs` 会断言每个对外宣称的后台都有完整的
driver。注册了一半的后台会在启动时响亮地失败，而不是在运行时静默出错。

### 原料三：Runtime Driver（按需）

`server/src/process/backend-drivers/` 负责进程级行为——托管服务如何
拉起与被监管。大多数后台这里什么都不需要：注册中心会回退到由目录条目
派生的托管进程 driver。OpenCode 和 OpenClaw 是目前仅有的两个拥有自定义
runtime driver 的后台（外部服务支持、自定义拉起规则）。

## 检查清单

1. 选路径：ACP 智能体 → 路径一或四；A2A 智能体 → 路径二；
   其他 → 路径三。
2. 一等公民后台：在 `shared/backend-catalog.mjs` 加目录条目，加 agent
   driver 并注册，按需加 runtime driver 处理自定义进程归属。
3. 跑契约测试——它们是门禁：ACP driver 跑
   `node --test server/test/backend-driver-registry.test.mjs`，自定义
   适配器跑 `node --test server/test/backend-adapter-sdk.test.mjs`。

## 继续阅读

- [后台支持矩阵](overview.zh.md)——当前已支持的后台
- [后台配置参考](../configuration/backend.zh.md)
