# Qwen Audio Agent X-Omni 示例

[English](README.md) | 中文

基于 Qwen3.5 Omni Realtime 的独立多模态对话示例：围绕摄像头、共享屏幕或图片
自然交流，也可以明确要求它关注画面条件、解说变化，同时继续聊天。
视觉工具、采集策略和观察调度均放在本示例中，不写入标准桌面端或网关全局 Prompt。

## 核心能力

- **第一阶段——视觉对话：** 摄像头、屏幕和图片输入，支持持续画面与按需采集。
- **第二阶段——可选观察：** 有时限的条件提醒和变化解说，支持取消、去重、超时与并发限制。
- **复用对话链路：** 使用现有 WebUI 语音 Hook 与 Gateway Client Protocol，复用音频、打断、播放回执和客户端动作。
- **可选后台：** 截图获得普通 `input_N` 引用，可由 `spawn_thinking` 交给已安装的后台；观察功能本身不需要后台。

## 快速开始

使用源码仓库及 `.nvmrc` 指定的 Node.js 版本，在仓库根目录运行：

```bash
npm ci
cp examples/x-omni/.env.example examples/x-omni/.env.local
```

在该文件填写 `DASHSCOPE_API_KEY`，然后启动：

```bash
npm run example:x-omni
```

打开 **http://127.0.0.1:5178**。示例启动独立的本机 Gateway，端口 **18890**。
默认配置、状态和记忆保存在被 Git 忽略的 `examples/x-omni/.runtime/`，
不连接桌面版 Gateway。显式设置的 `QWAUDIO_*` 目录仍会生效。

API Key 只留在 Node.js 进程，不进入浏览器构建产物。
支持 `qwen3.5-omni-plus-realtime`（默认）与 `qwen3.5-omni-flash-realtime`。
可选的 `QWEN_AUDIO_REALTIME_BASE_URL` 同时设置对话和视觉读取的 Omni WebSocket 地址。

默认仅前台模式（`AGENT_PROTOCOL=none`）。需要体验后台办事时，可在自行安装并配置
Qwen Code 后设置 `AGENT_PROTOCOL=qwen`。后台权限、模型选择沿用框架机制；
示例不会自动安装 Agent。

## 体验步骤

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
| `client/` | 来源授权、预览、JPEG 采集，复用 WebUI 语音运行时。 |
| `gateway.mjs` | 注册示例工具、采集动作和来源状态事件。 |
| `vision/tools.mjs` | `capture_visual`、`visual_observation`；返回简短文字与附件引用。 |
| `vision/omni-reader.mjs` | 每次检查开启短时、只输出文字的 Omni 视觉连接。 |
| `vision/observers.mjs` | 采样、事件边沿/冷却策略、取消和 Agent Delivery 通知。 |

持续画面直接进入主 Omni 会话。按需检查通过**独立视觉读取会话**获得描述，
再把文字观察交回主对话；不是将图片藏在工具结果字符串中让主模型“看见”。
读取会话发送合成静音 PCM 和一张 JPEG，再手动提交。
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
示例复用同一源码版本的 WebUI Hook 和摄像头编码器，不复制音视频传输实现。
当前使用 WebSocket，而不是 WebRTC。

## 限制、隐私与费用

- 预览在本地。按需图片、持续画面及观察采样按上述策略发送到配置的 Omni 服务。
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
```

测试使用合成画面和模拟模型回包，不需要云端 Key 或真实摄像头。
浏览器检查另需 Playwright Chromium。正式使用前还应手动验证实际云端模型行为。
