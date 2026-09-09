# 远程连接与配对

手机、另一台电脑上的桌面版或 TUI / WebUI 都可以连接电脑上的 Gateway。
客户端负责输入输出，Gateway 和后台 Agent 仍在原主机上工作；不需要桌面版充当中转。

> 这些步骤对应 `main` 开发版。请先确认 Gateway 与客户端都包含远程配对功能。

## 1. 选择连接方式

Gateway 默认只监听 loopback，并只信任字面量 loopback Host/Origin。远程请求必须先
通过 Gateway 访问认证，才能进入 HTTP 或 WebSocket 业务接口。不要把 Gateway 的
loopback 端口直接暴露到公网。

远程 Client 始终连接一个普通 HTTPS/WSS Gateway Endpoint。网络如何把这个 Endpoint
转发到本机 Gateway，与 Gateway 的客户端配对和设备授权是两层独立能力。目前支持：

- **Private Tailnet**：适合个人电脑。Gateway 主机和远程设备都安装官方 Tailscale，
  登录同一 Tailnet；Gateway 调用系统 `tailscale serve` 发布私有 HTTPS 地址。
- **外部 HTTPS**：适合有可信证书的服务器。用户自行配置反向代理、固定 IP 或域名，
  Gateway 只记录它的公开 Origin，不接管网络、代理或证书。

## 2. 启动访问入口

使用 Tailnet 前，先安装并登录官方 Tailscale。前台运行：

```bash
qwenaudio gateway --tailnet
```

命令会等待 `tailscale serve` 输出私有 HTTPS 地址，并在 Gateway 退出时停止本次发布。
需要后台常驻可执行 `qwenaudio gateway install --tailnet`，或写入 `config.env`：

```dotenv
QWEN_AUDIO_GATEWAY_TAILNET=1
```

外部 HTTPS 模式由用户先完成反向代理，再向 Gateway 声明准确的公开 Origin：

```bash
qwenaudio gateway --public-url https://voice.example.com
```

或写入 `config.env`：

```dotenv
QWEN_AUDIO_GATEWAY_PUBLIC_URL=https://voice.example.com
```

固定 IP 具备受信任的 IP 地址证书时，也可以直接填写 `https://<固定 IP>`。Endpoint 必须
是 HTTPS Origin，不能包含凭据、路径、查询参数或片段。反向代理必须只接受 HTTPS、正确
转发 WebSocket、保留公开 `Host`，并将流量转发至本机 `127.0.0.1:3101`。
建议同时设置 `Forwarded` 或 `X-Forwarded-For`。带有转发头的请求不会获得本机免认证待遇，
仍需配对或访问凭据；这些头不会用来推断用户身份。不要同时移除公开 `Host` 和所有转发头，
否则 Gateway 无法将代理请求与真正的本机请求区分。

Tailnet 只有在 `tailscale serve status --json` 确认私有 HTTPS 根路径指向当前 Gateway 后才会
标记就绪；终端中的登录或授权链接不代表发布成功。首次授权请通过官方 Tailscale 完成。

## 3. 配对客户端

Endpoint 就绪后，在 Gateway 主机的另一个终端执行：

```bash
qwenaudio gateway pair
```

命令输出短时、一次性的二维码、连接码和浏览器地址。Desktop、Mobile 等客户端只消费
同一种连接码，不感知 Endpoint 来自 Tailscale 还是外部代理。使用
`qwenaudio gateway devices` 查看已配对客户端，使用
`qwenaudio gateway revoke <设备 ID>` 撤销设备。

桌面版在“设置 → 应用程序 → Gateway”粘贴完整连接链接，点击“应用”即可配对并连接。
同一输入框也接受本机或已配对的远程 Gateway 地址，不需要另外设置“远程连接”。

远程访问不会绕过 Gateway 认证：除一次性配对页外，远程业务请求必须携带已
配对设备凭据。

## 连接后怎么检查

- 在客户端确认 Gateway 已连接，再检查语音前台状态；配对成功不等于模型凭据有效。
- 手机首次使用需允许麦克风权限。Tailscale 只解决网络可达性，不代替 Gateway 配对。
- 第二个客户端接管后，原客户端断开是预期行为，不是 Gateway 退出。
- 连接码过期或已使用时，在 Gateway 主机重新执行 `qwenaudio gateway pair`。
- Tailnet 地址不可达时，先检查两端 Tailscale 在线且属于同一 Tailnet，再检查策略和 HTTPS 发布状态。

客户端操作见[移动端](../getting-started/mobile.zh.md)与[桌面版](../desktop/overview.zh.md#远程连接)。
其他错误见[故障排查](troubleshooting.zh.md)。

## 高级认证与反向代理

配置一个个人访问密钥：

```dotenv
QWEN_AUDIO_GATEWAY_ACCESS_TOKEN=替换为至少24字符的随机密钥
```

可用 `openssl rand -base64 32` 生成随机密钥。该密钥只用于 Gateway 访问认证，
不要写入 URL、GCP 消息或公开日志。

原生 Client 使用 Bearer Token；浏览器 Client 可先发起一次带认证的 HTTP 请求，换取
`HttpOnly`、`SameSite=Strict` 会话 Cookie。通过外部 HTTPS 反向代理提供浏览器界面时，
Gateway 保持监听 loopback，并精确配置公开 Origin：

```dotenv
HOST=127.0.0.1
QWEN_AUDIO_AGENT_ALLOWED_ORIGINS=https://voice.example.com
```

例如，原生 TUI 可通过环境变量连接远程 Gateway，无需把密钥放进 URL：

```bash
QWEN_AUDIO_AGENT_URL=https://voice.example.com \
QWEN_AUDIO_GATEWAY_CLIENT_TOKEN="$ACCESS_TOKEN" \
qwenaudio tui
```

`qwenaudio gateway pair` 创建的连接码由远程 Client 通过 `POST /api/access/pair`
换取可撤销设备令牌。已配对设备可通过
`GET /api/access/devices` 列出，并通过 `DELETE /api/access/devices/:id` 撤销；
管理接口仅允许本机访问。

多个可信 Origin 使用英文逗号分隔。高级宿主可用 JSON 数组把不同访问密钥映射到
不同用户身份：

```dotenv
QWEN_AUDIO_AGENT_ACCESS_KEYS='[{"token":"替换为足够长的随机密钥","owner_id":"user_alice","label":"Alice"}]'
```

每个用户只有一个活动 Client 租约。第二个 Client 默认被拒绝；相同
`client.instance_id` 的重连，或显式协商 `session.takeover` 的接管可以替换旧 Client。
接管会关闭旧连接，并用租约代次阻止旧 Socket 的迟到消息生效。

`QWEN_AUDIO_AGENT_AUTH_SECRET` 只用于签署本地和远程会话身份，不是远程访问密码，
绝不能发送给 Client。

`QWEN_AUDIO_AGENT_ACCESS_TOKEN` 暂时保留为两种配置的旧别名。新配置应使用上面的宿主与
Client 独立名称，避免把 Client 凭据误当作 Gateway 服务端配置。
