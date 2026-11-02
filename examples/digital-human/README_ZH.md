# 数字人客户端示例

[English](README.md) | 中文

一个同时连接 **qwen-audio-agent Gateway** 与**数字人服务**的本地客户端，展示如何在不定制主框架的前提下接入可替换的数字人呈现。Gateway 负责实时对话、工具和后台任务；数字人服务消费助手已生成的回复音频，驱动人物与声音，不另建 ASR / LLM / TTS 链路。

同一示例提供自部署 [OpenAvatarChat / FlashHead](https://github.com/juhayna-zh/OpenAvatarChat) 的 DHAV 接入，以及商业 [Vidu](https://platform.vidu.cn/) / ARTC 接入。这是可选示例，不是标准 WebUI 或桌面版内置的数字人功能。

## 核心能力

| 接入方式 | 可体验内容 | 播放能力 |
| --- | --- | --- |
| DHAV Mock（默认） | 无 GPU 的合成画面，验证语音、文字对话与打断 | 实际起播、排空与取消回执 |
| 自部署 DHAV / FlashHead | 将同一客户端连接到自部署数字人服务 | 实际起播、排空与取消回执 |
| 商业 Vidu / ARTC（实验） | 选择角色图片，使用供应商原生音画；需账号、额度并显式开启 | 本地打断与旧媒体隔离；无逐回复播放回执 |

浏览器与可选 Electron 浮窗共用对话、字幕、麦克风控制和数字人适配器。Mock 只模拟数字人画面；正常对话仍会调用 Gateway 配置的模型。

### 自部署 DHAV / FlashHead 演示

原作者提供的数字人对话演示。

https://github.com/user-attachments/assets/5301ef5e-b674-4561-93bb-e0c7544cf696

### 商业 Vidu / ARTC 演示

贡献者提供的原始版本演示，展示数字人外观与浮窗交互；不作为当前版本的真实服务验收记录。

https://github.com/user-attachments/assets/dc9296b5-dfbe-4243-a2c6-3bf49237d71b

## 架构边界

| 组件 | 职责与接口 | 启停方式 |
| --- | --- | --- |
| 标准 Gateway | 通过 [GCP 与公开客户端 SDK](../../docs/gateway-protocol.zh.md)提供对话、工具、后台任务及助手 PCM | 用户独立启动与关闭 |
| 本示例：浏览器 + 本地 Node 服务 | `/gateway` 代理标准 GCP；`/avatar` 转交助手音频、渲染控制与媒体凭据；浏览器播放数字人音画 | `npm start` 启动，`Ctrl+C` 退出；默认自动管理 Mock |
| 数字人服务 | DHAV 返回配对音视频帧；Vidu 返回原生 ARTC 音画 | 自部署服务由部署者管理；Vidu 会话由示例创建与释放 |

浏览器通过本地服务建立两条独立连接，核心编排位于 [useDualConnection.js](client/useDualConnection.js)，代理入口是 [server.mjs](server/server.mjs)。本地服务不是第二个 Gateway，也不保存另一份对话历史。

供应商协议、SDK 和播放实现均留在示例内，不依赖 `qwen-audio-agent-rtc`。Gateway 复用通用的播放能力协商：有真实回执的客户端报告实际播放；缺少回执时，Gateway 只推进生成侧状态，不把生成完成当作用户听完。

## 快速开始

前提：使用框架支持的 Node.js 版本（推荐 22.22.2 或 24.15.0）、npm 10+、可用的 Realtime 模型配置，以及允许播放音频和访问麦克风的现代浏览器。以下命令从本仓库源码开始；默认 Mock 不需要 GPU 或数字人服务账号。浏览器自动化使用 Chromium；真实数字人服务另有 GPU、账号及平台要求。

**Vidu 需要包含通用无回执降级的 Gateway（`761672f` 及之后版本）。对应版本发布前，请使用最新 `main` 源码，不能只更新示例或 SDK 而继续连接旧 Gateway。**

### 1. 启动标准 Gateway

终端一，在仓库根目录执行。已有模型配置可以跳过 `config`：

```bash
npm ci
node cli/bin/qwenaudio.mjs config
npm run build
npm start -- --backend none
```

模型密钥与前台服务仍按[框架快速开始](../../docs/getting-started/quickstart.zh.md)配置，不放入本示例。`--backend none` 用于先验证纯对话；需要后台任务时，按框架配置启用后台。确认端口未被旧 Gateway 占用，并断开同一用户的其他 WebUI、桌面版或 TUI。

### 2. 启动示例客户端

终端二，从仓库根目录进入示例目录：

```bash
cd examples/digital-human
npm ci
cp .env.example .env.local
npm run build:client
npm start
```

Windows PowerShell 将复制命令换为 `Copy-Item .env.example .env.local`。如需调整 Gateway 地址或切换服务，先按下一节修改 `.env.local`。

打开终端打印的地址，默认是 `http://127.0.0.1:5273`。点击“连接数字人”授权音频播放，输入“你好，介绍一下你自己”；应看到回复字幕、听到回复，并看到随声音变化的 Mock 合成画面。开启麦克风后可用语音交互；Vidu 模式连接后会请求麦克风权限。

### 3. 退出与可选浮窗

点击页面“结束”释放数字人会话，再在终端二按 `Ctrl+C` 关闭示例。Gateway 不会随之关闭；不再需要时，在终端一另行退出。Vidu 待机也可能计费，不使用时应结束会话。

可选 Electron 浮窗只打开同一页面。在示例目录的另一终端执行：

```bash
npm install --no-save --package-lock=false electron@43.8.1
npm run desktop
```

浮窗支持拖动和置顶切换；关闭浮窗不会关闭 Node 服务或 Gateway。一次只使用一个客户端收音。

## 配置与数据

配置模板为 [.env.example](.env.example)。**Shell 环境变量优先于 `.env.local`，最后使用代码默认值**；修改后重启示例。示例不修改用户的 Gateway 配置。

| 配置 | 要求与默认值 |
| --- | --- |
| `DH_GATEWAY_URL` / `DH_GATEWAY_TOKEN` | 默认 `ws://127.0.0.1:18888/api/realtime`；Gateway 开启鉴权时填写令牌 |
| `DH_CLIENT_PORT` | 可选，默认 `5273`；仅监听本机回环地址 |
| `DH_RENDERER_ADAPTER` | 默认 `dhav`；可选已注册的 `vidu` |
| `DH_RENDERER_URL` / `DH_RENDERER_TOKEN` | DHAV 专用；URL 留空自动启动 Mock，自部署时填写服务地址及其所需令牌 |
| `DH_PERSONA` | 默认 `mock-default`；自部署 FlashHead 示例使用 `flashhead-default` |
| `VIDU_EXPERIMENTAL` | 默认 `0`；接受实验限制及费用后设为 `1` |
| `VIDU_API_KEY` / `ARTC_APP_ID` / `ARTC_APP_KEY` | Vidu 必填，分别为有效的组件版 Key 和同一 ARTC 应用的 ID / Key；模板中的 `vda_replace_me` 必须替换 |
| `VIDU_HOST` | 默认 `api.vidu.cn`；海外账号使用 `api.vidu.com`，需与 Key 匹配 |
| `DH_MOCK_FAULT` | 测试用故障注入，正常运行留空；可选值见模板 |

切换自部署服务的完整条件见[适配器契约](docs/provider-contract.zh.md)；商业服务的权限申请、配置和费用边界见 [Vidu 指南](docs/vidu.zh.md)。可选浮窗的 `DH_DESKTOP_URL` 与 `DH_ORB_LAUNCH` 从启动它的 Shell 读取，不读取 `.env.local`；后者默认不启用，仅接受本机操作者提供的启动参数。

- **外发数据**：麦克风和文字交给 Gateway 及其配置的模型；数字人服务接收助手回复音频。Vidu 还接收所选角色图片或图片 URL，浏览器从供应商加载 ARTC SDK 并接收媒体。
- **凭据边界**：Gateway 令牌、Vidu Key 和 ARTC AppKey 保留在本地 Node 服务；浏览器仅接收播放所需的短期 RTC 凭据。不要把长期密钥写入前端代码或 Vite 变量。
- **本地状态**：`.env.local` 保存示例配置；浏览器 `localStorage` 保存 Session ID，刷新后可复用。示例不另存服务端对话、音频或角色图片文件；对话记录由 Gateway 管理。Electron 的配置与缓存位于 `.desktop/`。
- **清理**：退出示例后，可删除 `.env.local`、`.desktop/` 并清除该站点的浏览器数据；`dist/` 是可重建的前端产物。Gateway 记录需单独管理，删除本地文件不会删除供应商保留的数据或取消已有账单。

## 验证与限制

在示例目录执行：

```bash
npm test
npm run build:client
npx playwright install chromium
npm run test:browser
npm run test:browser:vidu
```

预期测试与构建通过。测试覆盖协议编解码、连接、取消隔离、播放回执和安全边界；浏览器测试使用假的 Gateway、厂商 SDK 和本地媒体流，不调用真实模型或付费服务。具体记录见[验证记录](docs/presentation-validation.zh.md)，真实部署检查见[验收清单](docs/implementation-plan.zh.md)。

- **助手回复音频（数字人输入）**：目前只接受 PCM16 little-endian、24 kHz、单声道；其他采样率会被拒绝，不会隐式按错误速率播放。此限制不指用户麦克风的采集格式。
- **DHAV**：以实际起播、排空和取消产生回执；首次起播前失败可回退原声一次，开始后不从头重播。真实 FlashHead 的 GPU 性能和音画同步需部署者验证。
- **待机动画（DHAV）**：回复结束或被取消后，适配器继续用静音维持一个待机轮次，画面保持动作而不是停在最后一帧。这些帧带 `idle` 标记，直接画到 canvas，不进音频队列、不占播放时间轴、也不产生播放回执；真实回复在同一条有序控制通道上顶掉它。待机轮次失败只按退避有限重启，不会拖垮会话。仅当 provider 声明 `capabilities.idle` 时启用，Vidu 不受影响。代价是只要浏览器连着，渲染器就持续产帧（约 25 fps），自部署 GPU 需据此评估负载。
- **Vidu**：默认关闭，本版尚未完成真实服务验收。原生音画由同一媒体元素播放；打断立即停止本地旧媒体，并让下一条有效回复使用新的 live / RTC channel，增加重连延迟和可能的费用。
- **无播放回执的边界**：Vidu 不提供逐回复播放结束与远端打断完成确认，示例不估算或伪造回执。普通对话可显示生成字幕；自动后台结果通知保持待投递，可通过语音或文字主动查询任务。本例没有完整任务卡片或权限管理 UI。
- **故障与范围**：Vidu 故障会停止收音并要求重连，不自动重播；输入与排队有界。示例为本机单客户端集成，不是多租户生产服务，不能直接将本地凭据代理暴露到公网。其他浏览器、长期运行和商业 RTC 网络行为仍需真实环境验证。

## 替换扩展

- **自部署 DHAV**：设置 `DH_RENDERER_ADAPTER=dhav`、服务 URL / Token 和 `DH_PERSONA`。服务需实现会话创建与释放、输入 / 媒体 WebSocket 及 DHAV v1 音视频帧，部署参考 [OpenAvatarChat / FlashHead](https://github.com/juhayna-zh/OpenAvatarChat)。不是任意数字人 HTTP 地址都能直接接入。
- **商业 Vidu**：设置 `DH_RENDERER_ADAPTER=vidu` 与上述凭据，显式开启实验开关；共用同一启动命令和页面，详见 [Vidu 指南](docs/vidu.zh.md)。
- **新增服务**：在 [server/renderers/](server/renderers/) 实现鉴权、服务会话及音频转交，在 [client/renderers/](client/renderers/) 实现媒体播放与能力声明；分别在[服务端注册表](server/renderers/index.mjs)和[浏览器注册表](client/renderer-adapters.mjs)注册同名适配器。接口见[适配器契约](docs/provider-contract.zh.md)。需要供应商适配代码，不要求改 Gateway 或将原生 RTC 转成 DHAV。
- **恢复默认**：改回 `DH_RENDERER_ADAPTER=dhav`、`DH_PERSONA=mock-default`，清空 `DH_RENDERER_URL` / `DH_RENDERER_TOKEN`，设置 `VIDU_EXPERIMENTAL=0` 后重启；同时检查是否存在覆盖这些值的 Shell 环境变量。

如单独复制本目录，需额外 `npm install qwen-audio-agent` 获取公开客户端 SDK，再构建页面；Gateway 仍须独立运行，并满足前述版本要求。

## 作者与致谢

- [Haina Zhu（@juhayna-zh）](https://github.com/juhayna-zh)：原始数字人示例、DHAV 协议、Mock 渲染器、FlashHead 接入、角色界面及演示视频。
- [@zzasdf](https://github.com/zzasdf)：Vidu / ARTC 接入、桌面浮窗、角色图片交互及演示视频。

上游服务与依赖：[OpenAvatarChat / FlashHead](https://github.com/juhayna-zh/OpenAvatarChat)、[Vidu](https://platform.vidu.cn/) 与[阿里云 ARTC](https://help.aliyun.com/zh/live/activate-application)。演示素材保留贡献者署名；上述引用不表示获得服务方官方背书。
