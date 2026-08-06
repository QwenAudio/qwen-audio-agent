# Show HN 帖子草稿

## Title（二选一）

- Show HN: qwen-audio-agent – Full-duplex voice interface for coding agents
- Show HN: Talk to Claude Code/Codex hands-free, with tasks running in parallel

## Body

> 直接使用 articles/voice-layer-for-coding-agents-en.md 全文作为正文。
> 该文已按 HN 调性撰写：陈述事实、无营销语、结尾抛出两个讨论问题。

## 评论区预答 FAQ（发布后第一时间自评 1~2 条）

### Q: How is this different from just using voice dictation with Claude Code?

Dictation replaces typing; this replaces the whole interaction loop.
The runtime keeps the conversation alive while the agent works: it
answers simple questions instantly, delegates real work to the backend
agent over ACP, and reports results back into the same conversation.
Barge-in is handled at the protocol level, not as a hotkey.

### Q: Does it require cloud services?

By default it uses DashScope realtime voice (a Qwen API key). There is
also a speech-to-speech frontend mode where VAD/STT/LLM/TTS can all be
self-hosted. Wake-word detection is always local (sherpa-onnx).

### Q: Which agents work best?

Native ACP backends (OpenCode, Qoder, Kimi Code) are one-click setups.
Claude Code and Codex connect through ACP adapters; both are supported
by the one-command installer.

## 发布时间建议

美西时间周二~周四 9:00~11:00（北京时间周三~周五凌晨 0:00~2:00）。
发布后 30 分钟内同步在其他渠道放链接。
