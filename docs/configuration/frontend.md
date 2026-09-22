# Voice Frontends

The voice frontend handles realtime conversation; the backend Agent executes work. You can choose them independently.

Put these settings in the `config.env` shown by `qwenaudio config`, or select a service and enter credentials in Desktop's voice frontend settings.

## Choose a Service

| Service | Provider value | Required configuration or preparation | Guide |
| --- | --- | --- | --- |
| Qwen Audio / Omni 3.5 / Omni 3.8 | `dashscope` (default) | `DASHSCOPE_API_KEY`; Omni 3.8 also requires a workspace-specific `QWEN_AUDIO_REALTIME_BASE_URL` | [Audio](../voice-frontends/qwen-audio-realtime.md) / [Omni vision](../voice-frontends/qwen-omni-realtime.md) |
| StepAudio 3 | `stepfun` | `STEPFUN_API_KEY` | [StepFun](../voice-frontends/stepfun.md) |
| OpenAI Realtime | `gpt-live` | `OPENAI_API_KEY` | [GPT-Live](../voice-frontends/gpt-live.md) |
| Gemini Live | `google-live` | `GOOGLE_API_KEY` | [Google Live](../voice-frontends/google-live.md) |
| Doubao Seeduplex | `doubao-seeduplex` | `DOUBAO_API_KEY` | Configure its model, voice, and endpoint below |
| Hugging Face speech-to-speech | `speech-to-speech` | Start the service; default: `ws://127.0.0.1:8765/v1/realtime` | [Local model pipeline](../voice-frontends/speech-to-speech.md) |
| MiniCPM-o 4.5 | `minicpm-o` | Start the service; default: `ws://127.0.0.1:8006/v1/realtime?mode=audio` | [Audio/video modes and limits](../voice-frontends/minicpm-o.md) |

For the default frontend:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
DASHSCOPE_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-plus
```

To switch to StepFun, select it and supply its own credentials:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=stepfun
STEPFUN_API_KEY=your-stepfun-key
```

You can keep all provider settings in the same file. Switch using `QWEN_AUDIO_REALTIME_PROVIDER`; the Gateway does not reuse another provider's key, model, or voice.

## Model, Voice, and Endpoint

| Provider | Model | Voice | Endpoint |
| --- | --- | --- | --- |
| DashScope | `QWEN_AUDIO_REALTIME_MODEL` | Audio: `QWEN_AUDIO_REALTIME_VOICE`; Omni: `QWEN_OMNI_REALTIME_VOICE` | `QWEN_AUDIO_REALTIME_BASE_URL` |
| StepFun | `STEPFUN_REALTIME_MODEL` | `STEPFUN_REALTIME_VOICE` | `STEPFUN_REALTIME_URL` |
| GPT-Live | `GPT_LIVE_REALTIME_MODEL` | `GPT_LIVE_REALTIME_VOICE` | `GPT_LIVE_REALTIME_URL` |
| Google Live | `GOOGLE_LIVE_REALTIME_MODEL` | `GOOGLE_LIVE_REALTIME_VOICE` | `GOOGLE_LIVE_REALTIME_URL` |
| Doubao Seeduplex | `DOUBAO_SEEDUPLEX_REALTIME_MODEL` | `DOUBAO_SEEDUPLEX_REALTIME_VOICE` | `DOUBAO_SEEDUPLEX_REALTIME_URL` |
| speech-to-speech | Configure upstream | Configure upstream | `SPEECH_TO_SPEECH_REALTIME_URL` |
| MiniCPM-o | Configure upstream | Configure upstream | `MINICPM_O_REALTIME_URL` |

Empty endpoint and model fields use provider defaults, except Qwen3.8 Omni, which requires a [workspace-specific endpoint](../voice-frontends/qwen-omni-realtime.md#setup). For self-hosted services behind Bearer authentication, set `SPEECH_TO_SPEECH_AUTH_TOKEN` or `MINICPM_O_AUTH_TOKEN`. Aliases and protocol details are listed in each service guide.

Current built-in DashScope model profiles:

| Model ID | Realtime input |
| --- | --- |
| `qwen-audio-3.0-realtime-plus` (default) | Text, audio |
| `qwen-audio-3.0-realtime-flash` | Text, audio |
| `qwen3.5-omni-flash-realtime` | Text, audio, live visual frames |
| `qwen3.5-omni-plus-realtime` | Text, audio, live visual frames |
| `qwen3.8-omni-flash-realtime` | Text, audio, live visual frames |

All profiles support tool calls. Live vision also requires client and transport support; see [Visual Input](../guides/vision.md).

## Apply and Verify

1. Click Apply in Desktop. For a terminal Gateway, stop and restart it. For an installed background service, run `qwenaudio gateway restart`.
2. Connect a client and check that the voice frontend is connected.
3. Speak and confirm that audio plays. If you need tools, also test search or a simple backend request.

To inspect the configured provider and supported models:

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

Use provider-specific fields for new configurations. `QWEN_AUDIO_REALTIME_API_KEY` and `QWEN_AUDIO_REALTIME_ENDPOINT` are no longer process-environment overrides. Older files are converted when read; if conversion reports a conflict, keep the intended provider field and remove the obsolete field. See [configuration priority](../configuration.md#configuration-priority).
