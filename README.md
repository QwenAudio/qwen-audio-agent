# Qwen Audio Agent

[中文](README_ZH.md) | [English](README.md)

[![CI](https://github.com/QwenAudio/qwen-audio-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/QwenAudio/qwen-audio-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/qwen-audio-agent)](https://www.npmjs.com/package/qwen-audio-agent)
[![node](https://img.shields.io/badge/node-%E2%89%A522.22.2-brightgreen)](https://nodejs.org/)
[![license](https://img.shields.io/github/license/QwenAudio/qwen-audio-agent)](LICENSE)
[![WeChat](https://img.shields.io/badge/WeChat-join_chat-07C160?logo=wechat&logoColor=white)](#community)

## Agent Presence

Real conversation should not leave you waiting after a single sentence, nor
should it grind to a halt just because the Agent is looking something up,
calling a tool, or working on a task.

Conversation should keep flowing, and the Agent should always be present.

That is why we built **qwen-audio-agent**—a realtime voice runtime that keeps
Agents talking, working, and present. Whether chatting with you, thinking
through a problem, or working on a task, your Agent remains in the
conversation. It listens, responds, and when the task is complete, naturally
tells you:

"It's ready."

## News

- **2026-08-06 · [v1.6.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.6.0)**
  🪟 Desktop app now officially supports Windows; 🧠 adds invisible memory with automatic extraction after each session.
- **2026-08-05 · [v1.5.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.5.0)**
  ⏰ Adds scheduled reminders and progress reporting; 🗣️ adds the voice wake word ("你好千问"); 🐧 desktop build support for Linux; the desktop app now uses a data directory isolated from the CLI.
- **2026-08-05 · [v1.4.2](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.4.2)**
  🔧 Improves desktop backend Agent installation, login, and status detection; refines long-term memory behavior.
- **2026-08-04 · [v1.4.1](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.4.1)**
  🧰 Adds one-click backend Agent install; desktop floating orb supports auto-hide and shortcut recall.
- **2026-08-04 · [v1.4.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.4.0)**
  🧠 Adds personalized rules and checklist management; desktop app supports auto-sleep and shortcut wake.
- **2026-08-03 · [v1.3.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.3.0)**
  🎙️ Adds [🤗 speech-to-speech](https://github.com/huggingface/speech-to-speech) frontend integration, supporting fully local VAD, STT, LLM, and TTS.
- **2026-08-01 · [v1.2.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.2.0)**
  ⚡ Desktop app adds auto-update, faster startup, and improved backend Agent detection.
- **2026-07-31 · [v1.1.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.1.0)**
  🤝 Adds Kimi Code CLI backend with native ACP integration.
- **2026-07-30 · [v1.0.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v1.0.0)**
  🚀 First stable release, introducing a macOS desktop app with a built-in Gateway.
- **2026-07-28 · [v0.9.0](https://github.com/QwenAudio/qwen-audio-agent/releases/tag/v0.9.0)**
  🌍 Project officially open-sourced; backend Agents unified under the ACP architecture.

## Conversation Continues, Tasks Too

Conversation doesn't stop for background tasks; when a task completes, the
result naturally returns to the current conversation:

https://github.com/user-attachments/assets/42022655-36d1-46b2-9c26-ff0765284000

### Core Features

- Full-duplex realtime voice interaction, natural interruption, and sustained multi-turn conversation
- One-click selection of your preferred coding Agent, reusing existing tools, MCP, and Skills
- Frontend conversation and background tasks run in parallel; ask about progress or cancel at any time
- Create multiple independent tasks executed asynchronously by the backend Agent, with continuous status tracking
- Task results automatically return to the current conversation, supporting follow-up questions and modifications
- WebUI, terminal TUI, and desktop floating orb (macOS / Windows / Linux)
- Local user profile and cross-session personal memory

## Architecture

![qwen-audio-agent architecture](docs/architecture-overview-en.png)

Questions that can be answered directly are answered immediately; when tools
or sustained processing are needed, the task is delegated to the backend Agent.
Throughout, the user always faces the same assistant.

<details open>
<summary>View detailed architecture</summary>

![qwen-audio-agent reference architecture](docs/qwen-audio-agent-three-layer-architecture-en.png)

For the full design and module breakdown, see the [architecture document](docs/architecture.md).

</details>

## Agent Support

| Backend Agent | Integration | Setup | Rating |
| --- | --- | --- | --- |
| None | N/A | Frontend-only mode, no config needed | ★★★★★ |
| OpenCode | Native ACP | One-click install + Bailian config | ★★★★★ |
| OpenClaw | Built-in ACP bridge | One-click install + Bailian config | ★★★★★ |
| Qoder | Native ACP | One-click install, user config required | ★★★★★ |
| Kimi Code | Native ACP | One-click install, user config required | ★★★★★ |
| Hermes | Native ACP | One-click install, user config required | ★★★★☆ |
| CodeBuddy | Native ACP | One-click install, user config required | ★★★★☆ |
| Codex | External ACP adapter | One-click install (base + adapter), user config required | ★★★★☆ |
| Claude Code | External ACP adapter | One-click install (base + adapter), user config required | ★★★★☆ |

Ratings reflect current integration completeness, compatibility, and
verification level: five stars indicate a thoroughly tested recommended
integration; four stars indicate active development or not yet fully verified.
For detailed configuration and capability boundaries, see the [configuration guide](docs/configuration.md).

## Installation

Requires Node.js 22.22.2+ or 24.15.0+, npm 10+. One-click install (recommended):

```bash
npm install -g qwen-audio-agent
```

For building from source, installing from GitHub, and obtaining a DashScope
API Key, see the [installation guide](docs/getting-started/install.md).

## Quick Start

1. Create your config and fill in the API Key:

```bash
qwenaudio config
```

```dotenv
DASHSCOPE_API_KEY=your-key
# Voice frontend model: qwen-audio-3.0-realtime-flash or qwen-audio-3.0-realtime-plus (default)
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
# Backend Agent: optional, leave empty or set to none for frontend-only mode
AGENT_PROTOCOL=openclaw
# Backend model: can be empty; if empty, uses the Agent's own user config
QWEN_AUDIO_AGENT_BACKEND_MODEL=qwen3.7-max
```

> Uses DashScope realtime voice frontend by default; alternatively, switch to a local [speech-to-speech frontend](docs/voice-frontends/speech-to-speech.md), no cloud API Key needed.

2. Start the Gateway, then open another terminal to start the TUI (or use `qwenaudio webui` for the browser UI):

```bash
qwenaudio        # Terminal 1: Gateway
qwenaudio tui    # Terminal 2: TUI
```

For full configuration options, speech-to-speech frontend setup, and TUI
platform notes, see [quick start](docs/getting-started/quickstart.md),
[voice frontends](docs/voice-frontends/speech-to-speech.md), and
[TUI notes](docs/getting-started/tui.md).

## Desktop App

The desktop app provides a floating voice orb that stays on your desktop,
with a built-in Gateway, auto-hide, shortcut recall, and voice wake word.
Download the installer for your platform from the releases page, or build
from source:

```bash
npm run desktop:build:local      # macOS
npm run desktop:build:win        # Windows
npm run desktop:build:linux      # Linux (AppImage + deb, no signing)
```

For visuals, orb behavior, and build instructions, see the [desktop documentation](docs/desktop/overview.md).

## Backend Agent

`AGENT_PROTOCOL` is optional. Leave empty for frontend-only mode; when set,
it reuses the installed Agent's user-level models, tools, MCP, Skills, and
authentication. OpenCode and OpenClaw support one-click install with Bailian
configuration.

```bash
qwenaudio setup   # View available backend Agents
```

For Agent selection, persistent background service, generic ACP entry, and
permission modes, see the [backend Agent documentation](docs/backends/overview.md).

## User Profile and Memory

User data is stored in `~/.config/qwaudio/` (`USER.md`,
`frontend-memory.json`, `tasks.json`, `logs/`), kept local only, never
committed to the repository. See [user profile and memory](docs/reference/memory.md).

## Important Notes

- Do not store passwords, API Keys, verification codes, or access tokens in the user profile or conversation.
- Microphone audio and realtime conversation are sent to the configured Realtime frontend service (DashScope or speech-to-speech).
- Background tasks may invoke the selected Agent's models, tools, MCP, and external services.
- `full` permission allows the backend to execute commands and modify files; use only in trusted projects.
- The Gateway is for local use only; do not expose it directly to the network or public internet.
- On Linux / Windows with full-duplex without echo cancellation, wear headphones.

For detailed data boundaries, see the [privacy notice](PRIVACY.md); for
network and permission configuration, see the [configuration guide](docs/configuration.md).

## Development

```bash
npm install
npm run build
npm test
```

```bash
npm run dev       # Gateway + WebUI hot reload
npm run desktop   # Desktop floating orb (macOS / Windows)
```

For more build, test, and release instructions, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Community

You can start discussions directly in [GitHub Issues](https://github.com/QwenAudio/qwen-audio-agent/issues).

For users in China, scan the QR codes below to join the WeChat group. If the
group QR code is full or expired, scan either maintainer's personal QR code
to be invited.

| WeChat Group | Personal | Personal |
| :---: | :---: | :---: |
| <img src="docs/wechat-group-qr.png" width="240" alt="WeChat group QR code"> | <img src="docs/wechat-contact-qr.png" width="240" alt="Li Xu personal WeChat QR code"> | <img src="docs/wechat-pigeon-dan-qr.png" width="240" alt="Pigeon.Dan personal WeChat QR code"> |

## Contributing and Security

- Development and contribution guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)
- Data flow and privacy: [PRIVACY.md](PRIVACY.md)
- Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## License

[Apache License 2.0](LICENSE)
