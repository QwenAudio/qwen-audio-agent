# Adding a New Backend

The integration philosophy: **over protocol, never per-product**. The Gateway
talks to a protocol-neutral `BackendPort`; it never touches a backend's
internals. There are four ways to put a backend behind that port, from zero
code to first-class support.

## Path 1: generic ACP (zero code)

Before writing anything, check whether the agent already speaks ACP. If it
does, users can attach it with configuration alone:

```dotenv
AGENT_PROTOCOL=acp
ACP_COMMAND=your-agent --acp
# Optional: comma-separated environment names forwarded to the agent process
QWEN_AUDIO_AGENT_ACP_FORWARD_ENV=MY_AGENT_API_KEY
```

This is the full integration for many agents.

## Path 2: a remote A2A agent

If the agent speaks Google's A2A protocol instead of ACP, the optional A2A
Backend Adapter connects it to the same `BackendPort` — Agent Card discovery,
protocol negotiation, Tasks, cancellation, and Artifacts are handled by the
official A2A SDK inside the adapter. This is a programmatic extension for
custom Gateway launchers; it does not add an `AGENT_PROTOCOL` value.

→ [A2A Backend Adapter](../reference/a2a-backend-adapter.md)

## Path 3: a custom BackendPort adapter

Phone agents, hardware agents, HTTP services, or any non-ACP task runtime can
implement `BackendPort` directly with the Backend Adapter SDK
(`qwen-audio-agent/backend-adapter-sdk`). The SDK ships a shared conformance
suite — the same one the built-in adapters run — and
[`examples/backend-adapter/`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/backend-adapter)
is a minimal working implementation.

→ [Backend Adapter SDK](../reference/backend-adapter-sdk.md)

## Path 4: a first-class ACP backend

First-class means one-click install, capability declarations, and desktop
onboarding. It is assembled from three ingredients, two of which are enforced
by the registry at startup and in tests.

### Ingredient 1: catalog entry (required)

`shared/backend-catalog.mjs` holds the static metadata — identity, storage,
and onboarding. One entry describes:

- `id` / `label` — the `AGENT_PROTOCOL` value and the display name.
- `setup` — how the CLI is found (`command`, `executableEnvironment`) and
  the integration shape: `native` (speaks ACP itself), `bridge`
  (built-in bridge), `adapter` (external ACP adapter process), or
  `generic`.
- `lifecycle.installation` — the one-click install steps (npm packages or
  platform scripts); `null` when installation is user-managed.
- `onboarding` — the command the user runs to authenticate, plus a probe
  the desktop app uses to detect readiness.
- `skills` — **mandatory declaration**: the skills.sh installer id, an
  explicit `installer: null` (covered passively by the shared
  `~/.agents/skills/` convention), or `skills: null` (no skill convention).
  A missing declaration fails registration — every backend must make an
  explicit skill-support decision.
- `supportsFullPermission`, `baseUrlEnvironment`, `supportsExternalService`,
  `environment` passthrough names/prefixes.

### Ingredient 2: agent driver (required)

`server/src/agent/backends/<id>.mjs`, plus one import line in
`registry.mjs`. The driver declares the capability contract and builds the
runtime profile:

```js
export const myBackendDriver = {
  id: 'myagent',
  label: 'My Agent',
  capabilities: {
    delegation: true,          // can receive delegated async tasks
    permissions: true,         // surfaces permission prompts
    backendUi: false,          // has its own UI surface
    nativeSessionHistory: true,// keeps its own session history
    externalMcp: true,         // loads MCP servers from its own config
    nativeDelegation: false,   // has a native sub-agent mechanism
    sessionMcp: false,         // accepts per-session MCP injection
    coordinatorMcpInstructions: false, // relays MCP instructions to the coordinator
  },
  createProfile({ root, directory, model, modelUrl, permissionMode }) {
    return {
      label: this.label,
      acpConnection: processAcpConnection({
        command, args, cwd: directory, env: { /* backend-specific env */ },
      }),
    }
  },
}
```

All eight capability flags are required booleans — the registry validates
the contract, and `backend-driver-registry.test.mjs` asserts every
advertised backend has a complete driver. A half-registered backend fails
loudly at startup, never silently at runtime.

### Ingredient 3: runtime driver (only when needed)

`server/src/process/backend-drivers/` owns process-level behavior — how
the managed service is spawned and supervised. Most backends need nothing
here: the registry falls back to a managed-process driver derived from the
catalog entry. OpenCode and OpenClaw are the two with custom runtime
drivers (external-service support, custom spawn rules).

## Checklist

1. Pick the path: ACP agent → Path 1 or 4; A2A agent → Path 2; anything
   else → Path 3.
2. For a first-class backend: add the catalog entry in
   `shared/backend-catalog.mjs`, add the agent driver and register it, and
   optionally add a runtime driver for custom process ownership.
3. Run the contract tests — they are the gate:
   `node --test server/test/backend-driver-registry.test.mjs` for ACP
   drivers, `node --test server/test/backend-adapter-sdk.test.mjs` for
   custom adapters.

## Read next

- [Backend support matrix](overview.md) — what ships today
- [Backend configuration reference](../configuration/backend.md)
