# AI Passport 语音客户端示例

[English](README.md) | 中文

在 AI Passport（ESP32-C3）硬件卡片上运行“千问语音豆（Qwen Voice Bean）”，
通过局域网使用 qwen-audio-agent。卡片负责录音、播放回复和角色动画；电脑上的
Gateway 负责实时对话、工具调用及可选的后台 Agent 任务。

本目录提供电脑端的设备转发器。卡片固件由外部项目维护，安装与源码见
[千问语音豆社区说明](https://ai-passport.folotoy.cn/plays/233/)和
[固件仓库](https://github.com/liutaocode/esp32demo/tree/main/examples/qwen-voice-bean)。

## 硬件演示

千问语音豆实机演示：语音交互与角色状态动画，建议开启声音观看。

> **受硬件限制，目前仅开放半双工模式**：播放回复时暂停麦克风上传，等播放结束后再说话。
> 不支持语音自动打断，可通过按键手动打断。

https://github.com/user-attachments/assets/0af4ce90-ee59-4950-9d0b-cfc5a7d5c7d1

## 核心特点

- **卡片交互**：使用内置麦克风、扬声器、按键和屏幕进行语音对话，展示角色状态。
- **工具与任务**：沿用 Gateway 配置的语音前台和工具；启用后台 Agent 后可委托执行任务。
- **局域网传输**：使用 Gateway 客户端协议（GCP），由设备转发器拆分音频小包并限制缓冲。

## 接入方式

本例中，卡片不直接连接 Gateway，而是连接电脑上的设备转发器，再由转发器连接本机 Gateway。

| 组件 | 本例部署位置 | 职责 |
|---|---|---|
| 千问语音豆固件 | AI Passport 卡片 | 录音播放、半双工控制、Wi-Fi 配网、按键与角色动画。 |
| [设备转发器（device-relay.mjs）](device-relay.mjs) | 电脑，`局域网IP:3101` | 校验设备令牌，将回复音频拆成小包，缓冲并转发 GCP 消息。 |
| qwen-audio-agent Gateway | 同一电脑，`127.0.0.1:18888` | 实时对话、工具及可选的后台任务。 |

电脑上需要运行**两个独立进程**。`3101` 是转发器的局域网端口，`18888` 是 Gateway 的本机端口。

## 快速开始

准备一张 AI Passport 卡片和一台电脑，让两者处于可互通的可信局域网。
以下命令均在仓库根目录执行，Node.js 版本须符合仓库要求。

### 1. 配置并启动 Gateway

安装依赖，配置语音前台：

```bash
npm ci
node cli/bin/qwenaudio.mjs config
```

按 [Gateway 快速开始](../../docs/getting-started/quickstart.zh.md)配置语音前台；
需要后台任务时，再安装并授权后台 Agent。

在第一个终端启动 Gateway，并保持运行：

```bash
node cli/bin/qwenaudio.mjs gateway run --url http://127.0.0.1:18888
```

可先打开 `http://127.0.0.1:18888`，在 WebUI 验证语音。连接卡片前先断开 WebUI 对话，
避免同一用户的活动客户端冲突。

### 2. 配置并启动设备转发器

```bash
cp examples/ai-passport/.env.example examples/ai-passport/.env.local
```

编辑 `.env.local`，填写至少 24 字符的私有 `DEVICE_ACCESS_TOKEN`，并设置：

```dotenv
GATEWAY_URL=http://127.0.0.1:18888
DEVICE_HOST=0.0.0.0
DEVICE_PORT=3101
DEVICE_ALLOW_TOKEN_FREE=0
```

`DEVICE_HOST=0.0.0.0` 让卡片可以通过局域网连接转发器。设备令牌不是模型 API Key，
卡片与转发器使用相同值；模型凭据只保存在 Gateway 配置中。不要提交包含真实令牌的 `.env.local`。

在第二个终端启动转发器，并保持运行：

```bash
npm run example:ai-passport
```

该命令只加载 `.env.local` 并启动 `device-relay.mjs`，不会启动另一个 Gateway。

### 3. 连接卡片

按[社区说明](https://ai-passport.folotoy.cn/plays/233/)安装千问语音豆固件，在卡片配网页
填写电脑的局域网 IP 和相同的设备令牌。固件会补全端口 `3101` 与 `/api/realtime`：

```text
ws://电脑局域网IP:3101/api/realtime
```

卡片上不要填写 `127.0.0.1` 或 `0.0.0.0`。电脑需保持唤醒，防火墙需允许端口 `3101`。
本例使用明文 WebSocket，仅用于可信局域网；保持令牌校验开启，不要将转发器暴露到公网。

## 使用方式

1. 开机麦克风默认关闭，短按确认键开启。
2. 说出请求，停顿后等待语音回复。
3. 播放时暂停麦克风上传；等回复结束再说话，或按下键手动打断。

上键调整音量，长按确认键进入设置；最新按键行为以社区固件说明为准。

结束使用时，先关闭卡片麦克风或断开卡片，再在两个终端分别按 `Ctrl+C` 停止转发器和 Gateway。

## 协议与测试

[设备协议说明](docs/device-protocol.zh.md)列出了 PCM 格式、播放回执、暂停恢复、心跳及重连要求。

```bash
npm run test:ai-passport
```

测试覆盖设备认证、消息转发、音频拆包、缓冲及连接恢复，不需要模型密钥。
真实录音播放和 Wi-Fi 稳定性仍需在卡片上验证。

## 作者与致谢

- [Tao Liu](https://github.com/liutaocode)：实现千问语音豆固件、硬件交互、角色界面及设备转发器。
- [Li Xu](https://github.com/x-lixu)：维护框架侧接入、协议生命周期修复、回归测试与示例文档。
- [FoloToy AI Passport 社区](https://ai-passport.folotoy.cn/plays/233/)：提供硬件平台与固件分发。
