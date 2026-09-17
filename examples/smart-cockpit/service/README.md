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

- `POST /mcp/frontend` — by default, 37 tools for vehicle, navigation, music,
  weather and custom skills, including route planning and skill creation/loading.
- `POST /mcp/backend` — by default, the `flashbuy` tool. The Agent's web search
  and page retrieval are composed separately, not supplied by this endpoint.
- `GET /api/cockpit/state?cockpitId=default` — current snapshot.
- `GET /api/cockpit/events?cockpitId=default` — snapshot plus state updates via SSE.
- `POST /api/cockpit/commands` — direct scenario UI operations using the same tool names.
- `GET /api/cockpit/skills` and `GET/DELETE /api/cockpit/skills/:id` —
  scenario UI projection for persistent, cockpit-scoped custom skills.

Tool manifests and executors live under [`tools/`](tools/); this service owns
their shared state, business rules, external integrations, and protocol transports.
External AMap access is isolated under `integrations/amap/`. Domain ownership
comes from `tools/surface-routing.json` and its environment overrides; a domain
is exposed on one MCP surface at a time. The Gateway generates its runtime
consumer configuration from the same routing. `../gateway/frontend-mcp.json`
is the checked-in default, not a second routing source or a second executor.
Custom skill records live under `../.runtime/custom-skills/`; they are user data
and remain separate from the transient cockpit state snapshot.
