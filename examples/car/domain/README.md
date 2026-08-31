# Cockpit domain service

This scenario-owned service is the single source of truth for the cockpit demo.
It exposes the same vehicle, navigation, music, weather, and flash-buy operations
through MCP and a small HTTP command endpoint. Cockpit panels consume snapshots
and the SSE state stream directly; business state does not pass through the
qwen-audio-agent Gateway.

```bash
npm install --prefix examples/car/domain
npm run example:car:domain
```

Endpoints:

- `POST /mcp` — stateless Streamable HTTP MCP.
- `GET /api/cockpit/state?cockpitId=default` — current snapshot.
- `GET /api/cockpit/events?cockpitId=default` — snapshot plus state updates via SSE.
- `POST /api/cockpit/commands` — direct scenario UI operations using the same tool names.

The existing self-contained car server remains available during migration. The
GCP client and A2A agent issues will switch to this service before removing the
legacy action protocol.
