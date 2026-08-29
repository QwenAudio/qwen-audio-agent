---
marp: true
theme: default
paginate: true
size: 16:9
title: qwen-audio-agent：面向持续对话与长时任务的语音 Agent 架构
description: 前后台协同、异步任务、独立执行、自然播报与长期记忆
footer: qwen-audio-agent · Voice Agent Architecture
style: |
  section {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #172033;
    background: #ffffff;
    padding: 42px 64px;
    font-size: 23px;
    line-height: 1.45;
  }
  h1 {
    color: #111827;
    font-size: 39px;
    line-height: 1.2;
    margin: 0 0 24px;
  }
  h2 {
    color: #2563eb;
    font-size: 28px;
    margin: 0 0 18px;
  }
  h3 {
    color: #111827;
    font-size: 24px;
    margin: 16px 0 8px;
  }
  p, li { font-size: 22px; }
  li { margin: 7px 0; }
  strong { color: #2563eb; }
  code { font-size: 0.86em; }
  pre {
    background: #f8fafc;
    color: #0f172a;
    border: 1.5px solid #cbd5e1;
    border-left: 5px solid #2563eb;
    border-radius: 10px;
    padding: 16px 20px;
    font-size: 17px;
    line-height: 1.42;
    box-shadow: none;
  }
  pre code,
  pre code.hljs {
    display: block;
    padding: 0;
    font-size: inherit;
    color: #0f172a;
    background: transparent;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-variant-ligatures: none;
  }
  .hljs-comment,
  .hljs-quote { color: #64748b; font-style: italic; }
  .hljs-keyword,
  .hljs-selector-tag,
  .hljs-literal { color: #7c3aed; }
  .hljs-string,
  .hljs-attr,
  .hljs-template-variable { color: #047857; }
  .hljs-number,
  .hljs-symbol,
  .hljs-bullet { color: #b45309; }
  .hljs-title,
  .hljs-function { color: #1d4ed8; }
  .hljs-built_in,
  .hljs-type { color: #0369a1; }
  .hljs-variable,
  .hljs-params { color: #334155; }
  .hljs-meta { color: #be123c; }
  .hljs-punctuation { color: #475569; }
  .hljs-strong { font-weight: 700; }
  .hljs-emphasis { font-style: italic; }
  .hljs-addition { color: #047857; background: #ecfdf5; }
  .hljs-deletion { color: #b91c1c; background: #fef2f2; }
  pre::-webkit-scrollbar {
    display: none;
  }
  table {
    width: 100%;
    font-size: 18px;
  }
  th {
    color: #1d4ed8;
    background: #eff6ff;
  }
  td, th { padding: 9px 12px; }
  blockquote {
    border-left: 5px solid #7c3aed;
    background: #f5f3ff;
    padding: 12px 20px;
    margin: 20px 0;
  }
  blockquote p { font-size: 22px; }
  blockquote strong { font-weight: 750; }
  .lead {
    background: linear-gradient(120deg, #ffffff 0%, #eff6ff 100%);
  }
  .lead h1 { font-size: 56px; max-width: 920px; }
  .lead h2 { font-size: 30px; color: #64748b; }
  .diagram {
    padding: 16px 24px 26px;
  }
  .diagram h1 {
    font-size: 30px;
    margin: 4px 0 8px;
  }
  .diagram img {
    display: block;
    width: 100%;
    height: 560px;
    max-height: 560px;
    object-fit: contain;
    object-position: center top;
    margin: 0 auto;
  }
  .diagram-only {
    padding: 0;
    overflow: hidden;
  }
  .diagram-only p {
    margin: 0;
    width: 100%;
    height: 720px;
  }
  .diagram-only img {
    display: block;
    width: 100%;
    height: 720px;
    max-height: 720px;
    object-fit: contain;
    object-position: center center;
    margin: 0 auto;
  }
  .two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 52px;
  }
  .three-col {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 34px;
  }
  .big-number {
    color: #2563eb;
    font-size: 32px;
    font-weight: 750;
    margin: 0;
  }
  .plain-term {
    color: #64748b;
    font-size: 18px;
  }
  .callout {
    color: #111827;
    font-size: 27px;
    font-weight: 700;
    margin-top: 28px;
  }
  .small { font-size: 17px; }
  .compact li { font-size: 19px; margin: 4px 0; }
  .runtime-pipeline {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 36px minmax(0, 1fr) 36px minmax(0, 1fr) 36px minmax(0, 1fr);
    align-items: stretch;
    margin: 54px 0 34px;
  }
  .runtime-step {
    min-height: 138px;
    box-sizing: border-box;
    border: 2px solid #cbd5e1;
    border-radius: 12px;
    background: #f8fafc;
    padding: 18px 12px 16px;
    text-align: center;
  }
  .runtime-step strong {
    display: block;
    color: #111827;
    font-size: 23px;
    margin-bottom: 8px;
  }
  .runtime-step .component {
    display: block;
    min-height: 48px;
    color: #2563eb;
    font-size: 17px;
    font-weight: 700;
    line-height: 1.3;
  }
  .runtime-step .action {
    display: block;
    color: #64748b;
    font-size: 17px;
    line-height: 1.3;
  }
  .runtime-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #2563eb;
    font-size: 32px;
  }
  .memory-arch {
    display: grid;
    grid-template-columns: 1.05fr 34px 1.15fr 34px 1.1fr 34px 1.05fr;
    align-items: center;
    gap: 8px;
    margin-top: 46px;
  }
  .memory-stack {
    display: grid;
    gap: 18px;
  }
  .memory-node {
    border: 1.5px solid #cbd5e1;
    border-radius: 10px;
    background: #f8fafc;
    padding: 18px 14px;
    text-align: center;
    font-size: 18px;
    line-height: 1.35;
  }
  .memory-node strong {
    display: block;
    color: #111827;
    font-size: 21px;
    margin-bottom: 6px;
  }
  .memory-service {
    background: #eff6ff;
    border-color: #60a5fa;
  }
  .memory-store {
    background: #f5f3ff;
    border-color: #a78bfa;
  }
  .memory-consumer {
    background: #ecfdf5;
    border-color: #6ee7b7;
  }
  .memory-arrow {
    color: #64748b;
    font-size: 44px;
    text-align: center;
  }
  section::after { color: #94a3b8; }
---

<!-- _class: lead -->

# 面向持续对话与长时任务的语音 Agent 架构

## qwen-audio-agent 架构设计

低延迟对话 · 异步工作 · 独立执行 · 自然播报 · 长期记忆

---

<!-- _class: diagram -->

# 系统总览：实时语音与后台 Agent 协同

![前台与后台二级架构](./architecture-overview.png)

<!--
[Sources]
- docs/architecture-overview.png
-->

---

# 框架目标：统一实时交互与长时任务执行

> 系统向用户呈现为一个持续在线的语音 Agent：前台保持对话，后台承担长时工作。

- 可即时响应的问题：直接回答，并支持随时打断。
- 复杂任务：交给后台，可能运行几分钟甚至更久。
- 等待期间：用户可以继续说话、查询进度或取消任务。
- 任务完成：结果回到同一个语音人格，自然地接上当前对话。

<p class="callout">核心目标：让“实时交谈”和“长期工作”同时成立。</p>

---

# 一个助手，运行在两种时间尺度上

<div class="two-col">

<div>

<p class="big-number">百毫秒级</p>

### 对话节奏

- 低延迟
- 可打断
- 持续在场

<p class="plain-term">实时路径目标：低延迟响应。</p>

</div>

<div>

<p class="big-number">秒~小时级</p>

### 工作节奏

- 工具与文件
- 多个工作会话
- 可恢复、可取消

<p class="plain-term">异步路径目标：可靠执行与恢复。</p>

</div>

</div>

---

<!-- _class: diagram -->

# 两级运行架构：实时前台与后台协调

![三级架构的前两级](./qwen-audio-agent-two-layer-architecture.png)

<!--
[Sources]
- docs/qwen-audio-agent-two-layer-architecture.png
-->

---

# 两级架构划分为六个职责域

| 职责域 | 组件 | 架构职责 |
| --- | --- | --- |
| 实时对话 | Realtime Frontstage | 理解对话、决定直接回答或提交异步任务，承接后台结果 |
| 语音控制 | Realtime Gateway | 管理客户端接入（GCP）、语音连接、回合、打断、Realtime 协议、响应关联与播放状态 |
| 任务账本 | TaskManager | 记录任务是否排队、运行、完成或取消 |
| 后台接入 | BackendPort / Adapter | 将 ACP、A2A 与自定义后台 Agent 归一为统一事件与状态 |
| 持续协调 | Coordinator Session | 维持用户上下文，决定直接完成或继续委派 |
| 结果播报 | AnnouncementManager | 等到合适时机，再让前台自然说出结果 |

**具体实现可以替换，职责边界必须保持稳定。**

---

# 一次后台任务经历判断、受理、执行与交付

<div class="runtime-pipeline">
  <div class="runtime-step">
    <strong>前台判断</strong>
    <span class="component">Realtime Frontstage</span>
    <span class="action">直接回答或转入后台</span>
  </div>
  <div class="runtime-arrow">→</div>
  <div class="runtime-step">
    <strong>任务受理</strong>
    <span class="component">TaskManager</span>
    <span class="action">建立任务并持续跟踪</span>
  </div>
  <div class="runtime-arrow">→</div>
  <div class="runtime-step">
    <strong>后台执行</strong>
    <span class="component">Backend Adapter<br>+ Coordinator Session</span>
    <span class="action">协调并持续处理</span>
  </div>
  <div class="runtime-arrow">→</div>
  <div class="runtime-step">
    <strong>结果交付</strong>
    <span class="component">AnnouncementManager</span>
    <span class="action">择机交给前台播报</span>
  </div>
</div>

> <strong>Gateway 服务统一承载并编排任务链路：</strong> Realtime Gateway 维护语音交互状态；TaskManager、后台协调器与 AnnouncementManager 分别负责受理、执行和交付。

---

# 实时前台只保留低延迟职责

<div class="two-col">

<div>

## 直接回答

- 当前上下文已经足够
- 不需要外部搜索或文件
- 在当前语音回合生成答案
- 用户可以随时打断

</div>

<div>

## 提交后台

- 需要搜索、工具或文件
- 通过 `spawn_thinking` 提交异步任务
- 得到任务编号后结束本轮
- 后台独立继续执行

</div>

</div>

> 前台不持有后台原生 Session，也不决定后台工具链。

---

# 工具注册表，让前台能力保持可控

```js
export const frontendToolRegistry = new FrontendToolRegistry([
  // ── 内置：始终存在 ──
  { definition: spawnThinkingTool,       policy: { mode: 'background' } },
  { definition: scheduleReminderTool,    policy: { mode: 'inline' } },
  { definition: getCurrentTimeTool,      policy: { mode: 'inline' } },
  { definition: memoryTool,              policy: { mode: 'inline' } },
  { definition: notesTool,               policy: { mode: 'inline' } },
  { definition: cancelAgentTaskTool,     policy: { mode: 'control' } },
  { definition: getAgentTaskStatusTool,  policy: { mode: 'control' } },
  // ── 可扩展：按能力或客户端动作出现 ──
  { definition: webSearchTool,           policy: { mode: 'inline',  requiredCapabilities: […] } },
  { definition: fetchUrlTool,            policy: { mode: 'inline',  requiredCapabilities: […] } },
  { definition: knowledgeTool,           policy: { mode: 'inline',  requiredCapabilities: […] } },
  { definition: recallTool,              policy: { mode: 'inline',  requiredCapabilities: […] } },
  { definition: respondPermissionTool,   policy: { mode: 'control', requiredCapabilities: […] } },
  { definition: respondAgentInputTool,   policy: { mode: 'control', requiredCapabilities: […] } },
  { definition: enterSleepTool,          policy: { mode: 'control', requiredClientActions: […] } },
])
```

> <strong>前台工具集保持最小且有界：</strong> 每个工具携带策略：inline 快速读写、control 状态操作、background 异步任务。

<!--
[Sources]
- server/src/voice/frontend-tools.mjs
- server/src/voice/tools/spawn-thinking-tool.mjs
-->

---

# `spawn_thinking` ：快速受理，不等待结果

> **`spawn_thinking`** 是实时前台提交异步任务的唯一入口：Gateway 写入权威任务记录并立即返回内部受理回执，后台任务继续独立执行。

| 步骤 | 系统做什么 | 用户得到什么 |
| ---: | --- | --- |
| 1 | 保留目标和约束 | 请求不会被改写成另一件事 |
| 2 | 检查后台是否已配置、权限是否待处理 | 明确失败原因，不假装成功 |
| 3 | 写入一个权威任务记录 | 产生唯一任务 ID（`task_N`） |
| 4 | 立即返回受理回执 | 可以继续下一轮对话 |
| 5 | 后台独立取得调度槽并执行 | 不占用实时语音回合 |

```text
accepted 只表示“任务已经进入系统”
不表示“任务已经完成”
```

> 除 `objective` 外，任务还可携带 `input_refs`：把本轮或此前轮次标注为“可引用输入”的图片、文件作为原生附件一并移交后台。


---

# 自包含指令承载前后台之间的任务交接

Gateway 内部保留两份信息：

| 字段 | 含义 | 为什么需要 |
| --- | --- | --- |
| 用户原话 | 用户本轮最终表达 | 作为内部事实依据，避免转述丢失细节 |
| `objective` | 前台整理后的执行目标 | 解析指代并形成自包含任务边界 |

示例：

```text
用户原话：“接着刚才那个页面，把登录失败的问题修掉，不要修改现有视觉。”

objective: “继续当前页面工作，修复登录失败问题；保持现有视觉不变。”
```

**整理目标帮助理解，但永远不覆盖用户原话。**

---

# 协调信息：结构留在 Gateway，后台只收自然指令

用户本轮说：“接着刚才那个页面，把登录失败的问题修掉，不要修改现有视觉。”

```text
① 前台发起工具调用
spawn_thinking({ objective: "继续当前页面工作，修复登录失败问题；保持现有视觉不变。" })

② Gateway 写入权威任务：身份、会话、路由分字段存放，不进 prompt
{ id: "task_12", status: "queued", scope: "user", kind: "work",
  objective: "继续当前页面工作，…", ownerId: "personal", sessionId: "main", turnId: "…" }

③ 后台协调会话实际收到
objective 文本 + COORDINATOR_STABLE_INSTRUCTIONS 稳定指令块 + 用户原话（ACP ContentBlock 附件）
```

> 协调信息**内化为 Gateway 的权威任务记录**；投递给后台的只是投影——前台人格、完整记忆与聊天历史不会被批量转发，稳定指令块同时承载 Project Session 的路由纪律。

<!--
[Sources]
- server/src/task/task-manager.mjs
- server/src/backend/backend-work-input.mjs
- server/src/agent/acp-coordinator-contract.mjs
- server/src/agent/acp-coordinator-instructions.mjs
-->

---

# TaskManager 维护任务生命周期的权威事实

每个任务都保存：

- **任务归属**：用户身份、语音 Session、来源回合。
- **要做什么**：objective。
- **做到哪一步**：状态、开始时间、完成时间。
- **发生过什么**：有界的工具活动和权限请求。
- **结果是什么**：最终结果或错误。
- **是否已经告诉用户**：通知状态和播放确认时间。

> 模型负责解释状态；TaskManager 决定状态是什么。

---

# 任务生命周期由显式状态机驱动

```text
scheduled
   │ 到时
   ▼
queued → running ─────────────────────────→ completed
            │                                  │
            ├→ delegated → finalizing ─────────┘
            │
            ├→ cancelling → cancelled
            │
            └──────────────────────────────→ failed
```

| 状态 | 运行语义 |
| --- | --- |
| `queued` | 已受理，正在等后台空闲 |
| `running` | 固定协调会话正在处理 |
| `delegated` | 独立工作会话正在执行 |
| `finalizing` | 工作已结束，正在整理最终结果 |
| `completed` | 可信结果已经产生 |

<!--
[Sources]
- server/src/task/task-manager.mjs
-->

---

# TaskManager 决定后台任务何时开始、是否并行

任务进入 `queued` 后，TaskManager 按以下规则决定何时开始执行：

<div class="three-col">

<div>

### 有界并发

限制同时运行的后台任务，避免本机资源和后台服务过载。

</div>

<div>

### 串行协调

同一协调 Session 一次只处理一项任务，保证上下文顺序。

</div>

<div>

### 委派释放

任务进入独立执行层后释放协调槽位，长任务不阻塞后续请求。

</div>

</div>

> <strong>核心约束：</strong> 资源可控、上下文有序、长任务不阻塞持续对话。

---

# 协调 Session 提供可持续续接的后台对话窗口

协调 Session 是 Backend Adapter 为当前用户创建或恢复的一条后台 Agent 原生会话，用于承接跨任务的持续理解与执行协调。

- 同一用户反复复用，而不是每次重新开始。
- 每轮只看到自包含任务指令和当前任务所需的原生附件。
- 简单后台工作可以自己完成。
- 复杂、独立或长期工作可以进入独立执行层。
- 独立任务完成后，它负责校验结果并整理最终表达。

```js
return `${protocol}:${encodeURIComponent(
  clean(ownerId) || 'personal'
)}:backend`
```

**协调会话负责持续理解；独立 Session 负责长任务执行。**

<!--
[Sources]
- server/src/agent/acp-backend-session-utils.mjs
- server/src/agent/acp-backend-adapter.mjs
-->

---

# Backend Adapter 统一不同后台的协议语义

Backend Adapter 是后台协议适配层：

| 不同后台的差异 | 对上层统一成 |
| --- | --- |
| 不同 Session 协议 | 创建、恢复、继续、取消 |
| 不同工具事件 | 搜索、读取、修改、执行等通用活动 |
| 不同权限格式 | 有界的权限问题和用户决定 |
| 不同完成事件 | 可信结果与统一错误 |
| 不同启动方式 | owned / external 的明确进程归属 |

这样更换后台 Agent 时，不需要重写前台工具、任务状态机和播报逻辑。

> **扩展红利**：后台接入收敛为 **BackendPort** 契约——ACP 后台走通用 Adapter，
> 远程 A2A Agent 有专属 Adapter，非 ACP 系统可用 Backend Adapter SDK 自行实现。
> 统一的一致性测试套件对所有适配器执行同一组行为验证。

---

# 结果交付必须服从双工会话状态

结果产生时，用户可能正在说话或正在听上一段音频。

系统会依次：

1. 等用户说完。
2. 等当前回复与音频队列结束。
3. 等一个很短的安静窗口。
4. 合并刚刚一起完成的结果。
5. 把结果事实放回 Realtime 上下文。
6. 让同一人格自然表达。
7. 客户端开始播放后，才将通知标记为“已交付”。

> 最快说出来，不一定是最自然的交互。

---

# `response.done` 不是“用户已经听到”

与文本助手不同，语音助手的“生成完成”与“实际交付”之间存在时间差。

```js
if (outcome?.completed) {
  // Realtime has generated the response, but the client may still have it
  // queued behind earlier audio. Delivery is confirmed only when the
  // client reports that playback has actually started.
  batch.responseCompleted = true
  this.scheduleAcknowledgementTimeout()
}
```

```text
任务完成
  ≠ 语音生成完成
  ≠ 客户端开始播放
```

- 生成完成后仍然保留“领取凭证”，防止结果丢失。
- 重连或播放失败时可以重试。
- 同一结果上下文只注入一次，避免模型反复看到重复事实。

<!--
[Sources]
- server/src/voice/announcement/announcement-manager.mjs
- server/src/voice/realtime-gateway.mjs
-->

---

# 独立执行层：动态衍生的“第三层”

后台执行 Agent 具备**自主衍生能力**：可单独创建子 Agent （新 Session），形成类似“第三层”的独立执行空间。


<div class="two-col">

<div>

## 独立执行边界

- Session 保存任务历史与执行进度
- 工作区承载文件、工具和产物
- 权限约束在当前任务范围

</div>

<div>

## 与协调层形成闭环

1. 创建或续接目标 Session
2. 执行期间持续回传事件
3. 查询、取消与恢复指向同一 Session
4. 最终结果返回协调层统一交付

</div>

</div>

**核心价值：任务拥有独立、可追踪、可取消、可续接的生命周期。**

---

<!-- _class: diagram-only -->
<!-- _footer: "" -->
<!-- _paginate: false -->

![bg contain](./qwen-audio-agent-three-layer-architecture.png)

<!--
[Sources]
- docs/qwen-audio-agent-three-layer-architecture.png
-->

---

# 是否进入独立执行层，取决于任务是否需要独立生命周期

<div class="two-col">

<div>

## 进入独立执行层

- 需要跨回合延续同一个工作 Session
- 需要独立工作区和多步工具执行
- 需要单独的权限、取消或恢复边界
- 用户明确继续已有项目 Session

</div>

<div>

## 留在协调 Session

- 当前协调回合即可完成
- 只需轻量检索、计算或状态查询
- 回合结束后无需保留执行状态
- 结果可以直接进入交付

</div>

</div>

**判断标准不是任务“难不难”，而是是否需要创建并维护独立执行状态。**

---

# 五个 MCP Session 工具连接协调层与独立执行层

```js
export const ACP_SESSION_TOOL_NAMES = [
  'qwen_audio_agent_sessions_list',
  'qwen_audio_agent_session_start',
  'qwen_audio_agent_session_send',
  'qwen_audio_agent_session_status',
  'qwen_audio_agent_session_cancel',
]
```

| 工具 | 职责 |
| --- | --- |
| `list` | 找到以前的工作 Session |
| `start` | 开始一项新的独立工作 |
| `send` | 继续某个已有 Session |
| `status` | 读取当前执行状态与阶段结果 |
| `cancel` | 精确取消这项工作 |

MCP Session 工具不暴露给语音前台，仅作为协调会话管理独立执行层的统一接口。

<!--
[Sources]
- server/src/agent/acp-session-tools.mjs
-->

---

# 委派是一套可追踪、可取消、可恢复的执行协议

协调层与独立执行层之间的交互，本质上是一种委派（Delegation）机制。

| 阶段 | 谁负责 | 关键动作 |
| ---: | --- | --- |
| 1 | 协调会话 | 调用 `session_start` 或 `session_send` |
| 2 | Adapter | 记录 delegation ID 与目标 Session |
| 3 | TaskManager | 任务进入 `delegated`，释放协调槽位 |
| 4 | 独立 Session | 使用文件、终端、搜索等能力长期执行 |
| 5 | Adapter | 等待与当前委派精确匹配的最终结果 |
| 6 | 协调会话 | 重新取得控制权，校验并整理结果 |
| 7 | TaskManager | 任务进入 `completed`，等待自然播报 |

> 取消、查询、权限和重启恢复，始终绑定同一项任务与目标 Session。

---

# 运行时上下文由系统设定与长期信息共同构成

| 上下文来源 | 作用 | 类型与权威 |
| --- | --- | --- |
| `PROMPT.md` | 核心协议、工具规则与安全边界 | 系统设定，只读，最高优先级 |
| `ASSISTANT.md` | 默认身份、人格与关系定位 | 系统设定，只读，作为默认值 |
| 当前请求 | 用户此刻明确表达的目标 | 当前回合意图，高于历史偏好 |
| `USER.md` | 称呼、语言、表达风格与默认做法 | 可写记忆，具有有限指令权威 |
| `MEMORY.md` | 稳定事实、项目背景与长期决定 | 可写记忆，只作为理解数据 |

> **指令优先级**：PROMPT > 当前请求 > USER > ASSISTANT
> **数据隔离**：MEMORY 仅作为理解数据，不参与指令竞争。

---

# 记忆架构：三路径写入与统一上下文消费

明确上下文边界后，仅 `USER.md` 与 `MEMORY.md` 参与动态写入。它们通过三条路径进入统一服务，最终供前后台消费：

<div class="memory-arch">

<div class="memory-stack">
  <div class="memory-node"><strong>显式写入</strong>Realtime <code>memory</code> tool</div>
  <div class="memory-node"><strong>会后整理</strong>MemoryExtractor（不得推测）</div>
  <div class="memory-node"><strong>观察推断</strong>ProfileObserver → 候选池 → 晋升</div>
</div>

<div class="memory-arrow">›</div>

<div class="memory-node memory-service"><strong>统一记忆服务</strong>边界校验 · revision 校验<br>原子写入 · 审计</div>

<div class="memory-arrow">›</div>

<div class="memory-stack">
  <div class="memory-node memory-store"><strong>USER.md</strong>明确要求 ＋ 观察推断（分区存放）</div>
  <div class="memory-node memory-store"><strong>MEMORY.md</strong>长期事实数据</div>
</div>

<div class="memory-arrow">›</div>

<div class="memory-stack">
  <div class="memory-node memory-consumer"><strong>Realtime Frontstage</strong>直接对话与工具判断</div>
  <div class="memory-node memory-consumer"><strong>Coordinator Session</strong>后台理解与结果校验</div>
</div>

</div>


<!--
[Sources]
- server/src/conversation/frontend-agent-context.mjs
- server/src/conversation/frontend-memory-service.mjs
- server/src/conversation/memory-extractor.mjs
- server/src/conversation/profile-observer.mjs
- server/src/conversation/preference-promoter.mjs
-->

---

# 长期信息通过三种入口写入，纪律各不相同

<div class="three-col">

<div>

## 用户明确要求记住

- 由当前语音回合显式触发
- `read`：查看已有内容
- `append`：追加一项
- `replace`：精确修改或删除
- 写入成功后才能说“记住了”

</div>

<div>

## 会后整理（不得推测）

- 由语音 Session 关闭异步触发
- MemoryExtractor 只记录用户明说的事实
- 只处理 `USER.md` 与 `MEMORY.md`
- 静默运行，不阻塞会话关闭

</div>

<div>

## 观察推断（允许推测）

- ProfileObserver 观察画像字段，证据必须逐字出自用户发言
- 候选进入槽位池，跨会话攒确认
- 过门后由晋升器写入 `USER.md` 的「观察推断」区
- 永不覆盖「用户明确要求」区

</div>

</div>

**三个入口最终调用同一个 FrontendMemoryService；模型和工具都不能直接改写 Markdown 文件。**

---

# 自动整理采用“模型建议、代码裁决”的提交协议

```text
对话转写 → 模型生成 JSON Patch
         → 敏感信息与文档边界校验
         → USER 明确指令校验
         → revision 校验与原子写入
         → 审计
```

- `USER.md` 只接收能在用户原话中确认的长期交互指令。
- `MEMORY.md` 只接收稳定、具有跨会话价值的事实，并拒绝指令形态内容。
- 密码、密钥、验证码、token、证件和健康信息不会写入。
- 任何失败都静默结束，不修改 `ASSISTANT.md`，也不阻塞 Session 关闭。

**默认运行门槛：至少 4 条用户消息 · 同一用户冷却 30 分钟 · 最多读取最近 6000 字符转写。**

<!--
[Sources]
- server/src/conversation/memory-extractor.mjs
- server/src/conversation/frontend-memory-service.mjs
-->

---

# ConversationSync：恢复前台上下文并避免重复播报

ConversationSync 是 Gateway 内的短期会话账本，记录用户说了什么、前台答了什么、后台返回了什么，以及结果是否已经向用户表达。

<div class="two-col">

<div>

## 记录四类内容

| 时间线来源 | 内容 |
| --- | --- |
| `voice-user` | 用户最终转写 |
| `realtime-direct` | 前台直接回答 |
| `agent-result` | 后台原始结果 |
| `agent-presentation` | 已向用户表达的结果 |

</div>

<div>

## 直接解决三个问题

- **连接重建**：把最近对话重新交给 Realtime Frontstage
- **结果交付**：判断后台结果是否已经说过，避免重复注入或播报
- **记忆整理**：会话结束后向 MemoryExtractor 与 ProfileObserver 提供完整转写

</div>

</div>

**边界：它不共享后台 Agent 的内部 Session，也不保存跨会话长期记忆。**

---

# 让协作更丝滑：跨模块的边界划分与时序控制

除了核心链路的设计，语音智能体的丝滑体验往往藏在跨模块的协作细节中。

<div class="two-col compact">

<div>

### 职责边界

- 前台工具越少，实时路径越稳定
- Gateway 管事实，模型管表达
- 协调会话和执行 Session 分开
- 事实记忆和行为偏好分开
- 权限绑定用户身份与 Session

</div>

<div>

### 时序控制

- receipt 不等待后台完成
- transcript 关联不阻塞回执
- 委派后立即释放协调槽
- 结果等到自然窗口再播报
- 播放开始才确认交付

</div>

</div>

> 架构优化目标不是局部最短延迟，而是端到端的连续对话、可控执行与可靠恢复。

---

# 总结：七项架构设计原则

1. **用异步协议连接不同时间尺度。**
2. **Gateway 管系统事实，模型管理解与表达。**
3. **协调 Session 维持连续性，独立 Session 承担长任务执行。**
4. **后台任务完成不等于结果已交付，交付需要独立调度与确认。**
5. **记忆按权威分层，个性化不能突破安全边界。**
6. **跨会话能力必须可查询、可取消、可恢复、可审计。**
7. **局部失败不能让主对话失去可用性。**

> 最终目标：让用户感知到一个持续在线、可靠做事、自然交付结果的语音助手。
