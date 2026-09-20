# TUI 终端

先[启动 Gateway](../operations/gateway.zh.md)，再在另一个终端运行：

```bash
qwenaudio tui
```

远程连接先[导入连接码](../operations/remote-access.zh.md#_3-连接客户端)。TUI 不会替你选择或启动后台 Agent。

## 平台差异

| 平台 | 默认模式 | 打断方式 |
| --- | --- | --- |
| macOS | 带回声消除的全双工 | 直接说话 |
| Linux / Windows | 半双工 | 输入 `/interrupt` |

## 常用操作

| 操作 | 命令 / 按键 |
| --- | --- |
| 发送文字 | 输入后按回车 |
| 静音 / 恢复麦克风 | `/mute`（或 `/m`） |
| 半双工手动打断 | `/interrupt`（或 `/x`） |
| 查看帮助 | `/help`（或 `/h`） |
| 浏览历史 | `PageUp` / `PageDown` |
| 退出 TUI | `/exit` 或 `Ctrl-C` |

静音不取消后台工作，也不关闭结果播报。退出 TUI 不等于关闭独立运行的 Gateway。

## 终端布局

TUI 使用全屏双区布局：上方显示可滚动的对话、语音转写、任务状态与连接日志，
下方固定显示 Gateway / 麦克风状态和文本输入栏。异步消息和断线重连不会打断
正在编辑的文本。使用 `PageUp` / `PageDown` 浏览对话记录，按 `Ctrl-C` 可随时退出。

## 文本与附件输入

TUI 在语音之外也支持文本、图片和普通文件：

- 直接在底部输入栏输入文字并按回车发送。
- 直接粘贴本地文件路径，TUI 会立即将图片显示为 `[Image N]`，将普通文件显示为
  `@完整路径`，并暂存为下一轮附件。
- 文字中的 `@文件路径` 会作为附件随本轮请求发送。
- 输入 `/mute` 可静音或恢复麦克风，输入 `/help` 可查看全部命令。

暂存附件既可以随底部输入栏的文本发送，也可以随下一轮语音输入发送；删除输入栏
中的附件锚点会同步取消该附件。

附件内容由 TUI 读取并上传给 Gateway，不要求 Gateway 能访问你的本地路径。单个附件上限为 8 MB，单轮合计 12 MB。前台获得附件引用，需要时把原始内容交给后台；不会因粘贴了图片就自动具备视觉理解能力。处理方式见[对话与附件](../guides/conversation.zh.md)。

## macOS

macOS 始终使用 CoreAudio AEC 全双工：播报期间持续收音，支持直接说话打断，
无需额外配置。CoreAudio 辅助程序默认编译到
`~/Library/Caches/qwaudio/tui/macos-voice-io`，首次启动时自动构建。若缺少 Swift 编译器，先安装 Xcode Command Line Tools（`xcode-select --install`）。

## Linux / Windows

默认通过随包提供的 Python 音频桥接使用 `sounddevice` / PortAudio 半双工：
播放回复时麦克风会暂停，可输入 `/interrupt` 手动打断，播放结束或打断后恢复。
首次使用前需准备 Python、`sounddevice` 与可用的 PortAudio 库。把 `sounddevice` 安装到 TUI 实际使用的 Python 环境：

```bash
python -m pip install sounddevice
```

Linux 默认调用 `python3`，Windows 默认调用 `python`；可通过 `PYTHON` 指定解释器的绝对路径。Linux 如提示找不到 PortAudio，使用系统包管理器安装相应运行库。

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
[配置说明](../configuration.zh.md)。
