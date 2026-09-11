# Gateway 远程接入与移动端 Roadmap

> 状态：执行中
>
> GitHub 跟踪：[#320](https://github.com/QwenAudio/qwen-audio-agent/issues/320)
>
> 协议：[Gateway Client Protocol](../gateway-protocol.zh.md)

## 目标

让 Client 无论运行在 Gateway 本机、另一台电脑还是移动设备上，都能连接同一个个人
Gateway。Desktop、WebUI、TUI 与 Mobile 始终是可替换的 Client Environment，共用
同一套 GCP，不依赖具体 Realtime Provider 或 Backend Agent。

远程接入是一种部署拓扑，不是一种 Client 类型，也不是一套新业务协议：

```text
Desktop ─┐
WebUI ───┤
TUI ─────┼── GCP over WebSocket ── Gateway ── BackendPort
Mobile ──┘               ▲
                         └── 本机、LAN、Tailnet 或连接码覆盖的 Endpoint
```

## 架构边界

1. **网络模式**由 Gateway 持有：本机默认监听 loopback，LAN 显式监听 `0.0.0.0`，Tailnet
   调用用户已安装并登录的系统 `tailscale serve`。外部反向代理独立部署，只在生成连接码时
   覆盖 Endpoint。项目不内嵌或下载 Tailscale 网络栈。
2. **访问认证**发生在 GCP 之前。字面量 loopback 保持零配置；任何非 loopback 的
   HTTP 或 WebSocket 请求都必须携带配置密钥或已配对设备凭据。
3. **GCP Session**承载媒体、输入、Task、权限、Client Event、Client Action、历史、
   回放与接管，不知道 Endpoint 如何发布。
4. **Client 展示**持有平台 I/O 与 UI。Client 类型只用于诊断；行为由协商后的
   capability 决定，不能由类型分支决定。

Tailscale 名称、身份和内部事件只存在于远程访问模块，不得进入 GCP 信封、模型上下文、
Task 状态或 BackendPort。Client 最终只看到普通 Gateway Endpoint。

## 用户体验

- 本机 Client 继续零配置连接 `http://127.0.0.1:3101`。
- Gateway CLI 只提供本机、`gateway --lan` 和 `gateway --tailnet` 三种启动模式；
  `gateway pair` 直接签发可撤销设备凭据并统一输出二维码和连接码，外部代理地址通过
  `gateway pair --endpoint` 覆盖。Tailnet 模式下 Gateway 主机与远程设备都使用官方
  Tailscale 并加入同一 Tailnet。
- 远程 Desktop、TUI、WebUI 或 Mobile 消费同一种直接连接码，无需 HTTP 交换即可将独立
  设备凭据保存到平台安全存储。
- 可以配对多台设备，但每个用户只有一个活动交互 Client。第二个 Client 必须询问用户，
  确认后才协商 `session.takeover`。
- 相同 `client.instance_id` 的断线重连自动完成；不同 Client 接管后不得互相重连抢占。

Client 不需要理解 Tailscale 或反向代理实现，也不需要共享宿主级长期 Token。网络安装与登录
留在网络层，Gateway 只消费最终 Endpoint。

## 共享公开模型

Endpoint 描述只表达可达地址，不进入 GCP：

```json
{
  "version": 1,
  "url": "https://gateway.example.ts.net",
  "transport": "websocket",
  "secure": true
}
```

Connection Profile 只保存安全存储引用，不保存凭据正文：

```json
{
  "version": 1,
  "id": "phone",
  "gateway_url": "https://gateway.example.ts.net",
  "device_id": "device_example",
  "credential_ref": "platform-secure-store-key",
  "client_instance_id": "mobile_example"
}
```

直接连接码是只展示一次的传输信封，解码后包含：

```json
{
  "schema": "qwaudio.connection/v2",
  "websocket_url": "wss://gateway.example.ts.net/api/realtime",
  "device_id": "device_example",
  "credential_id": "device_key_example",
  "access_token": "per-device-secret",
  "issued_at": 1780000000000
}
```

原生 Client 使用 Authorization Header。移动端的本地 WebView 无法给 WebSocket Upgrade 设置 Header，因此在 TLS 内使用第二个
WebSocket subprotocol 值承载可撤销设备凭据，服务端只选择并回显公开的 GCP subprotocol。
凭据不进入 URL、GCP 消息、日志或模型上下文。

## RA0 — 固化远程接入契约

- [x] 合并中英文 Roadmap，并关联 issue #320。
- [x] 定义 Endpoint、Connection Profile 与配对码契约。
- [x] 为已有 loopback、Token、配对、租约与接管行为补齐 characterization。
- [x] 明确管理请求不占用活动交互 Client 租约。

完成条件：Tailscale 实现细节不进入 GCP、Realtime、Task、BackendPort 或 Client。

## RA1 — Endpoint 与 Connection Profile

- [x] 增加带版本的 Connection Profile Store 与 Credential Store Port。
- [x] 服务端访问配置和 Client 设备凭据分别管理。
- [x] 发布创建和消费配对码的共享 Helper。

完成条件：任意原生 Client 可以通过统一 Connection Profile 保存并重新连接。

## RA2 — Gateway 公开 Endpoint

- [x] 通过系统 `tailscale serve` 发布 Tailnet 私有 HTTPS/WSS Endpoint，并保持 Gateway
  Listener 只监听 loopback。
- [x] 支持在 `gateway pair --endpoint` 中使用用户维护的外部 HTTPS Origin，不把反向代理
  建模为 Gateway 启动模式。
- [x] 增加统一的 `gateway pair`、`devices` 与 `revoke` 命令，删除额外的 remote 命令层。
- [x] 保持网络发布与 Gateway 配对/设备授权彼此独立。
- [ ] 在真实手机上验证 GCP WebSocket 与长时间音频连接。

完成条件：用户无需复制长期 Token；LAN 用户主动控制监听范围，Tailnet 用户在 Gateway
主机和远程设备上安装官方 Tailscale，外部 HTTPS 用户自行维护可信代理。

## RA3 — 第一方远程 Client 对齐

- [x] 给参考 Client Profile 增加 `mobile`，移除 Gateway 中驱动行为的 Client 类型白名单。
- [x] 增加最小未认证浏览器配对壳；所有业务 API 与应用页面继续受保护。
- [x] 远程 WebUI 使用 HttpOnly Session，并能安全重连。
- [x] Desktop 与 TUI 可以消费配对码，并将可撤销凭据保存在普通设置之外（Desktop 使用
  操作系统保护存储；缺少跨平台系统钥匙串接口的终端 Client 使用仅当前用户可读文件）。
- [x] 统一 occupied、接管确认、replaced、revoked、offline 与 reconnecting 状态。

完成条件：Desktop、WebUI 与 TUI 在本机和远程模式下通过同一套 Conformance Suite。

## RA4 — Mobile Client

- [x] 只复用公开 Gateway Client SDK 与 capability profile，不导入 Gateway、Realtime、
  ACP、A2A 或 Electron 内部实现。
- [x] 支持二维码/Deep Link 配对与安全凭据存储。
- [x] 支持实时麦克风、音频播放、语音打断、静音、文本、图片/文件、对话历史、Task
  卡片、权限与后台追问响应、重连/回放和显式接管。
- [x] 语音与文字输入共用同一个对话模型。
- [x] 产出可复现的 iOS、Android 开发构建。

完成条件：手机通过私有 Tailnet HTTPS Endpoint 完成一次配对后，后续可自动重连，并
完成与 WebUI 相同的核心对话和 Task 流程。

## RA5 — 加固与发版准备

- [x] 增加远程未认证、Origin 绕过、配对码过期/重放、设备撤销和旧租约的反例测试。
- [x] 移动端在 App 重启后复用配对时持久化的 Client 实例身份，避免被误判为新客户端。
- [ ] 测试 Tailnet 直连/DERP 回退、Wi-Fi/蜂窝切换、电脑休眠/唤醒、Gateway 重启，以及
  一小时 WebSocket/音频会话。
- [x] 对 Desktop、WebUI、TUI 与 Mobile 执行统一协议 Conformance。
- [x] 增加 macOS、Windows、Linux、iOS 与 Android 构建检查；真实设备场景仍按上一项
  执行。
- [x] 参考路径可复现后更新中英文用户手册与开发构建说明。

完成条件：远程路径安全失败、恢复后不重复输入或播报，并且不影响本机零配置体验。

## PR 规则

- 每个实现 PR 关联 issue #320，并标注 RA 阶段。
- 协议/Core、公开 Endpoint 网络适配器与 Mobile UI 尽量保持独立评审。
- 每个公开模型同时提交 Schema、Parser、反例测试和中英文文档。
- 远程访问模块不得改变 Gateway Task、Realtime、BackendPort 或 GCP 行为。
- Client 不得把凭据正文存入普通设置、日志、URL、二维码历史或模型可见上下文。
