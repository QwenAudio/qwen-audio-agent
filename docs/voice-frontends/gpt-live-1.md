# GPT-Live 1 (OpenAI Live API)

qwen-audio-agent can use OpenAI's GPT-Live 1 as a cloud voice frontend.
GPT-Live 1 is a full-duplex model served by the Live API, a different wire
protocol from the Realtime API used by the `gpt-live` provider: the voice model
listens while it speaks and delegates reasoning and tool use to a backend.
Gateway still owns frontend tools, memory, reminders, task delegation, and
backend-Agent orchestration; the provider adapter maps the Live API event stream
onto the shared runtime.

## Configuration

Edit the user configuration file shown by `qwenaudio config`:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=gpt-live-1
OPENAI_API_KEY=your-openai-key
```

| Optional setting | Default | Description |
| --- | --- | --- |
| `GPT_LIVE_1_REALTIME_URL` / `OPENAI_LIVE_URL` | `wss://api.openai.com/v1/live/sessions` | Live API WebSocket endpoint |
| `GPT_LIVE_1_REALTIME_MODEL` | `gpt-live-1` | Voice model; behind Azure, the deployment name |
| `GPT_LIVE_1_REALTIME_VOICE` | Empty | Service default (`marin`), or a voice supported by the model |
| `GPT_LIVE_1_API_KEY` | Empty | Takes precedence over `OPENAI_API_KEY` when the Live frontend needs its own credential; the desktop writes this variable, and a present but empty value disables the `OPENAI_API_KEY` fallback |
| `GPT_LIVE_1_DELEGATION_MODEL` | `gpt-6-luna` | Responses model that reasons and calls Gateway tools; the Live delegation guide's starting point (behind Azure, the deployment name) |
| `GPT_LIVE_1_DELEGATION_INSTRUCTIONS` | Built in | Replaces the backend prompt frame; the Gateway task instructions and the rules for injected Gateway messages are always appended |
| `GPT_LIVE_1_VOICE_INSTRUCTIONS` | Built in | Replaces the voice-layer prompt (persona and hand-off rules) |
| `GPT_LIVE_1_OUTPUT_IDLE_MS` | `800` | Silence after which a spoken segment counts as finished |
| `GPT_LIVE_1_TRACE_EVENTS` | Empty | `1` logs every Live API event in both directions to stderr as shapes, ids, codes and sizes; conversation content (prompts, transcripts, tool output, audio) is replaced by its length; service error messages are kept, truncated to 200 characters (integration debugging) |
| `GPT_LIVE_1_TOOL_OUTPUT_MAX_BYTES` | Empty | Hard cap on one backend input item (a tool result, typed text). By default an item may use half of what is left of the session's backend input budget, never less than 2 KiB while that much remains; 1 KiB is held back so pending tool calls can still be answered |

Desktop exposes the endpoint, key, model, and voice fields under
**Voice frontend → GPT-Live 1**. Restart a terminal Gateway after editing the
file; for an installed service, run `qwenaudio gateway restart`.

### Behind a gateway or Azure

Endpoint and credential are configuration, not code. To reach GPT-Live 1
through Azure OpenAI or an API gateway in front of it, point
`GPT_LIVE_1_REALTIME_URL` at that service's `/openai/v1/live/sessions` path,
set `GPT_LIVE_1_API_KEY` to the key it issues, and set
`GPT_LIVE_1_REALTIME_MODEL` to the deployment name. Azure resolves the
delegated Responses model the same way, so `GPT_LIVE_1_DELEGATION_MODEL` must
name a text-model deployment on the same resource. The adapter sends the same
`session.start` and `Authorization: Bearer` header either way.

## Integration boundary

- The adapter connects over WebSocket and sends `session.start`; the model
  travels inside the session configuration, not as a URL parameter.
  Authentication uses `Authorization: Bearer ...`.
- Input and output are raw mono 24 kHz PCM16 carried in
  `session.input_audio.append` and `session.output_audio.delta`. Client audio is
  resampled by the Gateway client before it reaches the provider.
- Tool calls use Responses delegation. Gateway registers its function tools in
  `delegation.responses.tools`; the delegated model's function calls arrive in
  `response.event` envelopes, Gateway executes them, and results return with
  `response.item.create` followed by `response.create`.
- The prompt is split as the prompting guide recommends: the voice layer gets
  the persona plus the Backchannel, Interruption and Delegation policy sections
  (with the backend capability list); the delegated model gets the full
  frontend instructions inside the documented backend prompt skeleton.
- Recent conversation history is seeded through `session.input` at startup:
  the most recent text messages within a token budget kept below the
  documented 8,192-token limit. If the service rejects the seeded history at
  startup, the next connect omits it. Later changes to the tools or backend
  prompt go out as `session.update` carrying only the `delegation` block, and
  only when it changed; start-time fields are never resent.
- Task results, permission requests, and typed text reach the delegated model
  as `response.item.create` items followed by `response.create`, so it can
  integrate them and answer through the voice layer. The Gateway's fixed
  guidance for such items is part of the backend prompt, so each injection is
  a single item. Short Gateway announcements are spoken directly with
  `session.commentary.append`, which accepts at most 500 tokens; the speak
  request settles on the `session.commentary.appended` acknowledgement, the
  only completion signal the wire offers. When the user answers a permission
  question and no backend response follows within a short grace period (for
  example because the voice layer acknowledged on its own without delegating),
  the Gateway requests the backend response itself with `response.create`, as
  it does for other providers: only the backend can settle a permission. That
  answer is not superseded by the user's next utterance, since the backend's
  tool call trails the speech by a few seconds. The Live API has no per-response
  tool choice, so the delegated model handles injected task results with its
  tools available; `respond_permission` stays guarded by the rule that the turn
  must carry the user's own speech.
- The Live API has no turn-complete or response-done event, and its output audio
  streams continuously, including digital silence between answers. The adapter
  opens a spoken segment on the first frame with speech energy, plays pauses
  through, and closes the segment once no speech frame or transcript fragment
  has arrived for `GPT_LIVE_1_OUTPUT_IDLE_MS` (or when the output timeline
  jumps), completing the transcript first so the runtime records the assistant
  turn as it does for GA providers. Interruption is handled by the model
  itself; there is no `response.cancel`. A Gateway cancel marks the playing
  segment interrupted: the runtime has already muted it, and the record closes
  as cancelled at the model's next pause. The transcript trails the audio by a
  few hundred milliseconds, so the interrupted caption keeps filling until the
  model stops (`transcriptTrailsAudio`): the words played before the cut are
  kept, and the few the model still said before yielding are shown too. A new
  segment never begins with the punctuation that closed the one before.
- User turns are synthesised from the timed transcript fragments in the GA
  order. A new turn (`speech_started`) opens only for speech that began after
  the current or last answer began and more than 1.2 s after the previous
  fragment ended; while the answer still plays that is a barge-in: the runtime
  clears playback, the model's remaining words stay on the interrupted answer,
  and that answer closes as cancelled once the model yields. Speech that carries
  on for more than 1 s after the barge-in was only talked over, so the answer
  completes normally. Any other fragment belongs to the
  question, however late it arrives: it continues the open utterance, or
  silently reopens the completed one so the caption grows without a turn (the
  runtime clears playback on every `speech_started`). The turn is committed
  (`speech_stopped`, `committed`) as soon as the assistant starts answering or
  input stays quiet for 1.5 s, and the transcript completes on that quiet
  period. Closing punctuation that the transcript delivers with the first
  fragment after a pause closes the utterance it belongs to while that one is
  still open; once it has completed, that punctuation is not shown at the head
  of the next caption. A bracketed annotation such as `[clear throat]` never
  opens a turn. The answer's start time comes from output audio timing where the
  transport sends it and from output transcript timing otherwise; with
  neither, turns fall back to arrival order. `session.delegation.created`
  commits the turn as well (the service has taken it), so the backend response
  and its tool calls carry that turn; the transcript still completes on the
  quiet period.
- User speech never supersedes backend work: a Gateway cancel closes voice
  playback records only, the delegated backend response and the Gateway
  requests waiting on it keep running, and the backend's tool calls are
  answered even after a new user turn, because the service refuses
  `response.create` while a call is unanswered.
- Beyond that seeded history no pre-connection context is injected, and live
  visual frames are not negotiated for this provider.

## Cost

- The Live API bills a session by duration, per second, from `session.start`
  until it closes; silence, muted input and time spent waiting on the backend
  all count. Backend model and tool usage is billed separately. See OpenAI's
  pricing page for the current rate.
- Input-only mute (the microphone toggle in the WebUI and the desktop app)
  sends `session.input_audio.mute` and keeps the session open; sleep keeps it
  open as well. Today the session closes only when the voice client
  disconnects: closing the page or quitting the desktop app.
- Closing idle sessions automatically is a follow-up.

## Validation boundary

Local protocol tests cover session configuration, the client event encoding,
segmentation of spoken output, synthesised input turns, the delegated
function-call loop, the backend input budget with its repair path, the
full-duplex turn rules (late fragments, barge-in, cancel and tool-call
survival), announcement acknowledgement, idle closing, and a mock-service
connection. Live model
behavior, voices, latency, quotas, and regional availability require a valid
account and are governed by OpenAI's current Live API documentation.

## Read next

- [GPT-Live / OpenAI Realtime](gpt-live.md)
- [Frontend configuration reference](../configuration/frontend.md)
- [Custom Provider](custom-provider.md)
