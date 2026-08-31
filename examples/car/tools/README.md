# Cockpit tool groups

This directory is scenario-owned business code for the smart-cockpit showcase.
It is neither Gateway core nor a third qwen-audio-agent layer.

Each directory is one scenario capability group rather than one file per MCP
function. A group keeps its MCP manifest next to its executor and receives the
shared cockpit state and external services through the execution context.

`registry.mjs` is the only composition point:

- `FRONTEND_TOOL_GROUPS` are called inline by the foreground Realtime Agent.
- `BACKEND_TOOL_GROUPS` are called by the replaceable cockpit Agent over MCP.

Both surfaces use the standard MCP contract. Adding a group requires no change
to the Gateway protocol or the cockpit UI protocol. The explicit registry is a
readable code-level extension point, not a dynamic plugin framework.
