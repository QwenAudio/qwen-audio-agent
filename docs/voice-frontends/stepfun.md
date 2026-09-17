# StepAudio 3 Realtime

StepFun's WebSocket Realtime service provides text/audio input and output,
custom Function Calling, and server VAD. Gateway continues to own backend agents and tool execution.

## Configuration

Edit the user configuration file shown by `qwenaudio config`:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=stepfun
STEPFUN_API_KEY=your-stepfun-key
```

| Optional setting | Default | Description |
| --- | --- | --- |
| `STEPFUN_REALTIME_URL` | `wss://api.stepfun.com/v1/realtime` | WebSocket endpoint |
| `STEPFUN_REALTIME_MODEL` | `stepaudio-3-realtime-preview` | Currently supported model profile |
| `STEPFUN_REALTIME_VOICE` | Empty | Service default, or a voice ID supported by the model |

Credentials and voices are independent of DashScope. Unknown model IDs fail
before connecting; new models require a capability profile. Preview availability
and replacement follow the [official model documentation](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime).

In Desktop, select StepFun under Voice Frontend, enter the key, and apply.
Restart a terminal Gateway; for an installed service, run `qwenaudio gateway restart`.
`config show` and `config set --realtime-model` use the active provider's model catalog.
Remote clients use their Gateway's configuration.

## Integration boundary

- Only Gateway-managed `type: "function"` tools are registered. StepFun's built-in
  `type: "web_search"` and `type: "retrieval"` tools are not enabled. A custom
  Gateway function named `web_search` still executes through Gateway.
- Input/output use mono 24 kHz PCM16, negotiated through Gateway. The current
  profile does not support image or video transport.
- The published API does not fully specify transient response instructions.
  Announcements and delivery instructions use ordinary conversation items
  before `response.create`; these remain in conversation history. Automatic
  corrections requiring transient instructions stay disabled.
- Thinking deltas only signal response activity. The adapter normalizes cancellation into a common terminal event.

## Current validation limits

Live-service checks cover voice input/audio output, custom function calls,
tool-result delivery, and continuing after cancellation. This does not establish
interaction quality in every environment: desktop speaker tests still showed
frequent interruptions and the model verbally asking for permission without a
tool call. Such speech neither creates a backend task nor grants authorization.
This integration adds no automatic authorization, forced tool calls, or automatic replay rules.

For interrupted playback, correlate Gateway logs by `responseId` / `turnId`:
`realtime.provider.speech_started`, `realtime.provider.speech_stopped`,
`realtime.response.done`, and `realtime.playback.started/ended/cancelled`.
These events contain no raw audio or API keys. Restart Gateway after updating
to load the new code.

References: [Realtime API](https://platform.stepfun.com/docs/zh/api-reference/realtime/chat)
and [developer guide](https://platform.stepfun.com/docs/zh/guides/developer/realtime).
Local protocol tests cover connection, tool output, announcements, and cancellation.
Cloud voices, model behavior, and latency require a valid key to verify.
