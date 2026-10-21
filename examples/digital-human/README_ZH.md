# 数字人示例

[English](README.md) | 中文

基于 Qwen Audio Agent 的数字人示例，集中提供 DHAV Mock/FlashHead 与 Vidu S2 Avatar
组件版两种接入方式。Realtime Provider 负责语音和对话，数字人服务负责渲染；两种方式
的代码、配置模板和演示视频均位于本目录，按需要选择其中一种运行。

## 核心能力

| 方案 | 已实现能力 | 入口 |
| --- | --- | --- |
| DHAV Mock | 无需 GPU 的音频频谱视频，验证真实语音、WebRTC 与音视频调度 | [运行指南](docs/dhav.zh.md) |
| DHAV FlashHead | 对接自部署 GPU 渲染服务，浏览器接收音频与头像视频，支持打断和音频降级 | [服务部署与配置](docs/dhav.zh.md#33-部署-flashhead-渲染服务) |
| Vidu / ARTC | 云端渲染、默认角色或自选图片、浏览器和可拖动桌面浮窗，可切换回原悬浮球 | [Vidu 指南](vidu/README_ZH.md) |

### 演示视频

原有数字人演示（DHAV/FlashHead 接入指南对应的已有素材）：

https://github.com/user-attachments/assets/5301ef5e-b674-4561-93bb-e0c7544cf696

[观看或下载数字人演示](assets/digital-human-demo.mp4)

Vidu 桌面数字人：

<video src="assets/digital_human_demo_vidu.mp4" controls width="100%"></video>

[观看或下载 Vidu 演示](assets/digital_human_demo_vidu.mp4)

演示素材与自动化测试分别展示交互和验证代码，不代表在当前机器上完成真实服务验收。

## 架构边界

| 边界 | DHAV Mock / FlashHead | Vidu / ARTC |
| --- | --- | --- |
| 音频送入渲染端 | Gateway 呈现层 → DHAV Provider | 浏览器 Gateway SDK → 本地 Vidu 代理 |
| 音视频返回 | 带时间戳的 PCM/I420 配对帧 → Gateway 媒体 worker → WebRTC | Vidu → ARTC → 浏览器 SDK |
| UI | `client/` SPA，经 Gateway `/skins/digital-human` 提供 | `vidu/client/` 浏览器及 Electron 浮窗 |
| Gateway 生命周期 | `bootstrap/` 启动独立配置的示例 Gateway | `vidu/gateway-host.mjs` 复用或启动桌面 Gateway，仅停止自己启动的进程 |
| 配置和状态 | 本目录 `.env.local`、`.runtime/` | `vidu/.env.local`、`vidu/.desktop/`，Gateway 状态与原悬浮球共用 |

DHAV 使用已经合入框架的 `digitalHuman` 注入接口、WebRTC 视频下行和媒体调度；Vidu
使用 Gateway Client SDK 和独立 ARTC 下行。两条链路保留各自传输方式，Vidu 的迁入无需
新增核心改动。原因、同步边界和后续演进条件见[架构分析](docs/integration-architecture.zh.md)。

## 快速开始

从源码仓库运行，Node.js >= 22.22.2；先在仓库根目录执行 `npm ci`。

### DHAV Mock / FlashHead

以下命令在仓库根目录执行：

```sh
npm run example:digital-human:install
cd examples/digital-human
cp .env.example .env.local
# 编辑 .env.local，填写 DASHSCOPE_API_KEY；FlashHead 另填渲染服务地址、Token 和 persona。
npm run build:client
npm start
```

打开启动日志中的 `http://127.0.0.1:18895/skins/digital-human/index.html?...`，
点击麦克风并允许录音后说话，确认回复声音、画面和文字；文本输入也可触发回复。
Mock 无需 GPU，仍需要真实语音 Provider Key。FlashHead 的 GPU 服务需另行部署，见
[完整指南](docs/dhav.zh.md)。Ctrl-C 停止 Gateway 和启动器拥有的本地 Mock。

### Vidu / ARTC

以下命令在 `examples/digital-human` 执行：

```sh
npm run vidu:install
cp vidu/.env.example vidu/.env.local
# 按 Vidu 指南填写 VIDU_API_KEY、ARTC_APP_ID、ARTC_APP_KEY，并配置 Gateway 语音与工具。
npm run start:vidu
```

浮窗设置中选择图片，点击“开始对话”，允许麦克风后说话；确认数字人画面与有声回复。
先点“结束对话”，再退出程序。桌面浮窗已在 macOS 验证，其他桌面平台需本机验收。
Vidu API、ARTC 和联网 SDK 为前提，开始对话可能产生费用；申请入口和详细步骤见
[Vidu 配置指南](vidu/README_ZH.md#api-申请与配置)。已有配置文件时直接编辑，无需再次复制模板。

| 在本目录执行 | 用途 |
| --- | --- |
| `npm start` | DHAV Mock；配置 `DH_RENDERER_URL` 后使用远端 FlashHead |
| `npm run start:vidu` | Vidu 桌面浮窗 |
| `npm run dev:vidu` | Vidu 浏览器，访问 `http://127.0.0.1:5181` |
| `npm run start:orb` | 原悬浮球；也可在 Vidu 浮窗设置中切换 |

两套 UI 一次只选一套采集麦克风。它们不是同一会话中可以无缝热切换的渲染器。

## 配置与数据

- DHAV 默认本机端口 `18895`，配置位于 [.env.example](.env.example)，Shell 环境变量
  优先于本目录 `.env.local`；只在语音 Key 缺失时从仓库根 `.env.local` 读取该 Key。
  示例隔离状态在 `.runtime/`，渲染端接收助手音频；浏览器麦克风交给 Gateway/语音上游。
- Vidu 默认端口 `5181/5182`，配置位于 [vidu/.env.example](vidu/.env.example)，Shell
  环境变量优先于 `vidu/.env.local`。助手音频、文字和角色图片发往 Vidu，音视频由 ARTC
  送回；麦克风只发给 Gateway。Vidu Key、ARTC AppKey 和控制 secret 留在本地服务端。
- Vidu 会复用原悬浮球的语音、工具和持久配置；窗口状态独立。修改环境配置后重启对应
  运行服务。仅删除 `vidu/.desktop/` 可清理浮窗状态，不清除共享 Gateway 对话。
- `.env.local`、`.runtime/`、`vidu/.desktop/` 均不提交。退出相应进程后可手动删除该模式
  的环境文件和运行状态以重置；远端服务的数据保留由其政策决定，删除本地文件不删除远端数据。

详细参数、认证与故障排查分别见 [DHAV 指南](docs/dhav.zh.md)和 [Vidu 指南](vidu/README_ZH.md)。

## 验证与限制

安装两种模式依赖后，在本目录执行：

```sh
npm run test:all
npm run build:client
npm run build:vidu
```

`npm test` 仅测试 DHAV，`npm run test:vidu` 仅测试 Vidu。Mock/协议测试不需要 GPU 或
真实 Vidu 调用；DHAV 浏览器冒烟 `npm run test:digital-human-browser`（仓库根执行）
需要真实语音 Key 和原生 WebRTC 扩展，详见运行指南。

DHAV 的音视频按媒体 worker 音频时钟调度，头像异常可降级音频；目前不同时开启摄像头
输入和头像下行。Vidu 使用静音 PCM 时钟估算 Gateway 播放回执，不能测量 ARTC 实际播放
时刻，也不复用 DHAV 的音频降级机制；Token 不自动续期，活动会话最长两小时。
工具确认和补充输入在标准 Gateway WebUI 完成。真实 FlashHead/Vidu 的画面、声音、
打断、工具和关闭清理仍需在配置好外部服务后手工验收。

## 替换扩展

- 替换 DHAV 渲染服务：设置 `DH_RENDERER_URL`、`DH_RENDERER_TOKEN`、`DH_PERSONA`，
  服务需满足 [Provider 契约](docs/provider-contract.zh.md)；清空远端地址即可恢复本地 Mock。
- 切换 Vidu 国内/海外环境：在 `vidu/.env.local` 设置同环境的 `VIDU_HOST` 和 API Key；
  图片可在设置中更换，语音模型和工具沿用 Gateway 配置。
- Vidu 当前不能直接作为 DHAV Provider 使用。若以后需要统一媒体 worker，须先实现
  服务端 RTC 收流及带回合/代际信息的 PCM/I420 配对输出，再验证同步与降级。

## 作者与致谢

- [Haina Zhu / juhayna-zh](https://github.com/juhayna-zh)：[PR #562](https://github.com/QwenAudio/qwen-audio-agent/pull/562) 的 DHAV、Mock/FlashHead、WebRTC 呈现链路及客户端。
- [zzasdf](https://github.com/zzasdf)：[PR #548](https://github.com/QwenAudio/qwen-audio-agent/pull/548) 的 Vidu/ARTC 浏览器、桌面浮窗及演示素材。
- 外部服务与依赖：[Vidu](https://platform.vidu.cn/)、[阿里云 ARTC](https://help.aliyun.com/zh/live/activate-application)、[OpenAvatarChat FlashHead 服务](https://github.com/juhayna-zh/OpenAvatarChat)。使用时遵守各自的服务、模型和素材许可；本示例不代表这些项目的官方背书。
