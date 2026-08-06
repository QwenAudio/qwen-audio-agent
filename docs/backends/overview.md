# 后台 Agent

后台 Agent 负责需要工具、文件操作或持续处理的任务。前台语音 LLM 判断请求
需要执行时，会把目标交给后台 Agent 异步执行，结果完成后自然回到当前对话。

## 支持的 Agent

| 后台 Agent | 接入方式 | 接入准备 | 推荐指数 |
| --- | --- | --- | --- |
| 无 | N/A | 仅前台模式，无需配置 | ★★★★★ |
| OpenCode | 原生 ACP | 支持一键安装和百炼配置 | ★★★★★ |
| OpenClaw | 内置 ACP 桥接 | 支持一键安装和百炼配置 | ★★★★★ |
| Qoder | 原生 ACP | 支持一键安装，需用户配置 | ★★★★★ |
| Kimi Code | 原生 ACP | 支持一键安装，需用户配置 | ★★★★★ |
| Hermes | 原生 ACP | 支持一键安装，需用户配置 | ★★★★☆ |
| CodeBuddy | 原生 ACP | 支持一键安装，需用户配置 | ★★★★☆ |
| Codex | 外部 ACP 适配 | 支持一键安装本体与适配器，需用户配置 | ★★★★☆ |
| Claude Code | 外部 ACP 适配 | 支持一键安装本体与适配器，需用户配置 | ★★★★☆ |

推荐指数综合反映当前集成完整度、兼容性和实际验证程度：五星表示已经过充分测试的
推荐集成，四星表示正在开发或尚未完成同等范围验证。

## 一键安装

未安装的后台 Agent 可用统一命令安装到本机：

```bash
qwenaudio install codex
```

安装前先检测，**只补齐缺失的组件**：原生 ACP 后台装好即可用；本体缺失时装本体；
本体已装、仅缺 ACP 适配器时只装适配器；全部就绪时直接提示已可用。桌面版设置页
的“后台 Agent”列表中，未安装且支持一键安装的后台行尾会显示“安装”按钮，与 CLI
使用同一份安装逻辑。

查看当前可用的后台 Agent：

```bash
qwenaudio setup
```

该命令只检查，不会安装、下载或验证凭据。只检查指定后台或获取机器可读结果：

```bash
qwenaudio setup --backend codex
qwenaudio setup --json
```

## 选择后台

`AGENT_PROTOCOL` 是可选配置。留空时，Gateway 以仅前台模式运行，实时语音聊天
保持可用；需要后台执行的请求会返回明确说明，不会创建任务或猜测执行结果。
也可以在命令行中使用 `qwenaudio --backend none`，明确要求仅启动前台模式。

```dotenv
AGENT_PROTOCOL=openclaw
```

OpenCode 和 OpenClaw 支持自动下载安装；配置 `DASHSCOPE_API_KEY` 和
`QWEN_AUDIO_AGENT_BACKEND_MODEL` 后即可自动接入百炼模型。其他后台需先安装并完成
原生配置，qwen-audio-agent 会复用其用户级模型、工具、MCP、Skill 和认证。

使用其他支持 ACP stdio 的 Agent：

```dotenv
AGENT_PROTOCOL=acp
ACP_COMMAND=your-agent
ACP_ARGS=["--acp"]
```

命令、参数、显示名称和工作目录可分别通过 `ACP_COMMAND`、`ACP_ARGS`、
`ACP_LABEL` 和 `ACP_WORKSPACE` 配置。通用 ACP 入口不提供一键安装，请自行安装。

## 权限模式

`QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE` 可设为：

- `native`（默认）：权限由后台 Agent 自己判断和询问，Gateway 只负责原样转发。
- `full`：启动时明确授予最高权限，后台可直接执行命令、读写文件，不再逐次确认。

`full` 当前支持 OpenCode、Qoder、Kimi Code、Hermes、CodeBuddy、Codex 和
Claude Code，Gateway 会自动批准这些后台发起的权限请求。OpenClaw 的执行授权受
exec approvals、elevated 等配置约束，无法由统一开关表达，选择 `full` 时
Gateway 会明确拒绝启动。最高权限会放大误操作风险，只应在可信项目中启用。

## 后台常驻

希望个人助理长期在线时，可以安装为用户后台服务：

```bash
qwenaudio gateway install    # 安装并立即启动
qwenaudio gateway status
qwenaudio gateway restart
qwenaudio gateway stop
qwenaudio gateway start
qwenaudio gateway uninstall
```

后台服务每次启动都会重新读取 `config.env`，修改配置后执行 `gateway restart`
即可生效。

各后台的高级配置（可执行文件路径、工作目录、模型覆盖等）见
[配置说明](../configuration.md)。
