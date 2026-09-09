# Desktop

Desktop provides a voice orb and conversation panel with an embedded Gateway; no terminal service
needs to be started first. Configuration, memory, and workspace are shared with CLI by default,
but runtime directories are separate. A Gateway already running in the same Desktop runtime
directory is reused; otherwise the app starts and manages one.

## First Run

1. Download an installer from the [release page](https://github.com/QwenAudio/qwen-audio-agent/releases/latest) and open the app.
2. The first launch creates `config.env`. Open Settings and enter credentials for your voice frontend.
   For the default DashScope service, Settings links to the Bailian API Key page.
3. Select a Backend Agent, or start in frontend-only mode. Installed Agents reuse their authentication
   and model settings. If missing, use an available Install action and complete the backend's setup.
4. Click Apply and check Gateway, voice-frontend, and Backend Agent status.
5. Allow microphone permission, say “Hello”, and confirm you see a transcript and hear a reply.

Existing configuration is reused on startup. Filled settings or an installed backend do not prove
valid credentials or quota. See [Troubleshooting](../operations/troubleshooting.md) for errors.

## Orb and Conversation Panel

Use the “Open conversation” button beside the orb to open the panel. It shows conversation and
work cards and accepts text, images, and files. The panel and orb are two views of the same client,
not separate voice connections. The panel's collapse button returns to the orb.

Clicking the orb itself does not toggle mute. Use the microphone button instead; muting does not
stop current or future replies. See [Conversation & Attachments](../guides/conversation.md) for
manual input behavior.

## Backend Agent Connection

The app manages the selected backend by default. Agents supporting an external service can offer
“Connect to existing service” with an address and optional token; OpenClaw currently supports this.
This selects a **Backend Agent service**, not another Gateway for the Desktop client.
See [backend settings](../configuration/backend.md).

## Orb and Auto Sleep

After the configured idle period, the orb can hide automatically. You can also ask it to step down.
Sleep **hides the UI and stops microphone input to the voice frontend while retaining the Realtime
connection and conversation context**. The app stays in the menu bar; backend work is not cancelled,
and pending announcements continue after waking.

Wake it from the menu bar or show shortcut. The macOS default is `⇧⌘ Space`; view or change the
actual binding in Settings. If wake-word detection is enabled, the microphone is used only for local
keyword detection during sleep. Say “你好千问” to wake it. The first enable downloads and verifies
an approximately 33 MB [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) model, then reuses its cache.
Detection runs in an isolated Desktop worker; wake-word audio is not uploaded.

## Appearance

Settings offers the built-in Aurora Soundwave Orb, Liquid Gradient Orb, and imported pet skins.
These are animation examples of the built-in appearances:

| Aurora Soundwave Orb | Liquid Gradient Orb |
| --- | --- |
| ![Aurora Soundwave Orb animation](../desktop-fluid-orb-thinking.gif) | ![Liquid Gradient Orb animation](../desktop-goo-orb-thinking.gif) |

## Skins

In Settings → App → Appearance, click “Import Skin…” and select a skin directory, `pet.json`,
or a zip archive. Imported skins can be selected or deleted; built-in appearances cannot be deleted.

Codex pet packages and optional animation-frame descriptions are supported; Codex is not required.
See the [Pet Skin Protocol](pet-skin-spec.md) for resource creation and
[Desktop Animation Integration](../reference/desktop-animations.md) for state mappings,
loops, and one-shot playback.

## Remote Connections

Enter a local or remote Gateway URL in Settings → Application → Gateway and click Apply.
For the first connection to a remote Gateway requiring authentication, paste the complete
pairing link generated on its host into the same field. Desktop pairs automatically,
then displays the plain URL and reuses the saved credential for later connections.
See [Remote Connections and Pairing](../operations/remote-access.md). The Gateway and Backend Agent
stay on the remote host; Desktop only handles input and output, without its own relay service.
Tailnet mode requires official Tailscale on both devices; external HTTPS does not.

## Installation

For stable packages and updates, see [Install & Update](../getting-started/install.md#desktop-installation).
From a source checkout with dependencies installed, build a local test package:

```bash
npm run desktop:build:local      # macOS
npm run desktop:build:win        # Windows
npm run desktop:build:linux      # Linux: AppImage + deb
```

Outputs are in `dist/desktop/`. Local test builds are not equivalent to officially signed releases.

## Data Directory and Isolation

Desktop-hosted and CLI-hosted Gateways share configuration, identity, memory and workspace, but keep runtime state separate.
Desktop preferences, window placement, skins, wake-word models and connection credentials stay in the client application directory.
Both can run at once, but that does not mean they connect to the same Gateway.
See [configuration directories](../configuration.md#configuration-and-data-directories) for paths and overrides.

## Auto Update and Logs

Check for updates in Settings, then restart after download. Quitting stops the Gateway and backend
processes started by this app, not borrowed or remote services.

Open this Desktop runtime's log directory through Settings → App → Logs. Logs are redacted and
rotated. See [local logs](../configuration/advanced.md#local-logs) for configuration.
