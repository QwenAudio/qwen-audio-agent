# Frontend OpenAPI tool adapter

The frontend OpenAPI adapter connects selected REST operations to the chatbot
without coupling them to a realtime provider or a backend Agent. It uses the
same dynamic tool source and execution limits as the frontend MCP client.

The OpenAPI document describes the API. A separate qwen-audio-agent policy
decides which `operationId` values are model-visible; no operation is enabled
automatically.

## Configuration

Set `QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG` to a versioned JSON file. OpenAPI
documents may use JSON or YAML and are resolved relative to this config file:

```dotenv
QWEN_AUDIO_FRONTEND_OPENAPI_CONFIG=/absolute/path/to/frontend-openapi.json
WEATHER_AUTHORIZATION=Bearer replace-me
```

```json
{
  "version": 1,
  "apis": {
    "weather": {
      "enabled": true,
      "document": "./weather.openapi.yaml",
      "baseUrl": "https://weather.example.com/v1",
      "headers": {
        "authorization": "${WEATHER_AUTHORIZATION}"
      },
      "operations": {
        "getWeather": {
          "enabled": true,
          "description": "Read the current weather for one city."
        },
        "createAlert": {
          "enabled": true,
          "description": "Create a weather alert."
        }
      }
    }
  }
}
```

Model-visible names are stable: `openapi__<api>__<operationId>`. `baseUrl`
overrides the first `servers` URL in the document when set.

## Supported boundary

- OpenAPI 3.0 and 3.1 documents stored in local JSON or YAML files.
- Explicitly enabled operations with an `operationId`.
- Path and query parameters, plus `application/json` request bodies.
- Local `$ref` values. External and recursive references fail closed.
- Fixed request headers, with an exact `${VARIABLE}` environment reference for
  secret values.
- `operations` is an explicit allowlist. Enabled operations execute inline in
  the current conversation turn.
- API services must enforce any required confirmation, authorization, or
  business safety checks themselves.
- Remote APIs require HTTPS. Loopback HTTP is allowed only without headers.
  Redirects are not followed.
- Schemas, calls, time, and results are bounded. API responses are untrusted
  data and cannot override system or user instructions.

Header and cookie parameters, non-JSON bodies, remote OpenAPI documents, and
automatic exposure of undocumented operations are intentionally unsupported in
this first version. Restart the Gateway after changing the config or document.
