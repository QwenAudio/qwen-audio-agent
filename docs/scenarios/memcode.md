# Memcode

The [Memcode example](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/memcode/README.md) connects hosted
long-term memory through the public `MemoryProvider` v2 interface. It keeps the
default Gateway unchanged, checks the configured Gateway owner, supports local
document edits, and uses semantic search for recall. The launcher disables
automatic learning and confirms remote job completion before updating its local
snapshot. Remote semantic correction and deletion remain subject to the documented limitations.

Use this example when a host wants API-backed memory rather than a frontend
tool. For general MCP tools, use the separate [Frontend MCP client](../reference/frontend-mcp.md).
