# CLI Reference

After installation, run `qwenaudio` from any directory. In a source checkout, run `npm run cli -- <command>` from the repository root.

## Configuration and Diagnostics

| Command | Purpose |
| --- | --- |
| `qwenaudio --version` | Show the CLI version |
| `qwenaudio config` | Show the config path; create a template if missing |
| `qwenaudio config show` | Show the configured voice provider, model, and available models without credentials |
| `qwenaudio config set --realtime-model ID` | Change the current provider's model setting |
| `qwenaudio doctor` | Read-only configuration, connection, and state checks |
| `qwenaudio doctor --json` | Print diagnostic JSON |
| `qwenaudio doctor --turn ID` | Build a turn timeline from local logs |
| `qwenaudio setup` | Check integration readiness for all backends |
| `qwenaudio setup --backend qwen --json` | Check one backend and print JSON |

`config show` reads configuration, not live model availability. `setup` does not verify backend accounts or quota. [Apply configuration changes](../operations/gateway.md#applying-configuration-changes) after changing models.

## Gateway

| Command | Purpose |
| --- | --- |
| `qwenaudio` / `qwenaudio gateway` | Run in the current terminal |
| `qwenaudio gateway --backend qwen` | Use Qwen Code for this run |
| `qwenaudio gateway --backend none` | Run frontend-only |
| `qwenaudio gateway install` | Install and start a user background service |
| `qwenaudio gateway start` / `stop` / `restart` | Manage the installed background service |
| `qwenaudio gateway status` | Check reachability and local service status |
| `qwenaudio gateway uninstall` | Remove the user service without deleting user data |
| `qwenaudio gateway --lan` | Expose an endpoint on a trusted LAN |
| `qwenaudio gateway --tailnet` | Publish a private endpoint through system Tailscale Serve |
| `qwenaudio gateway --webrtc` | Enable the installed optional WebRTC extension |

`gateway stop/restart` does not manage a foreground process in another terminal. Stop that process with `Ctrl-C` in its terminal. Background services read backend settings from `config.env` and reject `--backend` overrides.

`--lan` and `--tailnet` are mutually exclusive and also work with `gateway install`. Normal remote access does not require WebRTC.

## Clients and Pairing

| Command | Purpose |
| --- | --- |
| `qwenaudio tui` | Connect to the Gateway with a voice terminal |
| `qwenaudio tui --audio-mode half` | Linux / Windows half-duplex |
| `qwenaudio tui --audio-mode full` | Linux / Windows full-duplex without AEC; use headphones |
| `qwenaudio tui --takeover` | Explicitly take over the user's active connection |
| `qwenaudio webui` | Open the Gateway page in a browser |
| `qwenaudio webui --no-open` | Print the page URL only |
| `qwenaudio gateway pair --name "My phone"` | Issue a connection link and QR code on the Gateway host |
| `qwenaudio gateway pair --endpoint https://voice.example.com` | Issue a link using a specified remote endpoint |
| `qwenaudio gateway devices` | List paired devices |
| `qwenaudio gateway revoke DEVICE_ID` | Revoke device credentials |
| `qwenaudio connect 'full-connection-link'` | Save the endpoint and credentials for TUI |
| `qwenaudio disconnect` | Forget TUI's saved connection without revoking the server-side device |

Use `--url URL` to specify a Gateway and `--session ID` to select a frontend session in TUI / WebUI. Client commands do not launch backend Agents or change Gateway models. For WebUI, open the connection link directly or use `--url`; it does not read TUI's saved connection profile.

Connection links contain credentials. Do not commit them to scripts or share screenshots publicly. See [Remote Connections](../operations/remote-access.md).

## Backends and Skills

```bash
qwenaudio install qwen
qwenaudio skill install owner/repo --list
qwenaudio skill install owner/repo --skill skill-name
qwenaudio skill list
qwenaudio skill remove skill-name
qwenaudio skill update
```

`install` installs components; you still complete backend authentication and model setup. `skill` installs only for backends. See [Backend Settings](../configuration/backend.md) and [Skills](../guides/skills.md).

Use `qwenaudio --help` for the current version's complete options. Inside TUI, use `/help` rather than sending CLI commands as chat.
