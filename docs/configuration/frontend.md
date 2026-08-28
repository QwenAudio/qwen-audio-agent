# Frontend Configuration

The voice frontend is the realtime speech model the Gateway connects to. All
settings on this page live in the user configuration file
(`~/.config/qwaudio/config.env`, see [Configuration](../configuration.md));
apply changes with `qwenaudio gateway restart`.

## Credentials and endpoint

The default provider is DashScope (`QWEN_AUDIO_REALTIME_PROVIDER=dashscope`):

```dotenv
DASHSCOPE_API_KEY=your-key
```

| Setting | Default | Description |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | — | Model Studio API key, shared by the realtime frontend and other gateway features |
| `QWEN_AUDIO_REALTIME_API_KEY` | Empty | Higher-priority alias of `DASHSCOPE_API_KEY` for the realtime frontend only |
| `QWEN_AUDIO_REALTIME_BASE_URL` / `QWEN_AUDIO_REALTIME_URL` | Empty | Override the DashScope Realtime endpoint (private deployment or proxy) |
| `DASHSCOPE_WORKSPACE_ID` | Empty | Switch to a dedicated Model Studio workspace endpoint |

A fully local frontend is available via `QWEN_AUDIO_REALTIME_PROVIDER=speech-to-speech`;
see [Speech-to-Speech](../voice-frontends/speech-to-speech.md). A custom provider
implements the provider contract; see [Custom Provider](../voice-frontends/custom-provider.md).

Frontend tools are configured separately: Web Search (`QWEN_AUDIO_WEB_SEARCH_PROVIDER`,
see [Configuration](../configuration.md)), and general chatbot tools through the
[Frontend MCP client](../reference/frontend-mcp.md), the
[Frontend OpenAPI adapter](../reference/frontend-openapi.md), or a
[Frontend Profile](../reference/frontend-profile.md).

## Realtime model selection

One Gateway owns one active Realtime model. The Desktop settings page can configure the model
for a locally owned Gateway, and the CLI provides the equivalent commands:

```bash
qwenaudio config show
qwenaudio config set --realtime-model qwen3.5-omni-flash-realtime
qwenaudio gateway restart
```

The exact supported IDs are:

| Model | Model input | Model output | Current client transport |
| --- | --- | --- | --- |
| `qwen3.5-omni-flash-realtime` | text, audio, image | text, audio | text, audio |
| `qwen3.5-omni-plus-realtime` | text, audio, image | text, audio | text, audio |
| `qwen-audio-3.0-realtime-plus` (default) | text, audio | text, audio | text, audio |
| `qwen-audio-3.0-realtime-flash` | text, audio | text, audio | text, audio |

All four profiles support Function Calling. Model capability is not the same as an implemented
client transport: JPEG observation frames and native video are both disabled in this release.
WebUI and TUI read the authoritative profile from Gateway health and only display it. Separate
clients cannot select conflicting models on one Gateway. A Desktop attached to a borrowed
Gateway, or a later CLI runtime using a conflicting configured model, refuses the mismatch
instead of silently changing the running service. To roll back, set the legacy ID above and
restart the Gateway.

