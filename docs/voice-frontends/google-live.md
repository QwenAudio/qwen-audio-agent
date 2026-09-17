# Google Gemini Live

qwen-audio-agent can connect to Google's Gemini Live WebSocket API as a cloud
voice frontend. Gateway keeps the same frontend tools, memory, reminders, task
delegation, and backend-Agent orchestration; the provider adapter translates
Gemini Live's bidirectional stream into the shared Realtime runtime.

## Configuration

Edit the user configuration file shown by `qwenaudio config`:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=google-live
GOOGLE_API_KEY=your-google-api-key
```

| Optional setting | Default | Description |
| --- | --- | --- |
| `GOOGLE_LIVE_REALTIME_URL` / `GEMINI_LIVE_REALTIME_URL` | `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` | WebSocket endpoint |
| `GOOGLE_LIVE_REALTIME_MODEL` / `GEMINI_LIVE_REALTIME_MODEL` | `gemini-3.8-live` | Current built-in model profile |
| `GOOGLE_LIVE_REALTIME_VOICE` / `GEMINI_LIVE_REALTIME_VOICE` | Empty | Service default, or a prebuilt Gemini Live voice name |
| `GEMINI_API_KEY` / `GOOGLE_LIVE_API_KEY` | Empty | Aliases for `GOOGLE_API_KEY` |

Desktop exposes the same fields under **Voice frontend -> Google Live**.
Restart a terminal Gateway after editing the file; for an installed service,
run `qwenaudio gateway restart`.

## Integration boundary

- The adapter uses Gemini Live's native WebSocket endpoint and adds the API key
  as the `key` query parameter unless the URL already contains `key` or
  `access_token`.
- Audio input uses mono 16 kHz PCM and audio output uses 24 kHz PCM.
- Gateway registers its own function declarations with Gemini Live. Tool
  results are sent back through `toolResponse`.
- Gemini Live does not acknowledge conversation items in the OpenAI-style way,
  so Gateway treats input and tool-response writes as accepted once the frame is
  sent.
- Conversation history restoration is disabled for this provider because
  injected history text would be interpreted as live realtime input.
- The current transport can send live JPEG frames as Gemini Live `video`
  realtime input when a client negotiates image-buffer capability.

## Validation boundary

Local protocol tests cover URL construction, session setup, audio and image
frames, tool calls, transcription events, model capability reporting, and
provider registration. Live model behavior, available voices, quotas, latency,
and regional availability require a valid Google AI account and are governed by
Google's current Gemini Live API documentation.

## Read next

- [GPT-Live / OpenAI Realtime](gpt-live.md)
- [Frontend configuration reference](../configuration/frontend.md)
- [Custom Provider](custom-provider.md)
