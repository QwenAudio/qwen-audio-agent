# Desktop

The desktop app provides a persistent on-screen voice orb and includes a built-in Gateway, eliminating the need to start a service beforehand. If a local Gateway already exists in the same user configuration directory, it will connect directly and use the Gateway's current runtime configuration; otherwise, the desktop app will start and manage it automatically. On first run, the app creates a configuration file and guides you to fill in the DashScope API Key on the settings page and select a backend agent (frontend-only mode is also available).

## Orb and Auto Sleep

When idle, the orb automatically hides and disconnects real-time voice; you can also say "可以退下了" (you may step down) to hide it. The app remains in the menu bar and can be re-summoned from the menu bar or via a show shortcut. The default shortcut is `⇧⌘ Space` and can be changed in app settings.

The sleep timeout and auto-hide are unified into a single "Auto Sleep" setting: during sleep, the microphone continues local listening, and saying the wake word "你好千问" (hello Qianwen) will resume the conversation. Backend agents and submitted tasks are not stopped by sleep; task results will be announced after wake-up. When the wake word is enabled for the first time, it automatically downloads and validates approximately 33 MB of the [`sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx) Chinese-English KWS model, and uses the local cache thereafter.

## Appearance

The desktop app supports two appearance styles: the Aurora Soundwave Orb and the Liquid Gradient Orb. The following shows their raw animations in the thinking / breathing state:

| Aurora Soundwave Orb | Liquid Gradient Orb |
| --- | --- |
| ![Aurora Soundwave Orb thinking animation](../desktop-fluid-orb-thinking.gif) | ![Liquid Gradient Orb thinking animation](../desktop-goo-orb-thinking.gif) |

## Skins

Beyond the built-in appearances, the orb supports sprite skins in the
[Codex pet](https://github.com/legeling/awesome-codex-pet) package format:
a directory containing `pet.json` and `spritesheet.webp` (8-column grid,
v1 is 1536x1872 with 9 rows, v2 is 1536x2288 with 11 rows). Assets from the
Codex pet ecosystem work without any conversion, and no Codex installation
is required.

To import a skin you already downloaded, open "Settings → Application →
Appearance", click "Import Skin…", and select the skin folder, its
`pet.json`, or a zip archive. Imported skins are stored under `skins/` in
the desktop data directory and appear in the appearance dropdown alongside
the built-in styles. Selecting an imported skin enables the "Delete"
button next to it; built-in appearances cannot be deleted.

The orb maps voice and task states to pet animations: waiting while
listening, reviewing while thinking, waving while speaking or greeting you
on wake, running left continuously while background tasks are executing,
jumping continuously while a task waits for your confirmation, running
while another frontend holds the voice channel, and the failed pose on
errors. Conversation states always take priority over background states.
Skin packages are static assets only (JSON + WebP) and are validated on
import; if a selected skin package is removed, the orb falls back to the
built-in appearance.

## Installation

Download the installer for your platform from the releases page:

- **macOS**: Download the `.dmg`, open it, and drag **Qwen Audio Agent** into "Applications".
- **Windows**: Download the `.exe` installer, double-click to run, and follow the wizard to complete installation.

To build a local test version from source:

```bash
npm run desktop:build:local      # macOS
npm run desktop:build:win        # Windows
npm run desktop:build:linux      # Linux (AppImage + deb, no signing required)
```

The output is located in `dist/desktop/`.

## Data Directory and Isolation

The desktop app uses the standard system application data directory (`~/Library/Application Support/Qwen Audio Agent` on macOS, `%APPDATA%/Qwen Audio Agent` on Windows, and `~/.config/Qwen Audio Agent` on Linux), which is completely isolated from the CLI's `~/.config/qwaudio`. The Gateway, locks, logs, and settings of the two do not interfere with each other and can run simultaneously. On first launch, the desktop app copies `config.env` and other user configurations from the CLI directory (the CLI retains the originals).

## Auto Update and Logs

The settings page displays the current version and allows manual update checks. When a new version is found, the background downloads a delta update, and once complete, a one-click restart installs it.

The desktop app can open the log directory from "Settings → Application → Logs". Along with the Gateway, it records structured JSONL logs with automatic credential redaction and log rotation. For log configuration details, see
[Configuration Guide](../configuration.md#本地日志).
