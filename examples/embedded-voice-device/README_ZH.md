# 嵌入式语音设备入口

[English](README.md)

本示例通过公开 Gateway WebSocket 协议接入内存有限的原生语音设备，将较大的
`audio.delta` 拆分，并为慢速设备提供有界发送缓冲。它不替换 Gateway、
修改语音服务实现，也不包含硬件音频驱动。

具体硬件固件应放在独立项目中。本入口提取自一个 ESP32-C3 语音伴侣应用，反复开关
麦克风及长时间网络行为仍需硬件验收，自动测试不能代表生产可靠性。原始硬件接入及
固件见 [Qwen 语音豆社区页面](https://ai-passport.folotoy.cn/plays/233/)。

## 运行

在仓库安装依赖 `npm ci`，在同一电脑启动 Gateway，按正常流程配置语音服务和后台
Agent。Gateway 保持仅监听本机回环地址，入口是 Gateway 的可信本地客户端，为入口单独配置至少 24 字符的私有
`DEVICE_ACCESS_TOKEN`。
不要将真实令牌写入源码或直接粘贴到终端命令中。

```sh
# 先在私有环境中配置 DEVICE_ACCESS_TOKEN。
GATEWAY_URL=http://127.0.0.1:18888 \
  node examples/embedded-voice-device/gateway.mjs
```

入口默认监听 `127.0.0.1:3101` 并要求 bearer 认证。可信局域网设备需要显式设置
`DEVICE_HOST=0.0.0.0`；端口可用 `DEVICE_PORT` 调整。设备连接
`ws://电脑IP:3101/api/realtime`，通过 `Authorization: Bearer …` 请求头认证。
上游地址必须为回环地址。入口共享本地 Gateway 权限，不提供独立设备配对、身份隔离
或撤销能力；需要这些能力时应使用 Gateway 原生配对接入。

设备无法输入令牌时，可显式设置 `DEVICE_ALLOW_TOKEN_FREE=1`，仅关闭设备入口认证，
上游仍然只连接回环地址。任何能够连接免令牌入口的人都能使用 Gateway 并产生模型费用；仅在
隔离、可信的局域网使用。本示例使用明文局域网 WS，不可直接暴露到公网。入口拒绝
浏览器 Origin 请求头及最小健康检查以外的 HTTP 路由。

## 设备协议要点

遵循公开的 `qwen-audio-agent/gateway-client-protocol`。每台设备使用稳定且唯一的
`client.instance_id`，重复身份可能替换已有连接。`session.hello` 声明 `input.audio`
与 `playback.receipts`；等待 `session.ready` 和 `voice.ready` 后再采集，使用服务公告
的输入、输出采样率。

- 单声道 PCM16LE 编码为 base64，通过 `input_audio_buffer.append` 上传。建议使用
  20 毫秒等小块，避免大内存分配，默认不保存录音。
- 增量解码 `audio.delta`。入口将单个 base64 音频字段限制为 4096 字符，保留响应 ID，
  拆分后的事件 ID 保持唯一。
- 扬声器实际开始、排空、取消时发送 `playback.started`、`playback.ended` 和
  `playback.cancelled`，网络接收完成不等于播放完成。
- 半双工设备播放时暂停麦克风上传，恢复前排空采集缓冲，避免上传扬声器回声。
  本例不提供 AEC 或自动语音打断。
- 关麦时取消回答、发送 `input.mute`，丢弃采集和播放队列并拒绝迟到音频；开麦时先
  发送 `wake` 和 `input.unmute`，再上传新录音。仅切换本地上传标记不能同步后端输入
  和休眠状态。设备应利用响应 ID 或采集代次隔离迟到回复。
- 语音服务暂时断开时，保留 Gateway 连接并等待 `voice.ready`，不要将服务恢复与
  Wi-Fi 断开混淆。

设备拥塞时仍持续读取上游，保证 WebSocket Ping/Pong 正常处理。GCP `session.ping`
原样绕过音频队列；声明 `session.heartbeat` 的设备须自行回复对应的 `session.pong`，
入口不会替设备应答应用层心跳。其他排队事件保持原有顺序。上游有效关闭码及原因保持
透传；客户端收到 `4001`（被替换）、`4002`（被占用）、`4003`（被撤销）时不应自动重试。

应用队列上限 2 MiB，WebSocket 消息上限 1 MiB；
超限会关闭连接，避免无界内存增长。这些只是示例限值，不保证吞吐或实时性。
状态日志不包含音频或令牌。

## 测试

```sh
npm run test:embedded-voice-device
```

测试使用本地模拟上游，无需模型密钥或模型调用，覆盖强制/可选令牌、路由及 Origin
拒绝、暂停恢复消息顺序、拆分后 PCM 完整重组，以及读端暂停时的 600000 字节突发。
回归测试还覆盖模拟拥塞期间的心跳、队列超限、关闭码透传，以及公共 Gateway 客户端
收到终止状态后停止重连。
真实麦克风、扬声器回声、Wi-Fi 中断和固件恢复需要在目标设备验证。
