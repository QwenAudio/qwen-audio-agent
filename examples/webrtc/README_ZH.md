# WebRTC 客户端示例

[English](README.md)

浏览器通过网关的 WebRTC 接口进行语音、文字对话，Omni 支持摄像头输入。原有 WSS 接入不变。

WebRTC 尚未发布到 npm，当前请使用源码开发方式体验。

## 正式版（npm）

安装框架和可选的 WebRTC 扩展，无需克隆仓库：

```sh
npm install -g qwen-audio-agent
npm install -g qwen-audio-agent-webrtc
qwenaudio config
qwenaudio gateway --webrtc
```

在 `qwenaudio config` 中填写 `DASHSCOPE_API_KEY`，并设置
`QWEN_AUDIO_REALTIME_PROVIDER=dashscope`。Audio 使用默认模型；Omni 将
`QWEN_AUDIO_REALTIME_MODEL` 设为 `qwen3.5-omni-plus-realtime` 后重启网关。

## 源码开发

完成项目安装后，在项目根目录执行：

```sh
npm run example:webrtc:install
export DASHSCOPE_API_KEY='your-key'  # 已配置则跳过
npm run example:webrtc
```

体验 Omni 时，先停止当前网关，再运行：

```sh
npm run example:webrtc:omni
```

## 打开演示

两种方式均访问 [Web UI](http://127.0.0.1:3101/api/realtime/webrtc/example)，点击连接并允许麦克风访问。
若使用其他端口，替换地址中的 `3101`。Omni 可开启摄像头；模型在启动时选定，页面不提供模型切换。

- 支持静音、打断、新建会话，以及相同身份和 session ID 下的历史恢复。
- 页面中的访问凭证是网关令牌，不是百炼 API Key。实际对话会消耗模型 API 额度。
- 扩展与主框架使用同一个 npm 安装目录；浏览器和普通 WSS 用户无需安装。
- 远程访问需要 HTTPS 和可达的媒体端口，必要时配置 STUN/TURN。

[协议与部署说明](../../docs/gateway-webrtc-client.zh.md)

如需屏幕、图片、按需识图和观察提醒，可体验同样支持 WebRTC 的
[X-Omni 示例](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/x-omni/README_ZH.md)。两个示例共用浏览器连接与网关媒体实现。
