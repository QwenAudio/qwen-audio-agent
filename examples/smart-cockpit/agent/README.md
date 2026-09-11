# Model-powered Cockpit A2A Agent

This directory contains the example's real backend Agent. Qwen3.8-Flash interprets
the task, chooses standard function tools, and can execute multiple tool calls
in sequence. The implementation stays deliberately replaceable: it is not
the qwen-audio-agent framework, and tool calls remain private to the backend.

The service exposes an A2A 1.0 Agent Card and JSON-RPC endpoint. Its Agent loop
discovers tools from the backend MCP surface and composes the framework's
`web_search` and `fetch_url` through `qwen-audio-agent/web-retrieval`. By default
this is 1 Service tool (`flashbuy`) + 2 retrieval tools. The latter are not part
of the Service's 38 scenario tools. Authoritative state and business rules remain
in `../service`; no additional search server or research framework is introduced.

Custom-skill list/create/load tools are foreground-routed by default. The
foreground executes their foreground workflow steps and delegates only backend
steps. If the skill domain is explicitly routed to the backend, the Agent reads
its small catalog and loads a matched workflow before execution. Skill text is
user data, not an authority or a way to add tools dynamically.

## News summaries and research

News tasks default to a short briefing with two or three useful items. Search
for the requested topic, read original pages when needed, and finish once the
evidence is sufficient; do not expand a brief request into deep research or
keep searching to fill the execution budget. Broader research is opt-in through
the user's request. Preserve source URLs and publication dates (or mark them
unverified), distinguish factual evidence from analysis, and never present
search snippets as fully read or cross-verified articles. The same model response
contains a Markdown briefing and a short spoken summary; the executor separates them into an A2A text artifact
and terminal status message. It appends the actual retrieval sources, read status,
timestamps, and failed retrievals. No-source reports are replaced with an explicit
verification failure, not invented current news. The foreground can keep chatting
throughout, using the existing Gateway task and announcement lifecycle.

Scenario limits are 24 model rounds, 32 model-requested tool calls, 10 minutes
per task, and 16,000 characters of page context per read. Provider/search and URL
fetch timeouts, DNS pinning, private-network/credential URL rejection, redirect
checks, and response-size limits reuse the framework implementation. Cancellation
propagates to model, retrieval, and MCP requests. The task deadline belongs to
this example's executor; the A2A adapter and Gateway do not impose a shorter
total deadline on ordinary background tasks. Single-request network timeouts
and the model/tool budgets remain independent of the 10-minute task limit.
These are example-owned guardrails, not the search provider's quota. The
tool/round limit is an internal normal finalization condition, not a failure:
stop further calls and summarize collected evidence without exposing budgets
or counters to the foreground. Excess calls receive internal non-execution
receipts; finalization explicitly disables tools. Empty final text or unexpected
tool calls yield the collected sources (or the last cockpit tool result) rather
than discarded work or invented completion. Actual evidence gaps remain visible. Cancellation and the 10-minute
deadline retain their terminal semantics.

```bash
npm install
npm start
```

Defaults:

- A2A Agent: `http://127.0.0.1:3020`
- Agent Card: `http://127.0.0.1:3020/.well-known/agent-card.json`
- Cockpit MCP: `http://127.0.0.1:3010/mcp/backend?cockpitId=default`

Environment variables:

- `DASHSCOPE_API_KEY` (required)
- `DASHSCOPE_MODEL` (defaults to `qwen3.8-flash` with thinking enabled)
- `DASHSCOPE_BASE_URL` (defaults to DashScope's OpenAI-compatible endpoint)
- `COCKPIT_AGENT_HOST`
- `COCKPIT_AGENT_PORT`
- `COCKPIT_SERVICE_ORIGIN`
- `COCKPIT_ID`
- `QWEN_AUDIO_WEB_SEARCH_PROVIDER` and the existing web-search MCP settings,
  shared with the frontend configuration. The default keyless `so360` provider
  is an experimental fallback; choose and verify a suitable provider for a live
  demo. See [web-search configuration](../../../docs/guides/web-search.md).

`createWebRetrieval` reads only the supplied environment object; it does not
load Gateway configuration files or create Gateway runtime directories. The
example bootstrap still loads the example's normal environment before startup.

Customers can replace this entire service with their own A2A, ACP or custom
backend Agent. The Gateway and cockpit client depend only on the backend
protocol, not on this model or Agent-loop implementation.
