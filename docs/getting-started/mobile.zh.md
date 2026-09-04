# 移动端

移动端是 WebUI 的原生展示形态：Gateway 和后台 Agent 仍运行在你的电脑上，手机只负责
麦克风、扬声器、文本/图片输入和界面。它与 Desktop、WebUI、TUI 使用同一套 Gateway
Client Protocol，不直接接触 Realtime Provider 或后台协议。

> 当前提供 iOS/Android 开发构建，尚未发布到应用商店。

## 连接

1. 在电脑和手机上安装并登录 [Tailscale](https://tailscale.com/download)，加入同一
   tailnet。
2. 在电脑上启动 Gateway，然后启用远程访问：

   ```bash
   qwenaudio gateway remote enable
   qwenaudio gateway remote invite
   ```

3. 打开移动端，扫描命令或桌面设置页显示的配对码。也可以粘贴 `qwaudio://connect…`
   链接。
4. 首次通话时允许麦克风权限。以后会自动重连；若 Desktop/WebUI/TUI 正在使用，移动端
   会先请求接管确认。

邀请短时有效且只能使用一次。配对后使用独立、可撤销的设备凭据；可以在电脑端执行
`qwenaudio gateway remote devices` 查看设备，并用
`qwenaudio gateway remote revoke <设备 ID>` 撤销。

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
