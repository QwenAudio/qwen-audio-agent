# Windows + WSL2 客户端安装指南

Windows 客户端负责界面、麦克风和扬声器；Gateway、后台 Agent 和用户数据仍在
WSL2 中运行。安装完成后无需另外启动 `qwenaudio webui`。

## 1. 准备运行环境

支持 Windows 10/11 x64，不支持 Windows ARM64 或 WSL1。打开 PowerShell 检查
WSL（检查不需要管理员权限，首次启用 WSL 时 Windows 可能要求系统授权）：

```powershell
wsl.exe --status
wsl.exe --list --verbose
```

如果尚未安装，按照 [Microsoft WSL 安装说明](https://learn.microsoft.com/windows/wsl/install)
安装一个发行版，例如 Ubuntu。目标发行版的 `VERSION` 必须为 `2`。

进入该发行版，检查 Linux 环境中的 Node.js 和 npm：

```bash
node --version
npm --version
```

需要 Node.js 22.22.2+（22.x）、24.15.0+（24.x）或 26+，以及 npm 10+。缺少时请在
WSL 发行版内安装，Windows 版 Node.js 不能代替它。

## 2. 安装 Windows 客户端

1. 从项目 [Releases](https://github.com/QwenAudio/qwen-audio-agent/releases) 下载
   `qwen-audio-agent-<version>-windows-x64.exe`。
2. 运行安装器并选择安装目录。安装仅作用于当前 Windows 用户，无需管理员权限。
3. 安装完成后，从桌面或开始菜单打开 **Qwen Audio Agent**。

正式发布包应带有 Windows 代码签名。仅在确认来源可信时使用未签名的本地或 CI
测试包。

## 3. 完成首次启动

1. 客户端会检查 WSL2、发行版、Node.js 和 npm。
2. 默认发行版不合适时，打开“管理 WSL 运行时”选择目标发行版。
3. 选择“准备安装”，核对将要在 WSL 中执行的命令，然后选择“确认安装”。
4. 等待私有运行时、Gateway 和语音连接就绪；主悬浮球会自动打开。

私有运行时安装在：

```text
~/.local/share/qwaudio/windows-client/runtime/<desktop-version>/
```

现有配置、Agent 登录、记忆和任务仍复用 `~/.config/qwaudio/`。

## 4. 配置语音和后台 Agent

打开“设置”，在“语音前台”中填写 DashScope API Key，并选择前台模型。只使用实时
语音聊天时，“后台 Agent”可以选择“不使用后台 Agent”。

需要使用 Codex 时，先在所选 WSL 发行版内安装并登录 Codex，确认以下命令可用：

```bash
codex --version
npm install -g @agentclientprotocol/codex-acp
codex-acp --version
```

然后回到客户端设置，刷新后台 Agent 列表并选择 **Codex**。设置页的 Gateway、
Realtime 和后台 Agent 均显示已连接后，即可正常使用。

## 5. 卸载

可从“Windows 设置 -> 应用 -> 已安装的应用”卸载，也可以在开始菜单中右键
**Qwen Audio Agent** 后选择“卸载”。

卸载器会删除 Windows 应用和快捷方式，但不会删除 WSL 私有运行时或
`~/.config/qwaudio/`。如需清理私有运行时，请在卸载前通过“管理 WSL 运行时”选择
“移除专用运行环境”。

## 常见问题

- **发行版显示 Stopped**：这是正常状态，重新检查时 WSL 会按需启动它。
- **提示缺少 Node.js/npm**：请安装到所选 WSL 发行版，而不是 Windows。
- **后台 Agent 未连接**：在 WSL 中确认 Agent 已登录、相关命令可用，然后在设置中刷新。
- **麦克风不可用**：在 Windows 隐私设置中允许桌面应用访问麦克风。

更多连接模式和故障排查见[配置说明](configuration.md#windows--wsl2-桌面版)。
