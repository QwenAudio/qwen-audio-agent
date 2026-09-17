# AI Passport 设备协议说明

[English](device-protocol.md) · [返回示例](../README_ZH.md)

千问语音豆通过局域网发送 [Gateway 客户端协议](../../../docs/gateway-protocol.zh.md)
消息，设备转发器将消息转发给同机 Gateway。

## 会话与音频

- 每台设备使用稳定且唯一的 `client.instance_id`，重复身份可能替换已有连接。
- 在 `session.hello` 声明 `input.audio` 与 `playback.receipts`，等待 `session.ready`
  和 `voice.ready` 后再采集，使用服务公告的输入、输出采样率。
- 单声道 PCM16LE 编码为 base64，通过 `input_audio_buffer.append` 上传；建议使用
  20 毫秒等小块，避免大内存分配。
- 增量解码 `audio.delta`；转发器将单个 base64 音频字段限制为 4096 字符，保留响应 ID，
  拆分后的事件 ID 保持唯一。
- 扬声器实际开始、排空、取消时发送 `playback.started`、`playback.ended` 和
  `playback.cancelled`。收到 `audio.done` 不代表扬声器已经播放完毕。

## 半双工与打断

参考硬件目前仅开放半双工：播放时暂停麦克风上传，恢复前排空采集缓冲，避免将扬声器
回声作为新一轮用户语音上传。不提供 AEC 或语音自动打断，可通过设备按键手动打断。

用户主动暂停且需要停止当前回复时，发送 `response.cancel` 与 `input.mute`，丢弃本地
采集和播放队列，并按响应 ID 或采集代次拒绝迟到音频。`input.mute` 本身只控制麦克风
输入，不是取消播放指令。恢复时先发 `wake` 和 `input.unmute`，再上传新录音；仅切换
本地上传标记不能同步 Gateway 输入或休眠状态。

半双工录放音控制由卡片固件负责。

## 心跳与恢复

- 语音服务暂时断开时，保留 Gateway 连接并等待 `voice.ready`，不要与 Wi-Fi 断开混淆。
- 转发器在拥塞时持续读取上游，保证 WebSocket Ping/Pong 正常处理。
- 设备若协商了 `session.heartbeat`，收到 `session.ping` 后必须返回 `session.pong`，
  其 `request_event_id` 对应 ping 的 `event_id`。转发器将 ping 原样绕过音频队列，不替
  设备应答；其他排队事件保留原顺序。
- 有效上游关闭码及原因保持透传。收到 `4001`（被替换）、`4002`（被占用）、
  `4003`（被撤销）时，不应自动重试，应显示状态并等待相应用户操作。
  短暂传输故障可采用有界退避重连。

## 限值与验收

应用发送队列上限为 2 MiB，上游 WebSocket 消息上限 1 MiB，设备消息上限 64 KiB。
超限会终止连接，避免无界内存增长。这些只是示例限值，不保证吞吐或实时性。
该队列不测量物理扬声器的消耗速度，固件仍负责播放缓冲与回执。

[自动测试](../README_ZH.md#协议与测试)用于协议回归。真机还需验证反复开关麦克风、
长回复、手动打断后的迟到音频、Wi-Fi 恢复以及与其他客户端争用连接。
仅健康检查成功不能代表硬件链路已验收。
