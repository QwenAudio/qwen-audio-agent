# Custom Conversation Client

This minimal text client demonstrates the replaceable UI boundary. It connects
to the public `WS /api/realtime` endpoint and imports only published package
entries—no WebUI, desktop, or Gateway internals.

```bash
node examples/custom-conversation-client/client.mjs \
  http://127.0.0.1:18888 \
  "你好，请介绍一下自己。"
```

Use the same event contract to add microphone PCM input, `audio.delta`
playback, multimodal `file` parts, or Task cards. The Gateway remains the
foreground Chatbot; the client owns only conversation I/O and presentation.

这个最小文本客户端用于演示可替换 UI 边界：它连接公开的
`WS /api/realtime`，且只导入发布包入口，不依赖 WebUI、桌面版或 Gateway 内部代码。
座舱面板、客服工作台等自定义 UI 可以在同一协议上增加麦克风 PCM 输入、
`audio.delta` 播放、多模态 `file` part 与 Task 卡片；Gateway 仍负责前台对话，
客户端只负责对话输入输出与呈现。
