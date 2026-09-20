# Run the Gateway

The Gateway connects the voice frontend and Backend Agent and serves conversation interfaces to
clients. Choose a run mode:

| Mode | Start | Stop |
| --- | --- | --- |
| Foreground terminal | `qwenaudio` or `qwenaudio gateway` | Press `Ctrl-C` in that terminal. |
| User background service | `qwenaudio gateway install` installs and starts it | `qwenaudio gateway stop`; remove it with `gateway uninstall`. |
| Embedded Desktop Gateway | Open Desktop; it starts and manages the Gateway | Quitting stops its own Gateway, not a borrowed or remote service. |

## Running from Source

From the repository root, `npm start`, `npm run gateway`, and
`npm run cli -- gateway` use the same CLI startup and shutdown path.
`npm run gateway` also builds the WebUI first. For example:

```bash
npm run gateway -- --backend qwen
```

Backend options belong to `gateway run`; TUI and WebUI only connect to a Gateway
and cannot change its backend. `setup --backend NAME` is a read-only check.
The old `npm run backend` alias has been removed; use `npm run gateway` instead.

`--url` takes precedence over `QWEN_AUDIO_AGENT_URL`, then `HOST` / `PORT`
(default `127.0.0.1:3101`). A wildcard `HOST` is retained for listening while
local health checks use loopback.

## Applying Configuration Changes

- **Foreground run**: press `Ctrl-C` in the Gateway terminal, then rerun the original command.
- **Background service**: run `qwenaudio gateway restart`. Without an installed service, this reports that the service is not installed.
- **Desktop**: change Settings and click Apply. After directly editing the file, quit and reopen the app.
  Client-only settings such as skins and wake preferences should not require a Gateway restart.
- **Remote connection**: change and restart the Gateway on its actual host. Local settings do not reconfigure a remote server.

Background services do not retain credentials temporarily exported in a terminal. Put persistent
settings in the `config.env` shown by `qwenaudio config`.

## Background Service Commands

```bash
qwenaudio gateway install
qwenaudio gateway status
qwenaudio gateway restart
qwenaudio gateway stop
qwenaudio gateway start
qwenaudio gateway uninstall
```

The service reads configuration on startup. `install`, `start`, and `restart` refresh the user
command-path cache so Agents and stdio MCP commands installed through Homebrew, npm, uv,
or version managers can be found.

## Instances and Clients

Only one Gateway may use a runtime directory. By default, CLI, TUI, and WebUI use the CLI instance;
Desktop has a separate runtime directory and can run another instance simultaneously. They share
configuration, memory, and workspace, but not task state, locks, or logs. See
[configuration and data directories](../configuration.md#configuration-and-data-directories).

Each user has one active client per Gateway. Taking over disconnects the previous client.
Multiple Gateway instances are different from multiple clients on one Gateway.

## Backend Process Ownership

The Gateway shuts down backend processes it started. Reusing an Agent's user configuration does
not mean attaching to or terminating an already-running user process. When explicitly configured
for an external OpenClaw Gateway, it connects without owning that service's lifecycle.
See [OpenClaw settings](../backends/configuration.md#openclaw).

## Check the Runtime

- `qwenaudio gateway status` reports Gateway reachability and local background-service
  state separately. Exit code `0` means the Gateway is reachable; `1` means it is not,
  regardless of how it was started. Reachability is not model/backend readiness.
- Use `qwenaudio gateway status --url URL` to check a remote Gateway, with its device
  token in `QWEN_AUDIO_GATEWAY_CLIENT_TOKEN`. It does not query local service state.
  An explicit URL overrides an installed service's address.
- `qwenaudio doctor` checks configuration and connectivity without starting models or microphones.
- See [local logs](../configuration/advanced.md#local-logs) for locations and rotation.
- See [remote connections](remote-access.md) for phones and other computers.
