# A2A Backend Adapter

The optional A2A Backend Adapter connects one remote A2A agent to the existing
`BackendPort`. It uses the official A2A JavaScript SDK for Agent Card discovery,
protocol negotiation, messages, Tasks, cancellation, and Artifact decoding.
A2A objects remain private to the adapter; the Gateway, Task runtime, frontend,
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

## Task projection

- The canonical Task instruction becomes the user Message text; frontend
  history, memory, Gateway IDs, and routing metadata are not sent remotely.
- Input attachments become standard A2A raw or URL Parts with MIME types.
- When the Agent Card advertises streaming, the adapter consumes native events;
  otherwise it requests non-blocking execution and polls `GetTask`.
- A2A status, Message, and Artifact updates become `backend.activity`,
  `backend.message`, and `backend.artifact`, continuously updating one Gateway
  Task.
- Final Artifacts become standard Gateway Artifacts; the final agent status
  Message supplies natural speech material.
- `CancelTask` is used when the remote task ID is known. Local cancellation
  still terminates a request that has not received a Task ID yet.

The Gateway `taskId` never becomes a remote task identity. The mapping exists only
while a submission is active and remote IDs do not cross `BackendPort`.

## State mapping

| A2A Task state | Backend state |
| --- | --- |
| `SUBMITTED` | `submitted` |
| `WORKING` / `UNSPECIFIED` | `working` |
| `COMPLETED` | completed outcome |
| `FAILED` / `REJECTED` | failed outcome |
| `CANCELED` | cancelled outcome |
| `INPUT_REQUIRED` | `input_required`; wait for `respondInput` and continue the same remote Task |
| `AUTH_REQUIRED` | `auth_required`; surface the remote request and continue the same remote Task after input |

A2A does not assign universal credential or approval semantics after
`AUTH_REQUIRED`. The adapter therefore exposes the Agent's status message as a
protocol-neutral input request; it never guesses credentials. The answer is
sent as a new user Message carrying the same remote Task and Context IDs, while
the Gateway keeps the original Task active.

## Options

- `agentCardUrl` or `agentCard`: exactly one discovery source is required;
- `token`, `headers`, `fetchImpl`: authentication and transport hooks;
- `acceptedOutputModes`: requested result MIME types;
- `pollIntervalMs`: task polling interval, default 1 second;
- `timeoutMs`: optional per-Task timeout; disabled by default so protocol Tasks
  can run until completion or explicit cancellation;
- `requestTimeoutMs`: timeout for unscoped requests such as Agent Card
  discovery, default 30 seconds;
- `legacyCompat`: official A2A 0.3 compatibility, default enabled;
- `clientFactory`: test or advanced transport injection.

Run the public Backend Adapter conformance suite for any derived adapter. The
built-in A2A adapter itself is covered by conformance tests plus A2A 1.0
HTTP+JSON discovery, task round-trip, and streaming-event tests.
