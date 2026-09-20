# Install & Update

## Choosing a Version

- **Everyday use**: choose a desktop installer from the
  [latest GitHub Release](https://github.com/QwenAudio/qwen-audio-agent/releases/latest), or the latest stable npm package.
- **Testing new features**: use GitHub `main`. This manual follows `main`; not every documented feature is in a stable package yet.
- Mobile currently uses [development builds](mobile.md#get-development-builds). For testing, prefer Gateway and client builds from the same revision.

## Desktop Installation

Desktop installers include the Gateway and its runtime. **You do not need to install Node.js or npm
just to run Desktop.** Backend Agent installation, authentication, and configuration are separate;
see [Backend Agents](../backends/overview.md).

Download from the [release page](https://github.com/QwenAudio/qwen-audio-agent/releases/latest):

| Platform | Installation |
| --- | --- |
| macOS | Open the `.dmg`, drag Qwen Audio Agent into Applications, then open the app. |
| Windows | Run the `.exe` installer and follow the setup wizard. |

Continue with the [Desktop guide](../desktop/overview.md). Linux users can
[build from source](../desktop/overview.md#installation).

## One-line Install

The following requirements apply to **CLI / source installations**: Node.js ^22.22.2, ^24.15.0,
or >=26.0.0, and npm 10+. The source repository includes `.nvmrc` and `.node-version`;
with nvm, run `nvm use`.

Install the stable release:

```bash
npm install -g qwen-audio-agent
```

Install the latest development code from GitHub:

```bash
npm install -g git+https://github.com/QwenAudio/qwen-audio-agent.git
```

## Install from Source

```bash
git clone https://github.com/QwenAudio/qwen-audio-agent.git
cd qwen-audio-agent
npm ci
npm run build
```

Run directly from the repository root without a global installation:

```bash
npm run cli -- config
npm run gateway
# In another terminal
npm run cli -- webui
```

To use `qwenaudio` from any directory, also run `npm run install:global`.
Use `npm run desktop` for the development Desktop app; this is separate from an installed release.

## Upgrade

Desktop can check for updates in Settings, or you can download a new installer. Update the stable CLI:

```bash
npm install -g qwen-audio-agent@latest
```

For GitHub development installs, rerun the GitHub installation command above. Restart the Gateway
you actually use after updating:
[foreground runs, background services, and Desktop differ](../operations/gateway.md#applying-configuration-changes).

## Verify Installation

```bash
qwenaudio --version
qwenaudio config
```

The first command shows the installed version; the second shows the configuration path and creates
a template if missing. Neither verifies API credentials or model connectivity. Configure the app
and complete a conversation using the [quickstart](quickstart.md).

Development builds provide `qwenaudio doctor` for read-only diagnostics. `qwenaudio setup`
checks backend installations and integration components, not authentication or quota.
See [Troubleshooting](../operations/troubleshooting.md).

## Configuration File Location

CLI and Desktop share `~/.config/qwaudio/config.env` by default, but keep separate runtime state.
See [configuration and data directories](../configuration.md#configuration-and-data-directories)
for overrides and storage details.

## Obtain a DashScope API Key

1. Open the [Bailian API Key page](https://bailian.console.aliyun.com/?tab=model#/api-key), sign in, and create a key.
2. Enter it in Desktop settings or as `DASHSCOPE_API_KEY` in `config.env`.

See the [official free-quota guide](https://help.aliyun.com/zh/model-studio/new-free-quota) for eligibility and conditions. Check available quota and billing settings before use. Do not expose keys or commit configuration files.
