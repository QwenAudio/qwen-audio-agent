# Model-powered Cockpit A2A Agent

This directory contains the example's real backend Agent. Qwen3.8-Flash interprets
the task, chooses standard function tools, and can execute multiple cockpit MCP
calls in sequence. The implementation stays deliberately replaceable: it is not
the qwen-audio-agent framework, and tool calls remain private to the backend.

The service exposes an A2A 1.0 Agent Card and JSON-RPC endpoint. Its Agent loop
discovers tools from the backend MCP surface and feeds tool results back to the
model until it produces a final answer. Authoritative state and business rules
remain in `../service`.

At the start of each task the Agent reads the small custom-skill catalog. A
matched workflow is loaded through `custom_skill_load`, then executed with the
same ordinary MCP tools as any other cockpit task. Skill text is user data, not
an authority or a way to add tools dynamically.

```bash
npm install
npm start
```

Defaults:

- A2A Agent: `http://127.0.0.1:3020`
- Agent Card: `http://127.0.0.1:3020/.well-known/agent-card.json`
- Cockpit MCP: `http://127.0.0.1:3010/mcp/backend?cockpitId=default`

Environment variables:

- `DASHSCOPE_API_KEY` (required)
- `DASHSCOPE_MODEL` (defaults to `qwen3.8-flash` with thinking enabled)
- `DASHSCOPE_BASE_URL` (defaults to DashScope's OpenAI-compatible endpoint)
- `COCKPIT_AGENT_HOST`
- `COCKPIT_AGENT_PORT`
- `COCKPIT_SERVICE_ORIGIN`
- `COCKPIT_ID`

Customers can replace this entire service with their own A2A, ACP or custom
backend Agent. The Gateway and cockpit client depend only on the backend
protocol, not on this model or Agent-loop implementation.
