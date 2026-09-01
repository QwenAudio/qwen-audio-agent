# Cockpit foreground composition

This directory is the smart-cockpit foreground composition root. It uses the
public qwen-audio-agent Gateway API and contains no vehicle, navigation, media,
or order execution logic.

- `server.mjs` wires the Gateway to the replaceable A2A backend Agent.
- `frontend-profile.json` selects the default Assistant and foreground tool sources.
- `frontend-mcp.json` enables the Service tools exposed to the foreground Agent.
- `spawn-thinking-tool.mjs` describes the fixed asynchronous task bridge.
- `assistant/` owns trusted foreground persona Prompts and validates the
  scenario-specific Client Event.

The cockpit Client owns labels, images, and selectable UI options. It sends only
an allowlisted persona id; this directory owns what that id means to the
foreground Agent.
