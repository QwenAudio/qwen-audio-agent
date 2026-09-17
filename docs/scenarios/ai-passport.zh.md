# AI Passport 语音客户端

AI Passport（ESP32-C3）卡片运行“千问语音豆（Qwen Voice Bean）”，通过局域网使用
qwen-audio-agent。卡片负责录音、播放回复和角色动画，电脑上的 Gateway 负责实时对话、
工具调用与可选的后台 Agent 任务。

## 演示

> 建议开启声音观看。**受硬件限制，参考设备目前仅开放半双工模式**：播放回复时暂停
> 麦克风上传，不支持说话自动打断回复。

<video controls playsinline preload="metadata" style="width: 100%; max-width: 320px; border-radius: 12px;">
  <source src="https://github.com/user-attachments/assets/0af4ce90-ee59-4950-9d0b-cfc5a7d5c7d1" type="video/mp4">
</video>

## 核心特点

- 使用硬件麦克风、扬声器、按键和屏幕，替代桌面或浏览器界面。
- 通过局域网传递 Gateway 客户端协议（GCP）消息，设备转发器为卡片拆分音频小包。
- 普通 Gateway 沿用已有语音前台、工具与后台 Agent 配置。

## 接入方式

卡片不直接连接 Gateway，而是通过局域网连接电脑上的设备转发器，再由转发器连接本机 Gateway。

| 组件 | 职责 |
|---|---|
| 千问语音豆固件 | 在 AI Passport 卡片上负责 Wi-Fi 配网、录音播放、半双工控制、按键和动画。 |
| 设备转发器（`device-relay.mjs`） | 监听电脑局域网端口 `3101`，校验设备令牌、拆分音频小包并转发 GCP 消息。 |
| qwen-audio-agent Gateway | 监听同机 `127.0.0.1:18888`，负责实时对话、工具和可选的后台任务。 |

设备转发器与 Gateway 是同一电脑上的两个独立进程，分别负责卡片传输与对话任务处理。

## 运行示例

按[快速开始](../getting-started/quickstart.zh.md)配置普通 Gateway。在仓库根目录
安装依赖，并使用本机回环端口启动：

```bash
npm ci
node cli/bin/qwenaudio.mjs gateway run --url http://127.0.0.1:18888
```

另开一个终端，复制并编辑转发器配置：

```bash
cp examples/ai-passport/.env.example examples/ai-passport/.env.local
```

将 `DEVICE_ACCESS_TOKEN` 设为至少 24 字符的私有令牌，显式设置 `DEVICE_HOST=0.0.0.0`
允许可信局域网访问；本例使用 `GATEWAY_URL=http://127.0.0.1:18888` 和 `DEVICE_PORT=3101`，
避免转发器与 Gateway 端口冲突。设备令牌不是模型 API Key。

```bash
npm run example:ai-passport
```

从[硬件社区](https://ai-passport.folotoy.cn/plays/233/)安装固件，然后在卡片上填写电脑的
局域网 IP 和相同设备令牌。参考固件连接 `ws://电脑局域网IP:3101/api/realtime`。
连接前，先断开同一 Gateway 用户的其他对话客户端。

电脑需保持唤醒，防火墙需允许端口 `3101`。本例使用明文 WebSocket，仅用于可信局域网，
请保持令牌校验开启，不要将转发器暴露到公网。

## 半双工体验与限制

短按确认键开启麦克风，说出请求后等待回复播放结束，再开始下一次说话；按下键可手动打断。
播放时暂停麦克风上传，当前设备不提供回声消除（AEC）或语音自动打断。

## 源码与致谢

- [示例与协议说明](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/ai-passport/README_ZH.md)：完整配置步骤、音频传输与测试说明。
- [外部固件源码](https://github.com/liutaocode/esp32demo/tree/main/examples/qwen-voice-bean)：硬件驱动、交互和角色界面。
- [Tao Liu](https://github.com/liutaocode)实现固件、硬件交互、角色界面及设备转发器；[Li Xu](https://github.com/x-lixu)维护框架侧接入与文档。[FoloToy 社区](https://ai-passport.folotoy.cn/plays/233/)提供固件分发。
