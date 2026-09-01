# Cockpit service

This scenario-owned service is the single source of truth for the cockpit demo.
It is supporting business infrastructure, not another qwen-audio-agent layer.
It exposes scenario operations through two scoped MCP surfaces and a small HTTP
command endpoint. Cockpit panels consume snapshots
and the SSE state stream directly; business state does not pass through the
qwen-audio-agent Gateway.

```bash
npm install --prefix examples/smart-cockpit/service
npm run example:smart-cockpit:service
```

Endpoints:

- `POST /mcp/frontend` — foreground MCP surface; weather, vehicle-state queries,
  and window, sunroof, headlight, and climate control.
- `POST /mcp/backend` — complete backend Agent MCP surface for composed work,
  including custom skill discovery, creation, and loading.
- `GET /api/cockpit/state?cockpitId=default` — current snapshot.
- `GET /api/cockpit/events?cockpitId=default` — snapshot plus state updates via SSE.
- `POST /api/cockpit/commands` — direct scenario UI operations using the same tool names.
- `GET /api/cockpit/skills` and `GET/DELETE /api/cockpit/skills/:id` —
  scenario UI projection for persistent, cockpit-scoped custom skills.

Tool manifests and executors live under [`tools/`](tools/); this service owns
their shared state, business rules, external integrations, and protocol transports.
External AMap access is isolated under `integrations/amap/`. The foreground
consumer allowlist lives with the Gateway in `../gateway/frontend-mcp.json`;
it does not duplicate the Service executors.
Custom skill records live under `../.runtime/custom-skills/`; they are user data
and remain separate from the transient cockpit state snapshot.
