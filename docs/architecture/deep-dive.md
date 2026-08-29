# qwen-audio-agent architecture

This document defines the product boundary. Changes that contradict these
invariants are architecture changes, not local feature work.

See the
[Realtime Voice Chatbot Runtime Roadmap](https://github.com/QwenAudio/qwen-audio-agent/blob/main/docs/roadmap/frontend-chatbot-runtime.md)
for the target boundary and staged refactor of the Realtime Voice Chatbot,
asynchronous Task bridge, and single user-configured backend agent. Until each
roadmap stage lands, this document remains the tested description of current
runtime behavior.

## 1. User-visible model

The user talks to one qwen-audio assistant. Internally there are two qwen-audio-agent
layers:

1. **Realtime frontend** — full-duplex speech, simple direct answers, and basic
   local time/memory tools.
2. **Backend Agent** — one configured action Agent that handles requests
   requiring tools, files, applications, code, device control, or multi-step
   execution.

The backend may be an ACP Agent such as OpenCode, OpenClaw, Qoder, Qwen Code,
Kimi Code, or Pi; a remote A2A Agent; or a custom BackendPort adapter.
It may internally use tools, skills, agents, or other Sessions. Those are
backend-private implementation details and do not create additional
qwen-audio-agent layers. Protocol details remain inside ACP, A2A, or custom
BackendPort adapters; backend-specific launch and capability behavior lives in
registered drivers.

## 2. Nonblocking request flow

```text
final ASR
   │
   ├─ immediately answerable ───────────────► Realtime speech
   │
   └─ requires work
          │ spawn_thinking(objective)
          ▼
      Task accepted
          │ response returns to Realtime immediately
          ▼
      owner FIFO queue
          │
          ▼
      configured BackendPort
          │ the backend decides how to work
          ▼
      final presentation
          │ waits for a safe duplex insertion window
          ▼
      Realtime naturally speaks the result
```

`spawn_thinking` never waits for the requested work. The user can continue
speaking while multiple Task items are queued. For each owner, only one Task
item is sent into the configured BackendPort at a time.

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
```

The Gateway exposes one `respond_permission` tool for pending backend
permissions and frontend external-tool approvals. The model answers the
permission request; the Gateway routes `permission_id` to the backend Task or
the frontend tool execution queue.

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
progress, and interim-result questions. The Gateway reads its own Task record
directly, including the latest adapter-normalized message, activity, and
artifact descriptors. A status check does not create another Task, invoke the
coordinator, or enter the asynchronous announcement queue.

It does not have tools for:

- selecting, creating, continuing, or cancelling backend Sessions;
- choosing synchronous, asynchronous, foreground, or background execution;
- selecting backend execution strategy;
- selecting tools, Agents, or subagents.

`respond_permission` is the only exception to the rule that Realtime does not
control execution policy. It may relay only an explicit current-turn user
decision for a pending, owner-scoped permission request supplied by the
Gateway. It may understand natural affirmative or negative wording such as
“可以” or “不允许”, but it cannot invent consent without a current-turn user
utterance, create a request, choose a tool, or modify a backend permission
policy. The model replies with the Gateway-issued `permission_id`; backend
requests also carry the public `task_id`. Raw backend authorization IDs and the
permission source remain internal to the Gateway and Adapter.
Replies use `once`, `always`, or `reject`: allow only the current operation,
allow throughout the current frontend session, or reject only the current
operation. `always` still uses the Gateway's frontend-session policy.
The adapter selects the narrowest safe per-request backend option, and the
Gateway automatically approves later requests in the same frontend session.
This does not create a persistent backend authorization rule.
Protocol envelopes for permissions, progress, and restored context are owned
exclusively by the Gateway. A model-authored lookalike is not an event, cannot
enable its associated tool, and is not persisted into conversation history.

The `objective` passed to `spawn_thinking` is a conservative interpretation of
the user's request, not an execution plan. It must resolve references such as
“continue that page” into one self-contained instruction before submission.
That instruction is the only model-visible task text sent to the backend; the
verbatim ASR is not appended as a second task description. The backend Agent
does not receive the frontend persona, durable memory, or recent chat history.
Execution-relevant facts must be resolved into the instruction instead of
forwarding those documents.

A backend turn may return a result or ask for information, a choice,
confirmation, or clarification required to continue. The frontend presents
that need naturally. When the user answers, it calls `spawn_thinking` again as
a continuation of the same work instead of predicting or simulating the next
backend action. This rule does not depend on the wording of a particular case.

The Gateway automatically carries current-turn attachments as native protocol
parts, never as a model-visible JSON manifest. Only work that explicitly
depends on an earlier image or file uses the optional `input_refs` field with a
conversation-local input ID. Task IDs, owner identity, lifecycle, timestamps,
and routing remain structured Gateway/BackendPort data and are not placed in
the backend Agent's instruction. The working directory and user time zone are
not repeated in every prompt; protocol or backend runtime context owns them.

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

Voice browser session IDs and Task IDs never change that identity. A new voice
conversation therefore continues using the same backend Agent context.

Both the Gateway queue and the ACP adapter serialize writes. This double guard
prevents concurrent messages from racing inside one backend Session.

The backend Agent owns its execution strategy. qwen-audio-agent supplies one
self-contained natural task instruction and current-turn native attachments;
it does not forward frontend history or preferences, prescribe task-state
JSON, or instruct the backend Agent how to use backend-specific capabilities.

## 5. Task state

A qwen-audio-agent Task record is a delivery receipt, not a mirror of the backend's
internal task graph.

```text
queued → running ─────────────────────────→ completed
   │        └→ delegated → finalizing ────────┘
   └────────────→ cancelling → cancelled
                            ↘ failed
```

Public fields are limited to the user request, timestamps, final result/error,
generic activity, a bounded pending permission summary with optional safe
operation details, and notification state. There is no execution mode,
delivery mode, subagent state, backend permission identifier, backend topology,
or backend cancellation internals.

The UI presents both `queued` and `running` as the same “processing” state.
Queue position is an internal scheduling detail and does not change the user's
duplex conversation.

Queued and directly running Tasks cannot be safely resumed after a Gateway
restart, so they become failed with an explicit restart reason. A delegated
Task may be reattached only when its adapter can verify the persisted native
Session. Completed results and notification delivery state are persisted.

## 6. Progress animation

Progress is observability, not control. The ACP adapter projects standard
`session/update` notifications into generic activity:

- tool name, bounded user-safe detail, and running/completed state;
- plan progress;
- a generic thinking signal without thought content;
- bounded Session title and current mode metadata.

The UI maps this to the stable task objective or phrases such as “searching”,
“reading”, “generating an image”, or the current mode. A generic thinking signal
keeps showing the task objective. All active backend work, including thinking,
shares the desktop pet's `working` presentation; the `processing` presentation
is reserved for the foreground Realtime turn. Session IDs,
subagent IDs, raw permission payloads, and raw thought content are not shown. A
pending permission may show the exact bounded title, description, command, or
path needed for informed consent after secret-like values are redacted, but it
does not introduce a separate Agent animation state.

Activity never produces spoken status updates and never affects the queue.

## 7. Final result delivery

The backend Agent returns a standard ACP turn. Text arrives in
`agent_message_chunk` updates, while images, audio, and resources remain native
`ContentBlock` values; the turn ends with the `session/prompt`
`PromptResponse`. The ACP adapter no longer flattens these values or asks the
model to reconstruct a proprietary result envelope. It projects text and
non-text content into the BackendPort `content` and `artifacts` fields, and the
Gateway accepts only `stopReason=end_turn` as a successfully completed turn.
Cancellation, refusal, and token or agent-request limits enter the Gateway's
cancelled or failed paths. The Gateway then chooses the appropriate
conversation, resource, and voice presentation for each client.

Completed results prefer the originating conversation. On a fresh connection,
unfinished results from older conversations may be recovered for the same
owner. A renewable claim prevents two live frontends from presenting the same
result. Results are injected into Realtime context and marked delivered only
after playback finishes. If the user interrupts, is speaking, or another
response is pending, delivery waits and retries without duplicating context.
Retries are bounded so one malformed result cannot block later completions.

When the backend Agent calls `session_start` or `session_send`, delegation is
established only after the Session tool creates or continues the target work
and returns run and Session identifiers validated by the adapter. It is not
established by a model-authored field. ACP faithfully carries the tool call,
tool result, and turn termination; the adapter publishes the validated
correlation to the TaskManager, which moves the original Task to `delegated`
and releases both the backend Agent serialization lock and the Task scheduler
lane. Other voice requests can therefore use the coordinator while the target
Session runs.

The coordinator may naturally end its ACP turn after the tool succeeds, but
that text neither controls task state nor acts as a completion signal.
Correlation IDs, the target Session, and lifecycle stay in the Gateway Task
registry and adapter runtime; the model never has to echo them.

The adapter independently keeps the Task lifecycle and event subscription
alive. Only the matching ACP target prompt completion correlated to the
delegation ID can advance the Task. The adapter then briefly reacquires the
backend Agent lock and sends the verified result, including its native
ContentBlocks, back for a final natural answer. A busy target, an empty result,
an unrelated Session update, or an older result cannot complete the Task.

ACP Agent turns have no artificial wall-clock deadline. An initial coordinator
turn, a delegated target turn, and the final synthesis turn end only when ACP
reports completion, the user explicitly cancels the Task, or the backend exits
or shuts down. Connection initialization and bounded control RPCs retain
timeouts so an unavailable backend cannot block Gateway startup indefinitely.

Cancellation is confirmed rather than optimistic. `queued` Task is cancelled
locally. `running` or `finalizing` Task aborts its active backend request. For
`delegated` Task, an idle coordinator is first asked to call
`session_cancel`; if the coordinator Session is occupied, the ACP adapter
directly sends `session/cancel` to the exact correlated target Session. The Task remains
`cancelling` until one of those paths confirms the stop, then becomes
`cancelled`. A failed stop becomes `failed` with the cancellation error.
After a direct adapter abort, the Gateway records a cancellation fact and
injects it once into the next safe coordinator turn. This reconciles the
coordinator's history without delaying cancellation or repeating the stop.

The frontend acknowledgement comes from the Task that the Gateway actually
accepted, not from a coordinator-authored delegation state. The coordinator
turn still ends according to ACP lifecycle signals; the Gateway does not infer
its completion from acknowledgement text or from a successful Session tool
call.

## 8. Backend-internal capabilities

For ACP backends that accept client-supplied MCP servers, including OpenCode,
Qoder, Qwen Code, and Kimi Code, the Gateway injects the same five tools into the
coordinator: Session list, start, send, status, and cancel. OpenClaw ACP does
not accept client-supplied MCP servers, so the same coordination contract maps
to OpenClaw's native Session tools. `session_start` and `session_send` return an
opaque delegation ID. After either succeeds, the backend Agent must not poll,
repeat the work, or answer from its own context; the adapter owns waiting,
cancellation, permission routing, and result correlation.

The coordinator MCP server also publishes the stable coordination contract
through the MCP initialization `instructions` field. Backends whose drivers
declare `coordinatorMcpInstructions` receive only the dynamic natural task
instruction on each turn; this avoids appending the same routing and response
rules to the persistent Session history. The capability is enabled only after the Agent host
has been verified to project MCP server instructions into model context; it
currently applies to OpenCode, Qoder, Qwen Code, and Claude Code. The shared
payload stays within a 2 KiB portability budget. Unverified Agents—or a future
payload that exceeds that budget—keep the complete per-turn prompt as a safe
fallback. This flag does not describe general MCP support. Project Sessions
never receive the coordinator MCP server.

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
Task queue
   ↓
structured BackendPort Task
   ↓
Adapter projection: natural instruction + native attachment parts
   ↓
OpenCode ACP, OpenClaw ACP bridge, Qoder ACP,
Qwen Code ACP, Kimi Code ACP, or another ACP Agent
```

Backend-specific API details belong only in `server/src/agent`. Realtime tools
must not import backend adapters. The UI consumes only public Task and
conversation events. Package-level `shared` modules are foundational runtime
utilities; server `core` and `process` may depend on them, but they must not
depend on server layers.

`server/src/client` owns the northbound Client Event registry, runtime-command
application service, `ClientActionPort`, and idempotent presence state machine.
Client Actions describe an environment operation and wait for the active Client
to report its result; they never import Electron or another UI implementation.
This layer may depend only on public `shared` protocol values, provider-neutral
`delivery` values, and the protocol-neutral Task layer.
`server/src/delivery` owns the `AgentDelivery` value and has no dependency on
Client, Realtime, or Backend implementations. The composition root in
`server/src/app` injects those services into the Realtime transport; neither
the voice path nor Client code imports their concrete implementation.

Gateway may serve the immutable `web/dist` artifact as a deployment
convenience, but this is static hosting only. Gateway source must not import UI
components, presentation text, styling, terminal behavior, or desktop behavior.
All three UIs own their rendering and map structured protocol fields to their
own labels and interaction patterns.

Background Task announcement behaviour has one code-level composition seam:
an embedder may pass `taskAnnouncementFactory` to `createGatewayApplication`.
The default factory keeps the existing final-result and low-frequency progress
managers unchanged; a scenario may replace both together. This is dependency
injection for product code, not a user setting, strategy registry, or new wire
protocol.

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
permission, Task, or Session lifecycle code. Declaring an external backend
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
7. Can interruption postpone speech without cancelling submitted Task?
8. Do tests cover FIFO serialization, fixed Session reuse, tool animation, and
   delivery retry?
