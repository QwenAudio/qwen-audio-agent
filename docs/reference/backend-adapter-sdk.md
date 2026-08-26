# Backend Adapter SDK

The Backend Adapter SDK connects non-ACP action systems to qwen-audio-agent.
A phone agent, hardware agent, HTTP service, or other task runtime implements
the protocol-neutral `BackendPort`; voice interaction, the Work queue,
authorization relay, and result presentation remain unchanged.

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
- `BackendWorkRuntime` for projecting Gateway Work into `submit`;
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
  subscribe,
  close,
}
```

`start` and `close` are idempotent. `status()` without a Work ID returns
runtime status; with an ID it addresses only that Gateway Work. `submit`,
`status`, `cancel`, and `respondAuthorization` accept Gateway Work IDs only.
Private sessions, task IDs, and topology never cross the port.

`submit(work)` receives structured internal Work plus one canonical
`work.instruction`. An adapter may use routing and correlation fields internally,
but an Agent-facing ACP prompt, A2A text part, or equivalent must contain only
`instruction` and native attachment parts. Do not serialize the Work object,
IDs, owner, lifecycle, frontend memory, or chat history into model-visible
text. `originalRequest` is bounded source evidence already incorporated into
the canonical instruction when needed; `workingDirectory` and `timeZone` are
likewise rendered as execution context. Custom non-model adapters may consume
the structured Work directly.

The final `submit` result contains at least:

```js
{
  content: 'Factual material for the frontend',
  artifacts: [],
  presentation: { speech: 'Material for natural expression', inline: null },
}
```

Do not return raw protocol objects, session IDs, tokens, or credentials.
Progress is published through `subscribe` as backend events correlated by
`workId` and `ownerId`; a failing observer cannot interrupt execution.

Adapters may publish protocol-neutral optional observations without expanding
the `BackendPort` method surface:

```js
{
  type: 'backend.activity',
  workId,
  ownerId,
  activity: {
    id: 'stable-observation-id',
    kind: 'thinking', // or tool, plan, mode, session, status, ...
    status: 'running',
  },
}
```

`kind` is extensible. Common presentation fields include `status`, `message`,
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
[`examples/backend-adapter`](../../examples/backend-adapter/README.md).

## Conformance

Each third-party adapter should provide fresh instances, two Work values, and
one holdable Work to the public suite:

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
isolation, duplicate Work, cancellation, and subscription cleanup. Protocol-
specific capabilities remain inside the adapter; ACP does not need to be
emulated.
