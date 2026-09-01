# Cockpit tool groups

This directory is scenario-owned business code for the smart-cockpit showcase.
It is neither Gateway core nor a third qwen-audio-agent layer.

Each directory is one scenario capability group rather than one file per MCP
function. A group keeps its MCP manifest next to its executor and receives the
shared cockpit state and external services through the execution context.

`registry.mjs` is the only composition point:

- Capability implementations stay grouped by domain in `COCKPIT_TOOL_GROUPS`.
- `FRONTEND_TOOL_NAMES` selects simple low-latency tools called inline by the
  foreground Realtime Agent.
- The backend MCP surface retains every scenario tool so the replaceable
  cockpit Agent can compose them in complex tasks and user-defined workflows.

Both surfaces use the standard MCP contract. Adding a group requires no change
to the Gateway protocol or the cockpit UI protocol. A domain group may safely
serve both surfaces because execution still has one implementation and one
authoritative state source. The explicit registry is a readable code-level
extension point, not a dynamic plugin framework.

`custom-skills/` is one such domain group. It exposes a fixed list/create/load
contract rather than registering one MCP tool per user skill. Loaded skill text
is workflow data and cannot expand the backend tool allowlist.
