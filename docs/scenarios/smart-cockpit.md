# Smart Cockpit

The repository ships a runnable smart-cockpit demo under
[`examples/car/`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/car).
It pairs a car UI with realtime speech, a text agent, vehicle control, navigation, music,
flash-buy workflows, weather, web search, memory, and user-created custom skills — a concrete
reference for putting a voice agent into a non-coding environment.

The example is intentionally self-contained: it reuses the same realtime voice and agent
patterns as qwen-audio-agent, but keeps its own server so the core runtime stays generic.

## How It Maps to the Three Layers

| Layer | In qwen-audio-agent | In the car example |
| --- | --- | --- |
| Client (the environment) | Desktop orb / TUI / WebUI | React cockpit UI: `VoiceDock`, map, music and vehicle panels |
| Gateway (conversation) | Realtime gateway + frontend agent | `server/voice/realtime.mjs` — WebSocket gateway in front of the Realtime provider |
| Backend (execution) | ACP backend agents | `server/agent.mjs` — a DashScope chat agent orchestrating skills |

Adapting to a cockpit meant swapping the client (car UI instead of a desktop orb) and the
execution layer (domain skills instead of a coding agent), while the voice conversation
pattern — full-duplex audio, barge-in, delegation, progress announcements — stays the same.

## Design Patterns Worth Reusing

- **The realtime model stays light.** It only handles audio interaction and lightweight
  routing. Anything that needs real work is delegated through a single `route_to_car_agent`
  function call to the agent, which owns the actual task logic. The voice layer never
  re-implements domain tools.
- **Capability layering.** Atomic tools (vehicle control, navigation, music APIs) are hidden
  from the model; only coarse built-in skills (`vehicle_control`, `navigation`, `music`,
  `flashbuy`, `weather`, `web_search`) plus basic system tools are exposed as function calls.
  Custom skills are Markdown workflows end users create through natural language, loaded at
  execution time via `skill_run`.
- **Voice-appropriate progress.** Skills emit staged progress events with a `speakPolicy`
  (`always` / `if_slow` / `silent`), so the cockpit announces only what is worth saying —
  "planning the route" — while the debug panel sees everything.
- **Forced routing.** For unambiguous intents the agent forces `tool_choice` on the first
  round, so the model cannot answer a vehicle-control request with plain text.
- **UI actions flow back.** Tool results produce `actions[]` that drive the cockpit panels
  (map preview, music player, cart) alongside the spoken reply.

## Run It

From the repository root:

```bash
# 1. Configure keys
cp examples/car/.env.example examples/car/.env.local
# fill in VITE_AMAP_KEY / VITE_AMAP_SECRET / AMAP_MCP_KEY / DASHSCOPE_API_KEY

# 2. Agent server (http://localhost:3001)
npm install --prefix examples/car/server
npm run example:car:server

# 3. Cockpit UI (http://localhost:5173)
npm install --prefix examples/car/react-app
npm run example:car:web
```

## Further Reading

The example carries its own design documents (Chinese):

- [System architecture](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/car/docs/system-architecture.md)
- [Agent design](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/car/docs/agent-design.md)
- [Tools and skills design](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/car/docs/tools-and-skills.md)
- [Voice interaction design](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/car/docs/voice-interaction-design.md)
