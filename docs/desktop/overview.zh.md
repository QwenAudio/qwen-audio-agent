# 桌面版

桌面版提供语音悬浮球与对话面板，并内置 Gateway，无需先在终端启动服务。
默认与 CLI 共享配置、记忆和工作区，但运行时目录独立；若同一桌面运行时目录已有
Gateway，会复用该实例，否则由应用启动和管理。

## 首次使用

1. 从[发布页](https://github.com/QwenAudio/qwen-audio-agent/releases/latest)下载安装包并打开应用。
2. 首次启动会创建 `config.env`。打开设置，填写语音前台所需凭据；
   默认 DashScope 可从设置中的入口前往百炼获取 API Key。
3. 选择后台 Agent，也可以先选择仅前台模式。已安装的 Agent 沿用自己的登录和模型配置；
   未安装时使用可用的“安装”入口，再按后台要求完成配置。
4. 点击“应用”，查看 Gateway、语音前台和后台 Agent 的运行状态。
5. 首次使用允许麦克风权限，说一句“你好”，确认看到转写并听到回复。

已存在配置时会沿用配置启动。配置已填写或后台已安装，不等于模型凭据或额度已经验证。
遇到错误时查看[故障排查](../operations/troubleshooting.zh.md)。

## 悬浮球与对话面板

使用悬浮球旁的“打开对话”按钮切换到面板，可以查看对话与工作卡片，并输入文字、
添加图片或文件。面板与悬浮球是同一客户端的两种展示形态，不会另开一个语音连接。
面板中的收起按钮可切回悬浮球。

点击悬浮球本身不会切换静音。使用麦克风按钮控制收音；静音不影响正在播放或之后
到达的回复。发送文字或附件的行为见[对话与附件](../guides/conversation.zh.md)。

## 后台 Agent 连接

默认由应用管理所选后台 Agent。支持外部服务的 Agent 可以选择“连接现有服务”，填写
服务地址和可选令牌；目前 OpenClaw 支持。这里连接的是**后台 Agent 服务**，
不是让桌面客户端切换到另一台 Gateway。具体限制见[后台设置](../configuration/backend.zh.md)。

## 悬浮球与自动休眠

闲置达到设置时长后，悬浮球可以自动隐藏；也可以说“可以退下了”。
休眠是**隐藏界面并停止向语音前台发送麦克风输入，保持 Realtime 连接与上下文**。
应用仍常驻菜单栏，后台工作不会因此取消，待播报结果在唤醒后继续处理。

可以从菜单栏或显示快捷键唤醒。macOS 默认快捷键为 `⇧⌘ Space`；
实际按键可在设置中查看或修改。若启用唤醒词，休眠时麦克风仅供本地关键词检测，
说“你好千问”即可唤醒。首次启用会下载并校验约 33 MB 的
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 模型，之后使用本地缓存；
检测在桌面客户端独立 Worker 中运行，不上传唤醒词音频。

## 外观

设置页可切换内置流光声波球、液态渐变球或导入的桌宠皮肤。下图是内置外观的动态示例：

| 流光声波球 | 液态渐变球 |
| --- | --- |
| ![流光声波球动态示例](../desktop-fluid-orb-thinking.gif) | ![液态渐变球动态示例](../desktop-goo-orb-thinking.gif) |

## 皮肤

在“设置 → 应用 → 外观”点击“导入皮肤…”，选择皮肤目录、`pet.json` 或 zip 包。
导入的皮肤可在外观列表选择或删除，内置外观不能删除。

支持 Codex pet 包格式及可选动画帧描述，无需安装 Codex。制作资源时参考
[桌宠皮肤协议](pet-skin-spec.zh.md)；状态映射、循环与单次播放规则见
[桌面动画对接](../reference/desktop-animations.zh.md)。

## 远程连接

设置中的“远程连接”可粘贴 Gateway 主机生成的连接码。配对步骤见
[远程连接与配对](../operations/remote-access.zh.md)。远程模式下，Gateway 与后台 Agent
都在远端运行，桌面版只承担输入输出，不负责发布远端 Gateway。
Tailnet 模式需要两端安装官方 Tailscale，外部 HTTPS 模式不需要。

## 安装

正式包与更新见[安装与升级](../getting-started/install.zh.md#桌面安装)。
从已安装源码依赖的仓库生成本机测试包：

```bash
npm run desktop:build:local      # macOS
npm run desktop:build:win        # Windows
npm run desktop:build:linux      # Linux：AppImage + deb
```

产物在 `dist/desktop/`。本地测试构建不等同于正式签名发布包。

## 数据目录与隔离

桌面与 CLI 启动的 Gateway 共用配置、身份、记忆和默认工作区，运行状态各自独立。
桌面偏好、窗口位置、皮肤、唤醒模型和连接凭据留在客户端应用目录。
两者可以同时运行，不代表连接的是同一个 Gateway。
完整路径及覆盖规则见[配置总览](../configuration.zh.md#配置与数据目录)。

## 自动更新与日志

设置页可检查更新，下载完成后重启安装。退出应用会停止它自己启动的 Gateway 与后台进程，
不会停止借用的或远程的服务。

从“设置 → 应用 → 日志”打开当前桌面版日志目录。日志会脱敏和轮转，详细配置见
[本地日志](../configuration/advanced.zh.md#本地日志)。
