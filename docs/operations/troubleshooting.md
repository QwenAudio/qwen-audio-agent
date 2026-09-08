# Troubleshooting

Identify the affected layer first: **client → Gateway → voice frontend / Backend Agent / frontend tools**.
Gateway connectivity does not prove model connectivity; an installed backend does not prove valid credentials.

## Collect Basic Information

Check client and Gateway versions, run mode, and the selected voice frontend and Backend Agent.
CLI commands:

```bash
qwenaudio --version
qwenaudio doctor
qwenaudio setup
```

Development builds include read-only `doctor`: it does not start models, backends, or microphones,
or automatically change configuration. `setup` checks backend executables and integration
components, not authentication, API keys, or quota. Without an active voice session, diagnostics
report voice connectivity as unverified. Complete a real conversation to verify it.

## Connections and Configuration

| Symptom | Check and action |
| --- | --- |
| Gateway disconnected | Confirm it is running and the client uses its actual address and port. Desktop and CLI have independent runtimes by default; inspect the right instance. |
| Gateway connected, voice frontend unavailable | Check the voice service address, credentials, quota, and Provider error. Orb animation alone is not connectivity evidence. |
| Configuration changes have no effect | Find the file with `qwenaudio config`, check environment / source `.env.local` overrides, and restart the actual Gateway. |
| `gateway restart` says the service is not installed | It manages the user background service only. Restart terminal runs manually; apply settings or reopen Desktop. |
| Client occupied or taken over | Each user has one active connection per Gateway. Confirm takeover or close the other client. |

See [Run the Gateway](gateway.md) and [configuration directories](../configuration.md).

## Microphone and Playback

| Symptom | Check and action |
| --- | --- |
| No microphone input | Check app / browser microphone permission, the system input device, mute, and sleep state. |
| Problems after plugging/unplugging a headset | Confirm system input/output switched to the intended devices. If needed, reopen the client and record the device model and switching sequence. |
| Text appears but there is no audio | Check output device, volume, and client playback state. For a local voice service, also inspect its TTS logs. |
| Speaker echo interrupts replies | Prefer half-duplex TUI on Linux / Windows; wear headphones for full-duplex without AEC. |
| Remote browser cannot access the microphone | Use trusted HTTPS and grant permission, not a plain remote HTTP address. |

See [TUI](../getting-started/tui.md) for audio modes. Sleep hides Desktop and stops microphone input
to the voice frontend while retaining the Realtime connection. Wake-word detection runs locally when enabled.

## Backends and Tools

- Backend execution fails: check installation with `qwenaudio setup --backend <name>`, then verify authentication and models in the backend's own interface.
- No backend model specified: the Gateway does not guess a default; it uses the Agent's configuration.
- Explicit model override fails: the backend must expose standard ACP model configuration and accept that value. Follow the error; do not assume silent fallback.
- MCP command missing: check `command` and PATH. Restart after installing commands; `gateway restart` refreshes the path cache for a background service.
- MCP environment variable missing: put it in that Gateway's `config.env`, not a temporary export in another terminal.
- Library unavailable or import fails: enable it and use a Gateway-host path. Complex documents also require isolated conversion support.

See [MCP configuration](../reference/frontend-mcp.md) and [Knowledge Library](../guides/knowledge.md).

## Remote Connections

First check that official Tailscale is online on both devices, they share a tailnet, and access
policies allow the connection. Then check that Gateway HTTPS publication is ready. Pairing codes
are short-lived and single-use; generate a new code on the host when needed. For external HTTPS,
check certificates, reverse-proxy settings, and WebSocket forwarding.
See [Remote Connections](remote-access.md).

## Logs and Reporting

Desktop exposes its log directory in Settings → App → Logs. CLI logs default to
`~/.config/qwaudio/logs`; Desktop logs use the `logs` subdirectory of its application data directory.

Development builds can summarize a recorded turn:

```bash
qwenaudio doctor --turn <turnId>
```

See [read-only diagnostics](../configuration/advanced.md#read-only-diagnostics) for bounds and limitations.
When filing an [Issue](https://github.com/QwenAudio/qwen-audio-agent/issues/new/choose), include
versions, OS, client / Gateway run mode, reproduction steps, time of occurrence, and relevant log excerpts.
**Do not include API keys, pairing codes, device tokens, full configuration files, or unreviewed private conversations.**
