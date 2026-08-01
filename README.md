# Qwen Audio Agent

[中文](README.md) | [English](README_EN.md)

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

- **2026-07-30 · [v1.0.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.0.0)**
  🚀 正式版发布，推出内置 Gateway 的 macOS 桌面版。
- **2026-07-28 · [v0.9.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v0.9.0)**
  🌍 项目正式开源，后台 Agent 统一接入 ACP 架构。

## 对话继续，任务也在继续

对话不会因为后台任务而停下；任务完成后，结果会自然回到当前对话：

https://github.com/user-attachments/assets/42022655-36d1-46b2-9c26-ff0765284000

### 核心特色

- 全双工实时语音交互、自然打断和持续多轮对话
- 一键选择你喜欢的办事 Agent，复用已有的工具、MCP、Skill
- 前台对话与后台任务并驾齐驱，可随时追问任务进度或取消任务
- 支持创建多个独立任务，由后台 Agent 异步执行，并持续追踪任务状态
- 任务结果自动回到当前对话，支持继续追问和修改
- 支持 WebUI、终端 TUI 和 macOS 桌面悬浮球
- 支持本地用户档案与跨会话个人记忆

## 参考架构

![qwen-audio-agent 原理图](docs/architecture-overview.png)

能直接回答的问题会立即回答；需要工具或持续处理时，任务会交给后台 Agent。
整个过程中，用户面对的始终是同一个助理。

<details open>
<summary>查看详细架构</summary>

![qwen-audio-agent 接入参考架构](docs/qwen-audio-agent-three-layer-architecture.png)

更完整的设计与模块说明见[架构文档](docs/architecture.md)。

</details>

## Agent 支持

| 后台 Agent | 接入方式 | 接入准备 | 推荐指数 |
| --- | --- | --- | --- |
| 无 | N/A | 仅前台模式，无需配置 | ★★★★★ |
| OpenCode | 原生 ACP | 支持自动安装和百炼配置 | ★★★★★ |
| OpenClaw | 内置 ACP 桥接 | 支持自动安装和百炼配置 | ★★★★★ |
| Qoder | 原生 ACP | 用户自行安装和配置 | ★★★★★ |
| Kimi Code | 原生 ACP | 用户自行安装和配置 | ★★★★★ |
| Hermes | 原生 ACP | 用户自行安装和配置 | ★★★★☆ |
| CodeBuddy | 原生 ACP | 用户自行安装和配置 | ★★★★☆ |
| Codex | 外部 ACP 适配 | 用户自行安装和配置 | ★★★★☆ |
| Claude Code | 外部 ACP 适配 | 用户自行安装和配置 | ★★★★☆ |

推荐指数综合反映当前集成完整度、兼容性和实际验证程度：五星表示已经过充分测试的
推荐集成，四星表示正在开发或尚未完成同等范围验证。
详细配置和能力边界见[配置说明](docs/configuration.md)。

## 安装

需要 Node.js 22.22.2+ 或 24.15.0+、npm 10+ 和 DashScope API Key。
仓库提供 `.nvmrc` 和 `.node-version`；使用 nvm 时可直接运行 `nvm use`。

一键安装（推荐，从 npm 安装）：

```bash
npm install -g qwen-audio-agent
```

也可以直接从 GitHub 安装最新代码：

```bash
npm install -g git+https://github.com/QwenAudio/qwen-audio-agent.git
```

从源码安装：

```bash
git clone https://github.com/QwenAudio/qwen-audio-agent.git
cd qwen-audio-agent
npm install
npm run install:global
```

升级到最新 npm 版本：

```bash
npm install -g qwen-audio-agent@latest
```

升级到 GitHub 最新代码：

```bash
npm install -g git+https://github.com/QwenAudio/qwen-audio-agent.git
```

## 获取 DashScope API Key

阿里云百炼为 Qwen Audio 3.0 Realtime 提供
[新人免费额度](https://help.aliyun.com/zh/model-studio/new-free-quota)，创建 API Key 后
即可免费开始使用 qwen-audio-agent。

1. 打开百炼控制台的 [API Key 页面](https://bailian.console.aliyun.com/?tab=model#/api-key)，
   登录账号，单击**创建 API Key**。
2. 复制生成的 Key，稍后填入 `config.env`。请勿公开或提交 API Key。

详细说明见[百炼官方文档](https://help.aliyun.com/zh/model-studio/get-api-key)。

## 快速开始

1. 创建配置：

```bash
qwenaudio config
```

2. 打开命令显示的 `config.env`，填写 DashScope API Key。需要执行后台任务时，
   再选择 OpenClaw 或其他后台 Agent：

```dotenv
DASHSCOPE_API_KEY=your-key
# 语音前台模型：qwen-audio-3.0-realtime-flash 或 qwen-audio-3.0-realtime-plus（默认）
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
# 后台Agent：可选，不设置或设置为 none 时，启动仅前台模式
AGENT_PROTOCOL=openclaw
# 后台模型：可为空，留空则沿用 Agent 自身的用户配置
QWEN_AUDIO_AGENT_BACKEND_MODEL=qwen3.7-max
```

3. 在一个终端中启动 Gateway：

```bash
qwenaudio
```

4. 另开一个终端，启动 TUI：

```bash
qwenaudio tui
```

也可以使用浏览器界面：

```bash
qwenaudio webui
```

### TUI 使用注意

| 平台 | 默认模式 | 打断方式 |
| --- | --- | --- |
| macOS | 带回声消除的全双工 | 直接说话 |
| Linux / Windows | 半双工 | 播报时按 `x` |

Linux 和 Windows 首次使用前需安装 `sounddevice` 和系统 PortAudio。也可以开启
无回声消除的全双工模式；此时请佩戴耳机，避免扬声器声音造成误识别：

```bash
qwenaudio tui --audio-mode full
```

## macOS 桌面版

桌面版提供常驻桌面的语音悬浮球，并内置和自动管理 Gateway，无需事先启动服务。
首次运行时，应用会创建配置文件，并引导你在设置页填写 DashScope API Key、选择
后台 Agent（也可以使用仅前台模式）。

桌面版支持流光声波球和液态渐变球两种外观。下面分别展示它们在思考 / 呼吸状态
下的原始动态效果：

| 流光声波球 | 液态渐变球 |
| --- | --- |
| ![流光声波球思考动画](docs/desktop-fluid-orb-thinking.gif) | ![液态渐变球思考动画](docs/desktop-goo-orb-thinking.gif) |

从发布页下载 `.dmg`，打开后将 **Qwen Audio Agent** 拖入“应用程序”即可。

从源码生成本机测试版：

```bash
npm run desktop:build:local
```

## 后台常驻

希望个人助理长期在线时，可以安装为用户后台服务：

```bash
qwenaudio gateway install
```

常用管理命令：

```bash
qwenaudio gateway status
qwenaudio gateway restart
qwenaudio gateway stop
qwenaudio gateway start
qwenaudio gateway uninstall
```

## 选择后台 Agent

`AGENT_PROTOCOL` 是可选配置。留空时，Gateway 以仅前台模式运行，实时语音聊天
保持可用；如果请求需要后台执行，前台会明确说明当前没有可用的后台 Agent。
也可以在命令行中使用 `qwenaudio --backend none`，明确要求仅启动前台模式。

通过 `AGENT_PROTOCOL` 环境变量或 `--backend` 参数选择后台 Agent。选择后，
OpenCode 和 OpenClaw 支持自动下载安装；配置
`DASHSCOPE_API_KEY` 和 `QWEN_AUDIO_AGENT_BACKEND_MODEL` 后即可自动接入百炼
模型。未指定后台模型且用户已经安装并配置对应 Agent 时，则完整复用用户环境。

查看当前可用的后台 Agent：

```bash
qwenaudio setup
```

使用 OpenClaw：

```dotenv
AGENT_PROTOCOL=openclaw
```

使用 OpenCode：

```dotenv
AGENT_PROTOCOL=opencode
```

使用 Qoder：

```dotenv
AGENT_PROTOCOL=qoder
```

后台 Agent 需要用户自行安装并完成原生配置；qwen-audio-agent 会复用其
用户级模型、工具、MCP、Skill 和认证。

其中部分 Agent 通过外部 ACP 适配器接入，除本体外，还需要全局安装对应的适配器。
以 Codex 为例：

```bash
npm install -g @agentclientprotocol/codex-acp
```

CLI 模式缺少适配器时会尝试通过 npx 按需启动；桌面版为保证启动可靠，仅使用已安装的
组件，请提前安装。

使用其他支持 ACP stdio 的 Agent：

```dotenv
AGENT_PROTOCOL=acp
ACP_COMMAND=your-agent
ACP_ARGS=["--acp"]
```

通用 ACP 入口不需要修改 Gateway 代码。命令、参数、显示名称和工作目录可分别通过 `ACP_COMMAND`、`ACP_ARGS`、`ACP_LABEL` 和 `ACP_WORKSPACE` 配置。

后台权限默认使用 `native`，由后台 Agent 在需要时询问。只有在可信项目中，并且
明确接受自动执行命令和修改文件时，才应启用：

```dotenv
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=full
```

详细选项见 [配置说明](docs/configuration.md)。

## 用户档案与记忆

用户数据保存在 `~/.config/qwaudio/`：

- `USER.md`：称呼、所在地、偏好和常用项目
- `frontend-memory.json`：用户明确要求长期记住的信息
- `tasks.json`：任务结果和待通知状态

这些文件只保存在本机，不会写入源码仓库。可以直接编辑 `USER.md`，也可以在对话中
要求助理记住或忘记信息。

## 使用注意事项

- 不要在用户档案或对话中保存密码、API Key、验证码和访问令牌。
- 麦克风音频与实时对话会发送到配置的 Qwen Audio Realtime 服务。
- 后台任务可能调用所选 Agent 的模型、工具、MCP 和外部服务。
- `full` 权限允许后台执行命令和修改文件，只应在可信项目中使用。
- Gateway 默认仅供本机访问；不要直接暴露到局域网或公网。
- Linux / Windows 使用无回声消除全双工时，请佩戴耳机。

详细数据边界见[隐私说明](PRIVACY.md)，网络与权限配置见
[配置说明](docs/configuration.md)。

## 源码开发

```bash
npm install
npm run build
npm test
```

```bash
npm run dev       # Gateway 与 WebUI 热更新
npm run desktop   # macOS 桌面悬浮球
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
