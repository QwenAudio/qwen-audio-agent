# Cockpit tool groups

This directory is scenario-owned business code for the smart-cockpit showcase.
It is neither Gateway core nor a third qwen-audio-agent layer.

Each directory is one scenario capability group rather than one file per MCP
function. A group keeps its MCP manifest next to its executor and receives the
shared cockpit state and external services through the execution context.

`registry.mjs` is the only composition point:

- Capability implementations stay grouped by domain in `COCKPIT_TOOL_GROUPS`.
- `surface-routing.json` selects whether each complete domain is exposed on the
  foreground Realtime MCP surface or the backend Agent MCP surface.
- `FRONTEND_TOOL_NAMES` and `BACKEND_TOOL_NAMES` are generated from that routing
  configuration rather than maintained as per-function allowlists.
- The default routing puts `vehicle`, `navigation`, `music`, `weather`, and
  `custom-skills` on the foreground path (37 tools), with only `flashbuy` on the
  backend Service path (1 tool). The Agent's 2 framework web-retrieval tools
  are composed separately and are not part of these 38 scenario tools.

Both surfaces use the standard MCP contract. Adding a group requires no change
to the Gateway protocol or the cockpit UI protocol. A domain group may safely
move between surfaces because execution still has one implementation and one
authoritative state source. The explicit registry is a readable code-level
extension point, not a dynamic plugin framework.

`gateway/frontend-mcp.json` is the checked-in default foreground consumer
configuration. `gateway/server.mjs` generates a matching runtime profile bundle
from the active routing before the Gateway starts, so environment overrides and
benchmark runs use the same domain routing as the Service.

`custom-skills/` exposes a fixed list/create/load contract rather than one MCP
tool per user skill. The foreground loads workflows, directly executes their
foreground steps, and delegates only backend steps. A structured temperature
event rule stores a range and reminder instead of executable code. The Service
emits a trigger only on a transition from outside to inside that range; the
client forwards the event for one spoken reminder. UI climate controls use the
same temperature tool and authoritative state as voice controls.

Screen route-preference changes are separate, silent context events. Both event
schemas and their presentation policy belong to `gateway/environment-events.mjs`,
not these business tools. Foreground MCP tools use the Gateway's combined
response handling and a configurable 10-second default timeout.

Loaded skills remain user data: they cannot change system instructions, expand
tool permissions, or replace the standard Markdown memory tools and policy.
