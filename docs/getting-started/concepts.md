# How It Fits Together

Qwen Audio Agent separates realtime conversation from background execution. You can keep talking while progress and results return to the conversation.

| Component | Responsibility | Runs in |
| --- | --- | --- |
| Client | Capture and play audio, accept text and attachments, display conversation | Desktop, browser, TUI, or phone |
| Gateway | Connect models, manage tools and background work, persist state | Your computer or server |
| Backend Agent | Act using its own model, tools, MCP servers, and Skills | A Gateway-managed process or an existing service connected through an adapter |

The **voice frontend** is the realtime model service connected by the Gateway—not the desktop interface. It interprets input, responds, and calls available tools. Desktop bundles a Gateway; mobile and remote clients do not need a local backend Agent.

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
