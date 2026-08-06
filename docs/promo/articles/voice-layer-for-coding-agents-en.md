# We built a full-duplex voice layer for coding agents (conversation keeps going while tasks run)

qwen-audio-agent is an open-source realtime voice runtime that sits in
front of your existing AI coding agents. It connects to backends over
ACP (Agent Client Protocol), so it works with Claude Code, Codex,
OpenCode, Qoder, Kimi Code and more, without touching the agents
themselves.

The problem we wanted to solve: today, voice interaction with agents is
walkie-talkie style. You say something, the agent goes silent while it
reads files and calls tools, then answers. The conversation stops every
time work starts.

Our model is different:

- Full-duplex speech with natural barge-in. You can interrupt at any
  time; queued playback is cancelled and the in-flight response is
  tombstoned so late async events never resurrect it.
- Front/back split. Small questions are answered instantly by a front
  model; anything that needs tools is delegated to a backend agent as an
  async task, and the voice conversation continues in parallel.
- Results flow back into the conversation. When a background task
  finishes, the agent just says "it's done" and you can follow up,
  modify, or kick off the next task, with full context intact.
- Voice wake word on desktop. After idle timeout the runtime sleeps but
  keeps the mic open with a local 3M-parameter sherpa-onnx keyword
  spotter ("no cloud call while sleeping"); saying the wake word brings
  the whole session back.

Interfaces: WebUI, terminal TUI (full-duplex on macOS), and a macOS
desktop floating orb. Linux desktop builds just landed.

Architecture notes worth sharing:

1. We only integrate over protocol, never per-product. Each backend is a
   small "driver" (command, env, capability flags); all behavioral
   differences are absorbed in one ACP adapter. Adding a new agent is
   one file plus one registry line, and the voice layer never changes.
2. Interruption is a state machine, not an event. Barge-in has to cancel
   playback queues, stop provider-side generation, and reject late
   callbacks explicitly. Most of our flakiness bugs came from async
   events arriving after cancellation.
3. Speech output is rewritten, not truncated. Every result has two
   renderings: a spoken summary and a full inline (markdown/code) view.
   Reading chat-style answers aloud never works.

It is Apache-2.0, installs with `npm install -g qwen-audio-agent`, and
runs on top of DashScope realtime voice by default (a speech-to-speech
frontend for fully local stacks is also available).

Repo: https://github.com/QwenAudio/qwen-audio-agent

We would love feedback from people who have tried to bolt voice onto
coding agents: how do you handle permission prompts over audio, and what
wake-word false-positive rates are acceptable in practice?
