# Smart Cockpit

[`examples/car/`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/car) is a runnable cockpit scenario built on the three-layer framework. It preserves the car UI, browser voice interaction, vehicle controls, navigation, music, weather, and flash-buy flow without maintaining a second Realtime server, conversation history, or Agent loop.

## Three-layer mapping

| Layer | Example implementation | Replaceable boundary |
|---|---|---|
| Client | React cockpit UI + Browser Audio | GCP 6.0 / Gateway Client SDK |
| Conversation control | qwen-audio-agent Gateway + foreground Realtime Agent | Reused framework core |
| Backend execution | Small A2A cockpit Agent | BackendPort / A2A / ACP / custom Adapter |

An independent domain service owns vehicle, route, media, and order state. The UI observes it over HTTP/SSE while the backend Agent invokes it through MCP. The Gateway neither parses scenario objects nor acts as a business-state event bus.

In a customer deployment, the conversation layer may be the only retained implementation. The cockpit UI and backend Agent can both be customer-owned. A custom UI does not inherit the framework WebUI; it implements GCP plus its own audio, page, and business-state channels.

## Run

```bash
cp examples/car/.env.example examples/car/.env.local
# Set DASHSCOPE_API_KEY in .env.local; map keys are optional.
npm run example:car:install
npm run example:car
```

Open `http://localhost:5173`. The command starts domain, agent, gateway, and client together.

See [`examples/car/README.md`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/car/README.md) for architecture, replacement, and test details.
