# A2A Backend Adapter

The optional A2A Backend Adapter connects one remote A2A agent to the existing
`BackendPort`. It uses the official A2A JavaScript SDK for Agent Card discovery,
protocol negotiation, messages, Tasks, cancellation, and Artifact decoding.
A2A objects remain private to the adapter; the Gateway, Work runtime, frontend,
and clients continue to use their protocol-neutral contracts.

This is a programmatic extension for custom Gateway launchers. It does not add
an `AGENT_PROTOCOL` value or a Desktop setting.

## Connect an agent

```js
import { createGatewayApplication } from 'qwen-audio-agent/gateway-application'
import { createBackendAgentHost } from 'qwen-audio-agent/backend-adapter-sdk'
import {
  createA2ABackendAdapter,
} from 'qwen-audio-agent/a2a-backend-adapter'

const backend = createA2ABackendAdapter({
  agentCardUrl: 'https://agent.example/.well-known/agent-card.json',
  token: process.env.MY_A2A_TOKEN,
})
const agent = createBackendAgentHost(backend)
const application = createGatewayApplication({ agent })

process.once('SIGTERM', () => application.close())
```

`agentCardUrl` is the complete public Agent Card URL. It must use HTTP or HTTPS
and cannot contain credentials. Use `token` for Bearer authentication, or
`headers` for another scheme:

```js
const backend = createA2ABackendAdapter({
  agentCardUrl: process.env.MY_A2A_AGENT_CARD_URL,
  headers: async () => ({
    Authorization: `Bearer ${await refreshAccessToken()}`,
    'X-Tenant': 'tenant-one',
  }),
})
```

Configured headers are applied to both discovery and task requests but are
never returned by `describe()`. An in-memory standard `agentCard` can replace
URL discovery. JSON-RPC and HTTP+JSON/REST are supported; the first compatible
interface declared by the Agent Card is selected. A2A 0.3 compatibility is
enabled by default through the official SDK and can be disabled with
`legacyCompat: false`.

## Work projection

- The Work objective becomes the user Message text.
- Input attachments become standard A2A raw or URL Parts with MIME types.
- The adapter requests non-blocking execution, then polls `GetTask` so Gateway
  status and cancellation remain responsive without requiring streaming.
- A2A status updates become `backend.activity` events.
- Final A2A Artifacts become standard Gateway Artifacts; the final agent status
  Message supplies natural speech material.
- `CancelTask` is used when the remote task ID is known. Local cancellation
  still terminates a request that has not received a Task ID yet.

Gateway Work IDs never become remote task identities. The mapping exists only
while a submission is active and remote IDs do not cross `BackendPort`.

## State mapping

| A2A Task state | Backend state |
| --- | --- |
| `SUBMITTED` | `submitted` |
| `WORKING` / `UNSPECIFIED` | `working` |
| `COMPLETED` | completed outcome |
| `FAILED` / `REJECTED` | failed outcome |
| `CANCELED` | cancelled outcome |
| `INPUT_REQUIRED` / `AUTH_REQUIRED` | explicit unsupported-interaction error |

A2A does not assign universal semantics to an authorization decision after
`AUTH_REQUIRED`; agents define that through their own flow or an extension.
The adapter therefore does not guess credentials or approval behavior. A
future authorization extension can be implemented inside this adapter without
changing Work or frontend contracts.

## Options

- `agentCardUrl` or `agentCard`: exactly one discovery source is required;
- `token`, `headers`, `fetchImpl`: authentication and transport hooks;
- `acceptedOutputModes`: requested result MIME types;
- `pollIntervalMs`: task polling interval, default 1 second;
- `timeoutMs`: per-Work timeout, default 5 minutes;
- `legacyCompat`: official A2A 0.3 compatibility, default enabled;
- `clientFactory`: test or advanced transport injection.

Run the public Backend Adapter conformance suite for any derived adapter. The
built-in A2A adapter itself is covered by conformance tests plus an A2A 1.0
HTTP+JSON discovery and task round trip.
