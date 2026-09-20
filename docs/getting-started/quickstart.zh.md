# 快速开始

先完成一次对话，再按需添加后台、工具或远程连接。桌面版不需要先安装 CLI。

| 使用方式 | 下一步 |
| --- | --- |
| 桌面应用 | [下载并打开桌面版](../desktop/overview.zh.md#首次使用)，在设置中填写配置。 |
| 终端或浏览器 | 按下面的步骤启动 Gateway，再连接 TUI 或 WebUI。 |
| 手机或另一台电脑 | 先在电脑或服务器启动 Gateway，再[生成连接码](../operations/remote-access.zh.md)。 |
| 自定义客户端或适配器 | 查看[扩展总览](../extensions.zh.md)。 |

## 命令行快速开始

尚未安装时，先看[安装与升级](install.zh.md)。

### 1. 创建配置

```bash
qwenaudio config
```

打开命令显示的 `config.env`。默认位置是 `~/.config/qwaudio/config.env`。

### 2. 填写凭据

先用仅前台模式验证语音对话：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
AGENT_PROTOCOL=none
```

[获取 DashScope API Key](install.zh.md#获取-dashscope-api-key)。使用其他云端或本地服务时，按[语音前台配置](../configuration/frontend.zh.md)替换这部分设置。

### 3. 启动 Gateway

```bash
qwenaudio
```

保持这个终端运行。另开一个终端，打开浏览器客户端：

```bash
qwenaudio webui
```

也可使用终端客户端：

```bash
qwenaudio tui
```

TUI 的音频依赖和平台差异见 [TUI 指南](tui.zh.md)。

## 确认运行成功

1. 客户端显示 Gateway 和语音前台已连接。
2. 允许麦克风权限、开启收音，说一句“你好”。
3. 确认能看到转写并听到回答。

没有声音或连接失败时，先看[故障排查](../operations/troubleshooting.zh.md)。同一 Gateway 中，每个用户只有一个活动客户端；新客户端接管后，原连接会断开。

## 添加后台 Agent

后台负责操作电脑、编写代码和执行其他工作。先自行安装并配置一个[支持的后台](../backends/overview.zh.md)，例如 Qwen Code，再修改：

```dotenv
AGENT_PROTOCOL=qwen
QWEN_AUDIO_AGENT_BACKEND_MODEL=
```

后台模型留空时沿用 Agent 的配置。停止并重新启动 Gateway，再试“查询这台电脑的内存容量”，查看工作卡片与结果。

没有现成后台时，可使用 [OpenCode / OpenClaw 托管初始化](../configuration/backend.zh.md#模型选择)。未配置后台或 `AGENT_PROTOCOL=none` 时，不启动后台 Agent；聊天和已启用的前台工具仍可使用。也可用 `qwenaudio --backend none` 临时覆盖。

## 下一步

- [基本概念](concepts.zh.md)：理解客户端、Gateway、前台与后台的关系。
- [对话与附件](../guides/conversation.zh.md)：文字、语音、图片和文件。
- [后台工作与授权](../guides/tasks.zh.md)：查询、继续、取消及权限确认。
- [运行与常驻](../operations/gateway.zh.md)：退出、重启和后台服务。
