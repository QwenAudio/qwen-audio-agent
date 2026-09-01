# Frontend MCP client

The frontend MCP client is the standards-based extension boundary for adding
chatbot tools without coupling them to a realtime provider or a backend Agent.
It is separate from the dedicated Web Search provider: Web Search keeps its
small built-in fallback, while general MCP servers are configured by the user.

The Gateway discovers the explicitly enabled tools at startup, gives them
stable names, and adds them to each Realtime session through the shared
frontend tool registry and executor.

## Configuration

Set `QWEN_AUDIO_FRONTEND_MCP_CONFIG` to a versioned JSON file:

```dotenv
QWEN_AUDIO_FRONTEND_MCP_CONFIG=/absolute/path/to/frontend-mcp.json
DOCUMENT_MCP_AUTHORIZATION=Bearer replace-me
```

```json
{
  "version": 1,
  "servers": {
    "documents": {
      "enabled": true,
      "transport": {
        "type": "streamable-http",
        "url": "https://mcp.example.com/mcp",
        "headers": {
          "authorization": "${DOCUMENT_MCP_AUTHORIZATION}"
        }
      },
      "connectTimeoutMs": 8000,
      "tools": {
        "search": {
          "enabled": true,
          "timeoutMs": 8000,
          "maxResultBytes": 32768,
          "maxCallsPerTurn": 2,
          "description": "Search the user's configured document source."
        },
        "create_issue": {
          "enabled": true,
          "description": "Create an issue in the configured tracker."
        }
      }
    }
  }
}
```

Local MCP servers can use standard input and output:

```json
{
  "version": 1,
  "servers": {
    "filesystem": {
      "enabled": true,
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "${FILES_ROOT}"],
        "env": {
          "SERVICE_TOKEN": "${SERVICE_TOKEN}"
        },
        "cwd": "${MCP_WORKING_DIRECTORY}"
      },
      "tools": {
        "list_directory": { "enabled": true }
      }
    }
  }
}
```

For compatibility, top-level `url` and `headers` fields still select Streamable
HTTP. Top-level `command`, `args`, `env`, and `cwd` fields are also accepted as
stdio shorthand. New configurations should use the explicit `transport` object.

Each exposed tool receives a stable model-visible name:
`mcp__<server>__<tool>`. Tools omitted from `tools`, or without
`enabled: true`, are never exposed.

## Current policy

- Streamable HTTP and stdio transports are supported. The legacy standalone SSE
  transport is not supported.
- Discovery and connection have a bounded timeout (8 seconds by default).
- Remote servers require HTTPS. Loopback HTTP is allowed only without headers.
- A server URL may be one exact environment reference such as `${MCP_URL}`.
- Header values may reference one exact environment variable with
  `${VARIABLE}`. A missing variable is a configuration error.
- The Gateway starts stdio servers directly without a shell and closes their child
  processes when it shuts down. `command`, arguments, environment values, and
  `cwd` may use exact environment references; a configured `cwd` must be absolute.
  The child receives only the SDK's safe base environment plus explicit `env` values.
- `tools` is an explicit allowlist. Enabled tools execute inline in the current
  conversation turn; the Gateway does not insert a generic confirmation turn
  based on whether a tool reads or writes.
- Behavioral metadata such as `readOnlyHint` and `destructiveHint` belongs to
  the MCP server's standard Tool Annotations. It is metadata, not Gateway policy.
- MCP servers must enforce any required confirmation, authorization, or business
  safety checks inside their own capability boundary.
- Schemas, descriptions, calls, time, and results are bounded. MCP results are
  treated as untrusted data and cannot override system or user instructions.
- If an enabled tool is absent or invalid during discovery, that server fails
  closed and exposes no partial tool set.

Restart the Gateway after changing this file. Secrets should be passed through
environment variables instead of committed to JSON.
