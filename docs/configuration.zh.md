# 配置总览

通常只需配置语音前台凭据；要让助手办事，再选择后台 Agent。
桌面版可在设置页编辑常用项，CLI 用户通过以下命令找到配置文件：

```bash
qwenaudio config
```

命令会显示准确路径，缺失时创建模板。不要把 API Key、Token 或本地身份密钥提交到仓库。

## 最小配置

使用默认语音前台：

```dotenv
DASHSCOPE_API_KEY=your-key
```

已经安装并配置好后台时，选择它即可。例如 Qwen Code：

```dotenv
AGENT_PROTOCOL=qwen
QWEN_AUDIO_AGENT_BACKEND_MODEL=
```

后台模型留空会沿用 Agent 自己的配置；明确填写才请求覆盖。无需后台时留空或设
`AGENT_PROTOCOL=none`，前台聊天与已启用的工具仍然可用。
OpenCode / OpenClaw 的一键托管与模型覆盖限制见[后台设置](configuration/backend.zh.md)。

## 配置优先级

```text
CLI 参数 > 进程环境变量 > .env.local > .env > 用户配置文件 > 内置默认值
```

源码运行时，仓库里的 `.env.local` 或 `.env` 可能盖过用户文件。
改了配置却没生效时，先核对实际文件、进程环境和正在连接的 Gateway。

配置修改后的应用方式见[Gateway 运行与常驻](operations/gateway.zh.md#修改配置后生效)：
终端退出重启、用户后台服务执行 `gateway restart`、桌面设置点击应用。

## 配置与数据目录

默认路径如下；桌面版与 CLI 是同一个助手的不同入口，但可运行独立的 Gateway。

| 数据 | CLI | 桌面版 |
| --- | --- | --- |
| 配置、身份、记忆、清单、共享 workspace | `~/.config/qwaudio` | 与 CLI 共享 |
| Gateway 锁、任务状态、会话、日志 | `~/.config/qwaudio` | 系统应用数据目录 |
| 桌宠皮肤、窗口状态 | 不适用 | 系统应用数据目录 |

桌面系统应用数据目录：

- macOS：`~/Library/Application Support/Qwen Audio Agent`
- Windows：`%APPDATA%/Qwen Audio Agent`
- Linux：`~/.config/Qwen Audio Agent`

共享目录内的 `config.env` 保存设置；`ASSISTANT.md` 保存默认人设，
`USER.md` 保存用户偏好，`MEMORY.md` 保存长期事实。自动生成的 `state.env`
包含本地身份密钥，请勿公开。详细用法见[个性化](reference/personalization.zh.md)
与[长期记忆](reference/memory.zh.md)。

高级用户可用 `QWAUDIO_DATA_DIR` 指定共享资产目录；`QWAUDIO_CONFIG_DIR`
显式覆盖运行时目录，未另设数据目录时也用于隔离资产；`XDG_CONFIG_HOME` 影响 CLI 默认目录。
显式覆盖目录会改变默认隔离关系，不要让无关实例共用一套任务或身份文件。

升级时只补齐共享层缺失的旧桌面资产；两边都有的文件不会自动覆盖或合并。
备份前先停止使用这些目录的应用，保存配置与需要保留的数据；不要用日志轮转代替历史数据管理。

## 按需求配置

| 我要配置 | 文档 |
| --- | --- |
| 语音模型、服务地址和凭据 | [语音前台](configuration/frontend.zh.md) |
| 后台选择、安装、模型与权限 | [后台设置](configuration/backend.zh.md) |
| 联网搜索 | [搜索服务](guides/web-search.zh.md) |
| 用户文档与知识检索 | [资料库](guides/knowledge.zh.md) |
| 人设、偏好、自动记忆 | [个性化](reference/personalization.zh.md)、[记忆](reference/memory.zh.md) |
| 额外前台工具 | [MCP](reference/frontend-mcp.zh.md)、[OpenAPI](reference/frontend-openapi.zh.md) |
| 打包一套前台人设与工具配置 | [Frontend Profile](reference/frontend-profile.zh.md) |
| 远程设备、常驻服务 | [远程连接](operations/remote-access.zh.md)、[Gateway](operations/gateway.zh.md) |
| 日志与其他可选参数 | [高级设置](configuration/advanced.zh.md) |

## 继续阅读

不确定哪里出了问题时，从[故障排查](operations/troubleshooting.zh.md)开始。
