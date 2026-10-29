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
QWEN_AUDIO_REALTIME_API_KEY=your-openai-key
QWEN_AUDIO_REALTIME_MODEL=gpt-live-1
QWEN_AUDIO_REALTIME_URL=
QWEN_AUDIO_REALTIME_VOICE=
```

| Optional setting | Default | Description |
| --- | --- | --- |
| `QWEN_AUDIO_REALTIME_URL` | `wss://api.openai.com/v1/live/sessions` | Live API WebSocket endpoint |
| `QWEN_AUDIO_REALTIME_MODEL` | `gpt-live-1` | Voice model; [register](../configuration/frontend.md#register-an-additional-model) another model ID with `"api": "gpt-live-1"` |
| `QWEN_AUDIO_REALTIME_VOICE` | Empty | Service default (`marin`), or a voice supported by the model |
| `GPT_LIVE_1_DELEGATION_MODEL` | `gpt-6-luna` | Responses model that reasons and calls Gateway tools |

The Live API marks no turn or response boundaries, so the adapter places them
by the timing below. The defaults are provisional, taken from live sessions; set
a key to tune a deployment. Values are milliseconds, clamped to 100–10,000; a
value that is not a number is ignored.

| Timing setting | Default | Description |
| --- | --- | --- |
| `GPT_LIVE_1_OUTPUT_IDLE_MS` | `1500` | Quiet in the model's speech and words that ends an answer |
| `GPT_LIVE_1_WORD_GAP_MS` | `600` | After an interruption, gap in the model's words that begins its next answer |
| `GPT_LIVE_1_INPUT_SEGMENT_GAP_MS` | `1200` | Gap in the user's speech after which words are a new utterance |
| `GPT_LIVE_1_INPUT_IDLE_MS` | `2000` | Quiet that completes a user utterance |

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
  starts on its first transcribed words.
- Speech streams as it is spoken, so clients buffer it before playing, also
  from a local Gateway such as the desktop app's.
- An interruption cuts no playback: OpenAI's server-controls guide leaves
  blocking model audio to the application, and this adapter does not block it.
  After a spoken barge-in, typed input, or the stop button, the answer plays out
  the speech the model already generated while the model yields, and backend
  work runs on. Typed input while the model speaks and the stop button, which
  the model cannot hear, also send `session.instructions.append` asking it to
  stop speaking.
- The voice model decides whether a turn gets a reply; a turn it leaves
  unanswered is released after the reply timeout, without an error. A
  permission or backend question is answered only by a turn that began after
  Gateway asked it.
- An interrupted answer's caption keeps filling as it plays out. Words that
  arrive after a user caption is final are not shown. When a question's words
  arrive only after its answer began, the turn opens there and the rest of the
  answer is its reply.
- After the stop button the answer plays out until the model is quiet. Then
  nothing the model says plays until the user speaks or types, or Gateway has
  something to say; speech still under way at that point plays on from there,
  as an interrupted answer.
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
- **Stopping relies on the model.** The stop button asks the model to stop
  speaking; a stopped answer plays out until the model is quiet, so a model that
  goes on talking is heard until it pauses.
- **Interruptions play out.** Speech the model generated before it yields, a
  second or two, still plays: under the user's voice on a spoken barge-in, and
  after typed input or the stop button. A very short interjection can leave a
  moment of it after the user stops.
- **Desktop actions by voice.** The voice model holds no tools and decides
  what to delegate. A spoken request for a desktop action, such as going to
  sleep, can get a spoken reply and no action, especially while the model is
  speaking. Naming the action ("close the floating orb", "hide it") works more
  often than a dismissal ("you can go now"), but not every time; a typed
  request reaches the tool.
- **One backend answer at a time.** Gateway sends typed input or an
  announcement once the running backend response completes, and the Live API
  runs delegations one after another, so a question asked during a long
  backend answer, even after a stop, is answered after it.
- **Typing before any audio.** The Live API expects continuous input audio. A
  question typed before the microphone has sent any audio, such as with it
  muted from the start, is spoken only after unmuting, usually within a few
  seconds. Once audio has flowed, a question typed while muted is answered at
  once.
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
