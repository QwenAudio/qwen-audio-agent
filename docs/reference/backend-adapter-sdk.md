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
