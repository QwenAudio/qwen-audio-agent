# X-Omni 视觉对话

X-Omni 是独立的实时多模态交互示例，默认以 Qwen3.5 Omni 提供视觉对话、按需识图和
用户主动开启的视觉观察。面壁 MiniCPM-o 也可通过框架已有适配器进行持续视听对话。
场景工具保留在示例内，与标准客户端分离。

## 启动

使用源码仓库和项目支持的 Node.js 版本，在根目录执行：

```bash
npm ci
cp examples/x-omni/.env.example examples/x-omni/.env.local
```

填写 `DASHSCOPE_API_KEY`，然后：

```bash
npm run example:x-omni
```

打开 **http://127.0.0.1:5178**。示例使用端口 18890 的独立 Gateway，
默认仅前台模式，不复用桌面版 Gateway。

## 模型配置

Qwen 默认使用 `qwen3.5-omni-plus-realtime`；也可通过
`QWEN_AUDIO_REALTIME_MODEL=qwen3.5-omni-flash-realtime` 选择 Flash。

如已单独部署 [MiniCPM-o 服务](../voice-frontends/minicpm-o.zh.md)，
将 `.env.local` 中的前台配置替换为：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=minicpm-o
MINICPM_O_REALTIME_URL=ws://127.0.0.1:8006/v1/realtime?mode=video
AGENT_PROTOCOL=none
```

地址以实际部署为准，按需配置 `MINICPM_O_AUTH_TOKEN`，无需 DashScope Key。
客户端使用持续画面与语音输入；当前 MiniCPM-o 接口不支持文字输入、按需识图、
观察和后台工具调用。不支持的控件会禁用，不模拟执行。

其他 Omni 服务需要对应的 Realtime Provider 适配器。视觉输入不意味着同时具备
工具调用和主动回复能力，具体要求见示例 README 的兼容性表及接入说明。

## 选择采集模式

- **按需采集：** 平时仅本地预览，视觉工具请求时才采集。
  短时 Omni 读取会话检查画面，再返回文字观察。
- **持续画面：** 麦克风开启时，每秒向主 Omni 会话发送一帧，可直接询问当前画面。

先选择并授权摄像头、屏幕或图片，再尝试“看看图里有什么”“读一下屏幕上的报错”。

## 观察与解说

本节需要 Qwen 配置及其内置视觉读取器。

可以说“关注这个进度条两分钟，完成后提醒我”，或“接下来一分钟，讲解画面中有意义的变化”。
首次采样后每 10 秒采样，默认两分钟，最多十分钟、两个观察。
用状态/停止按钮，或通过对话结束观察。

观察会产生额外模型请求及费用，仅观察画面，不录像、不用于安全告警。
关闭/切换来源、切换采集模式或断开连接都会停止观察；仅静音麦克风不会。

Qwen 配置下可选接入已安装的后台，利用截图引用进一步办事。

完整配置、架构、隐私、限制和测试见
[X-Omni 示例](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/x-omni)。
