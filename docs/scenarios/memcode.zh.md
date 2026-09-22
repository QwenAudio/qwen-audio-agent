# Memcode

[Memcode 示例](https://github.com/QwenAudio/qwen-audio-agent/blob/main/examples/memcode/README_ZH.md)通过公开的 `MemoryProvider` v2
接口接入托管长期记忆。它不改变默认 Gateway，检查配置的 Gateway owner，支持本地
文档编辑，并通过语义搜索完成回忆。启动器关闭自动学习，并在确认远端任务完成后
更新本地快照。远端语义更正与删除的限制见示例说明。

当宿主需要 API 驱动的记忆后端时使用这个示例。通用 MCP 工具仍应使用独立的
[前台 MCP Client](../reference/frontend-mcp.zh.md)。
