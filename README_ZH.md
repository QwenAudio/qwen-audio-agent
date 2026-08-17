# Qwen Audio Agent

[中文](README_ZH.md) | [English](README.md)

[![CI](https://github.com/QwenAudio/qwen-audio-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/QwenAudio/qwen-audio-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/qwen-audio-agent)](https://www.npmjs.com/package/qwen-audio-agent)
[![node](https://img.shields.io/badge/node-%E2%89%A522.22.2-brightgreen)](https://nodejs.org/)
[![license](https://img.shields.io/github/license/QwenAudio/qwen-audio-agent)](LICENSE)
[![WeChat](https://img.shields.io/badge/WeChat-%E5%8A%A0%E5%85%A5%E8%AE%A8%E8%AE%BA-07C160?logo=wechat&logoColor=white)](#交流与分享)

## Agent，始终在场

真正的交流，不该在说完一句话后，就陷入漫长的等待。也不该因为 Agent 正在查资料、调用工具或处理任务，整场对话就此暂停。

交流应该是连续的，Agent 也应该始终在场。

所以，我们做了 **qwen-audio-agent**——让 Agent 持续交流、持续工作、持续在场的实时语音运行时。无论是聊天、思考，还是处理任务，Agent 都始终在这场对话里。它会倾听，会回应，也会在任务完成时自然地告诉你：

“已经好了。”

## News

- **2026-08-15 · [v1.10.1](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.10.1)**
  🐛 修复若干已知问题；🖥️ 提升桌面版易用性。
- **2026-08-13 · [v1.10.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.10.0)**
  🐋 新增实验性 DeepSeek Harness 后台接入，支持一键安装。
- **2026-08-13 · [v1.9.1](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.9.1)**
  🖥️ 优化桌面端任务卡片展示，并修复若干已知问题。
- **2026-08-13 · [v1.9.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.9.0)**
  🧩 桌面任务卡实时展示 Agent 进度；🔎 后台 Agent 选择更清晰、支持搜索；🎙️ 支持 Qwen3.5-Omni Realtime 前台模型接入。
- **2026-08-12 · [v1.8.3](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.8.3)**
  ✨ 优化 Prompt；📉 减少 Token 消耗；🔧 修复已知问题。
- **2026-08-11 · [v1.8.2](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.8.2)**
  🖥️ 桌面设置页焕新，布局与视觉风格更加统一；🎙️ 语音唤醒更可靠；⏱️ 长任务会主动汇报进度。
- **2026-08-11 · [v1.8.1](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.8.1)**
  🧠 人设与记忆边界更清晰；🔧 任务与提醒更可靠。
- **2026-08-09 · [v1.8.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.8.0)**
  🆕 新增 Qwen Code 后台；🔧 修复已知问题。
- **2026-08-07 · [v1.7.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.7.0)**
  🎨 悬浮球开放自定义外观，兼容 [Awesome Codex Pet](https://codexpet.top/) 社区画廊的宠物包；🪟 优化 Windows 后台 Agent 启动。
- **2026-08-07 · [v1.6.1](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.6.1)**
  ⚡ 委派任务与权限确认即说即回；🖥️ 内置 computer-use，后台 Agent 开箱可操作电脑；🎙️ 唤醒更可靠；📚 文档全面双语化。
- **2026-08-06 · [v1.6.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.6.0)**
  🪟 桌面版正式支持 Windows；🧠 新增无感记忆，会话结束后自动提取。
- **2026-08-05 · [v1.5.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.5.0)**
  ⏰ 新增定时提醒与进度查询；🗣️ 新增语音唤醒词“你好千问”；🐧 桌面版支持 Linux 打包；桌面版数据目录与 CLI 隔离。
- **2026-08-05 · [v1.4.2](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.4.2)**
  🔧 优化桌面端后台 Agent 的安装、登录与状态检测，完善长期记忆行为。
- **2026-08-04 · [v1.4.1](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.4.1)**
  🧰 新增后台 Agent 一键安装；桌面悬浮球支持自动隐藏与快捷键唤回。
- **2026-08-04 · [v1.4.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.4.0)**
  🧠 新增个性化规则与清单管理；桌面版支持自动休眠与快捷键唤醒。
- **2026-08-03 · [v1.3.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.3.0)**
  🎙️ 新增 [🤗 speech-to-speech](https://github.com/huggingface/speech-to-speech) 前台接入，支持本地部署 VAD、STT、LLM 与 TTS 全链路。
- **2026-08-01 · [v1.2.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.2.0)**
  ⚡ 桌面版新增自动更新，优化启动速度与后台 Agent 检测。
- **2026-07-31 · [v1.1.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.1.0)**
  🤝 新增 Kimi Code CLI 后台，原生 ACP 接入。
- **2026-07-30 · [v1.0.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.0.0)**
  🚀 正式版发布，推出内置 Gateway 的 macOS 桌面版。
- **2026-07-28 · [v0.9.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v0.9.0)**
  🌍 项目正式开源，后台 Agent 统一接入 ACP 架构。

## 对话继续，任务也在继续

对话不会因为后台任务而停下；任务完成后，结果会自然回到当前对话：

https://github.com/user-attachments/assets/ab570531-8da9-4af4-93fa-244bb6614c05

### 核心特色

- 全双工实时语音交互、自然打断和持续多轮对话
- 从统一模型目录选择 DashScope Qwen Audio 与 Qwen3.5 Omni Realtime 模型
- 一键选择你喜欢的办事 Agent，复用已有的工具、MCP、Skill
- 前台对话与后台任务并驾齐驱，可随时追问任务进度或取消任务
- 支持创建多个独立任务，由后台 Agent 异步执行，并持续追踪任务状态
- 任务结果自动回到当前对话，支持继续追问和修改
- 支持 WebUI、终端 TUI 和桌面悬浮球（macOS / Windows / Linux）
- 桌面版自动休眠时断开云端 Realtime，但不停止已提交任务；可通过自定义快捷键或本地唤醒词恢复
- 支持当前用户的长期个性化覆盖与跨会话记忆

## 参考架构

![qwen-audio-agent 原理图](docs/architecture-overview.png)

能直接回答的问题会立即回答；需要工具或持续处理时，任务会交给后台 Agent。
整个过程中，用户面对的始终是同一个助理。

<details open>
<summary>查看详细架构</summary>

![qwen-audio-agent 接入参考架构](docs/qwen-audio-agent-three-layer-architecture.png)

更完整的产品边界见[架构文档](docs/architecture.zh.md)，也可查看
[语音 Agent 架构演示文档](docs/voice-agent-architecture-presentation.zh.md)。

</details>

## Agent 支持

| 后台 Agent | 接入方式 | 接入准备 | 推荐指数 |
| --- | --- | --- | --- |
| 无 | N/A | 仅前台模式，无需配置 | ★★★★★ |
| OpenCode | 原生 ACP | 支持一键安装和百炼配置 | ★★★★★ |
| OpenClaw | 内置 ACP 桥接 | 支持一键安装和百炼配置 | ★★★★★ |
| Qoder | 原生 ACP | 支持一键安装，需用户配置 | ★★★★★ |
| Qwen Code | 原生 ACP | 支持一键安装，需用户配置 | ★★★★☆ |
| Kimi Code | 原生 ACP | 支持一键安装，需用户配置 | ★★★★★ |
| Hermes | 原生 ACP | 支持一键安装，需用户配置 | ★★★★☆ |
| CodeBuddy | 原生 ACP | 支持一键安装，需用户配置 | ★★★★☆ |
| Codex | 外部 ACP 适配 | 支持一键安装本体与适配器，需用户配置 | ★★★★☆ |
| Claude Code | 外部 ACP 适配 | 支持一键安装本体与适配器，需用户配置 | ★★★★☆ |
| DeepSeek | 原生 ACP（实验性） | 支持一键安装，需 DeepSeek API Key | ★★★★☆ |

推荐指数综合反映当前集成完整度、兼容性和实际验证程度：五星表示已经过充分测试的
推荐集成，四星表示正在开发或尚未完成同等范围验证。
详细配置和能力边界见[配置说明](docs/configuration.zh.md)。

## 安装

需要 Node.js 22.22.2+ 或 24.15.0+、npm 10+。一键安装（推荐）：

```bash
npm install -g qwen-audio-agent
```

从源码安装、从 GitHub 安装最新代码以及获取 DashScope API Key 的详细步骤见
[安装指南](docs/getting-started/install.zh.md)。

## 快速开始

1. 创建配置并填入 API Key：

```bash
qwenaudio config
```

```dotenv
DASHSCOPE_API_KEY=your-key
# 语音前台模型：Omni Flash/Plus 或 Audio Flash/Plus（默认 Audio Plus）
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
# 后台Agent：可选，不设置或设置为 none 时，启动仅前台模式
AGENT_PROTOCOL=openclaw
# 后台模型：可为空，留空则沿用 Agent 自身的用户配置
QWEN_AUDIO_AGENT_BACKEND_MODEL=qwen3.7-max
```

> 默认使用 DashScope 实时语音前台；也可切换为本地 [speech-to-speech 前台](docs/voice-frontends/speech-to-speech.zh.md)，无需云端 API Key。
> `qwen3.5-omni-flash-realtime` 与 `qwen3.5-omni-plus-realtime`
> 在模型层支持文本、音频和图片输入。本版本客户端传输层仅启用文本和音频；
> 图片/画面帧与原生视频传输仍保持关闭，待对应客户端和 Gateway 链路实现。

桌面版或 `qwenaudio config set --realtime-model <id>` 配置 Gateway 统一使用的模型；
CLI 修改后需要重启 Gateway。WebUI 与 TUI 只显示当前生效模型，不单独覆盖模型。

2. 启动 Gateway，另开终端启动 TUI（也可用 `qwenaudio webui` 启动浏览器界面）：

```bash
qwenaudio        # 终端 1：Gateway
qwenaudio tui    # 终端 2：TUI
```

完整配置项、speech-to-speech 前台接入和 TUI 平台注意事项见
[快速开始](docs/getting-started/quickstart.zh.md)、
[语音前台](docs/voice-frontends/speech-to-speech.zh.md)与
[TUI 注意](docs/getting-started/tui.zh.md)。

## 桌面版

桌面版提供常驻桌面的语音悬浮球，内置 Gateway，支持空闲自动休眠、自定义唤醒
快捷键和本地语音唤醒。休眠时会断开 Realtime 前台，但桌面进程、Gateway、后台
Agent 和已提交任务仍继续运行；它不等于退出或重启桌面版。任务完成后可以唤醒
桌面版，并把结果带回当前对话。从发布页下载对应平台安装包，或从源码构建：

```bash
npm run desktop:build:local      # macOS
npm run desktop:build:win        # Windows
npm run desktop:build:linux      # Linux（AppImage + deb，无需签名）
```

外观效果、悬浮球行为和构建说明见[桌面版文档](docs/desktop/overview.zh.md)。

## 后台 Agent

`AGENT_PROTOCOL` 可选。留空即仅前台模式；选择后可复用已安装 Agent 的用户级
模型、工具、MCP、Skill 和认证。CLI 与桌面版共用同一套接入规范：检测到已有 Agent
时直接复用；用户选择一键安装时只补齐缺失组件；安装、配置和运行状态分别判断。
配置仍由后台 Agent 自己负责，桌面版打开其原生配置入口，不读取、复制或改写它的
凭据。

```bash
qwenaudio setup   # 查看当前可用的后台 Agent
```

Agent 选择、后台常驻服务、通用 ACP 入口和权限模式见
[后台 Agent 文档](docs/backends/overview.zh.md)。

## 个性化与记忆

用户数据保存在 `~/.config/qwaudio/`（`ASSISTANT.md`、`USER.md`、`MEMORY.md`、
`tasks.json`、`logs/`），只存本机、不进仓库。详见
[助手画像、用户偏好与记忆](docs/reference/memory.zh.md)。

## 使用注意事项

- 不要在用户偏好或对话中保存密码、API Key、验证码和访问令牌。
- 麦克风音频与实时对话会发送到配置的 Realtime 前台服务（DashScope 或
  speech-to-speech）。
- 后台任务可能调用所选 Agent 的模型、工具、MCP 和外部服务。
- `full` 权限允许后台执行命令和修改文件，只应在可信项目中使用。
- Gateway 默认仅供本机访问；不要直接暴露到局域网或公网。
- Linux / Windows 使用无回声消除全双工时，请佩戴耳机。

详细数据边界见[隐私说明](PRIVACY.md)，网络与权限配置见
[配置说明](docs/configuration.zh.md)。

## 源码开发

```bash
npm install
npm run build
npm test
```

```bash
npm run dev       # Gateway 与 WebUI 热更新
npm run desktop   # 桌面悬浮球（macOS / Windows）
```

更多构建、测试和发布说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 交流与分享

你可以直接在 [GitHub Issues](https://github.com/QwenAudio/qwen-audio-agent/issues) 发起讨论。

对中国用户，也可以扫描左侧二维码加入微信交流群；如果群二维码已满或过期，
扫描右侧任一维护者的个人二维码，维护者会邀请你进群。

| 微信交流群 | 个人微信 | 个人微信 |
| :---: | :---: | :---: |
| <img src="docs/wechat-group-qr.png" width="240" alt="微信交流群二维码"> | <img src="docs/wechat-contact-qr.png" width="240" alt="李旭个人微信二维码"> | <img src="docs/wechat-pigeon-dan-qr.png" width="240" alt="Pigeon.Dan 个人微信二维码"> |

## 参与贡献与安全

- 开发与提交说明：[CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题报告：[SECURITY.md](SECURITY.md)
- 数据流向说明：[PRIVACY.md](PRIVACY.md)
- 第三方组件声明：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## 许可证

[Apache License 2.0](LICENSE)
