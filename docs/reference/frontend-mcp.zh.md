# 前台 MCP Client

前台 MCP Client 是 Chatbot 工具的标准化扩展边界：它不绑定具体
Realtime Provider，也不绑定后台 Agent。它与专用 Web Search Provider
相互独立；Web Search 保留一个简单内置兜底，通用 MCP Server 由用户配置。

当前基础版本先定义配置、发现、命名空间、健康状态、执行和结果边界。
把发现到的工具动态接入 Realtime Session 是 Roadmap 的下一步。

## 配置

用 `QWEN_AUDIO_FRONTEND_MCP_CONFIG` 指定一个带版本的 JSON 文件：

```env
QWEN_AUDIO_FRONTEND_MCP_CONFIG=/absolute/path/to/frontend-mcp.json
DOCUMENT_MCP_TOKEN=replace-me
```

```json
{
  "version": 1,
  "servers": {
    "documents": {
      "enabled": true,
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "authorization": "Bearer ${DOCUMENT_MCP_TOKEN}"
      },
      "tools": {
        "search": {
          "enabled": true,
          "readOnly": true,
          "timeoutMs": 8000,
          "maxResultBytes": 32768,
          "maxCallsPerTurn": 2,
          "description": "检索用户配置的文档来源。"
        }
      }
    }
  }
}
```

每个公开工具会获得稳定的模型可见名称：
`mcp__<server>__<tool>`。未写入 `tools` 或未设置 `enabled: true`
的工具不会暴露。

## 当前策略

- 首个版本使用 Streamable HTTP Transport。
- 远端服务必须使用 HTTPS；回环地址可以使用 HTTP，但不能携带 Header。
- Header 值可以用 `${VARIABLE}` 精确引用一个环境变量；变量缺失即配置错误。
- 启用的工具必须明确设置 `readOnly: true`。在通用前台授权链路完成前，
  可写工具不会开放。
- Schema、描述、调用次数、执行时间和结果大小都有边界；MCP 结果按不可信数据
  处理，不能覆盖系统指令或用户要求。
- 发现阶段若缺少已启用工具或工具定义无效，该 Server 失败关闭，不暴露半套工具。

修改配置后需要重启 Gateway。密钥应通过环境变量传入，不要写入并提交 JSON。
