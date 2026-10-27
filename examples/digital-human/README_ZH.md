# 数字人客户端示例

[English](README.md) | [中文](README_ZH.md)

一个普通语音 Agent 客户端，同时连接 **qwen-audio-agent Gateway** 和**可替换的数字人服务**。Gateway 负责理解、对话和工具；数字人服务只消费助手回复音频，负责呈现人物与声音，不再运行一套 ASR / LLM / TTS。

本示例不修改框架运行时、SDK、GCP 或框架依赖，也不依赖 qwen-audio-agent-rtc。可以在仓库中运行，也可以复制本目录后使用官方 npm 包的公开 Client SDK，连接普通 Gateway。

## 演示

下面是原始 DHAV / FlashHead 演示，保留在线播放链接及[本地素材](assets/digital-human-demo.mp4)。

https://github.com/user-attachments/assets/5301ef5e-b674-4561-93bb-e0c7544cf696

[Vidu 旧版浮窗演示](assets/digital_human_demo_vidu.mp4)展示外观与交互，不代表当前改造已经完成真实服务验收。

## 连接方式

| 连接 | 数据 | 职责 |
| --- | --- | --- |
| 浏览器 ↔ Gateway | 标准 GCP：麦克风、文本、助手 PCM、响应事件；有能力时提供播放回执 | 对话与任务 |
| 浏览器 ↔ 数字人适配器 | 助手 PCM、渲染控制、媒体或短期 RTC 凭据 | 数字人呈现 |

示例本地服务代理第一条连接，并保护第二条连接的厂商密钥。它不是另一个 Gateway，不改变 GCP 消息，也不保存另一份对话历史。

- **已提供**：DHAV 适配器、本地无 GPU 的合成画面 Mock、连接自部署 DHAV 服务的配置。
- **Vidu 实验适配器**：保留原生 ARTC 音画播放，支持本地立即打断和旧会话隔离；不协商 `playback.receipts`，也不发送播放回执。逐回复播放完成边界仍缺失，默认关闭，PR 保持 Draft。见 [Vidu 配置及限制](docs/vidu.zh.md)。
- **当前音频范围**：PCM16 little-endian、24 kHz、单声道。其他采样率会明确拒绝本轮，不隐式按错误速率播放。

## 快速开始

### 1. 启动标准 Gateway

使用已安装框架的常规配置启动 Gateway，例如：

```bash
qwenaudio gateway --backend none
```

模型密钥、Realtime 服务、后台 Agent 都在 Gateway 配置；不放入本例。后台可按需要启用。本示例不会启动、修改或关闭用户已有 Gateway。

无需数字人专用 Gateway 分支或协议补丁。

### 2. 安装并启动客户端

要求 Node.js ≥ 22.22.2。仓库内：

```bash
cd examples/digital-human
npm ci
cp .env.example .env.local
npm run build:client
npm start
```

如果单独复制了本目录，在构建前额外安装公开 SDK 所在的官方包：

```bash
npm install qwen-audio-agent
```

打开终端打印的地址（默认 `http://127.0.0.1:5273`），点击“连接”，再开启麦克风或输入文字。浏览器必须先得到用户的音频播放授权。

`DH_RENDERER_URL` 留空时自动使用 Mock：显示随声音变化的合成画面，不下载模型、不需要 GPU。正常对话仍会调用用户配置的模型；自动化测试使用假的 Gateway，不调用真实模型。

### 3. 使用自部署数字人服务

在 `.env.local` 设置：

```dotenv
DH_GATEWAY_URL=ws://127.0.0.1:18888/api/realtime
DH_GATEWAY_TOKEN=
DH_RENDERER_ADAPTER=dhav
DH_RENDERER_URL=http://your-renderer-host:port
DH_RENDERER_TOKEN=your-renderer-token
DH_PERSONA=flashhead-default
```

DHAV 服务需提供：

- `POST /v1/avatar/sessions`：创建会话，返回独立输入 / 媒体 WebSocket 及短期令牌。
- 输入通道：接收 start / finish / cancel 和 PCM 数据。
- 媒体通道：返回 DHAV v1 配对音视频帧及媒体结束记录。
- `DELETE /v1/avatar/sessions/:id`：释放会话。

原作者提供的 [OpenAvatarChat / FlashHead 服务](https://github.com/juhayna-zh/OpenAvatarChat) 是部署参考。服务端保留原 DHAV 协议；本次变动将播放搬到示例浏览器，不要求它支持 Gateway GCP。模型权重、GPU 环境和服务部署请遵循该项目说明，真实环境需由部署者验证。

## 更换数字人服务

服务适配分为两个位置，均在本示例内：

1. `server/renderers/`：厂商鉴权、创建 / 关闭服务会话、音频转交、短期媒体凭据。
2. `client/renderers/`：接收媒体、调用厂商播放器；DHAV 回报实际播放，Vidu 独立展示。

在服务端和浏览器注册同名适配器，通过 `DH_RENDERER_ADAPTER` 选择。配置只能选择已注册实现，不能从浏览器传入任意 URL 或加载任意模块。

自部署 DHAV 用 WebAudio + canvas 播放 PCM / I420；Vidu 已在这两个位置注册，复用 `useDualConnection`。DHAV 的 `AvatarPlaybackController` 与真实播放回执不变，Vidu 的原生 RTC 播放留在适配器内。**不用改 Gateway，也不用把 RTC 媒体再转成 DHAV。** 具体接口和能力限制见 [适配器契约](docs/provider-contract.zh.md)。

## Vidu 与桌面浮窗

同一 `.env.local` 设置 `DH_RENDERER_ADAPTER=vidu` 及 Vidu/ARTC 凭证；只有显式设置 `VIDU_EXPERIMENTAL=1` 才允许预览，步骤见 [Vidu 指南](docs/vidu.zh.md)。共用 `npm run build:client`、`npm start` 和同一浏览器页面。live 待机期间也可能计费；打断会关闭旧 live/RTC channel，下一条有效回复才创建新的连接，因此会增加重连延迟，也可能增加供应商会话费用。点击“结束”释放当前会话。

可选浮窗只打开已运行的同一页面，安装 Electron 后在另一终端执行：

```bash
npm install --no-save --package-lock=false electron@43.8.1
npm run desktop
```

浮窗共用页面的对话、图片上传和播放控制，可拖动顶部，默认不置顶，顶部“置顶 / 取消置顶”可随时切换；关闭浮窗不会关闭 Gateway 或示例服务。Shell 环境变量 `DH_DESKTOP_URL` 可设置其他本机 HTTP 地址。原悬浮球仍是独立 UI 选项；一次仅用一套 UI 采集麦克风。

要启用“切换悬浮球”按钮，可在启动浮窗的 Shell 设置 `DH_ORB_LAUNCH` 为本机操作者提供的 JSON argv 数组，如 `["npm","run","desktop","--prefix","/path/to/source-checkout"]`；不设时不执行外部启动命令。页面不能指定命令，启动不经过 Shell。

## 播放与打断

- DHAV：`audio.done` 只结束渲染输入；实际媒体开始、排空和取消产生回执。首次起播前失败可回退原声一次，开始后不会从头重播。
- Vidu：返回音视频使用同一原生媒体元素播放；不再创建静音源播放器或原声对照模式，不做波形匹配或完成时间估算。
- Vidu 不协商 `playback.receipts`，不发送 `playback.started/ended/cancelled`。`audio.done` 不能证明数字人已说完，因此当前预览不支持可靠的任务播报与交付确认。
- 用户打断时，本地立即静音、暂停并解绑旧 RTC 媒体；适配器发送远端 interrupt 并挂断旧 live，不等待远端确认才停播。
- 下一条有效回复使用新 epoch、live 和 RTC channel，旧回调和迟到媒体不能进入新播放。数字人故障会明确报错并停止收音，需重连；不自动重播音频。
- 麦克风静音只影响采集；结束和新会话会释放数字人资源。输入与排队有界。

普通 `audio.done` 不证明模型执行成功，通用错误也不用于猜测模型终态。本例不提供听到位置反馈或模型上下文截断。

## 安全与范围

Vidu 默认关闭，PR 保持 Draft。关闭回执能力只是停止上报无法证实的状态，不是补齐供应商能力；逐回复播放边界和真实服务验收仍阻塞正式合并。详见[PR 说明](docs/pr-description.zh.md)与[音频流程](docs/audio-processing-flow.zh.md)。

本例默认仅监听回环地址，并校验 Host / WebSocket Origin。Gateway 访问令牌和厂商长期密钥只保留在本地 Node 进程；商业 RTC 必需的短期播放凭据可由适配器下发浏览器。不要把长期密钥放进 Vite 环境变量或前端代码。

本例是单客户端演示，不是多租户生产服务。远程部署需要 HTTPS、访问认证、会话配额和相应 Origin 策略，不能直接对公网暴露此本地凭据代理。

## 测试与部署验收

```bash
npm test
npm run build:client
npx playwright install chromium
npm run test:browser
npm run test:browser:vidu
```

测试覆盖协议编解码、Mock / 真实本地 WebSocket、取消隔离、两轮独立时间线、播放回执、安全边界及不同媒体适配器。浏览器测试不使用真实模型或付费 API。

Vidu 浏览器测试使用假厂商 SDK 和本地 MediaStream，检查不发送播放回执、原生媒体播放、
本地打断、旧媒体隔离、故障和重连。CI 同时运行 DHAV 与 Vidu 浏览器测试；本次结果待验证，
这些测试不能替代商业 RTC 网络、实际音画同步与长时间稳定性的真实验收。

真实服务验收清单见 [部署验证](docs/implementation-plan.zh.md)。自动化通过不等于已完成 FlashHead / 商业服务的部署验收。

## 致谢

感谢 [Haina Zhu (@juhayna-zh)](https://github.com/juhayna-zh) 实现原始数字人示例、DHAV 协议、Mock 渲染器、FlashHead 接入及角色界面。本次保留并重用这些实现，调整客户端与框架的责任边界。商业服务的扩展边界同时参考了 @zzasdf 的 Vidu 示例设计。
