# 远程连接与配对

远程客户端只负责输入输出，Gateway 和后台 Agent 仍在电脑或服务器上运行，不需要桌面版中转。先让地址可达，再生成连接码；网络连接和设备授权是两回事。

## 1. 选择连接方式

| 场景 | 网络准备 | 启动方式 |
| --- | --- | --- |
| 同一可信局域网 | 允许设备访问电脑端口；适合原生客户端 | `qwenaudio gateway --lan` |
| 个人电脑跨网络访问 | 两端安装官方 Tailscale，加入同一 Tailnet | `qwenaudio gateway --tailnet` |
| 自有 HTTPS 服务器 | 可信证书与支持 WebSocket 的反向代理 | 启动普通 Gateway，代理转发至它 |

浏览器远程收音需要可信 HTTPS。普通局域网 HTTP 地址不能保证 WebUI 的麦克风可用；原生移动端可使用显式 LAN 连接。Gateway 主机需保持开机且不休眠。

### 局域网

```bash
qwenaudio gateway --lan
```

Gateway 监听 `0.0.0.0`，连接码使用自动选择的物理网卡 IPv4。多网卡选错时，在 `config.env` 指定：

```dotenv
QWEN_AUDIO_GATEWAY_LAN_HOST=192.168.1.20
```

替换为本机实际地址。不要把这个 HTTP 入口转发到公网。

### Tailnet

电脑和远程设备先登录同一 Tailnet，再运行：

```bash
qwenaudio gateway --tailnet
```

Gateway 调用系统 `tailscale serve` 发布私有 HTTPS 地址，退出时停止本次发布。首次 HTTPS 授权在 Tailscale 完成；看到登录链接不代表服务已就绪，以启动结果为准。

需要常驻时，用 `qwenaudio gateway install --tailnet`；LAN 对应用 `qwenaudio gateway install --lan`。两种模式不要同时开启。应用包不内嵌 Tailscale，手机也需要官方 Tailscale App。

### 自有 HTTPS 入口

代理与 Gateway 同机时，用默认的 `qwenaudio gateway`，转发到 `127.0.0.1:3101`。代理在另一台机器时，用 `--lan`，并用防火墙限制访问。

- 代理需支持 WebSocket，并保留公开 `Host`。
- 建议保留 `Forwarded` 或 `X-Forwarded-For`。不要同时抹掉公开 `Host` 和所有转发头，否则网关无法区分代理请求与本机请求。
- 配置允许的浏览器来源：`QWEN_AUDIO_AGENT_ALLOWED_ORIGINS=https://voice.example.com`。
- 固定 IP 也可以使用，但其 HTTPS 证书必须受客户端信任且覆盖该 IP。

## 2. 生成连接码

在 **Gateway 所在主机**的另一个终端执行：

```bash
qwenaudio gateway pair --name "My phone"
```

LAN / Tailnet 地址会自动使用。自有 HTTPS 入口需明确指定：

```bash
qwenaudio gateway pair --endpoint https://voice.example.com --name "My phone"
```

Endpoint 只能包含协议、主机和可选端口，不加路径或查询参数。

命令输出二维码和同一个连接链接，形如 `https://主机/c#凭据`（LAN 为 `http://IP:端口/c#凭据`）。连接码包含设备凭据，只显示一次。**每台设备分别生成，不要公开分享或贴进日志。**

## 3. 连接客户端

| 客户端 | 操作 |
| --- | --- |
| 移动端 App | 扫码或粘贴完整连接码，然后允许麦克风权限。 |
| 桌面版 | 在“设置 → 应用程序 → Gateway”粘贴完整连接码，点击“应用”。 |
| WebUI | 在浏览器打开完整链接；浏览器保存认证状态后使用页面。 |
| TUI | 先运行下面的 `connect`，再启动 TUI。 |

```bash
qwenaudio connect '粘贴完整连接码'
qwenaudio tui
```

引号不能省略，链接含有特殊字符。`connect` 保存的是 TUI 配置，不会修改 Gateway；用 `qwenaudio disconnect` 清除。桌面和移动端各自保存凭据，后续不必重新配对。

同一用户在一个 Gateway 上只有一个活动客户端。接管会断开原客户端，不会关闭 Gateway。

## 管理设备

```bash
qwenaudio gateway devices
qwenaudio gateway revoke <设备ID>
```

撤销会关闭使用该凭据的活动连接。连接码泄露、设备丢失或换机时，撤销旧设备并重新配对。

## 连接后怎么检查

- 先看 Gateway 已连接，再确认语音前台和后台状态。配对成功不代表模型 Key 有效。
- Tailnet 地址不可达：检查两端在线、同一 Tailnet、访问策略和 Serve 状态。
- LAN 地址不可达：检查网卡地址、防火墙和 `--lan` 启动方式。
- HTTPS 能打开却不能聊天：检查 WebSocket 转发、允许的 Origin 和凭据。
- 有文字没声音或无法收音：检查客户端权限、音量和安全上下文，见[故障排查](troubleshooting.zh.md)。

## 高级认证与反向代理

自定义客户端也可使用独立访问密钥，不必导入连接码：

```dotenv
# Gateway 主机的 config.env
QWEN_AUDIO_GATEWAY_ACCESS_TOKEN=替换为至少24字符的随机密钥
```

可用 `openssl rand -base64 32` 生成密钥。TUI 端使用不同的变量：

```bash
QWEN_AUDIO_AGENT_URL=https://voice.example.com \
QWEN_AUDIO_GATEWAY_CLIENT_TOKEN="$ACCESS_TOKEN" \
qwenaudio tui
```

原生客户端通过握手 Bearer Token，浏览器通过受支持的 WebSocket 子协议认证。不要把此密钥写入普通 URL、协议消息或公开日志。`QWEN_AUDIO_AGENT_AUTH_SECRET` 是内部身份签名密钥，不是客户端访问密钥。

API、身份映射和连接接管规则见[网关契约](../contract.zh.md)与[客户端协议](../gateway-protocol.zh.md)。日常使用优先选独立、可撤销的设备连接码。
