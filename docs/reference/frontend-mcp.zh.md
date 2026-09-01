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
      "transport": {
        "type": "streamable-http",
        "url": "https://mcp.example.com/mcp",
        "headers": {
          "authorization": "${DOCUMENT_MCP_AUTHORIZATION}"
        }
      },
      "connectTimeoutMs": 8000,
      "tools": {
        "search": {
          "enabled": true,
          "timeoutMs": 8000,
          "maxResultBytes": 32768,
          "maxCallsPerTurn": 2,
          "description": "检索用户配置的文档来源。"
        },
        "create_issue": {
          "enabled": true,
          "description": "在用户配置的项目系统中创建 Issue。"
        }
      }
    }
  }
}
```

本地 MCP Server 可以使用标准输入输出：

```json
{
  "version": 1,
  "servers": {
    "filesystem": {
      "enabled": true,
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "${FILES_ROOT}"],
        "env": {
          "SERVICE_TOKEN": "${SERVICE_TOKEN}"
        },
        "cwd": "${MCP_WORKING_DIRECTORY}"
      },
      "tools": {
        "list_directory": { "enabled": true }
      }
    }
  }
}
```

为兼容已有配置，Server 顶层的 `url`、`headers` 仍表示 Streamable HTTP；
顶层的 `command`、`args`、`env`、`cwd` 也可作为 stdio 的简写。新配置推荐使用
显式 `transport` 对象。

每个公开工具会获得稳定的模型可见名称：
`mcp__<server>__<tool>`。未写入 `tools` 或未设置 `enabled: true`
的工具不会暴露。

## 当前策略

- 支持 Streamable HTTP 和 stdio Transport；不支持旧版独立 SSE Transport。
- 工具发现和连接有超时边界，默认 8 秒。
- 远端服务必须使用 HTTPS；回环地址可以使用 HTTP，但不能携带 Header。
- Server URL 可以用 `${MCP_URL}` 精确引用一个环境变量。
- Header 值可以用 `${VARIABLE}` 精确引用一个环境变量；变量缺失即配置错误。
- stdio Server 由 Gateway 直接启动，不经过 Shell；Gateway 关闭时会一并关闭子进程。
- stdio 的 `command`、参数、环境变量值和 `cwd` 可以精确引用环境变量；`cwd`
  如果填写，必须是绝对路径。子进程只继承 SDK 的安全基础环境和显式配置的 `env`。
- `tools` 是显式白名单；启用的工具由 Gateway 在当前对话轮次内直接调用，不再根据
  读写类型插入一轮通用确认。
- `readOnlyHint`、`destructiveHint` 等行为信息由 MCP Server 按标准 Tool Annotations
  提供。它们是元信息，不是 Gateway 的执行策略。
- 需要确认、鉴权或业务安全校验的操作由 MCP Server 在自己的能力边界内强制执行。
- Schema、描述、调用次数、执行时间和结果大小都有边界；MCP 结果按不可信数据
  处理，不能覆盖系统指令或用户要求。
- 发现阶段若缺少已启用工具或工具定义无效，该 Server 失败关闭，不暴露半套工具。

修改配置后需要重启 Gateway。密钥应通过环境变量传入，不要写入并提交 JSON。
