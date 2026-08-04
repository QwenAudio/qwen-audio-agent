# Privacy

qwen-audio-agent 是本地运行的语音前台，不包含内置遥测、广告分析或自动崩溃上报。
但完成语音对话和 Agent 任务需要与用户选择的外部服务交换数据。

## 数据流向

- 默认情况下，麦克风音频、实时转写上下文和模型回复请求会发送到阿里云
  DashScope 的 Qwen Audio Realtime 服务。若用户配置其他兼容服务，则数据发送到
  该服务。
- 委派任务、必要的对话上下文和任务结果会发送给用户选择的后台 Agent，例如
  OpenCode、OpenClaw、Qoder、Kimi Code、Hermes、CodeBuddy、Codex、Claude Code
  或用户配置的其他 ACP Agent。后台 Agent 还可能按照用户配置调用模型、工具、
  MCP 服务或访问项目文件；这些服务各自的隐私政策同样适用。
- Markdown 中的远程图片、音频和视频默认不会自动加载。用户点击加载或打开链接
  后，目标站点可能获知用户的 IP 地址和浏览器信息。

## 本地数据

用户档案、长期记忆、任务状态、后台工作目录和配置默认保存在
`~/.config/qwaudio/`。API Key 等凭据不应写入仓库、对话或用户档案。卸载应用不会
自动删除该目录，避免意外丢失用户数据。

## Windows + WSL2 桌面版边界

Windows 客户端把系统集成与 Agent 运行时分开：

- Windows Electron 进程负责麦克风采集、扬声器播放、悬浮球、设置、系统托盘、
  开机启动和应用更新。Windows 会按照系统隐私设置决定是否允许麦克风访问。
- Gateway、后台 Agent、配置、用户档案、记忆、任务和工作目录都在用户选择的
  WSL2 发行版内运行或保存。现有 `~/.config/qwaudio/` 会被直接复用，不复制到
  Windows。
- Windows 只保存连接模式、发行版名称、loopback 外部 Gateway 地址、开机启动、
  窗口位置、悬浮球显示状态和脱敏桌面日志。API Key、Token 和完整配置不会写入
  Windows 偏好、桌面日志或更新元数据。
- WSL 诊断在进入 Windows 剪贴板或日志前经过字段白名单和凭据脱敏；错误消息中的
  Bearer Token、API Key、密码等敏感值会被遮盖。用户仍应在分享诊断前自行复核。
- 托管模式只停止当前桌面会话启动并持有匹配所有权令牌的 WSL 进程树。外部模式
  只连接现有 loopback Gateway，绝不接管或停止它。

安装包携带版本匹配的私有 WSL 运行时。应用先校验 SHA-256，并显示确切安装命令；
只有用户确认后才会写入
`~/.local/share/qwaudio/windows-client/runtime/<desktop-version>/`。Windows 卸载器
不会自动删除 WSL 中的 `~/.config/qwaudio` 或私有运行时，避免跨边界静默删除数据；
私有运行时可在应用内核对目标并二次确认后单独移除。

Windows 客户端不会把 Gateway 绑定到 `0.0.0.0`，不会创建 Windows 防火墙例外、
`netsh portproxy` 或局域网监听。Windows 与 WSL 之间只使用系统提供的 localhost
转发。若该转发不可用，应用会显示修复说明，而不是扩大网络暴露范围。

运行日志默认保存在 `~/.config/qwaudio/logs/`，不会自动上传。日志系统会脱敏常见
凭据字段和 Bearer/API Key 文本，并且默认不记录音频、转写正文、模型回复正文、
任务目标或任务结果。诊断日志仍可能包含本机路径、所选 Agent/模型、Session/Task
标识和错误信息；分享日志前请再次检查，卸载应用也不会自动删除这些日志。

## 远程部署

Gateway 默认仅供本机使用。通过反向代理开放远程访问时，部署者负责启用 HTTPS、
访问认证、日志保护和适用的数据保留策略。不要将 Gateway 端口直接暴露到局域网
或公网。

## 项目边界

本项目无法控制 DashScope、用户选择的后台 Agent、模型提供商、MCP 服务或用户
打开的第三方链接如何处理数据。正式使用前，请审阅相关服务的隐私条款并选择
合适的部署方式。
