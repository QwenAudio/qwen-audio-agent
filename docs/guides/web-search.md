# Web Search

For current news, weather, or web sources, ask the assistant to “Search for…”. It can use
available search tools and answer from the results. Chat, search, and backend work are separate
capabilities; search itself does not require a Backend Agent.

## Default Search and Custom Services

The frontend `web_search` tool returns verifiable source links, does not create
backend Agent work, and does not invoke another text model. Without explicit
configuration it uses a small, key-free 360 search adapter that parses one
public search results page. This basic
fallback is experimental: it may be blocked, return weak results, or break
with upstream changes. Configure your own provider for reliable search.

For an optional hosted search service with source excerpts, select
[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp):

```dotenv
QWEN_AUDIO_WEB_SEARCH_PROVIDER=parallel
```

This preset uses Streamable HTTP at `https://search.parallel.ai/mcp` with no
account or API key. Anonymous searches use Fast mode and have service rate
limits. Search queries are sent to Parallel, and returned excerpts and source
links enter the voice model's context. The preset ignores custom MCP endpoint,
token, and tool overrides, so credentials saved for another service are not sent
to Parallel. To use a Parallel API key or a different endpoint, choose `mcp`
and configure its URL and token explicitly. Voice/model service costs are separate.
The default 360 provider remains unchanged; switch back with
`QWEN_AUDIO_WEB_SEARCH_PROVIDER=so360`.

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

Choose `so360` (default), `bing`, `bailian`, `parallel`, `mcp`, or `none`. Setting `none` disables search, not page fetching. Disable both search and page fetching with:

```dotenv
QWEN_AUDIO_WEB_TOOLS_ENABLED=false
```

## Results and Citations

WebUI and TUI show source links below the answer. Sources support the answer but do not guarantee
accuracy or freshness; check the original page for important information. Opening a search result
may also use `fetch_url`.

Focused research and Q&A can combine search, page reading, and knowledge retrieval; multiple
tool calls alone do not require backend work. Operations on the user's environment, ongoing
execution, and deliverable creation are routed according to the backend's declared capabilities.

To change search services, prefer configuring a Web Search Provider so the model keeps a single
`web_search` entry point. Avoid enabling the same search capability again through general MCP
configuration; the Gateway does not guess overlaps or merge tools based on names or descriptions.

For tools beyond search, see [frontend MCP configuration](../reference/frontend-mcp.md).
After changing settings, [restart the Gateway for your run mode](../operations/gateway.md#applying-configuration-changes).
