# awesome-claude-code 推荐表单草稿

> 该列表禁止 PR 提交，必须用 Web UI Issue 表单：
> https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml
> 注意：表单必须人工在浏览器填写（官方明确禁止 gh CLI 提交）。
> 本项目 1900+ stars，远超 100 stars 收录门槛。

## Resource name

qwen-audio-agent

## Resource link

https://github.com/QwenAudio/qwen-audio-agent

## Recommended section

Remote Control, Notifications & Voice I/O

## Description（按列表风格：描述性、无 emoji、单段、不推销）

A realtime full-duplex voice runtime that drives Claude Code via the
claude-code-acp adapter (Codex, OpenCode, and other ACP agents are also
supported), so spoken conversations continue while the agent reads files
and runs tools instead of pausing. Simple questions are answered
immediately by a front model, heavier requests are delegated to Claude
Code as async tasks whose results flow back into the same conversation,
and permission prompts arrive as voice confirmations. Ships a macOS
desktop app with a floating orb, a terminal TUI, and a web UI; barge-in
is handled with explicit cancellation state, and idle sessions sleep
behind a local sherpa-onnx wake word with no cloud calls. Apache-2.0.

## Disclosure（表单中主动披露作者身份）

Disclosure: I am a maintainer of this project.
