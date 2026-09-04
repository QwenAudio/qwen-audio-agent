# iOS Gateway Client 基础层

这个 Swift Package 是
[RA4 — Mobile Client](../../docs/roadmap/gateway-remote-access.zh.md#ra4--mobile-client)
的第一块原生 iOS 实现。它先落地麦克风与 UI 接入之前必须具备的安全边界：

- 在本地解析带版本的 `qwaudio://connect#...` 邀请，不把 URL fragment 发送给服务器；
- 拒绝已过期、夹带额外字段或远程非 HTTPS 的 Gateway 地址；
- 使用短时、一次性配对码请求 `/api/access/pair`；
- Connection Profile 只保存凭据引用，可撤销的设备 Token 使用 iOS Keychain 的
  `AfterFirstUnlockThisDeviceOnly` 级别保存；
- 通过认证后的 `/api/realtime` WebSocket，以 `mobile` 身份发送
  `session.hello` 并协商 GCP 6.0。

这个 Package 刻意不包含 Realtime Provider API Key、后台 Agent 配置、公网 Relay
或厂商私有设备协议。手机必须通过文档中的 Tailscale 路径（或安全性等价的私有部署）
访问 HTTPS Gateway，不能把 loopback Gateway 直接暴露到公网。

## 接入

在 Xcode 中把 `mobile/ios` 添加为本地 Swift Package，然后处理深链：

```swift
let invitation = try GatewayInvitationCodec.decode(url)
let credentials = KeychainGatewayCredentialStore()
let profiles = UserDefaultsGatewayProfileStore()
let outcome = try await GatewayPairingClient().pair(
    invitation: invitation,
    device: GatewayDevice(id: deviceID, label: UIDevice.current.name),
    clientInstanceID: clientInstanceID,
    credentialStore: credentials,
    profileStore: profiles
)
```

后续连接时不需要展示或复制 Token：

```swift
let client = GatewaySessionClient()
let ready = try await client.connect(
    profile: outcome.profile,
    credentialStore: credentials,
    configuration: GatewaySessionConfiguration(clientInstanceID: clientInstanceID)
)
```

宿主机在本地创建邀请：

```bash
qwenaudio gateway remote enable
qwenaudio gateway remote invite
```

配对前需要在 Gateway 宿主机和 iPhone 上安装并登录 Tailscale。邀请短时有效且只能
使用一次；手机丢失时，在宿主机执行 `qwenaudio gateway remote revoke DEVICE_ID` 撤销。

## 验证

```bash
cd mobile/ios
swift test
```

Package 面向 iOS 17 及以上；同时声明 macOS 13 仅用于在本地和 CI 中运行纯编解码、
配对、持久化及握手模型测试。

## 后续范围

RA4 后续还需要独立提交完整 iOS App：扫码、麦克风采集、音频播放与打断、文本及文件
输入、Task 与权限界面、断线 Replay、显式接管，以及可复现的签名开发构建。这些内容
应继续保持为可独立评审的改动。
