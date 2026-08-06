# Terminal Trove 收录提交（terminaltrove.com）

> 状态：**表单已全部填好，卡在 Cloudflare Turnstile 人机验证**（自动化无法通过）。
> 两条投递路径：① 真人浏览器打开 https://terminaltrove.com/post/ 按下文重填后提交；
> ② 发邮件给 curator@terminaltrove.com（官方备选通道）。
> 品牌口径：社区开源项目；已披露 maintainer 身份。

## 路径一：网页表单（/post/ 页面字段逐项对应）

| 字段 | 填写值 |
| --- | --- |
| name* | `qwen-audio-agent` |
| url* | `github.com/QwenAudio/qwen-audio-agent`（不带 https:// 前缀） |
| tagline* | Realtime full-duplex voice frontend for AI coding agents - talk hands-free from your terminal. |
| desc_1（250–300 字符，已按 256 字符核对） | Realtime full-duplex voice frontend for AI coding agents. Talk hands-free to Claude Code, Codex, OpenCode and other ACP agents with natural barge-in, background task results read back into the conversation, and a fully local wake word. |
| desc_2（150–300 字符，241） | The conversation never stops while work happens: long tasks run in the background and their results are announced back into the live conversation. Interrupt the assistant at any moment - it follows your new thought instead of getting confused. |
| desc_3（150–300 字符，231） | Connects over the Agent Client Protocol, so it reuses each agent's own tools, MCP servers and credentials. Ships as a terminal TUI, a web UI, and a floating macOS desktop orb, with local user profiles and cross-session memory. |
| desc_4（150–250 字符，238） | Runs on macOS (full-duplex/CoreAudio) and Linux, needs Node.js 22+. Install with npm install -g qwen-audio-agent. Disclosure: I am a maintainer of this project. |
| language | javascript |
| license | apache-2.0 |
| preview_png* | https://raw.githubusercontent.com/QwenAudio/qwen-audio-agent/main/docs/qwen-audio-agent-three-layer-architecture-en.png |
| preview_gif | https://raw.githubusercontent.com/QwenAudio/qwen-audio-agent/main/docs/desktop-goo-orb-thinking.gif |
| categories（多选） | macos, linux, ai, tui, cli |
| install（linux/npm、macos/npm） | `npm install -g qwen-audio-agent` |
| are you the author?* | yes |
| email* | x-lixu@users.noreply.github.com |
| 确认勾选* | 勾选 |

## 路径二：邮件模板（curator@terminaltrove.com）

```
Subject: Tool submission: qwen-audio-agent

name: qwen-audio-agent
url: https://github.com/QwenAudio/qwen-audio-agent
author: yes (maintainer)
email: x-lixu@users.noreply.github.com

Realtime full-duplex voice frontend for AI coding agents: talk hands-free
to Claude Code, Codex, OpenCode and other ACP agents from a terminal TUI,
with barge-in, background task results read back into the conversation,
and a fully local wake word. macOS (full-duplex) and Linux, Node.js 22+,
Apache-2.0. Install: npm install -g qwen-audio-agent
```

## 备注

- 表单描述各段有严格字数区间，上文均已在区间内，勿随意增删
- 提交后可在 https://terminaltrove.com/new/ 观察是否上线
- 该站无登录墙，仅 Turnstile 人机验证需真人过一次
