# 示例索引

示例展示如何扩展框架，不是启用对应能力的唯一方式。先完成[源码安装](../getting-started/install.zh.md#从源码安装)，再按各示例的 README 准备依赖与配置。示例通常使用独立端口，不要混用标准 Gateway 的连接地址。

| 想了解什么 | 从哪个示例开始 |
| --- | --- |
| 视觉对话、按需截图、持续观察 | [X-Omni](x-omni.zh.md)：默认 Qwen Omni，也演示 MiniCPM-o 的持续视听输入。 |
| 用 WebRTC 传输语音 | [WebRTC](../gateway-webrtc-client.zh.md)：客户端到 Gateway 的可选传输，不改变上游模型协议。 |
| 接入车内事件、设备控制和业务 Agent | [智能座舱](smart-cockpit.zh.md)。 |
| 接入硬件语音客户端 | [AI Passport](ai-passport.zh.md)。 |
| 使用外部长期记忆系统 | [VoiceMem](voicemem.zh.md)。 |
| 使用外部知识库 | [LightRAG](lightrag.zh.md)。 |
| 多场景客服与人工坐席 | [Customer Service](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/customer-service)：零售与航空场景。 |
| 评测前台与完整系统 | [Benchmark](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/benchmark)。 |

## 选择扩展位置

- 换语音模型：实现 [Realtime Provider](../voice-frontends/custom-provider.zh.md)。
- 换办事 Agent：实现 [Backend Adapter](../reference/backend-adapter-sdk.zh.md)。
- 换客户端：使用 [Gateway Client Protocol](../gateway-protocol.zh.md)。
- 增加聊天工具：配置 [MCP](../reference/frontend-mcp.zh.md) 或 [OpenAPI](../reference/frontend-openapi.zh.md)。
- 换知识库或记忆：实现对应的 [Knowledge Provider](../reference/knowledge.zh.md) 或 [Memory Provider](../reference/memory-provider.zh.md)。

示例中的业务提示词、设备动作和专用工具留在示例内。接口边界见[扩展总览](../extensions.zh.md)。
