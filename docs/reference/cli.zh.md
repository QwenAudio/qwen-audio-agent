# CLI 命令速查

安装后可在任意目录运行 `qwenaudio`。源码开发时，在仓库根目录使用 `npm run cli -- <命令>`。

## 配置与诊断

| 命令 | 用途 |
| --- | --- |
| `qwenaudio --version` | 查看 CLI 版本 |
| `qwenaudio config` | 显示配置路径，文件缺失时创建模板 |
| `qwenaudio config show` | 显示已配置的语音 Provider、模型及可选模型，不显示凭据 |
| `qwenaudio config set --realtime-model ID` | 修改当前 Provider 的模型配置 |
| `qwenaudio doctor` | 只读检查配置、连接与状态 |
| `qwenaudio doctor --json` | 输出诊断 JSON |
| `qwenaudio doctor --turn ID` | 从本机日志整理某一轮时间线 |
| `qwenaudio setup` | 检测所有后台的接入准备情况 |
| `qwenaudio setup --backend qwen --json` | 检测指定后台并输出 JSON |

`config show` 显示的是配置，不是线上模型探测；`setup` 不验证后台账号或额度。修改模型后需[应用配置](../operations/gateway.zh.md#修改配置后生效)。

## Gateway

| 命令 | 用途 |
| --- | --- |
| `qwenaudio` / `qwenaudio gateway` | 在当前终端运行 |
| `qwenaudio gateway --backend qwen` | 本次启动选择 Qwen Code |
| `qwenaudio gateway --backend none` | 本次启动仅前台模式 |
| `qwenaudio gateway install` | 安装并启动用户后台服务 |
| `qwenaudio gateway start` / `stop` / `restart` | 管理已安装的后台服务 |
| `qwenaudio gateway status` | 查看可达性与本机服务状态 |
| `qwenaudio gateway uninstall` | 移除用户后台服务，不删除用户数据 |
| `qwenaudio gateway --lan` | 开放可信局域网入口 |
| `qwenaudio gateway --tailnet` | 通过系统 Tailscale Serve 开放私有入口 |
| `qwenaudio gateway --webrtc` | 启用已安装的可选 WebRTC 扩展 |

`gateway stop/restart` 不用于结束或重启另一个终端中的前台进程；该进程在原终端用 `Ctrl-C` 停止。后台服务从 `config.env` 读取后台配置，不接受 `--backend` 覆盖。

`--lan` 和 `--tailnet` 互斥，均可用于 `gateway install`。普通远程连接不需要 WebRTC。

## 客户端与配对

| 命令 | 用途 |
| --- | --- |
| `qwenaudio tui` | 连接 Gateway 并打开语音终端 |
| `qwenaudio tui --audio-mode half` | Linux / Windows 半双工 |
| `qwenaudio tui --audio-mode full` | Linux / Windows 无 AEC 全双工，建议耳机 |
| `qwenaudio tui --takeover` | 显式接管当前用户的活动连接 |
| `qwenaudio webui` | 在浏览器打开 Gateway 页面 |
| `qwenaudio webui --no-open` | 只打印页面地址 |
| `qwenaudio gateway pair --name "My phone"` | 在 Gateway 主机签发连接码和二维码 |
| `qwenaudio gateway pair --endpoint https://voice.example.com` | 使用指定的远程入口生成连接码 |
| `qwenaudio gateway devices` | 列出配对设备 |
| `qwenaudio gateway revoke DEVICE_ID` | 撤销指定设备凭据 |
| `qwenaudio connect '完整连接码'` | 为 TUI 保存连接地址和凭据 |
| `qwenaudio disconnect` | 忘记 TUI 保存的连接；不撤销服务端设备 |

`--url URL` 可指定 Gateway 地址，`--session ID` 可供 TUI / WebUI 选择前台会话。客户端命令不会启动后台 Agent 或改变 Gateway 模型。WebUI 请直接打开连接码，或使用 `--url`；它不读取 TUI 保存的连接配置。

连接码是凭据，不要提交到脚本仓库或截图公开。详见[远程连接](../operations/remote-access.zh.md)。

## 后台与 Skills

```bash
qwenaudio install qwen
qwenaudio skill install owner/repo --list
qwenaudio skill install owner/repo --skill skill-name
qwenaudio skill list
qwenaudio skill remove skill-name
qwenaudio skill update
```

`install` 只安装组件，后台登录与模型配置仍由用户完成；`skill` 只安装到后台。详见[后台设置](../configuration/backend.zh.md)和[Skills](../guides/skills.zh.md)。

完整参数以当前版本 `qwenaudio --help` 为准。TUI 内使用 `/help`，不是把 CLI 命令当作聊天输入。
