# Qwen Audio Agent Car

English | [中文](README_ZH.md)

This smart-cockpit reference scenario is rebuilt on the qwen-audio-agent three-layer framework. It preserves the main cockpit UI and interactions without maintaining a second Realtime gateway, conversation history implementation, or Agent loop.

The cockpit UI and cockpit Agent are replaceable examples, not mandatory framework modules. The reusable core is the Gateway, foreground realtime conversation, GCP Client SDK, BackendPort, A2A, and MCP seams.

## Quick start

From the repository root:

```bash
cp examples/car/.env.example examples/car/.env.local
```

Set at least:

```dotenv
DASHSCOPE_API_KEY=your_dashscope_api_key
```

Optionally configure `VITE_AMAP_KEY`, `VITE_AMAP_SECRET`, and `AMAP_MCP_KEY` for AMap rendering and route services. Install the example dependencies and start all four processes:

```bash
npm run example:car:install
npm run example:car
```

Open `http://localhost:5173`.

| Process | Default address | Responsibility |
|---|---|---|
| cockpit-client | `http://127.0.0.1:5173` | Scenario UI, browser audio I/O, business panels |
| cockpit-gateway | `http://127.0.0.1:18888` | Foreground conversation, tools, Tasks, speech, interruption, recovery |
| cockpit-agent | `http://127.0.0.1:3020` | Small replaceable A2A backend example |
| cockpit-domain | `http://127.0.0.1:3010` | Authoritative business state, HTTP/SSE, MCP capabilities |

Press `Ctrl+C` to stop all processes.

A preflight validates the Realtime configuration and all four ports before any child process starts. Missing credentials and stale instances therefore produce one actionable error instead of several child-process stack traces.

## Boundaries

- The UI talks to the Gateway through GCP and knows nothing about the Realtime provider or backend Agent.
- The primary cockpit stays voice-only. Transcripts appear only in the debug panel, and ASR displays final results only.
- Scenario-specific HTTP/SSE projects vehicle, route, media, weather, and order state. The Gateway does not parse those objects.
- The foreground Agent owns realtime conversation and submits cockpit work through the fixed `spawn_thinking` bridge. The scenario customizes only the backend capability description in [`spawn-thinking-tool.mjs`](spawn-thinking-tool.mjs), while the tool name and argument contract stay fixed.
- The example backend attaches over A2A and invokes domain capabilities through MCP. It intentionally implements only a small intent router.
- Customers can replace the UI, backend Agent, or domain service without changing the framework core.

## Development and tests

```bash
npm run example:car:lint
npm run example:car:build
npm run test:car
```

See [architecture and data flow](docs/architecture.md), [component replacement](docs/replacing-components.md), and the [test matrix](docs/test-matrix.md).
