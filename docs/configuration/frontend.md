# Frontend Configuration

The voice frontend is the realtime speech model the Gateway connects to. All
settings on this page live in the user configuration file
(`~/.config/qwaudio/config.env`, see [Configuration](../configuration.md));
[apply changes for your run mode](../operations/gateway.md#applying-configuration-changes): restart foreground runs, use `gateway restart` for an installed service, or click Apply in Desktop.

## Credentials and endpoint

The default provider is DashScope (`QWEN_AUDIO_REALTIME_PROVIDER=dashscope`):

```dotenv
DASHSCOPE_API_KEY=your-key
```

| Provider | Credential | Endpoint | Model / voice |
| --- | --- | --- | --- |
| DashScope (default, alias `qwen`) | `DASHSCOPE_API_KEY` | `QWEN_AUDIO_REALTIME_BASE_URL` (alias `QWEN_AUDIO_REALTIME_URL`) | `QWEN_AUDIO_REALTIME_MODEL`; Audio: `QWEN_AUDIO_REALTIME_VOICE`; Omni: `QWEN_OMNI_REALTIME_VOICE` |
| StepFun | `STEPFUN_API_KEY` | `STEPFUN_REALTIME_URL` | `STEPFUN_REALTIME_MODEL`, `STEPFUN_REALTIME_VOICE` |
| GPT-Live | `OPENAI_API_KEY` (alias `GPT_LIVE_API_KEY`) | `GPT_LIVE_REALTIME_URL` (alias `OPENAI_REALTIME_URL`) | `GPT_LIVE_REALTIME_MODEL`, `GPT_LIVE_REALTIME_VOICE` (aliases `OPENAI_REALTIME_*`) |
| Google Live | `GOOGLE_API_KEY` (aliases `GEMINI_API_KEY`, `GOOGLE_LIVE_API_KEY`) | `GOOGLE_LIVE_REALTIME_URL` (alias `GEMINI_LIVE_REALTIME_URL`) | `GOOGLE_LIVE_REALTIME_MODEL`, `GOOGLE_LIVE_REALTIME_VOICE` (aliases `GEMINI_LIVE_REALTIME_*`) |
| speech-to-speech (alias `s2s`) | `SPEECH_TO_SPEECH_AUTH_TOKEN` (alias `S2S_API_KEY`) | `SPEECH_TO_SPEECH_REALTIME_URL` (alias `S2S_REALTIME_URL`) | Managed by the service |
| minicpm-o (alias `minicpmo`) | `MINICPM_O_AUTH_TOKEN` | `MINICPM_O_REALTIME_URL` | Managed by the service |

Only `QWEN_AUDIO_REALTIME_PROVIDER` is shared. Configure each provider once, then change
only the selector to switch. Credentials, endpoints, models and voices never cross providers.
An explicitly empty credential clears it. Empty models/endpoints use provider defaults;
empty voices use service/model defaults. Primary names take precedence over aliases.

There is no global runtime override. `QWEN_AUDIO_REALTIME_MODEL` and
`QWEN_AUDIO_REALTIME_VOICE` belong to DashScope only. The removed
`QWEN_AUDIO_REALTIME_API_KEY` and `QWEN_AUDIO_REALTIME_ENDPOINT` are ignored in process environments.

CLI source priority remains process environment, project `.env.local`, project `.env`,
then user `config.env`. Desktop saves provider-owned fields together in `config.env`;
`realtime-profiles.json` remains a private draft fallback. Explicit file fields win over drafts,
including cleared credentials and inactive providers edited with the CLI.

Transitional saved files containing removed unified fields are imported using the provider
recorded in that file, before merging other sources. The next Desktop realtime settings save
writes provider fields and removes the retired names. Different legacy/native credentials
for the same provider cause a migration error rather than silently replacing a key; keep the
intended native credential and remove the retired field. Reading configuration never rewrites files.


Other frontends include [StepAudio 3 Realtime](../voice-frontends/stepfun.md)
(with its own StepFun API key), [GPT-Live / OpenAI Realtime](../voice-frontends/gpt-live.md),
[Google Gemini Live](../voice-frontends/google-live.md),
[Speech-to-Speech](../voice-frontends/speech-to-speech.md), and
[ModelBest](../voice-frontends/minicpm-o.md), whose MiniCPM-o 4.5 endpoint may be local or hosted.
A custom provider implements
the provider contract; see [Custom Provider](../voice-frontends/custom-provider.md).

MiniCPM-o's public audio Realtime transport currently supports continuous
audio input and text/audio output, but not conversation items, structured
Function Calling, or input transcription. It is therefore a realtime voice-chat
frontend rather than a frontend for backend-Agent orchestration.

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
# For an installed user background service only:
qwenaudio gateway restart
```

The exact supported DashScope IDs are:

| Model | Model input | Model output | Realtime transport |
| --- | --- | --- | --- |
| `qwen3.5-omni-flash-realtime` | text, audio, image/video frames | text, audio | text, audio, live JPEG frames |
| `qwen3.5-omni-plus-realtime` | text, audio, image/video frames | text, audio | text, audio, live JPEG frames |
| `qwen-audio-3.0-realtime-plus` (default) | text, audio | text, audio | text, audio |
| `qwen-audio-3.0-realtime-flash` | text, audio | text, audio | text, audio |

Provider-specific pages list the corresponding non-DashScope IDs:
[StepAudio 3 Realtime](../voice-frontends/stepfun.md),
[GPT-Live](../voice-frontends/gpt-live.md), and
[Google Gemini Live](../voice-frontends/google-live.md).

All four profiles support Function Calling. Model capability remains distinct from transport:
Omni accepts the WebUI's capability-negotiated live JPEG stream, while ordinary uploaded images
continue through the attachment path. Desktop and TUI do not capture live frames. Clients read
the authoritative profile from Gateway health. Separate
clients cannot select conflicting models on one Gateway. A Desktop attached to a borrowed
Gateway, or a later CLI runtime using a conflicting configured model, refuses the mismatch
instead of silently changing the running service. To roll back, set the legacy ID above and
restart the Gateway.
