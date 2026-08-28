# 前台 MCP Client

前台 MCP Client 是 Chatbot 工具的标准化扩展边界：它不绑定具体
Realtime Provider，也不绑定后台 Agent。它与专用 Web Search Provider
相互独立；Web Search 保留一个简单内置兜底，通用 MCP Server 由用户配置。

Gateway 在启动时发现显式启用的工具，为其分配稳定名称，并通过共用的前台工具
注册表和执行器把它们加入每个 Realtime Session。

## 配置

用 `QWEN_AUDIO_FRONTEND_MCP_CONFIG` 指定一个带版本的 JSON 文件：

```dotenv
QWEN_AUDIO_FRONTEND_MCP_CONFIG=/absolute/path/to/frontend-mcp.json
DOCUMENT_MCP_AUTHORIZATION=Bearer replace-me
```

```json
{
  "version": 1,
  "servers": {
    "documents": {
      "enabled": true,
      "url": "https://mcp.example.com/mcp",
      "connectTimeoutMs": 8000,
      "headers": {
        "authorization": "${DOCUMENT_MCP_AUTHORIZATION}"
      },
      "tools": {
        "search": {
          "enabled": true,
          "readOnly": true,
          "timeoutMs": 8000,
          "maxResultBytes": 32768,
          "maxCallsPerTurn": 2,
          "description": "检索用户配置的文档来源。"
        },
        "create_issue": {
          "enabled": true,
          "readOnly": false,
          "approval": "required",
          "description": "在用户配置的项目系统中创建 Issue。"
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
- 工具发现和连接有超时边界，默认 8 秒。
- 远端服务必须使用 HTTPS；回环地址可以使用 HTTP，但不能携带 Header。
- Header 值可以用 `${VARIABLE}` 精确引用一个环境变量；变量缺失即配置错误。
- 启用的工具必须明确声明 `readOnly`。可写工具还必须设置
  `approval: "required"`，否则 Gateway 会在启动时拒绝该配置。
- 可写操作只有在用户自然语言确认后才会执行。每次确认只覆盖一个等待中的操作，
  且只能执行一次；拒绝、重复确认或确认前重连都会失败关闭，不提供会话级自动授权。
- Schema、描述、调用次数、执行时间和结果大小都有边界；MCP 结果按不可信数据
  处理，不能覆盖系统指令或用户要求。
- 发现阶段若缺少已启用工具或工具定义无效，该 Server 失败关闭，不暴露半套工具。

修改配置后需要重启 Gateway。密钥应通过环境变量传入，不要写入并提交 JSON。
