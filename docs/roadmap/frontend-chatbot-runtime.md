# Realtime Voice Chatbot Runtime Roadmap

> Status: Proposal
>
> GitHub tracking: [#185](https://github.com/QwenAudio/qwen-audio-agent/issues/185)
>
> Scope: while retaining one active backend agent, refactor qwen-audio-agent
> into a clearly bounded, extensible, standards-oriented realtime voice
> chatbot runtime that connects to the user's own action agent through an
> asynchronous work bridge.

## 1. Product definition

qwen-audio-agent contains two decoupled runtimes that appear to the user as one
assistant:

1. The **Realtime Voice Chatbot** owns the conversation. It handles voice,
   text, images, attachments, context, memory, search, knowledge/RAG, bounded
   low-latency tools, and presentation.
2. The **Backend Action Agent** accesses files, code, applications, devices,
   and external systems. It performs long-running, multi-step, or privileged
   work using its own model, configuration, tools, MCP servers, skills, and
   sessions.

`spawn_thinking` is the only model-visible work handoff between them. It sends
the user's objective and input references; the frontend never selects backend
sessions, execution modes, delegation strategies, tools, or sub-agents.

Only one user-selected backend is active. Multi-backend routing is outside this
roadmap.

## 2. Architecture invariants

1. With no backend configured, frontend chat, memory, search, and knowledge/RAG
   continue to work.
2. Backend queuing, execution, authorization, and failure never block the live
   conversation.
3. `spawn_thinking` waits only for intake, never for completion.
4. The frontend presents each backend result naturally and exactly once.
5. Frontend Runtime never depends on ACP or a backend product.
6. Work Runtime contains no session, coordinator-MCP, or backend-topology
   knowledge.
7. Backend adapters emit standard work events and artifacts; they never send
   client events directly.
8. Realtime providers never call the backend or choose work strategy.
9. Clients consume the public protocol and never infer internal state machines.
10. RAG indexing and memory extraction are system jobs, not user backend work.

## 3. Target boundaries

```text
Desktop / WebUI / TUI
          │ AG-UI compatible events + qwen.audio extensions
          ▼
Gateway Transport
          ▼
Frontend Chatbot Runtime
├── Realtime Session / Conversation Context
├── Frontend Tool Runtime
├── Search / Knowledge
├── Memory / Notes / Reminder
└── Presentation Runtime
          │ WorkSubmissionPort
          ▼
Work Runtime
├── State / Queue / Authorization
├── Artifact / Notification / Recovery
└── Scheduler
          │ BackendPort
          ▼
Single Backend Runtime
          ▼
ACP / future A2A / custom Backend Adapter
```

Dependency direction is fixed:

```text
Transport → Application → Domain ← Adapter
```

## 4. Core contracts

### RealtimeProviderPort

Providers expose `connect`, `updateSession`, `sendAudio`, `sendInput`,
`sendToolResult`, `createResponse`, `cancelResponse`, `close`, `capabilities`,
and `subscribe`. DashScope, OpenAI-compatible, Speech-to-Speech, and private
providers implement this port.

### FrontendTool

Each tool declares its name, description, input/output schemas, executor, and a
policy:

```text
mode: inline | background | control
readOnly / requiresApproval
timeoutMs / maxResultBytes / maxCallsPerTurn
```

`inline` tools return within the turn; `background` tools return an intake
receipt (`spawn_thinking`); `control` tools query or change existing work.

### Work

Work records carry internal and user-facing identity, owner, conversation,
turn, original request, objective, multimodal inputs, state, activity,
authorization, artifacts, presentation, and timestamps. Public states align
with A2A Task semantics: `submitted`, `working`, `auth_required`, `completed`,
`failed`, and `cancelled`. Gateway-specific phases remain internal.

### BackendPort

Backends implement `describe`, `start`, `health`, `submit`, `status`, `cancel`,
`respondAuthorization`, `subscribe`, and `close`. ACP sessions, coordinator
prompts, coordinator MCP, and native delegation stay inside the ACP adapter.
Every adapter implements the complete method surface and is checked at the
composition boundary. Optional capabilities are declared by `describe()` and
rejected explicitly, never inferred from a missing function. `submit`,
`status`, `cancel`, and `respondAuthorization` operate on Gateway Work IDs;
backend-private session and task identifiers never cross the port.
AgentClient owns exactly one injected backend instance. Driver selection,
profile construction, and protocol-specific dependencies belong to the adapter
factory rather than the runtime facade.

### Artifact and Presentation

Artifacts use the A2A-aligned `artifactId`, `name`, `description`, and Parts
shape. Each Part contains exactly one of text, URL, base64 raw content, or
structured data plus its MIME type. Authorization is a bounded Work request
with identity, state, summary, category, and timestamps; it carries a decision
request, never credentials. Presentation contains factual material and delivery
policy for the frontend, not a script that must be spoken verbatim.

Restart recovery is an explicit Work policy: safe reminders are rescheduled,
recoverable delegated runs are reattached, interrupted execution fails once,
and a persisted cancellation intent remains cancelled. Result delivery uses a
durable claimant lease; acknowledgement is checkpointed before its event is
published, and only an unacknowledged or expired lease may be replayed.

## 5. Standards strategy

| Boundary | Strategy |
| --- | --- |
| Client ↔ Gateway | Gradually project stable AG-UI events; use `qwen.*` extensions for audio, playback, ownership, and sleep |
| Gateway ↔ realtime model | OpenAI Realtime-compatible provider port |
| Model tools | Function Calling + JSON Schema |
| External tools and data | MCP; OpenAPI adapter for REST services |
| Gateway ↔ backend agent | ACP today; A2A-aligned internal semantics and a future A2A adapter |
| Multimodal content | MIME type plus text, URI, binary, or structured-data parts |
| Observability | Structured logs and progressively OpenTelemetry-aligned traces |

External protocols enter through projectors and adapters; they do not become
the internal domain model.

## 6. Frontend capability boundary

The frontend may run bounded short tool loops governed by total latency, call
count, result size, and interruption policy. It owns multimodal conversation,
history, preferences, memory, notes, reminders, web search, URL fetch,
citations, full context, knowledge/RAG, work control, authorization relay, and
natural result presentation.

Filesystem and shell access, code projects, application/device/browser
control, long-running or privileged work, sub-agents, sessions, plans,
delegation strategy, and backend MCP/skills/models remain backend-private.

## 7. Migration releases

### R0 — Freeze the architecture

- [ ] Merge this roadmap and the bilingual architecture RFC.
- [ ] Enforce dependency direction.
- [ ] Add characterization tests for current critical behavior.

### R1 — Protocol and client state

- [x] Add Zod schemas for Gateway client, server, and task events.
- [x] Introduce domain events and public event projectors.
- [x] Add an AG-UI compatibility projector without removing current events.
- [x] Extract a shared Gateway client and state reducer.
- [x] Migrate WebUI, TUI, and Desktop one at a time.

### R2 — Frontend Chatbot Runtime

- [x] Extract realtime session, turn, input, playback, and presentation logic.
  - [x] Centralize per-connection turn generation, correlation, and interruption boundaries.
  - [x] Extract provider audio/transcription and manual-input lifecycles.
  - [x] Extract response correlation, playback, and presentation lifecycles.
  - [x] Extract the realtime provider session lifecycle.
- [x] Add Frontend Tool Registry, Policy, and Executor.
  - [x] Extract the declarative Registry and visibility Policy.
  - [x] Route execution through the Registry-owned Executor.
- [x] Migrate existing tools without renaming or changing behavior.
- [x] Make `spawn_thinking` a first-class background tool.
- [x] Add a bounded short tool loop.

### R3 — Work Runtime

- [x] Extract state machine, scheduler, repository, and notification concerns.
  - [x] Centralize task phases, legal transitions, and public snapshots.
  - [x] Keep concurrency and lane limits in the dedicated scheduler.
  - [x] Extract notification claim, lease, release, and delivery state.
  - [x] Extract durable Work records and short job-id allocation.
- [x] Separate user work from system jobs.
- [x] Add artifact and authorization models.
- [x] Preserve restart, cancellation, and exactly-once delivery semantics.

### R4 — Backend Runtime

- [x] Define and validate BackendPort.
- [x] Reduce AgentClient to the single-backend runtime.
- [x] Implement BackendPort in the ACP adapter.
- [x] Move coordinator and session tools into the ACP boundary.
- [ ] Add a reusable backend-adapter conformance suite.

### R5 — Complete the frontend

- [ ] Web search provider, URL fetch, and citations.
- [ ] Knowledge store, document extraction, and indexing system jobs.
- [ ] Full context, retrieval provider, and RAG tools.
- [ ] Routing, citation, interruption, duplicate-speech, and prompt-injection
      evaluations.

### R6 — Open the ecosystem

- [ ] MCP client with per-tool policy and enablement.
- [ ] OpenAPI tool adapter.
- [ ] Lightweight frontend profiles; do not invent a public skill standard.
- [ ] Backend adapter SDK and examples.
- [ ] Optional A2A backend adapter.

## 8. Target repository shape

```text
server/src/
├── app/                  # composition root
├── transport/            # HTTP / WebSocket / AG-UI projectors
├── frontend/             # chatbot runtime
├── work/                 # user work domain
├── backend/              # backend port/runtime/adapters
├── providers/realtime/   # realtime provider adapters
└── platform/             # config/identity/persistence/logging/security

shared/                   # migration-time protocol and client runtime
packages/                 # protocol/client/backend-sdk after contracts settle
```

Directories move only with responsibility extraction and tests; the roadmap
does not authorize a cosmetic mass rename.

## 9. Enforced dependency rules

```text
frontend/        must not import backend/adapters/
work/            must not import ACP, sessions, or backend products
transport/       must not implement domain state machines
providers/       must not call BackendPort
backend/adapters must not emit client events directly
clients          must not infer internal Gateway state
shared/protocol  must not depend on server
```

## 10. Quality gates

Every stage runs lint, the complete test suite, release checks, public-protocol
compatibility tests, no-backend chat tests, non-blocking background-work tests,
interruption tests, exactly-once presentation tests, and adapter/provider
conformance suites.

Refactor PRs do not change user behavior by default. Behavioral changes require
their own commit, bilingual documentation, and end-to-end tests.

## 11. Non-goals

- Multiple concurrently active or automatically routed backend agents.
- Turning the frontend into a coding agent or general long-running agent.
- Migrating to Open WebUI, LiveKit, or another full platform.
- Immediately replacing the existing Gateway protocol.
- Inventing new MCP, A2A, or skill protocols.
- Exposing backend sessions or private task topology for uniformity.
