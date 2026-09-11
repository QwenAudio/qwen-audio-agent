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
- The default routing puts `vehicle`, `navigation`, `music`, and `weather` on
  the foreground fast path and keeps `flashbuy` and `custom-skills` on the
  backend path.

Both surfaces use the standard MCP contract. Adding a group requires no change
to the Gateway protocol or the cockpit UI protocol. A domain group may safely
move between surfaces because execution still has one implementation and one
authoritative state source. The explicit registry is a readable code-level
extension point, not a dynamic plugin framework.

`gateway/frontend-mcp.json` is the checked-in default foreground consumer
configuration. `gateway/server.mjs` generates a matching runtime profile bundle
from the active routing before the Gateway starts, so environment overrides and
benchmark runs use the same domain routing as the Service.

`custom-skills/` is one such domain group. It exposes a fixed list/create/load
contract rather than registering one MCP tool per user skill. Loaded skill text
is workflow data and cannot expand the backend tool allowlist.
