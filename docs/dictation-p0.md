# Composer dictation P0 design

## Scope

P0 adds opt-in dictation only to the WebUI and TUI composers. It does not
observe or write another application's input, synthesize keyboard events,
register a global shortcut, request an operating-system permission, or create
a dictation history. Desktop/native input, cross-application capture, history,
and semantic-memory features remain outside this design.

The server flag `QWEN_AUDIO_DICTATION_ENABLED` is off by default. When it is
off, `/api/health` does not advertise the dictation capabilities and every
`dictation.*` client event is a no-op except for a feature-disabled error.

## Boundaries and data flow

```text
Web/TUI microphone
       |
       | dictation.audio.append (PCM16, 16 kHz)
       v
Gateway DictationSession -----> dedicated Qwen-ASR-Realtime WebSocket
       |                                  |
       | dictation.transcript.*           | partial/final text
       v                                  v
client-owned composer <---- revisioned draft operation
       |
       | one client-side composer submit for a unique commitId
       v
existing input.message -> existing conversation/reply/memory path
```

The dedicated ASR connection uses only `session.update`,
`input_audio_buffer.append`, and `session.finish`. It never has tools, the
agent prompt, conversation history, or memory. A provider error enters a
visible `error` state and returns control to the keyboard. It never routes
audio to the primary Realtime frontend.

The composer is authoritative for `{ text, selectionStart, selectionEnd,
revision }`. The Gateway requests that snapshot only for one utterance, emits
an operation with the same `baseRevision`, and discards the snapshot after the
operation is acknowledged. A revision mismatch is rejected; one fresh snapshot
may be requested, but a stale patch is never guessed or merged.

Only `dictation.commit.request` may cause submission. The client de-duplicates
`commitId`, verifies the requested revision, and invokes the same composer
submit function used by the Send button exactly once. The resulting
`input.message` is therefore the only dictation content that enters the
conversation and existing memory extraction. This guarantee is scoped to a
live process and session; P0 intentionally has no durable receipt/outbox.

## Protocol 2.1.0

Every event carries `sessionId` and a monotonically increasing `seq` in its
direction. Client commands with a repeated or lower sequence are rejected.
Draft-changing messages additionally carry `operationId` and `baseRevision`.
Commit messages additionally carry `commitId`, `revision`, and `payloadHash`.

Client to Gateway:

- `dictation.start`: start an opt-in composer session; `continuous` defaults
  to `true`, locale defaults to the client locale.
- `dictation.audio.append`: append Base64 PCM16 audio to the dedicated ASR.
- `dictation.pause`, `dictation.resume`, `dictation.cancel`, `dictation.stop`:
  explicit lifecycle controls. Cancel discards every uncommitted value. Stop
  closes the live transcriber and enters `stopped`; resume is rejected until a
  new start creates a fresh session.
- `dictation.context`: one response to `dictation.context.request` containing
  the current text, selection, and revision.
- `dictation.operation.ack`: applied/conflict/rejected result.
- `dictation.commit.ack`: confirms whether the composer submitted the unique
  commit.

Gateway to client:

- `dictation.state`: one of `starting`, `listening`, `transcribing`, `editing`,
  `ready-to-send`, `paused`, `stopped`, `cancelled`, or `error`.
- `dictation.transcript.delta` and `dictation.transcript.final`: visible ASR
  preview only; neither event changes the conversation.
- `dictation.context.request`: requests one composer snapshot.
- `dictation.operation`: deterministic insert/replace/delete or a one-shot
  rewrite result, guarded by `baseRevision`.
- `dictation.commit.request`: asks the client to call its composer submit once.
- `dictation.error`: visible, non-fallback failure.

## Commands

An isolated final command at the end of an ASR-final utterance triggers submit:
Chinese `发送` or `提交`, and English `send` or `submit`, with optional terminal
punctuation and whitespace. A Chinese command after dictated text requires a
whitespace or explicit punctuation boundary; for example, `明天见。发送`
commits, while `把文件发送` remains ordinary text. A command appearing
mid-sentence, followed by an object/preposition/content, also remains ordinary
dictated text. The command token is removed before insertion and submission.

Exact edit forms are deterministic and local to the draft:

- `把 X 改成 Y` / `replace X with Y`
- `删除 X` / `delete X`

Open requests such as “改得更简洁” may use one stateless text request. That
request contains only the current draft and instruction, sets no tools, and
receives no memory or conversation context. Failure leaves the draft unchanged
and enters the visible error state. Rewrite uses an independent key by default;
explicit ASR-key reuse is allowed only for a transport-equivalent provider
origin and is rejected across origins.

## Lifecycle and timeout

```text
idle -> starting -> listening <-> paused
                      |
                      v
                 transcribing -> editing -> listening
                                      |
                                      v
                                ready-to-send
                                      |
                         continuous --+--> listening
                         one-shot --------> paused
start/listen/transcribe/edit/ready -- stop --> stopped -- new start --> starting
```

Pause or timeout clears pending in-process intent, context, operation, commit,
and timer state; cancel, error, stop, or connection close additionally closes
the dedicated ASR session. Continuous mode is on by default. Every
capture-bearing state —
`starting`, `listening`, `transcribing`, `editing`, and `ready-to-send` — has a
45-second timeout that moves the session to `paused` and stops dictation
capture. In `paused`, `stopped`, `cancelled`, or `error`, late context,
operation, and commit messages are ignored and cannot resume capture or submit.

## Privacy and observability invariants

- Audio, partial text, final-but-uncommitted text, cancelled text, edit
  commands, and composer snapshots are memory-only and are never written to
  conversation sync, memory extraction, disk, or logs.
- The dictation session emits no logs. Transcript/draft/audio fields are
  forbidden even at debug level.
- No new persistent file or directory is introduced by this feature.
- A client cannot capture unless it can render a dictation state. Hiding or
  unmounting the control cancels capture.
- TUI capture also requires the live client to be unmuted and own voice input.
  Leaving dictation restores its prior capture state only when those gates still
  hold; a provider error always returns to keyboard input instead of Realtime.
- Disabling the flag or losing the ASR provider returns the composer to normal
  keyboard behavior. The primary Realtime provider is never an ASR fallback.

## Rollback and limitations

Rollback is the default flag value: reject/cancel active sessions and retain
the user's current client-side draft. No migration is required.

P0 does not provide crash-durable exactly-once delivery, OS-global shortcuts,
secure-field detection outside the owned composer, input injection, persistent
history, delete/export UI, or cross-session dictation recall.
