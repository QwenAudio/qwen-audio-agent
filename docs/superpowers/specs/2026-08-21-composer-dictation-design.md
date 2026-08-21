# Composer Dictation Design (ZQ-77)

## Scope

Add opt-in dictation to the Web and TUI composers. Soink is an interaction
reference only: all code, audio transport, provider access, submission,
conversation handling, and Memory handling remain in qwen-audio-agent.

The feature is disabled unless `QWEN_AUDIO_DICTATION_ENABLED=true`. A disabled
Gateway does not advertise dictation capabilities, create an ASR connection,
or register client UI and shortcuts.

## Architecture

The additive Gateway protocol is `2.1.0`. A provider may expose a separate
`dictation` adapter; the built-in DashScope provider supplies Qwen3 ASR
Realtime. Dictation audio is carried by dedicated `dictation.*` events on the
existing same-origin Gateway socket and never enters the main Realtime input.

Each client owns a deterministic composer controller. It keeps committed draft
text and the current partial separately, tracks a monotonically increasing
revision, and records only the latest finalized dictated range. Provider
partials are display-only (underlined in Web and TUI); finals become locked
draft text. Keyboard input first settles the partial. Replace/delete commands
are accepted only when they match exactly once inside the latest dictated
range. There is no open-ended rewrite model in P0.

The Gateway owns the dictation state machine and its single ASR connection.
Active states have a 45-second inactivity deadline. Pause, cancel, stop,
provider failure, timeout, external input suspension, and socket close clear
all transient context, operation, partial, and commit state. Terminal sessions
reject late provider or client events. `STOP` cannot be resumed; the client must
send a fresh `START`.

Starting dictation transfers microphone routing from main Realtime to the ASR
adapter. The client remembers whether main capture was active and restores that
exact state only after a normal stop/cancel. External `input.suspend` is
terminal and fail-closed: capture stays off until the external owner explicitly
resumes and the user starts a new dictation session.

## Commit and command rules

English `send` and Chinese `发送` are commands only when they are a standalone
final segment or follow an explicit sentence-ending punctuation boundary.
Occurrences such as `please send the file` and `把文件发送` remain text.

A voice commit is a receipt-based handshake: the Gateway names a commit id,
revision, and text hash; the client verifies all three and calls the existing
composer submit function once. A live-session receipt set deduplicates retries.
No Enter key is synthesized. Manual and voice submission both notify the same
controller, so continuous mode (default on) returns to listening after success;
non-continuous mode stops. Failed or stale submissions remain visible and never
start a conversation turn.

## Memory and privacy

Partial, unsubmitted, cancelled, failed, and timed-out dictation exists only in
memory for the current process/session. It is never written to conversation,
Memory, disk, or logs. No transcript history is introduced.

Only an explicit correction of a durable fact in text that has already been
successfully submitted may call the existing `FrontendMemoryService`. The
correction reuses the existing sensitive-content policy and metadata-only
`MemoryAudit`. It performs an exact replace in the existing memory document;
missing or ambiguous facts fail visibly and never create episodic history.

## Out of scope

Desktop UI, global shortcuts, OS permissions, persistent transcript history,
Realtime fallback after ASR failure, arbitrary LLM rewrites, and P1/P2 follow-up
work are explicitly excluded.
