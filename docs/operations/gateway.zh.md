# Gateway 运行与常驻

Gateway 连接语音前台和后台 Agent，并向客户端提供对话接口。可以选择一种运行方式：

| 方式 | 启动 | 退出或停止 |
| --- | --- | --- |
| 终端前台运行 | `qwenaudio` 或 `qwenaudio gateway` | 原终端按 `Ctrl-C`。 |
| 用户后台服务 | `qwenaudio gateway install` 安装并立即启动 | `qwenaudio gateway stop`；卸载用 `gateway uninstall`。 |
| 桌面内置 Gateway | 打开桌面应用，由应用启动和管理 | 退出应用会停止它自己启动的 Gateway，不关闭借用或远程服务。 |

## 修改配置后生效

- **终端运行**：在运行 Gateway 的终端按 `Ctrl-C`，再执行原启动命令。
- **后台服务**：执行 `qwenaudio gateway restart`。未安装服务时，这条命令会报“后台服务尚未安装”。
- **桌面版**：在设置页修改后点击“应用”；直接编辑文件后退出并重新打开应用。
  皮肤、唤醒等客户端设置不应要求重启 Gateway。
- **远程连接**：修改和重启实际运行的 Gateway；本机配置不会改变远程服务器。

后台服务不会保留只在某个终端临时 `export` 的凭据。持久设置写入
`qwenaudio config` 显示的 `config.env`。

## 后台服务命令

```bash
qwenaudio gateway install
qwenaudio gateway status
qwenaudio gateway restart
qwenaudio gateway stop
qwenaudio gateway start
qwenaudio gateway uninstall
```

服务启动时重新读取配置。`install`、`start` 和 `restart` 会刷新用户命令搜索路径缓存，
使 Homebrew、npm、uv 或版本管理器安装的 Agent / stdio MCP 命令能够被发现。

## 实例与客户端

同一运行时目录只允许一个 Gateway。默认情况下，CLI、TUI、WebUI 使用 CLI 的实例；
桌面版运行时目录独立，可以同时启动另一个实例。两者共享配置、记忆和工作区，
但不共享任务、运行锁和日志。具体路径见[配置总览](../configuration.zh.md#配置与数据目录)。

同一 Gateway 中，每个用户只有一个活动客户端；接管会断开原连接。不要把
“多个 Gateway 实例”和“同一 Gateway 的多个客户端”混在一起。

## 后台进程的所有权

Gateway 负责关闭自己启动的后台进程。复用 Agent 的用户配置，不等于连接或关闭用户
已经运行的进程。OpenClaw 显式配置外部 Gateway 时只连接该服务，不负责其生命周期；
详见[OpenClaw 配置](../backends/configuration.zh.md#openclaw)。

## 检查运行情况

- 用 `qwenaudio gateway status` 查看用户后台服务状态。
- 用 `qwenaudio doctor` 检查当前配置和连接；诊断不会启动模型或麦克风。
- 日志路径与轮转见[本地日志](../configuration/advanced.zh.md#本地日志)。
- 手机或其他电脑连接见[远程连接与配对](remote-access.zh.md)。
