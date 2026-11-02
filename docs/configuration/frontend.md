# Voice Frontends

The voice frontend handles realtime conversation; the backend Agent executes work. You can choose them independently.

Keep provider selection, credentials, endpoints, and the selected model in the `config.env` shown by `qwenaudio config`. Desktop's voice frontend settings edit these connection settings and select models from the effective catalog. Optional model registrations belong in a separate `frontend-models.json` file.

## Choose a Service

| Service | Provider value | Required configuration or preparation | Guide |
| --- | --- | --- | --- |
| Qwen Audio / Omni 3.5 / Omni 3.8 | `dashscope` (default) | DashScope API key; Omni 3.8 also requires a workspace-specific URL | [Audio](../voice-frontends/qwen-audio-realtime.md) / [Omni vision](../voice-frontends/qwen-omni-realtime.md) |
| StepAudio 3 | `stepfun` | StepFun API key | [StepFun](../voice-frontends/stepfun.md) |
| OpenAI Realtime | `gpt-live` | OpenAI API key | [GPT-Live](../voice-frontends/gpt-live.md) |
| OpenAI Live API | `gpt-live-1` | OpenAI API key | [GPT-Live 1](../voice-frontends/gpt-live-1.md) |
| Gemini Live | `google-live` | Google API key | [Google Live](../voice-frontends/google-live.md) |
| Doubao Seeduplex | `doubao-seeduplex` | Doubao API key | Configure its model, voice, and endpoint below |
| Hugging Face speech-to-speech | `speech-to-speech` | Start the service; default: `ws://127.0.0.1:8765/v1/realtime` | [Local model pipeline](../voice-frontends/speech-to-speech.md) |
| MiniCPM-o 4.5 | `minicpm-o` | Start the service; default: `ws://127.0.0.1:8006/v1/realtime?mode=audio` | [Audio/video modes and limits](../voice-frontends/minicpm-o.md) |

For the default frontend:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
QWEN_AUDIO_REALTIME_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.1-realtime-plus
QWEN_AUDIO_REALTIME_URL=
QWEN_AUDIO_REALTIME_VOICE=
```

To switch to StepFun, select it and supply its own credentials:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=stepfun
QWEN_AUDIO_REALTIME_API_KEY=your-stepfun-key
QWEN_AUDIO_REALTIME_MODEL=stepaudio-3-realtime-preview
QWEN_AUDIO_REALTIME_URL=
QWEN_AUDIO_REALTIME_VOICE=
```

All frontends use the same five fields. They describe one active connection, not a collection of saved provider profiles. When switching providers, replace the key and model, and clear or replace the URL and voice. Frontend credentials are separate from backend, search, and memory-service credentials.

## Connection Fields

| Field | Meaning |
| --- | --- |
| `QWEN_AUDIO_REALTIME_PROVIDER` | Service to connect to; defaults to `dashscope` |
| `QWEN_AUDIO_REALTIME_MODEL` | Model ID; empty uses the provider default |
| `QWEN_AUDIO_REALTIME_API_KEY` | Credential for the selected service |
| `QWEN_AUDIO_REALTIME_URL` | WebSocket endpoint; empty uses the provider default |
| `QWEN_AUDIO_REALTIME_VOICE` | Voice override; empty uses the model or service default |

Provider defaults:

| Provider | Default model | Default endpoint |
| --- | --- | --- |
| `dashscope` | `qwen-audio-3.1-realtime-plus` | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` |
| `stepfun` | `stepaudio-3-realtime-preview` | `wss://api.stepfun.com/v1/realtime` |
| `gpt-live` | `gpt-realtime-2.1` | `wss://api.openai.com/v1/realtime` |
| `gpt-live-1` | `gpt-live-1` | `wss://api.openai.com/v1/live/sessions` |
| `google-live` | `gemini-3.8-live` | `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` |
| `doubao-seeduplex` | `1.2.6.1` | `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue` |
| `speech-to-speech` | Set upstream | `ws://127.0.0.1:8765/v1/realtime` |
| `minicpm-o` | Set upstream | `ws://127.0.0.1:8006/v1/realtime?mode=audio` |

For speech-to-speech and MiniCPM-o, leave model and voice empty: the upstream service controls them. Set the API key only if that service requires a Bearer token. Qwen3.8 Omni requires an explicit [workspace-specific URL](../voice-frontends/qwen-omni-realtime.md#setup), not the public DashScope default. Uniform configuration does not change each service's protocol or capability limits; the Provider adapter handles those differences. GPT-Live 1 also reads `GPT_LIVE_1_DELEGATION_MODEL`, the Responses model it delegates to (default `gpt-6-luna`), and four timing settings described in its [guide](../voice-frontends/gpt-live-1.md#configuration).

Current built-in DashScope model profiles:

| Model ID | Realtime input |
| --- | --- |
| `qwen-audio-3.1-realtime-plus` (default) | Text, audio |
| `qwen-audio-3.0-realtime-plus` | Text, audio |
| `qwen-audio-3.0-realtime-flash` | Text, audio |
| `qwen3.5-omni-flash-realtime` | Text, audio, live visual frames |
| `qwen3.5-omni-plus-realtime` | Text, audio, live visual frames |
| `qwen3.8-omni-flash-realtime` | Text, audio, live visual frames |

All profiles support tool calls. Live vision also requires client and transport support; see [Visual Input](../guides/vision.md).

Audio 3.1 Plus uses the existing `dashscope` provider and defaults to
`longanqian_v3.1`; Audio 3.0 Plus / Flash keep `longanqian`. An explicit
`QWEN_AUDIO_REALTIME_VOICE` must match the selected model. Audio models do not
support visual input. See the [Audio guide](../voice-frontends/qwen-audio-realtime.md)
for model switching and workspace endpoint overrides.

## Register an Additional Model

The effective catalog contains the built-in models plus your registrations. An unregistered model ID is a configuration error: the Gateway does not infer a protocol from its name. Register a new model only after confirming that the service exposes it through one of the supported APIs.

Create `frontend-models.json` beside `config.env`, under `QWAUDIO_CONFIG_DIR` (normally `~/.config/qwaudio`). To use another file, set `QWEN_AUDIO_FRONTEND_MODELS_CONFIG` in `config.env`; relative paths are resolved from that configuration directory, not the current working directory. Without the default file, only built-in models are loaded. An explicitly configured missing file or invalid JSON is an error, not a silent fallback.

This example contains a placeholder, not a verified service model. Replace `replace-with-supported-model-id` with the actual API model ID; do not put API keys or endpoints in this file:

```json
{
  "providers": {
    "dashscope": {
      "models": {
        "replace-with-supported-model-id": {
          "api": "audio",
          "label": "My Audio Model",
          "voice": null
        }
      }
    }
  }
}
```

`api` is required and selects a reusable integration preset: a wire-protocol variant, default capability declarations, session defaults (including turn detection), and integration constraints. These are shared defaults for this integration, not a guarantee that every model using the same upstream API has identical capabilities. Register only models compatible with the selected preset; registration does not discover model capabilities or override the preset. `label` is optional and defaults to the model ID. Omit `voice` or use `null` to leave the default voice to the service; an explicit voice setting in `config.env` still takes precedence.

DashScope accepts `audio`, `omni` (3.5), or `omni-v2` (3.8, with its workspace endpoint requirement). For `stepfun`, `gpt-live`, `gpt-live-1`, `google-live`, and `doubao-seeduplex`, `api` must equal the provider key. Registration is append-only: it cannot replace a built-in model for the same provider, add an unsupported provider/API, or set undeclared fields. Model IDs are case-sensitive and start with a letter or digit; remaining characters may also include `. _ : / @ + -`. Invalid entries are reported as configuration errors.

After loading the catalog, select the registered ID in Desktop or set `QWEN_AUDIO_REALTIME_MODEL`. Apply the configuration as described below. The catalog is not a service-side permission check: the account, region, endpoint, voice, and actual model compatibility still need validation. Models behind speech-to-speech and MiniCPM-o remain configured in those external services.

A new model compatible with an existing integration preset needs only a registration. If its capabilities, session requirements, or wire behavior differ, the integration needs an explicit change and tests before that model can use it. A new wire protocol requires a Provider adapter implementation; this JSON file does not load SDKs or executable plugins.

## Apply and Verify

1. Click Apply in Desktop. For a terminal Gateway, stop and restart it. For an installed background service, run `qwenaudio gateway restart`.
2. Connect a client and check that the voice frontend is connected.
3. Speak and confirm that audio plays. If you need tools, also test search or a simple backend request.

To inspect the configured provider and effective model catalog:

```bash
qwenaudio config show
qwenaudio config set --realtime-model qwen-audio-3.0-realtime-flash
```

`config set` changes the current provider's model; it neither switches providers nor restarts the Gateway. Remote clients use the remote Gateway's settings, not local model settings.

## Service Differences

- **MiniCPM-o:** the current adapter does not support text input, structured tool calls, proactive replies, or conversation context restoration. It supports voice/visual chat, not backend orchestration.
- **speech-to-speech:** recognition languages, voices, and tool-call quality depend on the STT, LLM, and TTS you configure.
- **Google Live:** the current adapter does not restore conversation context into a reconnected upstream session. Visible chat history does not mean the model received that history.
- Other supported features and limits are documented in the service-specific guides.

Configure frontend tools separately: [Search](../guides/web-search.md), [MCP](../reference/frontend-mcp.md), [OpenAPI](../reference/frontend-openapi.md).

## Older Configuration

Provider-specific frontend variables are read only for compatibility. The five unified fields take precedence, including explicitly empty values. If an older file contains both unified model/voice fields and another provider's model/voice fields, put the selected provider's intended values in the unified fields. For Omni, move an existing `QWEN_OMNI_REALTIME_VOICE` value to `QWEN_AUDIO_REALTIME_VOICE`.

Only the active connection is saved; separate provider drafts are no longer persisted. Old variables are not automatically deleted because a backend Agent, search, or another module may still use them. Remove obsolete frontend-only overrides yourself after migration. See [configuration priority](../configuration.md#configuration-priority).
