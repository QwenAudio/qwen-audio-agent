# Extending qwen-audio-agent

The runtime is generic; every scenario-specific behavior enters through a
declared seam. This page maps the seams and points to the guide for each.

## Frontend Tools: MCP, OpenAPI, Profiles

Add chatbot tools without touching the voice path: connect MCP servers through
the frontend MCP client, expose selected REST operations from an OpenAPI 3.x
document, or bundle persona plus tool configuration as a versioned Frontend
Profile.

→ [Frontend MCP client](reference/frontend-mcp.md) ·
[Frontend OpenAPI adapter](reference/frontend-openapi.md) ·
[Frontend Profiles](reference/frontend-profile.md)

## Voice Frontend: Custom Realtime Provider

Swap the realtime speech model for another cloud service or your own stack by
implementing the provider contract and registering it in the provider
registry.

→ [Custom Provider](voice-frontends/custom-provider.md)

## Knowledge: Retrieval Provider

The Gateway defines a small retrieval boundary instead of shipping a RAG
stack — connect the knowledge system you already operate.

→ [Knowledge Retrieval Provider](reference/knowledge.md)

## Backend: Connect a New Agent

Four paths put a backend behind the protocol-neutral `BackendPort`: the
zero-code generic ACP entry, a remote A2A agent, a custom adapter via the
Backend Adapter SDK, or a first-class backend with one-click install.

→ [Connecting a New Backend](backends/extend.md) ·
[Backend Adapter SDK](reference/backend-adapter-sdk.md) ·
[A2A Backend Adapter](reference/a2a-backend-adapter.md)

## Persona and Memory

The assistant's name, personality, and voice live in `ASSISTANT.md`; durable
user facts live in `USER.md` / `MEMORY.md`. All are plain Markdown in the
config directory, editable while the gateway keeps its constrained write path.

→ [Assistant Profile and User Preferences](reference/personalization.md) ·
[Long-Term Memory](reference/memory.md)

## Client: Build Your Own

The Gateway speaks typed events over a single WebSocket. Build a custom client
against the client protocol, or embed the assistant into a host page through
the stability contract — the same channel the desktop orb, TUI, and WebUI use.
[`examples/custom-conversation-client/`](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/custom-conversation-client)
is a minimal starting point.

→ [Gateway Client Protocol](gateway-protocol.md) ·
[Gateway Contract](contract.md)

## Desktop Appearance

The desktop orb renders replaceable pet skins: a `pet.json` manifest plus a
spritesheet.

→ [Pet Skin Spec](desktop/pet-skin-spec.md)
