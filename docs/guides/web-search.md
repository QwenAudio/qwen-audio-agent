# Web Search

For current news, weather, or web sources, ask the assistant to “Search for…”. It can use
available search tools and answer from the results. Chat, search, and backend work are separate
capabilities; search itself does not require a Backend Agent.

## Default Search and Custom Services

The frontend `web_search` tool returns verifiable source links, does not create
backend Agent work, and does not invoke another text model. Without explicit
configuration it uses a small, key-free 360 search adapter that parses one
public search results page and is reachable in mainland China. This basic
fallback is experimental: it may be blocked, return weak results, or break
with upstream changes. Configure your own provider for reliable search.

After enabling Model Studio's Web Search MCP service, select its built-in preset
explicitly; it then reuses `DASHSCOPE_API_KEY`:

```dotenv
QWEN_AUDIO_WEB_SEARCH_PROVIDER=bailian
```

The same provider-neutral adapter can connect to another compatible MCP search
service. Custom endpoints must provide their own credentials explicitly:

```dotenv
QWEN_AUDIO_WEB_SEARCH_PROVIDER=mcp
QWEN_AUDIO_WEB_SEARCH_MCP_URL=https://example.com/mcp
QWEN_AUDIO_WEB_SEARCH_MCP_TOKEN=your-token
QWEN_AUDIO_WEB_SEARCH_MCP_TOOL=web_search
```

Set `QWEN_AUDIO_WEB_SEARCH_PROVIDER=none` to disable frontend web search.

## Results and Citations

WebUI and TUI show source links below the answer. Sources support the answer but do not guarantee
accuracy or freshness; check the original page for important information. Opening a search result
may also use `fetch_url`.

For tools beyond search, see [frontend MCP configuration](../reference/frontend-mcp.md).
After changing settings, [restart the Gateway for your run mode](../operations/gateway.md#applying-configuration-changes).
