# 故障排查

先区分问题在哪一层：**客户端 → Gateway → 语音前台 / 后台 Agent / 前台工具**。
Gateway 连通不代表模型已经连上；后台显示已安装也不代表凭据有效。

## 先收集基本信息

确认客户端与 Gateway 的版本、运行方式，以及使用的语音前台和后台 Agent。
CLI 可执行：

```bash
qwenaudio --version
qwenaudio doctor
qwenaudio setup
```

`doctor` 是开发版的只读诊断：不启动模型、后台或麦克风，也不自动修改配置。
`setup` 检查后台程序与接入组件，不会验证登录、API Key 或剩余额度。
没有活动语音会话时，诊断会注明尚未验证语音连接；仍需实际完成一次对话。

## 连接与配置

| 现象 | 检查与处理 |
| --- | --- |
| Gateway 未连接 | 确认服务已启动，客户端地址与实际端口一致。桌面运行时和 CLI 默认独立，不要查错实例。 |
| Gateway 已连接，但语音前台异常 | 检查前台服务地址、凭据、额度和 Provider 错误。不要仅凭悬浮球动画判断连通。 |
| 修改配置后没变化 | 用 `qwenaudio config` 找准确路径，检查环境变量 / 源码 `.env.local` 覆盖，并重启实际 Gateway。 |
| `gateway restart` 提示未安装服务 | 该命令只管理用户后台服务。终端运行时退出重启；桌面版点击应用或退出重开。 |
| 客户端被占用或接管 | 同一用户在一个 Gateway 上只有一个活动连接；确认接管或关闭另一客户端。 |

运行方式见[Gateway 指南](gateway.zh.md)，目录见[配置总览](../configuration.zh.md)。

## 麦克风与播放

| 现象 | 检查与处理 |
| --- | --- |
| 没有收音 | 检查应用 / 浏览器的麦克风权限、系统输入设备、静音与休眠状态。 |
| 插拔耳机后异常 | 先确认系统输入输出已切换到目标设备；仍异常时重开该客户端，并记录设备型号与插拔顺序。 |
| 有文字但没有声音 | 检查系统输出设备与音量、客户端播放状态；本地语音服务还需检查其 TTS 日志。 |
| 扬声器回声误打断 | Linux / Windows TUI 优先用半双工；无 AEC 的全双工请佩戴耳机。 |
| 远程浏览器拿不到麦克风 | 使用可信 HTTPS 入口并允许权限，不要用普通远程 HTTP 地址。 |

详细音频模式见[TUI](../getting-started/tui.zh.md)。休眠是隐藏并停止向语音前台送麦克风输入，
保持 Realtime 连接；桌面唤醒词检测在启用后本地运行。

## 后台与工具

- 后台执行失败：用 `qwenaudio setup --backend <名称>` 检查安装；再用后台自己的入口检查登录和模型配置。
- 没指定后台模型：Gateway 不负责猜测默认模型，使用 Agent 自身配置。
- 显式模型覆盖失败：后台必须提供 ACP 标准模型配置且接受目标值，否则应按错误提示处理；不要假设静默回退。
- MCP 命令找不到：检查 `command` 与 PATH。新装命令后重新启动 Gateway；后台服务执行 `gateway restart` 刷新路径缓存。
- MCP 变量缺失：放入该 Gateway 使用的 `config.env`，不要依赖另一个终端的临时 `export`。
- 资料库打不开或导入失败：确认已开启，路径属于 Gateway 主机；复杂文档还要求可用的隔离转换能力。

详见[MCP 配置](../reference/frontend-mcp.zh.md)与[资料库](../guides/knowledge.zh.md)。

## 远程连接

先确认两端官方 Tailscale 在线、同一 Tailnet 且访问策略允许，再检查 Gateway 的 HTTPS
发布是否就绪。配对码是短时一次性的；失效后在主机重新生成，不要重复使用旧二维码。
外部 HTTPS 模式则检查证书、反向代理与 WebSocket 转发。步骤见[远程连接](remote-access.zh.md)。

## 日志与反馈

桌面版从“设置 → 应用 → 日志”打开日志目录。CLI 默认日志在
`~/.config/qwaudio/logs`；桌面版在其应用数据目录的 `logs` 下。

开发版可按单轮记录整理时间线：

```bash
qwenaudio doctor --turn <turnId>
```

范围和限制见[只读诊断](../configuration/advanced.zh.md#只读诊断)。
提交 [Issue](https://github.com/QwenAudio/qwen-audio-agent/issues/new/choose) 时，附上版本、
操作系统、客户端 / Gateway 运行方式、复现步骤、发生时间及相关日志片段。
**不要附 API Key、配对码、设备令牌、完整配置文件或未经检查的私密对话。**
