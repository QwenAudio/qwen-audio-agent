# Cockpit domain service

This scenario-owned service is the single source of truth for the cockpit demo.
It is supporting business infrastructure, not another qwen-audio-agent layer.
It exposes scenario operations through two scoped MCP surfaces and a small HTTP
command endpoint. Cockpit panels consume snapshots
and the SSE state stream directly; business state does not pass through the
qwen-audio-agent Gateway.

```bash
npm install --prefix examples/car/domain
npm run example:car:domain
```

Endpoints:

- `POST /mcp/frontend` — foreground MCP surface; weather only.
- `POST /mcp/backend` — backend Agent MCP surface; vehicle, navigation, music, and flash-buy.
- `GET /api/cockpit/state?cockpitId=default` — current snapshot.
- `GET /api/cockpit/events?cockpitId=default` — snapshot plus state updates via SSE.
- `POST /api/cockpit/commands` — direct scenario UI operations using the same tool names.

Tool manifests and executors live under `../tools`; this service owns only their
shared state, external service dependencies, and protocol transport.
