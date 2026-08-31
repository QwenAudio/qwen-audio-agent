# Lightweight Cockpit A2A Agent

This directory is deliberately a small, replaceable backend example. It is not
the qwen-audio-agent framework and does not implement a general-purpose Agent
runtime. Tool calls stay inside the backend. If a replacement Agent derives an
independent Session, that Session may act as a third execution layer extended
from the backend; this lightweight example intentionally does not do so.

The example exposes an A2A 1.0 Agent Card and JSON-RPC endpoint. A compact
intent router selects one of the existing cockpit MCP tools; the authoritative
state and business rules remain in `../domain`.

```bash
npm install
npm start
```

Defaults:

- A2A Agent: `http://127.0.0.1:3020`
- Agent Card: `http://127.0.0.1:3020/.well-known/agent-card.json`
- Cockpit MCP: `http://127.0.0.1:3010/mcp/backend?cockpitId=default`

Environment variables:

- `COCKPIT_AGENT_HOST`
- `COCKPIT_AGENT_PORT`
- `COCKPIT_DOMAIN_ORIGIN`
- `COCKPIT_ID`

Customers replace this entire service with their own A2A, ACP or custom
backend Agent. The Gateway and cockpit client do not depend on its internal
router or implementation.
