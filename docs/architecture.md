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

The backend may be OpenCode, OpenClaw, Qoder, Kimi Code, or another
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

Realtime has exactly six tools:

```text
spawn_thinking
cancel_agent_task
get_agent_task_status
get_current_time
user_memory
respond_agent_permission
```

`user_memory` keeps one small protocol for frontend-owned memory:

- `recall` reads profile or long-term text records and returns stable IDs;
- `remember` adds a new durable fact;
- `replace` atomically replaces recalled IDs when the user corrects a fact;
- `forget` removes explicitly requested records.

Only the marked managed section of `USER.md` is editable. User-maintained profile
text outside that section is returned as read-only data and cannot be replaced.

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
page” remain understandable. Final ASR remains the source of truth.

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
they become failed with an explicit restart reason. Completed results and
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
Qoder, and Kimi Code, the Gateway injects the same five tools into the
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
Kimi Code ACP, or another ACP Agent
```

Backend-specific API details belong only in `server/src/agent`. Realtime tools
must not import backend adapters. The UI consumes only public Work events and
final timeline content. Package-level `shared` modules are foundational runtime
utilities; server `core` may depend on them, but they must not depend on server
layers.

Gateway may serve the immutable `web/dist` artifact as a deployment
convenience, but this is static hosting only. Gateway source must not import UI
components, presentation text, styling, terminal behavior, or desktop behavior.
All three UIs own their rendering and map structured protocol fields to their
own labels and interaction patterns.

## 10. Process ownership

The Gateway is the only core product service. The shared adapter owns one ACP
stdio child and stops it with the Gateway. OpenCode, Qoder, and Kimi Code run
directly as ACP agents; OpenCode may additionally expose its native local
Session UI.
OpenClaw uses a small ACP bridge. Its adapter always starts and owns a dedicated
OpenClaw Gateway with isolated runtime and Session state. It may reuse the
user's model and capability configuration, but it never attaches to or shares
Session storage with a user-running OpenClaw Gateway, and it does not activate
the user's external message channels.

Desktop, TUI and WebUI are replaceable Gateway clients. They must never spawn,
restart or stop the Gateway or a backend. Closing a UI therefore cannot affect
queued work or the fixed backend Agent Session. Configuration that changes
Realtime or backend behavior takes effect on the next Gateway start; changing a
UI's Gateway URL only reconnects that UI.

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
