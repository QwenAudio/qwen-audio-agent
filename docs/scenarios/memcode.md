# Memcode

The [Memcode example](../../examples/memcode/README.md) connects hosted
long-term memory through the public `MemoryProvider` v2 interface. It keeps the
default Gateway unchanged, binds one personal Memcode credential to one
Gateway owner, supports explicit document edits, and uses semantic search for
recall. Automatic transcript and audio ingestion are disabled.

Use this example when a host wants API-backed memory rather than a frontend
tool. For general MCP tools, use the separate [Frontend MCP client](../reference/frontend-mcp.md).
