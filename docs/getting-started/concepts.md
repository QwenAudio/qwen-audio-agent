# How It Fits Together

Qwen Audio Agent separates realtime conversation from background execution. You can keep talking while progress and results return to the conversation.

## Three Core Components

| Component | Responsibility |
| --- | --- |
| Frontend Agent | Use a realtime model to understand input, respond naturally, and call available tools. |
| Orchestration Runtime | Connect frontend and backend, manage tasks, permissions, sessions, and events, and deliver results into the conversation. |
| Backend Agent | Execute work with its own model, tools, MCP servers, and Skills. |

**The Frontend Agent is neither the client nor just a model API.** It combines a realtime model with instructions, context, and tools. Desktop, WebUI, TUI, and mobile clients handle audio capture, playback, input, and display.

## What Is the Gateway?

The Gateway is the framework's **service host**: it hosts the Orchestration Runtime on a computer or server and exposes it to clients through a protocol. It is not a fourth core component alongside frontend, runtime, and backend, nor is it a protocol name. Clients use the Gateway Client Protocol.

Desktop bundles a Gateway and can also connect to a remote one. Mobile and other remote clients do not need a local Backend Agent. Components describe responsibilities; deployment determines where they run.

## Frontend and Backend Models

- The **frontend model** handles realtime conversation, such as Qwen Audio Realtime. Its capabilities determine transcription, vision, and tool support.
- The **backend model** belongs to the selected Agent. The Gateway preserves that Agent's configuration unless you explicitly request an override.
- Credentials, quotas, and model settings are separate. Configuring the frontend key does not sign in the backend.

## Without a Backend

Leave `AGENT_PROTOCOL` empty or set it to `none` for frontend-only mode. Chat and enabled tools such as search and memory remain available when supported by the voice service. Computer operations and other backend work are unavailable.

## Sessions, Work, and Workspaces

| Term | Meaning |
| --- | --- |
| Frontend session | A voice and text conversation. Starting a new one does not erase long-term memory. |
| Background work | An accepted execution request with a queryable, cancellable status. Acceptance is not completion. |
| Backend Session | Execution context managed by the Agent. Recovery and delegation depend on its capabilities. |
| Workspace | The default directory for project files, not a permission sandbox. |

## Local and Remote Use

CLI and Desktop can run separate Gateways. They share configuration and user data by default, but keep separate task and session state. Connect to the same Gateway to access that instance's work from another client.

Each user has one active client per Gateway. Confirming takeover disconnects the previous client without cancelling background work.

Next: [Quickstart](quickstart.md) · [Voice frontends](../configuration/frontend.md) · [Backend Agents](../backends/overview.md)
