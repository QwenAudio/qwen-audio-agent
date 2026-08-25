# Frontend MCP client

The frontend MCP client is the standards-based extension boundary for adding
chatbot tools without coupling them to a realtime provider or a backend Agent.
It is separate from the dedicated Web Search provider: Web Search keeps its
small built-in fallback, while general MCP servers are configured by the user.

This first foundation release defines configuration, discovery, namespacing,
health, execution, and result boundaries. Wiring discovered tools into live
Realtime sessions is tracked as the next Roadmap step.

## Configuration

Set `QWEN_AUDIO_FRONTEND_MCP_CONFIG` to a versioned JSON file:

```env
QWEN_AUDIO_FRONTEND_MCP_CONFIG=/absolute/path/to/frontend-mcp.json
DOCUMENT_MCP_TOKEN=replace-me
```

```json
{
  "version": 1,
  "servers": {
    "documents": {
      "enabled": true,
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "authorization": "Bearer ${DOCUMENT_MCP_TOKEN}"
      },
      "tools": {
        "search": {
          "enabled": true,
          "readOnly": true,
          "timeoutMs": 8000,
          "maxResultBytes": 32768,
          "maxCallsPerTurn": 2,
          "description": "Search the user's configured document source."
        }
      }
    }
  }
}
```

Each exposed tool receives a stable model-visible name:
`mcp__<server>__<tool>`. Tools omitted from `tools`, or without
`enabled: true`, are never exposed.

## Current policy

- Streamable HTTP is the initial transport.
- Remote servers require HTTPS. Loopback HTTP is allowed only without headers.
- Header values may reference one exact environment variable with
  `${VARIABLE}`. A missing variable is a configuration error.
- Every enabled tool must explicitly set `readOnly: true`. Mutating tools stay
  unavailable until the generic frontend approval path is implemented.
- Schemas, descriptions, calls, time, and results are bounded. MCP results are
  treated as untrusted data and cannot override system or user instructions.
- If an enabled tool is absent or invalid during discovery, that server fails
  closed and exposes no partial tool set.

Restart the Gateway after changing this file. Secrets should be passed through
environment variables instead of committed to JSON.
