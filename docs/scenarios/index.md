# Example Index

Examples demonstrate extension points; they are not the only way to enable a capability. Complete the [source installation](../getting-started/install.md#install-from-source), then follow each example's README for dependencies and configuration. Examples usually run on separate ports—do not substitute the standard Gateway address.

| What you want to explore | Start here |
| --- | --- |
| Visual conversation, on-demand capture, and observation | [X-Omni](x-omni.md): Qwen Omni by default, with continuous audiovisual input for MiniCPM-o. |
| WebRTC audio transport | [WebRTC](../gateway-webrtc-client.md): an optional client-to-Gateway transport, without changing the upstream model protocol. |
| Vehicle events, device controls, and a business Agent | [Smart Cockpit](smart-cockpit.md). |
| A hardware voice client | [AI Passport](ai-passport.md). |
| External long-term memory | [VoiceMem](voicemem.md). |
| Hosted API-backed memory | [Memcode](memcode.md). |
| An external knowledge system | [LightRAG](lightrag.md). |
| Customer service and human operators | [Customer Service](customer-service.md): retail and airline scenarios. |
| Frontend and full-system evaluation | [Benchmark](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/benchmark). |

## Choose an extension point

- A voice model: implement a [Realtime Provider](../voice-frontends/custom-provider.md).
- An action-taking Agent: implement a [Backend Adapter](../reference/backend-adapter-sdk.md).
- A client: use the [Gateway Client Protocol](../gateway-protocol.md).
- Chat tools: configure [MCP](../reference/frontend-mcp.md) or [OpenAPI](../reference/frontend-openapi.md).
- Knowledge or memory: implement a [Knowledge Provider](../reference/knowledge.md) or [Memory Provider](../reference/memory-provider.md).

Business prompts, device actions, and specialized tools stay in the examples. See the [extension overview](../extensions.md) for the boundaries.
