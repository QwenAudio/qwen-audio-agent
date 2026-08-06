# 快速开始

如果还没安装，先看[安装](install.md)。

## 1. 创建配置

```bash
qwenaudio config
```

命令会显示配置文件路径，并创建带注释的 `config.env` 模板。

## 2. 填写配置

最小配置只需要 DashScope API Key：

```dotenv
DASHSCOPE_API_KEY=your-key
```

需要执行后台任务时，再选择后台 Agent 并指定后台模型：

```dotenv
DASHSCOPE_API_KEY=your-key
# 语音前台模型：flash 低延迟更省，plus（默认）质量更好
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
# 后台 Agent：留空或不设为 none 时启动仅前台模式
AGENT_PROTOCOL=openclaw
# 后台模型：留空则沿用 Agent 自身的用户配置，不复用则由 Agent 自选
QWEN_AUDIO_AGENT_BACKEND_MODEL=qwen3.7-max
```

> 默认使用 DashScope 实时语音前台；也可切换为本地 [speech-to-speech 前台](../voice-frontends/speech-to-speech.md)，无需云端 API Key。

## 3. 启动

在一个终端中启动 Gateway：

```bash
qwenaudio
```

另开一个终端，启动 TUI：

```bash
qwenaudio tui
```

也可以使用浏览器界面（默认 `http://127.0.0.1:3101`）：

```bash
qwenaudio webui
```

## 仅前台模式

不设置 `AGENT_PROTOCOL`（或设为 `none`）时，Gateway 只提供实时语音聊天。
需要后台执行的请求会返回明确说明，不会创建任务或猜测执行结果。也可以用
`qwenaudio --backend none` 显式启动仅前台模式。

后台 Agent 的选择、一键安装、权限模式和常驻服务见
[后台 Agent](../backends/overview.md)，完整环境变量见
[配置说明](../configuration.md)，TUI 平台差异见
[TUI 注意](tui.md)。
