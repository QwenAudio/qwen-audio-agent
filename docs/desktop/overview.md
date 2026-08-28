# Desktop

The desktop app provides a persistent on-screen voice orb and includes a built-in Gateway, eliminating the need to start a service beforehand. If a local Gateway already exists in the same user configuration directory, it will connect directly and use the Gateway's current runtime configuration; otherwise, the desktop app will start and manage it automatically. On first run, the app creates a configuration file and guides you to fill in the DashScope API Key on the settings page and select a backend agent (frontend-only mode is also available).

## Backend Agent Connection

The app manages the selected backend Agent by default. For Agents that expose
an external-service capability, the Backend Agent settings also allow connecting
to an existing service by address and optional access token. OpenClaw currently
supports this mode; Agents without that capability continue to use their managed
ACP process and do not show irrelevant connection fields.

## Orb and Auto Sleep

When idle, the orb automatically hides and disconnects real-time voice; you can also say "可以退下了" (you may step down) to hide it. The app remains in the menu bar and can be re-summoned from the menu bar or via a show shortcut. The default shortcut is `⇧⌘ Space` and can be changed in app settings.

The sleep timeout and auto-hide are unified into a single "Auto Sleep" setting: during sleep, the microphone continues local listening, and saying the wake word "你好千问" (hello Qianwen) will resume the conversation. Backend agents and submitted tasks are not stopped by sleep; task results will be announced after wake-up. When the wake word is enabled for the first time, it automatically downloads and validates approximately 33 MB of the [`sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx) Chinese-English KWS model, and uses the local cache thereafter. Detection runs entirely in an isolated Desktop Client worker; wake-word audio is not sent to Gateway, and a successful detection emits only the standard `wake` event.

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

Generated skins may use the optional `animations.frames/fps` extension to
describe each standard action's effective frames and speed. See the
[desktop pet skin protocol](./pet-skin-spec.md).

To import a skin you already downloaded, open "Settings → App →
Appearance", click "Import Skin…", and select the skin folder, its
`pet.json`, or a zip archive. Imported skins are stored under `skins/` in
the desktop data directory and appear in the appearance dropdown alongside
the built-in styles. Selecting an imported skin enables the "Delete"
button next to it; built-in appearances cannot be deleted.

The desktop does not flatten every business signal into one "Agent state".
Lifecycle, runtime readiness, voice interaction, and background work remain
separate; skins consume only stable presentation states and one-shot events.

| Standard animation | Meaning | Agent state or event | Playback |
| --- | --- | --- | --- |
| `idle` | Resting | `idle`, `connecting`, `occupied` | Loop while the state persists |
| `running-right` | Moving right | The user drags the pet right | Loop while dragging |
| `running-left` | Moving left | The user drags the pet left | Loop while dragging |
| `waving` | Speaking | `speaking` | Loop for the full `speaking` state |
| `jumping` | Success / wake | `waking`, first startup readiness, successful task completion, pointer enter | Play once per event |
| `failed` | Failure | `error`, desktop runtime failure, task failure | Play once per event |
| `waiting` | Listening | `listening` | Loop for the full `listening` state |
| `running` | Working / startup | `working`, `starting` | Loop while the state persists |
| `review` | Foreground turn processing | `processing` | Play once per processing phase |

Sustained states and one-shot events are arbitrated separately: startup,
listening, speaking, and background work retain their looping tracks, while
first readiness, wake, task results, foreground processing, and pointer entry
play once. A one-shot action restores the current base track: `running` while
work remains active, otherwise `idle`. Every active background task uses
`working` → `running`, including backend thinking; a pending authorization does
not select an Agent animation and remains visible in the Task UI until its
spoken request naturally enters `speaking`. Every task kind uses the same
start, completion, and failure rules. Front-end-only mode skips backend readiness.
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

The desktop app shares the CLI's user directory (`~/.config/qwaudio`): settings, identity, memory, and the shared workspace are the same across both. Only runtime state — the Gateway process, locks, logs, task records, and skins — lives in the desktop app's own application data directory (`~/Library/Application Support/Qwen Audio Agent` on macOS, `%APPDATA%/Qwen Audio Agent` on Windows, and `~/.config/Qwen Audio Agent` on Linux), so the two can run simultaneously. On first launch, configuration from an older desktop build is migrated into the shared CLI directory (the CLI retains the originals).

## Auto Update and Logs

The settings page displays the current version and allows manual update checks. When a new version is found, the background downloads a delta update, and once complete, a one-click restart installs it.

The desktop app can open the log directory from "Settings → App → Logs". Along with the Gateway, it records structured JSONL logs with automatic credential redaction and log rotation. For log configuration details, see
[Configuration Guide](../configuration/advanced.md#local-logs).
