# 使用 MiniCPM-o Realtime 前台

qwen-audio-agent 可以连接用户自行运行的
[MiniCPM-o 4.5 Realtime 服务](https://github.com/OpenBMB/MiniCPM-o-Demo)，作为本地语音前台。
Gateway 不负责安装模型或管理推理进程。

该接入面向官方 Audio Full-Duplex WebSocket 协议：

```text
ws://127.0.0.1:8006/v1/realtime?mode=audio
```

服务就绪后配置 Provider 和地址：

```bash
QWEN_AUDIO_REALTIME_PROVIDER=minicpm-o
MINICPM_O_REALTIME_URL=ws://127.0.0.1:8006/v1/realtime?mode=audio
```

Adapter 会把客户端的 16-bit PCM 转换成协议要求的 16 kHz 单声道 float32 输入，将 24 kHz
单声道 float32 输出转换回 16-bit PCM，并把 MiniCPM-o 的 Session 和响应事件映射到统一的
Realtime Runtime。

MiniCPM-o 当前公开的 Realtime 协议没有定义结构化 Function Call 和输入转写事件。因此第一版
聚焦本地实时语音对话；依赖前台工具调用的能力在该 Provider 下暂不可用。
