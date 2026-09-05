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
                         └── 本机 Endpoint 或 Gateway 托管的 tsnet Funnel
```

## 架构边界

1. **远程访问模块**由 Gateway 持有，使用可选 tsnet 组件将本机 Gateway 发布为规范的
   HTTPS/WSS Endpoint；不开启时不下载、不启动。
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
- Gateway 管理入口开启远程访问；首次打开网页完成授权。Desktop 展示二维码，CLI 打印
  或导出短时邀请。Client 不安装、也不集成底层远程访问实现。
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
  "secure": true
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

原生 Client 使用 Authorization Header；远程 WebUI 使用 HttpOnly、SameSite Cookie。
移动端的本地 WebView 无法给 WebSocket Upgrade 设置 Header，因此在 TLS 内使用第二个
WebSocket subprotocol 值承载可撤销设备凭据，服务端只选择并回显公开的 GCP subprotocol。
凭据不进入 URL、GCP 消息、日志或模型上下文。

## RA0 — 固化远程接入契约

- [x] 合并中英文 Roadmap，并关联 issue #320。
- [x] 定义 Endpoint、Connection Profile 与邀请契约。
- [x] 为已有 loopback、Token、配对、租约与接管行为补齐 characterization。
- [x] 明确管理请求不占用活动交互 Client 租约。

完成条件：Tailscale 实现细节不进入 GCP、Realtime、Task、BackendPort 或 Client。

## RA1 — Endpoint 与 Connection Profile

- [x] 增加带版本的 Connection Profile Store 与 Credential Store Port。
- [x] 服务端访问配置和 Client 设备凭据分别管理。
- [x] 发布创建和消费邀请的共享 Helper。

完成条件：任意原生 Client 可以通过统一 Connection Profile 保存并重新连接。

## RA2 — Gateway 托管 tsnet

- [x] 将 tsnet 作为 Gateway 远程访问模块的可选进程，独立于 Desktop 与 CLI 生命周期。
- [x] 首次开启时按平台下载并校验组件，通过网页完成一次授权，状态持久化后自动恢复。
- [x] 使用 Funnel 发布 HTTPS/WSS Endpoint，同时保持 Gateway Listener 只监听 loopback。
- [x] 增加 CLI status、enable、disable、invite、设备列表与撤销命令。
- [ ] 在真实手机上验证 GCP WebSocket 与长时间音频连接。

完成条件：用户无需编辑 Gateway 配置、复制 Token 或暴露 LAN/公网 Listener，即可开启
远程访问，电脑和手机都无需安装额外网络客户端。

## RA3 — 第一方远程 Client 对齐

- [x] 给参考 Client Profile 增加 `mobile`，移除 Gateway 中驱动行为的 Client 类型白名单。
- [x] 增加最小未认证浏览器配对壳；所有业务 API 与应用页面继续受保护。
- [x] 远程 WebUI 使用 HttpOnly Session，并能安全重连。
- [x] Desktop 与 TUI 可以消费邀请，并将可撤销凭据保存在普通设置之外（Desktop 使用
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

完成条件：手机通过公网 HTTPS Endpoint 完成一次配对后，后续可自动重连，并完成与 WebUI 相同的
核心对话和 Task 流程。

## RA5 — 加固与发版准备

- [x] 增加远程未认证、Origin 绕过、邀请过期/重放、设备撤销和旧租约的反例测试。
- [ ] 测试 Funnel、Wi-Fi/蜂窝切换、电脑休眠/唤醒、Gateway 重启，以及
  一小时 WebSocket/音频会话。
- [x] 对 Desktop、WebUI、TUI 与 Mobile 执行统一协议 Conformance。
- [x] 增加 macOS、Windows、Linux、iOS 与 Android 构建检查；真实设备场景仍按上一项
  执行。
- [x] 参考路径可复现后更新中英文用户手册与开发构建说明。

完成条件：远程路径安全失败、恢复后不重复输入或播报，并且不影响本机零配置体验。

## PR 规则

- 每个实现 PR 关联 issue #320，并标注 RA 阶段。
- 协议/Core、tsnet 远程模块与 Mobile UI 尽量保持独立评审。
- 每个公开模型同时提交 Schema、Parser、反例测试和中英文文档。
- 远程访问模块不得改变 Gateway Task、Realtime、BackendPort 或 GCP 行为。
- Client 不得把凭据正文存入普通设置、日志、URL、二维码历史或模型可见上下文。
