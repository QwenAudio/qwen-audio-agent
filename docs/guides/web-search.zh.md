# 联网搜索

需要最新消息、天气或网页资料时，可以直接说“搜索一下……”。前台会使用可用的搜索工具，
并根据结果回答。聊天、搜索与后台工作是不同能力；搜索本身不要求配置后台 Agent。

## 默认搜索与自定义服务

语音前台的 `web_search` 工具返回可核验的来源链接，不会创建后台 Agent 工作，也不会
额外调用文本大模型。用户未配置时，默认使用无需 Key 的简易 360 搜索
Adapter，只解析一次公开搜索结果页。该基础兜底属于实验性实现，可能被拦截、结果质量
不稳定或受上游变化影响；稳定使用时应配置自己的 Provider。

如需返回来源摘录的托管搜索服务，可显式选择
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)：

```dotenv
QWEN_AUDIO_WEB_SEARCH_PROVIDER=parallel
```

此预设通过 Streamable HTTP 连接 `https://search.parallel.ai/mcp`，无需账号或 API Key。
匿名搜索使用 Fast 模式，受服务调用频率限制。搜索词会发送给 Parallel，返回的摘录和
来源链接会进入语音模型上下文。预设忽略自定义 MCP 地址、Token 和工具名，避免把为其他
服务保存的凭据发送给 Parallel。如需使用 Parallel API Key 或其他地址，请选择 `mcp`
并显式配置地址与 Token。语音与模型服务的费用独立计算。默认 360 Provider 不变；
设置 `QWEN_AUDIO_WEB_SEARCH_PROVIDER=so360` 即可切回。

在百炼开通联网搜索 MCP 后，需要显式选择内置预设；此时会复用
`DASHSCOPE_API_KEY`：

```dotenv
QWEN_AUDIO_WEB_SEARCH_PROVIDER=bailian
```

同一个与供应商无关的 Adapter 也可以接入其他兼容的 MCP 搜索服务；自定义地址必须
显式提供自己的凭据：

```dotenv
QWEN_AUDIO_WEB_SEARCH_PROVIDER=mcp
QWEN_AUDIO_WEB_SEARCH_MCP_URL=https://example.com/mcp
QWEN_AUDIO_WEB_SEARCH_MCP_TOKEN=your-token
QWEN_AUDIO_WEB_SEARCH_MCP_TOOL=web_search
```

可选 `so360`（默认）、`bing`、`bailian`、`parallel`、`mcp` 或 `none`。设置 `none` 只关闭搜索，网页读取工具仍可用；同时关闭搜索和网页读取时设置：

```dotenv
QWEN_AUDIO_WEB_TOOLS_ENABLED=false
```

## 结果与引用

WebUI 与 TUI 会在回答下方显示来源链接。来源是查询依据，不保证页面内容真实或足够新；
重要信息仍应核对原文。读取搜索结果中的网页可能再次使用 `fetch_url`。

范围明确的检索与问答可以组合搜索、网页读取和知识库检索，不会仅因需要多次调用就转为
后台工作。操作用户环境、持续执行或制作交付物则按后台声明的能力处理。

更换搜索服务优先配置 Web Search Provider，让模型仍只使用一个 `web_search` 入口。
避免在通用 MCP 配置里再次启用同一搜索能力；Gateway 不会按工具名称或描述猜测并自动合并工具。

如需通过 MCP 提供搜索以外的能力，见[前台 MCP 配置](../reference/frontend-mcp.zh.md)。
修改配置后按[当前运行方式重启 Gateway](../operations/gateway.zh.md#修改配置后生效)。
