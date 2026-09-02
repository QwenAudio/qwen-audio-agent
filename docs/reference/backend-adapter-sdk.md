# Backend Adapter SDK

The Backend Adapter SDK connects non-ACP action systems to qwen-audio-agent.
A phone agent, hardware agent, HTTP service, or other task runtime implements
the protocol-neutral `BackendPort`; voice interaction, the Task queue,
authorization relay, and result delivery remain unchanged.

## Import

```js
import {
  createBackendAgentHost,
  defineBackendAdapter,
  verifyBackendAdapterConformance,
} from 'qwen-audio-agent/backend-adapter-sdk'
```

The SDK exports:

- `defineBackendAdapter` for composition-time method validation;
- `createBackendAgentHost` for embedded Gateway composition;
- `BackendWorkRuntime` for projecting a Gateway Task into `submit`;
- `BackendEventType` and `backendEvent` for normalized backend events;
- `verifyBackendAdapterConformance`, shared with the built-in ACP adapter;
- `assertBackendPort`, `BACKEND_PORT_METHODS`, and the contract error type.

## BackendPort

An adapter implements the complete surface:

```js
{
  describe,
  start,
  health,
  submit,
  status,
  cancel,
  respondAuthorization,
  respondInput,
  subscribe,
  close,
}
```

`start` and `close` are idempotent. `status()` without a Task ID returns
runtime status; with an ID it addresses only that Gateway Task. `submit`,
`status`, `cancel`, `respondAuthorization`, and `respondInput` share one `taskId`. Private
sessions, remote task IDs, and topology never cross the port.

`submit(task)` receives a structured internal Task plus one canonical
`instruction`. An adapter may use routing and correlation fields internally,
but an Agent-facing ACP prompt, A2A text part, or equivalent must contain only
`instruction` and native attachment parts. Do not serialize the Task object,
IDs, owner, lifecycle, verbatim ASR, working directory, time zone, frontend
memory, or chat history into model-visible text. Custom non-model adapters may
consume the structured Task directly.

The final `submit` result contains at least:

```js
{
  content: 'Factual material for the frontend',
  artifacts: [],
}
```

`content` is the sole factual text that the frontend Chatbot understands,
summarizes, and expresses naturally. An adapter must not prescribe separate
spoken wording. Files, images, and structured output use `artifacts`;
BackendPort does not prescribe a Conversation Client presentation.

Do not return raw protocol objects, session IDs, tokens, or credentials.
Progress is published through `subscribe` as backend events correlated by
`taskId` and `ownerId`; a failing observer cannot interrupt execution.

Adapters may publish protocol-neutral optional observations without expanding
the `BackendPort` method surface:

```js
{
  type: 'backend.activity',
  taskId,
  ownerId,
  activity: {
    id: 'stable-observation-id',
    kind: 'thinking', // or tool, plan, mode, session, status, ...
    status: 'running',
  },
}
```

Incremental messages and artifacts use `backend.message` and
`backend.artifact`. ACP `session/update`, A2A streaming events, and custom
callbacks must be normalized inside the adapter; raw protocol payloads never
reach TaskManager or the frontend.

`kind` is extensible. Common display fields include `status`, `message`,
`label`, `detail`, `category`, `tool`, `title`, `updatedAt`, `mode`, `completed`,
and `total`; adapter-specific fields may be added. Reusing an activity `id`
updates that observation and makes it the most recent one. Never put raw
reasoning, credentials, private task IDs, or protocol payloads in public
activity.

Authorization requests use `backend.permission.requested` with a normalized
permission. In addition to a bounded `summary`, an adapter may provide an
optional safe `operation` (`title`, `kind`, `description`, `command`, `path`,
and bounded file `locations`) plus `approvalScope`. Public `session` scope means
the current frontend session only; persistent provider authorization must not
be inferred from it. Adapters that do not support authorization keep rejecting
`respondAuthorization` explicitly, as before.

Backend questions use `backend.input.requested` and remain part of the active
Task. The adapter must keep `submit` pending until `respondInput` resumes that
same operation, then emit `backend.input.resolved`. The request carries a
bounded prompt and `text`, `form`, or `url` mode; protocol-native objects and
remote IDs remain private. Adapters without interactive input reject
`respondInput` explicitly.

## Gateway composition

```js
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'
import { createBackendAgentHost } from 'qwen-audio-agent/backend-adapter-sdk'
import { MyBackendAdapter } from './my-backend.mjs'

const agent = createBackendAgentHost(new MyBackendAdapter())
const application = createGatewayApplication({ agent })

process.once('SIGTERM', () => application.close())
```

This entry is for custom Node launchers. Existing `AGENT_PROTOCOL` values still
select built-in backends and never load arbitrary code dynamically. A complete
non-ACP in-memory example lives in
[`examples/backend-adapter`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/backend-adapter).

## Conformance

Each third-party adapter should provide fresh instances, two Task values, and
one holdable Task to the public suite:

```js
await verifyBackendAdapterConformance({
  createFixture: async ({ hold }) => ({
    backend: new MyBackendAdapter({ hold }),
    work,
    nextWork,
    started,
  }),
})
```

The suite checks idempotent lifecycle, result boundaries, event and owner
isolation, duplicate Tasks, cancellation, and subscription cleanup. Protocol-
specific capabilities remain inside the adapter; ACP does not need to be
emulated.
