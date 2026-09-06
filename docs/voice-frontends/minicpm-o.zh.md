# 使用 MiniCPM-o Realtime 前台

qwen-audio-agent 可以连接用户自行运行的
[MiniCPM-o 4.5 Realtime 服务](https://github.com/OpenBMB/MiniCPM-o-Demo)，作为本地语音前台。
Gateway 不负责安装模型或管理推理进程。请先按照上游部署文档启动服务，并确认其公共
Gateway 健康可用，再启动 qwen-audio-agent。

该接入面向官方 Audio Full-Duplex WebSocket 协议：

```text
ws://127.0.0.1:8006/v1/realtime?mode=audio
```

服务就绪后配置 Provider 和地址：

```bash
QWEN_AUDIO_REALTIME_PROVIDER=minicpm-o
MINICPM_O_REALTIME_URL=ws://127.0.0.1:8006/v1/realtime?mode=audio
```

默认地址假设上游 Gateway 以 `--http` 方式监听本机回环地址；TLS 部署请改为对应的
`wss://` 地址。经过带认证的反向代理时，可用 `MINICPM_O_AUTH_TOKEN` 配置 Bearer 令牌。
桌面版可在“语音前台 → MiniCPM-o”中填写相同配置。

Adapter 会把客户端的 16-bit PCM 转换成协议要求的 16 kHz 单声道 float32 输入，将 24 kHz
单声道 float32 输出转换回 16-bit PCM，并把 MiniCPM-o 的 Session 和响应事件映射到统一的
Realtime Runtime。

MiniCPM-o 当前公开的 Realtime 协议没有定义对话项、结构化 Function Call、客户端主动
触发回复或输入转写事件。因此该接入聚焦本地实时语音对话；文字输入、历史转写恢复、
主动播报、记忆写入和后台 Agent 工具在此 Provider 下暂不可用。客户端能够获得的内容
仍会保留在本地 UI 聊天记录中。
