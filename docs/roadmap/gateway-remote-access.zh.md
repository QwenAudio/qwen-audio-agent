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
                         └── 本机、Tailscale、手动或未来 Relay Endpoint
```

## 架构边界

1. **Endpoint 发布**负责让本地 Gateway 可达，并返回规范的 HTTPS/WSS Endpoint。
   Tailscale 是第一个 Publisher；手动反向代理和未来官方 Relay 复用同一个接口。
2. **访问认证**发生在 GCP 之前。字面量 loopback 保持零配置；任何非 loopback 的
   HTTP 或 WebSocket 请求都必须携带配置密钥或已配对设备凭据。
3. **GCP Session**承载媒体、输入、Task、权限、Client Event、Client Action、历史、
   回放与接管，不知道 Endpoint 如何发布。
4. **Client 展示**持有平台 I/O 与 UI。Client 类型只用于诊断；行为由协商后的
   capability 决定，不能由类型分支决定。

Tailscale 名称、命令、身份和 Header 不得进入 Gateway Core、GCP 信封、模型上下文、
Task 状态或 BackendPort。宿主侧 Endpoint Publisher 可以调用 Tailscale，最终只返回
普通 Gateway Endpoint。

## 用户体验

- 本机 Client 继续零配置连接 `http://127.0.0.1:3101`。
- 宿主管理入口开启远程访问并创建短时邀请。Desktop 展示二维码，CLI 打印或导出。
- 远程 Desktop、TUI、WebUI 或 Mobile 消费同一种邀请，换取可撤销设备凭据，并保存到
  平台安全存储。
- 可以配对多台设备，但每个用户只有一个活动交互 Client。第二个 Client 必须询问用户，
  确认后才协商 `session.takeover`。
- 相同 `client.instance_id` 的断线重连自动完成；不同 Client 接管后不得互相重连抢占。

普通用户不需要复制 Token、编辑 URL 或执行网络命令；手动 Endpoint 与环境变量只作为
高级逃生入口保留。

## 共享公开模型

Endpoint 描述只表达可达地址，不进入 GCP：

```json
{
  "url": "https://gateway.example.ts.net",
  "transport": "websocket",
  "secure": true,
  "publisher": "tailscale"
}
```

Connection Profile 只保存安全存储引用，不保存凭据正文：

```json
{
  "id": "phone",
  "gateway_url": "https://gateway.example.ts.net",
  "device_id": "device_example",
  "credential_ref": "platform-secure-store-key",
  "client_instance_id": "mobile_example"
}
```

邀请不包含永久 Token、模型密钥、用户记忆或后台配置：

```json
{
  "version": 1,
  "gateway_url": "https://gateway.example.ts.net",
  "pairing_code": "short-lived-one-time-code",
  "expires_at": 1780000000000
}
```

原生 Client 使用 Authorization Header；浏览器在打开 WebSocket 前，把认证换成
HttpOnly、SameSite Cookie。

## RA0 — 固化远程接入契约

- [x] 合并中英文 Roadmap，并关联 issue #320。
- [x] 定义 Endpoint、Connection Profile、邀请与 Publisher 契约。
- [x] 为已有 loopback、Token、配对、租约与接管行为补齐 characterization。
- [x] 明确管理请求不占用活动交互 Client 租约。

完成条件：实现远程接入不需要在 Gateway Core 增加 Tailscale 或 Mobile 分支。

## RA1 — Endpoint 发布与 Connection Profile

- [x] 增加宿主侧 `GatewayEndpointPublisher` 契约和 Registry。
- [x] 实现 local 与 manual Publisher。
- [x] 增加带版本的 Connection Profile Store 与 Credential Store Port。
- [x] 服务端访问配置和 Client 设备凭据分别管理。
- [x] 发布创建和消费邀请的共享 Helper。

完成条件：任意宿主可以发布 Endpoint，任意原生 Client 可以通过 Provider 无关的
Connection Profile 保存并重新连接。

## RA2 — Tailscale Publisher

- [x] 实现 Desktop 与 CLI 共用的 Tailscale Adapter。
- [x] 使用机器可读输出检测安装、登录、网络就绪、主机名与发布状态。
- [x] 使用专属 Gateway Endpoint 启停，不覆盖用户已有的其他 Tailscale Serve 配置，
  同时保持 Gateway Listener 只监听 loopback。
- [x] 增加 CLI status、enable、disable、invite、设备列表与撤销命令。
- [ ] 在确定最终 Serve 模式前验证 GCP WebSocket 长连接，并保留 tailnet 直连回退。

完成条件：用户无需编辑 Gateway 配置、复制 Token 或暴露 LAN/公网 Listener，即可开启
Tailscale 远程访问。

## RA3 — 第一方远程 Client 对齐

- [x] 给参考 Client Profile 增加 `mobile`，移除 Gateway 中驱动行为的 Client 类型白名单。
- [x] 增加最小未认证浏览器配对壳；所有业务 API 与应用页面继续受保护。
- [x] 远程 WebUI 使用 HttpOnly Session，并能安全重连。
- [x] Desktop 与 TUI 可以消费邀请，并将可撤销凭据保存在普通设置之外（Desktop 使用
  操作系统保护存储；缺少跨平台系统钥匙串接口的终端 Client 使用仅当前用户可读文件）。
- [x] 统一 occupied、接管确认、replaced、revoked、offline 与 reconnecting 状态。

完成条件：Desktop、WebUI 与 TUI 在本机和远程模式下通过同一套 Conformance Suite。

## RA4 — Mobile Client

- [ ] 只复用公开 Gateway Client SDK 与 capability profile，不导入 Gateway、Realtime、
  ACP、A2A 或 Electron 内部实现。
- [ ] 支持二维码/Deep Link 配对与安全凭据存储。
- [ ] 支持实时麦克风、音频播放、语音打断、静音、文本、图片/文件、对话历史、Task
  卡片、权限与后台追问响应、重连/回放和显式接管。
- [ ] 语音与文字输入共用同一个对话模型。
- [ ] 产出可复现的 iOS、Android 开发构建，并说明外部 Tailscale 前置条件。

完成条件：同一 tailnet 中的手机完成一次配对后，后续可自动重连，并完成与 WebUI 相同的
核心对话和 Task 流程。

## RA5 — 加固与发版准备

- [ ] 增加远程未认证、Origin 绕过、邀请过期/重放、设备撤销和旧租约的反例测试。
- [ ] 测试 Tailscale 直连与中继、Wi-Fi/蜂窝切换、电脑休眠/唤醒、Gateway 重启，以及
  一小时 WebSocket/音频会话。
- [ ] 对 Desktop、WebUI、TUI 与 Mobile 执行统一协议 Conformance。
- [ ] 在具备平台工具链时增加 macOS、Windows、Linux、iOS 与 Android 构建检查。
- [ ] 参考路径可复现后再更新用户手册。

完成条件：远程路径安全失败、恢复后不重复输入或播报，并且不影响本机零配置体验。

## PR 规则

- 每个实现 PR 关联 issue #320，并标注 RA 阶段。
- 协议/Core、Tailscale 宿主集成与 Mobile UI 不放进同一个评审单元。
- 每个公开模型同时提交 Schema、Parser、反例测试和中英文文档。
- Endpoint Publisher 不得改变 Gateway Task、Realtime、BackendPort 或 GCP 行为。
- Client 不得把凭据正文存入普通设置、日志、URL、二维码历史或模型可见上下文。
