# Lightweight Frontend Profiles

A Frontend Profile is a local, versioned composition manifest that selects a
frontend assistant persona and external tool configurations through one entry
point. It can keep or share a frontend setup as a directory without introducing
a new skill or plugin protocol.

## Configuration

Create a directory:

```text
research-profile/
├── frontend-profile.json
├── ASSISTANT.md
└── tools/
    ├── mcp.json
    └── openapi.json
```

`frontend-profile.json`:

```json
{
  "version": 1,
  "name": "research",
  "description": "A voice frontend for research and source review",
  "assistant": "./ASSISTANT.md",
  "toolSources": {
    "mcp": "./tools/mcp.json",
    "openapi": "./tools/openapi.json"
  }
}
```

Enable it:

```dotenv
QWEN_AUDIO_FRONTEND_PROFILE=/absolute/path/to/research-profile/frontend-profile.json
```

`assistant`, `toolSources.mcp`, and `toolSources.openapi` are optional, but at
least one must be present. References must be relative paths to existing files
inside the profile directory. MCP and OpenAPI files retain their own versioned
formats and authorization policies; the profile does not duplicate those
protocols.

## Precedence

Existing focused settings have higher priority and can temporarily override a
profile:

1. `QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH`, `QWEN_AUDIO_FRONTEND_MCP_CONFIG`,
   and `QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG`;
2. references in the Frontend Profile;
3. qwen-audio-agent defaults.

`frontendProfile` in `/api/health` reports only enablement, name, and
description. It never exposes local paths.

## Boundaries

A Frontend Profile cannot change the core prompt and does not contain user
memory, a Realtime Provider, a backend Agent, secrets, scripts, or executable
code. Secrets remain environment references in MCP/OpenAPI configurations.
Unknown fields, paths outside the profile directory, and missing files fail
explicitly during Gateway startup.

Web Search keeps its independent Provider configuration. Without user
configuration, only the simple built-in search fallback is used; profiles do
not add a search-engine fallback chain.
