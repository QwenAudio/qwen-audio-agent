# Qwen Audio Agent X-Omni 示例

[English](README.md) | 中文

基于 qwen-audio-agent 的实时多模态交互参考实现，通过框架的 Gateway 与 Realtime
Provider 接口，提供视觉对话、按需识图，以及用户主动开启的视觉观察能力。

Qwen3.5 Omni 是默认配置，而非客户端架构的限定。面壁 MiniCPM-o 可通过已有适配器
进行持续视听对话；其他 Omni 服务可根据其传输协议与工具能力扩展接入。
视觉工具、采集策略和观察调度均位于本示例内，不写入标准客户端或网关全局 Prompt。

## 核心能力

- **视觉对话：** 摄像头、屏幕和图片输入，支持持续画面与按需采集。
- **可选观察：** 有时限的条件提醒和变化解说，支持取消、去重、超时与并发限制。
- **可选传输：** 同一界面可使用 WebSocket 或 WebRTC，复用 Gateway 的对话、打断、播放回执和客户端动作。
- **可选后台：** 截图获得普通 `input_N` 引用，可由 `spawn_thinking` 交给已安装的后台；观察功能本身不需要后台。

## 模型兼容性

| 前台服务 | 持续视听对话 | 按需识图 / 视觉观察 | 验证范围 |
| --- | --- | --- | --- |
| Qwen3.5 Omni Realtime | 支持 | 通过示例内置的 DashScope 视觉读取器支持 | Plus 已通过真实服务验证；有协议与浏览器自动化测试 |
| 面壁 MiniCPM-o 4.5 | 使用 `mode=video` 时支持 | 当前公开 Realtime 接口不支持 | 有协议与浏览器自动化测试；实际部署的推理效果需另行验证 |
| 其他 Omni 服务 | 需要支持图像缓冲输入的 Gateway 适配器 | 需要结构化工具调用、主动触发回复及对应视觉读取器 | 不作已验证声明 |

MiniCPM-o 当前适配接口未提供结构化工具调用与主动触发回复能力，因此示例会禁用
文字输入、按需识图和观察控件，不模拟这些能力，也不会自动回退到云端服务。
详见 [MiniCPM-o 接入指南](../../docs/voice-frontends/minicpm-o.zh.md)。

Qwen 配置支持 `qwen3.5-omni-plus-realtime`（默认）和
`qwen3.5-omni-flash-realtime`。Flash 使用同一适配器；此处记录的真实服务验证针对 Plus。

## 快速开始

使用源码仓库及 `.nvmrc` 指定的 Node.js 版本，在仓库根目录运行：

```bash
npm ci
cp examples/x-omni/.env.example examples/x-omni/.env.local
```

使用默认 Qwen 配置时，在 `.env.local` 填写：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
QWEN_AUDIO_REALTIME_MODEL=qwen3.5-omni-plus-realtime
DASHSCOPE_API_KEY=your-key
AGENT_PROTOCOL=none
```

启动示例：

```bash
npm run example:x-omni
```

打开 **http://127.0.0.1:5178**。示例启动独立的本机 Gateway，端口 **18890**。
默认配置、状态和记忆保存在被 Git 忽略的 `examples/x-omni/.runtime/`，
不连接桌面版 Gateway。显式设置的 `QWAUDIO_*` 目录仍会生效。

凭据只留在 Node.js 进程，不进入浏览器构建产物。使用 DashScope 时，可选的
`QWEN_AUDIO_REALTIME_BASE_URL` 同时设置对话和视觉读取的 WebSocket 地址。

### 选择 WebRTC

默认启动命令使用 WebSocket。使用同一份 Qwen 配置，停止当前示例后运行：

```bash
npm run example:webrtc:install  # 仅首次安装可选媒体依赖
npm run example:x-omni:webrtc
```

访问地址仍是 **http://127.0.0.1:5178**，界面会显示当前传输方式。
按需识图、持续画面、观察提醒与后台调用共用同一套实现，不需要另配模型。
切换传输需要重启示例并刷新页面；不会自动回退，也不会同时占用两条对话连接。

当前 WebRTC 入口支持 **Qwen Omni**；MiniCPM-o 请使用默认 WebSocket 命令。
这只切换客户端与 Gateway 之间的传输，Gateway 到模型仍使用现有 Provider 连接。
WebRTC 已覆盖合成媒体与模拟模型的真实浏览器测试；不代表已验证公网稳定性或真实模型效果。
远程使用需要 HTTPS、可达媒体端口，必要时配置 STUN/TURN；仅 HTTP 反向代理不够。
详见 [WebRTC 部署说明](../../docs/gateway-webrtc-client.zh.md)。

### MiniCPM-o 配置

先按 [官方部署说明](https://github.com/OpenBMB/MiniCPM-o-Demo) 安装并启动 MiniCPM-o，
再将 `.env.local` 中的前台配置替换为：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=minicpm-o
MINICPM_O_REALTIME_URL=ws://127.0.0.1:8006/v1/realtime?mode=video
AGENT_PROTOCOL=none
# MINICPM_O_AUTH_TOKEN=your-token
```

地址以实际部署为准；上述本机地址假设服务在回环地址以 HTTP 模式启动。
服务要求认证时再配置 `MINICPM_O_AUTH_TOKEN`，无需 DashScope Key。
使用同一启动命令，选择视觉来源并开启麦克风，客户端会自动采用**持续画面**模式。
示例不负责模型推理服务的安装、启动和进程管理。

### 可选后台

默认仅前台模式（`AGENT_PROTOCOL=none`）。需要体验后台办事时，可在自行安装并配置
Qwen Code 后设置 `AGENT_PROTOCOL=qwen`。后台权限、模型选择沿用框架机制；
示例不会自动安装 Agent。

## 使用方式

以下步骤针对功能完整的 Qwen 配置。使用 MiniCPM-o 时，可选择来源并进行持续视听对话，
不支持依赖工具的步骤和文字请求。

1. 选择**摄像头**、**共享屏幕**或**打开图片**，仅授权你想观察的来源。
2. 使用**按需采集**，输入“看看当前画面里有什么”，或开启麦克风后说话。
   仅预览不会上传画面。
3. 切到**持续画面**并开启麦克风，每秒向主 Omni 会话发送一帧，与其音频时间线关联。
4. 说“关注这个进度条两分钟，完成后告诉我”，或“接下来一分钟，讲解画面中有意义的变化”。
5. 说“停止观察”、点击**停止所有观察**，或关闭视觉来源。
   用**查看观察状态**确认实际运行或失败状态。
6. 配好后台后，可以尝试“读取当前屏幕，把截图交给后台分析这个报错”。

共享屏幕取决于浏览器支持及系统权限，建议先用桌面 Chrome/Edge 访问 localhost；
这不是打包后的桌面版或手机 App。静音麦克风不会取消用户已开启的视觉观察。
关闭/切换来源、切换采集模式、断开页面或退出示例都会取消观察。
刷新页面会新建对话。

## 架构与边界

| 组件 | 职责 |
| --- | --- |
| `client/` | 共用界面、来源授权与采集；WebSocket 复用 WebUI Hook，WebRTC 使用轻量 Hook 适配。 |
| `gateway.mjs` | 解析所配置的 Provider，注册其支持的示例工具、采集动作和来源状态事件。 |
| `vision/features.mjs` | 宿主与 UI 共用的能力判断规则。 |
| `vision/tools.mjs` | `capture_visual`、`visual_observation`；返回简短文字与附件引用。 |
| `vision/dashscope-reader.mjs` | 供应商专属视觉读取器，每次检查开启短时、只输出文字的 Qwen Omni 连接。 |
| `vision/observers.mjs` | 采样、事件边沿/冷却策略、取消和 Agent Delivery 通知。 |

持续画面通过 Gateway 配置的 Realtime 适配器进入主对话。
Qwen 配置下的按需检查通过**独立视觉读取会话**获得描述，
再把文字观察交回主对话。主模型收到的是文字工具结果，原始图片由视觉读取器处理，
并登记为附件。读取会话发送合成静音 PCM 和一张 JPEG，再手动提交。
它不会改动主会话的 VAD，也不会提交用户正在录制的麦克风音频。
参见官方 [Omni 客户端事件](https://help.aliyun.com/zh/model-studio/client-events)。

观察复用这个视觉读取器，不占用后台协调 Session。通知进入现有 Agent Delivery
回复队列，对话仍遵循原有轮次/打断机制。排队中的通知会在生成回复前检查取消及过期；
已经开始播放的语音无法追溯撤回。

主框架只补充通用宿主扩展：

- `createGatewayApplication({ frontendToolSources, clientActionNames })`。
- 工具来源遵循现有 `describe/initialize/tools/execute/health/close` 生命周期。
  `execute(name, args, context)` 获得连接级 `signal`、身份、`turnId`、`isCurrent()`、
  `supportsClientAction()`、`requestClientAction()`、`registerInputs()` 和 `deliver()`。
- 浏览器声明 `client.actions.xomni.visual.capture`，响应 `client.action.request`；
  `xomni.visual.state` 仅同步上下文，不触发播报。

没有向全局 Prompt、协议事件枚举或后台 Adapter 加入视觉业务。
示例复用同一源码版本的 WebUI Hook、摄像头编码器，以及 WebRTC 示例共用的
`shared/gateway/webrtc-browser.mjs` 浏览器连接。视觉业务不进入通用传输层。

| 链路 | WebSocket | WebRTC |
| --- | --- | --- |
| 语音 | PCM 消息 | 音频轨道 |
| 持续画面 | 每秒一张 JPEG | 采集帧进入 Canvas 视频轨道，Gateway 每秒最多抽一帧 |
| 文本、来源状态和采集动作 | Gateway Client Protocol 消息 | DataChannel 承载相同的网关命令与事件 |
| 按需截图结果 | 客户端动作结果 | 同一结果，经有大小/时限限制的分片回传 |

仅预览不会发送视频；退出持续模式会移除发送轨道并清空待处理画面。
麦克风静音保留连接和音频播放，也不取消用户主动开启的视觉观察。

### 接入其他 Omni 服务

复用或实现框架的 Realtime Provider 适配器，并准确声明模型与传输能力。
持续视觉沿用 Gateway 的 `input_image_buffer.append` 消息，供应商适配器负责转换
实际传输格式。仅修改模型名不能使不兼容的 API 自动可用。

如需工具驱动的识图与观察，在 `vision/` 内增加提供
`read(frame, question, { signal, structured })` 与 `close()` 的读取器。
普通读取返回文字，结构化读取返回 `{ match: boolean, summary: string }`。
在 `gateway.mjs` 中接入，并在验证主前台的工具调用和主动回复能力后更新
`vision/features.mjs`。采集与调度保持供应商无关；不要将新协议写入 UI，
也不要将 DashScope 读取器直接连接到不兼容的接口。

## 限制、隐私与费用

- 预览在本地。按需图片、持续画面及观察采样按上述策略发送到配置的服务。
  MiniCPM-o 模式只向其配置地址发送画面，不创建 DashScope 读取连接。
- 视觉读取会产生**额外推理费用和延迟**。最多同时两个推理请求、两个观察；
  首次采样后每 10 秒采样，默认 120 秒，可设置 10–600 秒。不做无限重试或重连。
- 条件默认只提醒一次。重复提醒需要条件从不满足变为满足，且间隔至少 20 秒。
  解说过滤相同摘要，并提示模型仅报告有意义的变化，但不能保证语义去重。
- 来源变化、画面过期、结构化结果无效或推理失败时停止该观察。
  可查看观察状态，再明确重新启动。
- JPEG 限制为 190 KiB。示例不将截图写入磁盘，附件引用保存在网关内存中；
  文字对话和观察结果可能进入正常会话历史。后台收到图片后可能按其自身逻辑保存。
- 不提供音频观察、录像、安全告警、自动电脑控制或未授权来源访问。
  定时采样可能错过短暂事件，模型判断也可能出错。
- 浏览器与网关部署在不同主机时需保持时钟同步，过期采集时间戳会被拒绝。
  远程部署还需要 HTTPS，以及框架的认证和来源配置。

## 开发验证

```bash
npm run test:x-omni
npm run example:x-omni:build
npx eslint examples/x-omni
npx playwright install chromium
npm run test:x-omni-browser
npm run example:webrtc:install
npm run test:x-omni-webrtc
```

测试使用合成画面和模拟模型回包，不需要云端 Key 或真实摄像头。
浏览器检查另需 Playwright Chromium，覆盖 Qwen 采集/工具完整链路，以及 MiniCPM-o
视频传输和不支持控件的禁用行为。这些测试验证集成链路，不代表模型感知质量；
部署前仍需验证实际服务与所选模型。
WebRTC 测试使用真实 PeerConnection、DataChannel 和独立媒体进程，覆盖截图分片、
音频播放回执、持续画面、静音、观察取消及显式重连。CI 在 Linux 基线任务运行。
