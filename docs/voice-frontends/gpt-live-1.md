# GPT-Live 1 (OpenAI Live API)

qwen-audio-agent can use OpenAI's GPT-Live 1 as a cloud voice frontend. It is a
full-duplex voice model on the Live API, a different protocol from the Realtime
API behind `gpt-live`: it listens while it speaks and delegates reasoning and
tools to a Responses model. Gateway still owns frontend tools, memory,
reminders, task delegation, and backend-Agent orchestration.

## Configuration

Edit the user configuration file shown by `qwenaudio config`:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=gpt-live-1
GPT_LIVE_1_API_KEY=your-openai-key
```

| Optional setting | Default | Description |
| --- | --- | --- |
| `GPT_LIVE_1_REALTIME_URL` / `OPENAI_LIVE_URL` | `wss://api.openai.com/v1/live/sessions` | Live API WebSocket endpoint; for Azure OpenAI, the resource's `/openai/v1/live/sessions` URL |
| `GPT_LIVE_1_REALTIME_MODEL` | `gpt-live-1` | Voice model; for Azure OpenAI, its deployment name |
| `GPT_LIVE_1_REALTIME_VOICE` | Empty | Service default (`marin`), or a voice supported by the model |
| `GPT_LIVE_1_DELEGATION_MODEL` | `gpt-6-luna` | Responses model that reasons and calls Gateway tools; for Azure OpenAI, a deployment name on the same resource |

The Live API marks no turn or response boundaries, so the adapter groups speech
by the timing below. The defaults are provisional, taken from live sessions; set
a key to tune a deployment. Values are milliseconds, clamped to 100–10,000 (the
question wait also takes 0, which turns it off); a value that is not a number is
ignored.

| Timing setting | Default | Description |
| --- | --- | --- |
| `GPT_LIVE_1_ANSWER_GAP_MS` | `1500` | Transcript gap that separates two answers |
| `GPT_LIVE_1_OUTPUT_IDLE_MS` | Answer gap | Quiet that ends a spoken answer |
| `GPT_LIVE_1_INPUT_SEGMENT_GAP_MS` | `1200` | Gap in the user's speech after which words are a new utterance |
| `GPT_LIVE_1_INPUT_IDLE_MS` | `2000` | Quiet that completes a user utterance |
| `GPT_LIVE_1_QUESTION_WAIT_MS` | `1000` | How long an answer that arrives before its question's words waits for them |
| `GPT_LIVE_1_LATE_QUESTION_MS` | `1200` | Words starting this soon after such an answer are its question, not a barge-in |
| `GPT_LIVE_1_BARGE_IN_YIELD_MS` | `1000` | After a barge-in, speech past this plays as a new answer |
| `GPT_LIVE_1_TRANSCRIPT_LAG_MS` | `600` | Late transcript still attached to the answer that just ended |
| `GPT_LIVE_1_STOPPED_ANSWER_PAUSE_MS` | `600` | Pause that ends an answer the user stopped |

Desktop exposes the endpoint, key, model, and voice fields under
**Voice frontend → GPT-Live 1**. Restart a terminal Gateway after editing the
file; for an installed service, run `qwenaudio gateway restart`.

## Integration boundary

- The adapter speaks the Live API over WebSocket: `session.start` first, bearer
  authentication, mono 24 kHz PCM16. As OpenAI's Live prompting guide
  recommends, the voice model gets a short persona and policies, and the
  delegated model gets the frontend instructions and Gateway's tools. Recent
  text history is seeded as `session.input`. Live visual frames are not
  negotiated.
- Tool results return with `response.item.create`, and the response that made
  the calls continues once on a later `response.create`. A failed call or a
  refused result is answered with a failure output.
- Short announcements are spoken with `session.commentary.append`; task results,
  permission requests, and typed text go to the delegated model.
- Answers and user turns are grouped by the timing settings above; a user turn
  starts on its first transcribed words. A barge-in interrupts playback only;
  backend work runs on.
- The voice model decides whether a turn gets a reply; a turn it leaves
  unanswered is released after the reply timeout, without an error. A
  permission or backend question is answered only by a turn that began after
  Gateway asked it.
- After a barge-in the caption keeps filling until the model stops. Words that
  arrive after a user caption is final, or after its answer started playing, are
  not shown.
- An explicit stop sends `session.instructions.append` asking the model to stop
  speaking; nothing it says next plays until the user speaks or Gateway has
  something to say.
- A 429 handshake or the concurrent-session limit counts as busy capacity; an
  invalid key or an unknown model blocks the connection. After a close for
  content, Gateway reconnects without that turn; any other error fails only the
  current turn.

## Language

GPT-Live 1 tends to speak the language of its instructions; OpenAI's Live
prompting guide asks for the prompt to be written in the language the assistant
should speak. The shared frontend prompt, persona, and Gateway tool descriptions
are Chinese, so the assistant speaks Chinese by default, also to a user speaking
English. To serve English-speaking users, translate all of them:

- the frontend prompt and persona (`config/frontend-agent/PROMPT.md`,
  `ASSISTANT.md`);
- the tool descriptions in `server/src/frontend/tools/`,
  `server/src/memory/tools.mjs`, and `server/src/knowledge/tools.mjs`;
- the Gateway texts the model receives, such as task and announcement texts;
- and set the client locale to `en-US`.

With all of these in English, spoken English questions got English voice and
backend answers.

## Known limitations

- **Barge-in delay.** A barge-in is known only from the user's first
  transcribed words, about a second after they start speaking; until then the
  previous answer keeps playing.
- **Typing while muted.** The Live API needs continuous input audio. The
  microphone toggle sends `session.input_audio.mute` and stops input audio, so a
  question typed while the microphone is muted is answered once it is unmuted.
- **Announcement delivery.** An announcement counts as delivered when its
  acknowledgement or backend response completes; the Live API ties no later
  signal to the speech.
- **Idle sessions.** The Live API bills a session per second until it closes,
  and backend usage separately. Muting and sleep keep the session open; closing
  the page or the app closes it. Closing idle sessions automatically is a
  follow-up.

## Validation boundary

Local tests drive the adapter with injected clocks; the shared behavior suite
runs it on a native Live fixture, and its synthesised turns run through the
real input runtime. Live model behavior, voices, latency, quotas, and regional
availability are governed by OpenAI's current Live API documentation.

## Read next

- [GPT-Live / OpenAI Realtime](gpt-live.md)
- [Frontend configuration reference](../configuration/frontend.md)
- [Custom Provider](custom-provider.md)
