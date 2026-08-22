# qwen-audio-agent architecture

This document defines the product boundary. Changes that contradict these
invariants are architecture changes, not local feature work.

## 1. User-visible model

The user talks to one qwen-audio assistant. Internally there are two qwen-audio-agent
layers:

1. **Realtime frontend** — full-duplex speech, simple direct answers, and basic
   local time/memory tools.
2. **Backend Agent** — one persistent Agent Session that owns every request
   requiring tools, current information, files, applications, code, or
   multi-step work.

The backend may be OpenCode, OpenClaw, Qoder, Qwen Code, Kimi Code, Pi, or another
ACP-compatible Agent.
It may internally use tools, skills, agents, or other Sessions. Those are
backend-private implementation details and do not create additional
qwen-audio-agent layers. All backends connect through one ACP client and one
shared coordination adapter; backend-specific launch and capability behavior
lives in registered drivers.

## 2. Nonblocking request flow

```text
final ASR
   │
   ├─ immediately answerable ───────────────► Realtime speech
   │
   └─ requires work
          │ spawn_thinking(objective)
          ▼
      Work accepted
          │ response returns to Realtime immediately
          ▼
      owner FIFO queue
          │
          ▼
      fixed Backend Agent Session
          │ the backend decides how to work
          ▼
      final presentation
          │ waits for a safe duplex insertion window
          ▼
      Realtime naturally speaks the result
```

`spawn_thinking` never waits for the requested work. The user can continue
speaking while multiple Work items are queued. For each owner, only one Work
item is sent into the Backend Agent Session at a time.

## 3. Realtime boundary

Realtime keeps a deliberately small tool set — few tools, low latency, no
multi-step orchestration. The base tools are:

```text
spawn_thinking
schedule_reminder
cancel_agent_task
get_agent_task_status
get_current_time
memory
notes
respond_agent_permission
```

`memory` maintains two ordinary Markdown documents through one flat interface. Each call is one
atomic `read`, `append`, or `replace` operation. `replace` locates a unique source fragment, and
fails safely if that fragment is missing or ambiguous. Realtime may issue several calls
in one turn; the Gateway merges their follow-up response. The documents have different authority:

- `user` is the current user's long-term personalization overlay: forms of
  address, relationship, the assistant's name for that user, language, expression
  style, and default behavior. It is injected as user-authorized directive material,
  overrides the instance-wide defaults from `ASSISTANT.md`, and yields to the user's
  current utterance.
- `memory` contains durable facts and decisions used for understanding and answers,
  never as instructions. The scopes are separated by behavioral authority, not topic.

Neither scope can authorize leaking internal structure, skipping permission
checks, or changing task and safety protocols. The packaged `PROMPT.md` remains
the core policy and cannot be overridden by personalization. Local `ASSISTANT.md`
contains only the assistant instance's default identity, personality, relationship
stance, and expression style. The assistant never edits it through memory. It is
created from the packaged template once, preserved across upgrades, and reloaded
for the next voice session after an edit.

Besides explicit tool writes, a session-end extractor reconciles missed explicit user
directives and durable facts. It routes the former to `USER.md` and the latter to
`MEMORY.md` through the same context service used by the realtime tool. It never writes
files directly or modifies `ASSISTANT.md`, rejects document-boundary mistakes and sensitive
content, records outcomes in a local audit file, and silently disables itself when no
text-model API key is configured.

`notes` manages user-named lists (shopping lists, todos, reading lists) as
frontend-owned volatile collections: single-call add, show, match-remove,
clear, and drop with no backend involvement. Lists are item data, not memory;
stable facts remain in `memory`, and list items are never written into the
user preferences or factual memory. Item and list resolution matches exact text first, then a
unique case-insensitive substring, and otherwise reports ambiguity with the
candidate names back to the model for clarification. `clear` and `drop`
additionally require an explicit destructive intent in the current turn.

`get_agent_task_status` is the single Realtime entry point for lifecycle,
progress, and interim-result questions. The Gateway answers non-delegated Work
directly. For `delegated` Work it creates a hidden, high-priority control query
that uses the coordinator to call `session_status`. The query waits behind an
already-running coordinator turn but ahead of ordinary queued Work, and its
result is delivered through the normal asynchronous announcement path. It is
not exposed as a user Work item and cannot become the implicit target of a
later status or cancellation request.

It does not have tools for:

- selecting, creating, continuing, or cancelling backend Sessions;
- choosing synchronous, asynchronous, foreground, or background execution;
- selecting backend execution strategy;
- selecting tools, Agents, or subagents.

`respond_agent_permission` is the only exception to the rule that Realtime does
not control backend execution. It may relay only an explicit current-turn user
decision for a pending, owner-scoped permission request supplied by the
Gateway. It may understand natural affirmative or negative wording such as
“可以” or “不允许”, but it cannot invent consent without a current-turn user
utterance, create a request, choose a tool, or modify a backend permission
policy. Replies are limited to `always` and `reject`; `always` uses the
backend's Session-scoped permission option when available.

The `objective` passed to `spawn_thinking` is a conservative interpretation of
the user's request, not an execution plan. Recent voice context is separately
included in the backend Agent envelope so references such as “continue that
page” remain understandable. Final ASR remains the source of truth. The Gateway
automatically carries current-turn attachments. Only work that explicitly
depends on an earlier image or file uses the optional `input_refs` field with a
conversation-local input ID; calls without multimodal input remain unchanged.

## 4. Fixed Backend Agent Session

The ACP adapter owns one persistent coordinator Session identity per owner and
backend:

```text
qwen-audio-agent:<owner>:backend
```

The Gateway stores the native ACP Session ID behind that stable key and calls
`session/resume` on later turns. Project delegation likewise resumes the
selected native Session in its recorded working directory, so voice-originated
work remains in the backend's own Session history rather than a Gateway copy.

Voice browser session IDs and Work IDs never change that identity. A new voice
conversation therefore continues using the same backend Agent context.

Both the Gateway queue and the ACP adapter serialize writes. This double guard
prevents concurrent messages from racing inside one backend Session.

The backend Agent owns its execution strategy. qwen-audio-agent supplies the user
request, recent voice context, local preferences, and a final response shape;
it does not instruct the backend Agent how to use backend-specific capabilities.

## 5. Work state

A qwen-audio-agent Work record is a delivery receipt, not a mirror of the backend's
internal task graph.

```text
queued → running ─────────────────────────→ completed
   │        └→ delegated → finalizing ────────┘
   └────────────→ cancelling → cancelled
                            ↘ failed
```

Public fields are limited to the user request, timestamps, final result/error,
generic tool activity, a bounded pending permission summary, and notification
state. There is no execution mode, delivery mode, subagent state, backend
permission identifier, backend topology, or backend cancellation internals.

The UI presents both `queued` and `running` as the same “processing” state.
Queue position is an internal scheduling detail and does not change the user's
duplex conversation.

Active Work cannot be safely resumed after a Gateway restart, so
it becomes failed with an explicit restart reason. Completed results and
notification delivery state are persisted.

## 6. Progress animation

Progress is observability, not control. The ACP adapter projects standard
`session/update` notifications into generic activity:

- tool name, bounded user-safe detail, and running/completed state;
- text/reasoning activity represented only as “organizing result”.

The UI maps this to stable phrases such as “searching”, “reading”, “generating
an image”, or “organizing the result”. Session IDs, subagent IDs, raw permission
payloads, and raw reasoning are not shown. A pending permission may show the
exact bounded operation or command needed for informed consent, after
secret-like values are redacted.

Activity never produces spoken status updates and never affects the queue.

## 7. Final result delivery

The backend Agent returns one final presentation:

```json
{
  "work_id": "work id",
  "state": "completed",
  "mode": "respond",
  "presentation": {
    "speech": "concise result material",
    "inline": null
  }
}
```

`speech` is semantic material, not a script. Realtime adapts it to the live
conversation. `inline` carries Markdown, code, or links for the shared
timeline.

Completed results prefer the originating conversation. On a fresh connection,
unfinished results from older conversations may be recovered for the same
owner. A renewable claim prevents two live frontends from presenting the same
result. Results are injected into Realtime context and marked delivered only
after playback finishes. If the user interrupts, is speaking, or another
response is pending, delivery waits and retries without duplicating context.
Retries are bounded so one malformed result cannot block later completions.

When the backend Agent hands work to another native backend Session, the
intermediate transport response is instead:

```json
{
  "work_id": "work id",
  "state": "delegated",
  "mode": "delegate",
  "delegation_id": "opaque run id",
  "target_session_id": "opaque backend Session id",
  "presentation": {
    "speech": "a natural confirmation authored by the backend Agent",
    "inline": null
  }
}
```

This response is never a user-visible completion. The adapter immediately
lets the backend Agent naturally finish this short post-tool response, moves
the original Work to `delegated`, and
releases both the backend Agent serialization lock and the Work scheduler
lane. Other voice requests can therefore use the coordinator while the target
Session runs. The adapter independently keeps the Work lifecycle and event
subscription alive. Only the matching ACP target prompt completion correlated
to the delegation ID can complete the Work. The adapter then briefly
reacquires the backend Agent lock and sends that verified result to it for
final presentation. A busy target, an empty result, an unrelated Session
update, or an older result cannot complete the Work.

The normal backend request timeout applies separately to the initial
coordinator turn and the final presentation turn. It does not apply while the
adapter is waiting for the delegated Session. During that interval, only an
explicit Work cancellation or backend shutdown cancels the target Session.

Cancellation is confirmed rather than optimistic. `queued` Work is cancelled
locally. `running` or `finalizing` Work aborts its active backend request. For
`delegated` Work, an idle coordinator is first asked to call
`session_cancel`; if the coordinator Session is occupied, the ACP adapter
directly sends `session/cancel` to the exact correlated target Session. The Work remains
`cancelling` until one of those paths confirms the stop, then becomes
`cancelled`. A failed stop becomes `failed` with the cancellation error.
After a direct adapter abort, the Gateway records a cancellation fact and
injects it once into the next safe coordinator turn. This reconciles the
coordinator's history without delaying cancellation or repeating the stop.

The delegated `presentation` is authored by the backend Agent with normal
reasoning and is spoken immediately as a start confirmation. It may explain
what was created, submitted, or planned, but it is not a final result. The
adapter aborts the backend turn only as a timeout fallback if it fails to finish
after the asynchronous Session tool has already succeeded.

## 8. Backend-internal capabilities

For ACP backends that accept client-supplied MCP servers, including OpenCode,
Qoder, Qwen Code, and Kimi Code, the Gateway injects the same five tools into the
coordinator: Session list, start, send, status, and cancel. OpenClaw ACP does
not accept client-supplied MCP servers, so the same coordination contract maps
to OpenClaw's native Session tools. `session_start` and `session_send` return an
opaque delegation ID. After either succeeds, the backend Agent must not poll,
repeat the work, or answer from its own context; the adapter owns waiting,
cancellation, permission routing, and result correlation.

`session_status` is observational only. If the query fails, the backend Agent
must report the failure; it must not inspect the target directory with native
tools or duplicate the delegated work.

Frontend code must not depend on which internal capability was chosen.
Frontend task snapshots may expose only a bounded title and generic delegated
state, never delegation IDs, target Session IDs, directories, or raw events.

## 9. Dependency direction

```text
WebUI / TUI / Desktop
   ↓ WebSocket and HTTP
Realtime Gateway
   ↓ spawn_thinking
Work queue
   ↓
backend Agent envelope
   ↓
Shared ACP adapter
   ↓
OpenCode ACP, OpenClaw ACP bridge, Qoder ACP,
Qwen Code ACP, Kimi Code ACP, or another ACP Agent
```

Backend-specific API details belong only in `server/src/agent`. Realtime tools
must not import backend adapters. The UI consumes only public Work events and
final timeline content. Package-level `shared` modules are foundational runtime
utilities; server `core` and `process` may depend on them, but they must not
depend on server layers.

Gateway may serve the immutable `web/dist` artifact as a deployment
convenience, but this is static hosting only. Gateway source must not import UI
components, presentation text, styling, terminal behavior, or desktop behavior.
All three UIs own their rendering and map structured protocol fields to their
own labels and interaction patterns.

## 10. Process ownership

The Gateway is the only core product service. Backend lifecycles use one shared
`owned/external` ownership model:

- `owned`: Gateway starts the required local backend processes and stops them
  on exit. The native backend process loads its own user configuration, models,
  tools, and MCP servers; the adapter supplies only protocol parameters and
  required shared capabilities.
- `external`: available only to backends declaring external-service support.
  Gateway does not start, move, or stop that backend. It connects through the
  backend's published protocol address and leaves configuration and state under
  the external service's control.

Backend service ownership and the ACP connection are independent axes. Each
backend profile declares an `acpConnection`; the connection factory currently
implements `process`, which launches one local ACP stdio child. A future remote
ACP bridge can add another connection kind without changing coordinator,
permission, Work, or Session lifecycle code. Declaring an external backend
service does not by itself make the ACP connection remote.

Each backend is registered through one validated plugin contract. Its catalog
entry owns identity, installation, native onboarding, process environment and
ownership metadata; its Agent and Runtime drivers declare explicit boolean
capabilities and are rejected at startup when incomplete or inconsistent.
Backend child processes receive only portable operating-system variables and
the selected plugin's declared credential namespace. Gateway identity,
Realtime, memory, and other backend secrets never cross that boundary. A
generic ACP command may opt in additional names explicitly through
`QWEN_AUDIO_AGENT_ACP_FORWARD_ENV`.

The HTTP/WebSocket application is constructed by an injectable composition
root. Importing the application factory does not bind a port; CLI and Desktop
use the thin bootstrap entry while tests and future clients may supply isolated
Agent, task, conversation, configuration, and logging services.

The shared adapter usually owns one ACP stdio child and stops it with Gateway.
OpenCode, Qoder, Qwen Code, and Kimi Code run directly as ACP agents; OpenCode may also
start its native local Session UI service. `OPENCODE_BASE_URL` currently names
that UI service, not a remote ACP execution endpoint, so OpenCode remains
`owned`.

OpenClaw uses a small ACP bridge. Without an explicit address, Gateway starts
an OpenClaw Gateway with isolated runtime and Session state. When
`OPENCLAW_BASE_URL` is explicit, it connects to the user's existing OpenClaw
Gateway without reading, copying, or modifying its authentication or Agent
state. Service ownership is then `external`, while the ACP connection remains
a local `process`: the official local bridge connects to the remote OpenClaw
Gateway over WebSocket/WSS. External connections bypass the short local-startup
port probe so the bridge can report the real network, TLS, and authentication
result. A local bridge exit interrupts ACP only and never changes the remote
Gateway lifecycle.

Codex follows the same boundary: qwen-audio-agent starts `codex-acp` over ACP
stdio, and that adapter starts Codex App Server over its own local stdio
protocol. Codex App Server may expose other transports, but they are not a
remote ACP endpoint and must not leak into the shared ACP adapter.

Desktop, TUI and WebUI are replaceable Gateway clients. The Gateway is the single
owner of its active Realtime model and publishes the exact model profile and
transport capabilities through health. Desktop may configure and restart only
its locally owned Gateway; WebUI and TUI treat the profile as read-only. Borrowed
or remote Gateway model mismatches are rejected rather than silently overridden.
Closing a UI cannot affect queued work or the fixed backend Agent Session.
Configuration that changes Realtime or backend behavior takes effect on the next
Gateway start; changing a UI's Gateway URL only reconnects that UI.

The macOS desktop renderer is packaged inside the application. Electron serves
those immutable assets from a private, random loopback path and proxies only
Gateway HTTP API and Realtime WebSocket traffic. Desktop UI assets must not be
loaded from the Gateway: rebuilding the desktop application must be sufficient
to update its appearance without upgrading the running Gateway frontend.

## 11. Review checklist

Before merging a change, verify:

1. Can Realtime still converse while backend work is queued or running?
2. Does every executable request enter the same persistent backend Agent
   Session?
3. Did any frontend API gain knowledge of Session, subagent, permission, or
   execution mode?
4. Are tool events used only for generic UI progress?
5. Is completion spoken only from a final backend Agent result?
6. Did any UI begin managing a Gateway or backend process?
7. Can interruption postpone speech without cancelling submitted Work?
8. Do tests cover FIFO serialization, fixed Session reuse, tool animation, and
   delivery retry?
