# Common Backend Settings

First make the Agent work through its native interface, then connect it to the Gateway. It uses the Agent's native configuration as its starting point. Model, tool, MCP, Skill, and authentication reuse depends on backend capabilities; see the specific integration guide.

## Select a Backend

For example, in `config.env`:

```dotenv
AGENT_PROTOCOL=qwen
QWEN_AUDIO_AGENT_BACKEND_MODEL=
QWEN_AUDIO_AGENT_BACKEND_PERMISSION_MODE=native
```

See [Backend Agents](../backends/overview.md) for names and requirements. Leave the selection empty or use `none` to disable the backend while keeping chat and enabled frontend tools.

For one run, use `qwenaudio gateway --backend qwen`. After changing persistent settings, [restart the actual Gateway](../operations/gateway.md#applying-configuration-changes).

## Check and Install

```bash
qwenaudio setup --backend qwen
qwenaudio install qwen
```

`setup` checks executables and integration components; it does not install, sign in, or verify quota. `install` adds only missing components, including external ACP adapters when required. Script-based steps ask for confirmation; `--yes` skips it.

Complete authentication and model setup through the backend's own interface. Desktop's Install and Configure actions reuse this workflow. “Installed” means components exist; even “Ready” does not replace a real task test.

The generic `acp` entry has no installer. Set `ACP_COMMAND` and `ACP_ARGS` yourself. See [Backend-Specific Settings](../backends/configuration.md).

## Model Selection

For ACP backends supporting standard model configuration, when `QWEN_AUDIO_AGENT_BACKEND_MODEL` is empty:

- The Gateway passes no model, guesses no default, and calls no model-setting interface.
- New Sessions use the backend's choice; restored Sessions keep their existing model.

An explicit value uses only standard ACP `configOptions` with `category: model` and `session/set_config_option`. Use a model ID offered by the backend. Unsupported overrides, failed settings, or unconfirmed results fail explicitly rather than silently falling back.

DeepSeek Harness uses a separate startup model setting; see [DeepSeek](../backends/configuration.md#deepseek).

Overrides apply to coordinator, new, and restored project Sessions. Non-ACP adapters implement their own declared capability; Muse Code uses MSP `modelId`, not ACP.

### Managed OpenCode / OpenClaw Setup

These two backends support automatic installation when missing and DashScope initialization for Gateway-owned instances:

```dotenv
AGENT_PROTOCOL=opencode
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_AGENT_BACKEND_MODEL=qwen3.7-max
```

For OpenClaw, use `AGENT_PROTOCOL=openclaw`. This is deployment-time initialization, not a universal backend behavior. Leave the backend model empty to preserve an existing Agent's model. See [OpenCode](../backends/configuration.md#opencode) / [OpenClaw](../backends/configuration.md#openclaw).

## Workspace and Processes

The default workspace is `<data-dir>/workspace`. Change it globally with `QWAUDIO_WORKSPACE` or per backend with its dedicated variable. A workspace is a project directory, not a sandbox.

The Gateway normally starts its own backend process while reusing user configuration. It stops processes it owns on exit. An explicitly configured external OpenClaw Gateway retains its own lifecycle.

## Backend Permission Modes

| Mode | Behavior |
| --- | --- |
| `native` (default) | The backend decides when permission is needed. The Gateway forwards real requests and applies granted task/session permissions. |
| `full` | Enable maximum permissions for supported backends and automatically approve their requests. |

`full` supports OpenCode, Qoder, Qwen Code, MiniMax Code, Kimi Code, Hermes, CodeBuddy, Codex, Claude Code, DeepSeek, and Muse Code. It allows direct file changes and command execution; enable it only in trusted environments.

- **OpenClaw:** native execution policies also apply. The unified `full` mode is rejected; configure OpenClaw itself.
- **Pi:** the current integration has no approval mechanism and always acts as `full`. Selecting `native` cannot add a sandbox.
- For other backends, follow startup checks and the specific guide.

See [Work and Permissions](../guides/tasks.md) for Allow this task, Always allow, and Deny.

## Skills

Skills are installed only for backends; see [Backend Skills](../guides/skills.md). Follow backend-specific instructions for external Agent services. A backend service URL is not the Gateway URL used by clients.

<a id="openclaw"></a>
<a id="opencode"></a>
<a id="qoder"></a>
<a id="qwen-code"></a>
<a id="minimax-code"></a>
<a id="kimi-code"></a>
<a id="hermes"></a>
<a id="codebuddy"></a>
<a id="codex"></a>
<a id="claude-code"></a>
<a id="pi"></a>

[Backend-Specific Settings](../backends/configuration.md) lists commands, authentication entry points, and dedicated variables.
