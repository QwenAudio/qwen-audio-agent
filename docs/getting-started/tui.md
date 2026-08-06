# TUI 使用注意

## 平台差异

| 平台 | 默认模式 | 打断方式 |
| --- | --- | --- |
| macOS | 带回声消除的全双工 | 直接说话 |
| Linux / Windows | 半双工 | 播报时按 `x` |

## macOS

macOS 始终使用 CoreAudio AEC 全双工：播报期间持续收音，支持直接说话打断，
无需额外配置。CoreAudio 辅助程序默认编译到
`~/Library/Caches/qwaudio/tui/macos-voice-io`，首次启动时自动构建。

## Linux / Windows

默认通过随包提供的 Python 音频桥接使用 `sounddevice` / PortAudio 半双工：
播放回复时麦克风会暂停，只支持 `x` 键手动打断，播放结束或打断后恢复。
首次使用前需安装 `sounddevice` 和系统 PortAudio。

也可以开启无回声消除的全双工模式：

```bash
qwenaudio tui --audio-mode full
```

此模式没有回声消除，请佩戴耳机，避免扬声器声音造成误识别或误打断。
不同声卡和蓝牙耳机对同时使用不同采样率的输入、输出流支持程度不同；如果持续
报告输入溢出、输出欠载或设备错误，请退出并改用 `--audio-mode half` 兜底。

## 配置

默认音频模式也可通过环境变量持久设置：

```dotenv
QWEN_AUDIO_AGENT_TUI_AUDIO_MODE=half
```

设为 `full` 等效于 `--audio-mode full`。完整参数见
[配置说明](../configuration.md)。
