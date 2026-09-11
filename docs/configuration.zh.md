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

产品根目录默认为 `~/.config/qwaudio`。网关和 TUI 按目录归属管理各自的数据，
不要求为每个进程建立一个独立根目录：

| 内容 | 默认路径（相对根目录） | 桌面与 CLI |
| --- | --- | --- |
| 设置、默认人设、本地身份 | `config.env`、`ASSISTANT.md`、`identity.env` | 共享 |
| 用户偏好、长期记忆、清单 | `data/USER.md`、`data/MEMORY.md`、`data/frontend-notes.json` | 共享 |
| 后台默认工作区 | `data/workspace/` | 共享，可单独指定 |
| 导入资料与索引 | `data/knowledge/` | 共享 |
| 任务、会话、日志、锁、托管后台状态 | `state/` | 每个 Gateway 独立 |
| 网关可重建缓存 | `cache/` | 可重新生成 |
| TUI 连接信息、凭据、实例锁与日志 | `tui/` | 仅终端客户端使用 |

CLI 启动的 Gateway 默认使用 `state/`；桌面代管的 Gateway 使用 `state/desktop/`。
两者共享配置、记忆与工作区，但任务、会话和运行日志各自独立。
后台 Agent 的原生 Session 由对应后台管理，不等同于工作区中的项目文件。

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `QWAUDIO_CONFIG_DIR` | 产品根目录；启动前设置 | `$XDG_CONFIG_HOME/qwaudio`，未设置 XDG 时为 `~/.config/qwaudio` |
| `QWAUDIO_DATA_DIR` | 共享用户数据 | `<config-dir>/data` |
| `QWAUDIO_STATE_DIR` | 当前 Gateway 的持久状态 | CLI 为 `<config-dir>/state`；桌面代管为 `<config-dir>/state/desktop` |
| `QWAUDIO_CACHE_DIR` | 可重建缓存 | `<config-dir>/cache` |
| `QWAUDIO_WORKSPACE` | 所有后台的默认工作区 | `<data-dir>/workspace` |

除产品根目录本身外，上述网关目录选项也可写入 `config.env`；建议使用绝对路径。
某个后台的显式工作区配置（例如 `QODER_WORKSPACE`）优先于共享工作区。
独立 Gateway 不应共享状态目录。状态并不是缓存，删除会丢失任务和会话记录。
`identity.env` 含本地身份密钥，请勿公开；备份时保留配置、数据及需要的状态。

启动只使用上述位置，不自动寻找、合并或迁移旧布局。已有项目和记忆需要保留时，
由用户显式指定数据/工作区路径或在停机后整理；旧文件不会被自动删除。

### 客户端目录

桌面客户端使用系统应用数据目录：

- macOS：`~/Library/Application Support/Qwen Audio Agent`
- Windows：`%APPDATA%/Qwen Audio Agent`
- Linux：`$XDG_CONFIG_HOME/Qwen Audio Agent`，默认 `~/.config/Qwen Audio Agent`

其中 `settings.env` 保存 Gateway 连接地址、语言、外观与唤醒偏好；
`ui-state.json` 保存窗口位置和客户端会话标识。连接凭据、`skins/`、
`cache/`（包括唤醒模型）和 `logs/` 也归客户端，Electron 自行管理浏览器存储。
设置页中的语音服务和后台 Agent 配置仍写入网关的 `config.env`。

TUI 的连接配置与凭据保存在 `<config-dir>/tui/`，默认 `~/.config/qwaudio/tui/`；
实例锁和诊断日志也放在这里。CLI 的 `connect`、`disconnect`、`tui` 命令管理这些文件，
Gateway 不读取或写入它们。

修改 `QWAUDIO_CONFIG_DIR` 时，TUI 目录随产品根目录改变；单独修改
`QWAUDIO_DATA_DIR`、`QWAUDIO_STATE_DIR` 或 `QWAUDIO_CACHE_DIR` 不影响 TUI。
如需独立指定位置，可在启动前设置 `QWAUDIO_TUI_DIR`。桌面应用目录不跟随这些变量。
WebUI 的登录状态、语言和会话标识由浏览器 Cookie / 本地存储管理。

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
