# 移动端

移动端是 WebUI 的原生展示形态：Gateway 和后台 Agent 仍运行在你的电脑上，手机只负责
麦克风、扬声器、文本/图片输入和界面。它与 Desktop、WebUI、TUI 使用同一套 Gateway
Client Protocol，不直接接触 Realtime Provider 或后台协议。

> 当前提供 iOS/Android 开发构建，尚未发布到应用商店。

## 连接

1. 在电脑上启动 Gateway，然后启用远程访问：

   ```bash
   qwenaudio gateway remote enable
   ```

   第一次开启时，Gateway 会准备可选远程组件并给出一个网页授权地址。按页面提示，将
   Gateway 加入你的私有 Tailnet。电脑端不需要另外安装 Tailscale。
2. 在手机安装并登录官方 Tailscale App，加入与 Gateway 相同的 Tailnet。
3. 授权完成后创建邀请：

   ```bash
   qwenaudio gateway remote invite
   ```

4. 命令会同时输出二维码、客户端接入链接和浏览器访问链接。移动端可直接扫码或粘贴
   接入链接；桌面版在设置中粘贴同一个接入链接；不安装客户端时可打开浏览器访问链接。
5. 首次通话时允许麦克风权限。以后会自动重连；若 Desktop/WebUI/TUI 正在使用，移动端
   会先请求接管确认。

邀请短时有效且只能使用一次。远程访问的开启、邀请和设备管理统一由 Gateway CLI
负责，客户端只消费邀请。配对后使用独立、可撤销的设备凭据；可以在电脑端执行
`qwenaudio gateway remote devices` 查看设备，并用
`qwenaudio gateway remote revoke <设备 ID>` 撤销。

默认远程地址只在私有 Tailnet 内可达，并优先建立设备间直连；在受限网络下，Tailscale
可能自动使用 DERP 中继。需要临时公网入口时，可显式使用
`qwenaudio gateway remote invite --mode funnel`。两种模式下 Gateway 业务接口都受配对
凭据保护。底层机制、授权要求和高级排障见
[远程访问安全](../configuration/advanced.zh.md#远程访问安全)。

## 开发构建

```bash
npm ci
npm run mobile:sync
npm run mobile:ios
# 或
npm run mobile:android
```

iOS 构建需要完整 Xcode；Android 构建需要 JDK 21 和 Android SDK。`mobile:sync` 会先构建
本地 Web 资源，再同步到 Capacitor 原生工程。Gateway 地址必须是 HTTPS；移动端不会把
设备凭据降级发送到明文 WebSocket。

GitHub 的 `Mobile` 工作流会保存 Android debug APK 和 iOS Simulator App，便于在没有
本地原生工具链时下载验收。iOS 真机安装仍需要 Apple 开发签名。
