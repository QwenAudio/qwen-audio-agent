# Memcode

[Memcode 示例](../../examples/memcode/README_ZH.md)通过公开的 `MemoryProvider` v2
接口接入托管长期记忆。它不改变默认 Gateway，把一个个人 Memcode 凭据严格绑定到一个
Gateway owner，支持用户明确发起的文档编辑，并通过语义搜索完成回忆。默认不自动写入
完整对话或音频。

当宿主需要 API 驱动的记忆后端时使用这个示例。通用 MCP 工具仍应使用独立的
[前台 MCP Client](../reference/frontend-mcp.zh.md)。
