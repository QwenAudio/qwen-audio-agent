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
| `qwen3.5-omni-flash-realtime` | text, audio, image | text, audio | text, audio, JPEG observation |
| `qwen3.5-omni-plus-realtime` | text, audio, image | text, audio | text, audio, JPEG observation |
| `qwen-audio-3.0-realtime-plus` (default) | text, audio | text, audio | text, audio |
| `qwen-audio-3.0-realtime-flash` | text, audio | text, audio | text, audio |

All four profiles support Function Calling. The two Omni profiles support the WebUI's explicit
JPEG observation transport; frames are sent at about 1 FPS, capped at eight recent in-memory
frames, and do not create model responses by themselves. Native video and observation on the
legacy Audio profiles remain unavailable. WebUI and TUI read the authoritative profile from
Gateway health and use it to gate or display the available inputs. Separate
clients cannot select conflicting models on one Gateway. A Desktop attached to a borrowed
Gateway, or a later CLI runtime using a conflicting configured model, refuses the mismatch
instead of silently changing the running service. To roll back, set the legacy ID above and
restart the Gateway.

## Background vision analysis

Camera observation and backend vision analysis are independent capabilities. When the
configured backend Agent accepts image input, the WebUI exposes a **Deep analysis** action and
the foreground Agent can call `analyze_visual_scene`. The Gateway freezes either the latest
frame or the recent bounded window (up to eight frames), sends those JPEG inputs only to the
configured backend for the requested analysis, and keeps the raw frames out of logs and default
persistence.

The result is a bounded `VisualInsight` with the source observation, generation, frame range,
capture timestamps, summary, uncertainty, and confidence. Delivery can be `display` (UI only),
`context` (available to the foreground on a later turn), or `respond` (one natural foreground
reply). A backend that does not advertise image input fails explicitly; the realtime foreground
continues to support ordinary conversation.
