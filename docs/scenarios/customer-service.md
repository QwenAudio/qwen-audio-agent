# Customer Service

> **Scenario blueprint — not a deployable capability today.**
> qwen-audio-agent is a personal-assistant runtime: one Gateway serves **one
> active voice client at a time** (a second client is told the gateway is
> occupied). A customer-service deployment with many concurrent visitors
> requires multi-client support that is still on the
> [roadmap](https://github.com/QwenAudio/qwen-audio-agent/issues/251).
> This page records how the scenario maps onto the architecture for when that
> lands — and what already works in single-seat form today.

## What already works today (single seat)

Everything in this section is a shipped capability, usable for one operator
or one visitor at a time — for example an agent-assist console for a human
operator, or a kiosk that serves visitors sequentially:

- **Service persona** — `ASSISTANT.md` defines the assistant's name,
  personality, and expression style; rewrite it as your service persona
  (brand voice, tone, what it must never promise). See
  [Assistant Profile and User Preferences](../reference/personalization.md).
- **Per-visitor memory records** — `QWEN_AUDIO_AGENT_IDENTITY_MODE=browser`
  gives each authenticated browser identity isolated `USER.md` / `MEMORY.md`
  documents under `users/`, and automatic memory reconciliation keeps working
  per identity. Isolation is real; **concurrency is not** — visitors are still
  served one conversation at a time.
- **Business tools as the execution layer** — connect your own service agent
  through the generic ACP entry, or implement `BackendPort` directly with the
  [Backend Adapter SDK](../reference/backend-adapter-sdk.md) for CRM/ticketing
  systems that speak neither ACP nor A2A. See
  [Connecting a New Backend](../backends/extend.md).
- **Domain workflows as skills** — return policies, order lookup procedures,
  and escalation rules ship as standard Agent Skills installed with
  `qwenaudio skill install`.
- **Frontend tools without a backend** — answer-level capabilities (order
  status lookup, FAQ search) can be exposed to the conversation directly via
  the [Frontend MCP client](../reference/frontend-mcp.md) or the
  [Frontend OpenAPI adapter](../reference/frontend-openapi.md), and your
  knowledge base plugs into the
  [Knowledge Retrieval Provider](../reference/knowledge.md) boundary instead
  of a bundled RAG stack.
- **Hard perimeter** — a customer-facing page crosses the trust boundary:
  HTTPS reverse proxy with authentication in front, public Origin declared
  via `QWEN_AUDIO_AGENT_ALLOWED_ORIGINS`, never `HOST=0.0.0.0` on a bare
  port. Follow
  [Remote Access Security](../configuration/advanced.md#remote-access-security).

## What still requires platform work

| Gap | Why it matters | Tracking |
| --- | --- | --- |
| Concurrent visitors | One active client per Gateway today; a busy hotline needs N parallel conversations | [Roadmap #251](https://github.com/QwenAudio/qwen-audio-agent/issues/251) |
| Multi-tenant authorization | `QWEN_AUDIO_AGENT_AUTH_SECRET` signs the local identity; it is not a tenant model | Future protocol work |
| Telephony audio | Bridging PSTN audio into the realtime frontend is your gateway's job today | Custom [voice frontend provider](../voice-frontends/custom-provider.md) |

The blueprint deliberately stops at the seams: your knowledge base, CRM, and
business UI remain your systems. qwen-audio-agent contributes the always-on
voice conversation, the persona and memory plane, and the delegation path
into whatever execution layer you connect.
