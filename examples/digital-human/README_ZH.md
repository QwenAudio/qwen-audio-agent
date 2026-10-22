# 数字人客户端示例

[English](README.md) | [中文](README_ZH.md)

一个普通语音 Agent 客户端，同时连接 **qwen-audio-agent Gateway** 和**可替换的数字人服务**。Gateway 负责理解、对话和工具；数字人服务只消费助手回复音频，负责呈现人物与声音，不再运行一套 ASR / LLM / TTS。

本示例不修改框架运行时、SDK、GCP 或框架依赖，也不依赖 qwen-audio-agent-rtc。可以在仓库中运行，也可以复制本目录后使用官方 npm 包的公开 Client SDK，连接普通 Gateway。

## 演示

下面是原始 DHAV / FlashHead 实现的演示素材；本次客户端重构仍需使用真实 GPU 服务重新部署验收。

https://github.com/user-attachments/assets/5301ef5e-b674-4561-93bb-e0c7544cf696

## 连接方式

| 连接 | 数据 | 职责 |
| --- | --- | --- |
| 浏览器 ↔ Gateway | 标准 GCP：麦克风、文本、助手 PCM、响应事件、播放回执 | 对话与任务 |
| 浏览器 ↔ 数字人适配器 | 助手 PCM、渲染控制、媒体或短期 RTC 凭据 | 数字人呈现 |

示例本地服务代理第一条连接，并保护第二条连接的厂商密钥。它不是另一个 Gateway，不改变 GCP 消息，也不保存另一份对话历史。

- **已提供**：DHAV 适配器、本地无 GPU 的合成画面 Mock、连接自部署 DHAV 服务的配置。
- **扩展位置已提供**：商业服务适配器可以直接播放厂商 RTC 媒体，无须转换为 DHAV；当前版本未包含 Vidu 商业适配器，也未执行付费服务验证。
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
2. `client/renderers/`：接收媒体、调用厂商播放器、上报真实播放开始 / 排空 / 错误。

在服务端和浏览器注册同名适配器，通过 `DH_RENDERER_ADAPTER` 选择。配置只能选择已注册实现，不能从浏览器传入任意 URL 或加载任意模块。

自部署 DHAV 用 WebAudio + canvas 播放 PCM / I420；#570 的 Vidu / ARTC 路径可将其商业组件控制和 RTC 播放迁入这两个位置。**不用改 Gateway，也不用把 RTC 媒体再转成 DHAV。** 具体接口和迁移对照见 [适配器契约](docs/provider-contract.zh.md)。

## 播放与打断

- 收到第一块真实助手音频才创建渲染轮次；纯文本和工具调用不会产生假播放。
- 使用现有 `audio.delta`、`audio.done` 和全量 `playback.clear`；`audio.done` 仅结束渲染输入，必须等数字人媒体和浏览器播放队列排空才发 `playback.ended`。
- 播放回执由真实可听播放驱动，不使用静音音轨或定时器模拟已播放。
- 用户打断、新会话、连接关闭会清理队列，隔离旧 response / generation 的迟到媒体。
- 首次播放前渲染失败可回退原音频一次；已经开始数字人播放后失败，取消本轮而不是从头重播。
- 麦克风静音只停止收音，不停止助手输出；队列与网络缓冲均有上限。

普通 Gateway WebSocket 输出不提供精确的模型执行终态，`audio.done` 不能证明模型成功。通用 `error` 只用于提示，不从错误文案猜测某条回复失败或取消。本例不要求响应终态或定向清理扩展。

## 安全与范围

本例默认仅监听回环地址，并校验 Host / WebSocket Origin。Gateway 访问令牌和厂商长期密钥只保留在本地 Node 进程；商业 RTC 必需的短期播放凭据可由适配器下发浏览器。不要把长期密钥放进 Vite 环境变量或前端代码。

本例是单客户端演示，不是多租户生产服务。远程部署需要 HTTPS、访问认证、会话配额和相应 Origin 策略，不能直接对公网暴露此本地凭据代理。

## 测试与部署验收

```bash
npm test
npm run build:client
npx playwright install chromium
npm run test:browser
```

测试覆盖协议编解码、Mock / 真实本地 WebSocket、取消隔离、两轮独立时间线、播放回执、安全边界及不同媒体适配器。浏览器测试不使用真实模型或付费 API。

真实服务验收清单见 [部署验证](docs/implementation-plan.zh.md)。自动化通过不等于已完成 FlashHead / 商业服务的部署验收。

## 致谢

感谢 [Haina Zhu (@juhayna-zh)](https://github.com/juhayna-zh) 实现原始数字人示例、DHAV 协议、Mock 渲染器、FlashHead 接入及角色界面。本次保留并重用这些实现，调整客户端与框架的责任边界。商业服务的扩展边界同时参考了 @zzasdf 的 Vidu 示例设计。
