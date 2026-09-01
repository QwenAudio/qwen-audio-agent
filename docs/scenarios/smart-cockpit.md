# Smart Cockpit

[`examples/smart-cockpit/`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/smart-cockpit) is a runnable cockpit scenario built on qwen-audio-agent's foreground/backend boundary. It preserves the car UI, browser voice interaction, vehicle controls, navigation, music, weather, and flash-buy flow without maintaining a second Realtime server, conversation history, or Agent loop.

## Component mapping

| Component | Example implementation | Replaceable boundary |
|---|---|---|
| `client/` | React cockpit UI + Browser Audio | GCP 6.0 / Gateway Client SDK |
| `gateway/` | qwen-audio-agent Gateway + foreground Realtime Agent | Framework reuse and scenario composition |
| `agent/` | Qwen3.8-Flash A2A cockpit Agent | BackendPort / A2A / ACP / custom Adapter |
| `service/` | Cockpit environment, state, rules, tools, and external integrations | HTTP/SSE / MCP / customer protocols |

An independent cockpit service owns vehicle, route, media, and order state. The UI observes it over HTTP/SSE while the foreground and backend Agents use scoped MCP surfaces. The Gateway neither parses scenario objects nor acts as a business-state event bus.

The example also supports voice-created, cockpit-scoped custom workflows. The backend Agent loads a workflow and composes existing MCP tools; user workflows do not dynamically change the Gateway protocol, MCP tool set, or A2A Agent Card.

The foreground can also switch among the Healer, Action, and Sharp Assistant
Profiles inside the current Realtime Session. A GCP Client Event carries only
an allowlisted ID; the Gateway maps it to deployment-owned Markdown under
`gateway/assistant/` and applies it to the next turn with `session.update`. Arbitrary
Client-supplied prompt text is never accepted.

In a customer deployment, the conversation layer may be the only retained implementation. The cockpit UI and backend Agent can both be customer-owned. A custom UI does not inherit the framework WebUI; it implements GCP plus its own audio, page, and business-state channels.

## Run

```bash
cp examples/smart-cockpit/.env.example examples/smart-cockpit/.env.local
# Set DASHSCOPE_API_KEY in .env.local; map keys are optional.
npm run example:smart-cockpit:install
npm run example:smart-cockpit
```

Open `http://localhost:5173`. The command starts service, agent, gateway, and client together.

See [`examples/smart-cockpit/README.md`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/smart-cockpit/README.md) for architecture, replacement, and test details.
