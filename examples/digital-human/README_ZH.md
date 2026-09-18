# 数字人 Example

**状态：待评审的设计方案，尚无可运行 demo。** 本轮只交付文档，确认后再提交、推送，由后续开发者实现。

基于 GitHub `main` 的 WebRTC PR #465，基线提交 `9ad6348f`，设计日期 2026-09-18。

## 目标

- 客户端只连接 qwen-audio-agent 网关。
- Realtime 模型继续负责理解、对话和回复语音，模型侧仍用 WSS。
- `DigitalHumanProvider` 只消费助手回复音频，文本是可选增强，不承担 ASR、LLM、TTS 或 S2S。
- 首个具体 demo 复用 OpenAvatarChat 的 FlashHead Avatar 组件，在独立 Python GPU 服务中运行 SoulX-FlashHead Lite。
- 以 LiveAvatar Avatar Only / LITE 校验抽象，不要求首版实现 LiveAvatar 或引入其 SDK。
- 专用依赖、适配器、安装脚本及部署文件都放在本 example，不加入主框架默认依赖。

## 阅读顺序

1. [架构设计](docs/design.zh.md)：职责、链路、框架扩展点、会话及部署边界。
2. [Provider 契约](docs/provider-contract.zh.md)：输入输出、生命周期、媒体接口，以及两个具体 Provider 的映射。
3. [开发与验收计划](docs/implementation-plan.zh.md)：OpenAvatarChat 接入步骤、依赖隔离、里程碑及测试清单。

这三份文档是本轮评审依据。目录中其他设计和 ADR 为历史草案，不应按其中的浏览器直连 Renderer 路线实施。

## 实施范围

框架需要补充轻量的呈现接口和视频下行能力；“不增加框架依赖”不代表“完全不改框架”。实际厂商实现留在 example，通过启动时注入接入。

先在 Mac 上完成真实 WebRTC 音视频通路的 Mock，再连接 Linux/NVIDIA 上的 OpenAvatarChat Renderer。Mock 不是模型推理，也不是浏览器本地动嘴动画。

安装和启动命令将在实现时交付；当前不要把文档中的拟议脚本、配置字段或接口当成已经可用。
