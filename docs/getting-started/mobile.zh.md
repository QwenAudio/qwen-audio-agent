# 移动端

移动端是 WebUI 的原生展示形态：Gateway 和后台 Agent 仍运行在你的电脑上，手机只负责
麦克风、扬声器、文本/图片输入和界面。它与 Desktop、WebUI、TUI 使用同一套 Gateway
Client Protocol，不直接接触 Realtime Provider 或后台协议。

> 当前提供 iOS/Android 开发构建，尚未发布到应用商店。

## 获取测试包

打开 [GitHub Actions → Mobile](https://github.com/QwenAudio/qwen-audio-agent/actions/workflows/mobile.yml?query=branch%3Amain)，
选择 `main` 上成功的构建，在 Artifacts 下载 `mobile-android-debug-apk`。
解压后将 APK 传到 Android 手机安装；如系统询问，允许本次安装来源。
下载 Actions 产物通常需要登录 GitHub，产物过期时需重新构建或使用下方的源码构建流程。

`mobile-ios-simulator-app` 是 **iOS 模拟器** 产物，不能直接安装到 iPhone。
iPhone 真机测试需使用 Xcode 与开发签名。当前没有应用商店正式包。
配对步骤对应开发版，建议 Gateway 与 App 使用同一批代码。

## 连接

1. 在电脑和手机上安装官方 Tailscale，登录同一 Tailnet，然后在电脑上启动：

   ```bash
   qwenaudio gateway --tailnet
   ```

   服务器也可以自行配置带可信证书的 HTTPS 反向代理；代理在另一台机器时，Gateway
   使用 `--lan` 启动。
2. 在电脑的另一个终端生成连接码：

   ```bash
   qwenaudio gateway pair
   ```

   使用反向代理时执行 `qwenaudio gateway pair --endpoint https://voice.example.com`。

   移动端扫描二维码或粘贴连接码；桌面版也可以使用同一个连接码。
3. 首次通话时允许麦克风权限。以后会自动重连；若其他客户端正在使用，移动端会先请求
   接管确认。

连接码包含独立、可撤销的设备凭据，只在网关主机显示一次；移动端导入后直接通过同一条
WSS 完成认证与业务，不再调用 HTTPS 配对接口。使用
`qwenaudio gateway devices` 查看设备，使用 `qwenaudio gateway revoke <设备 ID>` 撤销。
Private Tailnet 地址只在同一 Tailnet 内可达；使用外部 HTTPS Endpoint 时由用户负责证书、
反向代理和防火墙。所有方式共用同一套配对与客户端协议。底层机制和高级排障见
[远程访问安全](../operations/remote-access.zh.md)。

## 开发构建

```bash
npm ci
npm run mobile:sync
npm run mobile:ios
# 或
npm run mobile:android
```

iOS 构建需要完整 Xcode；Android 构建需要 JDK 21 和 Android SDK。`mobile:sync` 会先构建
本地 Web 资源，再同步到 Capacitor 原生工程。公网 Gateway 地址必须是 HTTPS；显式 LAN
连接允许使用带 Token 的 `ws://局域网IP`。

GitHub 的 `Mobile` 工作流会保存 Android debug APK 和 iOS Simulator App，便于在没有
本地原生工具链时下载验收。iOS 真机安装仍需要 Apple 开发签名。
