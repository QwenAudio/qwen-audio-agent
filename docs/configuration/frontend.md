# Voice Frontends

The voice frontend handles realtime conversation; the backend Agent executes work. You can choose them independently.

Keep provider selection, credentials, endpoints, and the selected model in the `config.env` shown by `qwenaudio config`. Desktop's voice frontend settings edit these connection settings and select from the framework's supported models. Model definitions and adaptation parameters are maintained in code.

## Choose a Service

| Service | Provider value | Required configuration or preparation | Guide |
| --- | --- | --- | --- |
| Qwen Audio / Omni 3.5 / Omni 3.8 | `dashscope` (default) | DashScope API key; Omni 3.8 also requires a workspace-specific URL | [Audio](../voice-frontends/qwen-audio-realtime.md) / [Omni vision](../voice-frontends/qwen-omni-realtime.md) |
| StepAudio 3 | `stepfun` | StepFun API key | [StepFun](../voice-frontends/stepfun.md) |
| OpenAI Realtime | `gpt-live` | OpenAI API key | [GPT-Live](../voice-frontends/gpt-live.md) |
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
| `google-live` | `gemini-3.8-live` | `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` |
| `doubao-seeduplex` | `1.2.6.1` | `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue` |
| `speech-to-speech` | Set upstream | `ws://127.0.0.1:8765/v1/realtime` |
| `minicpm-o` | Set upstream | `ws://127.0.0.1:8006/v1/realtime?mode=audio` |

For speech-to-speech and MiniCPM-o, leave model and voice empty: the upstream service controls them. Set the API key only if that service requires a Bearer token. Qwen3.8 Omni requires an explicit [workspace-specific URL](../voice-frontends/qwen-omni-realtime.md#setup), not the public DashScope default. Uniform configuration does not change each service's protocol or capability limits; the Provider adapter handles those differences.

Current built-in DashScope model profiles:

| Model ID | Realtime input |
| --- | --- |
| `qwen-audio-3.1-realtime-plus` (default) | Text, audio |
| `qwen-audio-3.1-realtime-flash` | Text, audio |
| `qwen-audio-3.0-realtime-plus` | Text, audio |
| `qwen-audio-3.0-realtime-flash` | Text, audio |
| `qwen3.5-omni-flash-realtime` | Text, audio, live visual frames |
| `qwen3.5-omni-plus-realtime` | Text, audio, live visual frames |
| `qwen3.8-omni-flash-realtime` | Text, audio, live visual frames |

All profiles support tool calls. Live vision also requires client and transport support; see [Visual Input](../guides/vision.md).

Audio 3.1 Plus / Flash use the existing `dashscope` provider and default to
`longanqian_v3.1`; Audio 3.0 Plus / Flash keep `longanqian`. An explicit
`QWEN_AUDIO_REALTIME_VOICE` must match the selected model. Audio models do not
support visual input. See the [Audio guide](../voice-frontends/qwen-audio-realtime.md)
for model switching and workspace endpoint overrides.

## Select a Supported Model

The model list is maintained by the framework. Desktop and `qwenaudio config show` use this same list; choose a model for the selected provider in Desktop or set `QWEN_AUDIO_REALTIME_MODEL`. Leave it empty to use the provider default. For example, with `dashscope` selected, use `qwen-audio-3.1-realtime-flash` to switch to the built-in 3.1 Flash model. The default remains 3.1 Plus.

An unsupported model ID is a configuration error. User configuration cannot add models, redefine existing models, or change their API bindings, capabilities, turn detection, or integration constraints. These are fixed by the framework's model support. The existing `QWEN_AUDIO_REALTIME_VOICE` and session-scoped voice overrides still work; choose a voice compatible with the selected model.

The list describes implemented support, not live service availability or account authorization. Check the account, region, endpoint, and voice for your chosen model, then apply and verify the connection below. Models behind speech-to-speech and MiniCPM-o remain configured in those external services.

## Apply and Verify

1. Click Apply in Desktop. For a terminal Gateway, stop and restart it. For an installed background service, run `qwenaudio gateway restart`.
2. Connect a client and check that the voice frontend is connected.
3. Speak and confirm that audio plays. If you need tools, also test search or a simple backend request.

To inspect the configured provider and supported model list:

```bash
qwenaudio config show
qwenaudio config set --realtime-model qwen-audio-3.1-realtime-flash
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
