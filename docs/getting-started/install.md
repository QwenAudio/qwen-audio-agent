# Installation

Requires Node.js ^22.22.2, ^24.15.0, or >=26.0.0, and npm 10+. When using the default DashScope
real-time voice frontend, a DashScope API Key is also required.
The repository provides `.nvmrc` and `.node-version`; when using nvm, you can simply run `nvm use`.

## One-line Install

Install from npm (recommended):

```bash
npm install -g qwen-audio-agent
```

You can also install the latest code directly from GitHub:

```bash
npm install -g git+https://github.com/QwenAudio/qwen-audio-agent.git
```

## Install from Source

```bash
git clone https://github.com/QwenAudio/qwen-audio-agent.git
cd qwen-audio-agent
npm install
npm run install:global
```

## Upgrade

Upgrade to the latest npm version:

```bash
npm install -g qwen-audio-agent@latest
```

Upgrade to the latest GitHub code:

```bash
npm install -g git+https://github.com/QwenAudio/qwen-audio-agent.git
```

After upgrading, if the Gateway is running as a background service, run `qwenaudio gateway restart` for the new version to take effect.

## Verify Installation

View the exact location of the configuration file and confirm the installation is ready:

```bash
qwenaudio config
```

After configuring the backend agent, you can run a read-only check to confirm whether the backend executable, ACP integration, and adapter are ready:

```bash
qwenaudio setup
```

## Configuration File Location

The CLI and the desktop version share `~/.config/qwaudio/config.env` (settings, identity,
memory, and the shared workspace live in the same user directory). Only runtime state —
Gateway process, locks, logs, and skins — is kept in the desktop app's own application
data directory (`~/Library/Application Support/Qwen Audio Agent` on macOS), so the two can run
simultaneously. Set `QWAUDIO_CONFIG_DIR` or
`XDG_CONFIG_HOME` to change the configuration directory. See [Configuration](../configuration.md) for details.

## Obtain a DashScope API Key

Alibaba Cloud Model Studio (Bailian) automatically provides eligible new users with a
[new-user free quota](https://help.aliyun.com/zh/model-studio/new-free-quota), which normally does not require a separate claim.
See the official [free-quota guide](https://help.aliyun.com/zh/model-studio/new-free-quota)
for current eligibility, region, validity, and stop-when-exhausted rules. You can also
open the [model usage page](https://help.aliyun.com/zh/model-studio/model-usage-statistics)
to check remaining quota. Quota and billing rules can vary by region, model, and account
status; follow the official Bailian pages for the current rules.

1. Open the [API Key page](https://bailian.console.aliyun.com/?tab=model#/api-key) in the Bailian console,
   log in to your account, and click **Create API Key**.
2. Copy the generated Key and fill it into `config.env` later. Do not publicly share or commit your API Key.

For detailed instructions, see [Get and configure an API Key](https://help.aliyun.com/zh/model-studio/get-api-key).
After quota is exhausted, verified accounts may continue with pay-as-you-go billing, so
enable the official stop-when-exhausted option when appropriate.
