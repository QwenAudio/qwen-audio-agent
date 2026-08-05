# Reddit 帖子草稿（r/ClaudeAI & r/ChatGPTCoding）

## Title

I built a full-duplex voice interface for Claude Code (and Codex/OpenCode) — the conversation keeps going while it works

## Body

Sharing a side project that solved a personal annoyance: every time
Claude Code starts reading files or calling tools, voice interaction
just dies — you're left staring at silence.

qwen-audio-agent is a voice runtime that sits in front of your existing
agents via ACP (Agent Client Protocol). What it actually does:

- Full-duplex voice with real barge-in. You can cut it off mid-sentence;
  playback is cancelled cleanly (I spent an embarrassing amount of time
  making sure cancelled responses don't get resurrected by late async
  events).
- The conversation doesn't pause for tasks. Simple questions get
  answered instantly; anything heavy is handed to Claude Code as an
  async task, and you keep talking. When the task finishes it just says
  so, and you can follow up with full context.
- Permission requests come through voice too — "it wants to edit X, ok?"
- Desktop app with a floating orb (macOS, Linux builds just landed),
  plus a TUI and web UI. Wake word support: it sleeps after idle but
  wakes on a local keyword-spotting model, no cloud calls while asleep.

Setup is one command (`npm install -g qwen-audio-agent`), it can install
the Claude Code ACP adapter for you. Voice stack defaults to DashScope
(Qwen's API); there's also a fully self-hosted speech-to-speech mode.

Repo: https://github.com/QwenAudio/qwen-audio-agent

Genuinely curious: anyone else experimenting with voice-driven coding
agents? The hardest unsolved problem for me is how verbose spoken
progress updates should be.

## 发布注意

- 两个板块间隔 24h 以上，避免交叉封号
- 配 demo 视频/GIF（30~60 秒，静音可懂）
- 有人在评论区问技术问题，用 FAQ 口径认真回复
