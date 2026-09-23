# Customer Service Voice Agent

The customer service example applies qwen-audio-agent to retail and airline support.
The voice frontend handles conversation, identity verification, and lookups; it delegates
business operations to a backend Agent over A2A. Frontend and backend use separate MCP
surfaces over one business service, which validates eligibility, amounts, inventory, and approval.

## Demo

The recording shows a voice-driven order cancellation: identity verification, order lookup,
a refund preview, and submission only after the customer's explicit consent.

<video controls playsinline preload="metadata" poster="https://raw.githubusercontent.com/QwenAudio/qwen-audio-agent/main/examples/customer-service/assets/customer-service-demo-poster.jpg" style="width: 100%; border-radius: 12px;">
  <source src="https://github.com/user-attachments/assets/e0f9fefa-f24b-47e5-bc2c-8402fc107df4" type="video/mp4">
</video>

## Core features

- Retail covers order lookup, cancellation, returns, and address changes; airline covers reservations, cancellation, flight and cabin changes, and more.
- Frontend MCP handles verification and read-only lookups. The backend Agent handles writes requiring approval; both surfaces share business state and rules.
- Writes produce a preview first and commit only after explicit consent. Decline, cancellation, and timeout do not apply the pending operation.
- The customer workspace shows calls and business state, the human desk receives handoff context, and an optional Policy console inspects and edits demo rules.

## Architecture

| Component | Responsibility and interface |
|---|---|
| `client/` | Customer workspace; captures and plays voice and speaks the Gateway Client Protocol. |
| `gateway/` | Voice frontend, verification and lookup tools, scenario assistant; delegates business tasks over A2A. |
| `agent/` | Backend Agent; runs multi-step operations and waits for or resumes customer approvals. |
| `service/` | Retail or airline state, rules, and separate frontend/backend MCP tool surfaces. |
| `desk/`, `console/` | Human handoff view and optional Policy console, outside the voice call's critical path. |

## Run the example

From the repository root, install dependencies and create `examples/customer-service/.env.local`
using [`.env.example`](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/customer-service/.env.example)
as a reference. Set at least `DASHSCOPE_API_KEY` with access to the required models.
The backend Chat Completions and frontend Realtime APIs use separate endpoints.

```bash
npm install
npm run example:customer-service:install
npm run example:customer-service           # Retail
# Or: npm run example:customer-service:airline  # Airline
```

Open the retail workspace at `http://127.0.0.1:4620` or the airline
workspace at `http://127.0.0.1:4720`, and grant microphone access. Verify identity, look up
an order or reservation, then decline or accept a cancellation or flight change to see that
the business state changes only after explicit consent.

This is a local, single-call demo, not a production customer service system or a complete
official τ-bench implementation. See the [example README](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/customer-service/README.md)
for complete setup, demo steps, limitations, and tests; the optional evaluation interface is
documented in the [Benchmark guide](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/customer-service/benchmark/README.md).
