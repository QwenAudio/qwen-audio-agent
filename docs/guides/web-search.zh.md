# 联网搜索

需要最新消息、天气或网页资料时，可以直接说“搜索一下……”。前台会使用可用的搜索工具，
并根据结果回答。聊天、搜索与后台工作是不同能力；搜索本身不要求配置后台 Agent。

## 默认搜索与自定义服务

语音前台的 `web_search` 工具返回可核验的来源链接，不会创建后台 Agent 工作，也不会
额外调用文本大模型。用户未配置时，默认使用无需 Key、国内可访问的简易 360 搜索
Adapter，只解析一次公开搜索结果页。该基础兜底属于实验性实现，可能被拦截、结果质量
不稳定或受上游变化影响；稳定使用时应配置自己的 Provider。

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

设置 `QWEN_AUDIO_WEB_SEARCH_PROVIDER=none` 可以关闭前台联网搜索。

## 结果与引用

WebUI 与 TUI 会在回答下方显示来源链接。来源是查询依据，不保证页面内容真实或足够新；
重要信息仍应核对原文。读取搜索结果中的网页可能再次使用 `fetch_url`。

如需通过 MCP 提供搜索以外的能力，见[前台 MCP 配置](../reference/frontend-mcp.zh.md)。
修改配置后按[当前运行方式重启 Gateway](../operations/gateway.zh.md#修改配置后生效)。
